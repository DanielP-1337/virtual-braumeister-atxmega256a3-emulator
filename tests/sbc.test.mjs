import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
  cpu.rampz = 2; cpu.eind = 1; cpu.sp = 0x5577;
  return cpu;
}

function put(cpu, pc, word) {
  cpu.flash.set([word & 255, word >>> 8], 2 * pc);
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
}

// Microchip 6.93.1, from the most significant instruction bit to the least.
const reg = n => n.toString(2).padStart(5, '0');
function sbc(d, r) {
  return Number.parseInt('000010' + reg(r)[0] + reg(d) + reg(r).slice(1), 2);
}

const signedByte = n => n < 128 ? n : n - 256;

// Subtract a single column at a time to obtain the two borrows independently.
function difference(a, b, borrow) {
  const wide = signedByte(a) - signedByte(b) - borrow;
  let result = 0, halfBorrow = 0;
  for (let bit = 0; bit < 8; bit++) {
    const column = ((a >>> bit) & 1) - ((b >>> bit) & 1) - borrow;
    result += (column & 1) * 2 ** bit;
    borrow = Number(column < 0);
    if (bit === 3) halfBorrow = borrow;
  }
  const flagsWithoutZ = 32 * halfBorrow + 16 * (wide < 0) + 8 * (wide < -128 || wide > 127)
    + 4 * (result >= 128) + borrow;
  return { result, flagsWithoutZ };
}

test('SBC decodes every ordered register pair and changes only Rd and the specified flags in one clock', () => {
  const cpu = machine();
  assert.deepEqual([sbc(0, 0), sbc(26, 26), sbc(23, 19), sbc(31, 31)], [0x0800, 0x0baa, 0x0b73, 0x0bff]);
  const words = new Set();
  for (let d = 0; d < 32; d++) for (let r = 0; r < 32; r++) {
    const word = sbc(d, r);
    words.add(word);
    put(cpu, 0, word);
    for (let cz = 0; cz < 4; cz++) {
      cpu.pc = 0;
      for (let i = 0; i < 32; i++) cpu.r[i] = (17 * i + 5 * d + 7 * r) & 255;
      cpu.sreg = ((17 * d + 31 * r) & 0xfc) | cz;
      const decoded = decodeAt(cpu);
      assert.deepEqual([decoded.mnemonic, decoded.operands], ['SBC', { destinationRegister: d, sourceRegister: r }]);
      const before = cpu.state(), steps = cpu.steps;
      const { result, flagsWithoutZ } = difference(cpu.r[d], cpu.r[r], cz & 1);
      const registers = [...before.registers];
      registers[d] = result;
      const trace = cpu.step();
      assert.equal(trace.mnemonic, 'SBC');
      assert.equal(trace.step, steps + 1);
      assert.deepEqual(trace.after, { ...before, pcWord: 1, cycles: before.cycles + 1, registers,
        sreg: (before.sreg & 0xc0) | flagsWithoutZ | (result === 0 ? cz & 2 : 0) });
      assert.deepEqual(trace.accesses.map(a => [a.space, a.kind, a.addressByte]), [['flash', 'fetch', 0], ['flash', 'fetch', 1]]);
    }
  }
  assert.equal(words.size, 1024);
});

test('SBC checks every byte pair with both borrow inputs and both prior zero states', () => {
  const cpu = machine();
  put(cpu, 0, sbc(9, 27));
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    for (let c = 0; c < 2; c++) {
      const { result, flagsWithoutZ } = difference(a, b, c);
      for (const z of [0, 2]) {
        const initial = ((a + b * 11) & 0xfc) | z | c;
        cpu.pc = 0; cpu.r[9] = a; cpu.r[27] = b; cpu.sreg = initial;
        cpu.step();
        assert.equal(cpu.r[9], result);
        assert.equal(cpu.r[27], b);
        assert.equal(cpu.sreg, (initial & 0xc0) | flagsWithoutZ | (result === 0 ? z : 0));
      }
    }
  }
});

