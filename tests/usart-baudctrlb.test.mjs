import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { USARTF0BaudControl } from '../src/peripherals/usart-baud.mjs';
import { USARTF0BaudHighControl } from '../src/peripherals/usart-baud-high.mjs';

const lowAddress = 0x0ba0 + 6, highAddress = lowAddress + 1;
function fixture(words = [], trace = true) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => { flash[2*i] = word & 255; flash[2*i+1] = word >>> 8; });
  present.fill(1, 0, 2*words.length);
  const cpu = new XmegaCPU({ flash, present });
  const low = new USARTF0BaudControl(), events = [];
  const high = new USARTF0BaudHighControl({ low, onAccess: trace ? e => events.push(e) : null });
  low.register(cpu.bus.mmio);
  high.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details),
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  return { cpu, bus: cpu.bus, low, high, events };
}
test('USARTF0 BAUDCTRLB resets the high register and scale to zero independently of the low byte', () => {
  const {bus,high} = fixture();
  assert.equal(bus.read(highAddress),0);
  assert.deepEqual(high.snapshot(),{ baudctrlb:0, bselHigh:0, bscale:0, bsel:0 });
  bus.write(lowAddress,255);
  bus.write(highAddress,0xf7);
  high.reset();
  assert.equal(bus.read(highAddress),0);
  assert.equal(bus.read(lowAddress),255);
  assert.deepEqual(high.snapshot(),{ baudctrlb:0, bselHigh:0, bscale:0, bsel:255 });
});
test('USARTF0 BAUDCTRLB decodes 0xA4 with 0x19 in the low register and reads both back', () => {
  const {bus,high,events} = fixture();
  bus.write(lowAddress,0x19);
  bus.write(highAddress,0xa4,18);
  assert.deepEqual(high.snapshot(),{ baudctrlb:164, bselHigh:4, bscale:-6, bsel:1049 });
  assert.deepEqual(events[0].before,{ baudctrlb:0, bselHigh:0, bscale:0, bsel:25 });
  assert.equal(events[0].cycle,18);
  assert.equal(bus.read(highAddress),0xa4);
  assert.equal(bus.read(lowAddress),0x19);
});
test('USARTF0 BAUDCTRLB represents every valid scale and all twelve BSEL bits in either write order', () => {
  const {bus,high} = fixture([],false);
  const scales = [0,1,2,3,4,5,6,7,null,-7,-6,-5,-4,-3,-2,-1];
  for (const [code,bscale] of scales.entries()) {
    if (bscale === null) continue;
    for (let upper=0; upper<16; upper++) {
      const raw = 16*code + upper;
      for (const lower of [0,1,25,127,128,254,255]) {
        if (lower%2) { bus.write(highAddress,raw); bus.write(lowAddress,lower); }
        else { bus.write(lowAddress,lower); bus.write(highAddress,raw); }
        assert.equal(bus.read(highAddress),raw);
        assert.equal(bus.read(lowAddress),lower);
        assert.deepEqual(high.snapshot(),{ baudctrlb:raw, bselHigh:upper, bscale, bsel:256*upper+lower });
      }
    }
  }
});
test('USARTF0 BAUDCTRLB rejects all sixteen encodings of reserved scale minus eight atomically', () => {
  const {bus,high,events}=fixture();
  bus.write(lowAddress,91);
  bus.write(highAddress,0x79);
  const before=high.snapshot();
  for (let v=128; v<144; v++) {
    assert.throws(()=>bus.write(highAddress,v), e=>e.classification==='USART_RESERVED_BSCALE' && e.addressByte===highAddress && e.attemptedValue===v);
    assert.deepEqual(high.snapshot(),before);
    assert.deepEqual(events.at(-1).before,events.at(-1).after);
    assert.equal(events.at(-1).completed,false);
    assert.equal(bus.read(highAddress),0x79);
  }
});
test('USARTF0 BAUDCTRLB owns exactly one MMIO byte per instance', () => {
  const {bus,high}=fixture(), other=fixture();
  assert.throws(()=>high.register(other.bus.mmio),/already registered/);
  assert.throws(()=>new USARTF0BaudHighControl({low:other.low}).register(bus.mmio),/Duplicate/);
  bus.write(highAddress,0x01);
  assert.equal(other.bus.read(highAddress),0);
  for (const a of [highAddress+1,0x09a7,0x0ba1]) assert.throws(()=>bus.read(a),e=>e.classification==='UNHANDLED_MMIO' && e.addressByte===a);
});
test('USARTF0 BAUDCTRLB synthetic CPU writes and reads respect AVRxm MMIO timing on replay', () => {
  function run() {
    const {cpu,events,high}=fixture([0xef53,0x8357,0x8167,0x9150,highAddress]);
    cpu.setPair(30,0x0ba0);
    cpu.sreg=0x95;
    const trace=Array.from({length:4},()=>cpu.step());
    assert.deepEqual(trace.map(t=>[t.mnemonic,t.after.pcWord,t.after.cycles]),[['LDI',1,1],['STD',2,3],['LDD',3,5],['LDS',5,6]]);
    assert.deepEqual([cpu.r[21],cpu.r[22],cpu.sp,cpu.sreg,cpu.pair(30)],[243,243,0x5fff,0x95,0xba0]);
    assert.deepEqual(events.map(e=>[e.kind,e.pcWord,e.cycle,e.value]),[['write',1,3,243],['read',2,5,243],['read',3,6,243]]);
    return {trace,events,state:high.snapshot()};
  }
  assert.deepEqual(run(),run());
});
test('USARTF0 BAUDCTRLB rejected CPU store leaves PC, cycles, and both register bytes intact', () => {
  const {cpu,bus,high}=fixture([0x9340, highAddress]);
  bus.write(lowAddress,0x4d);
  bus.write(highAddress,0xf5);
  const before=high.snapshot();
  cpu.r[20]=0x8a;
  assert.throws(()=>cpu.step(),e=>e.classification==='USART_RESERVED_BSCALE' && e.pcWord===0 && e.opcode===0x9340);
  assert.deepEqual([cpu.pc,cpu.cycles,cpu.steps],[0,0,0]);
  assert.deepEqual(high.snapshot(),before);
});
