import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { TCD1Period } from '../src/peripherals/tcd1-period.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TimerClock } from '../src/peripherals/timer-clock.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

// Non-U ATxmega256A3 device map and XMEGA A manual sections 14.4, 14.5 and 14.12.1–2.
const CTRL = 0x0940, MODE = 0x0941, LOCK_CLR = 0x0948, LOCK_SET = 0x0949, FLAGS = 0x094a;
const PER = 0x0966, CCA = 0x0968, CCB = 0x096a, ABUF = 0x0978, BBUF = 0x097a;

function fixture(words = [], mapCtrla = true) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const view = new DataView(flash.buffer);
  words.forEach((word, i) => view.setUint16(i * 2, word, true));
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), timer = new TCD1Period(), events = [];
  timer.register(cpu.bus.mmio, {
    mapCtrla, mapCtrlb: true, mapCompareA: true, mapCompareB: true,
    onCtrlaAccess: event => events.push(event),
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (reason, details) => cpu.fault(reason, details),
  });
  return { cpu, bus: cpu.bus, timer, events };
}

function put(bus, addr, value, cycle = 0) {
  bus.write(addr, value & 255, cycle);
  bus.write(addr + 1, value >>> 8, cycle);
}

function get(bus, addr, cycle) {
  return bus.read(addr, cycle) + 256 * bus.read(addr + 1, cycle);
}

function pwm(bus, period = 3) {
  put(bus, PER, period);
  put(bus, CCA, 0x3041); put(bus, CCB, 0x5062);
  put(bus, ABUF, 0x1273); put(bus, BBUF, 0x2484);
  bus.write(MODE, 0x33, 0);
}

function sample({ bus, timer }, cycle) {
  const flags = bus.read(FLAGS, cycle);
  return [timer.cnt, get(bus, CCA, cycle), get(bus, CCB, cycle), flags];
}

test('TCD1 CTRLA resets to OFF and clears only the counter and registers of its timer on reset', () => {
  const f = fixture(), { bus, timer } = f;
  assert.equal(bus.read(CTRL, 0), 0);
  assert.equal(bus.read(CTRL, 99999), 0);
  assert.equal(timer.cnt, 0);
  for (let upper = 0; upper < 16; upper++) {
    bus.write(CTRL, (upper << 4) | 1, 100000 + upper);
    assert.equal(bus.read(CTRL, 100000 + upper), 1);
  }
  assert.equal(timer.cnt, 15);
  timer.reset(100016);
  assert.deepEqual(timer.clock.snapshot(100100), { ctrla: 0, divider: 0 });
  assert.deepEqual(sample(f, 100100), [0, 0, 0, 0]);
  assert.equal(get(bus, PER, 100100), 0xffff);
});

test('TCD1 CTRLA DIV1 starts on the next peripheral edge and stop and restart preserve CNT', () => {
  const { bus, timer, events } = fixture();
  bus.write(CTRL, 1, 19);
  for (const [cycle, count] of [[19, 0], [20, 1], [21, 2], [27, 8]]) {
    assert.equal(bus.read(CTRL, cycle), 1);
    assert.equal(timer.cnt, count);
  }
  bus.write(CTRL, 0, 28);
  assert.equal(timer.cnt, 9);
  assert.equal(bus.read(CTRL, 400), 0);
  bus.write(CTRL, 1, 401);
  assert.equal(timer.cnt, 9);
  timer.clock.advanceTo(402);
  assert.equal(timer.cnt, 10);
  assert.deepEqual([events[0].before, events[0].after, events[0].cycle],
    [{ ctrla: 0, divider: 0 }, { ctrla: 1, divider: 1 }, 19]);
});

