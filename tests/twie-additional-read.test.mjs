import assert from 'node:assert/strict';
import test from 'node:test';
import { twieAddressAck } from '../scripts/twie-input.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';

const initial = { repeatedReadAck:'0xDF', firstReadByte:'0x81', secondReadByte:'0x36', thirdReadByte:'0xA7' };

function exchange(additionalReadBytes) {
  const input = twieAddressAck('0xDE', '0x00', {...initial, additionalReadBytes});
  const bus = new MMIORegistry(), wire = [];
  const master = new TWIMaster({
    respond: request => input.respond(request, wire),
    onTransfer: event => wire.push(event),
  });
  master.register(bus);
  const write = (reg, byte, cycle) => bus.handlers.get(reg).write(byte, cycle);
  const readData = cycle => bus.handlers.get(0x4a7).read(cycle);
  const receive = cycle => write(0x4a3, 2, cycle);
  write(0x4a1, 0x78, 0); write(0x4a5, 0x9b, 0); write(0x4a4, 1, 0);
  write(0x4a6, 0xde, 10); write(0x4a7, 0, 2890); write(0x4a6, 0xdf, 5770);
  let cycle = 11210;
  assert.equal(readData(cycle), 0x81);
  for (const expected of [0x36, 0xa7]) {
    receive(cycle + 2);
    cycle += 2 + 9 * 320;
    assert.equal(readData(cycle), expected);
  }
  return { input, wire, master, receive, readData, cycle };
}

test('TWIE additional read bytes require a contiguous sequence beginning at the fourth byte', () => {
  for (const spec of ['', '0x00,', ',0x00', '0x00,,0xAA', '0x01, 0x02', '0x100', '0xGG', false, 0, null]) {
    assert.throws(() => twieAddressAck('0xDE','0x00',{...initial,additionalReadBytes:spec}), /comma-separated hex bytes/);
  }
  assert.throws(() => twieAddressAck('0xDE','0x00',{...initial,thirdReadByte:undefined,additionalReadBytes:'0x00'}), /require the third read byte/);
  assert.deepEqual(twieAddressAck('0xDE','0x00',initial).report.repeatedRead,
    {addressByte:0xdf,ack:true,firstByte:0x81,secondByte:0x36,thirdByte:0xa7});
  assert.deepEqual(exchange('0x00,0xfF').input.report.repeatedRead.additionalBytes, [0,255]);
});

test('TWIE fourth byte requires the third committed read and the earlier master ACKs', () => {
  const { input, wire } = exchange('0x04');
  const request = {action:'read',address:0x6f,index:3};
  assert.equal(input.respond(request,wire),4);
  for (const change of [{address:0x6e},{index:2},{index:4},{action:'write'}]) {
    assert.equal(input.respond({...request,...change},wire),undefined);
  }
  for (const [i,change] of [[6,{ack:false}],[8,{address:0x6e}],[8,{action:'stop'}],[9,{index:1}],[9,{value:0}]]) {
    const altered=wire.map((e,n)=>n===i ? {...e,...change} : e);
    assert.equal(input.respond(request,altered),undefined);
  }
  assert.equal(input.respond(request,wire.slice(0,-1)),undefined);
});

test('TWIE fourth and fifth read bytes retain their own values and nine-clock deadlines', () => {
  for (const [spec,expected] of [['0x00',[0]],['0x04,0x00',[4,0]],['0x00,0xFF',[0,255]]]) {
    const {wire,master,receive,readData,cycle} = exchange(spec);
    let command = cycle + 2;
    for (const [i,value] of expected.entries()) {
      const previous = wire.length, arrival = command + 9 * 320;
      receive(command);
      master.advanceTo(command + 319);
      assert.equal(wire.length,previous);
      master.advanceTo(command + 320);
      assert.deepEqual([wire.at(-1).action,wire.at(-1).ack],['master-ack',true]);
      master.advanceTo(arrival - 1);
      assert.equal(master.interruptRequest,null);
      master.advanceTo(arrival);
      assert.deepEqual([wire.at(-1).index,wire.at(-1).value,master.status,master.interruptRequest.source],
        [3+i,value,0xa2,'read']);
      assert.equal(readData(arrival+1),value);
      command = arrival + 2;
    }
    const before=master.snapshot(), committed=wire.length;
    for (const tick of [command,command+1]) {
      assert.throws(() => receive(tick), {classification:'TWI_UNKNOWN_DATA'});
      assert.deepEqual(master.snapshot(),before);
      assert.equal(wire.length,committed);
    }
  }
});
