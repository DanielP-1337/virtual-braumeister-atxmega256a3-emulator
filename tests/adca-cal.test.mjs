import assert from 'node:assert/strict';
import test from 'node:test';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const temp = 0x0207, low = 0x020c, high = 0x020d;

test('ADCA calibration stages every low byte and commits the twelve-bit value with the high write', () => {
  const registry = new MMIORegistry(), adc = new ADCA();
  adc.register(registry);
  const l = registry.handlers.get(low), h = registry.handlers.get(high), t = registry.handlers.get(temp);
  assert.deepEqual(adc.snapshot(), { cal: 0, temp: 0 });
  for (let cal = 0; cal <= 0xfff; cal++) {
    const before = adc.snapshot().cal;
    l.write(cal & 255, 0);
    assert.equal(t.read(0), cal & 255);
    assert.equal(adc.snapshot().cal, before);
    h.write(0xf0 | (cal >>> 8), 1);
    assert.equal(adc.snapshot().cal, cal);
    assert.equal(l.read(2), cal & 255);
    assert.equal(h.read(3), cal >>> 8);
  }
  adc.reset();
  assert.deepEqual(adc.snapshot(), { cal: 0, temp: 0 });
});

test('ADCA calibration reads and writes use the same ADC TEMP and registration is atomic', () => {
  const registry = new MMIORegistry(), adc = new ADCA();
  const existing = { read: () => 0x70 };
  registry.map(high, existing);
  assert.throws(() => adc.register(registry), /registration collision/);
  assert.deepEqual([...registry.handlers], [[high, existing]]);
  const clean = new MMIORegistry();
  adc.register(clean);
  assert.throws(() => adc.register(registry), /registration collision/);
  assert.deepEqual([...clean.handlers.keys()], [temp, low, high]);
  const t = clean.handlers.get(temp), l = clean.handlers.get(low), h = clean.handlers.get(high);
  t.write(0x81, 0); h.write(7, 1);
  l.write(0x39, 2);
  assert.equal(l.read(3), 0x81);
  assert.equal(t.read(4), 7);
  h.write(5, 5);
  assert.equal(adc.snapshot().cal, 0x507);
});

test('ADCA calibration STS records the bus value and both calibration states at the completion edge', () => {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  // STS CALL,R19 / STS CALH,R20
  const program = [0x30, 0x93, 0x0c, 0x02, 0x40, 0x93, 0x0d, 0x02];
  flash.set(program); present.fill(1, 0, program.length);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: e => events.push(e) });
  adc.register(cpu.bus.mmio, { context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  cpu.r[19] = 0x96; cpu.r[20] = 0x03;
  const first = cpu.step(), second = cpu.step();
  assert.deepEqual([first.mnemonic, second.mnemonic, cpu.cycles, cpu.pc], ['STS', 'STS', 4, 4]);
  assert.deepEqual(events.map(e => [e.register, e.value, e.pcWord, e.cycle, e.instructionAttempt, e.before.cal, e.after.cal, e.after.temp]),
    [['CALL', 0x96, 0, 2, 1, 0, 0, 0x96], ['CALH', 3, 2, 4, 2, 0, 0x396, 0x96]]);
});
