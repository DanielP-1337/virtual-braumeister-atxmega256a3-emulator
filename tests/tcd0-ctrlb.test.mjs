import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';
import { TC0WaveformControl } from '../src/peripherals/tc0-ctrlb.mjs';
import { TCC0WaveformControl } from '../src/peripherals/tcc0-ctrlb.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';

// Literal addresses and encodings are from the non-U ATxmega256A3 device pack and XMEGA A table 14-4.
const CLK = 0x0900, MODE = 0x0901, FCLR = 0x0908, FSET = 0x0909, GCLR = 0x090a;
const CNT = 0x0920, PER = 0x0926, C = 0x092c, D = 0x092e, CBUF = 0x093c, DBUF = 0x093e;
const BOTH = 0x18, LOCK = 0x02, FORCE = 0x04;

function fixture({ words = [], install = true } = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const view = new DataView(flash.buffer);
  words.forEach((word, i) => view.setUint16(2 * i, word, true));
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, events = [];
  const timer = new TC0Counter('TCD0'), clock = new TC0Clock('TCD0', { counter: timer });
  const control = new TC0WaveformControl('TCD0', { clock, onAccess: e => events.push(e) });
  const opts = { fault: (message, details) => cpu.fault(message, details),
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) };
  timer.register(bus.mmio, { ...opts, mapPeriod: true, mapCompareC: true, mapCompareD: true });
  clock.register(bus.mmio, opts);
  if (install) control.register(bus.mmio, opts);
  return { cpu, bus, timer, clock, control, events, opts };
}

function put(bus, addr, value, cycle = 0) {
  bus.write(addr, value % 256, cycle);
  bus.write(addr + 1, Math.floor(value / 256), cycle);
}
function word(bus, addr, cycle) { return bus.read(addr, cycle) + bus.read(addr + 1, cycle) * 256; }
function state(bus, cycle) {
  return [word(bus, CNT, cycle), word(bus, C, cycle), word(bus, D, cycle), bus.read(GCLR, cycle)];
}

test('TCD0 CTRLB resets on timer reset and claims only the control byte of its own registered timer', () => {
  const a = fixture({ install: false }), b = fixture();
  assert.throws(() => a.control.register(b.bus.mmio), /registered clock/);
  assert.throws(() => new TCC0WaveformControl({ clock: a.clock }).register(a.bus.mmio), /registered clock/);
  a.bus.mmio.map(MODE, { read: () => 0x59 });
  assert.throws(() => a.control.register(a.bus.mmio), /free CTRLB/);
  assert.equal(a.bus.read(MODE), 0x59);
  assert.equal(a.clock.waveform, undefined);
  assert.equal(b.bus.read(MODE), 0);
  b.bus.write(MODE, 0xcb); b.bus.write(CLK, 1);
  b.timer.reset(8);
  assert.deepEqual([b.control.snapshot(), b.bus.read(MODE, 8), b.clock.snapshot(8).divider], [{ ctrlb: 0, wgmode: 0, channelEnables: 0 }, 0, 0]);
  for (const addr of [0x0801, 0x0902, 0x0941, 0x0966]) assert.throws(() => b.bus.write(addr, 1, 9),
    e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === addr);
});

