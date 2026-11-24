import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
}

function put(cpu, pc, word) {
  cpu.flash.set([word & 255, word >>> 8], pc * 2);
  cpu.present.fill(1, pc * 2, pc * 2 + 2);
}

// Microchip section 6.1.1 lists the two source-register fields separately.
function adcWord(rd, rr) {
  const source = rr.toString(2).padStart(5, '0');
  const dest = rd.toString(2).padStart(5, '0');
  return Number.parseInt('000111' + source[0] + dest + source.slice(1), 2);
}

// Propagate one full adder per bit. Overflow is the XOR of carries into and out of the sign bit.
function expected(a, b, carry) {
  let value = 0, half = 0, signCarry = 0;
  for (let bit = 0; bit < 8; bit++) {
    const left = (a >>> bit) & 1, right = (b >>> bit) & 1;
    if (bit === 7) signCarry = carry;
    value |= (left ^ right ^ carry) << bit;
    carry = (left & right) | (left & carry) | (right & carry);
    if (bit === 3) half = carry;
  }
  const negative = value >>> 7, overflow = signCarry ^ carry;
  const flags = half * 32 + (negative ^ overflow) * 16 + overflow * 8 + negative * 4 + Number(value === 0) * 2 + carry;
  return [value, flags];
}

test('ADC decodes all 1,024 register pairs and takes one AVRxm clock for either carry input', () => {
  const cpu = machine();
  assert.deepEqual([adcWord(0, 0), adcWord(23, 23), adcWord(31, 31)], [0x1c00, 0x1f77, 0x1fff]);
  cpu.sp = 0x4231; cpu.rampz = 2; cpu.eind = 1;
  const words = new Set();
  for (let rd = 0; rd < 32; rd++) for (let rr = 0; rr < 32; rr++) {
    const word = adcWord(rd, rr);
    words.add(word); put(cpu, 0, word);
    for (const carry of [0, 1]) {
      cpu.pc = 0;
      for (let i = 0; i < 32; i++) cpu.r[i] = (29 * i + rd + rr * 13) & 255;
      cpu.sreg = ((5 * rd + 27 * rr) & 254) | carry;
      const before = cpu.state(), steps = cpu.steps;
      const registers = [...before.registers];
      const [value, flags] = expected(registers[rd], registers[rr], carry);
      registers[rd] = value;
      const decoded = decodeAt(cpu);
      assert.deepEqual([decoded.mnemonic, decoded.operands], ['ADC', { destinationRegister: rd, sourceRegister: rr }]);
      const t = cpu.step();
      assert.deepEqual([t.mnemonic, t.opcode, t.step], ['ADC', word, steps + 1]);
      assert.deepEqual(t.after, { ...before, pcWord: 1, cycles: before.cycles + 1, registers, sreg: (before.sreg & 0xc0) | flags });
      assert.deepEqual(t.accesses.map(a => [a.space, a.kind, a.addressByte, a.value]),
        [['flash', 'fetch', 0, word & 255], ['flash', 'fetch', 1, word >>> 8]]);
    }
  }
  assert.equal(words.size, 1024);
});

test('ADC checks every pair of byte values with both C and Z inputs against a bit-serial adder', () => {
  const cpu = machine();
  put(cpu, 0, adcWord(3, 29));
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) for (const carry of [0, 1]) {
    const [value, flags] = expected(a, b, carry);
    for (const z of [0, 2]) {
      const initial = ((7 * a + 19 * b) & 0xfc) | z | carry;
      cpu.pc = 0; cpu.r[3] = a; cpu.r[29] = b; cpu.sreg = initial;
      cpu.step();
      assert.equal(cpu.r[3], value);
      assert.equal(cpu.r[29], b);
      assert.equal(cpu.sreg, (initial & 0xc0) | flags);
    }
  }
});

