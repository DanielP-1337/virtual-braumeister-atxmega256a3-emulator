import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const reference = 0x0202;

test('ADCA REFCTRL retains all four reference selections and independent sensor enables', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapRefctrl: true });
  assert.deepEqual([...registry.handlers.keys()], [reference]);
  const control = registry.handlers.get(reference);
  assert.equal(control.read(0), 0);
  for (let raw = 0; raw <= 0xff; raw++) {
    control.write(raw, 1);
    assert.equal(control.read(2), raw & 0x33);
  }
  adc.reset();
  assert.equal(control.read(3), 0);
});

test('CPU STS selects INTVCC and the bandgap at the REFCTRL write edge', () => {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0x80, 0x93, 0x02, 0x02]); // STS 0x0202,R24
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: event => events.push(event) });
  adc.register(cpu.bus.mmio, { mapCtrla: true, mapCtrlb: true, mapRefctrl: true });
  cpu.bus.write(0x020c, 0x5a);
  cpu.bus.write(0x020d, 3);
  cpu.bus.write(0x0200, 1);
  const before = adc.snapshot();
  cpu.r[24] = 0x12;
  const trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: reference, value: 0x12 });
  assert.deepEqual([event.register, event.completed, event.cycle, event.before, event.after],
    ['REFCTRL', true, 2, before, { cal: 0x035a, temp: 0x5a, ctrla: 1, ctrlb: 0, refctrl: 0x12 }]);
});
