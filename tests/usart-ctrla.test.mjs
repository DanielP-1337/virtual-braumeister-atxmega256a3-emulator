import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { USARTF0Control } from '../src/peripherals/usart.mjs';
import { USARTF0FrameControl } from '../src/peripherals/usart-frame.mjs';
import { USARTF0InterruptControl } from '../src/peripherals/usart-interrupts.mjs';

// Non-U A3 device pack and XMEGA A 8077I, sections 12 and 21.15.3.
const address = 0x0ba0 + 3;
const off = { ctrla: 0, rxcLevel: 0, txcLevel: 0, dreLevel: 0 };
const levels = [0, 1, 2, 3]; // Disabled, low, medium, high.

function fixture(words = [], trace = true) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((opcode, i) => {
    flash[2 * i] = opcode & 255;
    flash[2 * i + 1] = opcode >>> 8;
  });
  present.fill(1, 0, 2 * words.length);
  const cpu = new XmegaCPU({ flash, present });
  const events = [];
  const control = new USARTF0InterruptControl({ onAccess: trace ? event => events.push(event) : null });
  control.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  return { bus: cpu.bus, cpu, control, events };
}

test('USARTF0 CTRLA resets to zero with all three sources off and reset generates no bus access', () => {
  const { bus, control, events } = fixture();
  assert.deepEqual(control.snapshot(), off);
  assert.equal(bus.read(address), 0);
  bus.write(address, 0x3f);
  assert.deepEqual(control.snapshot(), { ctrla: 63, rxcLevel: 3, txcLevel: 3, dreLevel: 3 });
  control.reset();
  assert.equal(events.length, 2);
  assert.equal(bus.read(address), 0);
  assert.deepEqual(events.at(-1).before, off);
  assert.deepEqual(events.at(-1).after, off);
});

test('USARTF0 CTRLA reads back all 64 level combinations with every reserved-bit pattern', () => {
  const { bus, control, events } = fixture();
  const seen = new Set();
  for (const rxcLevel of levels) for (const txcLevel of levels) for (const dreLevel of levels) {
    const ctrla = 16 * rxcLevel + 4 * txcLevel + dreLevel;
    const expected = { ctrla, rxcLevel, txcLevel, dreLevel };
    for (const reserved of [0, 64, 128, 192]) {
      const byte = ctrla + reserved;
      bus.write(address, byte);
      assert.equal(events.at(-1).value, byte);
      assert.deepEqual(events.at(-1).after, expected);
      assert.equal(bus.read(address), ctrla);
      assert.deepEqual(events.at(-1).before, expected);
      assert.deepEqual(control.snapshot(), expected);
      seen.add(byte);
    }
  }
  assert.equal(seen.size, 256);
});

test('USARTF0 CTRLA can change or disable each source independently from every previous combination', () => {
  const { bus, control } = fixture([], false);
  const fields = [
    { key: 'rxcLevel', values: [0, 0x10, 0x20, 0x30], keep: 0x0f },
    { key: 'txcLevel', values: [0, 0x04, 0x08, 0x0c], keep: 0x33 },
    { key: 'dreLevel', values: [0, 0x01, 0x02, 0x03], keep: 0x3c },
  ];
  for (const rxcLevel of levels) for (const txcLevel of levels) for (const dreLevel of levels) {
    const prior = { rxcLevel, txcLevel, dreLevel };
    const start = 16 * rxcLevel + 4 * txcLevel + dreLevel;
    for (const field of fields) for (const next of levels) {
      bus.write(address, start);
      const byte = (bus.read(address) & field.keep) | field.values[next];
      bus.write(address, byte);
      assert.deepEqual(control.snapshot(), { ctrla: byte, ...prior, [field.key]: next });
    }
  }
});

