import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { DACBControl } from '../src/peripherals/dacb.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

const address = 0x0321;

test('DACB CTRLB resets to zero and reads back both channel modes and all trigger bits', () => {
  const registry = new MMIORegistry();
  const control = new DACBControl();
  control.register(registry);
  const ctr = registry.handlers.get(address);
  assert.equal(ctr.read(0), 0);
  for (const channel of [0, 0x40]) {
    for (const triggers of [0, 1, 2, 3]) {
      const value = channel | triggers;
      ctr.write(value | 0x9c, 1);
      assert.equal(ctr.read(2), value);
      assert.equal(control.snapshot().ctrlb, value);
    }
  }
  control.reset();
  assert.equal(ctr.read(3), 0);
});

test('DACB CTRLB rejects either reserved channel encoding without changing register state', () => {
  const registry = new MMIORegistry();
  const events = [];
  const control = new DACBControl({ onAccess: event => events.push(event) });
  control.register(registry);
  const ctr = registry.handlers.get(address);
  ctr.write(0x41, 1);
  for (const value of [0x22, 0x63]) {
    assert.throws(() => ctr.write(value, 2), error => error.classification === 'DACB_RESERVED_CHSEL' &&
      error.addressByte === address && error.accessKind === 'write' && error.attemptedValue === value);
    const event = events.at(-1);
    assert.equal(event.completed, false);
    assert.deepEqual(event.before, event.after);
    assert.equal(ctr.read(3), 0x41);
  }
});

test('DACB CTRLB read-modify-write preserves trigger bits and reports instruction completion cycles', () => {
  // LDD R20,Z+1; ANDI R20,0x9F; STD Z+1,R20.
  const program = [0x41, 0x81, 0x4f, 0x79, 0x41, 0x83];
  const flash = new Uint8Array(0x42000);
  const present = new Uint8Array(flash.length);
  flash.set(program);
  present.fill(1, 0, program.length);
  const cpu = new XmegaCPU({ flash, present });
  const events = [];
  const control = new DACBControl({ onAccess: event => events.push(event) });
  control.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  cpu.setPair(30, 0x0320);
  cpu.bus.write(address, 0x43);
  events.length = 0;
  const steps = [cpu.step(), cpu.step(), cpu.step()];
  assert.deepEqual(steps.map(step => [step.mnemonic, step.after.cycles]), [['LDD', 2], ['ANDI', 3], ['STD', 5]]);
  assert.deepEqual(events.map(event => [event.kind, event.value, event.cycle, event.pcWord, event.instructionAttempt]),
    [['read', 0x43, 2, 0, 1], ['write', 3, 5, 2, 3]]);
  assert.deepEqual(steps.flatMap(step => step.accesses.filter(access => access.space === 'mmio')),
    events.map(event => ({ kind: event.kind, space: 'mmio', addressByte: address, value: event.value })));
  assert.equal(control.snapshot().ctrlb, 3);
  assert.equal(cpu.pair(30), 0x0320);
});
