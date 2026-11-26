import assert from 'node:assert/strict';
import test from 'node:test';
import { DACBControl } from '../src/peripherals/dacb.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const address = 0x0320;

test('DACB CTRLA resets disabled and stores the five control bits defined by the A3 device', () => {
  const registry = new MMIORegistry();
  const control = new DACBControl();
  control.register(registry);
  const ctrla = registry.handlers.get(address);
  assert.equal(ctrla.read(0), 0);
  registry.handlers.get(0x0321).write(0x42, 1);
  registry.handlers.get(0x0322).write(0x18, 1);
  for (let bits = 0; bits < 32; bits++) {
    ctrla.write(0xe0 | bits, 2);
    assert.equal(ctrla.read(3), bits);
    assert.deepEqual(control.snapshot(), { ctrla: bits, ctrlb: 0x42, ctrlc: 0x18 });
  }
  control.reset();
  assert.deepEqual(control.snapshot(), { ctrla: 0, ctrlb: 0, ctrlc: 0 });
});

test('DACB CTRLA mapping is optional and an address collision is atomic', () => {
  const registry = new MMIORegistry();
  const existing = { read: () => 0xab };
  registry.map(address, existing);
  const control = new DACBControl();
  assert.throws(() => control.register(registry), /registration collision/);
  assert.deepEqual([...registry.handlers], [[address, existing]]);
  control.register(registry, { mapCtrla: false });
  assert.equal(registry.handlers.get(address), existing);
  assert.ok(registry.handlers.has(0x0321) && registry.handlers.has(0x0322));
});

test('indirect DACB CTRLA read-modify-write enables channel zero at the store edge', () => {
  // LD R19,Z / ANDI R19,0xF2 / ORI R19,0x05 / ST Z,R19
  const program = [0x30, 0x81, 0x32, 0x7f, 0x35, 0x60, 0x30, 0x83];
  const flash = new Uint8Array(0x42000);
  const present = new Uint8Array(flash.length);
  flash.set(program);
  present.fill(1, 0, program.length);
  const cpu = new XmegaCPU({ flash, present });
  const events = [];
  const control = new DACBControl({ onAccess: event => events.push(event) });
  control.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc }) });
  cpu.setPair(30, address);
  const trace = Array.from({ length: 4 }, () => cpu.step());
  assert.deepEqual(trace.map(step => [step.mnemonic, step.after.cycles]),
    [['LD', 1], ['ANDI', 2], ['ORI', 3], ['ST', 4]]);
  assert.deepEqual(events.map(event => [event.kind, event.value, event.cycle, event.pcWord]),
    [['read', 0, 1, 0], ['write', 5, 4, 3]]);
  assert.equal(control.snapshot().ctrla, 5);
  assert.equal(cpu.pair(30), address);
});