test('SBC Rd,Rd forms a zero or all-ones byte for all 32 registers, 256 values and C/Z inputs', () => {
  const cpu = machine();
  for (let d = 0; d < 32; d++) {
    put(cpu, 0, sbc(d, d));
    for (let input = 0; input < 256; input++) for (let cz = 0; cz < 4; cz++) {
      const prior = ((input + 13 * d) & 0xfc) | cz;
      cpu.pc = 0; cpu.r[d] = input; cpu.sreg = prior;
      cpu.step();
      const withBorrow = (cz & 1) === 1;
      assert.equal(cpu.r[d], withBorrow ? 0xff : 0);
      assert.equal(cpu.sreg, (prior & 0xc0) | (withBorrow ? 0x35 : cz & 2));
    }
  }
});

test('SBC fixed borrow and overflow boundaries preserve I/T for all 256 incoming SREG values', () => {
  const cpu = machine();
  put(cpu, 0, sbc(6, 23));
  // Each pair gives the expected result and new H/S/V/N/C for an initial borrow of 0 or 1.
  for (const [a, b, clear, set] of [
    [0, 0, [0, 0], [0xff, 0x35]], [0, 0xff, [1, 0x21], [0, 0x21]],
    [0x80, 0x7f, [1, 0x38], [0, 0x38]], [0x7f, 0xff, [0x80, 0x0d], [0x7f, 0x21]],
    [0x10, 0x0f, [1, 0x20], [0, 0x20]], [0x7f, 0x80, [0xff, 0x0d], [0xfe, 0x0d]],
  ]) for (let prior = 0; prior < 256; prior++) {
    const [result, flags] = (prior & 1) ? set : clear;
    cpu.pc = 0; cpu.r[6] = a; cpu.r[23] = b; cpu.sreg = prior;
    cpu.step();
    assert.deepEqual([cpu.r[6], cpu.sreg], [result, (prior & 0xc0) | flags | (result === 0 ? prior & 2 : 0)]);
  }
});

test('SBC propagates borrow and chained Z across three bytes and drives signed, unsigned and equality branches', () => {
  const start = 0xfffd;
  const asSigned = n => n < 0x800000 ? n : n - 0x1000000;
  function replay() {
    const cpu = machine(), traces = [];
    for (let i = 0; i < 3; i++) put(cpu, start + i, sbc(3 + i, 20 + i));
    for (const [a, b] of [[0, 0], [0, 1], [0x10000, 1], [0x123455, 0x123456], [0x123457, 0x123456],
      [0x800000, 0x7fffff], [0x7fffff, 0x800000], [0xffffff, 0xffffff]]) {
      for (const [bit, taken] of [[0, a < b], [1, a === b], [4, asSigned(a) < asSigned(b)]]) {
        put(cpu, start + 3, 0xf008 + bit); // BRBS bit,+1
        for (let i = 0; i < 3; i++) {
          cpu.r[3 + i] = a >>> (8 * i);
          cpu.r[20 + i] = b >>> (8 * i);
        }
        cpu.pc = start; cpu.sreg = 2; // Start the chain with Z set and no borrow.
        const clock = cpu.cycles;
        for (let n = 0; n < 4; n++) traces.push(cpu.step());
        const result = cpu.r[3] + (cpu.r[4] << 8) + (cpu.r[5] << 16);
        assert.deepEqual([result, cpu.pc, cpu.cycles - clock], [(a - b) & 0xffffff, start + 4 + Number(taken), 4 + Number(taken)]);
      }
    }
    return traces;
  }
  assert.deepEqual(replay(), replay());
});

test('SBC rejects missing instruction bytes and invalid fall-through before changing any CPU state', () => {
  const cpu = machine();
  const last = cpu.flash.length / 2 - 1;
  for (const [pc, missing] of [[0, 0], [3, 1], [last, null]]) {
    put(cpu, pc, sbc(2, 29));
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    cpu.pc = pc; cpu.r[2] = 0x80; cpu.r[29] = 0x7f; cpu.sreg = 0xa3;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
});
