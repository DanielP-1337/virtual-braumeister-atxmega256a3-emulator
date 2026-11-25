import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { PMIC } from '../src/peripherals/pmic.mjs';
import { TCC0Counter } from '../src/peripherals/tcc0-counter.mjs';
import { TCC0Clock } from '../src/peripherals/tcc0-clock.mjs';
import { TCC0InterruptControl } from '../src/peripherals/tcc0-intctrla.mjs';

// Independent A3 addresses and NORMAL-mode expectations from XMEGA A Tables 14-1 and 14-4.
const CLK = 0x800, INT = 0x806, CNT = 0x820, PER = 0x826, PMIC_CTRL = 0xa2;
const VECTOR = 0x1c;
const reset = { intctrla: 0, overflowLevel: 0, errorLevel: 0, overflowFlag: false };

function fixture(blocks = [[0, [0, 0, 0, 0]], [VECTOR, [0x9518]]], other = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  for (const [pc, words] of blocks) {
    for (const [i, word] of words.entries()) {
      const offset = 2 * (pc + i);
      flash[offset] = word & 255;
      flash[offset + 1] = word >>> 8;
      present.fill(1, offset, offset + 2);
    }
  }
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, events = [];
  const counter = new TCC0Counter(), clock = new TCC0Clock({ counter });
  counter.register(bus.mmio, { mapPeriod: true });
  clock.register(bus.mmio);
  const control = new TCC0InterruptControl({ clock, onAccess: e => events.push(e) });
  control.register(bus.mmio, { context: () => ({ pcWord: cpu.pc }) });
  const pmic = new PMIC({ sources: [cycle => control.request(cycle), ...other],
    onAcknowledge: (request, cycle) => control.acknowledge(request, cycle) });
  bus.attachPMIC(pmic);
  return { cpu, bus, counter, clock, control, pmic, events };
}

function writeWord(bus, reg, word, t = 0) {
  bus.write(reg, word & 255, t);
  bus.write(reg + 1, word >>> 8, t);
}

test('TCC0 INTCTRLA resets, isolates the register and leaves unsupported flag and timer addresses unmapped', () => {
  const { cpu, bus, clock, counter, control } = fixture();
  assert.deepEqual(control.snapshot(), reset);
  assert.equal(bus.read(INT), 0);
  for (const address of [0x805, 0x807, 0x80c, 0x906]) {
    assert.throws(() => bus.read(address), { classification: 'UNHANDLED_MMIO' });
    assert.throws(() => bus.write(address, 1), { classification: 'UNHANDLED_MMIO' });
  }
  const keys = [...bus.mmio.handlers.keys()];
  assert.throws(() => new TCC0InterruptControl({ clock }).register(bus.mmio), /free INTCTRLA/);
  assert.deepEqual([...bus.mmio.handlers.keys()], keys);
  writeWord(bus, PER, 2);
  bus.write(CLK, 1); bus.write(INT, 15);
  assert.equal(control.request(2).vectorWord, VECTOR);
  counter.reset(3); cpu.cycles = 3;
  assert.equal(bus.read(INT), 0);
  assert.equal(control.request(4), null);
  assert.deepEqual(control.snapshot(), reset);
});

test('TCC0 INTCTRLA decodes both independent interrupt levels for every bus byte', () => {
  const { bus, counter, control, events } = fixture();
  for (let value = 0; value <= 255; value++) {
    const before = control.snapshot();
    bus.write(INT, value);
    const expected = { intctrla: value % 16, overflowLevel: value % 4,
      errorLevel: Math.floor(value / 4) % 4, overflowFlag: false };
    assert.deepEqual(control.snapshot(), expected);
    assert.deepEqual(events.at(-1), { origin: 'peripheral-model', eventType: 'timer-access', pcWord: 0,
      peripheral: 'TCC0', register: 'INTCTRLA', addressByte: INT, kind: 'write', cycle: 0,
      value, completed: true, before, after: expected });
    assert.equal(bus.read(INT), value % 16);
    assert.equal(control.request(0), null);
  }
  assert.deepEqual(counter.snapshotPeriod(), { per: 65535, cnt: 0, temp: 0 });
});

