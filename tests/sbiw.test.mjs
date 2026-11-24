import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { ExecutionFault, instructionWords, XmegaCPU } from '../src/xmega.mjs';

const pairs = [24, 26, 28, 30];
const flashBytes = 0x42000;

function machine() {
  return new XmegaCPU({ flash: new Uint8Array(flashBytes), present: new Uint8Array(flashBytes) });
}

function put(cpu, pc, word) {
  cpu.flash.set([word % 256, Math.floor(word / 256)], 2 * pc);
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
}

// Assemble by concatenating the fields from Microchip section 6.98.
function assemble(pair, immediate) {
  const k = immediate.toString(2).padStart(6, '0');
  const dd = pairs.indexOf(pair).toString(2).padStart(2, '0');
  return parseInt('10010111' + k.slice(0, 2) + dd + k.slice(2), 2);
}

// Independent byte-wise subtraction. Compute overflow using signed integers
// without truncation, and borrow by subtracting from the two bytes in sequence.
function oracle(input, k) {
  const low = input % 256 - k;
  const high = Math.floor(input / 256) - Number(low < 0);
  const result = ((high + 256) % 256) * 256 + ((low + 256) % 256);
  const signed = input < 32768 ? input : input - 65536;
  const overflow = signed - k < -32768;
  const negative = result >= 32768;
  return {
    result,
    flags: Number(high < 0) + 2 * (result === 0) + 4 * negative +
      8 * overflow + 16 * (negative !== overflow),
  };
}

test('SBIW decodes all 256 words, including both high immediate bits, without fetching', () => {
  const cpu = machine();
  for (const [pair, k, word] of [[24, 4, 0x9704], [26, 15, 0x971f], [28, 16, 0x9760],
    [24, 32, 0x9780], [30, 63, 0x97ff]]) assert.equal(assemble(pair, k), word);
  const words = new Set();
  for (const pair of pairs) {
    for (let k = 0; k < 64; k++) {
      const word = assemble(pair, k);
      words.add(word);
      put(cpu, 0, word);
      assert.equal(instructionWords(word), 1);
      const detail = decodeAt(cpu);
      assert.equal(detail.mnemonic, 'SBIW');
      assert.deepEqual(detail.operands, { destinationLowRegister: pair, immediate: k });
      assert.deepEqual(detail.opcodeWords, [word]);
    }
  }
  assert.equal(words.size, 256);
  assert.deepEqual(cpu.accesses, []);
});

test('SBIW executes all 16,777,216 pair, input-word and immediate combinations', () => {
  const cpu = machine();
  for (let k = 0; k < 64; k++) {
    for (const [index, pair] of pairs.entries()) put(cpu, k * 4 + index, assemble(pair, k));
  }
  for (let input = 0; input <= 0xffff; input++) {
    cpu.pc = 0;
    for (let k = 0; k < 64; k++) {
      const { result, flags } = oracle(input, k);
      for (let index = 0; index < pairs.length; index++) {
        const pair = pairs[index];
        cpu.r[pair] = input % 256;
        cpu.r[pair + 1] = Math.floor(input / 256);
        const incoming = (input + k + index * 61) % 256;
        cpu.sreg = incoming;
        const trace = cpu.step();
        const actual = cpu.r[pair] + cpu.r[pair + 1] * 256;
        if (actual !== result || cpu.sreg !== (flags + (incoming & 0xe0)) ||
            cpu.pc !== k * 4 + index + 1 || trace.after.cycles - trace.before.cycles !== 2) {
          assert.fail(`SBIW R${pair},${k} on word ${input}, SREG ${incoming}: result ${actual}, SREG ${cpu.sreg}, PC ${cpu.pc}`);
        }
      }
    }
  }
  assert.equal(cpu.steps, 16777216);
  assert.equal(cpu.cycles, 33554432);
});