test('TCD0 CTRLB classifies every byte and independently preserves the four enables and reserved bit readback', () => {
  const { bus, control, clock, timer, events } = fixture();
  const reason = [null, 'TCD0_WAVEFORM_MODE_UNMODELED', 'TCD0_RESERVED_WGMODE', null,
    'TCD0_RESERVED_WGMODE', 'TCD0_WAVEFORM_MODE_UNMODELED', 'TCD0_WAVEFORM_MODE_UNMODELED', 'TCD0_WAVEFORM_MODE_UNMODELED'];
  bus.write(CLK, 1);
  for (let raw = 0; raw <= 255; raw++) {
    const mode = raw % 8, channels = Math.floor(raw / 16), before = control.snapshot();
    if (reason[mode]) {
      assert.throws(() => bus.write(MODE, raw, 5), e => e.classification === reason[mode] && e.accessKind === 'write' && e.attemptedValue === raw);
      assert.deepEqual([events.at(-1).completed, events.at(-1).before, events.at(-1).after, timer.cnt, clock.lastCycle], [false, before, before, 0, 0]);
    } else {
      bus.write(MODE, raw, 0);
      assert.deepEqual(control.snapshot(), { ctrlb: 16 * channels + mode, wgmode: mode, channelEnables: channels });
      assert.equal(bus.read(MODE, 0), 16 * channels + mode);
      assert.equal(events.at(-1).completed, true);
    }
  }
});

test('TCD0 CTRLB single-slope counts through PER and transfers C and D only upon reaching BOTTOM', () => {
  const { bus } = fixture();
  put(bus, PER, 3); put(bus, C, 0x1133); put(bus, D, 0x2244);
  put(bus, CBUF, 0x5577); put(bus, DBUF, 0xaaee);
  bus.write(MODE, 0xc3, 0);
  assert.deepEqual(state(bus, 32), [0, 0x1133, 0x2244, BOTH]);
  bus.write(CLK, 3, 32); // clkPER/4. The first three edges reach TOP.
  assert.deepEqual(state(bus, 43), [2, 0x1133, 0x2244, BOTH]);
  assert.deepEqual(state(bus, 44), [3, 0x1133, 0x2244, BOTH]);
  assert.deepEqual(state(bus, 47), [3, 0x1133, 0x2244, BOTH]);
  assert.deepEqual(state(bus, 48), [0, 0x5577, 0xaaee, 0]);
  assert.deepEqual([word(bus, PER, 48), word(bus, CBUF, 48), word(bus, DBUF, 48)], [3, 0x5577, 0xaaee]);
});

test('TCD0 CTRLB obeys LUPD, software UPDATE and independent validity even when output routing is disabled', () => {
  const { bus } = fixture();
  put(bus, PER, 3); put(bus, C, 0x1010); put(bus, D, 0x2020);
  put(bus, CBUF, 0x3131); put(bus, DBUF, 0x4242);
  bus.write(MODE, 0x03); bus.write(FSET, LOCK); bus.write(CLK, 1);
  bus.write(FSET, FORCE, 4);
  assert.deepEqual(state(bus, 4), [0, 0x1010, 0x2020, BOTH]);
  bus.write(FCLR, LOCK, 5); bus.write(GCLR, 0x08, 5);
  assert.deepEqual(state(bus, 7), [3, 0x1010, 0x2020, 0x10]);
  assert.deepEqual(state(bus, 8), [0, 0x1010, 0x4242, 0]);
  put(bus, CBUF, 0x569a, 9);
  bus.write(FSET, FORCE, 10);
  assert.deepEqual(state(bus, 10), [2, 0x569a, 0x4242, 0]);
});

test('TCD0 CTRLB mode writes account for the old mode on the completion edge while preserving CNT and divisor phase', () => {
  const { bus, clock } = fixture();
  put(bus, PER, 3); put(bus, CBUF, 0x1357); bus.write(CLK, 3);
  bus.write(MODE, 0xc3, 12); // The old NORMAL mode updates on this TOP.
  assert.deepEqual(state(bus, 12), [3, 0x1357, 0, 0]);
  put(bus, DBUF, 0x9753, 13);
  bus.write(MODE, 0x00, 16); // The old single-slope mode updates on this BOTTOM.
  assert.deepEqual(state(bus, 16), [0, 0x1357, 0x9753, 0]);
  put(bus, CBUF, 0x2299, 17);
  assert.deepEqual(state(bus, 27), [2, 0x1357, 0x9753, 8]);
  assert.deepEqual(state(bus, 28), [3, 0x2299, 0x9753, 0]);
  assert.equal(clock.snapshot(28).divider, 4);
});

