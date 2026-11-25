import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCC0Counter } from '../src/peripherals/tcc0-counter.mjs';
import { TCC0Clock } from '../src/peripherals/tcc0-clock.mjs';

// Addresses and CLKSEL values come from XMEGA A §§14.12.1, 14.12.11–13.
const CTRL = 0x0800, TEMP = 0x080f, LO = 0x0820, HI = 0x0821;
function fixture(words = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => {
    flash[2*i] = word & 0xff;
    flash[2*i+1] = word >>> 8;
  });
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const counter = new TCC0Counter(), clock = new TCC0Clock({ counter, onAccess: e => events.push(e) });
  const options = { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps+1 }) };
  counter.register(cpu.bus.mmio, options);
  clock.register(cpu.bus.mmio, options);
  return { cpu, bus: cpu.bus, counter, clock, events };
}

test('TCC0 clock resets to off and reads back only writable bits', () => {
  const {bus,counter,clock} = fixture();
  assert.equal(bus.read(CTRL,0),0);
  bus.write(LO,0x34,1);
  bus.write(HI,0x12,2);
  assert.equal(bus.read(LO,10001),0x34);
  assert.equal(bus.read(HI,10002),0x12);
  bus.write(CTRL,0xf6,10003);
  assert.equal(bus.read(CTRL,10004),6);
  counter.reset();
  assert.deepEqual(clock.snapshot(0),{ctrla:0,divider:0});
  assert.deepEqual(counter.snapshot(),{cnt:0,temp:0});
});

test('TCC0 clock DIV256 selects the next shared edge at every possible enable phase', () => {
  const {bus,counter} = fixture();
  for (let phase=0; phase<256; phase++) {
    counter.reset();
    bus.write(CTRL,6,256+phase);
    for (const [cycle,value] of [[511,0],[512,1],[767,1],[768,2],[1023,2],[1024,3]]) {
      assert.equal(bus.read(LO,cycle),value,'enable phase '+phase+' at clock '+cycle);
    }
  }
});

test('TCC0 clock implements every internal clock selector on the common prescaler', () => {
  const {bus,counter} = fixture();
  // Generate expected pulses one physical peripheral edge at a time.
  for (const [selector,divisor] of [[1,1],[2,2],[3,4],[4,8],[5,64],[6,256],[7,1024]]) {
    counter.reset();
    bus.write(CTRL,selector,0);
    let expected=0;
    for (let cycle=1;cycle<=3100;cycle++) {
      if (cycle % divisor===0) expected++;
      assert.equal(bus.read(LO,cycle) | (bus.read(HI,cycle)<<8),expected);
    }
  }
});

test('TCC0 clock stop restart and divider changes preserve the common phase', () => {
  const {bus} = fixture();
  bus.write(CTRL,6,253);
  bus.write(CTRL,6,255);
  bus.write(CTRL,0,256); // The old tap supplies the edge on the write clock.
  assert.equal(bus.read(LO,511),1);
  bus.write(CTRL,6,512);
  assert.equal(bus.read(LO,767),1);
  bus.write(CTRL,2,768);
  assert.equal(bus.read(LO,769),2);
  assert.equal(bus.read(LO,770),3);
});

test('TCC0 clock advances independently of TEMP and counter writes win on a counting edge', () => {
  const {bus} = fixture();
  bus.write(LO,0xff,0);
  bus.write(HI,0,0);
  bus.write(CTRL,6,0);
  assert.equal(bus.read(LO,255),0xff);
  assert.equal(bus.read(HI,256),0);
  assert.equal(bus.read(LO,257),0);
  assert.equal(bus.read(HI,258),1);
  bus.write(LO,0x94,511);
  bus.write(HI,0x72,512);
  assert.equal(bus.read(LO,512),0x94);
  assert.equal(bus.read(TEMP,513),0x72);
});

test('TCC0 clock wraps the 16-bit counter at reset TOP and preserves sparse and dense results', () => {
  const {bus,counter,clock} = fixture();
  bus.write(LO,0xfe,0);
  bus.write(HI,0xff,0);
  bus.write(CTRL,6,0);
  clock.snapshot(256);
  assert.equal(counter.snapshot().cnt,0xffff);
  clock.snapshot(512);
  assert.equal(counter.snapshot().cnt,0);
  clock.snapshot(256*(65536*10+7));
  assert.equal(counter.snapshot().cnt,5);
});

test('TCC0 clock rejects event sources without committing the counter or claiming a clock edge', () => {
  const {bus,counter,clock,events} = fixture();
  bus.write(CTRL,6,1);
  for (let select=8;select<=15;select++) {
    assert.throws(() => bus.write(CTRL,select,256),e=>e.classification==='TCC0_EVENT_CLOCK_UNMODELED' && e.addressByte===CTRL && e.attemptedValue===select);
    assert.equal(events.at(-1).completed,false);
    assert.deepEqual(clock.snapshot(255),{ctrla:6,divider:256});
    assert.equal(counter.snapshot().cnt,0);
  }
  assert.equal(bus.read(LO,256),1);
  assert.throws(()=>bus.write(CTRL+1,0,257),e=>e.classification==='UNHANDLED_MMIO');
  assert.throws(()=>clock.snapshot(200),RangeError);
});

test('TCC0 clock registration preserves collisions and requires the matching counter instance', () => {
  const counter=new TCC0Counter(), reg=new MMIORegistry(), other=new MMIORegistry();
  const clock=new TCC0Clock({counter}), existing={read:()=>3};
  assert.throws(()=>clock.register(reg));
  counter.register(reg);
  assert.throws(()=>clock.register(other));
  reg.map(CTRL,existing);
  assert.throws(()=>clock.register(reg));
  assert.equal(reg.handlers.get(CTRL),existing);
  assert.equal(counter.clock,undefined);
});

test('TCC0 clock real STS and LDS sample completion edges and replay deterministically', () => {
  // STS CTRLA,R16 at edges 253..255, then LDS R17,CNTL completes on edge 256.
  function run() {
    const {cpu,clock,counter,events}=fixture([0x9300,CTRL,0x9110,LO]);
    cpu.cycles=253;
    cpu.r[16]=6;
    cpu.sreg=0xa5;
    const traces=[cpu.step(),cpu.step()];
    assert.deepEqual(traces.map(t=>[t.mnemonic,t.after.pcWord,t.after.cycles]),[['STS',2,255],['LDS',4,256]]);
    assert.deepEqual([cpu.r[17],cpu.sp,cpu.sreg],[1,0x5fff,0xa5]);
    assert.deepEqual(events.map(e=>[e.origin,e.kind,e.cycle,e.value,e.completed]),[['peripheral-model','write',255,6,true]]);
    return [events,traces,clock.snapshot(256),counter.snapshot()];
  }
  assert.deepEqual(run(),run());
});
