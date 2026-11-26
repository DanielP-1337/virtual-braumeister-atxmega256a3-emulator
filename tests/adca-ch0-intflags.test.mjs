import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { adcStoreFixture } from './adca-store-fixture.mjs';

const channelFlags = 0x0223;

test('ADCA CH0 INTFLAGS clears a set CHIF only when bit zero is written as one', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapCh0Intflags: true });
  assert.deepEqual([...registry.handlers.keys()], [channelFlags]);
  const flags = registry.handlers.get(channelFlags);
  assert.equal(flags.read(0), 0);
  for (const initial of [0, 1]) {
    for (let raw = 0; raw <= 0xff; raw++) {
      adc.ch0Intflags = initial; // A pending hardware flag in this synthetic register test.
      assert.equal(flags.read(1), initial);
      flags.write(raw, 2);
      assert.equal(flags.read(3), (raw & 1) ? 0 : initial);
    }
  }
  adc.ch0Intflags = 1;
  adc.reset();
  assert.equal(flags.read(4), 0);
});

test('CPU STS logs the INTFLAGS bus write and the resulting cleared channel flag separately', () => {
  for (const initial of [0, 1]) {
    const { cpu, adc, events } = adcStoreFixture(channelFlags, 24, { mapCh0Intflags: true, mapCh0Intctrl: true });
    cpu.bus.write(0x0222, 3);
    adc.ch0Intflags = initial;
    cpu.r[24] = 1;
    const before = adc.snapshot(), trace = cpu.step(), event = events.at(-1);
    assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
    assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: channelFlags, value: 1 });
    assert.deepEqual([event.register, event.value, event.cycle, event.completed, event.before], ['CH0.INTFLAGS', 1, 2, true, before]);
    assert.deepEqual(event.after, { cal: 0, temp: 0, ch0Intctrl: 3, ch0Intflags: 0 });
  }
});
