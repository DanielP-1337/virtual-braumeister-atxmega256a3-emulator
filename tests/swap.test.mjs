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

function swapWord(rd) {
  return Number.parseInt('1001010' + rd.toString(2).padStart(5, '0') + '0010', 2);
}

// Build the expected byte from its base-16 digits, independently of the interpreter's shifts.
function swapDigits(byte) {
  return (byte % 16) * 16 + Math.floor(byte / 16);
}

test('SWAP executes every register and byte in one word and one AVRxm clock, changing only Rd', () => {
  const cpu = machine();
  cpu.sp = 0x4ef7; cpu.rampz = 2; cpu.eind = 1;
  assert.deepEqual([0, 15, 16, 22, 31].map(swapWord), [0x9402, 0x94f2, 0x9502, 0x9562, 0x95f2]);
  const words = new Set();
  for (let rd = 0; rd < 32; rd++) {
    const word = swapWord(rd);
    put(cpu, 0, word); words.add(word);
    const decoded = decodeAt(cpu, 0);
    assert.deepEqual([decoded.mnemonic, decoded.operands], ['SWAP', { register: rd }]);
    for (let byte = 0; byte <= 255; byte++) {
      cpu.pc = 0;
      for (let i = 0; i < 32; i++) cpu.r[i] = (71 * i + rd + byte) & 255;
      cpu.r[rd] = byte; cpu.sreg = (byte + rd * 37) & 255;
      const before = cpu.state(), registers = [...before.registers], step = cpu.steps + 1;
      registers[rd] = swapDigits(byte);
      const t = cpu.step();
      assert.deepEqual([t.mnemonic, t.opcode, t.step], ['SWAP', word, step]);
      assert.deepEqual(t.after, { ...before, registers, pcWord: 1, cycles: before.cycles + 1 });
      assert.deepEqual(t.accesses, [
        { kind: 'fetch', space: 'flash', addressByte: 0, value: word & 255, loaded: true },
        { kind: 'fetch', space: 'flash', addressByte: 1, value: word >>> 8, loaded: true },
      ]);
    }
  }
  assert.equal(words.size, 32);
});

test('SWAP preserves every possible SREG value for each of the 32 registers and all 256 input bytes', () => {
  const cpu = machine();
  for (let rd = 0; rd < 32; rd++) {
    put(cpu, 0, swapWord(rd));
    for (let byte = 0; byte <= 255; byte++) {
      const expected = swapDigits(byte);
      for (let sreg = 0; sreg <= 255; sreg++) {
        cpu.pc = 0; cpu.r[rd] = byte; cpu.sreg = sreg;
        cpu.step();
        assert.equal(cpu.r[rd], expected);
        assert.equal(cpu.sreg, sreg);
      }
    }
  }
  assert.equal(cpu.steps, 32 * 256 * 256);
  assert.equal(cpu.cycles, cpu.steps);
});

test('SWAP twice restores original bytes and preserves branch decisions on deterministic replay', () => {
  function replay(sreg) {
    const cpu = machine();
    for (const [pc, word] of [swapWord(22), swapWord(23), swapWord(22), swapWord(23), 0xf009].entries()) put(cpu, pc, word);
    cpu.r[22] = 0x02; cpu.r[23] = 0xc7; cpu.sreg = sreg;
    const events = Array.from({ length: 5 }, () => cpu.step());
    assert.deepEqual(events.slice(0, 4).map(t => t.after.registers.slice(22, 24)),
      [[0x20, 0xc7], [0x20, 0x7c], [0x02, 0x7c], [0x02, 0xc7]]);
    const taken = (sreg >>> 1) & 1; // BRBS Z,+1
    assert.deepEqual([cpu.pc, cpu.cycles, cpu.sreg], [5 + taken, 5 + taken, sreg]);
    return events;
  }
  for (const flags of [0, 2, 0x81, 0xff]) assert.deepEqual(replay(flags), replay(flags));
});

test('SWAP validates sparse instruction fetches and fall-through atomically and crosses a 64K word boundary', () => {
  const cpu = machine(), word = swapWord(28);
  cpu.r[28] = 0xa5; cpu.sreg = 0xdd;
  for (const [pc, missing] of [[0, 0], [1, 1], [cpu.flash.length / 2 - 1, null]]) {
    put(cpu, pc, word); cpu.pc = pc;
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual(cpu.state(), before); assert.equal(cpu.steps, 0);
  }
  put(cpu, 0xffff, word); cpu.pc = 0xffff;
  const t = cpu.step();
  assert.deepEqual([t.after.pcWord, t.after.cycles, t.after.registers[28], t.after.sreg], [0x10000, 1, 0x5a, 0xdd]);
  assert.deepEqual(t.accesses.map(a => a.addressByte), [0x1fffe, 0x1ffff]);
});
