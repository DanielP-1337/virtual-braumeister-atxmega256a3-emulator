import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { ExecutionFault, instructionWords, XmegaCPU } from '../src/xmega.mjs';

const flashSize = 0x42000;
const pairs = [24, 26, 28, 30];

function machine() {
  return new XmegaCPU({ flash: new Uint8Array(flashSize), present: new Uint8Array(flashSize) });
}

function put(cpu, wordPc, opcode) {
  cpu.flash.set([opcode % 256, Math.floor(opcode / 256)], wordPc * 2);
  cpu.present.fill(1, wordPc * 2, wordPc * 2 + 2);
}

// Assemble the manual's 1001 0110 KKdd KKKK fields independently.
function assemble(pair, immediate) {
  const k = immediate.toString(2).padStart(6, '0');
  const dd = pairs.indexOf(pair).toString(2).padStart(2, '0');
  return parseInt('10010110' + k.slice(0, 2) + dd + k.slice(2), 2);
}

test('ADIW decodes every register pair and six-bit immediate as a single word', () => {
  const cpu = machine();
  for (const [pair, k, expected] of [[24, 1, 0x9601], [26, 15, 0x961f],
    [28, 16, 0x9660], [24, 32, 0x9680], [30, 63, 0x96ff]]) {
    assert.equal(assemble(pair, k), expected);
  }
  const opcodes = new Set();
  for (const pair of pairs) {
    for (let k = 0; k <= 63; k++) {
      const op = assemble(pair, k);
      opcodes.add(op);
      put(cpu, 0, op);
      assert.deepEqual(decodeAt(cpu), { pcWord: 0, pcByte: 0, opcode: op, opcodeWords: [op],
        mnemonic: 'ADIW', operands: { destinationLowRegister: pair, immediate: k } });
      assert.equal(instructionWords(op), 1);
    }
  }
  assert.equal(opcodes.size, 256);
  assert.deepEqual(cpu.accesses, []);
});

test('ADIW executes every input word with every immediate using an independent byte-wise sum', () => {
  const cpu = machine();
  for (let k = 0; k <= 63; k++) {
    for (const [index, pair] of pairs.entries()) put(cpu, 4 * k + index, assemble(pair, k));
  }
  for (let input = 0; input <= 0xffff; input++) {
    const low = input % 256, high = Math.floor(input / 256);
    for (let k = 0; k <= 63; k++) {
      const index = (input + k) % 4, pair = pairs[index];
      cpu.pc = 4 * k + index;
      cpu.r[pair] = low;
      cpu.r[pair + 1] = high;
      const incomingFlags = (low + 3 * high + k) % 256;
      cpu.sreg = incomingFlags;
      const lowSum = low + k, highSum = high + Math.floor(lowSum / 256);
      const lo = lowSum % 256, hi = highSum % 256;
      const overflow = high === 127 && hi === 128;
      const negative = hi >= 128;
      const flags = (incomingFlags & 0xe0) + Number(highSum === 256) + 2 * (hi === 0 && lo === 0)
        + 4 * negative + 8 * overflow + 16 * (negative !== overflow);
      const event = cpu.step();
      if (cpu.r[pair] !== lo || cpu.r[pair + 1] !== hi || cpu.sreg !== flags ||
          cpu.pc !== 4 * k + index + 1 || event.after.cycles - event.before.cycles !== 2) {
        assert.fail(`ADIW R${pair},${k} on word ${input} with SREG ${incomingFlags}`);
      }
    }
  }
  assert.equal(cpu.steps, 65536 * 64);
  assert.equal(cpu.cycles, 2 * cpu.steps);
});

test('ADIW preserves other registers, I/T/H and stack for every incoming SREG byte', () => {
  const cpu = machine();
  cpu.sp = 0x4ace;
  cpu.rampz = 2;
  cpu.eind = 1;
  // input, immediate, result, expected S/V/N/Z/C
  const cases = [[0, 0, 0, 2], [0x00ff, 1, 0x0100, 0], [0x7fff, 1, 0x8000, 0x0c],
    [0x7fc1, 63, 0x8000, 0x0c], [0x8000, 0, 0x8000, 0x14], [0xffc0, 63, 0xffff, 0x14],
    [0xffff, 1, 0, 3], [0xffff, 63, 62, 1]];
  for (const pair of pairs) {
    for (const [input, k, result, flags] of cases) {
      const op = assemble(pair, k);
      put(cpu, 0xffff, op);
      for (let sreg = 0; sreg < 256; sreg++) {
        cpu.pc = 0xffff;
        cpu.sreg = sreg;
        for (let r = 0; r < 32; r++) cpu.r[r] = (sreg + 13 * r) % 256;
        cpu.r[pair] = input % 256;
        cpu.r[pair + 1] = Math.floor(input / 256);
        const before = cpu.state();
        const registers = before.registers.slice();
        registers[pair] = result % 256;
        registers[pair + 1] = Math.floor(result / 256);
        const event = cpu.step();
        assert.equal(event.mnemonic, 'ADIW');
        assert.equal(event.opcode, op);
        assert.deepEqual(event.after, { ...before, registers, sreg: (sreg & 0xe0) + flags,
          pcWord: 0x10000, cycles: before.cycles + 2 });
        assert.deepEqual(event.accesses.map(a => [a.kind, a.space, a.addressByte, a.value]),
          [['fetch', 'flash', 0x1fffe, op % 256], ['fetch', 'flash', 0x1ffff, 0x96]]);
      }
    }
  }
});

test('ADIW flags drive conditional branches with deterministic taken and untaken traces', () => {
  function run(input, flag) {
    const cpu = machine();
    put(cpu, 0, 0x9601); // ADIW R25:R24,1
    put(cpu, 1, 0xf008 + flag); // BRBS flag,+1
    put(cpu, 2, 0);
    put(cpu, 3, 0);
    cpu.r[24] = input % 256;
    cpu.r[25] = Math.floor(input / 256);
    return [cpu.step(), cpu.step(), cpu.step()];
  }
  for (const [input, expected] of [[0x0000, 0], [0xffff, 3], [0x7fff, 0x0c], [0x8000, 0x14]]) {
    for (let bit = 0; bit < 5; bit++) {
      const taken = (expected & (1 << bit)) !== 0;
      const events = run(input, bit);
      assert.deepEqual(events, run(input, bit));
      assert.deepEqual(events.map(e => e.before.pcWord), [0, 1, taken ? 3 : 2]);
      assert.deepEqual(events.map(e => e.after.cycles), [2, taken ? 4 : 3, taken ? 5 : 4]);
    }
  }
});

test('ADIW rejects missing instruction bytes and invalid fall-through before changing state', () => {
  const cpu = machine();
  cpu.r[24] = 255;
  cpu.r[25] = 127;
  cpu.sreg = 0xf3;
  function expectFault(pattern) {
    const before = cpu.state(), steps = cpu.steps;
    assert.throws(() => cpu.step(), e => e instanceof ExecutionFault && pattern.test(e.message)
      && e.trace.instructionCompleted === false);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, steps);
  }
  for (const index of [0, 1]) {
    put(cpu, 0, 0x9601);
    cpu.present[index] = 0;
    expectFault(/HEX hole/);
  }
  cpu.pc = flashSize / 2 - 1;
  put(cpu, cpu.pc, 0x9601);
  expectFault(/PC target outside device/);
});
