import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { SystemClock } from '../src/peripherals/system-clock.mjs';
import { OscillatorController } from '../src/peripherals/oscillator.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';
import { EEPROMPageBuffer } from '../src/peripherals/eeprom-page-buffer.mjs';

function fixture(delays = {rc32m: 3, rc32k: 7}, words = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  for (const [i,word] of words.entries()) {
    flash.set([word & 255, word >>> 8], 2*i);
    present.fill(1, 2*i, 2*i+2);
  }
  const cpu = new XmegaCPU({flash,present}), events = [];
  const clk = new SystemClock({onAccess: e => events.push(e)});
  const osc = new OscillatorController({startupCycles:delays,systemClock:clk});
  osc.register(cpu.bus.mmio,{fault: (m,d) => cpu.fault(m,d)});
  clk.register(cpu.bus,osc);
  osc.releaseReset();
  const write = (a,v,c) => cpu.write(a,v,c);
  const read = (a,c) => cpu.read(a,c);
  function select(value, cycle) { write(0x34,0xd8,cycle-1); write(0x40,value,cycle); }
  return {cpu,clk,osc,events,write,read,select};
}

test('CLK reset selects RC2M at divide by one and maps only CLK.CTRL through shared CCP', () => {
  const f=fixture();
  assert.deepEqual([f.read(0x40,0),f.clk.snapshot(31).cpuClockHz,f.clk.timeAt(31)],[0,2000000,7936]);
  for (const addr of [0x41,0x42,0x43,0x56]) assert.throws(()=>f.read(addr,0),e=>e.classification==='UNHANDLED_MMIO');
  assert.throws(()=>f.clk.register(f.cpu.bus,f.osc),/collision/);
  const flash = new Uint8Array(0x42000), c = new XmegaCPU({flash,present:flash}), clk = new SystemClock();
  const osc = new OscillatorController({systemClock:clk});
  c.bus.mmio.map(0x40,{read:()=>9});
  assert.throws(()=>clk.register(c.bus,osc),/collision/);
  assert.equal(c.bus.ccp,null); assert.equal(c.read(0x40),9);
});

test('CLK accepts only IOREG 0xD8 and only CPU write edges one through four after the key', () => {
  for (let key=0; key<256; key++) {
    const f=fixture({rc32m:1});
    f.write(0x50,3,0); f.write(0x34,key,10); f.write(0x40,1,11);
    assert.equal(f.read(0x40,15),Number(key===0xd8),'key '+key);
  }
  for (let offset=0; offset<=7; offset++) {
    const f=fixture({rc32m:1}); f.write(0x50,3,0); f.write(0x34,0xd8,100);
    f.write(0x40,1,100+offset);
    const expected=offset>=1 && offset<=4;
    assert.equal(f.events.at(-1).ioGrant,expected);
    assert.equal(f.events.at(-1).outcome,expected?'accepted':'no-ccp-grant');
    assert.equal(f.clk.snapshot(120).cpuClockHz,expected?32000000:2000000);
  }
});

test('CLK real OUT and two-word STS use the store bus edge at the inclusive fourth-clock boundary', () => {
  for (let delay=0; delay<4; delay++) {
    const words=[0xbf84,...Array(delay).fill(0),0x9390,0x0040,0];
    const f=fixture({rc32m:1},words); f.write(0x50,3,0);
    f.cpu.r[24]=0xd8; f.cpu.r[25]=1; f.cpu.sreg=0x25;
    const key=f.cpu.step();
    for (let n=0;n<delay;n++) f.cpu.step();
    const store=f.cpu.step(), e=f.events.at(-1);
    assert.equal(key.after.cycles,1);
    assert.deepEqual([e.cycle,e.ioGrant,e.value],[delay+3,delay<=2,1]);
    assert.deepEqual([store.mnemonic,store.after.cycles-store.before.cycles,store.after.pcWord,store.after.sreg],['STS',2,delay+3,0x25]);
    assert.deepEqual(store.accesses.at(-1),{kind:'write',space:'mmio',addressByte:0x40,value:1});
  }
});

test('CLK consumes a shared grant on a write, cancels it on intervening SRAM or I/O stores and permits reads', () => {
  for (const addr of [0x2010,0x50]) {
    const f=fixture({rc32m:1}); f.write(0x50,3,0); f.write(0x34,0xd8,10);
    f.write(addr,3,11); f.write(0x40,1,12);
    assert.equal(f.events.at(-1).outcome,'no-ccp-grant');
    assert.equal(f.read(0x40,15),0);
  }
  const f=fixture({rc32m:1}); f.write(0x50,3,0); f.write(0x34,0xd8,10);
  assert.equal(f.read(0x51,11),3); f.write(0x40,1,12);
  assert.equal(f.events.at(-1).outcome,'accepted');
  f.write(0x40,0,13); assert.equal(f.events.at(-1).outcome,'no-ccp-grant');
  assert.equal(f.read(0x40,20),1);
});

test('CLK ignores disabled or starting RC32M and accepts it on the first known-ready edge', () => {
  const f=fixture({rc32m:12});
  f.select(1,5); assert.equal(f.events.at(-1).outcome,'source-disabled');
  f.write(0x50,7,10); // RC32K has unknown timing; only the requested source matters.
  f.select(1,21); assert.equal(f.events.at(-1).outcome,'source-not-ready');
  f.write(0x40,1,22); assert.equal(f.events.at(-1).outcome,'no-ccp-grant');
  assert.equal(f.clk.switches.length,0);
  const g=fixture({rc32m:12}); g.write(0x50,7,10); g.select(1,22);
  assert.deepEqual([g.events.at(-1).outcome,g.clk.snapshot(26).cpuClockHz],['accepted',32000000]);
  const u=fixture({}); u.write(0x50,3,1); u.write(0x40,1,9);
  assert.equal(u.events.at(-1).outcome,'no-ccp-grant');
  assert.throws(()=>u.select(1,20),e=>e.classification==='CLK_SOURCE_READY_UNKNOWN' && e.addressByte===0x40);
  assert.equal(u.clk.switches.length,0); assert.equal(u.clk.snapshot(20).cpuClockHz,2000000);
});

