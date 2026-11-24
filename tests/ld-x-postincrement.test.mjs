import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt, discover } from '../src/discovery.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';

const encode = rd => Number.parseInt('1001000' + rd.toString(2).padStart(5, '0') + '1101', 2);

function place(cpu, pc, ...words) {
  let address = 2 * pc;
  for (const word of words) {
    cpu.flash[address] = word & 255;
    cpu.flash[address + 1] = word >>> 8;
    cpu.present.fill(1, address, address + 2);
    address += 2;
  }
}

function machine(words = [encode(18)], eeprom = null) {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) }, { eeprom });
  place(cpu, 0, ...words);
  cpu.rampz = 2; cpu.eind = 1; cpu.sp = 0x4fed;
  return cpu;
}

function attachEeprom(cpu) {
  const nvm = new NVMController();
  nvm.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details), clock: () => cpu.cycles });
  cpu.bus.attachEEPROM(nvm);
}

test('LD Rd,X+ decodes all 32 encodings and reads every byte into every defined destination in two SRAM clocks', () => {
  const cpu = machine(), words = new Set();
  assert.deepEqual([0, 18, 26, 27, 31].map(encode), [0x900d, 0x912d, 0x91ad, 0x91bd, 0x91fd]);
  for (let rd = 0; rd < 32; rd++) {
    const word = encode(rd);
    place(cpu, 0, word);
    words.add(word);
    const decoded = decodeAt(cpu, 0);
    assert.deepEqual([decoded.mnemonic, decoded.operands], ['LD', { register: rd, pointer: 'X', postIncrement: true }]);
    if (rd === 26 || rd === 27) continue;
    for (let value = 0; value < 256; value++) {
      cpu.pc = 0;
      for (let i = 0; i < 32; i++) cpu.r[i] = (value + 13 * i) & 255;
      cpu.r[rd] = value ^ 255;
      cpu.setPair(26, 0x25ff);
      cpu.sram[0x5ff] = value;
      cpu.sram[0x600] = value ^ 255;
      cpu.sreg = (value + 11 * rd) & 255;
      const before = cpu.state(), steps = cpu.steps;
      const registers = [...before.registers];
      registers[rd] = value; registers[26] = 0; registers[27] = 0x26;
      const t = cpu.step();
      assert.deepEqual([t.mnemonic, t.opcode, t.step], ['LD', word, steps + 1]);
      assert.deepEqual(t.after, { ...before, registers, pcWord: 1, cycles: before.cycles + 2 });
      assert.deepEqual(t.accesses.map(a => [a.space, a.kind, a.addressByte, a.value]), [
        ['flash', 'fetch', 0, word & 255], ['flash', 'fetch', 1, word >>> 8], ['sram', 'read', 0x25ff, value],
      ]);
    }
  }
  assert.equal(words.size, 32);
});

test('LD Rd,X+ reads exactly once at the original I/O address and preserves SREG while advancing X', () => {
  const cpu = machine([encode(3), encode(4)]), observations = [];
  cpu.setPair(26, 0x604);
  cpu.mapMMIO(0x604, { read(clock) { observations.push([clock, cpu.pair(26), cpu.r[3]]); return 0x9b; } });
  cpu.sreg = 0xd7;
  const first = cpu.step();
  assert.deepEqual(observations, [[1, 0x604, 0]]);
  assert.deepEqual([cpu.r[3], cpu.pair(26), cpu.sreg, cpu.cycles, first.accesses.at(-1).space], [0x9b, 0x605, 0xd7, 1, 'mmio']);
  cpu.setPair(26, 0x3f);
  const second = cpu.step();
  assert.deepEqual([cpu.r[4], cpu.sreg, cpu.pair(26), second.after.cycles], [0xd7, 0xd7, 0x40, 2]);
});

