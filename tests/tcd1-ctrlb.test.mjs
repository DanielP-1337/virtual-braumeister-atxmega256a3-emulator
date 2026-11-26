import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCD1Period } from '../src/peripherals/tcd1-period.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';
import { TC0WaveformControl } from '../src/peripherals/tc0-ctrlb.mjs';

// Non-U ATxmega256A3 byte addresses, independently of the model. XMEGA A sections 14.5 and 14.12.2.
const CLK = 0x0940, MODE = 0x0941, FCLR = 0x0948, FSET = 0x0949, GCLR = 0x094a, GSET = 0x094b;
const TEMP = 0x094f, PER = 0x0966, CCA = 0x0968, CCB = 0x096a, ABUF = 0x0978, BBUF = 0x097a;
const AV = 2, BV = 4, LOCK = 2, FORCE = 4;

function fixture({ words = [], mapCtrlb = true, record = false } = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const view = new DataView(flash.buffer);
  words.forEach((word, i) => view.setUint16(i * 2, word, true));
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), timer = new TCD1Period(), events = [];
  timer.register(cpu.bus.mmio, {
    mapCtrlb, mapCompareA: true, mapCompareB: true,
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (message, details) => cpu.fault(message, details),
    onCtrlbAccess: record ? e => events.push(e) : null,
  });
  return { cpu, bus: cpu.bus, timer, events };
}

function put(bus, address, word) {
  bus.write(address, word % 256);
  bus.write(address + 1, Math.floor(word / 256));
}

function word(bus, address) {
  return bus.read(address) + 256 * bus.read(address + 1);
}

function configure(bus, period = 3) {
  put(bus, PER, period);
  put(bus, CCA, 0x1731); put(bus, CCB, 0x2862);
  put(bus, ABUF, 0x31a7); put(bus, BBUF, 0x42b8);
}

function state(bus, timer) {
  return [timer.cnt, word(bus, CCA), word(bus, CCB), bus.read(GCLR)];
}

test('TCD1 CTRLB resets to zero, registers only its own byte and preflights collisions atomically', () => {
  const { bus, timer } = fixture(), legacy = fixture({ mapCtrlb: false });
  assert.equal(bus.read(MODE), 0);
  assert.deepEqual(timer.waveform.snapshot(), { ctrlb: 0, wgmode: 0, channelEnables: 0 });
  const extra = [...bus.mmio.handlers.keys()].filter(a => !legacy.bus.mmio.handlers.has(a));
  assert.deepEqual(extra, [MODE]);
  for (const addr of [CLK, MODE + 1, 0x0960, 0x0961]) {
    assert.throws(() => bus.write(addr, 0x01), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr);
    assert.throws(() => bus.read(addr), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr);
  }
  assert.throws(() => legacy.bus.write(MODE, 0x33), e => e.classification === 'UNHANDLED_MMIO');
  const mmio = new MMIORegistry(), other = new TCD1Period(), sentinel = { read: () => 0x48 };
  mmio.map(MODE, sentinel);
  assert.throws(() => other.register(mmio, { mapCompareA:true, mapCompareB:true, mapCtrlb:true }), /collision/);
  assert.deepEqual([...mmio.handlers], [[MODE,sentinel]]);
  assert.equal(other.waveform, undefined);
  configure(bus); bus.write(MODE, 0x33); timer.countUp(2); timer.reset();
  assert.deepEqual([bus.read(MODE), timer.cnt, word(bus, PER), bus.read(GCLR)], [0,0,0xffff,0]);
});

