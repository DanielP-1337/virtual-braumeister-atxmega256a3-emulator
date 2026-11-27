import test from 'node:test';
import assert from 'node:assert/strict';
import { spicFrameInput } from '../scripts/spic-input.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { SPIController } from '../src/peripherals/spic.mjs';

test('SPIC subsequent wire bytes require a contiguous, explicit sequence and reset independently', () => {
  assert.throws(()=>spicFrameInput(undefined,'0x01'),/first-rx/);
  for (const bad of [null,0,'','0','0x00,','0xFF,,0x00','0x01, 0x02','0x100','0xZZ']) {
    assert.throws(()=>spicFrameInput('0xaa',bad),/next-rx/);
  }
  const input=spicFrameInput('0x2A','0x00,0xa5,0xFF');
  assert.deepEqual(input.report,{provenance:'synthetic',peripheral:'SPIC',frameIndex:0,wireRx:42,additionalWireRx:[0,165,255]});
  const left=input.createExchange(), right=input.createExchange();
  assert.deepEqual([left(),left(),right(),left(),right(),left(),left(),left()],[42,0,42,165,0,255,null,null]);
});

test('SPIC reads every second response independently and a third unsupplied frame remains unknown', () => {
  for (let value=0;value<256;value++) {
    const gpio=new GPIOController(); gpio.write('C',0,0xb0);
    const input=spicFrameInput('0x5a','0x'+value.toString(16).padStart(2,'0'));
    const spi=new SPIController({gpio,exchange:input.createExchange()});
    spi.access(0,'write',0x5c,0);
    for (const [cycle,expected] of [[1,0x5a],[34,value]]) {
      spi.access(3,'write',cycle===1?0:7,cycle);
      assert.equal(spi.access(2,'read',undefined,cycle+32),0x80);
      assert.equal(spi.access(3,'read',undefined,cycle+32),expected);
    }
    spi.access(3,'write',0,67);
    assert.equal(spi.access(2,'read',undefined,99),0x80);
    assert.throws(()=>spi.access(3,'read',undefined,99),e=>e.classification==='SPI_UNKNOWN_RX');
  }
});
