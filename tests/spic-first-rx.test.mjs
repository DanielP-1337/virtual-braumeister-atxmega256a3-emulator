import assert from 'node:assert/strict';
import test from 'node:test';
import { firstSpicInput } from '../scripts/spic-input.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { SPIController } from '../src/peripherals/spic.mjs';

test('SPIC first wire byte accepts all byte values and starts afresh on each reset', () => {
  assert.equal(firstSpicInput(undefined),null);
  for (const invalid of [0, null, '', '00','0x0','0x100','0xgg','0x00,0xff']) assert.throws(()=>firstSpicInput(invalid));
  for (let value=0;value<256;value++) {
    const input=firstSpicInput('0x'+value.toString(16).padStart(2,'0'));
    assert.deepEqual(input.report,{provenance:'synthetic',peripheral:'SPIC',frameIndex:0,wireRx:value});
    const first=input.createExchange(),second=input.createExchange();
    assert.deepEqual([first(),first(),second(),second()],[value,null,value,null]);
  }
});

test('SPIC models the first wire response and leaves the next completed frame unresolved', () => {
  for (const [ctrl,expected] of [[0x50,0x96],[0x70,0x69]]) {
    const gpio=new GPIOController();
    gpio.write('C',0,0xb0);
    const spi=new SPIController({gpio,exchange:firstSpicInput('0x96').createExchange()});
    spi.access(0,'write',ctrl,0);
    spi.access(3,'write',0,1);
    assert.equal(spi.access(2,'read',undefined,33),0x80);
    assert.equal(spi.access(3,'read',undefined,33),expected);
    spi.access(3,'write',0,34);
    assert.equal(spi.access(2,'read',undefined,66),0x80);
    assert.throws(()=>spi.access(3,'read',undefined,66),e=>e.classification==='SPI_UNKNOWN_RX');
  }
});