test('LD Rd,X+ accounts for one I/O, three mapped EEPROM and two SRAM clocks at their boundaries', () => {
  const image = new Uint8Array(4096); image[0] = 0xc4; image[4095] = 0x57;
  const cpu = machine([encode(7), encode(8), encode(9), encode(10)], image);
  attachEeprom(cpu); cpu.write(0x1cc, 8);
  cpu.mapMMIO(0x0fff, { read() { return 0x31; } }); // Explicit synthetic handler at the edge of the I/O range.
  cpu.sram[0] = 0x86;
  cpu.setPair(26, 0x0fff);
  for (const [rd, address, value, space, cycles] of [
    [7, 0x0fff, 0x31, 'mmio', 1], [8, 0x1000, 0xc4, 'eeprom', 4],
    [9, 0x1fff, 0x57, 'eeprom', 7], [10, 0x2000, 0x86, 'sram', 9],
  ]) {
    if (rd === 9) cpu.setPair(26, address);
    const t = cpu.step(), access = t.accesses.at(-1);
    assert.deepEqual([access.kind, access.space, access.addressByte, access.value, access.waitCycles ?? 0],
      ['read', space, address, value, space === 'eeprom' ? 1 : 0]);
    assert.deepEqual([cpu.r[rd], cpu.pair(26), cpu.cycles, cpu.rampz], [value, address + 1, cycles, 2]);
  }
});

test('LD Rd,X+ rejects both undefined destination overlaps before sampling the data bus', () => {
  for (const rd of [26, 27]) {
    const cpu = machine([encode(rd)]);
    cpu.setPair(26, 0x604); cpu.sreg = 0x5a;
    let reads = 0;
    cpu.mapMMIO(0x604, { read() { reads++; return 0x27; } });
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNDEFINED_OPERANDS' && e.opcode === encode(rd));
    assert.deepEqual([cpu.state(), cpu.steps, reads], [before, 0, 0]);
  }
});

test('LD Rd,X+ faults atomically on unhandled, unmapped, unknown and out-of-range data', () => {
  for (const [address, enable, classification] of [
    [0x300, false, 'UNHANDLED_MMIO'], [0x610, false, 'INVALID_MMIO_VALUE'],
    [0x1000, false, 'UNMAPPED_EEPROM'], [0x10ab, true, 'UNKNOWN_EEPROM_DATA'],
    [0x6000, false, 'INVALID_DATA_ADDRESS'], [0xffff, false, 'INVALID_DATA_ADDRESS'],
  ]) {
    const cpu = machine();
    attachEeprom(cpu);
    if (enable) cpu.write(0x1cc, 8);
    cpu.mapMMIO(0x610, { read() { return 256; } });
    cpu.setPair(26, address); cpu.r[18] = 0xb3; cpu.sreg = 0x85;
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === classification && e.addressByte === address && e.accessKind === 'read');
    assert.deepEqual([cpu.state(), cpu.steps], [before, 0]);
  }
});

test('LD Rd,X+ rejects incomplete fetches and invalid fall-through before consuming an I/O byte', () => {
  const cpu = machine();
  const last = cpu.flash.length / 2 - 1;
  let reads = 0;
  cpu.mapMMIO(0x602, { read() { reads++; return 0x55; } });
  cpu.setPair(26, 0x602);
  for (const [pc, missing] of [[0, 0], [1, 1], [last, null]]) {
    place(cpu, pc, encode(18));
    if (missing !== null) cpu.present[2 * pc + missing] = 0;
    cpu.pc = pc;
    const before = cpu.state();
    assert.throws(() => cpu.step(), missing === null ? /PC target outside device/ : /HEX hole/);
    assert.deepEqual([cpu.state(), cpu.steps, reads], [before, 0, 0]);
  }
});

test('LD Rd,X+ reads through the last SRAM byte and deterministically stops before an invalid increment', () => {
  function replay() {
    const cpu = machine([encode(4), encode(5), encode(6)]);
    cpu.setPair(26, 0x5ffe); cpu.setPair(30, 0x22fe);
    cpu.sram.set([0xa4, 0x29], 0x3ffe);
    const trace = [];
    const result = discover(cpu, { onTrace: t => trace.push(t) });
    assert.deepEqual(trace.map(t => t.eventType), ['instruction', 'instruction', 'diagnostic']);
    assert.deepEqual([cpu.r[4], cpu.r[5], cpu.r[6], cpu.pair(26), cpu.pair(30), cpu.rampz], [0xa4, 0x29, 0, 0x6000, 0x22fe, 2]);
    assert.deepEqual([result.completedInstructions, result.cycles, result.lastPcWord, result.firstBlockingEvent.classification],
      [2, 4, 2, 'INVALID_DATA_ADDRESS']);
    return { trace, result };
  }
  assert.deepEqual(replay(), replay());
});