test('CLK handover spans two old and two new periods and protects both sources through the third edge', () => {
  const f=fixture({rc32m:1}); f.write(0x50,3,0); f.select(1,100);
  const expected=[
    [100,'old-source',2000000,25600,3], [101,'old-source',2000000,25856,3],
    [102,'new-source',32000000,26112,3], [103,'new-source',32000000,26128,3],
    [104,'settled',32000000,26144,2],
  ];
  for (const [c,phase,hz,ticks,mask] of expected) {
    const state=f.clk.snapshot(c);
    assert.deepEqual([state.phase,state.cpuClockHz,state.elapsedTicks,state.protectedSources],[phase,hz,ticks,mask]);
    f.write(0x50,0,c);
    assert.deepEqual([f.read(0x50,c),f.read(0x51,c)],[mask,mask]);
  }
  assert.deepEqual([f.read(0x40,104),f.clk.switches.length],[1,1]);
  f.write(0x50,3,110);
  assert.throws(()=>f.select(0,119),e=>e.classification==='CLK_SOURCE_READY_UNKNOWN');
});

test('CLK scales an oscillator startup spanning a switch and preserves fractional 32.768 kHz periods on switchback', () => {
  const f=fixture({rc32m:1,rc32k:10,rc2m:3}); f.write(0x50,7,20); f.select(1,24);
  // RC32K needs ten 2 MHz periods from edge 20: six old clocks until edge 26, then 64 new clocks.
  assert.equal(f.read(0x51,89),3); assert.equal(f.read(0x51,90),7);
  f.select(2,94); // Edge 96 is the last edge reached on the 32 MHz time scale.
  const origin=f.clk.timeAt(96);
  assert.equal(f.clk.timeAt(98)-origin,31250);
  assert.equal(f.clk.cycleAt(origin+15624),97); assert.equal(f.clk.cycleAt(origin+15625),97);
  assert.equal(f.clk.cycleAt(origin+15626),98);
  f.select(0,100);
  assert.equal(f.clk.snapshot(104).cpuClockHz,2000000);
  assert.equal(f.clk.timeAt(104)-f.clk.timeAt(100),2*15625+2*256);
});

test('CLK source encoding, repeated selections and overlapping requests preserve the accepted transition', () => {
  const f=fixture({rc32m:1,rc32k:1}); f.write(0x50,7,0);
  for (const target of [3,4]) { f.select(target,4+target*4); assert.equal(f.events.at(-1).outcome,'source-disabled'); }
  for (const target of [5,6,7]) assert.throws(()=>f.select(target,16+target*4),e=>e.classification==='CLK_RESERVED_SOURCE');
  f.select(0xf9,64); assert.equal(f.read(0x40,64),1);
  f.select(1,66); assert.equal(f.events.at(-1).outcome,'already-selected');
  assert.throws(()=>f.select(2,67),e=>e.classification==='CLK_SWITCH_IN_PROGRESS');
  assert.equal(f.clk.switches.length,1); assert.equal(f.clk.snapshot(68).activeSelector,1);
});

test('CLK keeps a protected EEPROM write at its physical-time deadline during and after a rate change', () => {
  const f=fixture({rc32m:1}), storage=f.cpu.bus.eepromStorage;
  const nvm=new NVMController({pageBuffer:new EEPROMPageBuffer(storage),timeBase:f.clk});
  nvm.register(f.cpu.bus.mmio,{fault:(m,d)=>f.cpu.fault(m,d),clock:()=>f.cpu.cycles});
  f.cpu.bus.attachEEPROM(nvm,{programming:{eraseWriteCycles:10}});
  function write(addr,val,c) { f.cpu.cycles=c; f.write(addr,val,c); }
  function program(offset,value,start) {
    write(0x1ca,0x33,start-7); write(0x1c0,offset,start-6); write(0x1c4,value,start-5);
    write(0x1ca,0x35,start-4); write(0x34,0xd8,start-1); write(0x1cb,1,start);
  }
  f.write(0x50,3,0); program(9,0x6c,10); assert.equal(nvm.activity.pending.completeCycle,20);
  f.select(1,14); // Six of ten reference clocks elapsed by the rate boundary (edge 16).
  assert.equal(nvm.activity.pending.completeCycle,80);
  nvm.advanceTo(79); assert.equal(storage.valid[9],0);
  nvm.advanceTo(80); assert.equal(storage.read(9),0x6c);
  program(10,0x91,100);
  assert.equal(nvm.activity.pending.completeCycle,260); // Ten reference clocks at 16x CPU speed.
  nvm.advanceTo(259); assert.equal(storage.valid[10],0);
  nvm.advanceTo(260); assert.equal(storage.read(10),0x91);
});

test('CLK reset clears selections, epochs and outstanding CCP permission and replays deterministically', () => {
  const f=fixture({rc32m:2});
  function run() {
    f.clk.reset(); f.osc.reset(); f.osc.releaseReset();
    const start=f.events.length;
    f.write(0x50,3,0); f.write(0x40,1,2); f.select(1,6);
    assert.deepEqual([f.clk.snapshot(10).cpuClockHz,f.clk.timeAt(10)],[32000000,2080]);
    f.write(0x34,0xd8,11);
    return f.events.slice(start);
  }
  assert.deepEqual(run(),run());
});
