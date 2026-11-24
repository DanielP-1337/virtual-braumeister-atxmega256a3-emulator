import assert from 'node:assert/strict';
import { XmegaCPU, ExecutionFault } from '../../src/xmega.mjs';
import { GPIOController } from '../../src/peripherals/gpio.mjs';
import { SPIController } from '../../src/peripherals/spic.mjs';

// Standalone synthetic AVR program. The register pointer Z holds the SPIC base.
// RJMP -3 returns to the STATUS load. The last word marks the first terminal arrival.
const words = [
  0xeb00, 0x9300, 0x0641, // LDI R16,0xB0; STS PORTC.DIRSET,R16
  0xece0, 0xe0f8,        // LDI R30,0xC0; LDI R31,0x08
  0xe50c, 0x8300, 0x8211, // LDI R16,0x5C; ST Z,R16; STD Z+1,R1
  0xe906, 0x8303,        // LDI R16,0x96; STD Z+3,R16
  0x8122, 0xff27, 0xcffd, // LDD R18,Z+2; SBRS R18,7; RJMP -3
  0x8113, 0x9310, 0x2000, // LDD R17,Z+3; STS 0x2000,R17
  0x8122, 0xcfff,        // LDD R18,Z+2; RJMP .
];
const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
for (const [word, opcode] of words.entries()) {
  flash[2 * word] = opcode & 255;
  flash[2 * word + 1] = opcode >>> 8;
}
present.fill(1, 0, 2 * words.length);

function run(withPeer) {
  const accesses = [], transfers = [], instructions = [];
  const cpu = new XmegaCPU({ flash, present });
  const options = { fault: (message, details) => cpu.fault(message, details),
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }) };
  const gpio = new GPIOController();
  gpio.register(cpu.bus.mmio, options);
  const spi = new SPIController({ gpio, exchange: withPeer ? () => 0x39 : null,
    onAccess: event => accesses.push(event), onTransfer: event => transfers.push(event) });
  spi.register(cpu.bus.mmio, options);
  let stop = null;
  while (cpu.pc !== words.length - 1 && cpu.steps < 100) {
    try {
      const event = cpu.step();
      spi.advanceTo(cpu.cycles);
      instructions.push({ pcWord: event.before.pcWord, opcode: event.opcode, cyclesAfter: cpu.cycles });
    } catch (error) {
      if (!(error instanceof ExecutionFault)) throw error;
      stop = { classification: error.classification, pcWord: cpu.pc, opcode: error.opcode,
        addressByte: error.addressByte, reason: error.message };
      break;
    }
  }
  const polls = accesses.filter(e => e.register === 'STATUS' && e.pcWord === 10);
  assert.deepEqual(polls.map(e => [e.cycle, e.value]), [[14,0],[19,0],[24,0],[29,0],[34,0],[39,0],[44,128]]);
  assert.deepEqual(transfers.map(e => [e.action, e.cycle, e.wireTx]), [['start',12,0x96],['complete',44,0x96]]);
  if (withPeer) {
    assert.equal(stop, null);
    assert.equal(cpu.pc, 17);
    assert.equal(cpu.r[17], 0x39);
    assert.equal(cpu.sram[0], 0x39);
    assert.equal(cpu.r[18], 0);
    assert.equal(cpu.steps, 32);
    assert.equal(cpu.cycles, 52);
  } else {
    assert.equal(stop?.classification, 'SPI_UNKNOWN_RX');
    assert.equal(stop.addressByte, 0x08c3);
    assert.equal(stop.opcode, 0x8113);
    assert.equal(cpu.pc, 13);
    assert.equal(cpu.steps, 29);
    assert.equal(cpu.cycles, 46);
    assert.equal(spi.snapshot().rx, null);
    assert.equal(spi.snapshot().status, 0x80);
  }
  return { source: 'synthetic', input: withPeer ? 'explicit wire byte 0x39' : 'no MISO sample',
    outcome: stop ? 'CONTROLLED_STOP' : 'REACHED_TERMINAL', completed: cpu.steps, cycles: cpu.cycles,
    lastPcWord: cpu.pc, stop, instructions, accesses, transfers };
}

const observed = [run(true), run(false)];
assert.deepEqual([run(true), run(false)], observed);
console.log(JSON.stringify({ validation: 'PASS', deterministicReplay: true, runs: observed }, null, 2));
