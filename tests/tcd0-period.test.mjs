import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TCC0Clock } from '../src/peripherals/tcc0-clock.mjs';
import { TCC0Counter } from '../src/peripherals/tcc0-counter.mjs';

// Data-byte addresses from the non-U ATxmega256A3 register map, independent of the model.
const C = { temp: 0x080f, low: 0x0826, high: 0x0827 };
const D = { temp: 0x090f, low: 0x0926, high: 0x0927 };

function fixture(words = [], record = false) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => { flash[2 * i] = word & 255; flash[2 * i + 1] = word >>> 8; });
  present.fill(1, 0, 2 * words.length);
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, events = [];
  const onAccess = record ? e => events.push(e) : null;
  const context = () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 });
  const c = new TCC0Counter({ onAccess }), d = new TC0Counter('TCD0', { onAccess });
  c.register(bus.mmio, { mapPeriod: true, context });
  d.register(bus.mmio, { mapCounter: false, mapPeriod: true, context });
  return { cpu, bus, c, d, events };
}

test('TCD0 period maps its own three data bytes and exposes the documented reset values', () => {
  const { bus, c, d } = fixture();
  assert.deepEqual([...bus.mmio.handlers.keys()].filter(a => a >= 0x900), [0x090f, 0x0926, 0x0927]);
  for (const [timer, regs] of [[c, C], [d, D]]) {
    assert.deepEqual(timer.snapshotPeriod(), { per: 65535, cnt: 0, temp: 0 });
    assert.deepEqual([bus.read(regs.temp), bus.read(regs.high)], [0, 0]);
    assert.equal(bus.read(regs.low), 255);
    assert.equal(bus.read(regs.high), 255);
  }
  for (const address of [0x0900, 0x090e, 0x0910, 0x0920, 0x0921, 0x0925, 0x0928, 0x0936, 0x0937, 0x093c, 0x0966]) {
    for (const kind of ['read', 'write']) {
      assert.throws(() => kind === 'read' ? bus.read(address) : bus.write(address, 0),
        e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === address && e.accessKind === kind);
    }
  }
});

test('TCD0 period interleaves low writes and either high-byte commit order without cross-timer interference', () => {
  for (const dFirst of [false, true]) {
    const { bus, c, d } = fixture();
    bus.write(C.low, 0x81); bus.write(D.low, 0x62);
    assert.deepEqual([c.per, d.per, bus.read(C.temp), bus.read(D.temp)], [65535, 65535, 0x81, 0x62]);
    if (dFirst) {
      bus.write(D.high, 0x47);
      assert.deepEqual([c.per, d.per], [65535, 0x4762]);
      bus.write(C.high, 0x35);
    } else {
      bus.write(C.high, 0x35);
      assert.deepEqual([c.per, d.per], [0x3581, 65535]);
      bus.write(D.high, 0x47);
    }
    assert.deepEqual([c.per, d.per, bus.read(C.temp), bus.read(D.temp)], [0x3581, 0x4762, 0x81, 0x62]);
  }
});

test('TCD0 period low reads snapshot each high byte and direct TEMP writes affect only the addressed timer', () => {
  const { bus, c, d } = fixture();
  bus.write(C.low, 0x19); bus.write(C.high, 0x2a);
  bus.write(D.low, 0x3b); bus.write(D.high, 0x4c);
  assert.deepEqual([bus.read(C.low), bus.read(D.low), bus.read(D.high), bus.read(C.high)], [0x19, 0x3b, 0x4c, 0x2a]);
  bus.write(D.temp, 0x75);
  bus.write(0x0820, 0xb3); // C's CNTL also uses C's CPU latch.
  assert.deepEqual([bus.read(D.high), bus.read(C.high)], [0x75, 0xb3]);
  bus.write(D.high, 0x98);
  bus.write(C.high, 0xd1);
  assert.deepEqual([c.per, d.per], [0xd1b3, 0x9875]);
  bus.write(D.low, 0x88);
  assert.equal(bus.read(D.low), 0x75); // Reads active PER, replacing the staged low byte with the active high byte.
  bus.write(D.high, 0x45);
  assert.deepEqual([c.per, d.per, c.temp, d.temp], [0xd1b3, 0x4598, 0xb3, 0x98]);
});

test('TCD0 period independently stages, commits, and reads back every 16-bit value while TCC0 has a pending write', () => {
  const { cpu, bus, c, d } = fixture();
  bus.write(C.low, 0xc7); bus.write(C.high, 0x11); bus.write(C.low, 0xaa);
  let active = 65535;
  for (let high = 0; high < 256; high++) for (let low = 0; low < 256; low++) {
    bus.write(D.low, low);
    assert.equal(d.per, active);
    bus.write(D.high, high);
    active = 256 * high + low;
    assert.equal(d.per, active);
    assert.equal(bus.read(D.low), low);
    assert.equal(bus.read(D.high), high);
    assert.equal(c.per, 0x11c7);
    assert.equal(c.temp, 0xaa);
    cpu.accesses.length = 0;
  }
  bus.write(C.high, 0x55);
  assert.deepEqual([c.per, d.per], [0x55aa, 0xffff]);
});

