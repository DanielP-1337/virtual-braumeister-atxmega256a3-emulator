import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCD1Period } from '../src/peripherals/tcd1-period.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';
import { TC0WaveformControl } from '../src/peripherals/tc0-ctrlb.mjs';

// Data-byte addresses from the independent non-U ATxmega256A3 device description.
const D1_TEMP = 0x094f, D1_LOW = 0x0966, D1_HIGH = 0x0967;
const D0_CLK = 0x0900, D0_MODE = 0x0901, D0_TEMP = 0x090f, D0_LOW = 0x0926, D0_HIGH = 0x0927;

function fixture(words = [], record = false) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const view = new DataView(flash.buffer);
  words.forEach((word, i) => view.setUint16(2 * i, word, true));
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, d0Log = [], d1Log = [];
  const opts = { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }), fault: (reason, details) => cpu.fault(reason, details) };
  const onD0 = record ? event => d0Log.push(event) : null;
  const d0 = new TC0Counter('TCD0', { onAccess: onD0 }), clock = new TC0Clock('TCD0', { counter: d0, onAccess: onD0 });
  d0.register(bus.mmio, { ...opts, mapPeriod: true, mapCompareC: true, mapCompareD: true });
  clock.register(bus.mmio, opts);
  new TC0WaveformControl('TCD0', { clock, onAccess: onD0 }).register(bus.mmio, opts);
  const d1 = new TCD1Period({ onAccess: record ? event => d1Log.push(event) : null });
  d1.register(bus.mmio, opts);
  return { cpu, bus, d0, clock, d1, d0Log, d1Log };
}

function writeWord(bus, address, value, cycle = 0) {
  bus.write(address, value % 256, cycle);
  bus.write(address + 1, Math.floor(value / 256), cycle);
}

test('TCD1 period owns exactly TEMP, PERL and PERH and exposes their reset and high-first read behavior', () => {
  const { bus, d1 } = fixture();
  assert.deepEqual([...bus.mmio.handlers.keys()].filter(a => a >= 0x0940), [D1_TEMP, D1_LOW, D1_HIGH]);
  assert.deepEqual(d1.snapshotPeriod(), { per: 65535, temp: 0 });
  assert.deepEqual([bus.read(D1_TEMP), bus.read(D1_HIGH)], [0, 0]);
  assert.deepEqual([bus.read(D1_LOW), bus.read(D1_HIGH), bus.read(D1_TEMP)], [255, 255, 255]);
  for (const addr of [0x0940, 0x094e, 0x0950, 0x0960, 0x0965, 0x0968, 0x0976, 0x0978, 0x097c]) {
    for (const kind of ['read', 'write']) assert.throws(() => kind === 'read' ? bus.read(addr) : bus.write(addr, 0),
      e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr && e.accessKind === kind);
  }
});

test('TCD1 period stages, commits and reads every 16-bit word while the running D0 keeps another period and a pending low byte', () => {
  const { bus, cpu, d0, d1, clock } = fixture();
  writeWord(bus, D0_LOW, 0x1234); bus.write(D0_LOW, 0x9b);
  bus.write(D0_MODE, 0xc3); bus.write(D0_CLK, 3); // clkPER/4.
  let previous = 0xffff;
  for (let expected = 0; expected < 65536; expected++) {
    const low = expected % 256, high = Math.floor(expected / 256), cycle = expected * 2;
    bus.write(D1_LOW, low, cycle);
    assert.deepEqual(d1.snapshotPeriod(), { per: previous, temp: low });
    bus.write(D1_HIGH, high, cycle + 1);
    assert.deepEqual(d1.snapshotPeriod(), { per: expected, temp: low });
    assert.deepEqual([bus.read(D1_LOW, cycle + 1), bus.read(D1_HIGH, cycle + 1), bus.read(D1_TEMP, cycle + 1)], [low, high, high]);
    clock.advanceTo(cycle + 1);
    assert.equal(d0.per, 0x1234);
    assert.equal(d0.temp, 0x9b);
    previous = expected;
    cpu.accesses.length = 0;
  }
  assert.equal(d0.cnt, Math.floor(131071 / 4) % (0x1234 + 1));
  bus.write(D0_HIGH, 1, 131072);
  assert.deepEqual([d0.per, d1.per], [0x019b, 0xffff]);
});

