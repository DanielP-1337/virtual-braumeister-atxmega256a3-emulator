import assert from 'node:assert/strict';
import test from 'node:test';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { USARTF0Control } from '../src/peripherals/usart.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

// Non-U A3 device map and XMEGA A manual section 21.15.4. Keep oracle values independent.
const address = 0x0ba0 + 4;
const off = { ctrlb: 0, receiverEnabled: false, transmitterEnabled: false };

function bench(words = [0]) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  present.fill(1, 0, 2 * words.length);
  words.forEach((w, i) => { flash[2 * i] = w & 255; flash[2 * i + 1] = w >>> 8; });
  const cpu = new XmegaCPU({ flash, present });
  const events = [];
  const control = new USARTF0Control({ onAccess: e => events.push(e) });
  control.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  return { control, cpu, events };
}

test('USARTF0 CTRLB resets to zero and clears previously enabled directions and control bits', () => {
  const { control, cpu, events } = bench();
  assert.deepEqual(control.snapshot(), off);
  assert.equal(cpu.bus.read(address), 0);
  cpu.bus.write(address, 0x1f);
  const count = events.length;
  control.reset();
  assert.equal(events.length, count);
  assert.deepEqual(control.snapshot(), off);
  assert.equal(cpu.bus.read(address), 0);
});

test('USARTF0 CTRLB selects RXEN and TXEN independently through every idle enable and disable transition', () => {
  const { cpu, control } = bench();
  const states = [[0, false, false], [16, true, false], [8, false, true], [24, true, true]];
  for (const [prior] of states) for (const [bits, rx, tx] of states) {
    cpu.bus.write(address, prior + 5);
    cpu.bus.write(address, (cpu.bus.read(address) & 7) | bits);
    assert.equal(cpu.bus.read(address), bits + 5);
    assert.deepEqual(control.snapshot(), { ctrlb: bits + 5, receiverEnabled: rx, transmitterEnabled: tx });
  }
});

test('USARTF0 CTRLB preserves the five writable fields and reads reserved bits as zero for all byte values', () => {
  const { cpu, events } = bench();
  for (let value = 0; value < 256; value++) {
    cpu.bus.write(address, value);
    const write = events.at(-1);
    assert.equal(write.value, value); // Raw data on the bus includes reserved bits.
    const expected = value % 32;
    assert.equal(cpu.bus.read(address), expected);
    assert.deepEqual(write.after, { ctrlb: expected, receiverEnabled: (expected >>> 4) === 1,
      transmitterEnabled: (Math.floor(expected / 8) % 2) === 1 });
    assert.deepEqual(events.at(-1).before, events.at(-1).after);
  }
});

test('USARTF0 CTRLB leaves DATA, STATUS, other controls, and other USART instances unmapped even when enabled', () => {
  const { cpu, control, events } = bench();
  cpu.bus.write(address, 0x18);
  for (const byte of [0x0b9f, 0x0ba0, 0x0ba1, 0x0ba2, 0x0ba3, 0x0ba5, 0x0ba6, 0x0ba7, 0x09a4, 0x0bb4]) {
    for (const kind of ['read', 'write']) {
      assert.throws(() => kind === 'read' ? cpu.bus.read(byte) : cpu.bus.write(byte, 0x6a),
        error => error.classification === 'UNHANDLED_MMIO' && error.addressByte === byte && error.accessKind === kind);
    }
  }
  assert.equal(control.snapshot().ctrlb, 24);
  assert.equal(events.length, 1);
});

test('USARTF0 CTRLB registration is atomic and a register collision preserves the existing handler', () => {
  const registry = new MMIORegistry(), other = new MMIORegistry(), control = new USARTF0Control();
  const existing = { read: () => 0x75 };
  registry.map(address, existing);
  assert.throws(() => control.register(registry), /Duplicate/);
  assert.deepEqual([...registry.handlers], [[address, existing]]);
  control.register(other);
  assert.deepEqual([...other.handlers.keys()], [address]);
  assert.throws(() => control.register(new MMIORegistry()), /already registered/);
});

test('USARTF0 CTRLB synthetic STD LDD STS LDS use the MMIO completion edge and preserve SREG, SP, and Z', () => {
  // LDI, STD Z+4, LDD Z+4, LDI, STS, LDS. Addresses in the direct instructions are data bytes.
  const { cpu, events } = bench([0xe158, 0x8354, 0x8124, 0xe068, 0x9360, address, 0x9140, address, 0]);
  cpu.setPair(30, 0x0ba0);
  cpu.sreg = 0xa5;
  const steps = Array.from({ length: 6 }, () => cpu.step());
  assert.deepEqual(steps.map(t => [t.mnemonic, t.after.pcWord, t.after.cycles]), [
    ['LDI', 1, 1], ['STD', 2, 3], ['LDD', 3, 5], ['LDI', 4, 6], ['STS', 6, 8], ['LDS', 8, 9],
  ]);
  assert.deepEqual([cpu.r[18], cpu.r[20], cpu.sreg, cpu.sp, cpu.pair(30)], [0x18, 8, 0xa5, 0x5fff, 0x0ba0]);
  assert.deepEqual(events.map(e => [e.kind, e.value, e.cycle, e.pcWord, e.instructionAttempt, e.before.ctrlb, e.after.ctrlb]), [
    ['write', 24, 3, 1, 2, 0, 24], ['read', 24, 5, 2, 3, 24, 24],
    ['write', 8, 8, 4, 5, 24, 8], ['read', 8, 9, 6, 6, 8, 8],
  ]);
  assert.ok(events.every(e => e.origin === 'peripheral-model' && e.completed && e.addressByte === address));
  assert.deepEqual(steps.flatMap(t => t.accesses.filter(a => a.space === 'mmio').map(a => [a.kind, a.value])), events.map(e => [e.kind, e.value]));
});

test('USARTF0 CTRLB reset and replay produce identical register states and ordered events', () => {
  const { cpu, control, events } = bench();
  function run() {
    control.reset();
    events.length = 0;
    for (const [i, value] of [0, 0x10, 0x18, 8, 0, 0xff].entries()) {
      cpu.bus.write(address, value, 2 * i);
      cpu.bus.read(address, 2 * i + 1);
    }
    return { events: [...events], state: control.snapshot() };
  }
  assert.deepEqual(run(), run());
});