test('TCD1 CTRLB classifies all 256 writes, masks reserved bits and preserves state on unsupported modes', () => {
  const { bus, timer, events } = fixture({ record:true });
  const faults = [null,'TCD1_WAVEFORM_MODE_UNMODELED','TCD1_RESERVED_WGMODE',null,
    'TCD1_RESERVED_WGMODE','TCD1_WAVEFORM_MODE_UNMODELED','TCD1_WAVEFORM_MODE_UNMODELED','TCD1_WAVEFORM_MODE_UNMODELED'];
  configure(bus);
  for (let raw = 0; raw < 256; raw++) {
    const mode = raw % 8, enables = Math.floor(raw / 16) % 4, before = timer.waveform.snapshot();
    if (faults[mode]) {
      assert.throws(() => bus.write(MODE, raw, 8), e => e.classification === faults[mode] && e.addressByte === MODE && e.attemptedValue === raw);
      const last = events.at(-1);
      assert.deepEqual([last.completed,last.before,last.after,timer.waveform.snapshot()], [false,before,before,before]);
    } else {
      bus.write(MODE, raw, 8);
      const expected = { ctrlb: enables * 16 + mode, wgmode: mode, channelEnables: enables };
      assert.deepEqual(timer.waveform.snapshot(), expected);
      assert.equal(bus.read(MODE, 8), expected.ctrlb);
      assert.equal(timer.waveform.updateAtBottom, mode === 3);
    }
    assert.deepEqual(state(bus,timer), [0,0x1731,0x2862,AV | BV]);
  }
});

test('TCD1 CTRLB 0x33 transfers both distinct buffers only on the TOP-to-BOTTOM transition', () => {
  const { bus, timer } = fixture();
  configure(bus, 3); bus.write(MODE, 0x33);
  assert.deepEqual(timer.waveform.snapshot(), { ctrlb:0x33, wgmode:3, channelEnables:3 });
  assert.equal(timer.countUp(0), false);
  for (const cnt of [1,2,3]) {
    assert.equal(timer.countUp(1), false);
    assert.deepEqual(state(bus,timer), [cnt,0x1731,0x2862,AV | BV]);
  }
  assert.equal(timer.countUp(1), true);
  assert.deepEqual(state(bus,timer), [0,0x31a7,0x42b8,0]);
  assert.deepEqual([word(bus, ABUF),word(bus, BBUF),word(bus, PER)], [0x31a7,0x42b8,3]);
  put(bus, CCB, 0x715e); timer.countUp(4);
  assert.deepEqual(state(bus,timer), [0,0x31a7,0x715e,0]);
});

test('TCD1 CTRLB selects the update edge independently of the two enables and the four validity combinations', () => {
  for (const enables of [0,0x10,0x20,0x30]) for (const valid of [0,AV,BV,AV | BV]) {
    const { bus,timer } = fixture();
    configure(bus, 2); bus.write(GCLR, AV | BV); bus.write(GSET, valid); bus.write(MODE, enables + 3);
    timer.countUp(2);
    assert.deepEqual(state(bus,timer), [2,0x1731,0x2862,valid]);
    timer.countUp(1);
    assert.deepEqual(state(bus,timer), [0,valid & AV ? 0x31a7 : 0x1731,valid & BV ? 0x42b8 : 0x2862,0]);
  }
});

test('TCD1 CTRLB respects LUPD through BOTTOM, independent validity, and an explicit software UPDATE', () => {
  const { bus,timer } = fixture();
  configure(bus); bus.write(MODE,0x33); bus.write(FSET,LOCK);
  timer.countUp(4); bus.write(FSET, FORCE);
  assert.deepEqual(state(bus,timer), [0,0x1731,0x2862,AV | BV]);
  bus.write(GCLR, AV); bus.write(FCLR,LOCK); timer.countUp(3);
  assert.deepEqual(state(bus,timer), [3,0x1731,0x2862,BV]);
  timer.countUp(1);
  assert.deepEqual(state(bus,timer), [0,0x1731,0x42b8,0]);
  bus.write(GSET,AV); timer.countUp(1); bus.write(FSET,FORCE);
  assert.deepEqual(state(bus,timer), [1,0x31a7,0x42b8,0]);
});

