import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCC0Counter } from '../src/peripherals/tcc0-counter.mjs';
import { TCC0Clock } from '../src/peripherals/tcc0-clock.mjs';

// Device data-byte addresses. XMEGA A §§3.11, 14.6.1, 14.6.4 and 14.12.11–15.
const CTRLA = 0x0800, TEMP = 0x080f, CNTL = 0x0820, CNTH = 0x0821, PERL = 0x0826, PERH = 0x0827;

function fixture(words = [], record = false) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, index) => {
    flash[2 * index] = word & 0xff;
    flash[2 * index + 1] = word >>> 8;
  });
  present.fill(1, 0, 2 * words.length);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const counter = new TCC0Counter(), clock = new TCC0Clock({ counter });
  counter.register(cpu.bus.mmio, {
    mapPeriod: true, onPeriodAccess: record ? event => events.push(event) : null,
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
  });
  clock.register(cpu.bus.mmio);
  return { cpu, bus: cpu.bus, counter, clock, events };
}

function writeWord(bus, lowAddress, word, cycle) {
  bus.write(lowAddress, word & 255, cycle);
  bus.write(lowAddress + 1, word >>> 8, cycle);
}

test('TCC0 period resets the active word to FFFF and uses the CPU TEMP latch on readback', () => {
  const { bus, counter, clock, events } = fixture([], true);
  assert.deepEqual(counter.snapshotPeriod(), { per: 65535, cnt: 0, temp: 0 });
  assert.equal(bus.read(PERH), 0); // High-byte reads return the shared latch.
  assert.deepEqual([bus.read(PERL), bus.read(PERH)], [255, 255]);
  writeWord(bus, PERL, 0x1234, 0);
  bus.write(PERL, 0x91, 1);
  bus.write(CTRLA, 6, 2);
  const accesses = events.length;
  counter.reset();
  assert.equal(events.length, accesses);
  assert.deepEqual(counter.snapshotPeriod(), { per: 65535, cnt: 0, temp: 0 });
  assert.deepEqual(clock.snapshot(0), { ctrla: 0, divider: 0 });
});

test('TCC0 period stages and atomically commits all 65536 possible words', () => {
  const { bus, counter, cpu } = fixture();
  let previous = 0xffff;
  for (let high = 0; high < 256; high++) {
    for (let low = 0; low < 256; low++) {
      const word = 256 * high + low;
      bus.write(PERL, low);
      assert.equal(counter.snapshotPeriod().per, previous);
      assert.equal(bus.read(TEMP), low);
      bus.write(PERH, high);
      assert.equal(counter.snapshotPeriod().per, word);
      assert.equal(bus.read(PERL), low);
      assert.equal(bus.read(PERH), high);
      previous = word;
      cpu.accesses.length = 0;
    }
  }
});

test('TCC0 period and CNT interfere through exactly one CPU temporary byte', () => {
  const { bus, counter } = fixture();
  bus.write(PERH, 0x81); // Reset TEMP supplies the low byte.
  assert.equal(counter.snapshotPeriod().per, 0x8100);
  writeWord(bus, CNTL, 0x34b2, 0);
  bus.write(PERL, 0x6a);
  assert.equal(bus.read(CNTL), 0xb2); // Replaces staged 0x6a with 0x34.
  bus.write(PERH, 0x42);
  assert.deepEqual(counter.snapshotPeriod(), { per: 0x4234, cnt: 0x34b2, temp: 0x34 });
  bus.write(CNTL, 0x17);
  assert.equal(bus.read(PERH), 0x17);
  bus.write(PERH, 0x55);
  assert.equal(bus.read(PERL), 0x17); // Snapshots the high byte of PER.
  bus.write(CNTH, 0x12);
  assert.deepEqual(counter.snapshotPeriod(), { per: 0x5517, cnt: 0x1255, temp: 0x55 });
  bus.write(TEMP, 0xe4);
  bus.write(PERH, 0x73);
  assert.deepEqual(counter.snapshotPeriod(), { per: 0x73e4, cnt: 0x1255, temp: 0xe4 });
});

test('TCC0 period 007D holds TOP for one divided tick and repeats every 126 ticks', () => {
  const { bus, counter, clock } = fixture();
  writeWord(bus, PERL, 125, 0);
  bus.write(CTRLA, 6, 19); // The shared prescaler phase starts at the reset epoch.
  for (let tick = 1; tick <= 253; tick++) {
    clock.snapshot(256 * tick - 1);
    assert.equal(counter.snapshot().cnt, (tick - 1) % 126);
    clock.snapshot(256 * tick);
    assert.equal(counter.snapshot().cnt, tick % 126);
  }
});

test('TCC0 period high write takes effect on completion while low writes leave the old TOP active', () => {
  const { bus, clock, counter } = fixture();
  writeWord(bus, PERL, 3, 0);
  bus.write(CTRLA, 1, 0);
  bus.write(PERL, 5, 2);
  bus.write(PERL, 6, 3); // Old TOP reached; latest staged byte wins.
  assert.deepEqual(counter.snapshotPeriod(), { per: 3, cnt: 3, temp: 6 });
  bus.write(PERH, 0, 4); // Old TOP clears on this edge; subsequent edges see TOP=6.
  assert.deepEqual(counter.snapshotPeriod(), { per: 6, cnt: 0, temp: 6 });
  clock.snapshot(10);
  assert.equal(counter.snapshot().cnt, 6);
  clock.snapshot(11);
  assert.equal(counter.snapshot().cnt, 0);
  bus.write(PERL, 3, 13);
  bus.write(PERH, 0, 14); // New TOP equals current CNT.
  assert.deepEqual(counter.snapshotPeriod(), { per: 3, cnt: 3, temp: 3 });
  clock.snapshot(15);
  assert.equal(counter.snapshot().cnt, 0);
});

