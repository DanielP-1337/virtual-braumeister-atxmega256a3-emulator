import test from 'node:test';
import assert from 'node:assert/strict';
import { GPIOController, PORT_BASES } from '../src/peripherals/gpio.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

function fixture(capture = true) {
  const c = new XmegaCPU({ flash: new Uint8Array(0x42000), present: new Uint8Array(0x42000) });
  const log = [], gpio = new GPIOController({ onAccess: capture ? e => log.push(e) : null });
  gpio.register(c.bus.mmio, { fault: (m, d) => c.fault(m, d), context: () => ({ pcWord: c.pc, cyclesBefore: c.cycles }) });
  return { c, gpio, log };
}
test('A3 port addresses and documented latch/config reset values', () => {
  assert.deepEqual(PORT_BASES, { A: 0x600, B: 0x620, C: 0x640, D: 0x660, E: 0x680, F: 0x6a0 });
  const { c, gpio } = fixture();
  for (const [name, base] of Object.entries(PORT_BASES)) {
    for (const offset of [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23]) assert.equal(c.read(base + offset), 0);
    assert.equal(gpio.snapshot(name).inputSample, 0); assert.equal(gpio.snapshot(name).inputKnownMask, 0);
    for (let pin = 0; pin < 8; pin++) assert.equal(gpio.drive(name, pin).highImpedance, true);
  }
});
test('DIR/OUT aliases exhaustively operate on the underlying byte and read it back', () => {
  const { c } = fixture(false);
  for (const base of [0x600, 0x604]) for (let old = 0; old < 256; old++) for (let mask = 0; mask < 256; mask++) {
    for (let action = 1; action <= 3; action++) {
      c.write(base, old); c.write(base + action, mask);
      // Independent per-bit truth table, rather than reusing implementation masks.
      let expected = 0;
      for (let bit = 0; bit < 8; bit++) {
        const was = Math.floor(old / 2 ** bit) % 2, selected = Math.floor(mask / 2 ** bit) % 2;
        const now = selected ? (action === 1 ? 1 : action === 2 ? 0 : 1 - was) : was;
        expected += now * 2 ** bit;
      }
      assert.equal(c.read(base + action), expected); assert.equal(c.read(base), expected);
      c.accesses.length = 0;
    }
  }
});
test('individual bits, ports and DIR/OUT fields remain isolated', () => {
  const { c } = fixture(); c.write(0x604, 0xaa); c.write(0x600, 0x55);
  c.write(0x605, 1); assert.equal(c.read(0x604), 0xab); assert.equal(c.read(0x600), 0x55);
  for (const base of [0x620,0x640,0x660,0x680,0x6a0]) { assert.equal(c.read(base), 0); assert.equal(c.read(base + 4), 0); }
});
test('latch versus drive respects direction, inversion and all output/pull modes', () => {
  const { c, gpio } = fixture();
  c.write(0x604, 1); assert.equal(gpio.drive('A', 0).drive, null); // Latch alone cannot drive an input.
  c.write(0x600, 1); assert.equal(gpio.drive('A', 0).drive, 1);
  c.write(0x610, 0x40); assert.equal(gpio.drive('A', 0).drive, 0); assert.equal(c.read(0x604), 1);
  for (let opc = 0; opc < 8; opc++) for (let dir = 0; dir < 2; dir++) for (let out = 0; out < 2; out++) {
    c.write(0x610, opc * 8); c.write(0x600, dir); c.write(0x604, out);
    const expected = !dir ? null : opc < 4 ? out : [4,6].includes(opc) ? (out ? 1 : null) : (out ? null : 0);
    assert.equal(gpio.drive('A', 0).drive, expected);
  }
  c.write(0x600, 0); c.write(0x610, 0x18); assert.equal(gpio.drive('A', 0).bias, 'pull-up');
  c.write(0x600, 1); assert.equal(gpio.drive('A', 0).bias, 'none');
});
test('input needs explicit digital samples; inversion does not alter output latch', () => {
  const { c, gpio } = fixture(); assert.throws(() => c.read(0x608), e => e.classification === 'GPIO_UNRESOLVED_INPUT');
  gpio.setInputSample('A', 0xa5, 0x7f); assert.throws(() => c.read(0x608));
  gpio.setInputSample('A', 0xa5); c.write(0x610, 0x40); assert.equal(c.read(0x608), 0xa4); assert.equal(c.read(0x604), 0);
  c.write(0x611, 7); assert.throws(() => c.read(0x608), e => e.classification === 'GPIO_INPUT_DISABLED_UNMODELED');
});
test('read-only, reserved registers/configurations and bank boundaries fail explicitly', () => {
  const { c, gpio } = fixture();
  for (const address of [0x5ff,0x609,0x60c,0x60d,0x618,0x61f,0x6b8,0x6c0,0x6ff]) assert.throws(() => c.read(address));
  assert.throws(() => c.write(0x608, 255), e => e.classification === 'GPIO_READ_ONLY');
  for (const value of [4,5,6]) assert.throws(() => c.write(0x610, value), e => e.classification === 'GPIO_RESERVED_CONFIGURATION');
  assert.equal(c.read(0x610), 0); assert.throws(() => gpio.setInputSample('A', 256)); assert.throws(() => gpio.drive('G', 0));
});
test('GPIO reset and access trace replay are deterministic', () => {
  const { c, gpio, log } = fixture();
  const sequence = () => { c.write(0x600, 0x33); c.write(0x605, 0x81); c.write(0x607, 1); c.write(0x610, 0x18); c.read(0x606); };
  sequence(); const first = JSON.stringify(log), state = gpio.snapshotAll();
  gpio.setInputSample('A', 255); gpio.reset(); log.length = 0; sequence();
  assert.equal(JSON.stringify(log), first); assert.deepEqual(gpio.snapshotAll(), state);
  assert.equal(log[1].before.out, 0); assert.equal(log[1].after.out, 0x81); assert.equal(log[1].register, 'OUTSET');
});
test('registration collision is rejected before any partial bank installation', () => {
  const { c, gpio } = fixture(); assert.throws(() => gpio.register(c.bus.mmio), /already/);
  const other = new GPIOController(); const size = c.hooks.size; assert.throws(() => other.register(c.bus.mmio), /collision/); assert.equal(c.hooks.size, size);
});
