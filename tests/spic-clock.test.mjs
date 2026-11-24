import test from 'node:test';
import assert from 'node:assert/strict';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { SPIController } from '../src/peripherals/spic.mjs';

function transferWithInputSS() {
  const gpio = new GPIOController(), mmio = new MMIORegistry(), events = [];
  gpio.write('C', 0, 0xa0); // SS is an input. MOSI and SCK are outputs.
  gpio.setInputSample('C', 0x10, 0x10);
  const spi = new SPIController({ gpio, exchange: () => 0x67, onTransfer: e => events.push(e) });
  spi.register(mmio);
  mmio.handlers.get(0x8c0).write(0x5c, 5);
  mmio.handlers.get(0x8c3).write(0x9d, 10);
  return { gpio, mmio, spi, events };
}

test('SPIC orders an observed SS loss against the outstanding transfer deadline', () => {
  // Frame occupies [10,42]. A coincident SS observation takes priority in this byte model.
  for (const [observedCycle, expectedRx, expectedActions] of [
    [41, 0, ['start', 'master-lost']],
    [42, 0, ['start', 'master-lost']],
    [43, 0x67, ['start', 'complete', 'master-lost']],
  ]) {
    const { gpio, spi, mmio, events } = transferWithInputSS();
    gpio.setInputSample('C', 0, 0x10);
    spi.advanceTo(observedCycle);
    assert.deepEqual(events.map(e => e.action), expectedActions);
    if (expectedRx) assert.equal(events[1].cycle, 42);
    assert.equal(mmio.handlers.get(0x8c0).read(43), 0x4c);
    assert.equal(mmio.handlers.get(0x8c2).read(43), 0x80);
    assert.equal(mmio.handlers.get(0x8c3).read(43), expectedRx);
    assert.equal(mmio.handlers.get(0x8c2).read(43), 0);
    assert.equal(spi.busy, false);
  }
});

test('SPIC preserves uncertainty if an active master loses its SS input evidence', () => {
  const { gpio, spi, mmio, events } = transferWithInputSS();
  gpio.setInputSample('C', 0, 0);
  spi.advanceTo(18);
  gpio.setInputSample('C', 0x10, 0x10);
  spi.advanceTo(42);
  assert.deepEqual(events.map(e => e.action), ['start', 'unknown-select']);
  assert.throws(() => mmio.handlers.get(0x8c2).read(42), { classification: 'SPI_UNKNOWN_SS' });
  spi.reset();
  assert.equal(mmio.handlers.get(0x8c2).read(0), 0);
});