test('TCD0 period writes and independent resets preserve the running TCC0 time base and pending bytes', () => {
  const { bus, c, d } = fixture();
  const clock = new TCC0Clock({ counter: c });
  clock.register(bus.mmio);
  bus.write(C.low, 3, 0); bus.write(C.high, 0, 0);
  bus.write(0x0800, 1, 0); // Divide by one, count 0, 1, 2, 3, 0.
  bus.write(D.low, 0xe5, 2); bus.write(D.high, 0x52, 3);
  clock.advanceTo(5);
  assert.deepEqual([c.cnt, c.per, c.temp, d.cnt, d.per], [1, 3, 3, 0, 0x52e5]);
  bus.write(C.low, 0x16, 5);
  d.reset(5);
  assert.deepEqual([c.cnt, c.per, c.temp, clock.ctrla, d.per, d.temp], [1, 3, 0x16, 1, 65535, 0]);
  bus.write(D.high, 0xab, 6); // Reset TEMP supplies zero on this high-first commit.
  bus.write(D.low, 0xee, 6);
  c.reset(6);
  assert.deepEqual([c.cnt, c.per, c.temp, clock.ctrla, d.per, d.temp], [0, 65535, 0, 0, 0xab00, 0xee]);
  bus.write(D.high, 0x92, 7);
  assert.equal(d.per, 0x92ee);
});

test('TCD0 period registration is atomic and rejects attaching the TCC0 clock to a D0 register bank', () => {
  assert.throws(() => new TC0Counter('TCD1'), /Unsupported TC0/);
  for (const occupied of [D.temp, D.low, D.high]) {
    const registry = new MMIORegistry(), handler = { read: () => 7 };
    const d = new TC0Counter('TCD0'), options = { mapCounter: false, mapPeriod: true };
    registry.map(occupied, handler);
    assert.throws(() => d.register(registry, options), /collision/);
    assert.deepEqual([...registry.handlers], [[occupied, handler]]);
    const fresh = new MMIORegistry();
    d.register(fresh, options);
    assert.throws(() => d.register(new MMIORegistry(), options), /collision/);
    assert.throws(() => new TCC0Clock({ counter: d }).register(fresh), /TCC0/);
    assert.equal(fresh.handlers.has(0x0800), false);
    assert.equal(d.clock, undefined);
  }
});

test('TCD0 period interleaved synthetic Y and Z instructions preserve CPU state and replay both bus traces', () => {
  function run() {
    // Four STD and four LDD instructions interleave C (Y) and D (Z).
    const { cpu, c, d, events } = fixture([0xa34e, 0xa366, 0xa35f, 0xa377, 0xa18e, 0xa196, 0xa0af, 0xa0b7], true);
    cpu.setPair(28, 0x0800); cpu.setPair(30, 0x0900); cpu.sreg = 0x53;
    cpu.r.set([0x24, 0x58, 0x31, 0x6e], 20);
    const steps = Array.from({ length: 8 }, () => cpu.step());
    assert.deepEqual(steps.map(t => t.mnemonic), ['STD', 'STD', 'STD', 'STD', 'LDD', 'LDD', 'LDD', 'LDD']);
    assert.deepEqual(steps.map(t => t.after.pcWord), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(steps.map(t => t.after.cycles), [2, 4, 6, 8, 10, 12, 14, 16]);
    assert.deepEqual([cpu.r[24], cpu.r[25], cpu.r[10], cpu.r[11]], [0x24, 0x31, 0x58, 0x6e]);
    assert.deepEqual([cpu.pair(28), cpu.pair(30), cpu.sreg, cpu.sp], [0x800, 0x900, 0x53, 0x5fff]);
    assert.deepEqual(events.map(e => [e.peripheral, e.addressByte, e.kind, e.value]), [
      ['TCC0', C.low, 'write', 0x24], ['TCD0', D.low, 'write', 0x31],
      ['TCC0', C.high, 'write', 0x58], ['TCD0', D.high, 'write', 0x6e],
      ['TCC0', C.low, 'read', 0x24], ['TCD0', D.low, 'read', 0x31],
      ['TCC0', C.high, 'read', 0x58], ['TCD0', D.high, 'read', 0x6e],
    ]);
    assert.deepEqual(events.map(e => e.after.per), [65535, 65535, 0x5824, 0x6e31, 0x5824, 0x6e31, 0x5824, 0x6e31]);
    assert.deepEqual(events.map(e => e.cycle), steps.map(s => s.after.cycles));
    assert.deepEqual([c.temp, d.temp], [0x58, 0x6e]);
    return { steps, events };
  }
  assert.deepEqual(run(), run());
});

test('TCD0 period leaves both timers and the CPU at the instruction boundary on an unhandled buffer write', () => {
  const { cpu, bus, c, d, events } = fixture([0xaf44], true); // STD Z+60,R20
  cpu.setPair(30, 0x900); cpu.r[20] = 0x72;
  bus.write(C.low, 0xd2); bus.write(C.high, 0x3a); bus.write(C.temp, 0x47);
  bus.write(D.low, 0x82); bus.write(D.high, 0x26); bus.write(D.temp, 0x53);
  const before = cpu.state(), eventCount = events.length;
  assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x93c &&
    e.attemptedValue === 0x72 && e.accessKind === 'write' && e.opcode === 0xaf44);
  assert.deepEqual(cpu.state(), before);
  assert.equal(cpu.steps, 0);
  assert.equal(events.length, eventCount);
  assert.deepEqual([c.per, c.temp, d.per, d.temp], [0x3ad2, 0x47, 0x2682, 0x53]);
});