test('USARTF0 CTRLA is isolated from receiver enables, frame configuration, other USARTs and unmodeled status flags', () => {
  const { bus, control } = fixture();
  const enables = new USARTF0Control(), frame = new USARTF0FrameControl();
  enables.register(bus.mmio);
  frame.register(bus.mmio);
  bus.write(address + 1, 0x18);
  bus.write(address + 2, 0x0b);
  bus.write(address, 0x20);
  assert.deepEqual(control.snapshot(), { ctrla: 32, rxcLevel: 2, txcLevel: 0, dreLevel: 0 });
  assert.equal(bus.read(address + 1), 0x18);
  assert.equal(bus.read(address + 2), 0x0b);
  enables.reset();
  frame.reset();
  assert.equal(bus.read(address), 0x20);
  for (const unknown of [0x0ba0, 0x0ba1, 0x0ba2, 0x0ba6, 0x0ba7, 0x09a3]) {
    for (const kind of ['read', 'write']) {
      assert.throws(() => kind === 'read' ? bus.read(unknown) : bus.write(unknown, 0),
        e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === unknown && e.accessKind === kind);
    }
  }
});

test('USARTF0 CTRLA registers exactly one byte and leaves a colliding handler in place', () => {
  const registry = new MMIORegistry(), fresh = new MMIORegistry(), control = new USARTF0InterruptControl();
  const existing = { read: () => 0x81 };
  registry.map(address, existing);
  assert.throws(() => control.register(registry), /Duplicate/);
  assert.deepEqual([...registry.handlers], [[address, existing]]);
  control.register(fresh);
  assert.deepEqual([...fresh.handlers.keys()], [address]);
  assert.throws(() => control.register(new MMIORegistry()), /already registered/);
});

test('USARTF0 CTRLA synthetic AVR read-modify-write preserves TXC and DRE and uses the MMIO completion edges', () => {
  // LDI R20,0x1B; STD Z+3,R20; LDD R21,Z+3; ANDI R21,0xCF; ORI R21,0x30;
  // STS address,R21; LDS R22,address. Opcodes and cycle oracle are independent of discovery.
  const { cpu, control, events } = fixture([0xe14b, 0x8343, 0x8153, 0x7c5f, 0x6350, 0x9350, address, 0x9160, address]);
  cpu.setPair(30, 0x0ba0);
  cpu.sreg = 0xf5;
  const steps = Array.from({ length: 7 }, () => cpu.step());
  assert.deepEqual(steps.map(t => [t.mnemonic,t.after.pcWord,t.after.cycles,t.after.sreg]), [
    ['LDI',1,1,0xf5], ['STD',2,3,0xf5], ['LDD',3,5,0xf5], ['ANDI',4,6,0xe1],
    ['ORI',5,7,0xe1], ['STS',7,9,0xe1], ['LDS',9,10,0xe1],
  ]);
  assert.deepEqual([cpu.r[20],cpu.r[21],cpu.r[22],cpu.pair(30),cpu.sp], [0x1b,0x3b,0x3b,0x0ba0,0x5fff]);
  assert.deepEqual(events.map(e => [e.kind,e.value,e.before.ctrla,e.after.ctrla,e.cycle,e.pcWord,e.instructionAttempt]), [
    ['write',27,0,27,3,1,2], ['read',27,27,27,5,2,3], ['write',59,27,59,9,5,6], ['read',59,59,59,10,7,7],
  ]);
  assert.ok(events.every(e => e.origin === 'peripheral-model' && e.eventType === 'usart-access' && e.peripheral === 'USARTF0'
    && e.register === 'CTRLA' && e.addressByte === address && e.completed));
  assert.deepEqual(steps.flatMap(t => t.accesses.filter(a => a.space === 'mmio')),
    events.map(e => ({ kind: e.kind, space: 'mmio', addressByte: address, value: e.value })));
  assert.deepEqual(control.snapshot(), { ctrla: 59, rxcLevel: 3, txcLevel: 2, dreLevel: 3 });
});

test('USARTF0 CTRLA reset and replay reproduce ordered accesses and repeated reads preserve each selection', () => {
  const { bus, control, events } = fixture();
  function replay() {
    control.reset();
    events.length = 0;
    for (const [i, value] of [0x20, 0x08, 0x02, 0xf9, 0].entries()) {
      bus.write(address, value, 3*i + 1);
      const first = bus.read(address, 3*i + 2);
      assert.equal(bus.read(address, 3*i + 3), first);
    }
    return { events: [...events], final: control.snapshot() };
  }
  assert.deepEqual(replay(), replay());
});
