import test from 'node:test';
import assert from 'node:assert/strict';
import { pe2HighInput } from '../scripts/pe2-input.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { PMIC } from '../src/peripherals/pmic.mjs';
import { PortEInterrupts } from '../src/peripherals/porte-interrupts.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const ctrl=0x0689, mask=0x068a, pin2ctrl=0x0692;
function fixture(interval) {
  const flash=new Uint8Array(0x42000), present=new Uint8Array(flash.length);
  flash.set([0xcf,0x93,0xdf,0x93]); // PUSH R28, PUSH R29.
  present.fill(1,0,4);
  const cpu=new XmegaCPU({flash,present});
  const gpio=new GPIOController({stableHighMask:pe2HighInput(interval)?.stableHighMask});
  gpio.register(cpu.bus.mmio);
  const port=new PortEInterrupts({gpio});
  port.register(cpu.bus.mmio,{mapIntctrl:true});
  const pmic=new PMIC({sources:[cycle=>port.request(cycle)]});
  cpu.bus.attachPMIC(pmic);
  return {cpu,gpio,port,pmic};
}

test('Synthetic PE2 high is an opt-in closed interval with ordered safe integer endpoints', () => {
  assert.equal(pe2HighInput(undefined),null);
  for (const invalid of ['',null,'-1:5','1:','2:1','1.5:4','1:Infinity','0:9007199254740992']) {
    assert.throws(()=>pe2HighInput(invalid));
  }
  const input=pe2HighInput('5:25');
  assert.deepEqual(input.report,{provenance:'synthetic',pin:'PE2',level:'high',fromCycle:5,throughCycle:25,endpoints:'inclusive'});
  for (const [port,from,through,expected] of [['E',5,25,4],['E',25,25,4],['E',4,5,0],['E',25,26,0],['F',5,25,0]]) {
    assert.equal(input.stableHighMask(port,from,through),expected);
  }
  assert.equal(pe2HighInput('0:0').stableHighMask('E',0,0),4);
});

test('PE2 both-edge and falling-edge sensing allows the push starting at the last covered cycle', () => {
  const {cpu,port,pmic}=fixture('5:25');
  cpu.write(mask,4,5);
  cpu.write(ctrl,1,10);
  cpu.write(pin2ctrl,2,13);
  port.observe(13);
  cpu.cycles=25;
  cpu.write(0x00a2,7);
  cpu.sreg=0x80;
  cpu.r[28]=0x45;
  const before=cpu.state();
  const t=cpu.step();
  assert.deepEqual([t.mnemonic,t.after.pcWord,t.after.cycles,t.after.sp],['PUSH',1,26,before.sp-1]);
  assert.deepEqual(t.accesses.at(-1),{kind:'write',space:'sram',addressByte:before.sp,value:0x45});
  assert.equal(port.snapshot().unobservedPins,0);
  const after=cpu.state();
  assert.throws(()=>cpu.step(),err=>{
    assert.equal(err.classification,'PORTE_INT0_INPUT_HISTORY_UNKNOWN');
    assert.deepEqual([err.trace.instructionAttempted,err.trace.accesses,err.trace.interruptRequest.unobservedPins],[false,[],4]);
    return true;
  });
  assert.deepEqual(cpu.state(),after);
  assert.equal(pmic.executingLevel,0);
});

test('A PE2 window preserves earlier possible edges and concurrent unknown pins', () => {
  const {cpu,port}=fixture('5:25');
  cpu.write(mask,4,4);
  cpu.write(ctrl,1,5);
  assert.equal(port.request(25).unobservedPins,4);
  port.reset();
  cpu.write(mask,12,5);
  cpu.write(ctrl,1,6);
  assert.equal(port.request(25).unobservedPins,8);
  port.reset();
  cpu.write(pin2ctrl,3,5); // A known physical high excludes a non-inverted low level.
  cpu.write(mask,4,5);
  cpu.write(ctrl,1,5);
  assert.equal(port.request(15),null);
  cpu.write(pin2ctrl,0x43,16);
  assert.equal(port.request(16).unobservedPins,4);
});

test('PORTE IN consumes the high level only at covered bus cycles and keeps other pin samples', () => {
  const {cpu,gpio}=fixture('5:25');
  gpio.setInputSample('E',0xa0,0xfb); // Only PE2 lacks a point sample.
  assert.throws(()=>cpu.read(0x0688,4),{classification:'GPIO_UNRESOLVED_INPUT'});
  assert.equal(cpu.read(0x0688,5),0xa4);
  cpu.write(pin2ctrl,0x40,6);
  assert.equal(cpu.read(0x0688,25),0xa0);
  assert.throws(()=>cpu.read(0x0688,26),{classification:'GPIO_UNRESOLVED_INPUT'});
  assert.deepEqual([gpio.snapshot('E').inputSample,gpio.snapshot('E').inputKnownMask],[0xa0,0xfb]);
});
