import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { TCC0Clock } from '../src/peripherals/tcc0-clock.mjs';
import { TCC0Counter } from '../src/peripherals/tcc0-counter.mjs';
import { TCC0WaveformControl } from '../src/peripherals/tcc0-ctrlb.mjs';

const ctrla = 0x0800, ctrlb = 0x0801, temp = 0x080f, low = 0x0820, high = 0x0821;
function fixture(words = [], install = true) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => {
    flash[2*i] = word & 0xff;
    flash[2*i+1] = word >>> 8;
  });
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, events = [];
  const counter = new TCC0Counter(), clock = new TCC0Clock({ counter });
  counter.register(bus.mmio);
  clock.register(bus.mmio);
  const waveform = new TCC0WaveformControl({ clock, onAccess: event => events.push(event) });
  const options = { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (message, details) => cpu.fault(message, details) };
  if (install) waveform.register(bus.mmio, options);
  return { cpu, bus, counter, clock, waveform, events };
}

test('TCC0 CTRLB resets to NORMAL with A through D disabled on every timer reset', () => {
  const { bus, counter, waveform, events } = fixture();
  assert.equal(bus.read(ctrlb, 0), 0);
  bus.write(ctrlb, 0xf0, 1);
  const count = events.length;
  counter.reset();
  assert.equal(events.length, count);
  assert.deepEqual(waveform.snapshot(), { ctrlb: 0, wgmode: 0, channelEnables: 0 });
  assert.equal(bus.read(ctrlb, 0), 0);
});

test('TCC0 CTRLB normal mode supports all four channel bits and masks read-only bit 3', () => {
  const { bus, waveform } = fixture();
  for (let channels = 15; channels >= 0; channels--) {
    for (const unused of [0, 8]) {
      const writable = channels * 16;
      bus.write(ctrlb, writable + unused);
      assert.deepEqual(waveform.snapshot(), { ctrlb: writable, wgmode: 0, channelEnables: channels });
      assert.equal(bus.read(ctrlb), writable);
    }
  }
});

test('TCC0 CTRLB rejects all reserved and unimplemented mode encodings atomically', () => {
  const { bus, waveform, events } = fixture();
  bus.write(ctrlb, 0x90, 0);
  const before = waveform.snapshot();
  // Table 14-4 defines NORMAL, FRQ, reserved, single-slope, reserved, and three dual-slope modes.
  const reason = [null,'TCC0_WAVEFORM_MODE_UNMODELED','TCC0_RESERVED_WGMODE','TCC0_WAVEFORM_MODE_UNMODELED',
    'TCC0_RESERVED_WGMODE','TCC0_WAVEFORM_MODE_UNMODELED','TCC0_WAVEFORM_MODE_UNMODELED','TCC0_WAVEFORM_MODE_UNMODELED'];
  for (let value = 0; value < 256; value++) {
    const classification = reason[value % 8];
    if (!classification) continue;
    assert.throws(() => bus.write(ctrlb, value, 2), error => error.classification === classification &&
      error.attemptedValue === value && error.addressByte === ctrlb && error.accessKind === 'write');
    const event = events.at(-1);
    assert.deepEqual([event.completed,event.classification,event.value,event.before,event.after],
      [false,classification,value,before,before]);
    assert.equal(bus.read(ctrlb, 0), 0x90);
  }
});

test('TCC0 CTRLB normal writes preserve the running clock, counter, TEMP and divider phase', () => {
  const { bus, counter, clock } = fixture();
  bus.write(low, 0xfe, 0);
  bus.write(high, 0x42, 0);
  bus.write(temp, 0x73, 0);
  bus.write(ctrla, 6, 120);
  bus.write(ctrlb, 0xf0, 255);
  assert.deepEqual(counter.snapshot(), { cnt: 0x42fe, temp: 0x73 });
  bus.write(ctrlb, 0, 256);
  assert.deepEqual(counter.snapshot(), { cnt: 0x42ff, temp: 0x73 });
  assert.equal(bus.read(ctrlb, 511), 0);
  assert.deepEqual(clock.snapshot(512), { ctrla: 6, divider: 256 });
  assert.deepEqual(counter.snapshot(), { cnt: 0x4300, temp: 0x73 });
});

