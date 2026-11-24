import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU, ExecutionFault } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
  cpu.sp = 0x4567;
  cpu.rampz = 2;
  cpu.eind = 1;
  return cpu;
}

function place(cpu, pc, word) {
  cpu.flash.set([word % 256, Math.floor(word / 256)], 2 * pc);
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
}

// Manual section 6.94 orders the nibbles as 4, upper K, register selector, lower K.
function encode(register, k) {
  const [high, low] = k.toString(16).padStart(2, '0');
  return parseInt('4' + high + (register - 16).toString(16) + low, 16);
}

// Independent oracle: add the one's complement of K. Carry out of an adder
// means no borrow. Check signed overflow using ordinary, unbounded integers.
const signed = x => x < 128 ? x : x - 256;
function expected(a, k, borrow, oldZ) {
  const sum = a + (255 - k) + (1 - borrow);
  const byte = sum % 256;
  const half = a % 16 + (15 - k % 16) + (1 - borrow) < 16;
  const delta = signed(a) - signed(k) - borrow;
  const v = delta < -128 || delta > 127;
  const n = byte >= 128;
  const flags = 32 * half + 16 * (n !== v) + 8 * v + 4 * n +
    2 * (byte === 0 && oldZ === 1) + (sum < 256);
  return { byte, flags };
}

test('all 4,096 SBCI words encode R16 through R31 and the split immediate', () => {
  const cpu = machine();
  for (const [r, k, word] of [[16, 0, 0x4000], [31, 255, 0x4fff], [19, 0xab, 0x4a3b], [31, 0xf0, 0x4ff0]]) {
    assert.equal(encode(r, k), word);
  }
  const words = new Set();
  for (let r = 16; r <= 31; r++) {
    for (let k = 0; k < 256; k++) {
      const word = encode(r, k);
      words.add(word);
      place(cpu, 0, word);
      const decoded = decodeAt(cpu);
      assert.equal(decoded.mnemonic, 'SBCI');
      assert.deepEqual(decoded.operands, { register: r, immediate: k });
    }
  }
  assert.equal(words.size, 4096);
  assert.equal(cpu.accesses.length, 0);
});

test('4,194,304 independent SBCI cases cover every register, K, input byte, carry and prior Z in one AVRxm cycle', () => {
  const cpu = machine();
  for (let r = 16; r <= 31; r++) {
    for (let k = 0; k < 256; k++) place(cpu, (r - 16) * 256 + k, encode(r, k));
  }
  let retired = 0;
  for (let a = 0; a < 256; a++) {
    const initial = Uint8Array.from({ length: 32 }, (_, r) => (a + r * 39) % 256);
    const registers = initial.slice();
    cpu.r.set(initial);
    for (const carry of [0, 1]) {
      for (const oldZ of [0, 1]) {
        const row = Array.from({ length: 256 }, (_, k) => expected(a, k, carry, oldZ));
        cpu.pc = 0;
        for (let r = 16; r <= 31; r++) {
          for (let k = 0; k < 256; k++) {
            const pc = (r - 16) * 256 + k;
            const incoming = 4 * ((a + r + k) % 64) + 2 * oldZ + carry;
            cpu.r[r] = a;
            cpu.sreg = incoming;
            const trace = cpu.step();
            retired++;
            registers[r] = row[k].byte;
            assert.deepEqual(cpu.r, registers);
            assert.equal(cpu.sreg, Math.floor(incoming / 64) * 64 + row[k].flags);
            assert.equal(trace.mnemonic, 'SBCI');
            assert.equal(trace.before.pcWord, pc);
            assert.equal(cpu.pc, pc + 1);
            assert.equal(cpu.steps, retired);
            assert.equal(cpu.cycles, retired);
            assert.equal(trace.accesses.length, 2);
            assert.equal(trace.accesses[0].kind, 'fetch');
            assert.equal(trace.accesses[1].kind, 'fetch');
          }
          registers[r] = cpu.r[r] = initial[r];
        }
      }
    }
  }
  assert.equal(retired, 4194304);
  assert.equal(cpu.sp, 0x4567);
  assert.equal(cpu.rampz, 2);
  assert.equal(cpu.eind, 1);
});

