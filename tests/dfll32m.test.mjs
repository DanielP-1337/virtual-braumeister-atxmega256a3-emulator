import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { OscillatorController } from '../src/peripherals/oscillator.mjs';
import { SystemClock } from '../src/peripherals/system-clock.mjs';
import { DFLL32M } from '../src/peripherals/dfll32m.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';

// Device bytes, masks and expected clock edges are literal independent test inputs.
function fixture({ startupCycles = { rc32m: 1, rc32k: 2 }, words = [] } = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  for (const [i, word] of words.entries()) {
    flash.set([word & 255, word >>> 8], 2 * i);
    present.fill(1, 2 * i, 2 * i + 2);
  }
  const cpu = new XmegaCPU({ flash, present }), clock = new SystemClock();
  const events = [], oscEvents = [];
  const osc = new OscillatorController({ systemClock: clock, startupCycles, onAccess: e => oscEvents.push(e) });
  osc.register(cpu.bus.mmio, { dfllReference: true, dfll32m: true, onDfllAccess: e => events.push(e),
    fault: (message, detail) => cpu.fault(message, detail), context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  clock.register(cpu.bus, osc);
  return { cpu, osc, clock, events, oscEvents, state: cycle => osc.dfll32m.snapshot(osc.snapshot(cycle)) };
}

function expectFault(fn, classification, address, value) {
  assert.throws(fn, e => e.classification === classification && e.addressByte === address &&
    e.accessKind === 'write' && e.attemptedValue === value);
}

test('DFLL enable reset reads zero, ignores writes under reset and clears a previously held reference', () => {
  const { cpu, osc, state } = fixture();
  for (let i = 0; i < 2; ++i) {
    osc.reset();
    assert.equal(cpu.read(0x0060, 0), 0);
    cpu.write(0x0060, 0xff, 0);
    assert.equal(cpu.read(0x0060, 0), 0);
    assert.deepEqual(state(0), { ctrl: 0, reference: 'RC32K', referenceState: 'disabled', heldReferenceMask: 0, awaitingDisableReadback: false });
    osc.releaseReset(); cpu.write(0x0050, 7, 0);
    cpu.write(0x0060, 1, 2);
    assert.equal(cpu.read(0x0060, 2), 1);
  }
});

test('DFLL enable only bit zero survives all 256 writes with a stable reference and needs no CCP grant', () => {
  const { cpu, osc, clock, events } = fixture();
  osc.releaseReset(); cpu.write(0x0050, 5, 0);
  for (let raw = 0; raw <= 255; ++raw) {
    const cycle = 3 + raw * 2;
    cpu.write(0x0060, raw, cycle);
    assert.equal(events.at(-1).value, raw);
    assert.equal(cpu.read(0x0060, cycle + 1), raw % 2);
  }
  assert.equal(cpu.read(0x0034, 515), 0);
  assert.equal(cpu.read(0x0050, 515), 5); // The control write does not start RC32M.
  assert.equal(cpu.read(0x0051, 515), 5);
  assert.equal(clock.snapshot(515).cpuClockHz, 2000000);
  assert.deepEqual(clock.switches, []);
});

test('DFLL enable distinguishes a starting selected reference from its first stable clock edge', () => {
  const { cpu, osc, events, state } = fixture({ startupCycles: { rc32k: 5 } });
  osc.releaseReset(); cpu.write(0x0050, 5, 10);
  const before = state(14);
  expectFault(() => cpu.write(0x0060, 1, 14), 'DFLL_REFERENCE_NOT_READY', 0x60, 1);
  assert.equal(events.at(-1).completed, false);
  assert.deepEqual(events.at(-1).after, before);
  assert.deepEqual(state(14), before);
  assert.equal(cpu.read(0x0060, 15), 0); // No pending auto-enable.
  cpu.write(0x0060, 1, 15);
  assert.deepEqual(state(15), { ctrl: 1, reference: 'RC32K', referenceState: 'ready', heldReferenceMask: 4, awaitingDisableReadback: false });
  assert.equal(cpu.read(0x0060, 15), 1);
});

test('DFLL enable fails explicitly for missing internal or selected external clock even when another source is ready', () => {
  const { cpu, osc, events } = fixture();
  osc.releaseReset(); cpu.write(0x0050, 3, 0);
  assert.equal(cpu.read(0x0051, 2), 3);
  expectFault(() => cpu.write(0x0060, 1, 2), 'DFLL_REFERENCE_DISABLED', 0x60, 1);
  cpu.write(0x0050, 7, 3); cpu.write(0x0056, 2, 5);
  assert.equal(cpu.read(0x0051, 5), 7);
  expectFault(() => cpu.write(0x0060, 0xff, 5), 'DFLL_REFERENCE_DISABLED', 0x60, 0xff);
  assert.deepEqual([events.at(-1).before.reference, events.at(-1).after.ctrl], ['XOSC32', 0]);
  assert.equal(cpu.read(0x0060, 100), 0);
});

test('DFLL enable distinguishes an unknown selected deadline from unrelated unknown status bits', () => {
  const unknown = fixture({ startupCycles: {} });
  unknown.osc.releaseReset(); unknown.cpu.write(0x0050, 5, 1);
  expectFault(() => unknown.cpu.write(0x0060, 1, 1000), 'DFLL_REFERENCE_READY_UNKNOWN', 0x60, 1);
  assert.equal(unknown.events.at(-1).after.referenceState, 'unknown');
  assert.equal(unknown.cpu.read(0x0060, 1000), 0);
  const other = fixture({ startupCycles: { rc32k: 2 } });
  other.osc.releaseReset(); other.cpu.write(0x0050, 7, 1);
  assert.equal(other.osc.snapshot(3).status, null);
  other.cpu.write(0x0060, 1, 3);
  assert.equal(other.cpu.read(0x0060, 3), 1);
});

test('DFLL enable guards the reference through disable until an actual zero read and rejects invalid changes atomically', () => {
  const { cpu, osc, state, oscEvents } = fixture();
  osc.releaseReset(); cpu.write(0x0050, 7, 0); cpu.write(0x0060, 1, 4);
  cpu.write(0x0056, 1, 5); // Changing the separate RC2M selector is permitted.
  expectFault(() => cpu.write(0x0056, 3, 5), 'DFLL_REFERENCE_DISABLED', 0x56, 3);
  assert.equal(cpu.read(0x0056, 5), 1);
  expectFault(() => cpu.write(0x0050, 1, 6), 'DFLL_REFERENCE_IN_USE', 0x50, 1);
  assert.deepEqual(oscEvents.at(-1).before, oscEvents.at(-1).after);
  assert.equal(cpu.read(0x0050, 6), 7);
  cpu.write(0x0060, 0, 7); cpu.write(0x0060, 0, 8);
  assert.equal(state(8).awaitingDisableReadback, true);
  cpu.write(0x0056, 3, 8); // A selector change cannot release the original reference.
  assert.equal(state(8).heldReferenceMask, 4);
  expectFault(() => cpu.write(0x0050, 1, 9), 'DFLL_DISABLE_READBACK_REQUIRED', 0x50, 1);
  assert.equal(cpu.read(0x0051, 9), 7);
  assert.equal(cpu.read(0x0060, 10), 0);
  cpu.write(0x0050, 1, 10);
  assert.equal(state(10).heldReferenceMask, 0);
  assert.equal(cpu.read(0x0051, 10), 1);
});

test('DFLL enable uses XOSCRDY for an explicitly supplied stable external test reference', () => {
  // Independent source fixture. The full A3 oscillator profile keeps XOSC disabled.
  const events = [];
  let source = 'XOSC32';
  const control = new DFLL32M({ referenceSelection: () => ({ rc32m: source }), context: () => ({}) }, e => events.push(e));
  const inputs = { ctrl: 0x0a, readyBits: 0x08, unknownBits: 0x02, inReset: false };
  control.access('write', 1, 12, inputs);
  assert.equal(control.access('read', null, 13, inputs), 1);
  assert.deepEqual([events[0].after.heldReferenceMask, events[0].after.referenceState], [8, 'ready']);
  assert.equal(control.checkOscillatorControl(0x0a), null);
  assert.equal(control.checkOscillatorControl(0x02).classification, 'DFLL_REFERENCE_IN_USE');
  control.access('write', 0, 14, inputs);
  source = 'RC32K';
  const both = { ...inputs, ctrl: 0x0e, readyBits: 0x0c };
  control.access('write', 1, 15, both);
  assert.equal(control.snapshot(both).heldReferenceMask, 12);
  assert.equal(control.checkOscillatorControl(4).classification, 'DFLL_DISABLE_READBACK_REQUIRED');
  control.access('write', 0, 16, both);
  assert.equal(control.access('read', null, 17, both), 0);
  assert.equal(control.checkOscillatorControl(0), null);
});

test('DFLL enable real LDS ORI STS uses the AVRxm MMIO edges and preserves unrelated registers and the stack', () => {
  const words = [0x9180, 0x0060, 0x6081, 0x9380, 0x0060, 0x9190, 0x0060];
  const { cpu, osc, events } = fixture({ words });
  osc.releaseReset(); cpu.write(0x0050, 7, 0);
  cpu.r.fill(0x55); cpu.sreg = 0xa2;
  const sp = cpu.sp;
  for (const [pc, clocks, r24, flags] of [[2, 1, 0, 0xa2], [3, 2, 1, 0xa0], [5, 4, 1, 0xa0], [7, 5, 1, 0xa0]]) {
    cpu.step();
    assert.deepEqual([cpu.pc, cpu.cycles, cpu.r[24], cpu.sreg, cpu.sp], [pc, clocks, r24, flags, sp]);
  }
  assert.equal(cpu.r[25], 1);
  for (let i = 0; i < 32; ++i) if (i !== 24 && i !== 25) assert.equal(cpu.r[i], 0x55);
  assert.deepEqual(events.map(e => [e.pcWord, e.kind, e.value, e.cycle, e.before.ctrl, e.after.ctrl]),
    [[0, 'read', 0, 1, 0, 0], [3, 'write', 1, 4, 0, 1], [5, 'read', 1, 5, 1, 1]]);
});

test('DFLL enable maps only the 32 MHz control byte and preserves an existing registration on collisions', () => {
  const { cpu, osc } = fixture();
  osc.releaseReset();
  for (const addr of [0x005f, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0068]) {
    assert.throws(() => cpu.read(addr), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr);
    assert.throws(() => cpu.write(addr, 1), e => e.classification === 'UNHANDLED_MMIO');
  }
  const registry = new MMIORegistry(), old = { read: () => 0x42 };
  registry.map(0x0060, old);
  assert.throws(() => new OscillatorController().register(registry, { dfll32m: true, dfllReference: true }), /collision/);
  assert.deepEqual([...registry.handlers], [[0x0060, old]]);
  assert.throws(() => new OscillatorController().register(new MMIORegistry(), { dfll32m: true }), /requires/);
});

test('DFLL enable reset and replay reproduce readback, diagnostics and ordered model events', () => {
  const { cpu, osc, events } = fixture();
  function replay() {
    osc.reset(); osc.releaseReset();
    const start = events.length;
    cpu.read(0x0060, 0);
    expectFault(() => cpu.write(0x0060, 1, 1), 'DFLL_REFERENCE_DISABLED', 0x60, 1);
    cpu.write(0x0050, 5, 2);
    cpu.write(0x0060, 1, 4); cpu.read(0x0060, 4);
    cpu.write(0x0060, 0, 5); cpu.read(0x0060, 6);
    return events.slice(start);
  }
  const first = replay();
  assert.deepEqual(first, replay());
  assert.ok(first.every(e => e.origin === 'peripheral-model' && e.eventType === 'dfll32m-access' && e.addressByte === 0x0060));
});
