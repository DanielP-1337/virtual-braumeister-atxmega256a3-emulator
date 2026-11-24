import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt, discover } from '../src/discovery.mjs';

// Build the manual's 0001 00rd dddd rrrr bit string independently of the decoder.
function encodeCpse(left, right) {
  const d = left.toString(2).padStart(5, '0');
  const r = right.toString(2).padStart(5, '0');
  return Number.parseInt('000100' + r[0] + d + r.slice(1), 2);
}

function machine() {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
}

function put(cpu, pcWord, ...words) {
  let byte = pcWord * 2;
  for (const word of words) {
    cpu.present.fill(1, byte, byte + 2);
    cpu.flash[byte++] = word & 0xff;
    cpu.flash[byte++] = word >>> 8;
  }
}

test('CPSE compares all 1,024 ordered register pairs, including self-comparisons', () => {
  const cpu = machine();
  assert.equal(encodeCpse(0, 0), 0x1000);
  assert.equal(encodeCpse(1, 16), 0x1210);
  assert.equal(encodeCpse(31, 31), 0x13ff);
  for (let left = 0; left < 32; left++) {
    for (let right = 0; right < 32; right++) {
      put(cpu, 0, encodeCpse(left, right), 0xffff, 0);
      for (const [a, b] of [[0, 0], [255, 255], [0, 128], [255, 127]]) {
        if (left === right && a !== b) continue;
        cpu.pc = 0;
        for (let i = 0; i < 32; i++) cpu.r[i] = i + 1;
        cpu.r[left] = a;
        cpu.r[right] = b;
        const before = cpu.state();
        const step = cpu.steps;
        assert.deepEqual(decodeAt(cpu).operands, { leftRegister: left, rightRegister: right });
        const trace = cpu.step();
        const taken = a === b;
        const advance = taken ? 2 : 1;
        assert.equal(trace.mnemonic, 'CPSE');
        assert.equal(trace.skip.taken, taken);
        assert.equal(trace.skip.skippedWords, taken ? 1 : 0);
        assert.deepEqual([trace.skip.leftRegister, trace.skip.rightRegister, trace.skip.leftValue, trace.skip.rightValue], [left, right, a, b]);
        assert.deepEqual(cpu.state(), { ...before, pcWord: advance, cycles: before.cycles + advance });
        assert.equal(cpu.steps, step + 1);
      }
    }
  }
});

test('CPSE preserves all 256 SREG patterns for equal and unequal operands at both widths', () => {
  const cpu = machine();
  for (const [successor, width] of [[0x0000, 1], [0x940e, 2]]) {
    put(cpu, 0, encodeCpse(30, 3), successor, 0, 0);
    for (let sreg = 0; sreg < 256; sreg++) {
      for (const equal of [true, false]) {
        cpu.pc = 0;
        cpu.sreg = sreg;
        cpu.r[30] = 0x80;
        cpu.r[3] = equal ? 0x80 : 0;
        const before = cpu.state();
        const trace = cpu.step();
        const advance = equal ? 1 + width : 1;
        assert.deepEqual(cpu.state(), { ...before, pcWord: advance, cycles: before.cycles + advance });
        assert.equal(trace.skip.skippedWords, equal ? width : 0);
      }
    }
  }
});

test('CPSE skips a 16-bit side effect or an entire JMP, CALL, LDS or STS without executing it', () => {
  // All addresses are synthetic. The two-word targets/operands are deliberately unusable.
  for (const [successor, width] of [[0xe705, 1], [0xffff, 1], [0x940d, 2], [0x941f, 2], [0x91f0, 2], [0x93f0, 2]]) {
    const cpu = machine();
    const skipped = width === 2 ? [successor, 0xffff] : [successor];
    put(cpu, 0, encodeCpse(2, 2), ...skipped, 0xe50a); // Landing instruction: LDI R16,0x5A.
    const before = cpu.state();
    const ram = cpu.sram.slice();
    const trace = cpu.step();
    assert.equal(cpu.steps, 1);
    assert.deepEqual(cpu.state(), { ...before, pcWord: 1 + width, cycles: 1 + width });
    assert.deepEqual(cpu.sram, ram);
    assert.equal(trace.skip.skippedOpcode, successor);
    assert.equal(trace.skip.skippedPcWord, 1);
    assert.equal(trace.accesses.length, 2 + 2 * width);
    trace.accesses.forEach((a, i) => assert.deepEqual([a.space, a.kind, a.addressByte], ['flash', 'fetch', i]));
    assert.equal(cpu.step().mnemonic, 'LDI');
    assert.equal(cpu.r[16], 0x5a);
  }
});

