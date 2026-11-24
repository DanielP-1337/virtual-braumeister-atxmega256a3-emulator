import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
}

function put(cpu, pc, ...words) {
  let address = pc * 2;
  for (const word of words) {
    cpu.present.fill(1, address, address + 2);
    cpu.flash[address++] = word & 255;
    cpu.flash[address++] = word >>> 8;
  }
}

// Manual opcode fields, written most significant bit first.
const reg = n => n.toString(2).padStart(5, '0');
const inc = d => Number.parseInt('1001010' + reg(d) + '0011', 2);
const cp = (d, r) => Number.parseInt('000101' + reg(r)[0] + reg(d) + reg(r).slice(1), 2);
const signed = b => b < 128 ? b : b - 256;

function incrementFlags(byte, flags) {
  const mathematical = signed(byte) + 1;
  const result = (byte + 1) % 256;
  return (flags & 0xe1) + 16 * (mathematical < 0) + 8 * (mathematical > 127)
    + 4 * (result >= 128) + 2 * (result === 0);
}

function compareFlags(left, right, flags) {
  // A one-bit subtractor exposes the borrow after bits 3 and 7 independently.
  let borrow = 0, halfBorrow = 0, difference = 0;
  for (let bit = 0; bit < 8; bit++) {
    const a = (left >>> bit) & 1, b = (right >>> bit) & 1;
    difference += (a ^ b ^ borrow) * 2 ** bit;
    borrow = ((1 - a) & (b | borrow)) | (b & borrow);
    if (bit === 3) halfBorrow = borrow;
  }
  const mathematical = signed(left) - signed(right);
  return (flags & 0xc0) + 32 * halfBorrow + 16 * (mathematical < 0)
    + 8 * (mathematical < -128 || mathematical > 127) + 4 * (difference >= 128)
    + 2 * (difference === 0) + borrow;
}

test('INC checks all 32 encodings and 256 byte values with register isolation and one-clock timing', () => {
  const cpu = machine();
  assert.deepEqual([inc(0), inc(13), inc(31)], [0x9403, 0x94d3, 0x95f3]);
  cpu.rampz = 3;
  cpu.eind = 1;
  for (let rd = 0; rd < 32; rd++) {
    put(cpu, 0, inc(rd));
    assert.deepEqual(decodeAt(cpu, 0).operands, { register: rd });
    for (let value = 0; value < 256; value++) {
      cpu.pc = 0;
      for (let i = 0; i < 32; i++) cpu.r[i] = i + 0x20;
      cpu.r[rd] = value;
      cpu.sreg = (value + 17 * rd) % 256;
      const before = cpu.state();
      const registers = [...before.registers];
      registers[rd] = (value + 1) % 256;
      const steps = cpu.steps;
      const trace = cpu.step();
      assert.equal(trace.mnemonic, 'INC');
      assert.deepEqual(cpu.state(), { ...before, pcWord: 1, cycles: before.cycles + 1,
        registers, sreg: incrementFlags(value, before.sreg) });
      assert.equal(cpu.steps, steps + 1);
      assert.deepEqual(trace.accesses.map(a => [a.kind, a.space, a.addressByte]), [['fetch', 'flash', 0], ['fetch', 'flash', 1]]);
    }
  }
});

test('INC overflow, wrap and sign transitions preserve I, T, H and C for all incoming SREG bytes', () => {
  const cpu = machine();
  put(cpu, 0, inc(7));
  // New Z/N/V/S bits are fixed independently for these boundary cases.
  for (const [input, output, flags] of [[0, 1, 0], [0x7e, 0x7f, 0], [0x7f, 0x80, 0x0c],
    [0x80, 0x81, 0x14], [0xfe, 0xff, 0x14], [0xff, 0, 0x02]]) {
    for (let initial = 0; initial < 256; initial++) {
      cpu.pc = 0; cpu.r[7] = input; cpu.sreg = initial;
      cpu.step();
      assert.deepEqual([cpu.r[7], cpu.sreg], [output, (initial & 0xe1) | flags]);
    }
  }
});