test('SBIW preserves neighboring registers, stack, I/T/H and extended registers for all incoming SREG bytes', () => {
  const cpu = machine();
  cpu.sp = 0x4142;
  cpu.rampz = 3;
  cpu.eind = 1;
  const fixtures = [
    // input, immediate, result, S V N Z C flags
    [0, 0, 0, 2], [0, 1, 0xffff, 0x15], [63, 63, 0, 2], [0x100, 1, 255, 0],
    [0x8000, 1, 0x7fff, 0x18], [0x803e, 63, 0x7fff, 0x18],
    [0x803f, 63, 0x8000, 0x14], [0xffff, 0, 0xffff, 0x14],
  ];
  for (const pair of pairs) {
    for (const [input, k, result, flags] of fixtures) {
      const word = assemble(pair, k);
      put(cpu, 0xffff, word);
      for (let initial = 0; initial < 256; initial++) {
        cpu.pc = 0xffff;
        cpu.r.set(Uint8Array.from({ length: 32 }, (_, reg) => (initial + 19 * reg) % 256));
        cpu.r[pair] = input % 256;
        cpu.r[pair + 1] = Math.floor(input / 256);
        cpu.sreg = initial;
        const before = cpu.state();
        const expectedRegisters = [...before.registers];
        expectedRegisters[pair] = result % 256;
        expectedRegisters[pair + 1] = Math.floor(result / 256);
        const event = cpu.step();
        assert.deepEqual(event.before, before);
        assert.deepEqual(event.after, { ...before, sreg: (initial & 0xe0) + flags,
          pcWord: 0x10000, cycles: before.cycles + 2, registers: expectedRegisters });
        assert.equal(event.mnemonic, 'SBIW');
        assert.equal(event.opcode, word);
        assert.deepEqual(event.accesses.map(a => [a.kind, a.space, a.addressByte, a.value]), [
          ['fetch', 'flash', 0x1fffe, word % 256], ['fetch', 'flash', 0x1ffff, Math.floor(word / 256)],
        ]);
      }
    }
  }
});

test('SBIW flags drive real conditional branch instructions with deterministic taken and untaken traces', () => {
  function run(input, bit) {
    const cpu = machine();
    put(cpu, 0, assemble(28, 17));
    put(cpu, 1, 0xf008 + bit); // BRBS bit,+1 skips a NOP if the flag is set.
    put(cpu, 2, 0);
    put(cpu, 3, 0);
    cpu.r[28] = input % 256;
    cpu.r[29] = Math.floor(input / 256);
    return [cpu.step(), cpu.step(), cpu.step()];
  }
  for (const [input, bit, taken] of [[16, 0, true], [17, 0, false], [17, 1, true],
    [18, 1, false], [0x8000, 3, true], [0x7fff, 3, false], [0x8000, 4, true], [18, 4, false]]) {
    const events = run(input, bit);
    assert.deepEqual(events, run(input, bit));
    assert.deepEqual(events.map(event => event.before.pcWord), [0, 1, taken ? 3 : 2]);
    assert.deepEqual(events.map(event => event.after.cycles), [2, taken ? 4 : 3, taken ? 5 : 4]);
  }
});

test('SBIW faults on either missing fetch byte or an invalid fall-through without partial state changes', () => {
  function expectFault(cpu, pattern) {
    const before = cpu.state(), retired = cpu.steps;
    assert.throws(() => cpu.step(), error => error instanceof ExecutionFault &&
      pattern.test(error.message) && error.trace.instructionCompleted === false);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, retired);
  }
  const cpu = machine();
  cpu.r[24] = 0x5a;
  cpu.r[25] = 0x80;
  cpu.sreg = 0xa7;
  for (const missing of [0, 1]) {
    put(cpu, 0, assemble(24, 63));
    cpu.present[missing] = 0;
    expectFault(cpu, /HEX hole/);
  }
  cpu.pc = flashBytes / 2 - 1;
  put(cpu, cpu.pc, assemble(24, 63));
  expectFault(cpu, /PC target outside device/);
  cpu.pc = 0;
  put(cpu, 0, 0xffff);
  expectFault(cpu, /Unsupported instruction/);
});
