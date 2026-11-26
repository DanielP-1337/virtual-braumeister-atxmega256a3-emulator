import test from 'node:test';
import assert from 'node:assert/strict';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { PMIC } from '../src/peripherals/pmic.mjs';
import { PortEInterrupts } from '../src/peripherals/porte-interrupts.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const ctrl = 0x0689, mask = 0x068a;
function fixture(bytes = [], options = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set(bytes);
  present.fill(1,0,bytes.length);
  const cpu = new XmegaCPU({flash,present}), gpio = new GPIOController(), events = [];
  gpio.register(cpu.bus.mmio);
  const port = new PortEInterrupts({gpio,onAccess:e => events.push(e)});
  port.register(cpu.bus.mmio,{mapIntctrl:true,...options,context:()=>({pcWord:cpu.pc,instructionAttempt:cpu.steps+1})});
  return {cpu,gpio,port,events};
}

test('PORTE INTCTRL independently retains both two-bit levels and reads reserved bits as zero', () => {
  const {cpu,port} = fixture([],{mapInt0Mask:false});
  assert.equal(cpu.bus.mmio.handlers.has(mask),false);
  assert.equal(cpu.read(ctrl),0);
  for (let raw=0; raw<=255; raw++) {
    cpu.write(ctrl,raw);
    assert.equal(cpu.read(ctrl),raw & 15);
    assert.equal(port.request(0),null);
  }
  port.reset();
  assert.deepEqual(port.snapshot(),{int0Mask:0,intctrl:0,unobservedPins:0});
  assert.throws(() => new PortEInterrupts().register(cpu.bus.mmio,{mapIntctrl:true}),/collision/);
  assert.equal(cpu.bus.mmio.handlers.has(mask),false);
});

test('PORTE INTCTRL firmware read-modify-write reads reset and programs low INT0 priority in five clocks', () => {
  const {cpu,port,events} = fixture([0x81,0x85,0x81,0x60,0x81,0x87]);
  cpu.setPair(30,0x0680);
  cpu.r[24]=0xff;
  cpu.write(mask,4);
  const read=cpu.step(), modify=cpu.step(), write=cpu.step();
  assert.deepEqual([read.mnemonic,modify.mnemonic,write.mnemonic],['LDD','ORI','STD']);
  assert.deepEqual([read.after.cycles,modify.after.cycles,write.after.cycles],[2,3,5]);
  assert.deepEqual([read.after.registers[24],modify.after.registers[24],write.after.registers[24]],[0,1,1]);
  assert.deepEqual(events.slice(1).map(e=>[e.register,e.kind,e.value,e.cycle]),[['INTCTRL','read',0,2],['INTCTRL','write',1,5]]);
  assert.deepEqual(port.snapshot(),{int0Mask:4,intctrl:1,unobservedPins:4});
});

test('PORTE INT0 remembers an unobserved sense interval through masking and an isolated input sample', () => {
  const {cpu,gpio,port}=fixture();
  cpu.write(0x0692,7); // PE2 input buffer disabled.
  cpu.write(mask,4);
  cpu.write(ctrl,1);
  assert.equal(port.request(1),null);
  cpu.write(0x0692,2,2); // Falling edges can now set the flag.
  port.observe(2);
  assert.equal(port.request(2),null);
  cpu.write(ctrl,0,3);
  cpu.write(mask,0,4);
  gpio.setInputSample('E',4,4);
  assert.equal(port.request(4),null);
  for (const level of [0,1,2,3]) {
    cpu.write(ctrl,0x0c | level,5);
    const req=port.request(5);
    if (level === 0) assert.equal(req,null);
    else {
      assert.deepEqual([req.level,req.vectorWord,req.unobservedPins],[level,0x56,4]);
      assert.equal(req.uncertainty.classification,'PORTE_INT0_INPUT_HISTORY_UNKNOWN');
    }
  }
  port.reset();
  assert.equal(port.request(6),null);
});

test('PMIC arbitrates uncertain PORTE INT0 after SEI and the next instruction without consuming a vector', () => {
  const {cpu,port}=fixture([0x78,0x94,0,0,0,0]); // SEI, NOP, NOP.
  let higher=null;
  const pmic=new PMIC({sources:[cycle=>port.request(cycle),()=>higher]});
  cpu.bus.attachPMIC(pmic);
  cpu.write(mask,4);
  cpu.write(ctrl,1);
  cpu.write(0x00a2,4); // Initially only the high PMIC level is enabled.
  assert.equal(cpu.step().mnemonic,'SEI');
  assert.equal(pmic.pending(cpu.cycles),null);
  cpu.write(0x00a2,7);
  assert.equal(cpu.step().mnemonic,'NOP');
  const before=cpu.state(), stack=cpu.sram.slice();
  higher={peripheral:'test',source:'ready',level:3,vectorWord:0x72};
  assert.deepEqual(pmic.pending(cpu.cycles),higher);
  higher=null;
  assert.throws(()=>cpu.step(), e=>{
    assert.equal(e.classification,'PORTE_INT0_INPUT_HISTORY_UNKNOWN');
    assert.deepEqual([e.trace.instructionAttempted,e.trace.accesses,e.trace.opcode,e.trace.interruptRequest.level],[false,[],null,1]);
    return true;
  });
  assert.deepEqual(cpu.state(),before);
  assert.deepEqual(cpu.sram,stack);
  assert.deepEqual(pmic.snapshot(),{status:0,intpri:0,ctrl:7});
});
