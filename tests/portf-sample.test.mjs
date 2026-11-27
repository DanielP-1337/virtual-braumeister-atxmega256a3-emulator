import test from 'node:test';
import assert from 'node:assert/strict';
import { portfInput } from '../scripts/portf-input.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

test('PORTF explicit samples carry an ordered cycle and unsigned byte', () => {
  assert.equal(portfInput(undefined), null);
  for (const invalid of ['', null, 0, '-1:0x00', '1:0x0', '1:0x100', '1:0xGG', '9007199254740992:0x00',
    '2:0xFF,1:0x00', '2:0xFF,2:0x00', '1:0x00,']) assert.throws(() => portfInput(invalid));
  const input = portfInput('0:0x00,12:0xa4');
  assert.deepEqual(input.report, {provenance:'synthetic',port:'F',register:'IN',samples:[{cycle:0,value:0},{cycle:12,value:164}]});
  assert.equal(input.inputSampleAt('F', 0), 0);
  assert.equal(input.inputSampleAt('F', 11), undefined);
  assert.equal(input.inputSampleAt('E', 12), undefined);
});

test('PORTF time-scoped reads apply pin inversion without changing the retained port sample', () => {
  const gpio = new GPIOController(portfInput('8:0x00,12:0xFF'));
  const mmio = new MMIORegistry();
  gpio.register(mmio);
  const sample = cycle => mmio.handlers.get(0x6a8).read(cycle);
  const unresolved = error => error.classification === 'GPIO_UNRESOLVED_INPUT';
  mmio.handlers.get(0x6b4).write(0x40, 6);
  assert.throws(() => sample(7), unresolved);
  const before = gpio.snapshot('F');
  assert.equal(sample(8), 0x10);
  assert.deepEqual(gpio.snapshot('F'), before);
  assert.throws(() => sample(9), unresolved);
  assert.throws(() => mmio.handlers.get(0x688).read(8), unresolved);
  gpio.setInputSample('F', 0x24);
  assert.equal(sample(12), 0xef);
  assert.equal(sample(13), 0x34);
});

test('GPIO sampled reads preserve input-disable and stable-high constraints', () => {
  const gpio = new GPIOController({inputSampleAt:() => 0, stableHighMask:() => 4});
  assert.throws(() => gpio.read('F', 8, 10), /contradicts/);
  gpio.write('F', 16, 7);
  assert.throws(() => gpio.read('F', 8, 10), e => e.classification === 'GPIO_INPUT_DISABLED_UNMODELED');
});
