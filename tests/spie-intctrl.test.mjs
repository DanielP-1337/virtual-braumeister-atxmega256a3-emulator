import test from 'node:test';
import assert from 'node:assert/strict';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { PMIC } from '../src/peripherals/pmic.mjs';
import { SPIController, SPIE_BASE } from '../src/peripherals/spic.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

function fixture(options = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0xac, 0x92]); // ST X,R10
  present.fill(1,0,2);
  const cpu = new XmegaCPU({ flash, present }), gpio = new GPIOController(), events = [];
  const spi = new SPIController({ instance:'SPIE',gpio,onAccess:e => events.push(e) });
  spi.register(cpu.bus.mmio, { mapIntctrl:true,...options,context:() => ({pcWord:cpu.pc,instructionAttempt:cpu.steps+1}) });
  return {cpu,gpio,spi,events};
}

test('SPIE INTCTRL independently maps and resets its four interrupt levels', () => {
  const {cpu,spi} = fixture({mapCtrl:false});
  assert.deepEqual([...cpu.bus.mmio.handlers.keys()],[0x0ac1]);
  assert.equal(cpu.read(0x0ac1),0);
  for (const level of [1,2,3,0]) {
    cpu.write(0x0ac1,level);
    assert.equal(cpu.read(0x0ac1),level);
    assert.equal(spi.interruptRequest(0),null);
  }
  cpu.write(0x0ac1,2);
  for (let value=4; value<=255; value++) {
    assert.throws(() => cpu.write(0x0ac1,value),{classification:'SPI_RESERVED_CONFIGURATION'});
    assert.equal(cpu.read(0x0ac1),2);
  }
  spi.reset();
  assert.equal(cpu.read(0x0ac1),0);
});

test('SPIE ST X disables its interrupt while preserving master mode and pending flags', () => {
  const {cpu,gpio,spi,events} = fixture();
  gpio.write('E',1,0x10);
  cpu.write(SPIE_BASE,0x50);
  cpu.write(SPIE_BASE+1,3);
  spi.flags = 0xc0; // Synthetic pending completion and write collision.
  cpu.setPair(26,SPIE_BASE+1);
  cpu.r[10]=0;
  const before=spi.snapshot(), t=cpu.step(), e=events.at(-1);
  assert.deepEqual([t.mnemonic,t.after.cycles,t.after.pcWord],['ST X',1,1]);
  assert.deepEqual(t.accesses.at(-1),{kind:'write',space:'mmio',addressByte:0x0ac1,value:0});
  assert.deepEqual([e.peripheral,e.register,e.cycle,e.value,e.before,e.after],['SPIE','INTCTRL',1,0,before,{...before,intctrl:0}]);
  assert.equal(spi.interruptRequest(1),null);
});

test('SPIE presents IF at its selected PMIC level and clears only IF on vector entry', () => {
  for (const level of [1,2,3]) {
    const {cpu,gpio,spi}=fixture();
    const pmic=new PMIC({sources:[cycle=>spi.interruptRequest(cycle)],onAcknowledge:r=>spi.acknowledgeInterrupt(r)});
    cpu.bus.attachPMIC(pmic);
    cpu.sreg=0x80;
    cpu.write(0x00a2,7);
    gpio.setInputSample('E',0x10,0x10);
    cpu.write(SPIE_BASE,0x50);
    spi.flags=0x40; // WRCOL alone is not an interrupt source.
    cpu.write(SPIE_BASE+1,level);
    assert.equal(pmic.pending(0),null);
    gpio.setInputSample('E',0,0x10);
    const request={peripheral:'SPIE',source:'IF',level,vectorWord:0x72};
    assert.deepEqual(pmic.pending(0),request);
    spi.acknowledgeInterrupt({...request,peripheral:'TWIE'});
    assert.equal(spi.snapshot().status,0xc0);
    const entry=cpu.step();
    assert.deepEqual([entry.eventType,entry.vectorPcWord,entry.interruptRequest],['interrupt-entry',0x72,request]);
    assert.deepEqual([spi.snapshot().status,spi.interruptRequest(cpu.cycles),pmic.executingLevel],[0x40,null,level]);
  }
});
