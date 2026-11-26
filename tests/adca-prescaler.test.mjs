import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const prescaler = 0x0204;

test('ADCA PRESCALER selects all eight peripheral clock divisors and masks the reserved bits', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapPrescaler: true });
  assert.deepEqual([...registry.handlers.keys()], [prescaler]);
  const control = registry.handlers.get(prescaler);
  const divisors = [4, 8, 16, 32, 64, 128, 256, 512];
  assert.deepEqual([control.read(0), adc.snapshot().divider], [0, 4]);
  for (let raw = 0; raw <= 0xff; raw++) {
    control.write(raw, 1);
    const selector = raw & 7;
    assert.equal(control.read(2), selector);
    assert.equal(adc.snapshot().divider, divisors[selector]);
  }
  adc.reset();
  assert.deepEqual([control.read(3), adc.snapshot().divider], [0, 4]);
});

test('CPU STS applies ADCA DIV256 on the write edge while preserving ADC configuration', () => {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0x80, 0x93, 0x04, 0x02]); // STS 0x0204,R24
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: event => events.push(event) });
  adc.register(cpu.bus.mmio, { mapCtrla: true, mapCtrlb: true, mapEvctrl: true, mapRefctrl: true, mapPrescaler: true });
  cpu.bus.write(0x020c, 0x5a);
  cpu.bus.write(0x020d, 3);
  cpu.bus.write(0x0200, 1);
  cpu.bus.write(0x0202, 0x12);
  cpu.r[24] = 6;
  const before = adc.snapshot(), trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: prescaler, value: 6 });
  assert.deepEqual([event.register, event.completed, event.cycle, event.before], ['PRESCALER', true, 2, before]);
  assert.deepEqual(event.after, { cal: 0x035a, temp: 0x5a, ctrla: 1, ctrlb: 0, refctrl: 0x12, evctrl: 0, prescaler: 6, divider: 256 });
  assert.equal(cpu.bus.read(prescaler), 6);
});
