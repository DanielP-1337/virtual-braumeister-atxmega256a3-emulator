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

function mulWord(rd, rr) {
  const src = rr.toString(2).padStart(5, '0'), dest = rd.toString(2).padStart(5, '0');
  return Number.parseInt('100111' + src[0] + dest + src.slice(1), 2);
}

// Add the partial products one input bit at a time, independently of the CPU's multiplication.
function referenceProduct(left, right) {
  let total = 0;
  for (let bit = 0; bit < 8; bit++) if ((right >>> bit) & 1) total += left << bit;
  return total;
}

function referenceFlags(product, initial) {
  return initial - initial % 4 + 2 * Number(product === 0) + Number(product >= 32768);
}

test('MUL executes all 1,024 register pairs in one word and two AVRxm clocks and writes only R1:R0 and Z/C', () => {
  const cpu = machine(), encodings = new Set();
  cpu.sp = 0x4f87; cpu.rampz = 2; cpu.eind = 1;
  assert.deepEqual([[0, 0], [0, 1], [1, 0], [28, 24], [31, 31]].map(([d, r]) => mulWord(d, r)),
    [0x9c00, 0x9c01, 0x9c10, 0x9fc8, 0x9fff]);
  for (let rd = 0; rd < 32; rd++) for (let rr = 0; rr < 32; rr++) {
    const word = mulWord(rd, rr);
    put(cpu, 0, word); encodings.add(word);
    const decoded = decodeAt(cpu, 0);
    assert.deepEqual([decoded.mnemonic, decoded.operands], ['MUL', { leftRegister: rd, rightRegister: rr }]);
    for (const [left, right] of [[0, 0xff], [1, 1], [0x10, 0x10], [0x97, 0xd9], [0xff, 0x81], [0xff, 0xff]]) {
      cpu.pc = 0;
      for (let i = 0; i < 32; i++) cpu.r[i] = (73 * i + rd + 11 * rr) & 255;
      cpu.r[rd] = left;
      if (rd !== rr) cpu.r[rr] = right;
      cpu.sreg = (rd * 19 + rr + left + right) & 255;
      const before = cpu.state(), registers = [...before.registers], step = cpu.steps + 1;
      const product = referenceProduct(left, rd === rr ? left : right);
      registers[0] = product % 256; registers[1] = Math.floor(product / 256);
      const t = cpu.step();
      assert.deepEqual([t.step, t.mnemonic, t.opcode], [step, 'MUL', word]);
      assert.deepEqual(t.after, { ...before, registers, pcWord: 1, cycles: before.cycles + 2, sreg: referenceFlags(product, before.sreg) });
      assert.deepEqual(t.accesses, [
        { space: 'flash', kind: 'fetch', addressByte: 0, value: word & 255, loaded: true },
        { space: 'flash', kind: 'fetch', addressByte: 1, value: word >>> 8, loaded: true },
      ]);
    }
  }
  assert.equal(encodings.size, 1024);
});

test('MUL returns the full unsigned product for every byte pair and all four incoming Z/C combinations', () => {
  const cpu = machine(); put(cpu, 0, mulWord(7, 29));
  for (let left = 0; left < 256; left++) for (let right = 0; right < 256; right++) {
    const product = referenceProduct(left, right);
    for (let zc = 0; zc < 4; zc++) {
      const flags = ((left + 3 * right) & 0xfc) | zc;
      cpu.pc = 0; cpu.r[7] = left; cpu.r[29] = right; cpu.sreg = flags;
      cpu.step();
      assert.equal(cpu.r[0], product % 256);
      assert.equal(cpu.r[1], Math.floor(product / 256));
      assert.equal(cpu.sreg, referenceFlags(product, flags));
    }
  }
  assert.equal(cpu.cycles, 2 * 65536 * 4);
});

