import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { adcStoreFixture } from './adca-store-fixture.mjs';

const mux = 0x0221;

test('ADCA CH0 MUXCTRL retains the A3 input selectors and masks bits 7 and 2', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapCh0Muxctrl: true });
  assert.deepEqual([...registry.handlers.keys()], [mux]);
  const control = registry.handlers.get(mux);
  assert.equal(control.read(0), 0);
  for (let raw = 0; raw <= 0xff; raw++) {
    const positive = (raw >>> 3) & 0x0f, negative = raw & 3;
    if (positive >= 8) {
      const before = adc.snapshot();
      assert.throws(() => control.write(raw, 1), e => e.classification === 'ADCA_RESERVED_MUXPOS');
      assert.deepEqual(adc.snapshot(), before);
    } else {
      control.write(raw, 1);
      assert.equal(control.read(2), (positive << 3) | negative);
    }
  }
  adc.reset();
  assert.equal(control.read(3), 0);
});

test('CPU STS latches channel 0 positive selector one with the ADC at DIV256', () => {
  const { cpu, adc, events } = adcStoreFixture(mux, 24, { mapCh0Muxctrl: true, mapPrescaler: true, mapCtrla: true });
  cpu.bus.write(0x020c, 0x5a);
  cpu.bus.write(0x020d, 3);
  cpu.bus.write(0x0200, 1);
  cpu.bus.write(0x0204, 6);
  const before = adc.snapshot();
  cpu.r[24] = 8;
  const trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: mux, value: 8 });
  assert.deepEqual([event.register, event.cycle, event.completed, event.before], ['CH0.MUXCTRL', 2, true, before]);
  assert.deepEqual(event.after, { cal: 0x035a, temp: 0x5a, ctrla: 1, prescaler: 6, divider: 256, ch0Muxctrl: 8 });
});

test('An unavailable A3 positive selector faults before the channel 0 MUX store retires', () => {
  const { cpu, adc, events } = adcStoreFixture(mux, 24, { mapCh0Muxctrl: true });
  cpu.bus.write(mux, 0x1b);
  cpu.r[24] = 0xc4;
  const before = adc.snapshot(), cpuBefore = cpu.state();
  assert.throws(() => cpu.step(), e => e.classification === 'ADCA_RESERVED_MUXPOS' && e.addressByte === mux && e.attemptedValue === 0xc4);
  assert.deepEqual(cpu.state(), cpuBefore);
  assert.deepEqual(adc.snapshot(), before);
  assert.deepEqual([events.at(-1).completed, events.at(-1).before, events.at(-1).after], [false, before, before]);
});
