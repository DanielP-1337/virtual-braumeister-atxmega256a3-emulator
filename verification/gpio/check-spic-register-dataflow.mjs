import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { spicRegisterDataflow } from './spic-register-dataflow.mjs';
import { json } from '../usartf0/trace-evidence.mjs';

const [directory='private/portf-cont-18-low-low-low'] = process.argv.slice(2);
const source=json(directory,'result.json'), monitor=spicRegisterDataflow();
let frame=0;
for await (const line of createInterface({input:createReadStream(join(directory,'trace-suffix.jsonl')),crlfDelay:Infinity})) {
  if (!line) continue;
  const t=JSON.parse(line);
  if(t.eventType==='diagnostic')continue;
  if(t.accesses.some(a=>a.space==='mmio'&&a.kind==='read'&&a.addressByte===0x08c3))frame++;
  monitor.observe(t,frame);
}
const result=monitor.result();
assert.deepEqual([result.status,result.first.frame,result.last.frame,result.reads,frame,source.spicCompletedTransfers],
  ['PASS',30,32,3,32,33]);
assert.equal(result.remainingRegisters.length,0);
assert.equal(result.variableStores.reduce((n,r)=>n+r.count,0),3);
assert.deepEqual(result.remainingSram.map(r=>r.address),[0x4871,0x4872,0x4873]);
function event(pc,opcode,mnemonic,before,after,accesses=[]) {
  return {eventType:'instruction',opcode,mnemonic,before:{pcWord:pc,cycles:pc,registers:before},after:{cycles:pc+1,registers:after},accesses};
}
const regs=Array(32).fill(0),live=regs.with(24,0x43);
const first=event(0xfd24,0x8183,'LDD',regs,live,[{space:'mmio',kind:'read',addressByte:0x08c3,value:0x43}]);
const store=event(0xfd27,0x938c,'ST X',live,live,[{space:'sram',kind:'write',addressByte:0x4870,value:0x43}]);
for(const [negative,category] of [
  [event(10,0x3080,'CPI',live,live),'variable operand'],
  [event(10,0xb98a,'OUT',live,live,[{space:'mmio',kind:'write',addressByte:10,value:0x43}]),'variable output'],
  [event(10,0x0001,'UNKNOWN',live,live),'unsupported opcode'],
]){
  const m=spicRegisterDataflow();m.observe(first,30);m.observe(negative,30);assert.equal(m.result().failure.category,category);
}
const address=spicRegisterDataflow(),pointer=live.with(26,0x43);
address.observe(first,30);address.observe(event(11,0x2fa8,'MOV',live,pointer),30);
address.observe(event(12,0x921c,'ST X',pointer,pointer,[{space:'sram',kind:'write',addressByte:0x2043,value:0}]),30);
assert.equal(address.result().failure.category,'variable operand');
const saved=spicRegisterDataflow();saved.observe(first,30);saved.observe(store,30);saved.observe(event(13,0xe080,'LDI',live,regs),30);
saved.observe(event(14,0x9508,'RET',regs,regs,[{space:'sram',kind:'read',addressByte:0x4870,value:0x43}]),30);
assert.equal(saved.result().failure.category,'variable address or return');
console.log(JSON.stringify({status:'PASS',firmwareSha256:source.firmwareSha256,from:30,to:32,firmwareTraceSha256:source.traceSha256,
  dynamicReads:result.reads,negativeChecks:5,observedOpcodes:result.opcodes},null,2));
