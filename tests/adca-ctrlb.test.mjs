import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const ctrla = 0x0200, ctrlb = 0x0201;

test('ADCA CTRLB masks reserved bits and supports each defined resolution and sign mode', () => {
  const registry = new MMIORegistry(), adc = new ADCA();
  adc.register(registry, { mapCalibration: false, mapCtrlb: true });
  assert.deepEqual([...registry.handlers.keys()], [ctrlb]);
  const control = registry.handlers.get(ctrlb);
  assert.equal(control.read(0), 0);
  for (let raw = 0; raw <= 0xff; raw++) {
    const before = control.read(1);
    if ((raw & 6) === 2) {
      assert.throws(() => control.write(raw, 2), e => e.classification === 'ADCA_RESERVED_RESOLUTION');
      assert.equal(control.read(3), before);
    } else {
      control.write(raw, 2);
      assert.equal(control.read(3), raw & 0x1e);
    }
  }
  adc.reset();
  assert.equal(control.read(4), 0);
});

test('ADCA guards both orders of enabling free-running conversions without side effects', () => {
  const events = [], adc = new ADCA({ onAccess: event => events.push(event) });
  const registry = new MMIORegistry();
  adc.register(registry, { mapCtrla: true, mapCtrlb: true });
  const a = registry.handlers.get(ctrla), b = registry.handlers.get(ctrlb);
  for (const [first, initial, second, request] of [[a, 1, b, 0x18], [b, 0x0c, a, 0x41]]) {
    adc.reset();
    first.write(initial, 1);
    const before = adc.snapshot();
    assert.throws(() => second.write(request, 2), e => e.classification === 'ADCA_FREE_RUNNING_UNSUPPORTED' && e.attemptedValue === request);
    assert.deepEqual(adc.snapshot(), before);
    assert.deepEqual([events.at(-1).before, events.at(-1).after, events.at(-1).completed], [before, before, false]);
    first.write(0, 3);
    second.write(request, 4);
    assert.equal(second.read(5), request);
  }
});

test('CPU STS records the zero CTRLB configuration at the bus write edge with ADCA enabled', () => {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0x10, 0x92, 0x01, 0x02]); // STS 0x0201,R1
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: event => events.push(event) });
  adc.register(cpu.bus.mmio, { mapCtrlb: true, mapCtrla: true, context: () => ({ pcWord: cpu.pc }) });
  cpu.bus.write(0x020c, 0x5a);
  cpu.bus.write(0x020d, 3);
  cpu.bus.write(ctrla, 1);
  cpu.bus.write(ctrlb, 0x16);
  const trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: ctrlb, value: 0 });
  assert.deepEqual([event.pcWord, event.cycle, event.register, event.completed], [0, 2, 'CTRLB', true]);
  assert.deepEqual(event.before, { cal: 0x035a, temp: 0x5a, ctrla: 1, ctrlb: 0x16 });
  assert.deepEqual(event.after, { ...event.before, ctrlb: 0 });
});
