import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAt } from '../src/discovery.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { SPIController, SPIC_BASE, SPIE_BASE } from '../src/peripherals/spic.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

test('SPIE CTRL retains all eight bits on port E and is independent of SPIC', () => {
  const gpio = new GPIOController(), bus = new MMIORegistry(), transfers = [];
  const c = new SPIController({ gpio }), e = new SPIController({ instance: 'SPIE', gpio, onTransfer: t => transfers.push(t) });
  c.register(bus);
  e.register(bus);
  assert.deepEqual([...bus.handlers.keys()], [0x08c0,0x08c1,0x08c2,0x08c3,0x0ac0]);
  assert.throws(() => new SPIController({ instance: 'SPIE', gpio }).register(bus), /SPIE MMIO registration collision/);
  const ctrl = bus.handlers.get(SPIE_BASE), ctrlC = bus.handlers.get(SPIC_BASE);
  gpio.write('E', 1, 0x10);
  ctrlC.write(0x21, 0);
  assert.equal(ctrl.read(0), 0);
  for (let value = 0; value <= 0xff; value++) {
    ctrl.write(value, value);
    assert.equal(ctrl.read(value), value);
  }
  assert.deepEqual(transfers, []);
  e.reset();
  assert.equal(ctrl.read(0), 0);
  assert.equal(ctrlC.read(0), 0x21);
});

test('SPIE master selection observes PE4 for unknown, driven high and driven low SS', () => {
  const gpio = new GPIOController(), bus = new MMIORegistry(), transitions = [];
  gpio.write('C', 1, 0x10);
  gpio.setInputSample('C', 0x10, 0x10);
  const e = new SPIController({ instance: 'SPIE', gpio, onTransfer: t => transitions.push(t) });
  e.register(bus);
  const ctrl = bus.handlers.get(SPIE_BASE), initial = e.snapshot();
  assert.throws(() => ctrl.write(0x50, 1), err => err.classification === 'SPI_UNKNOWN_SS' && err.addressByte === SPIE_BASE);
  assert.deepEqual(e.snapshot(), initial);
  gpio.setInputSample('E', 0x10, 0x10);
  ctrl.write(0x50, 2);
  assert.equal(ctrl.read(2), 0x50);
  gpio.setInputSample('E', 0, 0x10);
  e.advanceTo(3);
  assert.deepEqual([ctrl.read(3),e.snapshot().status,transitions.map(t => [t.peripheral,t.action,t.cycle])],
    [0x40,0x80,[['SPIE','master-lost',3]]]);
});

function storeCpu(register, postIncrement = false) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const opcode = 0x920c | register << 4 | Number(postIncrement);
  flash.set([opcode & 0xff, opcode >>> 8]);
  present.fill(1,0,2);
  return new XmegaCPU({ flash, present });
}

test('ST X writes 0x50 to SPIE CTRL in one clock with PE4 already configured for output', () => {
  const cpu = storeCpu(12), gpio = new GPIOController(), accesses = [], transfers = [];
  gpio.write('E', 1, 0x10);
  gpio.write('E', 5, 0x10);
  const e = new SPIController({ instance:'SPIE', gpio, onAccess:a => accesses.push(a), onTransfer:t => transfers.push(t) });
  e.register(cpu.bus.mmio, { context: () => ({ pcWord:cpu.pc, instructionAttempt:cpu.steps+1 }) });
  cpu.setPair(26, SPIE_BASE);
  cpu.r[12] = 0x50;
  const before = e.snapshot(), trace = cpu.step();
  assert.deepEqual([trace.mnemonic,trace.after.pcWord,trace.after.cycles,cpu.pair(26)],['ST X',1,1,SPIE_BASE]);
  assert.deepEqual(trace.accesses.at(-1),{kind:'write',space:'mmio',addressByte:SPIE_BASE,value:0x50});
  assert.deepEqual(accesses,[{origin:'peripheral-model',eventType:'spi-access',peripheral:'SPIE',addressByte:SPIE_BASE,
    register:'CTRL',pcWord:0,instructionAttempt:1,kind:'write',value:0x50,cycle:1,before,after:{...before,ctrl:0x50}}]);
  assert.deepEqual(transfers,[]);
});

test('Indirect X store diagnostics report the effective address and source byte before execution', () => {
  for (const postIncrement of [false,true]) {
    for (let register = 0; register < 32; register++) {
      const cpu = storeCpu(register, postIncrement);
      cpu.r[register] = 0x50;
      cpu.setPair(26, SPIE_BASE + 1);
      const state = cpu.state(), decoded = decodeAt(cpu);
      assert.deepEqual(decoded.operands,{register,pointer:'X',postIncrement,addressByte:0x0ac1,value:state.registers[register]});
      assert.equal(decoded.mnemonic,postIncrement ? 'ST X+' : 'ST X');
      assert.deepEqual(cpu.state(),state);
      assert.equal(cpu.accesses.length,0);
    }
  }
});
