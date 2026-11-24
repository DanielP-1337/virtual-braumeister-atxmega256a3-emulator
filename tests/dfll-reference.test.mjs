import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { OscillatorController } from '../src/peripherals/oscillator.mjs';
import { SystemClock } from '../src/peripherals/system-clock.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

// Literal addresses and selections from ATxmega256A3.atdf and XMEGA A 7.10.7.
const selections = [
  { dfllctrl: 0, rc32m: 'RC32K',  rc2m: 'RC32K' },
  { dfllctrl: 1, rc32m: 'RC32K',  rc2m: 'XOSC32' },
  { dfllctrl: 2, rc32m: 'XOSC32', rc2m: 'RC32K' },
  { dfllctrl: 3, rc32m: 'XOSC32', rc2m: 'XOSC32' },
];

function fixture({ words = [], startupCycles = {} } = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => {
    flash.set([word & 255, word >>> 8], i * 2);
    present.fill(1, i * 2, i * 2 + 2);
  });
  const cpu = new XmegaCPU({ flash, present });
  const clock = new SystemClock(), events = [];
  const osc = new OscillatorController({ systemClock: clock, startupCycles, onAccess: event => events.push(event) });
  osc.register(cpu.bus.mmio, { dfllReference: true, context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  clock.register(cpu.bus, osc);
  return { cpu, clock, osc, events };
}

test('DFLL reference reset selects internal 32.768 kHz for both loops and clears prior writes', () => {
  const { cpu, osc } = fixture();
  for (let reset = 0; reset < 2; ++reset) {
    osc.reset();
    assert.equal(cpu.read(0x0056, 0), 0);
    cpu.write(0x0056, 3, 1);
    assert.deepEqual(osc.referenceSelection(), selections[0]);
    osc.releaseReset();
    assert.equal(cpu.read(0x0056, 2), 0);
    cpu.write(0x0056, 3, 3);
    assert.deepEqual(osc.referenceSelection(), selections[3]);
  }
});

test('DFLL reference all 256 bus values read back only the two independent non-U A3 selector bits', () => {
  const { cpu, osc, events } = fixture();
  osc.releaseReset();
  for (let value = 0; value < 256; ++value) {
    const expected = selections[value % 4];
    cpu.write(0x0056, value, value * 2);
    const store = events.at(-1);
    assert.equal(store.value, value);
    assert.deepEqual(store.referenceAfter, expected);
    assert.equal(cpu.read(0x0056, value * 2 + 1), expected.dfllctrl);
    assert.deepEqual(osc.referenceSelection(), expected);
  }
});

test('DFLL reference ordinary writes select TOSC or internal RC with either reference disabled or starting', () => {
  const { cpu, osc, clock } = fixture({ startupCycles: { rc32m: 3, rc32k: 10 } });
  osc.releaseReset();
  assert.equal(cpu.read(0x0034, 1), 0);
  cpu.write(0x0056, 2, 1); // No CCP key. The external oscillator is disabled.
  assert.deepEqual(osc.referenceSelection(), selections[2]);
  assert.deepEqual([cpu.read(0x0050, 1), cpu.read(0x0051, 1)], [1, 1]);
  cpu.write(0x0050, 7, 2);
  cpu.write(0x0056, 1, 3);
  assert.deepEqual(osc.referenceSelection(), selections[1]);
  assert.equal(cpu.read(0x0051, 4), 1);
  assert.equal(cpu.read(0x0051, 5), 3);
  assert.equal(cpu.read(0x0051, 11), 3);
  assert.equal(cpu.read(0x0051, 12), 7);
  assert.deepEqual(clock.switches, []);
  assert.equal(clock.snapshot(12).cpuClockHz, 2000000);
});

test('DFLL reference reads and writes are defined even when the reference startup time is unknown', () => {
  const { cpu, osc } = fixture();
  osc.releaseReset();
  cpu.write(0x0050, 5, 10);
  for (const [cycle, selection] of [[11, 2], [12, 0]]) {
    cpu.write(0x0056, selection, cycle);
    assert.equal(cpu.read(0x0056, cycle), selection);
    assert.deepEqual([osc.snapshot(cycle).unknownBits, osc.snapshot(cycle).readyBits], [4, 1]);
  }
  assert.throws(() => cpu.read(0x0051, 13), e => e.classification === 'OSC_STARTUP_TIMING_UNKNOWN');
});

test('DFLL reference real LDS ANDI STS clears bit 1 and preserves bit 0, CPU state and access edges', () => {
  // LDS R24,0x56 / ANDI R24,0xFD / STS 0x56,R24 / LDS R25,0x56.
  const { cpu, osc, events } = fixture({ words: [0x9180, 0x0056, 0x7f8d, 0x9380, 0x0056, 0x9190, 0x0056] });
  osc.releaseReset();
  cpu.write(0x0056, 3, 0);
  cpu.r.fill(0x4e);
  cpu.sreg = 0xa5;
  const stack = cpu.sp;
  for (const [pc, cycles, r24, r25, sreg] of [
    [2, 1, 3, 0x4e, 0xa5], [3, 2, 1, 0x4e, 0xa1], [5, 4, 1, 0x4e, 0xa1], [7, 5, 1, 1, 0xa1],
  ]) {
    cpu.step();
    assert.deepEqual([cpu.pc, cpu.cycles, cpu.r[24], cpu.r[25], cpu.sreg, cpu.sp], [pc, cycles, r24, r25, sreg, stack]);
  }
  for (let reg = 0; reg < 32; ++reg) if (reg !== 24 && reg !== 25) assert.equal(cpu.r[reg], 0x4e);
  assert.deepEqual(events.slice(1).map(e => [e.pcWord, e.cycle, e.kind, e.value, e.referenceBefore.dfllctrl, e.referenceAfter.dfllctrl]),
    [[0, 1, 'read', 3, 3, 3], [3, 4, 'write', 1, 3, 1], [5, 5, 'read', 1, 1, 1]]);
});

test('DFLL reference maps only the selector byte and registration collisions leave all other hooks intact', () => {
  const { cpu, osc } = fixture();
  osc.releaseReset();
  for (const address of [0x0055, 0x0057, 0x0060, 0x0068]) {
    for (const kind of ['read', 'write']) {
      assert.throws(() => kind === 'read' ? cpu.read(address) : cpu.write(address, 1),
        e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === address && e.accessKind === kind);
    }
  }
  const registry = new MMIORegistry(), existing = { read: () => 0xab };
  registry.map(0x0056, existing);
  assert.throws(() => new OscillatorController().register(registry, { dfllReference: true }), /collision/);
  assert.deepEqual([...registry.handlers.entries()], [[0x0056, existing]]);
});

test('DFLL reference selections and peripheral evidence replay identically after reset', () => {
  const { cpu, osc, events } = fixture();
  function replay() {
    osc.reset(); osc.releaseReset();
    const start = events.length;
    for (const [cycle, value] of [[0, 1], [1, 3], [2, 2], [3, 0]]) {
      cpu.write(0x0056, value, cycle);
      cpu.read(0x0056, cycle);
    }
    return events.slice(start);
  }
  const first = replay();
  assert.deepEqual(first, replay());
  assert.ok(first.every(e => e.origin === 'peripheral-model' && e.addressByte === 0x0056 && e.completed));
  assert.deepEqual(first[0].referenceBefore, selections[0]);
});