test('CPSE on inequality falls through and leaves the next opcode to execute or fault', () => {
  for (const [words, effect] of [[[0xe50a], 'LDI'], [[0x9300, 0x2000], 'STS'], [[0xffff], 'fault']]) {
    const cpu = machine();
    cpu.r[0] = 1;
    cpu.r[16] = 0x39;
    put(cpu, 0, encodeCpse(0, 31), ...words, 0);
    const trace = cpu.step();
    assert.deepEqual([cpu.pc, cpu.steps, cpu.cycles, trace.skip.taken, trace.skip.skippedWords], [1, 1, 1, false, 0]);
    assert.deepEqual(trace.accesses.map(a => a.addressByte), [0, 1]);
    if (effect === 'fault') {
      assert.throws(() => cpu.step(), /Unsupported instruction 0xffff/);
      assert.equal(cpu.steps, 1);
    } else {
      assert.equal(cpu.step().mnemonic, effect);
      if (effect === 'LDI') assert.equal(cpu.r[16], 0x5a);
      else assert.equal(cpu.sram[0], 0x39);
    }
  }
});

test('CPSE fetches only required words and keeps architectural state on a truncated or invalid skip', () => {
  for (const missing of [0, 1, 2, 3, 4, 5]) {
    const cpu = machine();
    put(cpu, 0, encodeCpse(7, 7), 0x940e, 0x1234, 0);
    cpu.present[missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'FLASH_HOLE' && e.addressByte === missing && e.trace.eventType === 'diagnostic');
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  const cpu = machine();
  put(cpu, 0, encodeCpse(0, 1));
  cpu.r[1] = 1;
  cpu.step();
  assert.deepEqual([cpu.pc, cpu.cycles], [1, 1]);
  assert.throws(() => cpu.step(), e => e.classification === 'FLASH_HOLE' && e.addressByte === 2);

  const last = cpu.flash.length / 2 - 1;
  for (const [pc, tail, expected] of [[last - 1, [0x940e], /outside device at byte/], [last - 2, [0x940e, 0], /PC target outside device/]]) {
    cpu.pc = pc;
    put(cpu, pc, encodeCpse(0, 0), ...tail);
    const before = cpu.state();
    const steps = cpu.steps;
    assert.throws(() => cpu.step(), expected);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, steps);
  }
  cpu.pc = 0xffff;
  put(cpu, cpu.pc, encodeCpse(0, 0), 0x9200, 0, 0);
  const cycles = cpu.cycles;
  cpu.step();
  assert.equal(cpu.pc, 0x10002);
  assert.equal(cpu.cycles - cycles, 3);
});

test('CPSE discovery replays both outcomes and a skipped CALL creates no stack frame', () => {
  function run() {
    const cpu = machine();
    // Reset: equal registers skip CALL, LDI makes them unequal, then the second CPSE falls through.
    put(cpu, 0, encodeCpse(16, 0), 0x940e, 0xffff, 0xe001, encodeCpse(0, 16), 0xffff);
    const trace = [];
    const result = discover(cpu, { onTrace: event => trace.push(event) });
    assert.deepEqual(trace.map(t => t.before.pcWord), [0, 3, 4, 5]);
    assert.deepEqual(result.recentControlFlow.map(t => [t.mnemonic, t.fromWord, t.toWord]), [['CPSE', 0, 3], ['CPSE', 4, 5]]);
    assert.deepEqual([result.completedInstructions, result.cycles, result.callStack.length], [3, 5, 0]);
    assert.equal(result.firstBlockingEvent.classification, 'UNSUPPORTED_OPCODE');
    assert.equal(trace.at(-1).eventType, 'diagnostic');
    return trace;
  }
  assert.deepEqual(run(), run());
});
