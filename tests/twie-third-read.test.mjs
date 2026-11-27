import assert from 'node:assert/strict';
import test from 'node:test';
import { twieAddressAck } from '../scripts/twie-input.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';

const earlierBytes = { repeatedReadAck: '0xDF', firstReadByte: '0x81', secondReadByte: '0x36' };

function afterTwoBytes(thirdReadByte) {
  const input = twieAddressAck('0xDE', '0x00', { ...earlierBytes, thirdReadByte });
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
  write(0x4a3, 2, 11212);
  assert.equal(read(14093), 0x36);
  return { input, master, wire, irq, write, read };
}

test('TWIE third read byte requires byte two and preserves the two-byte profile when omitted', () => {
  assert.throws(() => twieAddressAck('0xDE', '0x00', {...earlierBytes, secondReadByte:undefined, thirdReadByte:'0x00'}),
    /requires the second read byte/);
  for (const invalid of [null, false, 0, '0x0', '0x100', '0xGG', '0x00,0x00']) {
    assert.throws(() => afterTwoBytes(invalid), /one hex data byte/);
  }
  const { input, master, write } = afterTwoBytes();
  assert.deepEqual(input.report.repeatedRead, {addressByte:0xdf, ack:true, firstByte:0x81, secondByte:0x36});
  const before = master.snapshot();
  assert.throws(() => write(0x4a3, 2, 14094), {classification:'TWI_UNKNOWN_DATA'});
  assert.deepEqual(master.snapshot(), before);
  assert.equal(afterTwoBytes('0x00').input.report.repeatedRead.thirdByte, 0);
});

test('TWIE third read byte matches both earlier reads and the intervening master ACK', () => {
  const { input, wire } = afterTwoBytes('0xA5');
  const request = {action:'read', address:0x6f, index:2};
  assert.equal(input.respond(request, wire), 0xa5);
  for (const change of [{index:1}, {index:3}, {index:2.5}, {address:0x6e}, {action:'write'}]) {
    assert.equal(input.respond({...request, ...change}, wire), undefined);
  }
  for (const [at, change] of [[3,{action:'stop'}],[5,{value:0}],[6,{ack:false}],[6,{action:'stop'}],
    [6,{address:0x6e}],[7,{value:0}],[7,{index:0}],[7,{address:0x6e}]]) {
    const history = wire.map((event, i) => i === at ? {...event, ...change} : event);
    assert.equal(input.respond(request, history), undefined);
  }
  for (const history of [8, wire.slice(0,-1), [...wire,{action:'stop'}]]) {
    assert.equal(input.respond(request, history), undefined);
  }
});

test('TWIE receives byte three at the ninth clock and stops atomically before the fourth', () => {
  for (const spec of ['0x00','0xA5']) {
    const { master, wire, irq, write, read } = afterTwoBytes(spec);
    write(0x4a3, 2, 14095);
    master.advanceTo(14414);
    assert.equal(wire.length, 8);
    master.advanceTo(14415);
    assert.deepEqual([wire.at(-1).action,wire.at(-1).cycle,wire.at(-1).ack], ['master-ack',14415,true]);
    master.advanceTo(16974);
    assert.equal(master.interruptRequest, null);
    master.advanceTo(16975);
    assert.deepEqual([wire.at(-1).action,wire.at(-1).index,wire.at(-1).value,master.status], ['read',2,Number(spec),0xa2]);
    assert.equal(read(16976), Number(spec));
    assert.deepEqual(irq.slice(-2).map(e => [e.cycle,e.source]), [[16975,'read'],[16976,null]]);
    const before = master.snapshot();
    for (const cycle of [16977,16978]) {
      assert.throws(() => write(0x4a3, 2, cycle), {classification:'TWI_UNKNOWN_DATA'});
      assert.deepEqual(master.snapshot(), before);
      assert.equal(wire.length, 10);
    }
  }
});
