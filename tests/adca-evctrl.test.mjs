import test from 'node:test';
import assert from 'node:assert/strict';
import { ADCA } from '../src/peripherals/adca.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

const eventControl = 0x0203;

test('ADCA EVCTRL round-trips every defined sweep, event input group and event action', () => {
  const adc = new ADCA(), registry = new MMIORegistry();
  adc.register(registry, { mapCalibration: false, mapEvctrl: true });
  assert.deepEqual([...registry.handlers.keys()], [eventControl]);
  const control = registry.handlers.get(eventControl);
  assert.equal(control.read(0), 0);
  for (let raw = 0; raw <= 0xff; raw++) {
    if ((raw & 7) === 7) {
      const before = control.read(1);
      assert.throws(() => control.write(raw, 2), e => e.classification === 'ADCA_RESERVED_EVENT_ACTION');
      assert.equal(control.read(3), before);
    } else {
      control.write(raw, 2);
      assert.equal(control.read(3), raw);
    }
  }
  adc.reset();
  assert.equal(control.read(4), 0);
});

function fixture() {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0x10, 0x92, 0x03, 0x02]); // STS 0x0203,R1
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: event => events.push(event) });
  adc.register(cpu.bus.mmio, { mapCtrla: true, mapCtrlb: true, mapRefctrl: true, mapEvctrl: true,
    fault: (message, details) => cpu.fault(message, details) });
  return { cpu, adc, events };
}

test('CPU STS selects no ADC event action while preserving the enabled ADC and reference', () => {
  const { cpu, adc, events } = fixture();
  cpu.bus.write(0x020c, 0x5a);
  cpu.bus.write(0x020d, 3);
  cpu.bus.write(0x0200, 1);
  cpu.bus.write(0x0202, 0x12);
  cpu.bus.write(eventControl, 0xd5);
  const before = adc.snapshot();
  const trace = cpu.step(), event = events.at(-1);
  assert.deepEqual([trace.mnemonic, trace.after.pcWord, trace.after.cycles], ['STS', 2, 2]);
  assert.deepEqual(trace.accesses.at(-1), { kind: 'write', space: 'mmio', addressByte: eventControl, value: 0 });
  assert.deepEqual([event.register, event.completed, event.cycle, event.before, event.after],
    ['EVCTRL', true, 2, before, { cal: 0x035a, temp: 0x5a, ctrla: 1, ctrlb: 0, refctrl: 0x12, evctrl: 0 }]);
});

test('A reserved ADC event action stops STS before the register or CPU state changes', () => {
  const { cpu, adc, events } = fixture();
  cpu.bus.write(eventControl, 0xc9);
  cpu.r[1] = 0x2f;
  const before = adc.snapshot(), cpuBefore = cpu.state();
  assert.throws(() => cpu.step(), e => e.classification === 'ADCA_RESERVED_EVENT_ACTION' && e.addressByte === eventControl && e.attemptedValue === 0x2f);
  assert.deepEqual(cpu.state(), cpuBefore);
  assert.deepEqual(adc.snapshot(), before);
  const event = events.at(-1);
  assert.deepEqual([event.completed, event.classification, event.before, event.after], [false, 'ADCA_RESERVED_EVENT_ACTION', before, before]);
});
