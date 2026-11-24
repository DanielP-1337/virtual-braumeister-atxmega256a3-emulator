import assert from 'node:assert/strict';
import test from 'node:test';
import { EEPROMStorage } from '../src/eeprom-storage.mjs';
import { EEPROMPageBuffer } from '../src/peripherals/eeprom-page-buffer.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

// The oracle indexes a flat EEPROM by absolute offset. None of its expected
// addresses or values come from the modeled buffer, its tags, or its registers.
const size = 4096;
function seed() {
  return Uint8Array.from({ length: size }, (_, index) =>
    (Math.floor(index / 251) * 31 + index * 47 + 3) % 256);
}
function storageWith(bytes, valid) {
  return new EEPROMStorage({ bytes: bytes.slice(), valid: valid?.slice(),
    provenance: { kind: 'synthetic', label: 'Page-buffer test data' } });
}

test('EEPROM page buffer changes exactly one addressed byte at every one of the 4,096 offsets', () => {
  const expected = seed();
  const storage = storageWith(expected);
  const buffer = new EEPROMPageBuffer(storage);
  const known = new Uint8Array(size).fill(1);
  for (let offset = 0; offset < size; offset++) {
    const replacement = 255 - expected[offset];
    buffer.load(offset, replacement);
    assert.deepEqual(storage.bytes, expected, 'A buffer load must remain volatile');
    assert.deepEqual(storage.valid, known);
    buffer.completeEraseWrite(offset);
    expected[offset] = replacement;
    assert.deepEqual(storage.bytes, expected, 'Persistent mismatch at write ' + offset);
    assert.deepEqual(storage.valid, known);
  }
});

test('EEPROM page buffer combines repeated loads, tags explicit FF and commits only tagged slots in the selected page', () => {
  const expected = seed();
  const known = Uint8Array.from({ length: size }, (_, i) => Number(i % 5 === 0));
  // Change a known zero back to FF, change an unknown byte into a known zero,
  // and ensure every other prior value and validity bit survives.
  expected[0x0fe0] = 0;
  known[0x0fe0] = 1;
  known[0x0fe7] = 0;
  known[0x0fff] = 0;
  const storage = storageWith(expected, known);
  const buffer = new EEPROMPageBuffer(storage);
  buffer.load(0, 255);
  buffer.load(7, 0);
  buffer.load(31, 0xf3);
  buffer.load(63, 0x6e);
  assert.deepEqual(storage.bytes, expected);
  assert.deepEqual(storage.valid, known);
  buffer.completeEraseWrite(0x0ff1); // The current ADDR selects the last page.
  expected[0x0fe0] = 255;
  expected[0x0fe7] = 0;
  expected[0x0fff] = 0x62;
  known[0x0fe7] = known[0x0fff] = 1;
  assert.deepEqual(storage.bytes, expected);
  assert.deepEqual(storage.valid, known);
  assert.equal(storage.read(0x0fe7), 0);
  assert.equal(storage.read(0x0fff), 0x62);
  assert.equal(storage.provenanceAt(0x0fe0).kind, 'emulated-write');
  assert.equal(storage.provenanceAt(0x0fe7).kind, 'emulated-write');
  assert.equal(storage.provenanceAt(0x0fff).kind, 'emulated-write');
  assert.equal(storage.provenanceAt(5).kind, 'synthetic');
  assert.throws(() => storage.read(0x0ffe), e => e.classification === 'UNKNOWN_EEPROM_DATA');
  // No tag from the previous page may be replayed into another page.
  buffer.load(3, 0xe8);
  buffer.completeEraseWrite(0x21);
  expected[0x23] = 0xe8;
  known[0x23] = 1;
  assert.deepEqual(storage.bytes, expected);
  assert.deepEqual(storage.valid, known);
});

test('EEPROM page buffer makes an explicitly written FF known in initially unknown storage', () => {
  const storage = new EEPROMStorage();
  const buffer = new EEPROMPageBuffer(storage);
  const expected = storage.bytes.slice();
  buffer.load(31, 255);
  assert.equal(storage.describe().knownBytes, 0);
  assert.throws(() => storage.read(31), e => e.classification === 'UNKNOWN_EEPROM_DATA');
  buffer.completeEraseWrite(31);
  const known = new Uint8Array(size);
  known[31] = 1;
  assert.deepEqual(storage.valid, known);
  expected[31] = 255;
  assert.deepEqual(storage.bytes, expected);
  assert.equal(storage.read(31), 255);
  assert.throws(() => storage.read(32), e => e.classification === 'UNKNOWN_EEPROM_DATA');
});

test('EEPROM page buffer rejects invalid offsets or bytes atomically and clearing it discards tags', () => {
  const expected = seed(), storage = storageWith(expected);
  const buffer = new EEPROMPageBuffer(storage);
  for (const badOffset of [-1, 4096, 1.5, NaN]) assert.throws(() => buffer.load(badOffset, 1));
  for (const badByte of [-1, 256, 1.5, NaN]) assert.throws(() => buffer.load(1, badByte));
  assert.equal(buffer.loaded, false);
  buffer.load(19, 0x9a);
  for (const badOffset of [-1, 4096, 1.5, NaN]) assert.throws(() => buffer.completeEraseWrite(badOffset));
  assert.equal(buffer.loaded, true);
  assert.deepEqual(storage.bytes, expected);
  buffer.completeEraseWrite(0x80);
  expected[0x93] = 0x9a;
  assert.deepEqual(storage.bytes, expected);
  buffer.load(10, 0);
  buffer.clear();
  assert.equal(buffer.loaded, false);
  buffer.load(9, 0xae);
  buffer.completeEraseWrite(0x80);
  expected[0x89] = 0xae;
  assert.deepEqual(storage.bytes, expected);
});

