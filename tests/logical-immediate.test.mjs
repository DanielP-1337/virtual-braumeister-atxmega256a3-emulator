import test from 'node:test';
import assert from 'node:assert/strict';
import {XmegaCPU} from '../src/xmega.mjs';
import {decodeAt,discover} from '../src/discovery.mjs';
import {NVMController} from '../src/peripherals/nvm.mjs';
function encode(name,r,k){const bits=k.toString(2).padStart(8,'0');return parseInt((name==='ORI'?'0110':'0111')+bits.slice(0,4)+(r-16).toString(2).padStart(4,'0')+bits.slice(4),2);}
// Boolean truth tables per bit, with arithmetic reconstruction; no bitwise CPU formulas.
function expected(name,a,k){let result=0;for(let bit=0;bit<8;bit++){const x=Math.floor(a/2**bit)%2===1,y=Math.floor(k/2**bit)%2===1;if(name==='ORI'?(x||y):(x&&y))result+=2**bit;}return result;}
function flags(before,result){const b=before.toString(2).padStart(8,'0').split('');b[3]=result>=128?'1':'0';b[4]='0';b[5]=b[3];b[6]=result===0?'1':'0';return parseInt(b.join(''),2);}
function cpu(){const flash=new Uint8Array(0x42000).fill(255),present=new Uint8Array(0x42000);present.fill(1,0,4);return new XmegaCPU({flash,present});}
function prepare(c,op){c.flash[0]=op%256;c.flash[1]=Math.floor(op/256);c.pc=0;c.steps=0;c.cycles=0;c.r.fill(0xa6);c.sreg=0xff;c.sp=0x5fff;c.rampz=2;c.eind=1;}
test('all 8192 ORI/ANDI encodings decode complete immediates and R16-R31 independently',()=>{
  const c=cpu();assert.equal(encode('ORI',19,8),0x6038);assert.equal(encode('ANDI',31,255),0x7fff);
  for(const name of ['ORI','ANDI'])for(let r=16;r<32;r++)for(let k=0;k<256;k++){
    prepare(c,encode(name,r,k));const d=decodeAt(c);assert.equal(d.mnemonic,name);assert.deepEqual(d.operands,{register:r,immediate:k});assert.equal(c.accesses.length,0);
  }
});
test('all register, immediate and initial-byte combinations: result, flags, isolation and timing',()=>{
  const c=cpu();
  for(const name of ['ORI','ANDI']){
    const table=Array.from({length:256},(_,a)=>Array.from({length:256},(_,k)=>expected(name,a,k)));
    for(let r=16;r<32;r++)for(let k=0;k<256;k++)for(let a=0;a<256;a++){
      prepare(c,encode(name,r,k));c.r[r]=a;const want=Uint8Array.from(c.r);want[r]=table[a][k];
      const t=c.step();assert.deepEqual(c.r,want);assert.equal(c.sreg,flags(255,want[r]));assert.equal(c.pc,1);assert.equal(c.cycles,1);assert.equal(c.steps,1);
      assert.equal(c.sp,0x5fff);assert.equal(c.rampz,2);assert.equal(c.eind,1);assert.equal(t.mnemonic,name);assert.equal(t.accesses.length,2);assert.ok(t.accesses.every(x=>x.kind==='fetch'));
    }
  }
});
test('all 256 incoming SREG states crossed with every result byte for each instruction',()=>{
  const c=cpu();for(const name of ['ORI','ANDI'])for(let f=0;f<256;f++)for(let result=0;result<256;result++){
    prepare(c,encode(name,31,result));c.r[31]=name==='ORI'?0:255;c.sreg=f;c.step();assert.equal(c.r[31],result);assert.equal(c.sreg,flags(f,result));
  }
});
test('boundary values and deterministic multi-instruction replay preserve memory and strict faults',()=>{
  function run(){const c=cpu();const words=[0x6038,0x7f30,0x6f3f,0x7030,0xffff];c.present.fill(1,0,10);words.forEach((w,i)=>{c.flash[i*2]=w%256;c.flash[i*2+1]=Math.floor(w/256);});
    const ram=Uint8Array.from(c.sram),rom=Uint8Array.from(c.flash),ee=Uint8Array.from(c.eeprom),traces=[];
    const r=discover(c,{onTrace:t=>traces.push(t)});assert.deepEqual(traces.slice(0,4).map(t=>t.after.registers[19]),[8,0,255,0]);
    assert.equal(r.completedInstructions,4);assert.equal(r.cycles,4);assert.equal(r.firstBlockingEvent.classification,'UNSUPPORTED_OPCODE');assert.equal(r.firstBlockingEvent.opcode,0xffff);
    assert.deepEqual(c.sram,ram);assert.deepEqual(c.flash,rom);assert.deepEqual(c.eeprom,ee);return{r,traces};}
  assert.deepEqual(run(),run());
  const c=cpu();prepare(c,0x6038);c.present[1]=0;assert.throws(()=>c.step(),e=>e.classification==='FLASH_HOLE');assert.equal(c.steps,0);
});
test('discovery inventories explicit peripheral rejection separately from completed MMIO',()=>{
  const c=cpu();prepare(c,0x8734);c.setPair(30,0x1c0);c.r[19]=8;
  new NVMController().register(c.bus.mmio,{fault:(m,d)=>c.fault(m,d),clock:()=>c.cycles});
  const r=discover(c);assert.equal(r.firstBlockingEvent.classification,'NVM_CONTROL_UNSUPPORTED');
  assert.deepEqual(r.firstBlockingEvent.memoryAccess,{addressByte:0x1cc,kind:'write',attemptedValue:8});
  assert.deepEqual(r.mmioInventory.map(x=>[x.addressByte,x.kind,x.completed,x.values]),[[0x1cc,'write',false,[8]]]);assert.equal(r.completedInstructions,0);
});
