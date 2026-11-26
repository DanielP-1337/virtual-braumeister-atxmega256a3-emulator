import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';

// Data-byte addresses and masks from the non-U 256A3 TC0 instance, independently of the model.
const CLK = 0x0900, FCLR = 0x0908, FSET = 0x0909, GCLR = 0x090a, GSET = 0x090b;
const TEMP = 0x090f, PER = 0x0926, CCC = 0x092c, BUF = 0x093c;
const VALID = 8, LOCK = 2, UPDATE = 4;

function fixture(words = [], record = false) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((w, i) => { flash[2 * i] = w & 255; flash[2 * i + 1] = w >>> 8; });
  present.fill(1, 0, 2 * words.length);
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, events = [];
  const d = new TC0Counter('TCD0'), clock = new TC0Clock('TCD0', { counter: d });
  const fault = (s, detail) => cpu.fault(s, detail);
  d.register(bus.mmio, { mapPeriod: true, mapCounter: false, mapCompareC: true, fault,
    onCompareAccess: record ? e => events.push(e) : null,
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  clock.register(bus.mmio, { fault });
  return { cpu, bus, d, clock, events };
}

function put(bus, addr, value, cycle = 0) {
  bus.write(addr, value & 255, cycle);
  bus.write(addr + 1, value >>> 8, cycle);
}

function get(bus, addr, cycle = 0) {
  return bus.read(addr, cycle) + 256 * bus.read(addr + 1, cycle);
}

test('TCD0 CCCBUF exposes both zeroed words and the hardware status aliases only for the selected bank', () => {
  const { bus } = fixture();
  assert.deepEqual([bus.read(TEMP), get(bus, BUF), get(bus, CCC), bus.read(GCLR), bus.read(GSET),
    bus.read(FCLR), bus.read(FSET), bus.read(CLK)], [0, 0, 0, 0, 0, 0, 0, 0]);
  for (const addr of [0x083c, 0x0903, 0x092e, 0x0936, 0x093a, 0x093b, 0x093e, 0x093f, 0x097c]) {
    for (const kind of ['read', 'write']) assert.throws(() => kind === 'read' ? bus.read(addr) : bus.write(addr, 1),
      e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr && e.accessKind === kind);
  }
});

test('TCD0 CCCBUF stages and commits all 65536 words and transfers each complete word exactly once', () => {
  const { bus, cpu } = fixture();
  let active = 0;
  for (let word = 0; word <= 65535; word++) {
    const low = word % 256, high = Math.floor(word / 256);
    bus.write(BUF, low);
    assert.equal(bus.read(TEMP), low);
    assert.equal(bus.read(GCLR), 0);
    bus.write(BUF + 1, high);
    assert.equal(bus.read(GSET), VALID);
    assert.equal(get(bus, BUF), word);
    assert.equal(get(bus, CCC), active);
    assert.equal(bus.read(GCLR), VALID);
    bus.write(FSET, UPDATE);
    assert.equal(get(bus, CCC), word);
    assert.equal(get(bus, BUF), word);
    assert.equal(bus.read(GSET), 0);
    active = word;
    cpu.accesses.length = 0;
  }
});

test('TCD0 CCCBUF uses the local CPU TEMP across period, buffered and active words without touching TCC0', () => {
  const { bus } = fixture();
  const c = new TC0Counter('TCC0');
  c.register(bus.mmio, { mapPeriod: true });
  bus.write(0x0826, 0xcd);
  bus.write(BUF, 0x51); bus.write(PER, 0xb7); bus.write(BUF + 1, 0x38);
  assert.equal(get(bus, BUF), 0x38b7);
  assert.equal(bus.read(TEMP), 0x38);
  put(bus, CCC, 0xa46e);
  assert.equal(bus.read(CCC), 0x6e); // Active low snapshots its high byte into D0 TEMP.
  bus.write(BUF + 1, 0x95);
  assert.equal(get(bus, BUF), 0x95a4);
  bus.write(BUF, 0x71); // A pending high-byte commit has not yet changed the valid buffer.
  assert.equal(bus.read(GSET), VALID);
  bus.write(FSET, UPDATE);
  assert.equal(bus.read(TEMP), 0x71); // The hardware transfer never uses CPU TEMP.
  bus.write(BUF + 1, 0x64);
  assert.equal(get(bus, CCC), 0x95a4);
  assert.equal(get(bus, BUF), 0x6471);
  bus.write(0x0827, 0x12);
  assert.equal(c.per, 0x12cd);
});

test('TCD0 CCCBUF lets software cancel or revalidate a retained buffer through CTRLGCLR and CTRLGSET', () => {
  const { bus } = fixture();
  put(bus, CCC, 0x1357); put(bus, BUF, 0x2468);
  bus.write(GCLR, 0); bus.write(GSET, 0);
  assert.equal(bus.read(GCLR), VALID);
  bus.write(GCLR, VALID); bus.write(FSET, UPDATE);
  assert.deepEqual([get(bus, CCC), get(bus, BUF), bus.read(GSET)], [0x1357, 0x2468, 0]);
  bus.write(GSET, VALID);
  assert.equal(bus.read(GCLR), VALID);
  bus.write(FSET, UPDATE);
  assert.deepEqual([get(bus, CCC), bus.read(GCLR)], [0x2468, 0]);
  put(bus, CCC, 0x3197); bus.write(FSET, UPDATE);
  assert.equal(get(bus, CCC), 0x3197);
});

test('TCD0 CCCBUF gets an automatic UPDATE only on its own divided NORMAL TOP edge', () => {
  const { bus, d } = fixture();
  const c = new TC0Counter('TCC0'), cClock = new TC0Clock('TCC0', { counter: c });
  c.register(bus.mmio, { mapPeriod: true }); cClock.register(bus.mmio);
  put(bus, 0x0826, 2); bus.write(0x0800, 1);
  put(bus, PER, 3); put(bus, CCC, 0x1133); put(bus, BUF, 0xaa55);
  cClock.advanceTo(48);
  assert.deepEqual([get(bus, CCC, 48), bus.read(GSET, 48), d.cnt], [0x1133, VALID, 0]);
  bus.write(CLK, 3, 48); // clkPER/4. After reset the shared tap edges are multiples of four.
  assert.deepEqual([get(bus, CCC, 59), bus.read(GCLR, 59), d.cnt], [0x1133, VALID, 2]);
  assert.deepEqual([get(bus, CCC, 60), bus.read(GCLR, 60), d.cnt], [0xaa55, 0, 3]);
  put(bus, CCC, 0x7766, 60);
  assert.deepEqual([get(bus, CCC, 64), d.cnt], [0x7766, 0]);
  assert.equal(get(bus, CCC, 1000000), 0x7766); // No valid word to copy at subsequent TOPs.
});

test('TCD0 CCCBUF lock holds pending data across hardware and command UPDATE until explicitly unlocked', () => {
  const { bus } = fixture();
  put(bus, PER, 2); put(bus, BUF, 0x7e11);
  bus.write(FSET, LOCK); bus.write(CLK, 1);
  bus.write(FSET, UPDATE, 2);
  assert.deepEqual([get(bus, CCC, 2), bus.read(GSET, 2), bus.read(FSET, 2), bus.read(FCLR, 2)], [0, VALID, LOCK, LOCK]);
  put(bus, BUF, 0x3a87, 3); // Replace pending data while locked.
  bus.write(FCLR, LOCK, 5);
  assert.deepEqual([get(bus, CCC, 7), bus.read(GCLR, 7)], [0, VALID]);
  assert.deepEqual([get(bus, CCC, 8), bus.read(GCLR, 8)], [0x3a87, 0]);
  bus.write(CLK, 0, 8);
  put(bus, BUF, 0xf102, 8);
  bus.write(FCLR, UPDATE, 9); // Command bits on the clear alias are read-only.
  assert.equal(bus.read(GSET, 9), VALID);
  bus.write(FSET, UPDATE, 10);
  assert.deepEqual([get(bus, CCC, 10), bus.read(GSET, 10), bus.read(FSET, 10)], [0xf102, 0, 0]);
});

test('TCD0 CCCBUF keeps a new high-byte commit pending when the preceding word transfers on that bus edge', () => {
  const { bus } = fixture();
  put(bus, PER, 3); put(bus, BUF, 0x1248); bus.write(CLK, 1);
  bus.write(BUF, 0x5a, 2); // Only TEMP changes.
  bus.write(BUF + 1, 0xbc, 3); // TOP consumes 0x1248 before the new 16-bit commit.
  assert.deepEqual([get(bus, CCC, 3), get(bus, BUF, 3), bus.read(GCLR, 3)], [0x1248, 0xbc5a, VALID]);
  assert.equal(get(bus, CCC, 6), 0x1248);
  assert.deepEqual([get(bus, CCC, 7), bus.read(GSET, 7)], [0xbc5a, 0]);
});

test('TCD0 CCCBUF rejects unsupported control writes atomically and never acknowledges a channel D store', () => {
  const { cpu, bus, clock, d, events } = fixture([0x9340, 0x093e], true); // STS 0x093e,R20
  put(bus, PER, 2); put(bus, BUF, 0x5345); bus.write(CLK, 1);
  const before = d.compareC.snapshot();
  for (const [reg, value, classification] of [[GCLR, 0x18, 'TCD0_BUFFER_FLAGS_UNMODELED'],
    [GSET, 0x09, 'TCD0_BUFFER_FLAGS_UNMODELED'], [FSET, 3, 'TCD0_DIRECTION_UNMODELED'],
    [FSET, 10, 'TCD0_COMMAND_UNMODELED'], [FSET, 12, 'TCD0_COMMAND_UNMODELED']]) {
    assert.throws(() => bus.write(reg, value, 2), e => e.classification === classification && e.addressByte === reg);
    assert.equal(events.at(-1).completed, false);
    assert.deepEqual(events.at(-1).before, events.at(-1).after);
    assert.deepEqual(d.compareC.snapshot(), before);
    assert.equal(clock.lastCycle, 0);
  }
  cpu.r[20] = 0x7b;
  const state = cpu.state(), count = events.length;
  assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x093e && e.attemptedValue === 0x7b);
  assert.deepEqual(cpu.state(), state); assert.equal(cpu.steps, 0);
  assert.equal(events.length, count);
  assert.deepEqual(d.compareC.snapshot(), before);
});