test('TCD1 period interleaved high-byte commits in either order keep both timer words and TEMP bytes distinct', () => {
  for (const first of ['D0', 'D1']) {
    const { bus, d0, d1, clock } = fixture();
    writeWord(bus, D0_LOW, 0x0b55); writeWord(bus, D1_LOW, 0x4c33); bus.write(D0_CLK, 1);
    bus.write(D0_LOW, 0x91, 2); bus.write(D1_LOW, 0x72, 3);
    assert.deepEqual([d0.per, d1.per, d0.temp, d1.temp], [0x0b55, 0x4c33, 0x91, 0x72]);
    if (first === 'D0') {
      bus.write(D0_HIGH, 0x24, 4); bus.write(D1_HIGH, 0x36, 5);
    } else {
      bus.write(D1_HIGH, 0x36, 4); bus.write(D0_HIGH, 0x24, 5);
    }
    clock.advanceTo(5);
    assert.deepEqual([d0.per, d1.per, d0.temp, d1.temp, d0.cnt], [0x2491, 0x3672, 0x91, 0x72, 5]);
    assert.deepEqual([bus.read(D0_LOW, 5), bus.read(D1_LOW, 5), bus.read(D1_HIGH, 5), bus.read(D0_HIGH, 5)], [0x91, 0x72, 0x36, 0x24]);
  }
});

test('TCD1 period low reads latch the active high byte and direct TEMP or repeated low writes select the local commit byte', () => {
  const { bus, d0, d1 } = fixture();
  bus.write(D1_HIGH, 0x57);
  assert.equal(d1.per, 0x5700);
  writeWord(bus, D1_LOW, 0xab34); bus.write(D1_LOW, 0x55);
  assert.equal(bus.read(D1_HIGH), 0x55);
  bus.write(0x0920, 0x93); // D0.CNTL uses D0 TEMP.
  assert.equal(bus.read(D1_LOW), 0x34);
  bus.write(0x093c, 0xf1); // D0.CCCBUFL replaces only D0's staged low byte.
  assert.deepEqual([bus.read(D1_HIGH), bus.read(D0_TEMP)], [0xab, 0xf1]);
  bus.write(D1_HIGH, 0x77);
  assert.equal(d1.per, 0x77ab);
  bus.write(D1_LOW, 0x31); bus.write(D1_LOW, 0x62); bus.write(D1_HIGH, 0x29);
  assert.equal(d1.per, 0x2962);
  bus.write(D1_TEMP, 0xee); bus.write(D1_HIGH, 0x40);
  assert.deepEqual([d1.per, d1.temp, d0.per, d0.temp], [0x40ee, 0xee, 0xffff, 0xf1]);
});

test('TCD1 period writes straddle a live D0 PWM rollover with identical D0 counts, TEMP, compare flags and bus events', () => {
  function run(accessD1) {
    const { bus, d0, d1, clock, d0Log } = fixture([], true);
    writeWord(bus, D0_LOW, 3); writeWord(bus, 0x093c, 0x5511); writeWord(bus, 0x093e, 0x6622);
    bus.write(D0_LOW, 0x5d); // Leave another period write pending on D0.
    bus.write(D0_MODE, 0xc3); bus.write(D0_CLK, 3);
    writeWord(bus, D1_LOW, 0xbeef);
    const history = [];
    for (const cycle of [11, 12, 15, 16, 17, 19]) {
      if (accessD1 && cycle === 12) bus.write(D1_LOW, 0x6e, cycle);
      if (accessD1 && cycle === 16) bus.write(D1_HIGH, 0x35, cycle);
      clock.advanceTo(cycle);
      history.push([d0.cnt, d0.per, d0.temp, d0.compare.ccc, d0.compare.ccd, d0.compare.validFlags()]);
      if (accessD1 && cycle >= 12) assert.deepEqual(d1.snapshotPeriod(), { per: cycle < 16 ? 0xbeef : 0x356e, temp: 0x6e });
    }
    return { history, d0Log };
  }
  const withStores = run(true);
  assert.deepEqual(withStores, run(false));
  assert.deepEqual(withStores.history, [
    [2,3,0x5d,0,0,0x18], [3,3,0x5d,0,0,0x18], [3,3,0x5d,0,0,0x18],
    [0,3,0x5d,0x5511,0x6622,0], [0,3,0x5d,0x5511,0x6622,0], [0,3,0x5d,0x5511,0x6622,0],
  ]);
});

