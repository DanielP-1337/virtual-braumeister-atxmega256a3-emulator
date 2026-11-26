import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt, discover } from '../src/discovery.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
// Independent encoder transcribes the manual's bit strings, not the CPU decoder.
function encode(pointer, store, register, displacement) {
  const q = displacement.toString(2).padStart(6, '0');
  const r = register.toString(2).padStart(5, '0');
  return parseInt(`10${q[0]}0${q.slice(1,3)}${+store}${r}${+(pointer === 'Y')}${q.slice(3)}`, 2);
}
function cpu() {
  const flash = new Uint8Array(0x42000).fill(255), present = new Uint8Array(0x42000);
  present.fill(1, 0, 4); return new XmegaCPU({ flash, present });
}
function prepare(c, op, pair, base) {
  c.flash[0] = op & 255; c.flash[1] = op >>> 8;
  c.pc = 0; c.cycles = 0; c.steps = 0; c.r.fill(0x59);
  c.setPair(28, 0x4100); c.setPair(30, 0x4200); c.setPair(pair, base);
  c.sreg = 0xa5; c.rampz = 2; c.eind = 3;
}
test('independent encoding anchors and exhaustive decode: all 8192 encodings', () => {
  assert.equal(encode('Z', false, 19, 15), 0x8537);
  assert.equal(encode('Z', true, 19, 15), 0x8737);
  assert.equal(encode('Y', false, 31, 63), 0xadff);
  const c = cpu(), seen = new Set();
  for (const p of ['Y','Z']) for (const store of [false,true]) for (let r=0;r<32;r++) for (let q=0;q<64;q++) {
    const op = encode(p,store,r,q); seen.add(op); prepare(c,op,p==='Y'?28:30,0x2100);
    const d = decodeAt(c); assert.equal(d.opcode,op);
    assert.deepEqual(d.operands, {register:r,pointer:p,displacement:q,baseAddressByte:0x2100,addressByte:0x2100+q,...(store?{value:c.r[r]}:{})});
    assert.equal(d.mnemonic, store?(q?'STD':'ST'):(q?'LDD':'LD'));
  }
  assert.equal(seen.size,8192);
});
test('all displacements, registers and Y/Z load/store forms execute with exact SRAM timing', () => {
  const c=cpu();
  for(const p of ['Y','Z']) for(const store of [false,true]) for(let r=0;r<32;r++) for(let q=0;q<64;q++) {
    const pair=p==='Y'?28:30; prepare(c,encode(p,store,r,q),pair,0x2100);
    c.sram.fill(0xcc); c.sram[0x100+q]=(q*13+71)&255;
    const expected=Uint8Array.from(c.r), value=store?c.r[r]:c.sram[0x100+q];
    if(!store) expected[r]=value; const t=c.step();
    assert.deepEqual(c.r,expected); assert.equal(c.sreg,0xa5); assert.equal(c.sp,0x5fff);
    assert.equal(c.rampz,2); assert.equal(c.eind,3); assert.equal(c.pc,1); assert.equal(c.steps,1);
    assert.equal(c.cycles,store?(q?2:1):(q?3:2));
    assert.equal(c.sram[0x100+q],value); assert.equal(c.sram[0xff+q],0xcc);
    assert.deepEqual(t.accesses.at(-1),{kind:store?'write':'read',space:'sram',addressByte:0x2100+q,value});
  }
});
test('every SREG value is preserved by every displacement and direction', () => {
  const c=cpu();
  for(const p of ['Y','Z']) for(const store of [false,true]) for(let q=0;q<64;q++) for(let flags=0;flags<256;flags++) {
    prepare(c,encode(p,store,7,q),p==='Y'?28:30,0x2000); c.sreg=flags; c.step(); assert.equal(c.sreg,flags);
  }
});
test('explicit synthetic MMIO handlers receive exact accesses and AVRxm I/O timing', () => {
  const c=cpu(); let reads=0, writes=[];
  // Test-only address handlers; no NVM handler is installed by the firmware runner.
  for(let a=0x800;a<0x840;a++) c.mapMMIO(a,{read:()=>{reads++;return a&255;},write:v=>writes.push([a,v])});
  for(const p of ['Y','Z']) for(const store of [false,true]) for(let q=0;q<64;q++) {
    prepare(c,encode(p,store,4,q),p==='Y'?28:30,0x800); const t=c.step();
    assert.equal(c.cycles,store?(q?2:1):(q?2:1));
    assert.equal(t.accesses.at(-1).addressByte,0x800+q); assert.equal(t.accesses.at(-1).space,'mmio');
    if(store) assert.deepEqual(writes.at(-1),[0x800+q,0x59]); else assert.equal(c.r[4],q);
  }
  assert.equal(reads,128); assert.equal(writes.length,128);
});
test('SRAM edges and 16-bit displacement carry use the resulting data address', () => {
  const c=cpu(); let wrapped=0; c.mapMMIO(0,{read:()=>0x81,write:v=>wrapped=v});
  for(const p of ['Y','Z']) for(const store of [false,true]) for(const [base,q,address] of [[0x1fff,1,0x2000],[0x5fc0,63,0x5fff],[0xffff,1,0]]) {
    prepare(c,encode(p,store,4,q),p==='Y'?28:30,base); const t=c.step();
    assert.equal(t.accesses.at(-1).addressByte,address); assert.equal(c.pair(p==='Y'?28:30),base);
    if(address===0) assert.equal(store?wrapped:c.r[4],store?0x59:0x81);
  }
});
test('invalid data, unmapped EEPROM, unknown MMIO, invalid handler values fail without retirement', () => {
  const c=cpu(); c.mapMMIO(0x800,{read:()=>256});
  for(const p of ['Y','Z']) for(const store of [false,true]) for(const [base,q,classification] of [[0x5fff,1,'INVALID_DATA_ADDRESS'],[0xffc0,63,'INVALID_DATA_ADDRESS'],[0xfff,1,'UNMAPPED_EEPROM'],[0x1c0,15,'UNHANDLED_MMIO']]) {
    prepare(c,encode(p,store,4,q),p==='Y'?28:30,base); const before=c.state();
    assert.throws(()=>c.step(),e=>e.classification===classification && e.addressByte===base+q && e.trace.eventType==='diagnostic');
    assert.deepEqual(c.state(),before); assert.equal(c.steps,0);
  }
  prepare(c,encode('Y',false,4,1),28,0x7ff);
  assert.throws(()=>c.step(),e=>e.classification==='INVALID_MMIO_VALUE');
});
test('displacement accesses honor GPIO aliases and CPU I/O side effects through the bus', () => {
  const c=cpu(); new GPIOController().register(c.bus.mmio,{fault:(m,d)=>c.fault(m,d)});
  prepare(c,encode('Z',true,4,5),30,0x600); c.r[4]=0xa6; c.step(); // OUTSET
  prepare(c,encode('Y',false,4,4),28,0x600); c.step(); assert.equal(c.r[4],0xa6);
  prepare(c,encode('Y',true,4,1),28,0x3e); c.r[4]=0x72; c.step(); assert.equal(c.sreg,0x72);
  prepare(c,encode('Z',false,4,1),30,0x3e); c.sreg=0x72; c.step(); assert.equal(c.r[4],0x72);
});
test('nearby pre/postincrement encodings remain unsupported; failed NVM read has decoded operands', () => {
  const c=cpu();
  prepare(c,0x9001,30,0x2000);
  c.sram[0] = 0xa7;
  c.step();
  assert.deepEqual([c.r[0],c.pair(30),c.cycles],[0xa7,0x2001,2]);
  prepare(c,0x9201,30,0x2000); c.r[0]=0x73;
  assert.equal(c.step().mnemonic,'ST Z+');
  assert.deepEqual([c.sram[0],c.pair(30)],[0x73,0x2001]);
  for(const op of [0x9002,0x9009,0x900a,0x9202,0x9209,0x920a]) {
    prepare(c,op,30,0x2000); assert.throws(()=>c.step(),/Unsupported instruction/);
  }
  prepare(c,0x8537,30,0x1c0); const r=discover(c);
  assert.equal(r.firstBlockingEvent.classification,'UNHANDLED_MMIO');
  assert.equal(r.firstBlockingEvent.operands.addressByte,0x1cf);
  assert.equal(r.firstBlockingEvent.operands.register,19);
  assert.equal(r.firstBlockingEvent.operands.displacement,15);
  assert.equal(r.firstBlockingEvent.memoryAccess.kind,'read');
  assert.equal(r.cycles,0); assert.equal(r.completedInstructions,0);
  assert.equal(r.mmioInventory[0].completed,false); assert.deepEqual(r.mmioInventory[0].values,[]);
});
