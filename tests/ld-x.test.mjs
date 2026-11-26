import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

function machine(eeprom) {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({ flash, present:new Uint8Array(flash.length) }, { eeprom });
}
function place(cpu, rd, pc = 0) {
  const word = parseInt('1001000' + rd.toString(2).padStart(5,'0') + '1100', 2);
  cpu.flash.set([word & 255, word >>> 8], 2 * pc);
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
  cpu.pc = pc;
  return word;
}

test('LD Rd,X reads every byte for all 32 destinations including XL and XH using the old pointer', () => {
  const cpu = machine();
  for (let rd = 0; rd < 32; rd++) {
    const word = place(cpu, rd);
    for (let value = 0; value < 256; value++) {
      cpu.pc = 0; cpu.r[rd] = value ^ 255; cpu.setPair(26,0x21ff);
      cpu.sram[0x1ff] = value; cpu.sreg = (value + rd) & 255; cpu.rampz = 2;
      const before = cpu.state(), registers = [...before.registers];
      registers[rd] = value;
      assert.deepEqual(decodeAt(cpu).operands, {register:rd,pointer:'X',postIncrement:false,addressByte:0x21ff});
      const t = cpu.step();
      assert.deepEqual([t.opcode,t.mnemonic,t.after], [word,'LD',{...before,pcWord:1,registers,cycles:before.cycles+2}]);
      assert.deepEqual(t.accesses.map(a=>[a.kind,a.space,a.addressByte,a.value]), [
        ['fetch','flash',0,word & 255],['fetch','flash',1,word >>> 8],['read','sram',0x21ff,value],
      ]);
    }
  }
  assert.equal(place(cpu,31),0x91fc);
});

test('LD Rd,X samples I/O once at one clock and honors the mapped EEPROM read wait', () => {
  const bytes = new Uint8Array(4096), calls = [];
  bytes[0x33] = 0xaa;
  const cpu = machine(bytes), nvm = new NVMController();
  nvm.register(cpu.bus.mmio,{fault:(m,d)=>cpu.fault(m,d),clock:()=>cpu.cycles});
  cpu.bus.attachEEPROM(nvm); cpu.write(0x1cc,8);
  cpu.mapMMIO(0x604,{read:cycle=>{ calls.push([cycle,cpu.pair(26)]); return 0xc7; }});
  cpu.sram[0x3fff] = 0x6d;
  for (const [addr,value,cycles] of [[0x604,0xc7,1],[0x1033,0xaa,3],[0x5fff,0x6d,2]]) {
    place(cpu,31); cpu.setPair(26,addr); cpu.sreg = 0xe3;
    const t = cpu.step();
    assert.deepEqual([cpu.r[31],cpu.pair(26),cpu.sreg,t.after.cycles-t.before.cycles], [value,addr,0xe3,cycles]);
  }
  assert.deepEqual(calls,[[1,0x604]]);
});

test('LD Rd,X faults before consuming a byte and can retry after the data address is mapped', () => {
  const cpu = machine(), last = cpu.flash.length / 2 - 1, calls = [];
  cpu.setPair(26,0x601); cpu.r[31] = 0x54;
  place(cpu,31);
  const before = cpu.state();
  assert.throws(()=>cpu.step(),e=>e.classification==='UNHANDLED_MMIO' && e.addressByte===0x601);
  assert.deepEqual(cpu.state(),before);
  cpu.mapMMIO(0x601,{read:cycle=>{calls.push(cycle);return 0x73;}});
  place(cpu,31,last);
  const boundary = cpu.state();
  assert.throws(()=>cpu.step(),/PC target outside device/);
  assert.deepEqual(cpu.state(),boundary);
  assert.deepEqual(calls,[]);
  cpu.pc=0; cpu.step();
  assert.deepEqual([cpu.r[31],cpu.pair(26),calls],[0x73,0x601,[1]]);
});
