import assert from 'node:assert/strict';
import test from 'node:test';
import { twieAddressAck } from '../scripts/twie-input.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';

function masterWith(input) {
  const bus = new MMIORegistry(), events = [];
  const master = new TWIMaster({
    respond: input && (request => input.respond(request, events.length)),
    onTransfer: event => events.push(event),
  });
  master.register(bus);
  const write = (address, value, cycle = 0) => bus.handlers.get(address).write(value, cycle);
  write(0x4a1, 0x78); write(0x4a5, 0x9b); write(0x4a4, 1);
  return { master, events, write };
}

test('TWIE address ACK input records the exact initial address and direction', () => {
  assert.equal(twieAddressAck(), null);
  for (const spec of [true, null, '111','0x6','0x100','0xGG',' 0xDE']) {
    assert.throws(() => twieAddressAck(spec), /one hex address byte/);
  }
  assert.deepEqual(twieAddressAck('0xde').report, {
    provenance:'synthetic', peripheral:'TWIE', phase:'initial-address', addressByte:0xde, address:0x6f, read:false, ack:true,
  });
  for (const [spec, byte] of [[undefined,0xde],['0xDE',0xdf],['0xDE',0xae]]) {
    const { master, events, write } = masterWith(twieAddressAck(spec));
    const before = master.snapshot();
    assert.throws(() => write(0x4a6, byte, 17), {classification:'TWI_UNKNOWN_ACK'});
    assert.deepEqual(master.snapshot(), before);
    assert.deepEqual(events, []);
  }
});

test('TWIE initial address ACK reaches the ninth clock and leaves data and later addresses unknown', () => {
  const input = twieAddressAck('0xDE');
  for (let pass = 0; pass < 2; pass++) {
    const { master, events, write } = masterWith(input);
    write(0x4a6, 0xde, 17);
    master.advanceTo(2896);
    assert.equal(master.interruptRequest, null);
    master.advanceTo(2897);
    assert.deepEqual(events.map(e => [e.action,e.cycle,e.ack]), [['start',17,undefined],['address',2897,true]]);
    assert.deepEqual(master.interruptRequest, {peripheral:'TWIE',vectorWord:0x5c,level:1,source:'write'});
    const before = master.snapshot();
    for (const [reg,byte] of [[0x4a7,0x00],[0x4a7,0xde],[0x4a6,0xdf],[0x4a6,0xde]]) {
      assert.throws(() => write(reg,byte,2898), {classification:'TWI_UNKNOWN_ACK'});
      assert.deepEqual(master.snapshot(), before);
    }
    write(0x4a3,3,2899);
    assert.equal(master.snapshot().phase,'idle');
    assert.throws(() => write(0x4a6,0xde,2900), {classification:'TWI_UNKNOWN_ACK'});
    assert.deepEqual(events.map(e=>e.action), ['start','address','stop']);
  }
});

test('TWIE input for a read address supplies no data and permits an atomic retry', () => {
  const { master, events, write } = masterWith(twieAddressAck('0xDF'));
  const before = master.snapshot();
  for (const cycle of [17,18]) {
    assert.throws(() => write(0x4a6,0xdf,cycle), {classification:'TWI_UNKNOWN_DATA'});
    assert.deepEqual(master.snapshot(),before);
    assert.deepEqual(events,[]);
  }
});
