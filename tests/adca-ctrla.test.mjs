import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const ctrl = 0x0200, low = 0x020c, high = 0x020d;

test('ADCA CTRLA retains ENABLE and each DMA request selection independently of calibration', () => {
  const registry = new MMIORegistry(), adc = new ADCA();
  adc.register(registry, { mapCtrla: true });
  const handler = registry.handlers.get(ctrl);
  assert.equal(handler.read(0), 0);
  registry.handlers.get(low).write(0x81, 0);
  registry.handlers.get(high).write(6, 0);
  for (const dma of [0, 0x40, 0x80, 0xc0]) {
    for (const enable of [1, 0]) {
      handler.write(dma | enable, 1);
      assert.equal(handler.read(2), dma | enable);
      assert.deepEqual(adc.snapshot(), { cal: 0x681, temp: 0x81, ctrla: dma | enable });
    }
  }
  adc.reset();
  assert.deepEqual(adc.snapshot(), { cal: 0, temp: 0, ctrla: 0 });
});

test('ADCA CTRLA maps independently and a colliding registration leaves every handler intact', () => {
  const registry = new MMIORegistry(), adc = new ADCA();
  const existing = { read: () => 0x08 };
  registry.map(ctrl, existing);
  assert.throws(() => adc.register(registry, { mapCtrla: true }), /registration collision/);
  assert.deepEqual([...registry.handlers], [[ctrl, existing]]);
  const controlOnly = new MMIORegistry();
  adc.register(controlOnly, { mapCalibration: false, mapCtrla: true });
  assert.deepEqual([...controlOnly.handlers.keys()], [ctrl]);
  assert.throws(() => adc.register(new MMIORegistry()), /registration collision/);
});

function storeFixture() {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0x30, 0x93, 0x00, 0x02]); // STS ADCA.CTRLA,R19
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: e => events.push(e) });
  adc.register(cpu.bus.mmio, { mapCtrla: true, context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (message, details) => cpu.fault(message, details) });
  return { cpu, adc, events };
}

test('ADCA CTRLA STS enables the converter at the write edge and preserves a pending calibration byte', () => {
  const { cpu, adc, events } = storeFixture();
  cpu.bus.write(low, 0x85);
  cpu.r[19] = 1;
  const trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: ctrl, value: 1 });
  assert.deepEqual([event.register, event.cycle, event.pcWord, event.instructionAttempt, event.completed], ['CTRLA', 2, 0, 1, true]);
  assert.deepEqual(event.before, { cal: 0, temp: 0x85, ctrla: 0 });
  assert.deepEqual(event.after, { cal: 0, temp: 0x85, ctrla: 1 });
  assert.deepEqual(adc.snapshot(), event.after);
});

test('ADCA CTRLA start and flush requests fault before changing configuration or retiring the store', () => {
  const { cpu, adc, events } = storeFixture();
  cpu.bus.write(low, 0xd7); cpu.bus.write(high, 8);
  cpu.bus.write(ctrl, 0x41);
  const initial = adc.snapshot();
  for (let action = 2; action <= 0x3e; action += 2) {
    cpu.r[19] = 0xc0 | action;
    const before = cpu.state();
    const classification = action & 0x3c ? 'ADCA_CONVERSION_START_UNSUPPORTED' : 'ADCA_PIPELINE_FLUSH_UNSUPPORTED';
    assert.throws(() => cpu.step(), e => e.classification === classification && e.addressByte === ctrl && e.attemptedValue === cpu.r[19]);
    assert.deepEqual(cpu.state(), before);
    assert.deepEqual(adc.snapshot(), initial);
    const e = events.at(-1);
    assert.deepEqual([e.classification, e.completed, e.before, e.after], [classification, false, initial, initial]);
  }
});
