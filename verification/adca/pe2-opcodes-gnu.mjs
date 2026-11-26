import assert from 'node:assert/strict';
import { XmegaCPU } from '../../src/xmega.mjs';
import { decodeAt } from '../../src/discovery.mjs';
import { runAvrProbe } from '../gnu-avr-probe.mjs';

const [mode,bin]=process.argv.slice(2);
assert.ok(bin && ['and','st-z-postincrement'].includes(mode),'Expected opcode family and AVR GNU bin directory');
const isAnd=mode==='and';
const cases=isAnd ? [
  {a:1,b:1,flags:0xa0,same:true},{a:0x80,b:0xc1,flags:0x6b},{a:0x55,b:0xaa,flags:0xff},
  {a:0x7f,b:0xff,flags:0x13},{a:0,b:0,flags:0xe1,same:true},
] : [{address:0x4197,value:0,flags:0xa0},{address:0x21ff,value:0x5a,flags:0xff},{address:0x2200,value:0xf3,flags:0x17}];
const asm=['.text','.global _start','_start:'],gdb=[],sequences=[];
for (const [i,c] of cases.entries()) {
  const instructions=isAnd ? [`ldi r18,${c.a}`,`ldi r25,${c.b}`,`ldi r21,${c.flags}`,'out 0x3f,r21',
    c.same?'tst r18':'and r18,r25','in r20,0x3f'] :
    [`ldi r30,${c.address&255}`,`ldi r31,${c.address>>>8}`,`ldi r25,${c.value}`,`ldi r21,${c.flags}`,
      'out 0x3f,r21','st Z+,r25',`lds r18,${c.address}`,'in r20,0x3f'];
  asm.push(...instructions,'nop');
  const regs=isAnd?['r18','r25','r20']:['r18','r25','r20','r30','r31'];
  gdb.push('stepi '+instructions.length,'printf "OBS '+i+' '+regs.map(()=>'%u').join(' ')+'\\n", '+regs.map(r=>'($'+r+' & 255)').join(', '),'stepi');
  sequences.push(instructions.length);
}
asm.push('break');
if (isAnd) {
  for (let d=0;d<32;d++) for(let r=0;r<32;r++) asm.push(`and r${d},r${r}`);
} else {
  for (let r=0;r<32;r++) asm.push(`st Z+,r${r}`);
}
const {bytes,output,assembler,simulator}=runAvrProbe(bin,mode,asm,gdb);
const observations=[...output.matchAll(/^OBS ([\d ]+)\r?$/gm)].map(m=>m[1].trim().split(/ +/).map(Number));
assert.equal(observations.length,cases.length,output);
const flash=new Uint8Array(0x42000),present=new Uint8Array(flash.length);
flash.set(bytes);present.fill(1,0,bytes.length);
const cpu=new XmegaCPU({flash,present});
for(const [i,c] of cases.entries()) {
  for(let j=0;j<sequences[i];j++) cpu.step();
  const result=c.a & (c.same?c.a:c.b);
  const expected=isAnd?[i,result,c.b,(c.flags & 0xe1) | (result===0?2:result>=128?0x14:0)] :
    [i,c.value,c.value,c.flags,(c.address+1)&255,(c.address+1)>>>8];
  assert.deepEqual(observations[i],expected);
  assert.deepEqual([i,cpu.r[18],cpu.r[25],cpu.r[20],...(isAnd?[]:[cpu.r[30],cpu.r[31]])],expected);
  cpu.step();
}
let table=cpu.pc+1; // Skip BREAK after the observations.
const encodings=isAnd?1024:32;
for(let i=0;i<encodings;i++,table++) {
  const d=decodeAt(cpu,table), r=i%32;
  assert.equal(d.mnemonic,isAnd?'AND':'ST Z+');
  if(isAnd) assert.deepEqual(d.operands,{destinationRegister:i>>>5,sourceRegister:r});
  else assert.deepEqual([d.operands.register,d.operands.pointer,d.operands.postIncrement],[r,'Z',true]);
}
console.log(JSON.stringify({status:'PASS',mode,assembler,simulator,encodings,observations},null,2));