test('TCD0 CTRLB continues a paused prescaler and finds BOTTOM across a missed TOP, multiple periods and all internal divisors', () => {
  for (const [i, divisor] of [1, 2, 4, 8, 64, 256, 1024].entries()) {
    for (const period of [3, 17, 0xffff]) {
      const { bus, timer } = fixture();
      put(bus, PER, period); put(bus, CNT, 0xfffc);
      put(bus, DBUF, 0xb816); bus.write(MODE, 0x83);
      bus.write(CLK, i + 1, 7 * divisor);
      let cnt = 0xfffc, seenBottom = false, previous = 0;
      for (const edges of [1, 2, 3, 4, 5, period + 8, 2 * period + 18]) {
        // Independent oracle clocks one timer edge at a time, including a possible 16-bit wrap.
        for (let e = previous; e < edges; e++) {
          cnt = cnt === period ? 0 : (cnt + 1) % 65536;
          if (cnt === 0) seenBottom = true;
        }
        const cycle = (7 + edges) * divisor;
        assert.deepEqual([word(bus, D, cycle), bus.read(GCLR, cycle), timer.cnt], [seenBottom ? 0xb816 : 0, seenBottom ? 0 : 16, cnt]);
        previous = edges;
      }
    }
  }
  const { bus } = fixture();
  put(bus, PER, 3); put(bus, DBUF, 0x7001); bus.write(MODE, 0x83); bus.write(CLK, 3);
  bus.write(CLK, 0, 9); assert.deepEqual(state(bus, 101), [2, 0, 0, 16]);
  bus.write(CLK, 3, 101); assert.deepEqual(state(bus, 104), [3, 0, 0, 16]);
  assert.deepEqual(state(bus, 108), [0, 0, 0x7001, 0]);
});

test('TCD0 CTRLB suppresses the BOTTOM event on a coincident CPU counter commit and preserves staged data', () => {
  const { bus } = fixture();
  put(bus, PER, 3); put(bus, CBUF, 0xc741); bus.write(MODE, 0x43); bus.write(CLK, 1);
  bus.write(CNT, 0, 3); bus.write(CNT + 1, 0, 4); // Software writes zero in place of the hardware wrap.
  assert.deepEqual(state(bus, 4), [0, 0, 0, 8]);
  assert.deepEqual(state(bus, 7), [3, 0, 0, 8]);
  assert.deepEqual(state(bus, 8), [0, 0xc741, 0, 0]);
});

test('TCD0 CTRLB a high-byte commit on BOTTOM leaves the replacement pending for the next PWM period', () => {
  const { bus } = fixture();
  put(bus, PER, 3); put(bus, CBUF, 0xabcd); put(bus, DBUF, 0x4321);
  bus.write(MODE, 0xc3); bus.write(CLK, 1);
  bus.write(DBUF, 0x98, 3); bus.write(DBUF + 1, 0x76, 4);
  assert.deepEqual(state(bus, 4), [0, 0xabcd, 0x4321, 16]);
  assert.equal(word(bus, DBUF, 4), 0x7698);
  assert.deepEqual(state(bus, 8), [0, 0xabcd, 0x7698, 0]);
});

