import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { adcStoreFixture } from './adca-store-fixture.mjs';

const interruptControl = 0x0222;

test('ADCA CH0 INTCTRL retains the defined interrupt modes and all four priority levels', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapCh0Intctrl: true });
  assert.deepEqual([...registry.handlers.keys()], [interruptControl]);
  const control = registry.handlers.get(interruptControl);
  assert.equal(control.read(0), 0);
  for (let raw = 0; raw <= 0xff; raw++) {
    const mode = (raw >>> 2) & 3;
    if (mode === 2) {
      const before = control.read(1);
      assert.throws(() => control.write(raw, 2), e => e.classification === 'ADCA_RESERVED_INTMODE');
      assert.equal(control.read(3), before);
    } else {
      control.write(raw, 2);
      assert.equal(control.read(3), raw & 0x0f);
    }
  }
  adc.reset();
  assert.equal(control.read(4), 0);
});

test('CPU STS selects conversion complete and interrupt level off on channel 0', () => {
  const { cpu, adc, events } = adcStoreFixture(interruptControl, 1, { mapCh0Muxctrl: true, mapCh0Intctrl: true, mapPrescaler: true });
  cpu.bus.write(0x0204, 6);
  cpu.bus.write(0x0221, 8);
  cpu.bus.write(interruptControl, 0x0f);
  const before = adc.snapshot(), trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: interruptControl, value: 0 });
  assert.deepEqual([event.register, event.cycle, event.completed, event.before], ['CH0.INTCTRL', 2, true, before]);
  assert.deepEqual(event.after, { cal: 0, temp: 0, prescaler: 6, divider: 256, ch0Muxctrl: 8, ch0Intctrl: 0 });
});

test('A reserved channel 0 interrupt mode preserves the old register and CPU state', () => {
  const { cpu, adc, events } = adcStoreFixture(interruptControl, 1, { mapCh0Intctrl: true });
  cpu.bus.write(interruptControl, 0x05);
  cpu.r[1] = 0xfa;
  const before = adc.snapshot(), cpuBefore = cpu.state();
  assert.throws(() => cpu.step(), e => e.classification === 'ADCA_RESERVED_INTMODE' && e.addressByte === interruptControl && e.attemptedValue === 0xfa);
  assert.deepEqual(cpu.state(), cpuBefore);
  assert.deepEqual(adc.snapshot(), before);
  assert.deepEqual([events.at(-1).completed, events.at(-1).before, events.at(-1).after], [false, before, before]);
});
