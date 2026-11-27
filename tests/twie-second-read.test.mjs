import assert from 'node:assert/strict';
import test from 'node:test';
import { twieAddressAck } from '../scripts/twie-input.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';

function begin(secondReadByte) {
  const input = twieAddressAck('0xDE', '0x00', {
    repeatedReadAck: '0xDF', firstReadByte: '0x81', secondReadByte,
  });
  const bus = new MMIORegistry(), wire = [], irq = [];
  const master = new TWIMaster({
    respond: request => input.respond(request, wire),
    onTransfer: event => wire.push(event), onInterrupt: event => irq.push(event),
  });
  master.register(bus);
  const write = (address, value, cycle) => bus.handlers.get(address).write(value, cycle);
  const read = cycle => bus.handlers.get(0x4a7).read(cycle);
  write(0x4a1, 0x78, 0); write(0x4a5, 0x9b, 0); write(0x4a4, 1, 0);
  write(0x4a6, 0xde, 10); write(0x4a7, 0, 2890); write(0x4a6, 0xdf, 5770);
  assert.equal(read(11210), 0x81);
  return { input, master, wire, irq, write, read };
}

test('TWIE second read byte requires an explicit first byte and preserves address-only profiles', () => {
  assert.throws(() => twieAddressAck('0xDE', '0x00', {repeatedReadAck:'0xDF', secondReadByte:'0x00'}), /requires the first read byte/);
  for (const invalid of [null, false, 0, '0x0', '0x100', '0xGG']) assert.throws(() => begin(invalid), /one hex data byte/);
  assert.deepEqual(begin().input.report.repeatedRead, {addressByte:0xdf,ack:true,firstByte:0x81});
  assert.deepEqual(begin('0x00').input.report.repeatedRead, {addressByte:0xdf,ack:true,firstByte:0x81,secondByte:0});
});

test('TWIE second read byte matches the peer, byte index and complete preceding wire exchange', () => {
  const { input, wire } = begin('0xA5');
  const request = {action:'read',address:0x6f,index:1};
  assert.equal(input.respond(request, wire), 0xa5);
  for (const change of [{action:'write'}, {address:0x6e}, {index:0}, {index:2}]) {
    assert.equal(input.respond({...request,...change}, wire), undefined);
  }
  for (const [i, change] of [[2, {value:1}], [3, {action:'stop'}], [4, {read:false}], [4, {ack:false}],
    [5, {address:0x6e}], [5, {index:1}], [5, {value:0}]]) {
    const wrong = wire.map((event, index) => index === i ? {...event,...change} : event);
    assert.equal(input.respond(request, wrong), undefined);
  }
  for (const history of [6, wire.slice(0, 5), [...wire, {action:'stop'}]]) {
    assert.equal(input.respond(request, history), undefined);
  }
});

test('TWIE BYTEREC clocks the master ACK and second byte and leaves the third byte unknown', () => {
  for (const spec of ['0x00', '0xA5']) {
    const { master, wire, write, read, irq } = begin(spec);
    write(0x4a3, 2, 11212);
    master.advanceTo(11531);
    assert.equal(wire.length, 6);
    master.advanceTo(11532);
    assert.deepEqual([wire.at(-1).action, wire.at(-1).ack, wire.at(-1).cycle], ['master-ack',true,11532]);
    master.advanceTo(14091);
    assert.equal(master.interruptRequest, null);
    master.advanceTo(14092);
    assert.deepEqual([wire.at(-1).action,wire.at(-1).index,wire.at(-1).value,master.status], ['read',1,Number(spec),0xa2]);
    assert.equal(read(14093), Number(spec));
    assert.deepEqual(irq.slice(-2).map(e => [e.cycle,e.source]), [[14092,'read'],[14093,null]]);
    const before = master.snapshot();
    for (const cycle of [14094,14095]) {
      assert.throws(() => write(0x4a3, 2, cycle), {classification:'TWI_UNKNOWN_DATA'});
      assert.deepEqual(master.snapshot(), before);
      assert.equal(wire.length, 8);
    }
  }
});
