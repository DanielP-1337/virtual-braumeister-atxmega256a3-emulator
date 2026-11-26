import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { adcStoreFixture } from './adca-store-fixture.mjs';

const channelControl = 0x0220;

test('ADCA CH0 CTRL retains the gain and input-mode fields and resets to zero', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapCh0Ctrl: true });
  assert.deepEqual([...registry.handlers.keys()], [channelControl]);
  const ctrl = registry.handlers.get(channelControl);
  assert.equal(ctrl.read(0), 0);
  for (let raw = 0; raw < 0x80; raw++) {
    ctrl.write(raw, 1);
    assert.equal(ctrl.read(2), raw & 0x1f);
  }
  adc.reset();
  assert.equal(ctrl.read(3), 0);
});

test('CPU STS selects the single-ended ADCA channel without starting a conversion', () => {
  const { cpu, adc, events } = adcStoreFixture(channelControl, 24,
    { mapCh0Ctrl: true, mapCh0Muxctrl: true, mapCh0Intflags: true, mapCtrla: true });
  cpu.bus.write(0x020c, 0x5a);
  cpu.bus.write(0x020d, 3);
  cpu.bus.write(0x0200, 1);
  cpu.bus.write(0x0221, 8);
  cpu.bus.write(0x0223, 1);
  const before = adc.snapshot();
  cpu.r[24] = 1;
  const trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: channelControl, value: 1 });
  assert.deepEqual([event.register, event.value, event.cycle, event.completed, event.before], ['CH0.CTRL', 1, 2, true, before]);
  assert.deepEqual(event.after, { ...before, ch0Ctrl: 1 });
});

test('CH0 START diagnoses the missing ADC conversion before changing channel or CPU state', () => {
  const { cpu, adc, events } = adcStoreFixture(channelControl, 24, { mapCh0Ctrl: true, mapCtrla: true });
  cpu.bus.write(0x0200, 1);
  cpu.bus.write(channelControl, 1);
  const config = adc.snapshot();
  for (let value = 0x80; value <= 0xff; value++) {
    cpu.r[24] = value;
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'ADCA_CONVERSION_START_UNSUPPORTED' &&
      e.addressByte === channelControl && e.attemptedValue === value);
    assert.deepEqual(cpu.state(), before);
    assert.deepEqual(adc.snapshot(), config);
    assert.deepEqual([events.at(-1).completed, events.at(-1).after], [false, config]);
  }
});
