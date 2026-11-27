import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const word = (d,r) => 0x1800 | (d << 4) | (r & 15) | ((r & 16) << 5);
function machine() {
  const flash=new Uint8Array(0x42000), present=new Uint8Array(flash.length);
  present.fill(1,0,4);
  return new XmegaCPU({flash,present});
}
function put(cpu,opcode) {
  cpu.flash[0]=opcode & 255;
  cpu.flash[1]=opcode >>> 8;
  cpu.pc=0;
}
const signed = x => x < 128 ? x : x-256;
function expectedFlags(a,b,old) {
  const result=(a-b)&255, difference=signed(a)-signed(b);
  const negative=result>=128, overflow=difference < -128 || difference > 127;
  return (old & 0xc0) | (a < b ? 1 : 0) | (a===b ? 2 : 0) | (negative ? 4 : 0) |
    (overflow ? 8 : 0) | (negative !== overflow ? 16 : 0) | ((a & 15) < (b & 15) ? 32 : 0);
}

test('SUB decodes every register pair, including overlapping operands, and retires in one clock', () => {
  const cpu=machine();
  assert.equal(word(14,24),0x1ae8);
  for (let d=0; d<32; d++) for (let r=0; r<32; r++) {
    put(cpu,word(d,r));
    for (let i=0; i<32; i++) cpu.r[i]=(i*17+d*7-r)&255;
    cpu.sreg=(r*9+d)&255;
    const before=cpu.state(), registers=[...before.registers];
    const a=registers[d], b=registers[r];
    registers[d]=(a-b)&255;
    const decoded=decodeAt(cpu), trace=cpu.step();
    assert.deepEqual([decoded.mnemonic,decoded.operands],['SUB',{destinationRegister:d,sourceRegister:r}]);
    assert.deepEqual(trace.after,{...before,registers,sreg:expectedFlags(a,b,before.sreg),pcWord:1,cycles:before.cycles+1});
    assert.deepEqual(trace.accesses.map(access=>access.kind),['fetch','fetch']);
  }
});

test('SUB computes all byte differences and ignores incoming C and Z', () => {
  const cpu=machine();
  put(cpu,word(14,24));
  for (let a=0; a<256; a++) for (let b=0; b<256; b++) for (const flags of [0x03,0xfc]) {
    cpu.r[14]=a; cpu.r[24]=b; cpu.sreg=flags; cpu.pc=0;
    cpu.step();
    assert.equal(cpu.r[14],(a-b)&255);
    assert.equal(cpu.sreg,expectedFlags(a,b,flags));
  }
});