test('TCD1 CTRLA internal divisors follow the common prescaler across every selector change', () => {
  const { bus, timer } = fixture();
  // Count individual input pulses independently of the model's batched arithmetic.
  const divisors = [0, 1, 2, 4, 8, 64, 256, 1024];
  const changes = new Map([[3, 7], [2048, 6], [2561, 5], [2816, 4], [2861, 3],
    [2880, 2], [2882, 1], [2891, 0], [2999, 6]]);
  let expected = 0, select = 0;
  for (let cycle = 1; cycle <= 3100; cycle++) {
    if (select && cycle % divisors[select] === 0) expected++;
    if (changes.has(cycle)) {
      select = changes.get(cycle);
      bus.write(CTRL, select, cycle);
    }
    assert.deepEqual(timer.clock.snapshot(cycle), { ctrla: select, divider: divisors[select] });
    assert.equal(timer.cnt, expected, 'peripheral cycle ' + cycle);
  }
});

test('TCD1 CTRLA clock transfers two distinct valid words on the first BOTTOM after enable', () => {
  const f = fixture();
  pwm(f.bus);
  f.bus.write(CTRL, 1, 20);
  for (const [cycle, count] of [[20, 0], [21, 1], [22, 2], [23, 3]]) {
    assert.deepEqual(sample(f, cycle), [count, 0x3041, 0x5062, 6]);
  }
  assert.deepEqual(sample(f, 24), [0, 0x1273, 0x2484, 0]);
  assert.deepEqual(sample(f, 28), [0, 0x1273, 0x2484, 0]);
});

test('TCD1 CTRLA requires 4096 DIV1 edges for two pending zero words with PER 0x0fff', () => {
  const f = fixture(), { bus } = f;
  put(bus, PER, 0x0fff); put(bus, ABUF, 0); put(bus, BBUF, 0);
  bus.write(MODE, 0x33, 2);
  bus.write(CTRL, 1, 37);
  assert.deepEqual(sample(f, 37), [0, 0, 0, 6]);
  assert.deepEqual(sample(f, 4132), [4095, 0, 0, 6]);
  assert.deepEqual(sample(f, 4133), [0, 0, 0, 0]);
});

test('TCD1 CTRLA evaluates BOTTOM before committing a new compare-buffer high byte on that edge', () => {
  const f = fixture(), { bus } = f;
  pwm(bus);
  bus.write(CTRL, 1, 0);
  bus.write(ABUF, 0xad, 3);
  bus.write(ABUF + 1, 0x3b, 4);
  assert.deepEqual(sample(f, 4), [0, 0x1273, 0x2484, 2]);
  assert.deepEqual(sample(f, 7), [3, 0x1273, 0x2484, 2]);
  assert.deepEqual(sample(f, 8), [0, 0x3bad, 0x2484, 0]);
});

test('TCD1 CTRLA honors the UPDATE lock, an off interval, and both pending words across restart', () => {
  const f = fixture(), { bus } = f;
  pwm(bus);
  bus.write(CTRL, 1, 0);
  bus.write(LOCK_SET, 2, 2);
  bus.write(CTRL, 0, 4);
  assert.deepEqual(sample(f, 50), [0, 0x3041, 0x5062, 6]);
  bus.write(LOCK_CLR, 2, 51);
  bus.write(CTRL, 1, 70);
  assert.deepEqual(sample(f, 73), [3, 0x3041, 0x5062, 6]);
  assert.deepEqual(sample(f, 74), [0, 0x1273, 0x2484, 0]);
});

test('TCD1 CTRLA event selectors fault without consuming an edge or changing the old clock', () => {
  const f = fixture(), { bus, timer, events } = f;
  pwm(bus); bus.write(CTRL, 1, 0);
  assert.deepEqual(sample(f, 3), [3, 0x3041, 0x5062, 6]);
  for (let select = 8; select <= 15; select++) {
    assert.throws(() => bus.write(CTRL, select, 4), e => e.classification === 'TCD1_EVENT_CLOCK_UNMODELED' &&
      e.addressByte === CTRL && e.attemptedValue === select);
    assert.equal(timer.clock.lastCycle, 3);
    assert.deepEqual([events.at(-1).completed, events.at(-1).before, events.at(-1).after],
      [false, { ctrla: 1, divider: 1 }, { ctrla: 1, divider: 1 }]);
  }
  assert.deepEqual(sample(f, 4), [0, 0x1273, 0x2484, 0]);
  assert.throws(() => timer.clock.advanceTo(3), RangeError);
});