// A hand-assembled program uses LDI R16,imm followed by STS addr,R16.
// Only the test invokes the completion primitive. No CPU-visible command
// simulates CCP authorization, programming duration, or a completed page write.
function machine(storage, buffer, writes = []) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  let pos = 0;
  for (const [address, value] of writes) {
    const ldi = 0xe000 + Math.floor(value / 16) * 256 + value % 16;
    for (const word of [ldi, 0x9300, address]) {
      flash[pos++] = word % 256;
      flash[pos++] = Math.floor(word / 256);
    }
  }
  present.fill(1, 0, pos);
  const cpu = new XmegaCPU({ flash, present }, { eeprom: storage });
  const nvm = new NVMController({ pageBuffer: buffer });
  nvm.register(cpu.bus.mmio, { fault: (message, detail) => cpu.fault(message, detail), clock: () => cpu.cycles });
  const accesses = [];
  cpu.bus.attachEEPROM(nvm, { onAccess: event => accesses.push(event) });
  return { cpu, nvm, accesses };
}

test('EEPROM page buffer loads through DATA0 via synthetic AVR stores and exposes EELOAD independently of busy', () => {
  function replay() {
    const expected = seed(), storage = storageWith(expected);
    const buffer = new EEPROMPageBuffer(storage);
    // Operations use addresses from the A3 datasheet. High address bits do not
    // select a destination page during a buffer load; completion selects it.
    const writes = [[0x01ca, 0x33], [0x01c0, 0xff], [0x01c1, 0xbe],
      [0x01c2, 0xa5], [0x01c4, 0x69]];
    const { cpu, nvm, accesses } = machine(storage, buffer, writes);
    const steps = [];
    for (let i = 0; i < writes.length; i++) {
      steps.push(cpu.step(), cpu.step());
      assert.equal(nvm.read(15), i < writes.length - 1 ? 0 : 2);
    }
    assert.deepEqual(steps.flatMap(step => step.accesses.filter(a => a.kind === 'write'))
      .map(a => [a.space, a.addressByte, a.value]), writes.map(([address, value]) => ['mmio', address, value]));
    assert.deepEqual(storage.bytes, expected);
    buffer.completeEraseWrite(0x620);
    expected[0x63f] = 0x69;
    assert.deepEqual(storage.bytes, expected);
    assert.equal(nvm.read(15), 0);
    assert.equal(buffer.loaded, false);
    cpu.write(0x01ca, 0);
    cpu.write(0x01cc, 8);
    assert.equal(cpu.read(0x163f), 0x69);
    assert.equal(cpu.read(0x163e), expected[0x63e]);
    assert.deepEqual(accesses.map(event => event.provenance.kind), ['emulated-write', 'synthetic']);
    return steps;
  }
  assert.deepEqual(replay(), replay());
});

test('EEPROM page buffer survives strict rejected MMIO operations and loses volatile data on controller reset', () => {
  const expected = seed(), storage = storageWith(expected);
  const buffer = new EEPROMPageBuffer(storage), { cpu, nvm } = machine(storage, buffer);
  const fails = (operation, classification) => assert.throws(operation, e => e.classification === classification);
  cpu.write(0x01c4, 0x55); // NO_OPERATION leaves no tag.
  assert.equal(cpu.read(0x01cf), 0);
  cpu.write(0x01cc, 8);
  fails(() => cpu.write(0x01ca, 0x33), 'NVM_UNSUPPORTED_COMMAND');
  fails(() => cpu.write(0x01c4, 0xa5), 'NVM_DATA0_MAPPED_UNSUPPORTED');
  fails(() => cpu.write(0x1001, 0xa5), 'EEPROM_PAGE_BUFFER_UNSUPPORTED');
  cpu.write(0x01cc, 0);
  cpu.write(0x01ca, 0x33);
  cpu.write(0x01c0, 4);
  cpu.write(0x01c4, 0x0a);
  for (const command of [0x35, 0x36]) fails(() => cpu.write(0x01ca, command), 'NVM_UNSUPPORTED_COMMAND');
  fails(() => cpu.write(0x01cb, 1), 'NVM_COMMAND_EXECUTION_UNSUPPORTED');
  assert.equal(cpu.read(0x01ca), 0x33);
  assert.equal(cpu.read(0x01cf), 2);
  assert.deepEqual(storage.bytes, expected);
  nvm.activity.begin('eeprom', 5);
  assert.equal(cpu.read(0x01cf), 0x82);
  fails(() => cpu.write(0x01c4, 0x00), 'NVM_BUSY_ACCESS_UNSUPPORTED');
  fails(() => nvm.reset(), 'NVM_RESET_DURING_OPERATION_UNSUPPORTED');
  cpu.cycles = 5;
  assert.equal(cpu.read(0x01cf), 2);
  assert.equal(cpu.read(0x01c4), 0x0a);
  nvm.reset();
  assert.equal(cpu.read(0x01cf), 0);
  assert.equal(buffer.loaded, false);
  assert.deepEqual(storage.bytes, expected);
  const legacy = machine(storage, undefined);
  fails(() => legacy.cpu.write(0x01ca, 0x33), 'NVM_UNSUPPORTED_COMMAND');
});