test('TCC0 period below the live counter misses TOP and wraps through FFFF before using the new range', () => {
  const { bus, clock, counter } = fixture();
  bus.write(CTRLA, 1, 0);
  writeWord(bus, PERL, 2, 10);
  assert.deepEqual(counter.snapshotPeriod(), { per: 2, cnt: 10, temp: 2 });
  for (const [cycle, count] of [[11,11],[65534,65534],[65535,65535],[65536,0],[65537,1],[65538,2],[65539,0]]) {
    clock.snapshot(cycle);
    assert.equal(counter.snapshot().cnt, count);
  }
});

test('TCC0 period sparse advancement agrees with individual edges for boundary TOP and CNT values', () => {
  const { bus, clock, counter } = fixture();
  for (const top of [0, 1, 2, 125, 0x1234, 0xfffe, 0xffff]) {
    for (const start of [0, top, 0xfffd, 0xffff]) {
      counter.reset();
      writeWord(bus, PERL, top, 0);
      writeWord(bus, CNTL, start, 0);
      bus.write(CTRLA, 1, 0);
      let expected = start, cycle = 0;
      for (const steps of [1, 17, 0xfffd, 1, 130003]) {
        for (let tick = 0; tick < steps; tick++) {
          expected = expected === top ? 0 : (expected + 1) & 0xffff;
        }
        cycle += steps;
        clock.snapshot(cycle);
        assert.equal(counter.snapshot().cnt, expected);
      }
    }
  }
  counter.reset();
  writeWord(bus, PERL, 125, 0);
  writeWord(bus, CNTL, 123, 0);
  bus.write(CTRLA, 1, 0);
  clock.snapshot(Number.MAX_SAFE_INTEGER);
  assert.equal(counter.snapshot().cnt, Number((BigInt(Number.MAX_SAFE_INTEGER) + 123n) % 126n));
});

test('TCC0 period registration checks both bytes before mapping and keeps buffered and adjacent registers strict', () => {
  for (const occupied of [PERL, PERH]) {
    const registry = new MMIORegistry(), existing = { read: () => 0x4d }, counter = new TCC0Counter();
    registry.map(occupied, existing);
    assert.throws(() => counter.register(registry, { mapPeriod: true }), /collision/);
    assert.deepEqual([...registry.handlers], [[occupied, existing]]);
    counter.register(new MMIORegistry(), { mapPeriod: true });
  }
  const first = fixture(), second = fixture();
  writeWord(first.bus, PERL, 0x75ab, 0);
  assert.equal(second.counter.snapshotPeriod().per, 0xffff);
  for (const address of [0x0825,0x0828,0x0836,0x0837,0x0866,0x0926,0x0806]) {
    for (const kind of ['read','write']) {
      assert.throws(() => kind === 'read' ? first.bus.read(address) : first.bus.write(address, 1),
        e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === address && e.accessKind === kind);
    }
  }
});

test('TCC0 period STD and LDD pairs preserve Z and SREG and log distinct MMIO completion edges on replay', () => {
  function run() {
    // STD Z+38,R20; STD Z+39,R21; LDD R22,Z+38; LDD R23,Z+39.
    const { cpu, counter, events } = fixture([0xa346,0xa357,0xa166,0xa177], true);
    cpu.setPair(30, 0x0800);
    cpu.r[20] = 0xa7;
    cpu.r[21] = 0x42;
    cpu.sreg = 0xab;
    const traces = Array.from({ length: 4 }, () => cpu.step());
    assert.deepEqual(traces.map(t => [t.mnemonic,t.after.pcWord,t.after.cycles]),
      [['STD',1,2],['STD',2,4],['LDD',3,6],['LDD',4,8]]);
    assert.deepEqual([cpu.r[22],cpu.r[23],cpu.sreg,cpu.sp,cpu.pair(30)], [0xa7,0x42,0xab,0x5fff,0x0800]);
    assert.deepEqual(traces.flatMap(t => t.accesses.filter(a => a.space === 'mmio')
      .map(a => [t.step, a.kind, a.addressByte, a.value])), [
      [1,'write',PERL,0xa7], [2,'write',PERH,0x42], [3,'read',PERL,0xa7], [4,'read',PERH,0x42],
    ]);
    assert.ok(events.every(e => e.origin === 'peripheral-model' && e.eventType === 'timer-access' && e.completed));
    assert.deepEqual(events.map(e => [e.register,e.pcWord,e.instructionAttempt,e.cycle,e.kind,e.value,e.before.per,e.after.per,e.after.temp]), [
      ['PERL',0,1,2,'write',0xa7,0xffff,0xffff,0xa7],
      ['PERH',1,2,4,'write',0x42,0xffff,0x42a7,0xa7],
      ['PERL',2,3,6,'read',0xa7,0x42a7,0x42a7,0x42],
      ['PERH',3,4,8,'read',0x42,0x42a7,0x42a7,0x42],
    ]);
    return { traces, events, state: counter.snapshotPeriod() };
  }
  assert.deepEqual(run(), run());
});
