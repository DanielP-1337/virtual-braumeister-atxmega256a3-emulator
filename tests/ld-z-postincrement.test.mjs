import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { decodeAt, discover } from '../src/discovery.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';

function encode(register) {
  // Microchip AVR Instruction Set Manual, 6.68.1, form (ii).
  return Number.parseInt('1001000' + register.toString(2).padStart(5, '0') + '0001', 2);
}

function put(cpu, pc, ...words) {
  let a = pc * 2;
  for (const word of words) {
    cpu.present.fill(1, a, a + 2);
    cpu.flash[a++] = word & 255;
    cpu.flash[a++] = word >>> 8;
  }
}

function machine(words = [encode(0)], eeprom = null) {
  const flash = new Uint8Array(0x42000);
  const cpu = new XmegaCPU({ flash, present: new Uint8Array(flash.length) }, { eeprom });
  put(cpu, 0, ...words);
  return cpu;
}

function attachEeprom(cpu) {
  const nvm = new NVMController();
  nvm.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details), clock: () => cpu.cycles });
  cpu.bus.attachEEPROM(nvm);
}

test('LD Rd,Z+ reads all byte values into all 30 defined destinations and preserves SREG and RAMPZ', () => {
  const cpu = machine();
  assert.deepEqual([encode(0), encode(16), encode(29)], [0x9001, 0x9101, 0x91d1]);
  for (let rd = 0; rd < 30; rd++) {
    put(cpu, 0, encode(rd));
    for (let value = 0; value <= 255; value++) {
      cpu.pc = 0;
      cpu.r.fill(value ^ 255);
      cpu.r[30] = 0xff;
      cpu.r[31] = 0x21;
      cpu.sram[0x1ff] = value;
      cpu.sram[0x200] = value ^ 255;
      cpu.sreg = 255 - value;
      cpu.rampz = value % 8;
      cpu.eind = 2;
      const before = cpu.state();
      const expected = [...before.registers];
      expected[rd] = value;
      expected[30] = 0;
      expected[31] = 0x22;
      const oldSteps = cpu.steps;
      const t = cpu.step();
      assert.equal(t.mnemonic, 'LD');
      assert.deepEqual(cpu.state(), { ...before, pcWord: 1, cycles: before.cycles + 2, registers: expected });
      assert.equal(cpu.steps, oldSteps + 1);
      assert.deepEqual(t.accesses.map(a => [a.kind, a.space, a.addressByte, a.value]),
        [['fetch', 'flash', 0, encode(rd) & 255], ['fetch', 'flash', 1, encode(rd) >>> 8], ['read', 'sram', 0x21ff, value]]);
    }
  }
});

test('LD Rd,Z+ keeps consecutive data reads separate from ELPM through the same Z and RAMPZ', () => {
  const cpu = machine([encode(8), encode(9), 0x90a6]); // ELPM R10,Z
  cpu.setPair(30, 0x20ff);
  cpu.rampz = 2;
  cpu.sram[0xff] = 0x37;
  cpu.sram[0x100] = 0xe4;
  for (const [address, value] of [[0x20ff, 0xf1], [0x220ff, 0x1f], [0x22100, 0xc8], [0x2101, 0x17], [0x22101, 0x71]]) {
    cpu.flash[address] = value;
    cpu.present[address] = 1;
  }
  const traces = [cpu.step(), cpu.step(), cpu.step()];
  assert.deepEqual(traces.map(t => [t.accesses.at(-1).space, t.accesses.at(-1).addressByte, t.after.cycles]), [
    ['sram', 0x20ff, 2], ['sram', 0x2100, 4], ['flash', 0x22101, 7],
  ]);
  assert.deepEqual(Array.from(cpu.r.slice(8, 11)), [0x37, 0xe4, 0x71]);
  assert.deepEqual([cpu.pair(30), cpu.rampz, cpu.pc], [0x2101, 2, 3]);
});

test('LD Rd,Z+ samples an I/O register once in one AVRxm clock and can read CPU.RAMPZ', () => {
  const cpu = machine([encode(19), encode(20)]);
  const busReads = [];
  cpu.mapMMIO(0x604, { read(clock) { busReads.push([clock, cpu.pair(30)]); return 0xda; } });
  cpu.setPair(30, 0x604);
  cpu.rampz = 3;
  const t = cpu.step();
  assert.deepEqual(busReads, [[1, 0x604]]);
  assert.deepEqual([t.accesses.at(-1).space, cpu.r[19], cpu.pair(30), cpu.cycles], ['mmio', 0xda, 0x605, 1]);
  cpu.setPair(30, 0x3b);
  cpu.step();
  assert.deepEqual([cpu.r[20], cpu.pair(30), cpu.rampz, cpu.cycles], [3, 0x3c, 3, 2]);
});

