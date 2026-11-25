import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCC0Counter } from '../src/peripherals/tcc0-counter.mjs';

// ATxmega256A3 device map and XMEGA A manual sections 3.11 and 14.12.11-13.
const temp = 0x080f, low = 0x0820, high = 0x0821;
function fixture(words = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((w,i) => { flash[2*i] = w & 255; flash[2*i+1] = w >>> 8; });
  present.fill(1,0,2*words.length);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const timer = new TCC0Counter({ onAccess: e => events.push(e) });
  timer.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps+1 }) });
  return { cpu, bus: cpu.bus, timer, events };
}

test('TCC0 counter and CPU TEMP reset to zero without generating a transaction', () => {
  const {bus,timer,events} = fixture();
  assert.deepEqual(timer.snapshot(),{cnt:0,temp:0});
  bus.write(low,0xa7);
  bus.write(high,0x63);
  const count=events.length;
  timer.reset();
  assert.equal(events.length,count);
  assert.deepEqual([bus.read(temp),bus.read(low),bus.read(high)],[0,0,0]);
});

test('TCC0 counter stages the last low byte and commits both bytes only on a high write', () => {
  const {bus,timer} = fixture();
  for (let byte=0;byte<256;byte++) {
    const old=timer.snapshot().cnt;
    const msb=255-byte;
    bus.write(low,byte^255);
    bus.write(low,byte);
    assert.deepEqual(timer.snapshot(),{cnt:old,temp:byte});
    bus.write(high,msb);
    assert.deepEqual(timer.snapshot(),{cnt:256*msb+byte,temp:byte});
    assert.equal(bus.read(low),byte);
    assert.equal(bus.read(high),msb);
  }
});

test('TCC0 counter high accesses use the current TEMP even without a preceding low access', () => {
  const {bus,timer} = fixture();
  bus.write(high,0xba);
  assert.equal(timer.snapshot().cnt,0xba00);
  bus.write(temp,0x4e);
  assert.equal(bus.read(high),0x4e);
  bus.write(high,0x51);
  bus.write(high,0x72);
  assert.deepEqual(timer.snapshot(),{cnt:0x724e,temp:0x4e});
});

test('TCC0 counter low read snapshots committed high and replaces any staged byte in shared TEMP', () => {
  const {bus,timer} = fixture();
  bus.write(low,0x37);
  bus.write(high,0xab);
  bus.write(low,0xcc);
  assert.equal(bus.read(low),0x37);
  assert.equal(bus.read(temp),0xab);
  assert.equal(bus.read(high),0xab);
  bus.write(high,0x18);
  assert.deepEqual(timer.snapshot(),{cnt:0x18ab,temp:0xab});
  bus.write(temp,0x80);
  assert.equal(bus.read(high),0x80);
  assert.equal(timer.snapshot().cnt,0x18ab);
});

test('TCC0 counter stays stopped over elapsed clocks and never maps clock control or other timers', () => {
  const {bus,timer} = fixture();
  bus.write(low,0xff,1);
  bus.write(high,0xff,2);
  assert.equal(bus.read(low,100000),255);
  assert.equal(bus.read(high,100001),255);
  for (const a of [0x07ff,0x0800,0x080e,0x0810,0x081f,0x0822,0x0826,0x0860]) {
    for (const kind of ['read','write']) {
      assert.throws(()=>kind==='read'?bus.read(a):bus.write(a,6),
        e=>e.classification==='UNHANDLED_MMIO' && e.accessKind===kind && e.addressByte===a);
    }
  }
  assert.equal(timer.snapshot().cnt,0xffff);
});

test('TCC0 counter registration is atomic at every byte and state belongs to one instance', () => {
  for (const a of [temp,low,high]) {
    const registry=new MMIORegistry(), existing={read:()=>0x7e};
    const timer=new TCC0Counter();
    registry.map(a,existing);
    assert.throws(()=>timer.register(registry),/collision/);
    assert.deepEqual([...registry.handlers],[[a,existing]]);
    timer.register(new MMIORegistry());
    assert.throws(()=>timer.register(new MMIORegistry()),/collision/);
  }
  const first=fixture(), second=fixture();
  first.bus.write(low,0x12);
  first.bus.write(high,0x34);
  assert.deepEqual(second.timer.snapshot(),{cnt:0,temp:0});
});

test('TCC0 counter synthetic CPU stores and loads use the MMIO completion edge and preserve SREG and SP', () => {
  // STS low,R20; STS high,R21; LDS R22,low; LDS R23,high.
  const {cpu,events}=fixture([0x9340,low,0x9350,high,0x9160,low,0x9170,high]);
  cpu.r[20]=0xcd; cpu.r[21]=0x9a; cpu.sreg=0xb5;
  const steps=Array.from({length:4},()=>cpu.step());
  assert.deepEqual(steps.map(t=>[t.mnemonic,t.after.pcWord,t.after.cycles]),
    [['STS',2,2],['STS',4,4],['LDS',6,5],['LDS',8,6]]);
  assert.deepEqual([cpu.r[22],cpu.r[23],cpu.sreg,cpu.sp],[0xcd,0x9a,0xb5,0x5fff]);
  assert.deepEqual(events.map(e=>[e.register,e.kind,e.cycle,e.before.cnt,e.after.cnt,e.after.temp]),[
    ['CNTL','write',2,0,0,0xcd],['CNTH','write',4,0,0x9acd,0xcd],
    ['CNTL','read',5,0x9acd,0x9acd,0x9a],['CNTH','read',6,0x9acd,0x9acd,0x9a],
  ]);
});

test('TCC0 counter reset and replay reproduce the entire ordered CPU-access history', () => {
  const {bus,timer,events}=fixture();
  function replay() {
    timer.reset();
    events.length=0;
    bus.write(temp,0xab,1);
    bus.write(high,0x98,3);
    bus.read(low,4);
    bus.read(high,5);
    bus.write(low,0,7);
    bus.write(high,0,9);
    assert.ok(events.every(e=>e.origin==='peripheral-model' && e.eventType==='timer-access' && e.completed));
    return {events:[...events],state:timer.snapshot()};
  }
  assert.deepEqual(replay(), replay());
});
