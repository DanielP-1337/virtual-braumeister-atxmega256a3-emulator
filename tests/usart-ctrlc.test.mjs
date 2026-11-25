import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { USARTF0Control } from '../src/peripherals/usart.mjs';
import { USARTF0FrameControl } from '../src/peripherals/usart-frame.mjs';

// ATxmega256A3 device map and XMEGA A 8077I pp. 248-249, independent of the model.
const address = 0x0ba0 + 5;
const reset = { ctrlc: 6, mode: 'asynchronous', dataBits: null, parity: 'none', stopBits: 1 };
const eightN2 = { ctrlc: 11, mode: 'asynchronous', dataBits: 8, parity: 'none', stopBits: 2 };

function fixture(words = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, index) => {
    flash[2 * index] = word & 255;
    flash[2 * index + 1] = word >> 8;
    present.fill(1, 2 * index, 2 * index + 2);
  });
  const cpu = new XmegaCPU({ flash, present });
  const events = [], frame = new USARTF0FrameControl({ onAccess: e => events.push(e) });
  frame.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details),
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) });
  return { cpu, bus: cpu.bus, frame, events };
}

test('USARTF0 CTRLC exposes the printed non-U reset byte and leaves reserved reset character size unknown', () => {
  const { bus, frame, events } = fixture();
  assert.deepEqual(frame.snapshot(), reset);
  assert.equal(bus.read(address), 0b00000110);
  bus.write(address, 0x3f);
  frame.reset();
  assert.equal(events.length, 2);
  assert.equal(bus.read(address), 6);
  assert.deepEqual(frame.snapshot(), reset);
});

test('USARTF0 CTRLC selects asynchronous 8N2 with 0x0B and distinguishes 8N1 and 8E2', () => {
  const { bus, frame, events } = fixture();
  bus.write(address, 0x0b, 12);
  assert.deepEqual(frame.snapshot(), eightN2);
  assert.deepEqual(events[0], { origin: 'peripheral-model', eventType: 'usart-access', pcWord: 0,
    instructionAttempt: 1, peripheral: 'USARTF0', register: 'CTRLC', addressByte: address, kind: 'write',
    cycle: 12, value: 11, completed: true, classification: null, before: reset, after: eightN2 });
  assert.equal(bus.read(address, 13), 11);
  assert.deepEqual(events[1].before, events[1].after);
  bus.write(address, 0x03);
  assert.deepEqual(frame.snapshot(), { ...eightN2, ctrlc: 3, stopBits: 1 });
  bus.write(address, 0x2b);
  assert.deepEqual(frame.snapshot(), { ...eightN2, ctrlc: 43, parity: 'even' });
});

test('USARTF0 CTRLC reads back every defined asynchronous character size, parity, and stop selection', () => {
  const { bus, frame } = fixture();
  const values = new Set();
  for (const [sizeCode, dataBits] of [[0, 5], [1, 6], [2, 7], [3, 8], [7, 9]]) {
    for (const [parityBits, parity] of [[0, 'none'], [32, 'even'], [48, 'odd']]) {
      for (const [stopBit, stopBits] of [[0, 1], [8, 2]]) {
        const ctrlc = sizeCode + parityBits + stopBit;
        bus.write(address, ctrlc);
        assert.deepEqual(frame.snapshot(), { ctrlc, mode: 'asynchronous', dataBits, parity, stopBits });
        assert.equal(bus.read(address), ctrlc);
        values.add(ctrlc);
      }
    }
  }
  assert.equal(values.size, 30);
});

test('USARTF0 CTRLC diagnoses all reserved asynchronous encodings without altering the previous format', () => {
  const { bus, events, frame } = fixture();
  bus.write(address, 11);
  let rejected = 0;
  for (let raw = 0; raw < 64; raw++) {
    const parity = Math.floor(raw / 16), size = raw % 8;
    if (parity !== 1 && ![4, 5, 6].includes(size)) continue;
    assert.throws(() => bus.write(address, raw), e => e.classification === 'USART_RESERVED_FRAME'
      && e.addressByte === address && e.accessKind === 'write' && e.attemptedValue === raw);
    assert.deepEqual(frame.snapshot(), eightN2);
    assert.equal(events.at(-1).completed, false);
    assert.deepEqual(events.at(-1).before, events.at(-1).after);
    rejected++;
  }
  assert.equal(rejected, 34);
});

