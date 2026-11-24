import test from 'node:test';
import assert from 'node:assert/strict';
import {NVMController,NVMActivity,NVM_BASE,NVM_REGISTERS} from '../src/peripherals/nvm.mjs';
import {XmegaCPU} from '../src/xmega.mjs';
function fixture(options={}) {
  const flash=new Uint8Array(0x42000).fill(255),present=new Uint8Array(0x42000);
  flash[0]=0x37;flash[1]=0x85;present.fill(1,0,2);
  const c=new XmegaCPU({flash,present}); const events=[];
  const n=new NVMController({onAccess:e=>events.push(e),...options});
  n.register(c.bus.mmio,{fault:(m,d)=>c.fault(m,d),clock:()=>c.cycles,context:()=>({pcWord:c.pc,cyclesBefore:c.cycles})});
  return {c,n,events};
}
test('documented NVM register addresses and cold reset values',()=>{
  assert.equal(NVM_BASE,0x1c0);
  assert.deepEqual(NVM_REGISTERS,{ADDR0:0,ADDR1:1,ADDR2:2,DATA0:4,DATA1:5,DATA2:6,CMD:10,CTRLA:11,CTRLB:12,INTCTRL:13,STATUS:15,LOCKBITS:16});
  const {c,n}=fixture(); for(const o of [0,1,2,4,5,6,10,11,12,13,15]) assert.equal(c.read(0x1c0+o),0);
  assert.equal(n.activity.pending,null);assert.equal(n.activity.eepromLoaded,false);assert.equal(n.activity.flashLoaded,false);
  assert.throws(()=>c.read(0x1d0),e=>e.classification==='NVM_LOCKBITS_UNKNOWN');
});
test('state kernel: flash, EEPROM and lock-bit busy transitions at exact deadlines',()=>{
  for(const [kind,busy] of [['flash',0xc0],['eeprom',0x80],['lockbits',0x80]]) {
    const a=new NVMActivity();a.advanceTo(10);a.begin(kind,20);assert.equal(a.status,busy);
    assert.equal(a.advanceTo(19),null);assert.equal(a.status,busy);
    assert.deepEqual(a.advanceTo(20),{kind,startCycle:10,completeCycle:20});assert.equal(a.status,0);
    assert.equal(a.advanceTo(20),null);assert.equal(a.advanceTo(100),null);
  }
});
test('loaded flags remain independent of busy state and of each other',()=>{
  for(const ee of [false,true]) for(const flash of [false,true]) {
    const a=new NVMActivity();a.eepromLoaded=ee;a.flashLoaded=flash;
    const loaded=Number(ee)*2+Number(flash);assert.equal(a.status,loaded);
    a.begin('eeprom',2);assert.equal(a.status,0x80|loaded);a.advanceTo(2);assert.equal(a.status,loaded);
    a.begin('flash',4);assert.equal(a.status,0xc0|loaded);a.advanceTo(4);assert.equal(a.status,loaded);
  }
});
test('scheduler rejects overlap, invalid deadlines and backwards time without mutations',()=>{
  const a=new NVMActivity();for(const t of [-1,NaN,1.5,Infinity]) assert.throws(()=>a.advanceTo(t));
  assert.throws(()=>a.begin('invented',3));assert.throws(()=>a.begin('flash',0));
  a.begin('flash',10);const before=a.snapshot();assert.throws(()=>a.begin('eeprom',20));assert.deepEqual(a.snapshot(),before);
  a.advanceTo(5);assert.throws(()=>a.advanceTo(4));assert.equal(a.now,5);
});
test('read-only STATUS and LOCKBITS writes do not change state',()=>{
  const {c,n,events}=fixture({lockbits:0x5a});
  for(let v=0;v<256;v++) {c.write(0x1cf,v);c.write(0x1d0,v);assert.equal(c.read(0x1cf),0);assert.equal(c.read(0x1d0),0x5a);}
  assert.ok(events.filter(e=>e.kind==='write').every(e=>e.ignored));n.reset();assert.equal(c.read(0x1d0),0x5a);
});
test('register staging, unsupported commands, control features and CCP trigger reject explicitly',()=>{
  const {c,n}=fixture();
  for(const o of [0,1,2,4,5,6]) {c.write(0x1c0+o,0xa5+o);assert.equal(c.read(0x1c0+o),0xa5+o);}
  for(let command=1;command<256;command++) assert.throws(()=>c.write(0x1ca,command),e=>e.classification==='NVM_UNSUPPORTED_COMMAND');
  for(const [address,classification] of [[0x1cb,'NVM_COMMAND_EXECUTION_UNSUPPORTED'],[0x1cc,'NVM_CONTROL_UNSUPPORTED'],[0x1cd,'NVM_INTERRUPTS_UNSUPPORTED']]) {
    for(let v=1;v<256;v++) assert.throws(()=>c.write(address,v),e=>e.classification===classification);
    c.write(address,0);assert.equal(c.read(address),0);
  }
  assert.throws(()=>c.write(0x34,0xd8),e=>e.classification==='UNHANDLED_MMIO');
  assert.equal(n.activity.pending,null);assert.equal(c.read(0x1ca),0);
});
test('reserved offsets, register boundaries and registration collisions remain strict',()=>{
  const {c,n}=fixture();
  for(const a of [0x1bf,0x1c3,0x1c7,0x1c8,0x1c9,0x1ce,0x1d1]) {
    assert.throws(()=>c.read(a),e=>e.classification==='UNHANDLED_MMIO');
    assert.throws(()=>c.write(a,0),e=>e.classification==='UNHANDLED_MMIO');
  }
  assert.throws(()=>n.read(3),e=>e.classification==='NVM_UNSUPPORTED_REGISTER');
  const size=c.hooks.size;assert.throws(()=>new NVMController().register(c.bus.mmio),/collision/);assert.equal(c.hooks.size,size);
});
test('pending activity is observable but unsupported busy access and warm reset fail safely',()=>{
  const {c,n}=fixture();n.activity.begin('flash',20);assert.equal(c.read(0x1cf),0xc0);
  assert.throws(()=>c.write(0x1c0,3),e=>e.classification==='NVM_BUSY_ACCESS_UNSUPPORTED');
  assert.throws(()=>n.reset(),e=>e.classification==='NVM_RESET_DURING_OPERATION_UNSUPPORTED');
  assert.equal(n.activity.status,0xc0);c.cycles=20;n.advanceTo(c.cycles);assert.equal(c.read(0x1cf),0);
  n.reset();assert.equal(n.activity.status,0);
});
test('deterministic activity replay emits one completion and preserves all nonvolatile bytes',()=>{
  function run(){const transitions=[];const {c,n,events}=fixture({onTransition:e=>transitions.push(e)});
    const flash=Uint8Array.from(c.flash),eeprom=Uint8Array.from(c.eeprom);
    n.activity.begin('eeprom',15);for(const time of [0,3,14,15,15,25]) {c.cycles=time;assert.equal(c.read(0x1cf),time<15?0x80:0);}
    n.reset();assert.deepEqual(c.flash,flash);assert.deepEqual(c.eeprom,eeprom);assert.equal(transitions.length,1);
    return {events,transitions,state:n.snapshot()};}
  assert.deepEqual(run(),run());
});
test('real CPU LDD reads derived idle status, preserves pointers and charges two I/O cycles',()=>{
  const {c,n,events}=fixture();c.setPair(30,0x1c0);c.r[19]=0xff;c.rampz=2;c.sreg=0xa5;
  const t=c.step();assert.equal(c.r[19],0);assert.equal(c.pair(30),0x1c0);assert.equal(c.sreg,0xa5);
  assert.equal(c.cycles,2);assert.equal(c.pc,1);assert.equal(t.eventType,'instruction');
  assert.deepEqual(t.accesses.at(-1),{kind:'read',space:'mmio',addressByte:0x1cf,value:0});
  assert.equal(events.length,1);assert.equal(n.activity.pending,null);
});
