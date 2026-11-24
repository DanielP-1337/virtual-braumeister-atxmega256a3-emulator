import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
  cpu.sp = 0x4879; cpu.rampz = 3; cpu.eind = 1;
  return cpu;
}

function place(cpu, pc, ...words) {
  let address = 2 * pc;
  for (const word of words) {
    cpu.present.fill(1, address, address + 2);
    cpu.flash[address++] = word & 255;
    cpu.flash[address++] = word >>> 8;
  }
}

const dec = rd => Number.parseInt('1001010' + rd.toString(2).padStart(5, '0') + '1010', 2);

// Use the unbounded signed result for S and overflow, independently of the CPU flag calculation.
function expected(byte, oldFlags) {
  const signed = byte < 128 ? byte : byte - 256;
  const mathematical = signed - 1;
  const value = (mathematical + 256) % 256;
  const preserved = Math.floor(oldFlags / 32) * 32 + (oldFlags % 2);
  const flags = preserved + 16 * (mathematical < 0) + 8 * (mathematical < -128)
    + 4 * (value >= 128) + 2 * (value === 0);
  return { value, flags };
}

test('DEC covers all 32 encodings and every input byte, with register isolation and one AVRxm clock', () => {
  const cpu = machine(), words = new Set();
  assert.deepEqual([dec(0), dec(15), dec(16), dec(29), dec(31)], [0x940a, 0x94fa, 0x950a, 0x95da, 0x95fa]);
  for (let rd = 0; rd < 32; rd++) {
    place(cpu, 0, dec(rd));
    words.add(dec(rd));
    for (let byte = 0; byte < 256; byte++) {
      cpu.pc = 0; cpu.sreg = (byte + 29 * rd) & 255;
      for (let i = 0; i < 32; i++) cpu.r[i] = (byte + 11 * i) & 255;
      cpu.r[rd] = byte;
      const before = cpu.state(), steps = cpu.steps;
      const decoded = decodeAt(cpu);
      assert.deepEqual([decoded.mnemonic, decoded.operands], ['DEC', { register: rd }]);
      const { value, flags } = expected(byte, before.sreg);
      const registers = [...before.registers]; registers[rd] = value;
      const t = cpu.step();
      assert.deepEqual([t.mnemonic, t.opcode, t.step], ['DEC', dec(rd), steps + 1]);
      assert.deepEqual(t.after, { ...before, registers, pcWord: 1, cycles: before.cycles + 1, sreg: flags });
      assert.deepEqual(t.accesses.map(a => [a.space, a.kind, a.addressByte]), [['flash', 'fetch', 0], ['flash', 'fetch', 1]]);
    }
  }
  assert.equal(words.size, 32);
});

test('DEC recomputes S/V/N/Z and preserves I/T/H/C for all 65,536 byte and SREG combinations', () => {
  const cpu = machine();
  place(cpu, 0, dec(13));
  // Expected S/V/N/Z at the significant sign, wrap, overflow and zero boundaries.
  const boundaries = new Map([[0, 0x14], [1, 0x02], [2, 0], [0x10, 0], [0x7f, 0],
    [0x80, 0x18], [0x81, 0x14], [0xff, 0x14]]);
  for (let byte = 0; byte < 256; byte++) for (let initial = 0; initial < 256; initial++) {
    cpu.pc = 0; cpu.r[13] = byte; cpu.sreg = initial;
    const { value, flags } = expected(byte, initial);
    cpu.step();
    assert.equal(cpu.r[13], value);
    assert.equal(cpu.sreg, flags);
    if (boundaries.has(byte)) assert.equal(cpu.sreg, (initial & 0xe1) | boundaries.get(byte));
  }
});

test('DEC drives zero, sign, negative and overflow branches across a word-PC bank boundary', () => {
  const cpu = machine(), start = 0xfffe;
  for (const [input, flags] of [[0, 0x14], [1, 2], [2, 0], [0x80, 0x18], [0x81, 0x14]]) {
    for (const bit of [1, 2, 3, 4]) {
      place(cpu, start, dec(2), 0xf008 + bit); // BRBS bit,+1
      cpu.pc = start; cpu.r[2] = input; cpu.sreg = (~flags) & 0xff;
      const clock = cpu.cycles, taken = (flags >>> bit) & 1;
      cpu.step(); cpu.step();
      assert.deepEqual([cpu.pc, cpu.cycles - clock], [0x10000 + taken, 2 + taken]);
    }
  }
});

test('DEC and BRNE count down from zero and positive values with deterministic traces', () => {
  function replay(input) {
    const cpu = machine(), records = [];
    place(cpu, 0, dec(4), 0xf7f1); // BRNE -2
    cpu.r[4] = input; cpu.sreg = 0xe1;
    const iterations = input || 256;
    for (let i = 0; i < iterations; i++) {
      assert.equal(cpu.pc, 0);
      records.push(cpu.step(), cpu.step());
    }
    assert.deepEqual([cpu.pc, cpu.r[4], cpu.sreg, cpu.steps, cpu.cycles], [2, 0, 0xe3, iterations * 2, iterations * 3 - 1]);
    return records;
  }
  for (const input of [0, 1, 3, 0x80]) assert.deepEqual(replay(input), replay(input));
});

test('DEC on YH leaves YL and SP intact until explicit stack-pointer writes', () => {
  const cpu = machine();
  place(cpu, 0, 0xb7cd, 0xb7de, dec(29), 0xbfcd, 0xbfde); // IN YL,SPL / IN YH,SPH / DEC YH / OUT SPL,YL / OUT SPH,YH
  for (const stack of [0x4000, 0x45ff, 0x5ff7]) {
    cpu.pc = 0; cpu.sp = stack; cpu.sreg = 2;
    cpu.step(); cpu.step();
    const t = cpu.step();
    assert.deepEqual([cpu.pair(28), cpu.sp, cpu.sreg, t.accesses.length], [stack - 0x100, stack, 0, 2]);
    cpu.step();
    assert.equal(cpu.sp, stack);
    cpu.step();
    assert.equal(cpu.sp, stack - 0x100);
  }
});

test('DEC rejects either missing fetch byte and out-of-range fall-through without committing state', () => {
  const cpu = machine(), last = cpu.flash.length / 2 - 1;
  for (const [pc, missing] of [[0, 0], [7, 1], [last, null]]) {
    place(cpu, pc, dec(3));
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    cpu.pc = pc; cpu.r[3] = 0x80; cpu.sreg = 0xa3;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
});
