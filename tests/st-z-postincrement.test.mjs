import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

function machine() {
  const flash=new Uint8Array(0x42000);
  return new XmegaCPU({flash,present:new Uint8Array(flash.length)});
}
function storeAt(cpu,source,pc=0) {
  const word=parseInt('1001001'+source.toString(2).padStart(5,'0')+'0001',2);
  cpu.flash.set([word & 255,word >>> 8],pc*2);
  cpu.present.fill(1,pc*2,pc*2+2);
  cpu.pc=pc;
  return word;
}

test('ST Z+ stores every byte from each defined source at the old address and carries into ZH', () => {
  const cpu=machine();
  for(let r=0;r<30;r++) {
    const opcode=storeAt(cpu,r);
    for(let value=0;value<256;value++) {
      cpu.pc=0; cpu.setPair(30,0x21ff); cpu.r[r]=value;
      cpu.sreg=value ^ 0x93; cpu.rampz=value & 7; cpu.eind=1;
      cpu.sram[0x200]=value ^ 255;
      const before=cpu.state(), decoded=decodeAt(cpu), t=cpu.step();
      assert.deepEqual(decoded.operands,{register:r,pointer:'Z',postIncrement:true,addressByte:0x21ff,value});
      assert.deepEqual([decoded.mnemonic,t.mnemonic,t.opcode],['ST Z+','ST Z+',opcode]);
      const registers=before.registers.slice(); registers[30]=0; registers[31]=0x22;
      assert.deepEqual(t.after,{...before,pcWord:1,cycles:before.cycles+1,registers});
      assert.deepEqual(t.accesses.map(a=>[a.kind,a.space,a.addressByte,a.value]),[
        ['fetch','flash',0,opcode & 255],['fetch','flash',1,opcode >>> 8],['write','sram',0x21ff,value]]);
      assert.deepEqual([cpu.sram[0x1ff],cpu.sram[0x200]],[value,value ^ 255]);
    }
  }
  assert.equal(storeAt(cpu,25),0x9391);
});

test('ST Z+ commits mapped I/O once at its bus cycle and honors the SREG wait state', () => {
  const cpu=machine(),events=[];
  storeAt(cpu,25,1);storeAt(cpu,25);
  cpu.r[25]=0xa7;cpu.setPair(30,0x601);
  cpu.mapMMIO(0x601,{write:(v,c)=>events.push([v,c,cpu.pair(30)])});
  cpu.step();
  assert.deepEqual(events,[[0xa7,1,0x601]]);
  assert.equal(cpu.pair(30),0x602);
  cpu.setPair(30,0x3f);
  const t=cpu.step();
  assert.deepEqual(t.accesses.at(-1),{kind:'write',space:'cpu-io',addressByte:0x3f,value:0xa7,waitCycles:1});
  assert.deepEqual([cpu.sreg,cpu.pair(30),t.after.cycles-t.before.cycles],[0xa7,0x40,2]);
});

test('ST Z+ treats R30 and R31 sources as undefined before any bus write', () => {
  const cpu=machine();
  for(const r of [30,31]) {
    storeAt(cpu,r);
    cpu.setPair(30,0x2103);
    const before=cpu.state(), byte=cpu.sram[0x103];
    assert.throws(()=>cpu.step(),e=>{
      assert.equal(e.classification,'UNDEFINED_OPERANDS');
      assert.deepEqual(e.trace.accesses.map(a=>a.kind),['fetch','fetch']);
      return true;
    });
    assert.deepEqual(cpu.state(),before);
    assert.equal(cpu.sram[0x103],byte);
  }
});

test('ST Z+ preserves its pointer on rejected writes and invalid fall-through and can retry the store', () => {
  const cpu=machine(),writes=[];
  storeAt(cpu,7); cpu.setPair(30,0x603); cpu.r[7]=0x37;
  const initial=cpu.state();
  assert.throws(()=>cpu.step(),/Unsupported data write/);
  assert.deepEqual(cpu.state(),initial);
  cpu.mapMMIO(0x603,{write:(v,c)=>writes.push([v,c,cpu.pair(30)])});
  storeAt(cpu,7,cpu.flash.length/2-1);
  const before=cpu.state();
  assert.throws(()=>cpu.step(),/PC target outside device/);
  assert.deepEqual(cpu.state(),before);
  assert.deepEqual(writes,[]);
  cpu.pc=0;cpu.step();
  assert.deepEqual(writes,[[0x37,1,0x603]]);
  assert.equal(cpu.pair(30),0x604);
});

test('ST Z+ respects the EEPROM mapping fault and the last implemented SRAM byte', () => {
  const cpu=machine(), events=[];
  const nvm=new NVMController();
  nvm.register(cpu.bus.mmio,{fault:(m,d)=>cpu.fault(m,d),clock:()=>cpu.cycles});
  cpu.bus.attachEEPROM(nvm,{onAccess:e=>events.push(e)});
  cpu.write(0x01cc,8);
  storeAt(cpu,2);cpu.r[2]=0xdd;cpu.setPair(30,0x1033);
  const before=cpu.state(), original=cpu.eeprom[0x33];
  assert.throws(()=>cpu.step(),{classification:'EEPROM_PAGE_BUFFER_UNSUPPORTED'});
  assert.deepEqual(cpu.state(),before);
  assert.deepEqual([cpu.eeprom[0x33],events.at(-1).attemptedValue],[original,0xdd]);
  cpu.setPair(30,0x5fff);cpu.rampz=2;cpu.step();
  assert.deepEqual([cpu.sram.at(-1),cpu.pair(30),cpu.rampz],[0xdd,0x6000,2]);
  cpu.pc=0;
  assert.throws(()=>cpu.step(),/Unsupported data write/);
  assert.equal(cpu.pair(30),0x6000);
});