test('TCD1 CTRLA registers atomically and leaves unimplemented neighbors and the previous mapping strict', () => {
  const f = fixture([], false);
  assert.equal(f.timer.clock, undefined);
  assert.throws(() => f.bus.write(CTRL, 1, 0), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === CTRL);
  const current = fixture();
  for (const addr of [CTRL - 1, CTRL + 2, CTRL + 0x20]) {
    assert.throws(() => current.bus.read(addr), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr);
  }
  const reg = new MMIORegistry(), blocked = new TCD1Period(), existing = { read: () => 0x12 };
  reg.map(CTRL, existing);
  assert.throws(() => blocked.register(reg, { mapCtrla: true, mapCtrlb: true, mapCompareA: true }), /collision/);
  assert.deepEqual([...reg.handlers], [[CTRL, existing]]);
  assert.equal(blocked.clock, undefined);
});

test('TCD1 CTRLA shares the prescaler with TCD0 while each timer keeps its start, period and buffers', () => {
  const f = fixture(), { bus } = f, d0 = new TC0Counter('TCD0');
  d0.register(bus.mmio, { mapPeriod: true, mapCompareC: true });
  const clock0 = new TimerClock('TCD0', { counter: d0 });
  clock0.register(bus.mmio);
  pwm(bus);
  put(bus, 0x0926, 7); put(bus, 0x093c, 0x7654);
  bus.write(0x0900, 1, 2); bus.write(CTRL, 2, 5);
  assert.deepEqual(sample(f, 9), [2, 0x3041, 0x5062, 6]);
  // The normal-mode TCD0 update is at TOP. TCD1 transfers in single-slope mode on the fourth /2 edge.
  clock0.advanceTo(9);
  assert.deepEqual([d0.cnt, d0.compare.ccc, d0.compare.validFlags()], [7, 0x7654, 0]);
  bus.write(0x0900, 0, 10);
  assert.deepEqual(sample(f, 11), [3, 0x3041, 0x5062, 6]);
  assert.deepEqual(sample(f, 12), [0, 0x1273, 0x2484, 0]);
  assert.deepEqual([clock0.snapshot(12), d0.cnt], [{ ctrla: 0, divider: 0 }, 0]);
});

test('TCD1 CTRLA AVR store starts at its completion edge and the clock and first fault replay exactly', () => {
  function run() {
    // A3 datasheet p. 59: ST Z,Rr uses one clock. Four NOPs follow the start store.
    const f = fixture([0x8300, 0, 0, 0, 0, 0x8310, 0x8302]), { cpu, timer, events } = f;
    pwm(f.bus);
    cpu.setPair(30, CTRL); cpu.r[16] = 1; cpu.r[17] = 0; cpu.sreg = 0x95;
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const step = cpu.step();
      timer.clock.advanceTo(cpu.cycles);
      samples.push([step.mnemonic, cpu.cycles, timer.cnt, timer.compare.validFlags()]);
    }
    assert.deepEqual(samples, [['ST', 1, 0, 6], ['NOP', 2, 1, 6], ['NOP', 3, 2, 6],
      ['NOP', 4, 3, 6], ['NOP', 5, 0, 0], ['ST', 6, 1, 0]]);
    assert.deepEqual([cpu.sreg, cpu.sp, cpu.pair(30)], [0x95, 0x5fff, CTRL]);
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === CTRL + 2);
    assert.deepEqual(cpu.state(), before);
    assert.deepEqual(events.map(e => [e.origin, e.pcWord, e.instructionAttempt, e.cycle, e.value]),
      [['peripheral-model', 0, 1, 1, 1], ['peripheral-model', 5, 6, 6, 0]]);
    return { samples, before, events };
  }
  assert.deepEqual(run(), run());
});
