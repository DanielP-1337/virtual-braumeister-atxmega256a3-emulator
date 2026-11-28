import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { ADCASingleConversion } from '../src/peripherals/adca-conversion.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { adcaSampleInput } from '../scripts/adca-input.mjs';

const ctrla = 0x200, flags = 0x206, temp = 0x207, low = 0x210, high = 0x211;
const channel = 0x220, channelFlags = 0x223, request = 10000;
function fixture(options, prescaler = 6) {
  const conversion = new ADCASingleConversion(options), adc = new ADCA({ conversion });
  const registry = new MMIORegistry();
  adc.register(registry, { mapCtrla: true, mapCtrlb: true, mapRefctrl: true, mapEvctrl: true, mapPrescaler: true,
    mapCh0Ctrl: true, mapCh0Muxctrl: true, mapCh0Intctrl: true, mapCh0Intflags: true,
    mapInterruptFlags: true, mapChannel0Result: true });
  const write = (address, byte, cycle) => registry.handlers.get(address).write(byte, cycle);
  const read = (address, cycle) => registry.handlers.get(address).read(cycle);
  write(ctrla, 1, 0);
  write(0x202, 0x12, 1);
  write(0x204, prescaler, 2);
  write(0x221, 8, 3);
  write(channel, 1, 4);
  return { adc, conversion, write, read };
}
const classified = classification => error => error.classification === classification;

test('ADCA starts on each of 256 eligible clock phases and raises both CH0 flags seven ADC clocks later', () => {
  for (let phase = 0; phase < 256; phase++) {
    const { adc, conversion, read, write } = fixture({ clockPhase: phase, results: [0xa51] });
    write(ctrla, 5, request);
    const start = request + 1 + ((phase - (request + 1) % 256 + 256) % 256);
    assert.equal(conversion.pending.inputPin, 1);
    assert.equal(read(ctrla, start - 1), 5);
    assert.equal(read(channel, start - 1), 0x81);
    assert.equal(read(ctrla, start), 1);
    assert.equal(read(channel, start), 1);
    assert.equal(read(flags, start + 1791), 0);
    assert.equal(read(channelFlags, start + 1792), 1);
    assert.equal(adc.needsClock, false);
    assert.equal(read(flags, start + 1792), 1);
    write(flags, 0xfe, start + 1793);
    assert.equal(read(channelFlags, start + 1793), 1);
    write(channelFlags, 1, start + 1794);
    assert.equal(read(flags, start + 1794), 0);
  }
});

test('ADCA returns every 12-bit raw code through both little-endian aliases and the shared temporary register', () => {
  const results = Array.from({ length: 4096 }, (_, i) => i);
  const { conversion, read, write } = fixture({ clockPhase: 0, results }, 0);
  for (const raw of results) {
    const cycle = request + 32 * raw;
    write(channel, 0x81, cycle);
    assert.equal(read(flags, cycle + 32), 1);
    write(flags, 1, cycle + 32);
    write(temp, 0xcd, cycle + 32);
    assert.equal(read(high, cycle + 32), 0xcd);
    assert.equal(read(0x224, cycle + 32), raw & 0xff);
    assert.equal(read(high, cycle + 32), raw >>> 8);
    write(temp, 0xee, cycle + 32);
    assert.equal(read(low, cycle + 32), raw & 0xff);
    assert.equal(read(0x225, cycle + 32), raw >>> 8);
    assert.equal(read(temp, cycle + 32), raw >>> 8);
  }
  assert.equal(conversion.requestCount, 4096);
});

test('ADCA exposes definite states without a clock phase and stops at a phase-dependent observation', () => {
  const { conversion, read, write } = fixture({ results: [0x321] });
  write(ctrla, 5, request);
  const { firstStart, lastStart, firstComplete, lastComplete } = conversion.pending;
  assert.deepEqual([firstStart, lastStart, firstComplete, lastComplete],
    [request + 1, request + 256, request + 1793, request + 2048]);
  assert.equal(read(channel, request), 0x81);
  assert.throws(() => read(channel, firstStart), classified('ADCA_CLOCK_PHASE_UNKNOWN'));
  assert.equal(read(channel, lastStart), 1);
  assert.equal(read(flags, firstComplete - 1), 0);
  assert.throws(() => read(flags, firstComplete), classified('ADCA_CLOCK_PHASE_UNKNOWN'));
  assert.throws(() => write(channelFlags, 1, lastComplete - 1), classified('ADCA_CLOCK_PHASE_UNKNOWN'));
  assert.equal(read(flags, lastComplete), 1);
  assert.equal(read(low, lastComplete), 0x21);
  assert.equal(read(high, lastComplete), 3);
});