test('hand-calculated borrow and overflow boundaries across all 256 incoming SREG values', () => {
  const cpu = machine();
  // Each row gives a, K, and two [result, flags excluding I/T/Z] pairs for C=0 and C=1.
  const vectors = [
    [0x00, 0x00, [0, 0], [0xff, 0x35]],
    [0x00, 0xff, [1, 0x21], [0, 0x21]],
    [0x80, 0x7f, [1, 0x38], [0, 0x38]],
    [0x7f, 0xff, [0x80, 0x0d], [0x7f, 0x21]],
    [0x10, 0x0f, [1, 0x20], [0, 0x20]],
    [0xff, 0xff, [0, 0], [0xff, 0x35]],
    [0x00, 0xf0, [0x10, 1], [0x0f, 0x21]],
  ];
  for (const [a, k, clear, set] of vectors) {
    place(cpu, 0, encode(29, k));
    for (let sreg = 0; sreg < 256; sreg++) {
      const [byte, flags] = sreg % 2 ? set : clear;
      cpu.pc = 0;
      cpu.r[29] = a;
      cpu.sreg = sreg;
      cpu.step();
      assert.equal(cpu.r[29], byte);
      assert.equal(cpu.sreg, (sreg & 0xc0) + flags + (byte === 0 ? sreg & 2 : 0));
    }
  }
});

test('24-bit SUBI/SBCI chains propagate borrow and zero across a flash bank with deterministic replay', () => {
  function run(a, k) {
    const cpu = machine();
    cpu.pc = 0xfffe;
    cpu.sreg = 0xff;
    const images = [cpu.sram.slice(), cpu.eeprom.slice()];
    const traces = [];
    for (let i = 0; i < 3; i++) {
      const weight = 256 ** i;
      const imm = Math.floor(k / weight) % 256;
      cpu.r[16 + i] = Math.floor(a / weight) % 256;
      const word = encode(16 + i, imm) + (i === 0 ? 0x1000 : 0);
      place(cpu, 0xfffe + i, word);
    }
    const flash = cpu.flash.slice();
    for (let i = 0; i < 3; i++) {
      const pc = cpu.pc;
      const modulus = 256 ** (i + 1);
      const difference = a % modulus - k % modulus;
      const trace = cpu.step();
      assert.equal(cpu.r[16 + i], Math.floor(((difference + modulus) % modulus) / (256 ** i)));
      assert.equal(cpu.sreg & 3, Number(difference < 0) + 2 * (difference === 0));
      assert.equal(cpu.sreg & 0xc0, 0xc0);
      assert.equal(trace.mnemonic, i === 0 ? 'SUBI' : 'SBCI');
      assert.equal(cpu.pc, 0xffff + i);
      assert.equal(cpu.cycles, i + 1);
      assert.deepEqual(trace.accesses, [0, 1].map(offset => ({
        kind: 'fetch', space: 'flash', addressByte: 2 * pc + offset, value: flash[2 * pc + offset], loaded: true,
      })));
      traces.push(trace);
    }
    assert.deepEqual(cpu.flash, flash);
    assert.deepEqual(cpu.sram, images[0]);
    assert.deepEqual(cpu.eeprom, images[1]);
    return traces;
  }
  for (const [a, k] of [[0, 1], [1, 1], [0x010000, 1], [0x800000, 1], [0xff00ff, 0xff00ff], [0x00ffff, 0xffffff]]) {
    assert.deepEqual(run(a, k), run(a, k));
  }
});

test('missing SBCI bytes and out-of-range fall-through fault before registers, flags or counters change', () => {
  for (const missing of [0, 1, null]) {
    const cpu = machine();
    cpu.pc = missing === null ? cpu.flash.length / 2 - 1 : 3;
    place(cpu, cpu.pc, 0x4001);
    cpu.sreg = 0xff;
    cpu.r[16] = 0x80;
    if (missing !== null) cpu.present[2 * cpu.pc + missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e instanceof ExecutionFault && !e.trace.instructionCompleted &&
      (missing === null ? /PC target outside device/.test(e.message) :
        e.classification === 'FLASH_HOLE' && e.addressByte === 2 * cpu.pc + missing));
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
});
