import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
}

function put(cpu, pc, word) {
  cpu.flash[pc * 2] = word & 255;
  cpu.flash[pc * 2 + 1] = word >>> 8;
  cpu.present.fill(1, pc * 2, pc * 2 + 2);
}

function addWord(d, r) {
  const dest = d.toString(2).padStart(5, '0');
  const src = r.toString(2).padStart(5, '0');
  return Number.parseInt('000011' + src[0] + dest + src.slice(1), 2);
}

// Count the on-bits in each full-adder column, independently of the CPU's byte arithmetic.
function expectedSum(a, b) {
  let value = 0, carry = 0, halfCarry = 0;
  for (let bit = 0; bit < 8; bit++) {
    const column = ((a >>> bit) & 1) + ((b >>> bit) & 1) + carry;
    value += (column % 2) * 2 ** bit;
    carry = Math.floor(column / 2);
    if (bit === 3) halfCarry = carry;
  }
  const signed = byte => byte < 128 ? byte : byte - 256;
  const wide = signed(a) + signed(b);
  const flags = 32 * halfCarry + 16 * (wide < 0) + 8 * (wide < -128 || wide > 127)
    + 4 * (value >= 128) + 2 * (value === 0) + carry;
  return { value, flags };
}

test('ADD decodes all 1,024 register pairs and changes only the destination and documented flags', () => {
  const cpu = machine();
  cpu.rampz = 3; cpu.eind = 1; cpu.sp = 0x5efa;
  assert.deepEqual([addWord(0, 0), addWord(25, 25), addWord(31, 31)], [0x0c00, 0x0f99, 0x0fff]);
  for (let d = 0; d < 32; d++) for (let r = 0; r < 32; r++) {
    put(cpu, 0, addWord(d, r));
    cpu.pc = 0;
    for (let i = 0; i < 32; i++) cpu.r[i] = (17 * i + d + 3 * r) & 255;
    cpu.sreg = (5 * d + 27 * r) & 255;
    const before = cpu.state();
    const expected = expectedSum(cpu.r[d], cpu.r[r]);
    const registers = [...before.registers];
    registers[d] = expected.value;
    const decoded = decodeAt(cpu);
    assert.deepEqual([decoded.mnemonic, decoded.operands], ['ADD', { destinationRegister: d, sourceRegister: r }]);
    const step = cpu.steps;
    const t = cpu.step();
    assert.equal(t.mnemonic, 'ADD');
    assert.deepEqual(t.after, { ...before, registers, sreg: (before.sreg & 0xc0) | expected.flags,
      cycles: before.cycles + 1, pcWord: 1 });
    assert.equal(cpu.steps, step + 1);
    assert.deepEqual(t.accesses.map(a => [a.space, a.kind, a.addressByte]), [['flash', 'fetch', 0], ['flash', 'fetch', 1]]);
  }
});

test('ADD checks all byte pairs and incoming C/Z combinations against a bit-by-bit adder', () => {
  const cpu = machine();
  put(cpu, 0, addWord(13, 19));
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    const { value, flags } = expectedSum(a, b);
    for (let cz = 0; cz < 4; cz++) {
      const initial = ((a + 3 * b) & 0xfc) | cz;
      cpu.pc = 0; cpu.r[13] = a; cpu.r[19] = b; cpu.sreg = initial;
      cpu.step();
      assert.equal(cpu.r[13], value);
      assert.equal(cpu.r[19], b);
      assert.equal(cpu.sreg, (initial & 0xc0) | flags);
    }
  }
});

test('ADD Rd,Rd matches LSL for every register and input byte using shifted-out bits', () => {
  const cpu = machine();
  for (let d = 0; d < 32; d++) {
    put(cpu, 0, addWord(d, d));
    for (let a = 0; a < 256; a++) {
      const c = a >>> 7, n = (a >>> 6) & 1, h = (a >>> 3) & 1;
      const flags = 32 * h + 16 * c + 8 * (n ^ c) + 4 * n + 2 * ((a & 127) === 0) + c;
      const initial = (a + d) & 255;
      cpu.pc = 0; cpu.r[d] = a; cpu.sreg = initial;
      cpu.step();
      assert.equal(cpu.r[d], (a & 127) << 1);
      assert.equal(cpu.sreg, (initial & 0xc0) | flags);
    }
  }
});

test('ADD replaces H/S/V/N/Z/C and preserves I/T under every incoming SREG pattern', () => {
  const cpu = machine();
  put(cpu, 0, addWord(10, 11));
  for (const [a, b, result, flags] of [
    [0, 0, 0, 2], [0x0f, 1, 0x10, 0x20], [0x40, 0x40, 0x80, 0x0c],
    [0x7f, 1, 0x80, 0x2c], [0x80, 0x80, 0, 0x1b], [0xff, 1, 0, 0x23],
    [0xff, 0xff, 0xfe, 0x35], [0xff, 0, 0xff, 0x14],
  ]) for (let initial = 0; initial < 256; initial++) {
    cpu.pc = 0; cpu.r[10] = a; cpu.r[11] = b; cpu.sreg = initial;
    cpu.step();
    assert.deepEqual([cpu.r[10], cpu.sreg], [result, (initial & 0xc0) | flags]);
  }
});

test('ADD drives conditional branches from fresh flags with deterministic PC and AVRxm timing', () => {
  function replay() {
    const cpu = machine(), trace = [];
    put(cpu, 0, addWord(7, 8));
    for (const [a, b, flags] of [[0xff, 1, 0x23], [0x7f, 1, 0x2c], [0xff, 0xff, 0x35]]) {
      for (let bit = 0; bit < 6; bit++) {
        put(cpu, 1, 0xf008 + bit); // BRBS bit,+1
        cpu.pc = 0; cpu.r[7] = a; cpu.r[8] = b; cpu.sreg = (~flags) & 0xff;
        const start = cpu.cycles, taken = (flags >>> bit) & 1;
        trace.push(cpu.step(), cpu.step());
        assert.deepEqual([cpu.pc, cpu.cycles - start], [2 + taken, 2 + taken]);
      }
    }
    return trace;
  }
  assert.deepEqual(replay(), replay());
});

test('ADD rejects sparse fetches and invalid fall-through atomically and carries the word PC across 64K', () => {
  const cpu = machine(), last = cpu.flash.length / 2 - 1;
  cpu.r[3] = 0xff; cpu.sreg = 0xa5;
  for (const [pc, missing] of [[0, 0], [1, 1], [last, null]]) {
    put(cpu, pc, addWord(3, 3));
    cpu.pc = pc;
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  put(cpu, 0xffff, addWord(3, 3));
  cpu.pc = 0xffff;
  const t = cpu.step();
  assert.deepEqual([t.after.pcWord, t.after.cycles, t.after.registers[3]], [0x10000, 1, 0xfe]);
});
