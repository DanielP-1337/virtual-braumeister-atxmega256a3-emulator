import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAt } from '../src/discovery.mjs';
import { ExecutionFault, XmegaCPU } from '../src/xmega.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
  cpu.sp = 0x4765;
  cpu.rampz = 2;
  cpu.eind = 1;
  return cpu;
}

function place(cpu, pc, word) {
  cpu.flash.set([word % 256, Math.floor(word / 256)], 2 * pc);
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
}

// Four hexadecimal digits in manual order: 5, upper K, register selector, lower K.
function encode(register, immediate) {
  const [high, low] = immediate.toString(16).padStart(2, '0');
  return parseInt('5' + high + (register - 16).toString(16) + low, 16);
}

// A full-subtractor truth table, indexed by (operand bit, immediate bit, borrow in).
// The test propagates borrows bit by bit and checks overflow in signed integer space.
const differenceBit = [0, 1, 1, 0, 1, 0, 0, 1];
const borrowBit = [0, 1, 1, 1, 0, 0, 0, 1];
const signedByte = byte => byte < 128 ? byte : byte - 256;

function reference(value, immediate) {
  let result = 0, borrow = 0, halfBorrow = 0;
  for (let bit = 0; bit < 8; bit++) {
    const weight = 2 ** bit;
    const a = Math.floor(value / weight) % 2;
    const b = Math.floor(immediate / weight) % 2;
    const index = 4 * a + 2 * b + borrow;
    result += weight * differenceBit[index];
    borrow = borrowBit[index];
    if (bit === 3) halfBorrow = borrow;
  }
  const signed = signedByte(value) - signedByte(immediate);
  const overflow = signed < -128 || signed > 127;
  const negative = result >= 128;
  const flags = 32 * halfBorrow + 16 * (negative !== overflow) + 8 * overflow +
    4 * negative + 2 * (result === 0) + borrow;
  return { result, flags };
}

test('all 4,096 SUBI encodings name the correct register and eight-bit immediate', () => {
  const cpu = machine();
  for (const [word, register, immediate] of [[0x5000, 16, 0], [0x5fff, 31, 255], [0x5a3b, 19, 0xab], [0x50e0, 30, 0]]) {
    assert.equal(encode(register, immediate), word);
  }
  const words = new Set();
  for (let register = 16; register <= 31; register++) {
    for (let immediate = 0; immediate < 256; immediate++) {
      const word = encode(register, immediate);
      words.add(word);
      place(cpu, 0, word);
      const decoded = decodeAt(cpu);
      assert.equal(decoded.mnemonic, 'SUBI');
      assert.deepEqual(decoded.operands, { register, immediate });
    }
  }
  assert.equal(words.size, 4096);
  assert.equal(cpu.accesses.length, 0);
});

test('all 1,048,576 register, immediate and input-byte combinations give the expected byte, SREG and one-cycle retirement', () => {
  const cpu = machine();
  for (let register = 16; register <= 31; register++) {
    for (let immediate = 0; immediate < 256; immediate++) {
      place(cpu, (register - 16) * 256 + immediate, encode(register, immediate));
    }
  }
  for (let value = 0; value < 256; value++) {
    const row = Array.from({ length: 256 }, (_, k) => reference(value, k));
    const initial = Uint8Array.from({ length: 32 }, (_, r) => (37 * r + value) % 256);
    const registers = initial.slice();
    cpu.pc = 0;
    for (let register = 16; register <= 31; register++) {
      for (let immediate = 0; immediate < 256; immediate++) {
        const pc = (register - 16) * 256 + immediate;
        const incoming = (pc + 113 * value) % 256;
        cpu.sreg = incoming;
        cpu.r.set(initial);
        cpu.r[register] = value;
        const trace = cpu.step();
        registers[register] = row[immediate].result;
        assert.deepEqual(cpu.r, registers);
        assert.equal(cpu.sreg, Math.floor(incoming / 64) * 64 + row[immediate].flags);
        assert.equal(trace.mnemonic, 'SUBI');
        assert.equal(trace.before.pcWord, pc);
        assert.equal(cpu.pc, pc + 1);
        assert.equal(trace.after.cycles - trace.before.cycles, 1);
        assert.equal(cpu.steps, value * 4096 + pc + 1);
        assert.equal(trace.accesses.length, 2);
        assert.equal(trace.accesses[0].kind, 'fetch');
        assert.equal(trace.accesses[1].kind, 'fetch');
      }
      registers[register] = initial[register];
    }
  }
  assert.equal(cpu.cycles, 1048576);
  assert.equal(cpu.sp, 0x4765);
  assert.equal(cpu.rampz, 2);
  assert.equal(cpu.eind, 1);
});