test('TCD1 period resets locally while D0 is running and D0 reset preserves the pending D1 byte', () => {
  const { bus, d0, clock, d1 } = fixture();
  writeWord(bus, D0_LOW, 7); bus.write(D0_CLK, 1); bus.write(D0_LOW, 0xa7, 1);
  writeWord(bus, D1_LOW, 0x3412, 2); bus.write(D1_LOW, 0xee, 3);
  d1.reset(); clock.advanceTo(4);
  assert.deepEqual([d1.per, d1.temp, d0.cnt, d0.per, d0.temp, clock.ctrla], [0xffff, 0, 4, 7, 0xa7, 1]);
  bus.write(D1_HIGH, 0xab, 4); bus.write(D1_LOW, 0x58, 5);
  d0.reset(6);
  assert.deepEqual([d0.cnt, d0.per, d0.temp, clock.ctrla, d1.per, d1.temp], [0, 0xffff, 0, 0, 0xab00, 0x58]);
  bus.write(D1_HIGH, 0xac, 7);
  assert.equal(d1.per, 0xac58);
});

test('TCD1 period registration preflights each address and rejects repeated registration without changing either bus', () => {
  assert.throws(() => new TC0Counter('TCD1'), /Unsupported TC0/);
  for (const address of [D1_TEMP, D1_LOW, D1_HIGH]) {
    const registry = new MMIORegistry(), sentinel = { read: () => 9 }, instance = new TCD1Period();
    registry.map(address, sentinel);
    assert.throws(() => instance.register(registry), /collision/);
    assert.deepEqual([...registry.handlers], [[address, sentinel]]);
    const fresh = new MMIORegistry(), third = new MMIORegistry();
    instance.register(fresh);
    assert.throws(() => instance.register(third), /collision/);
    assert.equal(third.handlers.size, 0);
    assert.deepEqual([...fresh.handlers.keys()], [D1_TEMP, D1_LOW, D1_HIGH]);
  }
});

test('TCD1 period interleaved AVR loads and stores preserve word PC, cycles, CPU state and both byte-level traces', () => {
  function run() {
    const words = [0xa34e, 0xa326, 0xa35f, 0xa337, 0xa186, 0xa197, 0xa16e, 0xa17f];
    const { cpu, bus, clock, d0, d1, d1Log, d0Log } = fixture(words, true);
    cpu.setPair(28, 0x0900); cpu.setPair(30, 0x0940); cpu.sreg = 0xb5;
    cpu.r[18] = 0x92; cpu.r[19] = 0x47; cpu.r[20] = 0x35; cpu.r[21] = 0x6a;
    bus.write(D0_CLK, 1);
    const steps = words.map(() => cpu.step());
    assert.deepEqual(steps.map(s => s.mnemonic), ['STD','STD','STD','STD','LDD','LDD','LDD','LDD']);
    assert.deepEqual(steps.map(s => [s.after.pcWord, s.after.cycles]), [[1,2],[2,4],[3,6],[4,8],[5,10],[6,12],[7,14],[8,16]]);
    assert.deepEqual([cpu.r[24],cpu.r[25],cpu.r[22],cpu.r[23],cpu.pair(28),cpu.pair(30),cpu.sreg,cpu.sp], [0x92,0x47,0x35,0x6a,0x900,0x940,0xb5,0x5fff]);
    clock.advanceTo(cpu.cycles);
    assert.deepEqual([d0.cnt,d0.per,d0.temp,d1.per,d1.temp], [16,0x6a35,0x6a,0x4792,0x47]);
    assert.deepEqual(d1Log.map(e => [e.pcWord,e.cycle,e.register,e.kind,e.value]), [
      [1,4,'PERL','write',0x92], [3,8,'PERH','write',0x47], [4,10,'PERL','read',0x92], [5,12,'PERH','read',0x47],
    ]);
    assert.ok(d1Log.every(e => e.peripheral === 'TCD1' && e.completed && e.origin === 'peripheral-model'));
    assert.deepEqual(d1Log.map(e => e.after.per), [0xffff,0x4792,0x4792,0x4792]);
    return { steps, d0Log, d1Log };
  }
  assert.deepEqual(run(), run());
});

test('TCD1 period faults precisely on an adjacent buffer store and preserves the low byte pending on each timer', () => {
  const { cpu, bus, d0, d1, d0Log, d1Log } = fixture([0xaf40, 0], true); // STD Z+56,R20
  cpu.setPair(30, 0x0940); cpu.r[20] = 0x72;
  writeWord(bus, D0_LOW, 0x1365); bus.write(D0_LOW, 0x2c); bus.write(D0_CLK, 1);
  writeWord(bus, D1_LOW, 0x2487); bus.write(D1_LOW, 0x4d);
  const before = cpu.state(), events = [d0Log.length, d1Log.length];
  assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x0978 && e.attemptedValue === 0x72);
  assert.deepEqual(cpu.state(), before);
  assert.deepEqual([d0Log.length, d1Log.length], events);
  assert.deepEqual([d0.per,d0.temp,d1.per,d1.temp], [0x1365,0x2c,0x2487,0x4d]);
});