test('TCD1 CTRLB mode writes preserve count and never generate UPDATE simply by selecting PWM or NORMAL', () => {
  const { bus, timer } = fixture();
  configure(bus); bus.write(MODE,0x33,2);
  bus.read(MODE,400000); bus.write(MODE,0x33,800000);
  assert.deepEqual(state(bus,timer), [0,0x1731,0x2862,AV | BV]); // CPU bus cycles alone give no timer input edges.
  timer.countUp(2); bus.write(MODE,0x30);
  assert.deepEqual(state(bus,timer), [2,0x1731,0x2862,AV | BV]);
  timer.countUp(1); // NORMAL updates on reaching TOP.
  assert.deepEqual(state(bus,timer), [3,0x31a7,0x42b8,0]);
  put(bus, BBUF, 0xaa17); bus.write(MODE,0x33);
  assert.deepEqual(state(bus,timer), [3,0x31a7,0x42b8,BV]);
  timer.countUp(1);
  assert.deepEqual(state(bus,timer), [0,0x31a7,0xaa17,0]);
});

test('TCD1 CTRLB batched edges match a one-edge oracle at period boundaries and after missing TOP', () => {
  for (const period of [0,1,5,0xffff]) for (const start of [0,7,0xfffc]) {
    const { bus,timer } = fixture();
    put(bus,PER,0xffff); bus.write(MODE,0x33); timer.countUp(start);
    put(bus,PER,period);
    let expected = start;
    for (const edges of [0,1,2,4,13,65538,131079]) {
      put(bus,CCB,0x28e6); put(bus,BBUF,0x3a52);
      let reached = false;
      for (let i=0; i<edges; i++) {
        expected = expected === period ? 0 : (expected + 1) % 65536;
        if (expected === 0) reached = true;
      }
      assert.equal(timer.countUp(edges), reached);
      assert.deepEqual([timer.cnt,word(bus,CCB),bus.read(GCLR)], [expected,reached ? 0x3a52 : 0x28e6,reached ? 0 : BV]);
    }
    const before = state(bus,timer);
    for (const invalid of [-1,0.25,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => timer.countUp(invalid), RangeError);
      assert.deepEqual(state(bus,timer),before);
    }
  }
});

test('TCD1 CTRLB BOTTOM consumes only full valid words and preserves a replacement low byte in CPU TEMP', () => {
  const { bus,timer } = fixture();
  configure(bus,2); bus.write(MODE,0x33); timer.countUp(2);
  bus.write(BBUF,0x5a);
  timer.countUp(1);
  assert.equal(bus.read(TEMP),0x5a);
  bus.write(BBUF+1,0xb4);
  assert.deepEqual(state(bus,timer), [0,0x31a7,0x42b8,BV]);
  timer.countUp(2);
  assert.deepEqual(state(bus,timer), [2,0x31a7,0x42b8,BV]);
  timer.countUp(1);
  assert.deepEqual(state(bus,timer), [0,0x31a7,0xb45a,0]);
});

test('TCD1 CTRLB routes A to PD4 and B to PD5 only in PWM and respects pin direction and the GPIO latch', () => {
  const { bus,timer } = fixture();
  const gpio = new GPIOController({ unresolvedOutputSource: (port,pin) => timer.waveform.outputSource(port,pin) });
  gpio.register(bus.mmio);
  bus.write(0x0660,0xff); bus.write(0x0664,0x95);
  for (const mode of [0,3]) for (const enables of [0,1,2,3]) {
    bus.write(MODE, enables * 16 + mode);
    for (let pin=0; pin<8; pin++) {
      const pad = gpio.drive('D',pin), latch = (0x95 >>> pin) & 1;
      const routed = mode === 3 && ((pin === 4 && (enables & 1)) || (pin === 5 && (enables & 2)));
      assert.deepEqual([pad.source,pad.latch,pad.drive,pad.highImpedance],
        [routed ? ['TCD1.OC1A','TCD1.OC1B'][pin-4] : undefined,latch,routed ? 'unresolved' : latch,false]);
    }
  }
  assert.equal(gpio.drive('C',4).source,undefined);
  bus.write(0x0662,0x10);
  assert.deepEqual([gpio.drive('D',4).source,gpio.drive('D',4).highImpedance,gpio.drive('D',5).source],[undefined,true,'TCD1.OC1B']);
  assert.equal(bus.read(0x0664),0x95);
  assert.throws(() => bus.read(0x0668), e => e.classification === 'GPIO_UNRESOLVED_INPUT');
});

