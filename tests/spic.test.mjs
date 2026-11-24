import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { SPIController } from '../src/peripherals/spic.mjs';

const CTRL = 0x08c0, INTCTRL = 0x08c1, STATUS = 0x08c2, DATA = 0x08c3;
function setup(exchange) {
  const bus = new MMIORegistry(), gpio = new GPIOController(), events = [];
  gpio.write('C', 0, 0xb0);
  const spi = new SPIController({ gpio, exchange, onTransfer: e => events.push(e) });
  spi.register(bus);
  const read = (address, cycle) => bus.handlers.get(address).read(cycle);
  const write = (address, byte, cycle) => bus.handlers.get(address).write(byte, cycle);
  return { bus, gpio, spi, events, read, write };
}

test('SPIC maps only the four A3 registers, resets all four and preflights collisions', () => {
  const { bus, gpio, spi, read, write } = setup();
  assert.deepEqual([...bus.handlers.keys()], [CTRL, INTCTRL, STATUS, DATA]);
  for (const addr of [CTRL, INTCTRL, STATUS, DATA]) assert.equal(read(addr, 0), 0);
  write(CTRL, 0x5c, 0);
  write(DATA, 0xa5, 1);
  spi.reset();
  for (const addr of [CTRL, INTCTRL, STATUS, DATA]) assert.equal(read(addr, 0), 0);
  spi.advanceTo(60);
  assert.equal(read(STATUS, 60), 0);
  const occupied = new MMIORegistry();
  occupied.map(STATUS, { read: () => 0x24 });
  assert.throws(() => new SPIController({ gpio }).register(occupied), /collision/i);
  assert.deepEqual([...occupied.handlers.keys()], [STATUS]);
  assert.throws(() => spi.register(bus), /collision/i);
});

test('SPIC all eight clock selections, four modes and two bit orders complete on their own deadlines', () => {
  const divisors = [4, 16, 64, 128, 2, 8, 32, 64];
  for (const [index, divider] of divisors.entries()) for (const mode of [0, 1, 2, 3]) for (const lsb of [false, true]) {
    let frame;
    const { read, write } = setup(f => { frame = f; return 0x13; });
    const ctrl = 0x50 | (index >= 4 ? 0x80 : 0) | (index % 4) | (mode << 2) | (lsb ? 0x20 : 0);
    write(CTRL, ctrl, 1);
    assert.equal(read(CTRL, 2), ctrl);
    write(DATA, 0x96, 3);
    assert.equal(frame.wireTx, lsb ? 0x69 : 0x96);
    assert.equal(frame.mode, mode);
    assert.equal(frame.divider, divider);
    const end = 3 + divider * 8;
    assert.equal(read(STATUS, end - 1), 0);
    assert.equal(read(STATUS, end), 0x80);
    assert.equal(read(DATA, end), lsb ? 0xc8 : 0x13);
    assert.equal(read(STATUS, end), 0);
  }
});

test('SPIC colliding writes preserve the active TX and acknowledge each observed flag separately', () => {
  const sent = [];
  const { read, write } = setup(f => { sent.push(f.tx); return 0x29; });
  write(CTRL, 0x5c, 0);
  write(DATA, 0xa1, 1);
  write(DATA, 0xb2, 2);
  assert.equal(read(STATUS, 3), 0x40);
  write(DATA, 0x33, 4); // Acknowledge old WRCOL, then raise a new one.
  assert.equal(read(STATUS, 5), 0x40); // IF has not been observed.
  assert.equal(read(DATA, 33), 0x29);
  assert.deepEqual(sent, [0xa1]);
  assert.equal(read(STATUS, 34), 0x80);
  write(DATA, 0xd4, 35); // An accepted DATA write acknowledges observed IF.
  assert.equal(read(STATUS, 36), 0);
  assert.deepEqual(sent, [0xa1, 0xd4]);
});

test('SPIC receive buffer changes only on completion and a stale status read cannot acknowledge a new completion', () => {
  const { read, write } = setup(f => f.tx + 1);
  write(CTRL, 0x5c, 0);
  write(DATA, 0x41, 1);
  assert.equal(read(DATA, 32), 0); // Reset receive latch, independent of TX.
  write(DATA, 0x53, 33); // Immediately start next frame, without acknowledging IF.
  assert.equal(read(STATUS, 34), 0x80); // Arm first completion.
  assert.equal(read(DATA, 65), 0x54);  // Second byte overwrote the unread first byte.
  assert.equal(read(STATUS, 66), 0x80);
  assert.equal(read(DATA, 67), 0x54);
  assert.equal(read(STATUS, 68), 0);
});

test('SPIC reports unknown input only on readback, preserving completion state on the failed read', () => {
  const { read, write, spi } = setup();
  write(CTRL, 0x5c, 0);
  write(DATA, 0x00, 4);
  assert.equal(read(STATUS, 35), 0);
  assert.equal(read(STATUS, 36), 0x80);
  const state = spi.snapshot();
  assert.throws(() => read(DATA, 37), { classification: 'SPI_UNKNOWN_RX', addressByte: DATA, accessKind: 'read' });
  assert.deepEqual(spi.snapshot(), state);
});

test('SPIC faults explicitly on unsupported register operations, pin configurations and bad peer data', () => {
  const { gpio, read, write, spi } = setup(() => 999);
  assert.throws(() => write(DATA, 1, 0), { classification: 'SPI_DISABLED_WRITE' });
  assert.throws(() => write(STATUS, 0x80, 1), { classification: 'SPI_READ_ONLY' });
  for (const level of [1, 2, 3]) assert.throws(() => write(INTCTRL, level, 2), { classification: 'SPI_INTERRUPT_UNMODELED' });
  write(CTRL, 0x40, 3);
  assert.throws(() => write(DATA, 1, 4), { classification: 'SPI_SLAVE_UNMODELED' });
  gpio.write('C', 0, 0xa0);
  assert.throws(() => write(CTRL, 0x5c, 5), { classification: 'SPI_UNKNOWN_SS' });
  assert.equal(read(CTRL, 5), 0x40);
  gpio.write('C', 0, 0xb0);
  gpio.write('C', 0x16, 7);
  write(CTRL, 0x5c, 6);
  assert.throws(() => write(DATA, 1, 7), { classification: 'SPI_PIN_CONFIGURATION_UNMODELED' });
  gpio.write('C', 0x16, 0);
  assert.throws(() => write(DATA, 1, 8), { classification: 'SPI_INVALID_RESPONSE' });
  assert.equal(spi.busy, false);
  assert.equal(read(STATUS, 9), 0);
});

test('AVR program polls SPIC from reset and reads DATA only after IF in deterministic replays', () => {
  const script = fileURLToPath(new URL('../verification/spic/poll-master.mjs', import.meta.url));
  const evidence = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' }));
  assert.equal(evidence.validation, 'PASS');
  assert.equal(evidence.deterministicReplay, true);
  assert.deepEqual(evidence.runs.map(r => [r.outcome, r.completed, r.cycles]),
    [['REACHED_TERMINAL', 32, 52], ['CONTROLLED_STOP', 29, 46]]);
});
