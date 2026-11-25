import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { USARTF0BaudControl } from '../src/peripherals/usart-baud.mjs';

const address = 0x0ba0 + 6;
function bench(words = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => { flash[2*i] = word & 255; flash[2*i+1] = word >>> 8; });
  present.fill(1,0,2*words.length);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const baud = new USARTF0BaudControl({ onAccess: e => events.push(e) });
  baud.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  return { cpu, bus: cpu.bus, events, baud };
}
test('USARTF0 BAUDCTRLA resets all eight low BSEL bits to zero', () => {
  const {bus,baud,events} = bench();
  assert.equal(bus.read(address), 0);
  bus.write(address,255);
  baud.reset();
  assert.equal(events.length,2);
  assert.deepEqual(baud.snapshot(), {baudctrla:0,bselLow:0});
  assert.equal(bus.read(address),0);
});
test('USARTF0 BAUDCTRLA stores every byte and supports nondestructive repeated reads', () => {
  const {bus,baud} = bench();
  for (let byte=0; byte<256; byte++) {
    bus.write(address,255-byte);
    bus.write(address,byte);
    assert.equal(bus.read(address),byte);
    assert.equal(bus.read(address),byte);
    assert.deepEqual(baud.snapshot(),{baudctrla:byte,bselLow:byte});
  }
});
test('USARTF0 BAUDCTRLA writes leave a separately mapped high register untouched', () => {
  const {bus} = bench();
  let high = 0xb5, accesses = 0;
  bus.mmio.map(address+1,{read:()=>{accesses++;return high;},write:value=>{accesses++;high=value;}});
  for(const low of [0,255,128,1,0x19]) {
    bus.write(address,low); assert.equal(bus.read(address),low);
    assert.equal(high,0xb5);
  }
  assert.equal(accesses,0);
  bus.write(address+1,0x72);assert.equal(bus.read(address),0x19);
});
test('USARTF0 BAUDCTRLA maps only its own byte and keeps other instance addresses unmapped', () => {
  const {bus} = bench();
  for(const a of [address-1,address+1,0x09a6,0x0ba0,0x0ba1]) {
    assert.throws(()=>bus.read(a),e=>e.classification==='UNHANDLED_MMIO' && e.addressByte===a);
    assert.throws(()=>bus.write(a,0xaa),e=>e.classification==='UNHANDLED_MMIO' && e.addressByte===a);
  }
  assert.equal(bus.read(address),0);
});
test('USARTF0 BAUDCTRLA prevents duplicate registration and has independent instance state', () => {
  const first=bench(), second=bench();
  assert.throws(()=>first.baud.register(second.bus.mmio),/already registered/);
  assert.throws(()=>new USARTF0BaudControl().register(first.bus.mmio),/Duplicate/);
  first.bus.write(address,0x80);
  assert.equal(second.bus.read(address),0);
  assert.equal(first.bus.read(address),0x80);
});
test('USARTF0 BAUDCTRLA synthetic displacement and direct instructions complete on their AVRxm clock edges', () => {
  const {cpu,events} = bench([0xe85c,0x8356,0x8166,0x9350,address,0x9140,address]);
  cpu.setPair(30,0x0ba0); cpu.sreg=0x95;
  const trace=Array.from({length:5},()=>cpu.step());
  assert.deepEqual(trace.map(t=>[t.mnemonic,t.after.pcWord,t.after.cycles]),[['LDI',1,1],['STD',2,3],['LDD',3,5],['STS',5,7],['LDS',7,8]]);
  assert.deepEqual([cpu.r[20],cpu.r[22],cpu.sreg,cpu.sp,cpu.pair(30)],[0x8c,0x8c,0x95,0x5fff,0x0ba0]);
  assert.deepEqual(events.map(e=>[e.kind,e.pcWord,e.cycle,e.value]),[['write',1,3,140],['read',2,5,140],['write',3,7,140],['read',5,8,140]]);
  assert.ok(events.every(e=>e.completed && e.addressByte===address && e.register==='BAUDCTRLA'));
});
test('USARTF0 BAUDCTRLA replay reproduces register state and ordered access history', () => {
  const {bus,baud,events}=bench();
  function run() {
    baud.reset(); events.length=0;
    for(const [step,v] of [0x00,0xff,0x81,0x19].entries()) { bus.write(address,v,2*step); bus.read(address,2*step+1); }
    return {events:[...events],state:baud.snapshot()};
  }
  assert.deepEqual(run(),run());
});