test('TCD1 CTRLB and the running TCD0 have independent BOTTOM events and output routing on port D', () => {
  const { bus,timer } = fixture();
  const d0 = new TC0Counter('TCD0'), clock = new TC0Clock('TCD0',{ counter:d0 });
  d0.register(bus.mmio,{ mapPeriod:true,mapCompareC:true,mapCompareD:true }); clock.register(bus.mmio);
  const mode0 = new TC0WaveformControl('TCD0',{ clock }); mode0.register(bus.mmio);
  const gpio = new GPIOController({ unresolvedOutputSource: (port,pin) => mode0.outputSource(port,pin) ?? timer.waveform.outputSource(port,pin) });
  gpio.register(bus.mmio); bus.write(0x0660,0xff);
  put(bus,0x0926,3); put(bus,0x093c,0x7651); bus.write(0x0901,0xc3); bus.write(0x0900,1);
  configure(bus,2); bus.write(MODE,0x33,2);
  clock.advanceTo(4);
  assert.deepEqual([d0.cnt,d0.compare.ccc,d0.compare.validFlags(),...state(bus,timer)], [0,0x7651,0,0,0x1731,0x2862,AV | BV]);
  assert.deepEqual([2,3,4,5].map(pin=>gpio.drive('D',pin).source), ['TCD0.OC0C','TCD0.OC0D','TCD1.OC1A','TCD1.OC1B']);
  bus.write(0x093c,0x17,4); bus.write(0x093d,0x5b,4);
  timer.countUp(3);
  assert.deepEqual([d0.cnt,d0.compare.ccc,d0.compare.validFlags(),...state(bus,timer)], [0,0x7651,8,0,0x31a7,0x42b8,0]);
});

test('TCD1 CTRLB AVR register writes and readback replay deterministically up to an unmapped clock or invalid mode', () => {
  function run() {
    // STD Y+1,R20, LDD R22,Y+1, ST Z,R21. Y and Z both address the TC1 base.
    const { cpu,bus,timer,events } = fixture({ words:[0x8349,0x8169,0x8350],record:true });
    cpu.setPair(28,CLK); cpu.setPair(30,CLK); cpu.r[20]=0x33; cpu.r[21]=1; cpu.sreg=0xa5;
    configure(bus); const steps = [cpu.step(),cpu.step()];
    assert.deepEqual(steps.map(s=>[s.mnemonic,s.after.pcWord,s.after.cycles]), [['STD',1,2],['LDD',2,4]]);
    assert.deepEqual([cpu.r[22],cpu.pair(28),cpu.pair(30),cpu.sp,cpu.sreg], [0x33,CLK,CLK,0x5fff,0xa5]);
    assert.deepEqual(events.map(e=>[e.kind,e.value,e.pcWord,e.instructionAttempt,e.cycle,e.before.ctrlb,e.after.ctrlb]),
      [['write',0x33,0,1,2,0,0x33],['read',0x33,1,2,4,0x33,0x33]]);
    assert.ok(events.every(e=>e.origin === 'peripheral-model' && e.peripheral === 'TCD1' && e.register === 'CTRLB' && e.addressByte === MODE && e.completed));
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === CLK && e.attemptedValue === 1);
    assert.deepEqual(cpu.state(),before); assert.equal(events.length,2);
    assert.deepEqual(state(bus,timer),[0,0x1731,0x2862,AV | BV]);
    return { steps,events };
  }
  assert.deepEqual(run(),run());
  const bad = fixture({ words:[0x8349],record:true });
  bad.cpu.setPair(28,CLK); bad.cpu.r[20]=0x32;
  const before = bad.cpu.state();
  assert.throws(() => bad.cpu.step(), e => e.classification === 'TCD1_RESERVED_WGMODE' && e.addressByte === MODE);
  assert.deepEqual(bad.cpu.state(),before); assert.equal(bad.events[0].completed,false);
});