test('LD Rd,Z+ takes three clocks in mapped EEPROM and two on the following SRAM byte', () => {
  const image = new Uint8Array(4096);
  image[4095] = 0xdc;
  const cpu = machine([encode(17), encode(18)], image);
  attachEeprom(cpu);
  cpu.write(0x1cc, 8);
  cpu.setPair(30, 0x1fff);
  cpu.rampz = 2;
  cpu.sram[0] = 0x49;
  const eeprom = cpu.step();
  assert.deepEqual(eeprom.accesses.at(-1), { kind: 'read', space: 'eeprom', addressByte: 0x1fff, value: 0xdc, waitCycles: 1 });
  assert.deepEqual([cpu.r[17], cpu.pair(30), cpu.cycles], [0xdc, 0x2000, 3]);
  const ram = cpu.step();
  assert.deepEqual(ram.accesses.at(-1), { kind: 'read', space: 'sram', addressByte: 0x2000, value: 0x49 });
  assert.deepEqual([cpu.r[18], cpu.pair(30), cpu.rampz, cpu.cycles], [0x49, 0x2001, 2, 5]);
});

test('LD Rd,Z+ rejects both undefined destination overlaps before touching the data bus', () => {
  for (const rd of [30, 31]) {
    const cpu = machine([encode(rd)]);
    cpu.setPair(30, 0x605);
    cpu.rampz = 2;
    cpu.sreg = 0xd7;
    let reads = 0;
    cpu.mapMMIO(0x605, { read() { reads++; return 7; } });
    const before = cpu.state();
    assert.deepEqual(decodeAt(cpu).operands, { register: rd, pointer: 'Z', postIncrement: true });
    assert.throws(() => cpu.step(), e => e.classification === 'UNDEFINED_OPERANDS' && e.opcode === encode(rd));
    assert.deepEqual([cpu.steps, reads], [0, 0]);
    assert.deepEqual(cpu.state(), before);
  }
});

test('LD Rd,Z+ leaves Rd, Z and clocks intact on invalid, unmapped and unknown data', () => {
  for (const [address, mapping, fault] of [
    [0x321, false, 'UNHANDLED_MMIO'], [0x1000, false, 'UNMAPPED_EEPROM'], [0x1100, true, 'UNKNOWN_EEPROM_DATA'],
    [0x6000, false, 'INVALID_DATA_ADDRESS'], [0xffff, false, 'INVALID_DATA_ADDRESS'],
  ]) {
    const cpu = machine();
    attachEeprom(cpu);
    if (mapping) cpu.write(0x1cc, 8);
    cpu.r[0] = 0x92;
    cpu.setPair(30, address);
    cpu.rampz = 4;
    cpu.sreg = 0xa5;
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === fault && e.addressByte === address && e.accessKind === 'read');
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  const cpu = machine([encode(7), encode(7)]);
  cpu.setPair(30, 0x5fff);
  cpu.sram[0x3fff] = 0x35;
  cpu.step();
  assert.deepEqual([cpu.r[7], cpu.pair(30), cpu.cycles], [0x35, 0x6000, 2]);
  const before = cpu.state();
  assert.throws(() => cpu.step(), e => e.classification === 'INVALID_DATA_ADDRESS' && e.addressByte === 0x6000);
  assert.deepEqual(cpu.state(), before);
});

test('LD Rd,Z+ validates instruction fetch and fall-through before an I/O read', () => {
  const cpu = machine();
  let reads = 0;
  cpu.setPair(30, 0x604);
  cpu.mapMMIO(0x604, { read() { reads++; return 0xc4; } });
  const last = cpu.flash.length / 2 - 1;
  put(cpu, last, encode(5));
  cpu.present[1] = 0;
  for (const [pc, reason] of [[0, /HEX hole/], [last, /PC target outside device/]]) {
    cpu.pc = pc;
    const before = cpu.state();
    assert.throws(() => cpu.step(), reason);
    assert.deepEqual(cpu.state(), before);
    assert.deepEqual([reads, cpu.steps], [0, 0]);
  }
});

test('LD Rd,Z+ discovery reproduces the committed read and the first subsequent fault', () => {
  function replay() {
    const cpu = machine([encode(6), encode(6)]);
    cpu.setPair(30, 0x5fff);
    cpu.sram[0x3fff] = 0x38;
    const trace = [];
    const result = discover(cpu, { onTrace: t => trace.push(t) });
    assert.deepEqual(trace.map(t => t.eventType), ['instruction', 'diagnostic']);
    assert.deepEqual([result.completedInstructions, result.cycles, result.lastPcWord], [1, 2, 1]);
    assert.equal(result.firstBlockingEvent.classification, 'INVALID_DATA_ADDRESS');
    assert.deepEqual([cpu.r[6], cpu.pair(30)], [0x38, 0x6000]);
    return { trace, result };
  }
  assert.deepEqual(replay(), replay());
});