test('MUL samples both operands before writing R0 or R1, including overlapping sources and squares', () => {
  const cpu = machine();
  for (const [rd, rr] of [[0, 1], [1, 0], [0, 31], [31, 0], [1, 31], [31, 1], [0, 0], [1, 1]]) {
    put(cpu, 0, mulWord(rd, rr));
    for (let a = 0; a < 256; a++) {
      // A repeated source register has exactly one independently selectable byte.
      const first = rd === rr ? a : 0, last = rd === rr ? a : 255;
      for (let b = first; b <= last; b++) {
        const expected = referenceProduct(a, b);
        cpu.pc = 0; cpu.r[0] = 0xa6; cpu.r[1] = 0x59; cpu.r[rd] = a; cpu.r[rr] = b;
        cpu.step();
        assert.equal(cpu.r[0], expected % 256);
        assert.equal(cpu.r[1], Math.floor(expected / 256));
        if (rd > 1) assert.equal(cpu.r[rd], a);
        if (rr > 1) assert.equal(cpu.r[rr], b);
      }
    }
  }
});

test('MUL preserves I/T/H/S/V/N and sets Z from both product bytes and C from bit 15 for every initial SREG', () => {
  const cpu = machine(); put(cpu, 0, mulWord(2, 5));
  // Expected products and Z/C are literal boundary cases.
  const cases = [[0, 0xff, 0, 2], [0xe7, 0, 0, 2], [1, 1, 1, 0], [16, 16, 0x0100, 0],
    [0x80, 0x80, 0x4000, 0], [0x97, 0xd9, 0x7fff, 0], [0x81, 0xff, 0x807f, 1], [0xff, 0xff, 0xfe01, 1]];
  for (const [a, b, product, zc] of cases) for (let flags = 0; flags < 256; flags++) {
    cpu.pc = 0; cpu.r[2] = a; cpu.r[5] = b; cpu.sreg = flags;
    cpu.step();
    assert.deepEqual([cpu.r[0], cpu.r[1], cpu.sreg], [product % 256, Math.floor(product / 256), (flags & 0xfc) | zc]);
  }
});

test('MUL supplies fresh branch flags and deterministic timing on replay', () => {
  function replay() {
    const cpu = machine(), records = [];
    put(cpu, 0, mulWord(9, 10));
    for (const [a, b, zc] of [[0, 1, 2], [16, 16, 0], [255, 255, 1]]) for (const bit of [0, 1]) {
      put(cpu, 1, 0xf008 | bit); // BRBS bit,+1
      cpu.pc = 0; cpu.r[9] = a; cpu.r[10] = b; cpu.sreg = 0xfc | (3 ^ zc);
      const start = cpu.cycles, taken = (zc >>> bit) & 1;
      records.push(cpu.step(), cpu.step());
      assert.deepEqual([cpu.pc, cpu.cycles - start, cpu.sreg], [2 + taken, 3 + taken, 0xfc | zc]);
    }
    return records;
  }
  assert.deepEqual(replay(), replay());
});

test('MUL validates sparse fetches and invalid fall-through before modifying R1:R0 and crosses a 64K word boundary', () => {
  const cpu = machine(), word = mulWord(0, 1);
  cpu.r[0] = 0x97; cpu.r[1] = 0xd9; cpu.sreg = 0xff;
  for (const [pc, missing] of [[0, 0], [1, 1], [cpu.flash.length / 2 - 1, null]]) {
    put(cpu, pc, word); cpu.pc = pc;
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual(cpu.state(), before); assert.equal(cpu.steps, 0);
  }
  put(cpu, 0xffff, word); cpu.pc = 0xffff;
  const t = cpu.step();
  assert.deepEqual([t.after.pcWord, t.after.cycles, cpu.r[0], cpu.r[1], cpu.sreg], [0x10000, 2, 0xff, 0x7f, 0xfc]);
  assert.deepEqual(t.accesses.map(a => a.addressByte), [0x1fffe, 0x1ffff]);
});
