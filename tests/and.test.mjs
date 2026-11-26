import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

function machine() {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({flash,present:new Uint8Array(flash.length)});
}

function loadAnd(cpu,d,r,pc=0) {
  const bits = (n,width) => n.toString(2).padStart(width,'0');
  const source=bits(r,5), word=Number.parseInt('001000'+source[0]+bits(d,5)+source.slice(1),2);
  cpu.pc=pc;
  cpu.flash.set([word & 255,word >>> 8],pc*2);
  cpu.present.fill(1,pc*2,pc*2+2);
  return word;
}

test('AND disassembles and executes all 1024 register pairs including the TST alias in one clock', () => {
  const cpu=machine(), initial=Uint8Array.from({length:32},(_,i)=>(i*77+121)&255);
  for (let d=0; d<32; d++) for (let r=0; r<32; r++) {
    cpu.r.set(initial);
    const word=loadAnd(cpu,d,r), start=cpu.cycles;
    assert.deepEqual(decodeAt(cpu).operands,{destinationRegister:d,sourceRegister:r});
    assert.equal(decodeAt(cpu).mnemonic,'AND');
    const expected=Array.from(initial);
    expected[d]=initial[d] & initial[r];
    const t=cpu.step();
    assert.deepEqual([t.mnemonic,t.opcode,t.after.pcWord,t.after.cycles],['AND',word,1,start+1]);
    assert.deepEqual(t.after.registers,expected);
    assert.deepEqual(t.accesses.map(a=>[a.kind,a.space,a.addressByte]),[['fetch','flash',0],['fetch','flash',1]]);
  }
  assert.equal(loadAnd(cpu,18,18),0x2322);
});

test('AND updates Z N V S independently of carry and preserves I T H C for all operand bytes', () => {
  const cpu=machine();
  loadAnd(cpu,1,25);
  const check=(left,right,flags)=>{
    cpu.pc=0; cpu.r[1]=left; cpu.r[25]=right; cpu.sreg=flags;
    cpu.step();
    const result=left & right;
    assert.equal(cpu.r[1],result);
    assert.equal(cpu.r[25],right);
    assert.equal(cpu.sreg,(flags & 0xe1) | (result===0 ? 2 : result>=128 ? 0x14 : 0));
  };
  for (let a=0;a<256;a++) for (let b=0;b<256;b++) check(a,b,(a+b)&255);
  for (let flags=0;flags<256;flags++) {check(0xaa,0x55,flags); check(0xff,0x81,flags); check(0x0f,1,flags);}
});

test('AND at an invalid fall-through leaves registers flags and counters untouched', () => {
  const cpu=machine();
  loadAnd(cpu,18,18,cpu.flash.length/2-1);
  cpu.r[18]=1; cpu.sreg=0xff;
  const before=cpu.state();
  assert.throws(()=>cpu.step(),/PC target outside device/);
  assert.deepEqual(cpu.state(),before);
  assert.equal(cpu.steps,0);
});