test('USARTF0 CTRLC explicitly stops on unmodeled synchronous, IrDA and master SPI mode writes', () => {
  const { bus, frame, events } = fixture();
  for (let raw = 64; raw < 256; raw++) {
    assert.throws(() => bus.write(address, raw), e => e.classification === 'USART_MODE_UNMODELED' && e.attemptedValue === raw);
    assert.deepEqual(frame.snapshot(), reset);
    assert.equal(events.at(-1).classification, 'USART_MODE_UNMODELED');
    assert.equal(events.at(-1).completed, false);
  }
});

test('USARTF0 CTRLC leaves enables, adjacent bytes and other instances independent and respects registry ownership', () => {
  const { cpu, bus, frame } = fixture();
  const control = new USARTF0Control();
  control.register(bus.mmio);
  bus.write(address, 11);
  assert.deepEqual(control.snapshot(), { ctrlb: 0, receiverEnabled: false, transmitterEnabled: false });
  bus.write(address - 1, 0x18);
  assert.deepEqual(frame.snapshot(), eightN2);
  frame.reset();
  assert.equal(bus.read(address - 1), 0x18);
  for (const other of [0x0ba0, 0x0ba1, 0x0ba2, 0x0ba3, 0x0ba6, 0x0ba7, 0x09a5, 0x0bb5]) {
    assert.throws(() => bus.read(other), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === other);
    assert.throws(() => bus.write(other, 11), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === other);
  }
  assert.throws(() => frame.register(cpu.bus.mmio), /already registered/);
  assert.throws(() => new USARTF0FrameControl().register(cpu.bus.mmio), /Duplicate/);
  assert.equal(bus.read(address), 6);
});

test('USARTF0 CTRLC synthetic CPU store and load preserve SREG, SP, Z, MMIO timing and deterministic replay', () => {
  function execute() {
    // LDI R20,11; STD Z+5,R20; LDD R21,Z+5. These words live only in this test image.
    const { cpu, frame, events } = fixture([0xe04b, 0x8345, 0x8155]);
    cpu.setPair(30, 0x0ba0);
    cpu.sreg = 0xa5;
    const trace = Array.from({ length: 3 }, () => cpu.step());
    assert.deepEqual(trace.map(t => [t.mnemonic, t.after.pcWord, t.after.cycles]), [
      ['LDI', 1, 1], ['STD', 2, 3], ['LDD', 3, 5] ]);
    assert.deepEqual([cpu.r[20], cpu.r[21], cpu.sreg, cpu.sp, cpu.pair(30)], [11, 11, 0xa5, 0x5fff, 0x0ba0]);
    assert.deepEqual(events.map(e => [e.kind, e.cycle, e.pcWord, e.instructionAttempt]),
      [['write', 3, 1, 2], ['read', 5, 2, 3]]);
    assert.deepEqual(trace.flatMap(t => t.accesses.filter(a => a.space === 'mmio')),
      ['write', 'read'].map(kind => ({ kind, space: 'mmio', addressByte: address, value: 11 })));
    return { trace, events, state: frame.snapshot() };
  }
  assert.deepEqual(execute(), execute());
});

test('USARTF0 CTRLC rejected CPU write reports its operand, leaves the instruction unretired and preserves the register', () => {
  const { cpu, frame, events } = fixture([0x9340, address]); // STS data address,R20
  cpu.r[20] = 0xc6;
  assert.throws(() => cpu.step(), e => e.classification === 'USART_MODE_UNMODELED' && e.attemptedValue === 0xc6
    && e.addressByte === address && e.pcWord === 0 && e.opcode === 0x9340);
  assert.deepEqual([cpu.pc, cpu.cycles, cpu.steps], [0, 0, 0]);
  assert.deepEqual(frame.snapshot(), reset);
  assert.deepEqual([events.length, events[0].kind, events[0].completed], [1, 'write', false]);
});