test('TCC0 INTCTRLA latches TOP while masked and preserves the flag across disable, relevel and polling', () => {
  const { bus, control, counter } = fixture();
  writeWord(bus, PER, 3);
  bus.write(CLK, 6, 5); // Shared divider edges at 256, 512, 768, 1024, ...
  assert.equal(control.request(767), null);
  assert.deepEqual([counter.cnt, control.overflowFlag], [2, false]);
  assert.equal(control.request(768), null);
  assert.deepEqual([counter.cnt, control.overflowFlag], [3, true]);
  for (const value of [13, 14, 15, 12, 1]) {
    bus.write(INT, value, 768);
    const level = value % 4;
    const expected = level ? { peripheral: 'TCC0', source: 'overflow', level, vectorWord: VECTOR } : null;
    assert.deepEqual(control.request(768), expected);
    assert.deepEqual(control.request(768), expected);
    assert.equal(control.overflowFlag, true);
  }
  control.acknowledge(control.request(768), 768);
  assert.equal(control.request(1024), null); // Bottom after TOP is a different edge.
  assert.equal(counter.cnt, 0);
  assert.equal(control.request(1791), null);
  assert.equal(control.request(1792).level, 1);
});

test('TCC0 INTCTRLA batched edges match a per-tick reference across TOP, MAX and zero periods', () => {
  for (const [top, initial] of [[0, 0], [0, 65534], [1, 1], [4, 2], [4, 65533], [65535, 65533]]) {
    const { bus, counter, control } = fixture();
    writeWord(bus, PER, top); writeWord(bus, CNT, initial);
    bus.write(INT, 1); bus.write(CLK, 1);
    let t = 0, value = initial;
    for (const ticks of [0, 1, 1, 2, 3, 9, 65537, 131075]) {
      let hit = false;
      for (let i = 0; i < ticks; i++) {
        value = value === top || value === 65535 ? 0 : value + 1;
        if (value === top) hit = true;
      }
      t += ticks;
      const request = control.request(t);
      assert.deepEqual([counter.cnt, Boolean(request)], [value, hit]);
      if (request) control.acknowledge(request, t);
    }
  }
});

test('TCC0 INTCTRLA honors a simultaneous CPU CNT commit and retains earlier TOPs in the same batch', () => {
  for (const [commitCycle, earlierTop] of [[3, false], [7, true]]) {
    const { bus, counter, control } = fixture();
    writeWord(bus, PER, 3); bus.write(INT, 1); bus.write(CLK, 1);
    bus.write(CNT, 1, 0); // Stage a new counter value before starting the timed interval.
    bus.write(CNT + 1, 0, commitCycle);
    assert.equal(counter.cnt, 1);
    const request = control.request(commitCycle);
    assert.equal(Boolean(request), earlierTop);
    if (request) control.acknowledge(request, commitCycle);
    assert.equal(control.request(commitCycle + 1), null);
    assert.equal(control.request(commitCycle + 2).level, 1);
  }
});

test('TCC0 INTCTRLA requires its overflow level, the corresponding PMIC mask and global I', () => {
  for (const global of [false, true]) for (let level = 0; level < 4; level++) {
    for (let mask = 0; mask < 8; mask++) {
      const { cpu, bus, control, pmic } = fixture();
      writeWord(bus, PER, 1); bus.write(CLK, 1); bus.write(INT, 12 + level); bus.write(PMIC_CTRL, mask);
      cpu.step(); // A real NOP takes the timer to TOP with global interrupts masked.
      assert.equal(control.request(1)?.level ?? 0, level);
      cpu.sreg = global ? 0xb5 : 0x35;
      const allowed = global && level > 0 && Boolean(mask & (2 ** (level - 1)));
      const event = cpu.step();
      assert.equal(event.eventType === 'interrupt-entry', allowed);
      assert.equal(cpu.pc, allowed ? VECTOR : 2);
      assert.equal(control.overflowFlag, !allowed);
      assert.equal(pmic.executingLevel, allowed ? level : 0);
    }
  }
});