test('CP decodes all 1,024 ordered register pairs, preserves both operands and only fetches its own word', () => {
  const cpu = machine();
  assert.deepEqual([cp(0, 0), cp(24, 16), cp(31, 31)], [0x1400, 0x1780, 0x17ff]);
  cpu.rampz = 2; cpu.eind = 1;
  for (let d = 0; d < 32; d++) {
    for (let r = 0; r < 32; r++) {
      put(cpu, 0, cp(d, r));
      for (const [a, b] of [[0, 0xff], [0x80, 0x7f], [0x10, 0x10]]) {
        cpu.pc = 0;
        for (let i = 0; i < 32; i++) cpu.r[i] = i * 7;
        cpu.r[d] = a;
        if (d !== r) cpu.r[r] = b;
        cpu.sreg = (13 * r + d) % 256;
        const before = cpu.state();
        const decoded = decodeAt(cpu);
        assert.equal(decoded.mnemonic, 'CP');
        assert.deepEqual(decoded.operands, { leftRegister: d, rightRegister: r });
        const steps = cpu.steps;
        const trace = cpu.step();
        assert.equal(trace.mnemonic, 'CP');
        assert.deepEqual(cpu.state(), { ...before, pcWord: 1, cycles: before.cycles + 1,
          sreg: compareFlags(before.registers[d], before.registers[r], before.sreg) });
        assert.equal(cpu.steps, steps + 1);
        assert.deepEqual(trace.accesses.map(a => [a.kind, a.space, a.addressByte]), [['fetch', 'flash', 0], ['fetch', 'flash', 1]]);
      }
    }
  }
});

test('CP flags cover every byte pair and incoming C/Z combination with an independent borrow oracle', () => {
  const cpu = machine();
  put(cpu, 0, cp(17, 2));
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      for (let cz = 0; cz < 4; cz++) {
        const flags = ((a + 3 * b) & 0xfc) | cz;
        cpu.pc = 0; cpu.r[17] = a; cpu.r[2] = b; cpu.sreg = flags;
        cpu.step();
        assert.equal(cpu.sreg, compareFlags(a, b, flags));
        assert.equal(cpu.r[17], a);
        assert.equal(cpu.r[2], b);
      }
    }
  }
});

test('CP followed by CPC drives 16-bit equality, unsigned and signed branches', () => {
  const cpu = machine();
  const signedWord = v => v < 0x8000 ? v : v - 0x10000;
  for (const [a, b] of [[0, 0], [0x0100, 1], [0x1200, 0x1201], [0x1201, 0x1200],
    [0x8000, 0x7fff], [0x7fff, 0x8000], [0xffff, 0xffff], [0xff, 0x100]]) {
    for (const [bit, taken] of [[1, a === b], [0, a < b], [4, signedWord(a) < signedWord(b)]]) {
      put(cpu, 0, cp(2, 4), 0x0435, 0xf008 + bit, 0, 0); // CPC R3,R5 and BRBS bit,+1.
      cpu.pc = 0; cpu.sreg = 0xff;
      cpu.setPair(2, a); cpu.setPair(4, b);
      const cycles = cpu.cycles;
      cpu.step(); cpu.step(); cpu.step();
      assert.deepEqual([cpu.pc, cpu.cycles - cycles, cpu.pair(2), cpu.pair(4)], [taken ? 4 : 3, taken ? 4 : 3, a, b]);
    }
  }
});

test('INC and CP reject incomplete fetches and invalid fall-through before committing state', () => {
  for (const opcode of [inc(19), cp(7, 25)]) {
    const cpu = machine();
    const last = cpu.flash.length / 2 - 1;
    cpu.r[19] = 0xff; cpu.r[7] = 0x80; cpu.sreg = 0xad;
    for (const pc of [0, last]) {
      put(cpu, pc, opcode);
      cpu.pc = pc;
      if (pc === 0) cpu.present[1] = 0;
      const before = cpu.state();
      assert.throws(() => cpu.step(), pc === 0 ? /HEX hole/ : /PC target outside device/);
      assert.deepEqual(cpu.state(), before);
      assert.equal(cpu.steps, 0);
    }
    cpu.pc = 0xffff;
    put(cpu, cpu.pc, opcode);
    const trace = cpu.step();
    assert.deepEqual([trace.after.pcWord, cpu.cycles, cpu.steps], [0x10000, 1, 1]);
  }
});
