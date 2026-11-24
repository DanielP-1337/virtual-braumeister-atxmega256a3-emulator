import test from 'node:test';
import assert from 'node:assert/strict';
import {XmegaCPU} from '../src/xmega.mjs';
import {NVMController} from '../src/peripherals/nvm.mjs';
import {EEPROMStorage} from '../src/eeprom-storage.mjs';
import {decodeAt,discover} from '../src/discovery.mjs';
const pattern=()=>Uint8Array.from({length:4096},(_,i)=>(Math.floor(i/32)*19+i%32*7+3)%256);
function initialized(){return new EEPROMStorage({bytes:pattern(),provenance:{kind:'synthetic',label:'Independent page/offset test pattern'}});}
function machine(storage=new EEPROMStorage()){
  const flash=new Uint8Array(0x42000).fill(255),present=new Uint8Array(0x42000);const c=new XmegaCPU({flash,present},{eeprom:storage});
  const n=new NVMController();n.register(c.bus.mmio,{fault:(m,d)=>c.fault(m,d),clock:()=>c.cycles});const events=[];const m=c.bus.attachEEPROM(n,{onAccess:e=>events.push(e)});return{c,n,m,events,storage};
}
test('CTRLB reset and EEMAPEN readback/toggling require no CCP; attach must be explicit',()=>{
  const {c,n,m}=machine();assert.equal(c.read(0x1cc),0);assert.equal(m.enabled,false);
  for(const value of [8,0,8,8,0]){c.write(0x1cc,value);assert.equal(c.read(0x1cc),value);assert.equal(m.enabled,value===8);}
  assert.equal(c.bus.mmio.handlers.has(0x34),false);assert.throws(()=>c.bus.attachEEPROM(n),/already/);
});
test('all 4096 mapped bytes use exact page/offset data and retain isolation',()=>{
  const {c,storage}=machine(initialized());c.write(0x1cc,8);const ram=Uint8Array.from(c.sram),flash=Uint8Array.from(c.flash),bytes=Uint8Array.from(storage.bytes);
  for(let offset=0;offset<4096;offset++)assert.equal(c.read(0x1000+offset),(Math.floor(offset/32)*19+offset%32*7+3)%256);
  assert.deepEqual(c.sram,ram);assert.deepEqual(c.flash,flash);assert.deepEqual(storage.bytes,bytes);assert.equal(storage.describe().pages,128);assert.equal(storage.describe().pageSizeBytes,32);
});
test('disabled mapping rejects every address even when data is known',()=>{
  const {c}=machine(initialized());for(let offset=0;offset<4096;offset++)assert.throws(()=>c.read(0x1000+offset),e=>e.classification==='UNMAPPED_EEPROM');
  c.write(0x1cc,8);assert.equal(c.read(0x1000),3);c.write(0x1cc,0);assert.throws(()=>c.read(0x1fff),e=>e.classification==='UNMAPPED_EEPROM');
});
test('unknown bytes always fail; partial validity and provenance never become inferred data',()=>{
  const {c,storage,events}=machine();assert.equal(storage.describe().knownBytes,0);c.write(0x1cc,8);
  for(let offset=0;offset<4096;offset++)assert.throws(()=>c.read(0x1000+offset),e=>e.classification==='UNKNOWN_EEPROM_DATA'&&e.addressByte===0x1000+offset);
  assert.equal(c.cycles,0);assert.ok(events.every(e=>!e.completed&&e.provenance.kind==='unknown'));
  const valid=new Uint8Array(4096);valid[0]=1;valid[4095]=1;
  const partial=new EEPROMStorage({bytes:pattern(),valid,provenance:{kind:'synthetic',label:'Two known boundary bytes'}});
  const x=machine(partial);x.c.write(0x1cc,8);assert.equal(x.c.read(0x1000),3);assert.equal(x.c.read(0x1fff),pattern()[4095]);assert.throws(()=>x.c.read(0x1001),e=>e.classification==='UNKNOWN_EEPROM_DATA');
  valid.fill(1);assert.equal(partial.describe().knownBytes,2);
});
test('storage rejects wrong capacity, invalid provenance and validity; explicit local image is copied',()=>{
  for(const size of [0,4095,4097])assert.throws(()=>new EEPROMStorage({bytes:new Uint8Array(size),provenance:{kind:'local-dump',label:'fixture.bin'}}));
  assert.throws(()=>new EEPROMStorage({bytes:pattern()}));assert.throws(()=>new EEPROMStorage({bytes:pattern(),valid:new Uint8Array(4096).fill(2),provenance:{kind:'synthetic',label:'bad'}}));
  const input=pattern(),s=new EEPROMStorage({bytes:input,provenance:{kind:'local-dump',label:'locally supplied fixture.bin',sha256:'test metadata'}});input.fill(0);
  assert.equal(s.read(0),3);assert.equal(s.describe().knownBytes,4096);assert.equal(s.provenance.kind,'local-dump');for(const a of [-1,4096,1.5])assert.throws(()=>s.read(a));
});
test('mapped boundaries never alias MMIO, SRAM, flash or invalid addresses',()=>{
  const {c,m}=machine(initialized());c.write(0x1cc,8);
  assert.throws(()=>c.read(0xfff),e=>e.classification==='UNHANDLED_MMIO');assert.equal(c.read(0x2000),0xa5);assert.equal(c.read(0x1fff),pattern()[4095]);
  c.write(0x2000,0x42);assert.equal(c.read(0x2000),0x42);assert.equal(c.read(0x1000),3);
  assert.throws(()=>c.read(0x6000),e=>e.classification==='INVALID_DATA_ADDRESS');assert.throws(()=>m.read(0x2000),e=>e.classification==='INVALID_EEPROM_ADDRESS');
});
test('reserved/protected/power bits reject atomically; command execution remains unsupported',()=>{
  const {c,n}=machine();c.write(0x1cc,8);
  for(let value=1;value<256;value++)if(value!==8){assert.throws(()=>c.write(0x1cc,value),e=>e.classification==='NVM_CONTROL_UNSUPPORTED');assert.equal(c.read(0x1cc),8);}
  for(const command of [6,0x30,0x32,0x33,0x34,0x35,0x36])assert.throws(()=>c.write(0x1ca,command),e=>e.classification==='NVM_UNSUPPORTED_COMMAND');
  assert.throws(()=>c.write(0x1cb,1),e=>e.classification==='NVM_COMMAND_EXECUTION_UNSUPPORTED');assert.throws(()=>c.write(0x1c4,0xaa),e=>e.classification==='NVM_DATA0_MAPPED_UNSUPPORTED');assert.equal(n.activity.status,0);
});
test('all mapped stores reject page-buffer loading without changing persistent data or validity',()=>{
  const {c,n,storage}=machine(initialized());c.write(0x1cc,8);const bytes=Uint8Array.from(storage.bytes),valid=Uint8Array.from(storage.valid);
  for(let offset=0;offset<4096;offset++)assert.throws(()=>c.write(0x1000+offset,offset%256),e=>e.classification==='EEPROM_PAGE_BUFFER_UNSUPPORTED');
  assert.deepEqual(storage.bytes,bytes);assert.deepEqual(storage.valid,valid);assert.equal(n.activity.eepromLoaded,false);assert.equal(n.activity.pending,null);
});
test('busy NVM and pending command dependencies fail before mapped data access',()=>{
  for(const kind of ['flash','eeprom','lockbits']){
    const {c,n,storage}=machine(initialized());c.write(0x1cc,8);n.activity.begin(kind,10);
    assert.throws(()=>c.read(0x1000),e=>e.classification==='EEPROM_NVM_BUSY');assert.throws(()=>c.write(0x1000,0),e=>e.classification==='EEPROM_NVM_BUSY');
    assert.throws(()=>c.write(0x1cc,0),e=>e.classification==='NVM_BUSY_ACCESS_UNSUPPORTED');assert.throws(()=>n.reset(),e=>e.classification==='NVM_RESET_DURING_OPERATION_UNSUPPORTED');
    c.cycles=10;assert.equal(c.read(0x1000),3);assert.equal(storage.read(0),3);
  }
  const {c,n}=machine(initialized());c.write(0x1cc,8);n.registers[10]=6; // Explicit unsupported-state fixture; not command execution.
  assert.throws(()=>c.read(0x1000),e=>e.classification==='EEPROM_COMMAND_UNSUPPORTED');
});
test('controller reset and fresh CPU reset preserve shared EEPROM and provenance, disable mapping',()=>{
  const storage=initialized(),{c,n,m}=machine(storage);c.write(0x1cc,8);n.reset();assert.equal(m.enabled,false);assert.equal(c.read(0x1cc),0);
  const fresh=machine(storage);assert.equal(fresh.c.pc,0);assert.equal(fresh.c.steps,0);assert.equal(fresh.c.cycles,0);assert.equal(fresh.m.enabled,false);assert.equal(fresh.c.sp,0x5fff);
  fresh.c.write(0x1cc,8);for(let i=0;i<4096;i++)assert.equal(fresh.c.read(0x1000+i),pattern()[i]);assert.equal(storage.describe().knownBytes,4096);
  const unknown=new EEPROMStorage();assert.equal(machine(unknown).storage.describe().knownBytes,0);assert.equal(machine(unknown).storage.describe().knownBytes,0);
});
test('mapped LDS/LDD timing adds one bus wait cycle without CPU opcode changes; replay is deterministic',()=>{
  function run(){const {c,n,events}=machine(initialized());c.write(0x1cc,8);const words=[0x9100,0x1000,0x8111];
    words.forEach((w,i)=>{c.flash[2*i]=w&255;c.flash[2*i+1]=w>>>8;});c.present.fill(1,0,6);c.setPair(30,0x1000);const a=c.step(),b=c.step();
    assert.equal(a.after.cycles,3);assert.equal(b.after.cycles,7);assert.equal(c.r[16],3);assert.equal(c.r[17],10);assert.equal(a.accesses.at(-1).waitCycles,1);assert.equal(b.accesses.at(-1).space,'eeprom');
    return {a,b,events,state:n.snapshot()};}
  assert.deepEqual(run(),run());
});
test('MOVW diagnostics decode all register pairs without changing CPU state before execution',()=>{
  const {c}=machine();c.present.fill(1,0,2);c.flash[1]=1;
  for(let d=0;d<32;d+=2)for(let r=0;r<32;r+=2){
    c.flash[0]=16*(d/2)+r/2;const before=c.state(),decoded=decodeAt(c);
    assert.equal(decoded.mnemonic,'MOVW');assert.deepEqual(decoded.operands,{destinationLowRegister:d,sourceLowRegister:r});assert.deepEqual(c.state(),before);
  }
  // The original trap assertion runs verbatim with the archived PoC 002G suite.
  c.flash[0]=0xfc;
  c.r[24]=0x6d;
  c.r[25]=0xb2;
  const before=c.state();
  const result=discover(c);
  assert.deepEqual(result.lastCompletedInstruction,{pcWord:0,opcode:0x01fc,mnemonic:'MOVW'});
  assert.equal(result.firstBlockingEvent.classification,'FLASH_HOLE');
  assert.equal(result.firstBlockingEvent.pcWord,1);
  const registers=before.registers.slice();
  registers[30]=0x6d;
  registers[31]=0xb2;
  assert.deepEqual(c.state(),{...before,pcWord:1,cycles:1,registers});
  assert.equal(result.completedInstructions,1);
});
