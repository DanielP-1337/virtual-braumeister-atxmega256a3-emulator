import test from 'node:test';
import assert from 'node:assert/strict';
import { OscillatorController } from '../src/peripherals/oscillator.mjs';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

function fixture(startupCycles, words = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  for (const [i, word] of words.entries()) {
    flash.set([word & 255, word >>> 8], 2*i);
    present.fill(1, 2*i, 2*i + 2);
  }
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const osc = new OscillatorController({ startupCycles, onAccess: e => events.push(e) });
  osc.register(cpu.bus.mmio, { fault: (m,d) => cpu.fault(m,d), context: () => ({ pcWord: cpu.pc }) });
  return { cpu, osc, events, rd: (addr, cycle) => cpu.read(addr, cycle), wr: (addr, v, cycle) => cpu.write(addr, v, cycle) };
}

test('OSC register reset, CPU release and active 2 MHz source follow the XMEGA A reset sequence', () => {
  const { osc, rd, wr } = fixture();
  assert.deepEqual([rd(0x50,0), rd(0x51,0)], [1,0]);
  wr(0x50,7,0); wr(0x51,0xff,0);
  assert.deepEqual([rd(0x50,0), rd(0x51,0)], [1,0]);
  osc.releaseReset();
  assert.deepEqual([rd(0x50,0), rd(0x51,0)], [1,1]);
  wr(0x50,0,9);
  assert.equal(rd(0x50,9), 1);
  assert.equal(rd(0x51,9), 1);
});

test('OSC each ready bit first appears on its deadline, measured from the enable write', () => {
  for (const [enable, clocks] of [[2,12],[4,640]]) {
    const { osc, rd, wr } = fixture({ rc32m: 12, rc32k: 640 });
    osc.releaseReset();
    wr(0x50,1|enable,101);
    assert.equal(rd(0x50,101), 1|enable);
    for (let elapsed=0; elapsed<=clocks+2; elapsed++) {
      assert.equal(rd(0x51,101+elapsed), elapsed < clocks ? 1 : 1|enable);
    }
  }
});

test('OSC staggered enables and unrelated control writes preserve independent deadlines without polling', () => {
  const { osc, rd, wr } = fixture({ rc32m: 9, rc32k: 3 });
  osc.releaseReset(); wr(0x50,3,10); wr(0x50,7,12); wr(0x50,7,14);
  assert.deepEqual([rd(0x51,14),rd(0x51,15),rd(0x51,18),rd(0x51,19)], [1,5,5,7]);
  const another = fixture({ rc32m: 3, rc32k: 3 });
  another.osc.releaseReset(); another.wr(0x50,7,47);
  assert.equal(another.rd(0x51,50), 7);
});

test('OSC disabling cancels startup or clears readiness and reenabling starts a full new interval', () => {
  const { osc, rd, wr } = fixture({ rc32m: 8, rc32k: 3 });
  osc.releaseReset(); wr(0x50,7,0); wr(0x50,5,2);
  assert.equal(rd(0x51,3),5);
  wr(0x50,3,4); assert.equal(rd(0x51,8),1);
  wr(0x50,7,9);
  assert.deepEqual([rd(0x51,11),rd(0x51,12)], [1,7]);
  wr(0x50,1,12); assert.equal(rd(0x51,12),1);
  assert.deepEqual(osc.snapshot().enabledAt, {rc32m:null,rc32k:null});
});

test('OSC status writes and reserved bits have no effect, unsupported sources fault atomically', () => {
  const { osc, rd, wr, events } = fixture({ rc32m: 3, rc32k: 7 });
  osc.releaseReset(); wr(0x50,0xe3,2); wr(0x51,0xff,3);
  assert.deepEqual([rd(0x50,3),rd(0x51,3)], [3,1]);
  for (const v of [0x0d,0x15,0x1f]) {
    const prior = osc.snapshot();
    assert.throws(() => wr(0x50,v,4), e => e.classification === 'OSC_SOURCE_UNMODELED' && e.attemptedValue === v);
    assert.deepEqual(osc.snapshot(),prior);
    assert.equal(events.at(-1).completed,false);
  }
  assert.equal(rd(0x51,5),3);
  wr(0x51,0,6); assert.equal(rd(0x51,6),3);
});

test('OSC unspecified delays produce a classified unknown read only while the affected source is enabled', () => {
  const { osc, rd, wr, events } = fixture({ rc32m: 5 });
  osc.releaseReset(); wr(0x50,7,20);
  assert.equal(rd(0x50,25),7);
  assert.deepEqual([osc.snapshot().readyBits,osc.snapshot().unknownBits,osc.snapshot().status],[3,4,null]);
  assert.throws(() => rd(0x51,1000000), e => e.classification === 'OSC_STARTUP_TIMING_UNKNOWN' && e.addressByte === 0x51 && e.attemptedValue === null);
  assert.deepEqual([events.at(-1).completed,events.at(-1).value],[false,null]);
  wr(0x50,3,1000001); assert.equal(rd(0x51,1000001),3);
});

test('OSC registers occupy exactly two A3 byte addresses and collision checks install neither partially', () => {
  const { rd, wr, osc } = fixture();
  for (const addr of [0x0040,0x004f,0x0052,0x0056]) {
    assert.throws(() => rd(addr,0), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr);
    assert.throws(() => wr(addr,0xff,0), e => e.classification === 'UNHANDLED_MMIO');
  }
  for (const addr of [0x50,0x51]) {
    const r=new MMIORegistry(); r.map(addr,{read:()=>17});
    assert.throws(() => new OscillatorController().register(r),/collision/);
    assert.deepEqual([...r.handlers.keys()],[addr]);
  }
  assert.throws(() => osc.register(new MMIORegistry()),/collision/);
});

test('OSC AVRxm STS and LDS use the bus clock edge, with polling independent of instruction count', () => {
  // STS 0x50,R16, LDS R17,0x51, NOP, LDS R18,0x51.
  const { cpu, osc, events } = fixture({ rc32m:3,rc32k:11 },[0x9300,0x0050,0x9110,0x0051,0x0000,0x9120,0x0051]);
  cpu.r[16]=3; cpu.sreg=0xa5; osc.releaseReset();
  for(let n=0;n<4;n++) cpu.step();
  assert.deepEqual([cpu.r[17],cpu.r[18],cpu.pc,cpu.steps,cpu.cycles,cpu.sreg],[1,3,7,4,5,0xa5]);
  assert.deepEqual(events.map(e=>[e.pcWord,e.cycle,e.addressByte,e.kind,e.value]),[[0,2,0x50,'write',3],[2,3,0x51,'read',1],[5,5,0x51,'read',3]]);
});

test('OSC reset and replay cancel previous schedules and validate the CPU time base', () => {
  const { osc, rd, wr, events } = fixture({rc32m:4,rc32k:9});
  function sequence() {
    osc.reset(); const start=events.length;
    assert.equal(rd(0x51,0),0); osc.releaseReset(); wr(0x50,7,10);
    for (const cycle of [10,13,14,18,19,100]) rd(0x51,cycle);
    return events.slice(start);
  }
  assert.deepEqual(sequence(),sequence());
  assert.throws(() => rd(0x51,99), /monotonic/);
  for(const delay of [-1,0,2.3,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => new OscillatorController({startupCycles:{rc32m:delay}}),/startup delay/);
});