test('TCC0 CTRLB normal channel enables preserve GPIO drive and leave the clock off after reset', () => {
  const { bus, clock, counter } = fixture(), gpio = new GPIOController();
  gpio.register(bus.mmio);
  bus.write(0x0640, 0xf0, 0);
  bus.write(0x0644, 0xa5, 0);
  const pins = () => Array.from({ length: 8 }, (_, pin) => gpio.drive('C', pin));
  const original = pins();
  for (const value of [0x10,0x20,0x40,0x80,0xf0,0]) {
    bus.write(ctrlb, value, 256);
    assert.deepEqual(pins(), original);
  }
  assert.deepEqual(clock.snapshot(2048), { ctrla: 0, divider: 0 });
  assert.equal(counter.snapshot().cnt, 0);
});

test('TCC0 CTRLB owns exactly one register on its associated timer', () => {
  const a = fixture([], false), b = fixture();
  assert.throws(() => a.waveform.register(b.bus.mmio));
  const existing = { read: () => 0x52 };
  a.bus.mmio.map(ctrlb, existing);
  assert.throws(() => a.waveform.register(a.bus.mmio));
  assert.equal(a.bus.mmio.handlers.get(ctrlb), existing);
  b.bus.write(ctrlb, 0x30);
  assert.equal(a.bus.read(ctrlb), 0x52);
  for (const address of [0x0802,0x0803,0x0826,0x0841,0x0901]) {
    assert.throws(() => b.bus.write(address, 0), error => error.classification === 'UNHANDLED_MMIO' && error.addressByte === address);
  }
});

test('TCC0 CTRLB indirect CPU stores and reads use the completion edge and replay exactly', () => {
  function run() {
    // STD Z+1,R20 and LDD R21,Z+1. Z is the timer base.
    const { cpu, events, waveform } = fixture([0x8341,0x8151]);
    cpu.setPair(30, ctrla);
    cpu.sreg = 0xb5;
    cpu.r[20] = 0x58;
    const first = cpu.step(), second = cpu.step();
    assert.deepEqual([first.mnemonic, first.after.pcWord, first.after.cycles], ['STD',1,2]);
    assert.deepEqual([second.mnemonic, second.after.pcWord, second.after.cycles], ['LDD',2,4]);
    assert.deepEqual([cpu.r[21],cpu.sp,cpu.sreg,cpu.pair(30)], [0x50,0x5fff,0xb5,ctrla]);
    assert.deepEqual(events.map(e=>[e.origin,e.pcWord,e.cycle,e.kind,e.value,e.completed]), [
      ['peripheral-model',0,2,'write',0x58,true], ['peripheral-model',1,4,'read',0x50,true],
    ]);
    return { first, second, events, state: waveform.snapshot() };
  }
  assert.deepEqual(run(), run());
});

test('TCC0 CTRLB rejected CPU store preserves retirement and leaves no peripheral clock advance', () => {
  const { cpu, bus, counter, clock, events } = fixture([0x8341]);
  cpu.setPair(30, ctrla);
  cpu.r[20] = 0x53;
  bus.write(ctrla, 1, 0);
  assert.throws(() => cpu.step(), e => e.classification === 'TCC0_WAVEFORM_MODE_UNMODELED');
  assert.deepEqual([cpu.cycles,cpu.steps,cpu.pc,cpu.r[20]], [0,0,0,0x53]);
  assert.deepEqual(clock.snapshot(0), { ctrla: 1, divider: 1 });
  assert.deepEqual(counter.snapshot(), { cnt: 0, temp: 0 });
  assert.equal(events.at(-1).completed, false);
});
