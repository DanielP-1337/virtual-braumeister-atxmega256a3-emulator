import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spieFrameInput } from '../../scripts/spie-input.mjs';
import { GPIOController } from '../../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../../src/peripherals/mmio-registry.mjs';

const file = resolve(process.argv[2] ?? 'src/peripherals/spic.mjs');
const { SPIController, SPIE_BASE } = await import(pathToFileURL(file).href);
const options = ['mapCtrl', 'mapIntctrl', 'mapStatus', 'mapData'];
const offsets = [0, 1, 2, 3];
const gpio = new GPIOController();
gpio.write('E', 1, 0xb0);
for (let mask = 0; mask < 16; mask++) {
  const selected = offsets.filter(i => mask & (1 << i));
  const configuration = Object.fromEntries(options.map((option, i) => [option, selected.includes(i)]));
  const registry = new MMIORegistry();
  new SPIController({ instance: 'SPIE', gpio }).register(registry, configuration);
  assert.deepEqual([...registry.handlers.keys()], selected.map(i => SPIE_BASE + i));

  for (const offset of selected) {
    const occupied = new MMIORegistry();
    occupied.map(SPIE_BASE + offset, { read: () => 0 });
    const spi = new SPIController({ instance: 'SPIE', gpio });
    assert.throws(() => spi.register(occupied, configuration), /collision/);
    assert.deepEqual([...occupied.handlers.keys()], [SPIE_BASE + offset]);
    assert.equal(spi.registered, false);
  }
}
const compatibility = new MMIORegistry();
new SPIController({ instance: 'SPIE', gpio }).register(compatibility);
assert.deepEqual([...compatibility.handlers.keys()], [SPIE_BASE]);
new SPIController({ gpio }).register(compatibility, { mapCtrl: false, mapStatus: false, mapData: false });
assert.ok(offsets.every(i => compatibility.handlers.has(0x08c0 + i)));
assert.equal(spieFrameInput(undefined), null);
for (const unsupported of ['', '0x0', '0x100', '0x03,', '0x42,22', null]) {
  assert.throws(() => spieFrameInput(unsupported), /synthetic-spie-rx/);
}
const values = Array.from({ length: 256 }, (_, i) => i);
const input = spieFrameInput(values.map(n => '0x' + n.toString(16).padStart(2, '0')).join(','));
assert.deepEqual(input.report, { provenance: 'synthetic', peripheral: 'SPIE', frameIndex: 0, wireRx: 0, additionalWireRx: values.slice(1) });
for (let pass = 0; pass < 2; pass++) {
  const registry = new MMIORegistry();
  const c = new SPIController({ gpio });
  const e = new SPIController({ instance: 'SPIE', gpio, exchange: input.createExchange() });
  c.register(registry);
  e.register(registry, { mapIntctrl: true, mapData: true, mapStatus: true });
  const cState = c.snapshot();
  const reg = i => registry.handlers.get(SPIE_BASE + i);
  reg(0).write(0x50, 1);
  for (const n of values) {
    const cycle = 10 + 40 * n;
    reg(3).write(4, cycle);
    assert.equal(reg(2).read(cycle + 31), 0);
    assert.equal(reg(2).read(cycle + 32), 0x80);
    assert.equal(reg(3).read(cycle + 34), n);
    assert.equal(reg(2).read(cycle + 35), 0);
  }
  reg(3).write(4, 10250);
  assert.equal(reg(2).read(10282), 0x80);
  assert.throws(() => reg(3).read(10284), { classification: 'SPI_UNKNOWN_RX', addressByte: SPIE_BASE + 3 });
  assert.deepEqual(c.snapshot(), cState);
}
console.log(JSON.stringify({ status: 'PASS', sourceSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  registerMasks: 16, collisions: 32, completedByteValues: 256, resetPasses: 2, unknownAfterInputExhaustion: true }, null, 2));
