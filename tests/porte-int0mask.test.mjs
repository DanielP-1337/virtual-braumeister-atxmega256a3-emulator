import test from 'node:test';
import assert from 'node:assert/strict';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { PortEInterrupts } from '../src/peripherals/porte-interrupts.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

test('PORTE INT0MASK independently selects any of the eight port pins and resets to zero', () => {
  const bus = new MMIORegistry(), port = new PortEInterrupts();
  port.register(bus);
  assert.deepEqual([...bus.handlers.keys()],[0x068a]);
  const mask = bus.handlers.get(0x068a);
  assert.equal(mask.read(0),0);
  for (let raw=0; raw<=255; raw++) {
    mask.write(raw,raw);
    assert.equal(mask.read(raw),raw);
  }
  assert.throws(() => new PortEInterrupts().register(bus),/collision/);
  port.reset();
  assert.equal(mask.read(256),0);
});

test('CPU STD selects PE2 in INT0MASK without sampling the port or disturbing its latches', () => {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0xc2,0x87]); // STD Z+10,R28.
  present.fill(1,0,2);
  const cpu = new XmegaCPU({flash,present}), gpio = new GPIOController(), events = [];
  gpio.register(cpu.bus.mmio);
  const port = new PortEInterrupts({onAccess:e=>events.push(e)});
  port.register(cpu.bus.mmio,{context:()=>({pcWord:cpu.pc,instructionAttempt:cpu.steps+1})});
  cpu.write(0x0680,0xbb);
  const gpioBefore = gpio.snapshotAll();
  cpu.setPair(30,0x0680);
  cpu.r[28] = 4;
  const trace = cpu.step();
  assert.deepEqual([trace.mnemonic,trace.after.pcWord,trace.after.cycles],['STD',1,2]);
  assert.deepEqual(trace.accesses.at(-1),{kind:'write',space:'mmio',addressByte:0x068a,value:4});
  assert.deepEqual(events,[{origin:'peripheral-model',eventType:'port-interrupt-access',pcWord:0,instructionAttempt:1,
    peripheral:'PORTE',register:'INT0MASK',addressByte:0x068a,kind:'write',value:4,cycle:2,before:{int0Mask:0},after:{int0Mask:4}}]);
  assert.deepEqual(gpio.snapshotAll(),gpioBefore);
});
