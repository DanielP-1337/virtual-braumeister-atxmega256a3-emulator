import assert from 'node:assert/strict';
import test from 'node:test';
import { twieAddressAck } from '../scripts/twie-input.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';

function writeThenRead(firstReadByte) {
  const input = twieAddressAck('0xDE', '0x00', { repeatedReadAck: '0xDF', firstReadByte });
  const bus = new MMIORegistry(), wire = [], interrupts = [];
  const master = new TWIMaster({
    respond: request => input.respond(request, wire),
    onTransfer: event => wire.push(event), onInterrupt: event => interrupts.push(event),
  });
  master.register(bus);
  const write = (address, value, cycle) => bus.handlers.get(address).write(value, cycle);
  write(0x4a1, 0x78, 0); write(0x4a5, 0x9b, 0); write(0x4a4, 1, 0);
  write(0x4a6, 0xde, 10);
  write(0x4a7, 0, 2890);
  master.advanceTo(5770);
  return { input, bus, wire, interrupts, master, write };
}

test('TWIE repeated read inputs require the matching write, read address and explicit first byte', () => {
  for (const [data, addr] of [[undefined, '0xDF'], ['0x00', '0xDE'], ['0x00', '0xDD']]) {
    assert.throws(() => twieAddressAck('0xDE', data, { repeatedReadAck: addr }), /first write data ACK and the read address/);
  }
  assert.throws(() => twieAddressAck('0xDE', '0x00', { firstReadByte: '0x00' }), /requires a repeated read address ACK/);
  for (const invalid of ['0', '0x0', '0x100', 0, false, null]) {
    assert.throws(() => twieAddressAck('0xDE', '0x00', { repeatedReadAck: invalid }), /one hex address byte/);
    assert.throws(() => twieAddressAck('0xDE', '0x00', { repeatedReadAck: '0xDF', firstReadByte: invalid }), /one hex data byte/);
  }
  assert.deepEqual(writeThenRead(undefined).input.report.repeatedRead, { addressByte: 0xdf, ack: true });
  assert.deepEqual(writeThenRead('0x00').input.report.repeatedRead, { addressByte: 0xdf, ack: true, firstByte: 0 });
});

test('TWIE repeated read ACK is scoped to the completed initial write and supplies only byte zero', () => {
  const { input, wire } = writeThenRead('0x80');
  const address = { action: 'address', address: 0x6f, read: true, repeated: true };
  const read = { action: 'read', address: 0x6f, index: 0 };
  assert.equal(input.respond(address, wire), true);
  assert.equal(input.respond(read, wire), 0x80);
  for (const history of [3, wire.slice(0, 2), [...wire, {action:'stop'}],
    [{action:'repeated-start'}, ...wire.slice(1)], [wire[0], {...wire[1], addressByte:0xdc}, wire[2]],
    [wire[0], wire[1], {...wire[2], value:1}], [wire[0], wire[1], {...wire[2], ack:false}]]) {
    assert.equal(input.respond(address, history), undefined);
    assert.equal(input.respond(read, history), undefined);
  }
  for (const wrong of [{...address, repeated:false}, {...address, read:false}, {...address, address:0x6e},
    {...read, index:1}, {...read, address:0x6e}]) assert.equal(input.respond(wrong, wire), undefined);
});

test('TWIE repeated address ACK alone faults atomically before committing the repeated START', () => {
  const { wire, master, write } = writeThenRead(undefined);
  const before = master.snapshot();
  for (const cycle of [5771, 5772]) {
    assert.throws(() => write(0x4a6, 0xdf, cycle), { classification:'TWI_UNKNOWN_DATA' });
    assert.deepEqual(master.snapshot(), before);
    assert.deepEqual(wire.map(e => e.action), ['start', 'address', 'write']);
  }
});

test('TWIE receives the supplied first byte on clock eight and requests new input for the second', () => {
  for (const spec of ['0x00', '0xA5']) {
    const { bus, master, write, wire, interrupts } = writeThenRead(spec);
    write(0x4a6, 0xdf, 5771);
    master.advanceTo(8651);
    assert.deepEqual(wire.slice(-2).map(e => [e.action,e.cycle,e.addressByte,e.ack]),
      [['repeated-start',5771,undefined,undefined], ['address',8651,0xdf,true]]);
    master.advanceTo(11210);
    assert.equal(master.interruptRequest, null);
    master.advanceTo(11211);
    assert.deepEqual([master.status, master.interruptRequest.source, wire.at(-1).index, wire.at(-1).value],
      [0xa2, 'read', 0, Number(spec)]);
    assert.equal(bus.handlers.get(0x4a7).read(11212), Number(spec));
    assert.deepEqual(interrupts.slice(-2).map(e => [e.cycle,e.asserted]), [[11211,true],[11212,false]]);
    const before = master.snapshot();
    assert.throws(() => write(0x4a3, 2, 11213), { classification:'TWI_UNKNOWN_DATA' });
    assert.deepEqual(master.snapshot(), before);
    assert.equal(wire.length, 6);
  }
});
