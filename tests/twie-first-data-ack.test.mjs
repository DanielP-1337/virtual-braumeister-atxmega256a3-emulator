import assert from 'node:assert/strict';
import test from 'node:test';
import { twieAddressAck } from '../scripts/twie-input.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';

test('TWIE first data ACK requires an explicit byte and a write address', () => {
  for (const spec of [null, false, 0, '0', '0x0', '0x100', '0xGG']) {
    assert.throws(() => twieAddressAck('0xDE', spec), /one hex data byte/);
  }
  for (const address of [undefined, '0xDF']) {
    assert.throws(() => twieAddressAck(address, '0x00'), /requires an initial write address/);
  }
  const input = twieAddressAck('0xDE', '0x00');
  assert.deepEqual(input.report, { ...twieAddressAck('0xDE').report, firstWrite: {index: 0, value: 0, ack: true} });
});

test('TWIE first data ACK matches the committed address phase, peer, index and byte', () => {
  const input = twieAddressAck('0xDE', '0x5A');
  const request = { action: 'write', address: 0x6f, index: 0, value: 0x5a };
  assert.equal(input.respond(request, 2), true);
  for (const count of [0, 1, 3, 4]) assert.equal(input.respond(request, count), undefined);
  for (const change of [{ action: 'read' }, { action: 'address', repeated: true }, { address: 0x6e }, { index: 1 }, { value: 0 }]) {
    assert.equal(input.respond({ ...request, ...change }, 2), undefined);
  }
  assert.equal(twieAddressAck('0xDE').respond(request, 2), undefined);
});

test('TWIE completes the first data ACK on the ninth clock and leaves subsequent bus responses open', () => {
  const input = twieAddressAck('0xDE', '0x00');
  for (let reset = 0; reset < 2; reset++) {
    const bus = new MMIORegistry(), wire = [], interrupts = [];
    const master = new TWIMaster({
      respond: request => input.respond(request, wire.length),
      onTransfer: event => wire.push(event), onInterrupt: event => interrupts.push(event),
    });
    master.register(bus);
    const write = (address, value, cycle) => bus.handlers.get(address).write(value, cycle);
    write(0x4a1, 0x78, 0); write(0x4a5, 0x9b, 0); write(0x4a4, 1, 0);
    write(0x4a6, 0xde, 17);
    master.advanceTo(2897);
    const before = master.snapshot();
    assert.throws(() => write(0x4a7, 1, 2898), { classification: 'TWI_UNKNOWN_ACK' });
    assert.deepEqual(master.snapshot(), before);
    write(0x4a7, 0, 2899);
    assert.equal(master.snapshot().byteIndex, 1);
    master.advanceTo(5778);
    assert.equal(master.interruptRequest, null);
    assert.deepEqual(wire.map(e => e.action), ['start', 'address']);
    master.advanceTo(5779);
    const completed = master.snapshot();
    assert.deepEqual([completed.phase, completed.status, completed.pending], ['write', 0x62, []]);
    assert.deepEqual(interrupts.map(e => [e.cycle, e.asserted]), [[2897, true], [2899, false], [5779, true]]);
    assert.deepEqual(wire.map(e => [e.action, e.cycle, e.value, e.ack]),
      [['start', 17, undefined, undefined], ['address', 2897, undefined, true], ['write', 5779, 0, true]]);
    for (const [reg, byte] of [[0x4a7, 0], [0x4a6, 0xdf], [0x4a6, 0xde]]) {
      assert.throws(() => write(reg, byte, 5780), { classification: 'TWI_UNKNOWN_ACK' });
      assert.deepEqual(master.snapshot(), completed);
      assert.equal(wire.length, 3);
    }
  }
});
