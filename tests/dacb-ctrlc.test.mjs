import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { DACBControl } from '../src/peripherals/dacb.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

const address = 0x0322;

test('DACB CTRLC resets to zero and reads back all reference and alignment selections independently of CTRLB', () => {
  const registry = new MMIORegistry();
  const control = new DACBControl();
  control.register(registry);
  const ctrlc = registry.handlers.get(address);
  registry.handlers.get(0x0321).write(0x42, 0);
  assert.equal(ctrlc.read(1), 0);
  for (const reference of [0, 0x08, 0x10, 0x18]) {
    for (const leftAdjust of [0, 1]) {
      const value = reference | leftAdjust;
      ctrlc.write(value | 0xe6, 2);
      assert.equal(ctrlc.read(3), value);
      assert.equal(control.snapshot().ctrlb, 0x42);
    }
  }
  control.reset();
  assert.equal(ctrlc.read(4), 0);
});

test('DACB CTRLC can be omitted and a collision leaves the registry intact', () => {
  const registry = new MMIORegistry();
  const existing = { read: () => 0x81 };
  registry.map(address, existing);
  const control = new DACBControl();
  assert.throws(() => control.register(registry), /registration collision/);
  assert.deepEqual([...registry.handlers], [[address, existing]]);
  const withoutCtrlc = new MMIORegistry();
  control.register(withoutCtrlc, { mapCtrlc: false });
  assert.ok(withoutCtrlc.handlers.has(0x0321));
  assert.equal(withoutCtrlc.handlers.has(address), false);
  assert.throws(() => control.register(registry), /registration collision/);
});

test('DACB CTRLC read-modify-write selects AVCC with right-aligned data at the STD completion edge', () => {
  // LDD R19,Z+2; ANDI R19,0xE6; ORI R19,0x08; STD Z+2,R19.
  const program = [0x32, 0x81, 0x36, 0x7e, 0x38, 0x60, 0x32, 0x83];
  const flash = new Uint8Array(0x42000);
  const present = new Uint8Array(flash.length);
  flash.set(program);
  present.fill(1, 0, program.length);
  const cpu = new XmegaCPU({ flash, present });
  const events = [];
  const control = new DACBControl({ onAccess: event => events.push(event) });
  control.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  cpu.setPair(30, 0x0320);
  cpu.bus.write(address, 0x19);
  events.length = 0;
  const steps = Array.from({ length: 4 }, () => cpu.step());
  assert.deepEqual(steps.map(step => [step.mnemonic, step.after.cycles]),
    [['LDD', 2], ['ANDI', 3], ['ORI', 4], ['STD', 6]]);
  assert.deepEqual(events.map(event => [event.register, event.kind, event.value, event.cycle, event.pcWord, event.instructionAttempt]),
    [['CTRLC', 'read', 0x19, 2, 0, 1], ['CTRLC', 'write', 8, 6, 3, 4]]);
  assert.equal(control.snapshot().ctrlc, 8);
});