test('ADC Rd,Rd rotates every byte in every register through both carry inputs', () => {
  const cpu = machine();
  for (let rd = 0; rd < 32; rd++) {
    put(cpu, 0, adcWord(rd, rd));
    for (let byte = 0; byte < 256; byte++) for (const carry of [0, 1]) {
      const outgoing = byte >>> 7, negative = (byte >>> 6) & 1;
      const value = ((byte & 127) << 1) | carry;
      const initial = ((byte + rd) & 254) | carry;
      const flags = ((byte >>> 3) & 1) * 32 + outgoing * 16 + (negative ^ outgoing) * 8
        + negative * 4 + Number(value === 0) * 2 + outgoing;
      cpu.pc = 0; cpu.r[rd] = byte; cpu.sreg = initial;
      cpu.step();
      assert.deepEqual([cpu.r[rd], cpu.sreg], [value, (initial & 0xc0) | flags]);
    }
  }
});

test('ADC replaces the six arithmetic flags and preserves I and T under all 256 initial SREG values', () => {
  const cases = [
    // Operands, then result/flags for carry zero followed by result/flags for carry one.
    [0, 0, 0, 2, 1, 0], [0x0f, 0, 15, 0, 16, 0x20], [0x7f, 0, 0x7f, 0, 0x80, 0x2c],
    [0x80, 0x80, 0, 0x1b, 1, 0x19], [0x80, 0x7f, 0xff, 0x14, 0, 0x23],
    [0xff, 0, 0xff, 0x14, 0, 0x23], [0xff, 0xff, 0xfe, 0x35, 0xff, 0x35],
  ];
  const cpu = machine(); put(cpu, 0, adcWord(14, 8));
  for (const [a, b, value0, flags0, value1, flags1] of cases) for (let initial = 0; initial < 256; initial++) {
    cpu.pc = 0; cpu.r[14] = a; cpu.r[8] = b; cpu.sreg = initial;
    cpu.step();
    const carry = initial & 1;
    assert.deepEqual([cpu.r[14], cpu.sreg], [carry ? value1 : value0, (initial & 0xc0) | (carry ? flags1 : flags0)]);
  }
});

test('ADC consumes ADD carry across bytes and branches on the high-byte zero flag deterministically', () => {
  function replay() {
    const cpu = machine(), trace = [];
    put(cpu, 0, 0x0d02); // ADD R16,R2
    put(cpu, 1, adcWord(17, 3));
    put(cpu, 2, 0xf009); // BRBS Z,+1
    for (const [left, right, sum, highFlags] of [
      [0x00ff, 1, 0x0100, 0], [1, 0, 1, 2], [0xffff, 1, 0, 0x23],
      [0x7fff, 1, 0x8000, 0x2c], [0x8000, 0x8000, 0, 0x1b],
    ]) {
      cpu.pc = 0; cpu.setPair(16, left); cpu.setPair(2, right); cpu.sreg = 0xc3;
      const start = cpu.cycles, low = cpu.step(), high = cpu.step(), branch = cpu.step();
      const taken = (highFlags >>> 1) & 1;
      assert.deepEqual([low.mnemonic, high.mnemonic, high.before.sreg & 1],
        ['ADD', 'ADC', Number((left & 255) + (right & 255) > 255)]);
      assert.deepEqual([cpu.pair(16), cpu.pair(2), cpu.sreg, cpu.pc, cpu.cycles - start],
        [sum, right, 0xc0 | highFlags, 3 + taken, 3 + taken]);
      trace.push(low, high, branch);
    }
    return trace;
  }
  assert.deepEqual(replay(), replay());
});

test('ADC validates sparse fetches and out-of-range fall-through before committing, including at a 64K word boundary', () => {
  const cpu = machine();
  cpu.r[9] = 0xff; cpu.sreg = 0xc1;
  for (const [pc, missing] of [[0, 0], [1, 1], [cpu.flash.length / 2 - 1, null]]) {
    put(cpu, pc, adcWord(9, 9)); cpu.pc = pc;
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  put(cpu, 0xffff, adcWord(9, 9)); cpu.pc = 0xffff;
  const t = cpu.step();
  assert.deepEqual([t.after.pcWord, t.after.cycles, t.after.registers[9], t.after.sreg], [0x10000, 1, 255, 0xf5]);
});