test('ADCA keeps a missing sample unknown and resets the result cursor and pending state on reset', () => {
  const { adc, conversion, read, write } = fixture({ clockPhase: 0, results: [0xbad] }, 0);
  write(ctrla, 5, request);
  assert.equal(read(low, request + 32), 0xad);
  assert.equal(read(high, request + 32), 0xb);
  write(channelFlags, 1, request + 32);
  write(ctrla, 5, request + 32);
  assert.equal(read(flags, request + 64), 1);
  write(flags, 1, request + 64);
  assert.equal(read(high, request + 64), 0xb);
  assert.throws(() => read(low, request + 64), classified('ADCA_RESULT_UNKNOWN'));
  assert.throws(() => write(low, 7, request + 64), classified('ADCA_RESULT_READ_ONLY'));
  adc.reset();
  assert.deepEqual(conversion.snapshot(), { requests: 0, pending: null, result: 0 });
  assert.deepEqual([read(flags, 0), read(low, 0), read(high, 0)], [0, 0, 0]);
  write(ctrla, 1, 0); write(channel, 1, 1); write(ctrla, 5, request);
  assert.equal(read(low, request + 32), 0xad);
});

test('ADCA preserves the current request across premature, unsupported and overlapping trigger attempts', () => {
  const { adc, conversion, read, write } = fixture({ clockPhase: 0 }, 7);
  write(0x204, 0, 90);
  assert.throws(() => write(ctrla, 5, 101), classified('ADCA_STARTUP_TIMING_UNRESOLVED'));
  write(0x222, 1, 200);
  assert.throws(() => write(ctrla, 5, request), classified('ADCA_CONVERSION_CONFIGURATION_UNSUPPORTED'));
  write(0x222, 0, request); write(ctrla, 5, request); write(channel, 0x81, request + 1);
  const pending = { ...conversion.pending };
  assert.equal(conversion.requestCount, 1);
  assert.throws(() => write(ctrla, 5, pending.firstStart), classified('ADCA_OVERLAPPING_START_UNSUPPORTED'));
  assert.throws(() => write(0x221, 0, pending.firstStart), classified('ADCA_ACTIVE_CONFIGURATION_UNSUPPORTED'));
  assert.deepEqual(conversion.pending, pending);
  adc.advanceTo(pending.firstComplete);
  assert.equal(read(flags, pending.firstComplete), 1);
  assert.throws(() => write(0x222, 1, pending.firstComplete), classified('ADCA_PENDING_INTERRUPT_UNSUPPORTED'));
});

test('ADCA scenario input accepts explicit phases and finite sample lists independently', () => {
  assert.equal(adcaSampleInput(undefined, undefined), null);
  assert.deepEqual(adcaSampleInput('0', undefined), { clockPhase: 0, results: [] });
  assert.deepEqual(adcaSampleInput(undefined, '0x000,0xa57,0xFFF'), { clockPhase: null, results: [0, 0xa57, 4095] });
  assert.deepEqual(adcaSampleInput('511', '0x000'), { clockPhase: 511, results: [0] });
  for (const phase of ['512', '-1', '', '1.5', '1 ']) assert.throws(() => adcaSampleInput(phase, undefined));
  for (const codes of ['', '0x1000', '0x000,', '0xff', '0x000,,0x001']) assert.throws(() => adcaSampleInput(undefined, codes));
  for (const options of [{ clockPhase: 512 }, { results: [1, undefined] }, { results: [-1] }, { results: [4096] }]) {
    assert.throws(() => new ADCASingleConversion(options), RangeError);
  }
});