test('literal borrow, overflow and zero vectors replace all six affected bits across all 256 incoming SREG values', () => {
  const cpu = machine();
  // Each row gives Rd before, K, Rd after and the six resulting H/S/V/N/Z/C bits.
  const vectors = [
    [0x00, 0x00, 0x00, 0x02], [0xff, 0xff, 0x00, 0x02], [0x00, 0x01, 0xff, 0x35],
    [0x10, 0x01, 0x0f, 0x20], [0x01, 0x10, 0xf1, 0x15], [0x80, 0x01, 0x7f, 0x38],
    [0x7f, 0xff, 0x80, 0x0d], [0xff, 0x01, 0xfe, 0x14], [0x8f, 0x80, 0x0f, 0x00],
    [0x08, 0xf8, 0x10, 0x01], [0x00, 0xff, 0x01, 0x21], [0xf0, 0x0f, 0xe1, 0x34],
    [0x80, 0x10, 0x70, 0x18],
  ];
  for (const [value, immediate, expected, flags] of vectors) {
    place(cpu, 0, encode(17, immediate));
    for (let incoming = 0; incoming < 256; incoming++) {
      cpu.pc = 0;
      cpu.r[17] = value;
      cpu.sreg = incoming;
      cpu.step();
      assert.equal(cpu.r[17], expected);
      assert.equal(cpu.sreg, Math.floor(incoming / 64) * 64 + flags);
    }
  }
});

test('literal SUBI words advance across word 0xffff with fetch-only bus activity and identical replays', () => {
  function run() {
    const cpu = machine();
    cpu.pc = 0xfffe;
    cpu.r[16] = 0x10;
    cpu.sreg = 0xff;
    const words = [0x5001, 0x500f, 0x5800]; // R16 minus 1, 15, then 128.
    const expected = [[0x0f, 0xe0], [0x00, 0xc2], [0x80, 0xcd]];
    const ram = cpu.sram.slice(), eeprom = cpu.eeprom.slice();
    words.forEach((word, index) => place(cpu, 0xfffe + index, word));
    const flash = cpu.flash.slice();
    const traces = words.map((word, i) => {
      const pc = 0xfffe + i;
      const before = cpu.state();
      const trace = cpu.step();
      const registers = before.registers.slice();
      registers[16] = expected[i][0];
      assert.deepEqual(trace.after, { ...before, registers, pcWord: pc + 1, sreg: expected[i][1], cycles: i + 1 });
      assert.deepEqual(trace.accesses, [
        { kind: 'fetch', space: 'flash', addressByte: 2 * pc, value: word % 256, loaded: true },
        { kind: 'fetch', space: 'flash', addressByte: 2 * pc + 1, value: Math.floor(word / 256), loaded: true },
      ]);
      return trace;
    });
    assert.deepEqual(cpu.sram, ram);
    assert.deepEqual(cpu.eeprom, eeprom);
    assert.deepEqual(cpu.flash, flash);
    return traces;
  }
  assert.deepEqual(run(), run());
});

test('incomplete fetches, invalid fall-through and reserved words stop before retirement; SBCI operands decode independently', () => {
  const cpu = machine();
  cpu.r.fill(0x23);
  cpu.sreg = 0xff;
  function checkFault(predicate) {
    const before = cpu.state();
    assert.throws(() => cpu.step(), error => error instanceof ExecutionFault &&
      error.trace.instructionCompleted === false && predicate(error));
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  for (const missing of [0, 1]) {
    place(cpu, 0, 0x5001);
    cpu.present[missing] = 0;
    checkFault(e => e.classification === 'FLASH_HOLE' && e.addressByte === missing);
  }
  cpu.pc = cpu.flash.length / 2 - 1;
  place(cpu, cpu.pc, 0x5001);
  checkFault(e => /PC target outside device/.test(e.message));
  cpu.pc = 0;
  for (const [word, register, immediate] of [[0x4000, 16, 0], [0x4a3b, 19, 0xab], [0x4ff0, 31, 0xf0]]) {
    place(cpu, 0, word);
    const decoded = decodeAt(cpu);
    assert.equal(decoded.mnemonic, 'SBCI');
    assert.deepEqual(decoded.operands, { register, immediate });
  }
  for (const word of [0xfffd, 0xfffe, 0xffff]) {
    place(cpu, 0, word);
    checkFault(e => e.opcode === word && /Unsupported instruction/.test(e.message));
  }
});