test('TCD0 CCCBUF registration preserves every existing handler on collision and reset clears the entire channel', () => {
  for (const addr of [FCLR, FSET, GCLR, GSET, CCC, CCC + 1, BUF, BUF + 1]) {
    const registry = new MMIORegistry(), existing = { read: () => 9 }, d = new TC0Counter('TCD0');
    registry.map(addr, existing);
    assert.throws(() => d.register(registry, { mapPeriod: true, mapCompareC: true }), /collision/);
    assert.deepEqual([...registry.handlers], [[addr, existing]]);
    assert.equal(d.compareC, undefined);
  }
  const { bus, d, clock } = fixture();
  put(bus, CCC, 0x6b45); put(bus, BUF, 0xcd81); bus.write(FSET, LOCK);
  bus.write(CLK, 1); d.reset(10);
  assert.deepEqual(d.compareC.snapshot(), { ccc: 0, cccbuf: 0, cccbv: false, lupd: false, temp: 0 });
  assert.equal(clock.snapshot(10).ctrla, 0);
  bus.write(BUF + 1, 0x32, 10); // High first consumes reset TEMP.
  assert.equal(get(bus, BUF, 10), 0x3200);
  assert.equal(bus.read(GSET, 10), VALID);
});

test('TCD0 CCCBUF replays actual AVR buffer writes, valid-flag reads, a forced UPDATE and active readback', () => {
  function run() {
    const { cpu, events } = fixture([0xaf44, 0xaf55, 0x8562, 0x8711, 0xa574, 0xa585, 0x8593], true);
    cpu.setPair(30, 0x0900); cpu.r[20] = 0xb2; cpu.r[21] = 0x47; cpu.r[17] = UPDATE; cpu.sreg = 0x35;
    const steps = Array.from({ length: 7 }, () => cpu.step());
    assert.deepEqual(steps.map(t => t.mnemonic), ['STD', 'STD', 'LDD', 'STD', 'LDD', 'LDD', 'LDD']);
    assert.deepEqual(steps.map(t => t.after.pcWord), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(steps.map(t => t.after.cycles), [2, 4, 6, 8, 10, 12, 14]);
    assert.deepEqual([cpu.r[22], cpu.r[23], cpu.r[24], cpu.r[25], cpu.sreg, cpu.sp, cpu.pair(30)],
      [VALID, 0xb2, 0x47, 0, 0x35, 0x5fff, 0x900]);
    assert.deepEqual(events.map(e => [e.register, e.addressByte, e.kind, e.value]), [
      ['CCCBUFL', BUF, 'write', 0xb2], ['CCCBUFH', BUF + 1, 'write', 0x47], ['CTRLGCLR', GCLR, 'read', VALID],
      ['CTRLFSET', FSET, 'write', UPDATE], ['CCCL', CCC, 'read', 0xb2], ['CCCH', CCC + 1, 'read', 0x47], ['CTRLGSET', GSET, 'read', 0],
    ]);
    assert.ok(events.every(e => e.peripheral === 'TCD0' && e.origin === 'peripheral-model' && e.completed));
    assert.deepEqual(events.map(e => e.cycle), steps.map(t => t.after.cycles));
    return { steps, events };
  }
  assert.deepEqual(run(), run());
});
