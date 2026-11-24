import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ExecutionFault, XmegaCPU } from '../../src/xmega.mjs';
import { TWIMaster } from '../../src/peripherals/twie.mjs';

const FIXTURES = [
  { address: 0x57, offset: 0xf0, bytes: [0x00, 0xa5, 0x5a, 0xff, 0x80, 0x01, 0xc3, 0x3c] },
  { address: 0x6f, offset: 0x00, bytes: [0xff, 0x00, 0x37, 0xd2, 0x81, 0x42, 0x24, 0x18] },
];

function program(address, offset, length) {
  const words = [];
  const labels = new Map(), branches = [];
  const ldi = (r, v) => words.push(0xe000 | ((v & 0xf0) << 4) | ((r - 16) << 4) | (v & 15));
  const label = name => labels.set(name, words.length);
  function jump(name) {
    branches.push([words.length, name]);
    words.push(0xc000);
  }
  function write(offset, value) { ldi(16, value); words.push(0x8300 | offset); } // STD Z+q,R16.
  function waitByte(name) {
    label(name);
    words.push(0x8114, 0xfd16); // LDD R17,Z+4; SBRC R17,6 (WIF).
    jump(name + '-ready');
    words.push(0xff17);         // SBRS R17,7 (RIF).
    jump(name);
    label(name + '-ready');
    words.push(0xfd14);         // SBRC R17,4 (RXACK).
    jump('nack');
  }
  ldi(30, 0xa0); ldi(31, 0x04);
  write(1, 0x78); write(5, 0x9b); write(4, 1);
  write(6, address << 1);
  waitByte('address-write');
  write(7, offset);
  waitByte('offset');
  write(6, (address << 1) | 1);
  for (let i = 0; i < length; i++) {
    waitByte('byte-' + i);
    words.push(0x8127, 0x9320, 0x2000 + i); // LDD R18,Z+7; STS SRAM+i,R18.
    if (i + 1 < length) write(3, 2);       // ACK and receive the next byte.
  }
  write(3, 7); // NACK and STOP.
  ldi(19, 1);
  jump('wait-stop');
  label('nack');
  write(3, 3);
  ldi(19, 2);
  label('wait-stop');
  words.push(0x8114, 0xff10); // Poll BUSSTATE bit 0 until IDLE.
  jump('wait-stop');
  const terminal = words.length;
  words.push(0xcfff);
  for (const [pc, target] of branches) {
    const delta = labels.get(target) - pc - 1;
    assert.ok(Number.isInteger(delta) && delta >= -2048 && delta < 2048);
    words[pc] = 0xc000 | (delta & 0xfff);
  }
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  for (const [pc, word] of words.entries()) {
    flash[pc * 2] = word & 0xff;
    flash[pc * 2 + 1] = word >>> 8;
  }
  present.fill(1, 0, words.length * 2);
  return { image: { flash, present }, terminal };
}

export function runCombined(fixture, peer = 'fixture') {
  const { address, offset, bytes } = fixture;
  const { image, terminal } = program(address, offset, bytes.length);
  const cpu = new XmegaCPU(image);
  const transfers = [], interrupts = [], accesses = [];
  let lastStatus, stop = null;
  // Byte values are invented test patterns, exclusively for this synthetic AVR program.
  const respond = request => {
    assert.equal(request.address, address);
    if (request.action === 'address') return peer !== 'nack-address' && !(peer === 'nack-read-address' && request.read);
    if (request.action === 'write') { assert.equal(request.value, offset); return peer !== 'nack-data'; }
    return bytes[request.index];
  };
  const master = new TWIMaster({ respond: peer === 'unknown' ? null : respond,
    onTransfer: e => transfers.push(e), onInterrupt: e => interrupts.push(e), onAccess: e => {
      if (e.kind === 'read' && e.register === 'MASTER.STATUS') {
        if (e.value === lastStatus) return;
        lastStatus = e.value;
      }
      accesses.push({ pcWord: cpu.pc, cycle: e.cycle, register: e.register, kind: e.kind,
        value: e.value, completed: e.completed });
    } });
  master.register(cpu.bus.mmio, { fault: (message, details) => cpu.fault(message, details) });
  while (cpu.pc !== terminal) {
    if (cpu.steps >= 50000 || cpu.cycles >= 100000) throw new Error('Synthetic TWI probe timed out');
    try {
      cpu.step();
      if (master.needsClock) master.advanceTo(cpu.cycles);
    } catch (error) {
      if (!(error instanceof ExecutionFault)) throw error;
      stop = { classification: error.classification, pcWord: cpu.pc, opcode: error.opcode,
        addressByte: error.addressByte, instructionCompleted: false };
      break;
    }
  }
  return { pcWord: cpu.pc, steps: cpu.steps, cycles: cpu.cycles, terminal, resultRegister: cpu.r[19], stop,
    received: [...cpu.sram.slice(0, bytes.length)], state: master.snapshot(), accesses, transfers, interrupts };
}

export function verifyCombinedProbes() {
  return FIXTURES.map(fixture => {
    const result = runCombined(fixture);
    assert.deepEqual(result, runCombined(fixture));
    assert.equal(result.stop, null);
    assert.equal(result.pcWord, result.terminal);
    assert.equal(result.resultRegister, 1);
    assert.equal(result.state.status, 1);
    assert.deepEqual(result.received, fixture.bytes);
    assert.deepEqual(result.transfers.map(e => e.action), [
      'start', 'address', 'write', 'repeated-start', 'address',
      ...fixture.bytes.flatMap(() => ['read', 'master-ack']), 'stop',
    ]);
    assert.deepEqual(result.transfers.filter(e => e.action === 'address').map(e => e.addressByte),
      [fixture.address * 2, fixture.address * 2 + 1]);
    assert.deepEqual(result.transfers.filter(e => e.action === 'master-ack').map(e => e.ack),
      [true, true, true, true, true, true, true, false]);
    assert.deepEqual(result.interrupts.filter(e => e.asserted).map(e => [e.vectorWord, e.level, e.source]),
      ['write', 'write', ...fixture.bytes.map(() => 'read')].map(source => [0x005c, 1, source]));
    return { fixture, ...result };
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(verifyCombinedProbes(), null, 2));
}