test('TCC0 INTCTRLA keeps OVFIF pending when a competing higher-level vector wins arbitration', () => {
  const higher = { peripheral: 'TWIE', source: 'write', vectorWord: 0x5c, level: 3 };
  const { bus, control, pmic } = fixture(undefined, [() => higher]);
  writeWord(bus, PER, 1); bus.write(CLK, 1); bus.write(INT, 2); bus.write(PMIC_CTRL, 7);
  const winner = pmic.pending(1);
  assert.deepEqual(winner, higher);
  pmic.acknowledge(winner, 3);
  assert.equal(pmic.pending(3), null);
  assert.deepEqual(control.request(3), { peripheral: 'TCC0', source: 'overflow', vectorWord: VECTOR, level: 2 });
});

test('TCC0 INTCTRLA acknowledges at vector entry, preserves the three-byte return PC and executes RETI', () => {
  const { cpu, bus, control, pmic } = fixture([[0, [0x940d, 0x2345]],
    [0x12345, Array(9).fill(0)], [VECTOR, [0x9518]]]); // JMP to word 0x12345
  writeWord(bus, PER, 8); bus.write(CLK, 1); bus.write(INT, 2); bus.write(PMIC_CTRL, 2);
  cpu.sreg = 0xb5;
  while (cpu.cycles < 8) cpu.step();
  const pc = cpu.pc, sp = cpu.sp, steps = cpu.steps;
  assert.ok(pc > 0xffff);
  const e = cpu.step();
  assert.deepEqual([e.eventType, e.vectorPcWord, e.returnPcWord, e.before.cycles, e.after.cycles],
    ['interrupt-entry', VECTOR, pc, 8, 10]);
  assert.deepEqual([cpu.steps, cpu.sp, cpu.sreg, pmic.executingLevel, control.overflowFlag],
    [steps, sp - 3, 0xb5, 2, false]);
  assert.deepEqual([cpu.read(sp), cpu.read(sp - 1), cpu.read(sp - 2)], [pc & 255, pc >>> 8 & 255, pc >>> 16]);
  assert.equal(cpu.step().mnemonic, 'RETI');
  assert.deepEqual([cpu.pc, cpu.sp, cpu.sreg, pmic.executingLevel], [pc, sp, 0xb5, 0]);
});

test('TCC0 INTCTRLA executes displacement stores and loads in two clocks each and replays the bus trace', () => {
  function run() {
    // LDI R16,0x27; STD Z+6,R16; LDD R17,Z+6. Z holds an independent synthetic timer base.
    const { cpu, control, events } = fixture([[0, [0xe207, 0x8306, 0x8116]]]);
    cpu.setPair(30, 0x800);
    const steps = [cpu.step(), cpu.step(), cpu.step()];
    assert.deepEqual(steps.map(s => [s.mnemonic, s.after.pcWord, s.after.cycles]), [['LDI', 1, 1], ['STD', 2, 3], ['LDD', 3, 5]]);
    assert.deepEqual([cpu.r[16], cpu.r[17], cpu.pair(30), cpu.sreg, cpu.sp], [0x27, 7, 0x800, 0, 0x5fff]);
    assert.deepEqual(events.map(e => [e.kind, e.addressByte, e.value, e.cycle]), [['write', INT, 0x27, 3], ['read', INT, 7, 5]]);
    assert.deepEqual(control.snapshot(), { intctrla: 7, overflowLevel: 3, errorLevel: 1, overflowFlag: false });
    return { steps, events };
  }
  assert.deepEqual(run(), run());
});
