import assert from 'node:assert/strict';
import { XmegaCPU } from '../../src/xmega.mjs';
import { decodeAt } from '../../src/discovery.mjs';
import { runAvrProbe } from '../gnu-avr-probe.mjs';

const bin=process.argv[2];
assert.ok(bin,'Expected the AVR GNU bin directory');
const cases=[[0x65,0xec,0x03],[0,1,0xff],[0x80,1,0xc0],[0x7f,0xff,0x40],[0,0,0],[0x34,0x34,1]];
const asm=['.text','.global _start','_start:'],gdb=[];
for (const [i,[a,b,flags]] of cases.entries()) {
  asm.push('ldi r18,'+a,'mov r14,r18','ldi r24,'+b,'ldi r20,'+flags,'out 0x3f,r20',
    'sub r14,r24','in r21,0x3f','nop');
  gdb.push('stepi 7','printf "SUB '+i+' %u %u %u\\n", $r14, $r24, $r21','stepi');
}
asm.push('break');
for (let d=0;d<32;d++) for (let r=0;r<32;r++) asm.push('sub r'+d+',r'+r);
const {bytes,output,assembler,simulator}=runAvrProbe(bin,'sub',asm,gdb);
const observations=Array.from(output.matchAll(/^SUB ([\d ]+)\r?$/gm),m=>m[1].trim().split(/ +/).map(Number));
assert.equal(observations.length,cases.length);
const flash=new Uint8Array(0x42000),present=new Uint8Array(flash.length);
flash.set(bytes);present.fill(1,0,bytes.length);
const cpu=new XmegaCPU({flash,present});
for (const [i] of cases.entries()) {
  for (let j=0;j<7;j++) cpu.step();
  assert.deepEqual([i,cpu.r[14],cpu.r[24],cpu.r[21]],observations[i]);
  cpu.step();
}
let pc=cpu.pc+1;
for (let d=0;d<32;d++) for (let r=0;r<32;r++) {
  const decoded=decodeAt(cpu,pc++);
  assert.deepEqual([decoded.mnemonic,decoded.operands],['SUB',{destinationRegister:d,sourceRegister:r}]);
}
console.log(JSON.stringify({status:'PASS',assembler,simulator,encodings:1024,cases,observations},null,2));
