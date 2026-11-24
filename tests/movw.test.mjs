import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionFault, XmegaCPU } from '../src/xmega.mjs';
import { decodeAt } from '../src/discovery.mjs';

const lowRegisters = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];

function machine() {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
  cpu.sp = 0x472a;
  cpu.eind = 1;
  cpu.rampz = 2;
  return cpu;
}

function loadWord(cpu, pcWord, opcode) {
  const address = pcWord * 2;
  cpu.flash.set([opcode % 256, Math.floor(opcode / 256)], address);
  cpu.present.fill(1, address, address + 2);
}

test('all MOVW encodings preserve every SREG value and retire in one AVRxm cycle', () => {
  const cpu = machine();
  // DS40002198C section 6.76 orders the pair selectors in a 16 by 16 table.
  // Generate machine words in table order. Expected data comes from named byte
  // indices in an independent list, without the CPU decoder or pair helpers.
  for (let slot = 0; slot < 256; slot++) loadWord(cpu, slot, 0x0100 + slot);
  for (let flags = 0; flags < 256; flags++) {
    const initial = Uint8Array.from({ length: 32 }, (_, r) => (r * 29 + flags) % 256);
    cpu.sreg = flags;
    cpu.pc = 0;
    for (const destination of lowRegisters) {
      for (const source of lowRegisters) {
        cpu.r.set(initial);
        const before = cpu.state();
        const registers = Array.from(initial);
        registers[destination] = initial[source];
        registers[destination + 1] = initial[source + 1];
        const trace = cpu.step();
        assert.deepEqual(trace.after, { ...before, pcWord: before.pcWord + 1, cycles: before.cycles + 1, registers });
        assert.equal(trace.mnemonic, 'MOVW');
        assert.equal(trace.opcode, 0x0100 + before.pcWord);
        assert.equal(trace.step, flags * 256 + before.pcWord + 1);
        assert.deepEqual(trace.accesses, [
          { kind: 'fetch', space: 'flash', addressByte: 2 * before.pcWord, value: before.pcWord, loaded: true },
          { kind: 'fetch', space: 'flash', addressByte: 2 * before.pcWord + 1, value: 1, loaded: true },
        ]);
      }
    }
  }
  assert.equal(cpu.steps, 65536);
  assert.equal(cpu.cycles, 65536);
});

test('literal MOVW words copy both bytes in order across low registers and X, Y, Z', () => {
  // Literal assembler encodings also pin the orientation of the selector table.
  const words = [0x0180, 0x01d8, 0x01ed, 0x01fe, 0x01ff, 0x010f];
  const destinations = [16, 26, 28, 30, 30, 0];
  function run(low, high) {
    const cpu = machine();
    cpu.pc = 0xfffd;
    cpu.sreg = 0xa5;
    cpu.r.fill(0x47);
    cpu.r[0] = low;
    cpu.r[1] = high;
    words.forEach((word, index) => loadWord(cpu, cpu.pc + index, word));
    const traces = [];
    for (const destination of destinations) {
      const trace = cpu.step();
      assert.deepEqual(Array.from(cpu.r.slice(destination, destination + 2)), [low, high]);
      assert.equal(cpu.sreg, 0xa5);
      traces.push(trace);
    }
    assert.equal(cpu.pc, 0x10003);
    assert.equal(cpu.cycles, words.length);
    return traces;
  }
  for (const [low, high] of [[0, 0], [255, 255], [0, 255], [255, 0], [128, 1], [0x3a, 0xc5]]) {
    assert.deepEqual(run(low, high), run(low, high));
  }
});

test('a missing MOVW byte or an invalid fall-through leaves the destination and counters intact', () => {
  for (const missing of [0, 1]) {
    const cpu = machine();
    loadWord(cpu, 0, 0x01f0);
    cpu.r[0] = 0x77;
    cpu.present[missing] = 0;
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e instanceof ExecutionFault &&
      e.classification === 'FLASH_HOLE' && e.addressByte === missing && !e.trace.instructionCompleted);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  const cpu = machine();
  cpu.pc = cpu.flash.length / 2 - 1;
  cpu.r.set([0x43, 0x21]);
  loadWord(cpu, cpu.pc, 0x01f0);
  const before = cpu.state();
  assert.throws(() => cpu.step(), /PC target outside device/);
  assert.deepEqual(cpu.state(), before);
  assert.equal(cpu.steps, 0);
});

test('neighboring opcode families still trap and each failure cites its own opcode', () => {
  for (const opcode of [0x00ff, 0x0200, 0xffff]) {
    const cpu = machine();
    loadWord(cpu, 0, opcode);
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e instanceof ExecutionFault &&
      e.opcode === opcode && e.trace.opcode === opcode && /Unsupported instruction/.test(e.message));
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
});

test('SUBI stop diagnostics name the immediate and register without touching CPU state', () => {
  const cpu = machine();
  const before = cpu.state();
  for (const [word, register, immediate] of [[0x50e0, 30, 0], [0x5a3b, 19, 0xab], [0x5fff, 31, 255]]) {
    loadWord(cpu, 0, word);
    const decoded = decodeAt(cpu);
    assert.equal(decoded.mnemonic, 'SUBI');
    assert.deepEqual(decoded.operands, { register, immediate });
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
});