test('TCD0 CTRLB routes only enabled output pads and keeps the GPIO latch, unresolved waveform and external input distinct', () => {
  const { bus, control } = fixture();
  const gpio = new GPIOController({ unresolvedOutputSource: (port, pin) => control.outputSource(port, pin) });
  gpio.register(bus.mmio);
  bus.write(0x0660, 0xff); bus.write(0x0664, 0xa5);
  for (let enables = 0; enables < 16; enables++) {
    bus.write(MODE, enables * 16 + 3);
    for (let pin = 0; pin < 8; pin++) {
      const pad = gpio.drive('D', pin), latch = (0xa5 >>> pin) & 1;
      const routed = pin < 4 && (enables & (1 << pin)) !== 0;
      assert.deepEqual([pad.latch, pad.source, pad.drive, pad.highImpedance],
        [latch, routed ? 'TCD0.OC0' + 'ABCD'[pin] : undefined, routed ? 'unresolved' : latch, false]);
    }
  }
  bus.write(MODE, 0xc3); bus.write(0x0672, 0x68); // Inverted wired-AND on PD2.
  assert.deepEqual([gpio.drive('D', 2).drive, gpio.drive('D', 2).highImpedance], ['unresolved', null]);
  assert.equal(gpio.drive('C', 2).source, undefined);
  bus.write(0x0662, 4); // DIRCLR releases PD2.
  assert.deepEqual([gpio.drive('D', 2).drive, gpio.drive('D', 2).highImpedance, gpio.drive('D', 2).source], [null, true, undefined]);
  assert.equal(bus.read(0x0664), 0xa5);
  assert.throws(() => bus.read(0x0668), e => e.classification === 'GPIO_UNRESOLVED_INPUT');
  bus.write(MODE, 0xc0);
  assert.deepEqual([gpio.drive('D', 3).source, gpio.drive('D', 3).drive], [undefined, 0]);
});

test('TCD0 CTRLB runs independently of the C0 NORMAL overflow and update point on the same bus', () => {
  const { bus } = fixture();
  const timerC = new TC0Counter('TCC0'), clockC = new TC0Clock('TCC0', { counter: timerC });
  timerC.register(bus.mmio, { mapPeriod: true, mapCompareC: true });
  clockC.register(bus.mmio); new TCC0WaveformControl({ clock: clockC }).register(bus.mmio);
  put(bus, 0x0826, 3); put(bus, PER, 3); put(bus, 0x083c, 0x4132); put(bus, CBUF, 0x5284);
  bus.write(MODE, 0xc3); bus.write(0x0801, 0xc0); bus.write(0x0800, 1); bus.write(CLK, 1);
  assert.deepEqual([word(bus, 0x082c, 3), word(bus, C, 3), bus.read(GCLR, 3)], [0x4132, 0, 8]);
  assert.deepEqual([word(bus, 0x082c, 4), word(bus, C, 4), bus.read(GCLR, 4)], [0x4132, 0x5284, 0]);
});

test('TCD0 CTRLB AVR control and clock stores retire on their bus cycles and replay before an unmapped TC1 store', () => {
  function run() {
    // STD Z+1,R20; ST Z,R21; LDD R22,Z+1; STS 0x0966,R18.
    const { cpu, bus, events, clock, timer } = fixture({ words: [0x8341, 0x8350, 0x8161, 0x9320, 0x0966, 0] });
    cpu.setPair(30, CLK); cpu.r[20] = 0xc3; cpu.r[21] = 1; cpu.r[18] = 0x7e; cpu.sreg = 0x95;
    put(bus, PER, 3); put(bus, DBUF, 0xc781);
    const steps = [cpu.step(), cpu.step(), cpu.step()];
    assert.deepEqual(steps.map(s => [s.mnemonic, s.after.pcWord, s.after.cycles]), [['STD',1,2],['ST',2,3],['LDD',3,5]]);
    assert.deepEqual([cpu.r[22],cpu.sreg,cpu.sp,cpu.pair(30),clock.snapshot(5).divider,timer.cnt], [0xc3,0x95,0x5fff,CLK,1,2]);
    assert.deepEqual(events.map(e => [e.origin,e.register,e.kind,e.value,e.cycle]), [
      ['peripheral-model','CTRLB','write',0xc3,2],['peripheral-model','CTRLB','read',0xc3,5]]);
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x0966 && e.attemptedValue === 0x7e);
    assert.deepEqual(cpu.state(), before);
    return { steps, events };
  }
  assert.deepEqual(run(), run());
});
