import test from 'node:test';
import assert from 'node:assert/strict';
import {XmegaCPU,instructionWords} from '../src/xmega.mjs';
import {decodeAt,discover} from '../src/discovery.mjs';
// Manual bit-string encoders and width patterns are independent of production masks.
function encode(name,operand,bit) {
  const r=operand.toString(2).padStart(5,'0'),b=bit.toString(2).padStart(3,'0');
  return parseInt(({SBRC:`1111110${r}0${b}`,SBRS:`1111111${r}0${b}`,SBIC:`10011001${r}${b}`,SBIS:`10011011${r}${b}`})[name],2);
}
function make(){return new XmegaCPU({flash:new Uint8Array(0x42000).fill(255),present:new Uint8Array(0x42000)});}
function put(c,pc,words){for(const [i,w] of words.entries()){c.flash[(pc+i)*2]=w&255;c.flash[(pc+i)*2+1]=w>>>8;c.present.fill(1,(pc+i)*2,(pc+i)*2+2);}}
function prepare(c,op,next=0xffff,second=0xffff){put(c,0,[op,next,second,0]);c.pc=0;c.cycles=0;c.steps=0;c.r.fill(0xa5);c.sreg=0xd7;c.sp=0x5fff;c.rampz=2;c.eind=1;}
test('all 65536 instruction words independently classify the four two-word families',()=>{
  const patterns=[/^1001010[01]{5}110[01]$/,/^1001010[01]{5}111[01]$/,/^1001000[01]{5}0000$/,/^1001001[01]{5}0000$/];
  let count=0;
  for(let op=0;op<=0xffff;op++){const expected=patterns.some(p=>p.test(op.toString(2).padStart(16,'0')))?2:1;assert.equal(instructionWords(op),expected);count+=expected===2;}
  assert.equal(count,192);
  for(const op of [-1,65536,NaN,1.5])assert.throws(()=>instructionWords(op));
});
test('SBRC/SBRS: every register, bit and byte value, both following widths and outcomes',()=>{
  const c=make();assert.equal(encode('SBRC',19,7),0xfd37);
  for(const name of ['SBRC','SBRS'])for(let r=0;r<32;r++)for(let bit=0;bit<8;bit++)for(let value=0;value<256;value++)for(const [next,width] of [[0xffff,1],[0x940e,2]]){
    prepare(c,encode(name,r,bit),next);c.r[r]=value;const registers=Uint8Array.from(c.r);
    const taken=name==='SBRC'?Math.floor(value/2**bit)%2===0:Math.floor(value/2**bit)%2===1;
    const t=c.step();assert.equal(t.mnemonic,name);assert.equal(c.pc,taken?1+width:1);assert.equal(c.cycles,taken?1+width:1);
    assert.equal(c.steps,1);assert.deepEqual(c.r,registers);assert.equal(c.sreg,0xd7);assert.equal(c.sp,0x5fff);assert.equal(c.rampz,2);assert.equal(c.eind,1);
    assert.equal(t.skip.taken,taken);assert.equal(t.skip.skippedWords,taken?width:0);
    assert.equal(t.accesses.length,taken?2+2*width:2);assert.ok(t.accesses.every(a=>a.kind==='fetch'));
  }
});
test('SBIC/SBIS: all 32 I/O addresses, bits and values; one bus read; AVRxm 2/3/4 cycles',()=>{
  const c=make();let value=0,reads=[];for(let address=0;address<32;address++)c.mapMMIO(address,{read:()=>{reads.push(address);return value;}});
  for(const name of ['SBIC','SBIS'])for(let address=0;address<32;address++)for(let bit=0;bit<8;bit++)for(value=0;value<256;value++)for(const [next,width] of [[0xffff,1],[0x9200,2]]){
    prepare(c,encode(name,address,bit),next);reads=[];const registers=Uint8Array.from(c.r);
    const taken=name==='SBIC'?Math.floor(value/2**bit)%2===0:Math.floor(value/2**bit)%2===1;
    const t=c.step();assert.deepEqual(reads,[address]);assert.equal(c.pc,taken?1+width:1);assert.equal(c.cycles,taken?2+width:2);
    assert.deepEqual(c.r,registers);assert.equal(c.sreg,0xd7);assert.equal(c.sp,0x5fff);
    assert.equal(t.accesses.filter(a=>a.kind==='read').length,1);assert.equal(t.accesses[2].addressByte,address);
  }
});
test('all SREG values survive each skip family and each outcome/width',()=>{
  const c=make();let value=0;c.mapMMIO(7,{read:()=>value});
  for(const name of ['SBRC','SBRS','SBIC','SBIS'])for(let flags=0;flags<256;flags++)for(const v of [0,255])for(const next of [0xffff,0x9000]){
    prepare(c,encode(name,7,3),next);c.sreg=flags;c.r[7]=v;value=v;c.step();assert.equal(c.sreg,flags);
  }
});
test('skipped JMP/CALL/LDS/STS and unsupported instructions have no execution side effects',()=>{
  const c=make();let sideEffects=0;c.mapMMIO(0x600,{read:()=>{sideEffects++;return 1;},write:()=>sideEffects++});
  for(const next of [0x940c,0x941f,0x9000,0x9200,0xffff,0x9508,0xfd37]){
    prepare(c,0xfc00,next,0x600);c.r[0]=0;const ram=Uint8Array.from(c.sram),regs=Uint8Array.from(c.r);
    const t=c.step();assert.equal(sideEffects,0);assert.deepEqual(c.sram,ram);assert.deepEqual(c.r,regs);assert.equal(c.sp,0x5fff);assert.equal(c.steps,1);
    assert.ok(!t.accesses.some(a=>a.kind==='write'));
  }
  prepare(c,0xfc00,0xffff);c.r[0]=1;c.step();assert.throws(()=>c.step(),/Unsupported instruction/);
});
test('missing current/skipped instruction bytes trap without retiring; untaken skip does not prefetch',()=>{
  for(const missing of [0,1,2,3,4,5]){
    const c=make();prepare(c,0xfc00,0x940c,0);c.r[0]=0;c.present[missing]=0;const before=c.state();
    assert.throws(()=>c.step(),e=>e.classification==='FLASH_HOLE'&&e.addressByte===missing&&e.trace.eventType==='diagnostic');
    assert.deepEqual(c.state(),before);assert.equal(c.steps,0);
  }
  const c=make();prepare(c,0xfc00);c.r[0]=1;c.present.fill(0,2);c.step();assert.equal(c.pc,1);assert.equal(c.cycles,1);
  assert.throws(()=>c.step(),e=>e.classification==='FLASH_HOLE');
});
test('flash end boundaries distinguish missing operands and out-of-device control flow',()=>{
  const end=0x21000;
  for(const [pc,words,reason] of [[end-1,[0xfc00],'INVALID_FLASH_ADDRESS'],[end-2,[0xfc00,0x940c],'INVALID_FLASH_ADDRESS'],[end-2,[0xfc00,0xffff],'target']]){
    const c=make();put(c,pc,words);c.pc=pc;
    assert.throws(()=>c.step(),e=>reason==='target'?/PC target outside/.test(e.message):e.classification===reason);assert.equal(c.pc,pc);assert.equal(c.steps,0);assert.equal(c.cycles,0);
  }
  const c=make();put(c,end-4,[0xfc00,0x940e,0xffff,0]);c.pc=end-4;c.step();assert.equal(c.pc,end-1);assert.equal(c.cycles,3);assert.equal(c.sp,0x5fff);
});
test('I/O faults retain exact instruction and address; no register-file or classic AVR offset alias',()=>{
  for(const name of ['SBIC','SBIS'])for(let a=0;a<32;a++){
    const c=make();prepare(c,encode(name,a,7));const before=c.state();
    assert.throws(()=>c.step(),e=>e.classification==='UNHANDLED_MMIO'&&e.addressByte===a&&e.accessKind==='read'&&e.opcode===encode(name,a,7));assert.deepEqual(c.state(),before);
  }
  const c=make();prepare(c,encode('SBIC',0,0));c.mapMMIO(0,{read:()=>300});assert.throws(()=>c.step(),e=>e.classification==='INVALID_MMIO_VALUE');
});
test('diagnostic operands and repeated traces are deterministic; skipped calls create no frames',()=>{
  function run(){const c=make();put(c,0,[0xfd37,0x940e,0xffff,0xffff]);c.r[19]=0;const trace=[];const d=decodeAt(c);assert.deepEqual(d.operands,{bit:7,register:19,value:0});
    const result=discover(c,{onTrace:t=>trace.push(t)});assert.equal(result.completedInstructions,1);assert.equal(result.cycles,3);assert.equal(result.lastPcWord,3);
    assert.equal(result.callStack.length,0);assert.equal(result.recentControlFlow[0].mnemonic,'SBRC');assert.equal(trace[1].eventType,'diagnostic');return{result,trace};}
  assert.deepEqual(run(),run());
});
