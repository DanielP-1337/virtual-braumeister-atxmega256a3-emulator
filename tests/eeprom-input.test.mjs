import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadEepromInput } from '../scripts/eeprom-input.mjs';
import { EEPROMStorage } from '../src/eeprom-storage.mjs';
import { XmegaCPU } from '../src/xmega.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';

const eof = ':00000001FF';
const firstByte = ':01000000A55A';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceName = 'synthetic-capture.eep';
function readHex(text) {
  return loadEepromInput(undefined, sourceName, path => {
    assert.equal(path, resolve(sourceName));
    return Buffer.from(text);
  });
}

test('sparse EEPROM input preserves declared bytes, holes and the source digest', () => {
  const text = [firstByte, ':01000200FFFE', ':010FFF003CB5', eof, ''].join('\r\n');
  const input = readHex(text);
  const store = new EEPROMStorage(input);
  assert.equal(store.describe().knownBytes, 3);
  assert.deepEqual([store.read(0), store.read(2), store.read(0xfff)], [0xa5, 0xff, 0x3c]);
  assert.throws(() => store.read(1), { classification: 'UNKNOWN_EEPROM_DATA' });
  assert.deepEqual(store.provenance, { kind: 'local-dump', label: resolve(sourceName), sha256: hash(text),
    format: 'intel-hex', addressSpace: 'eeprom-byte-offset' });
});

test('an omitted EEPROM and a complete raw dump retain their existing semantics', () => {
  const unknown = new EEPROMStorage(loadEepromInput(undefined, undefined, () => assert.fail('Unexpected file read')));
  assert.equal(unknown.describe().knownBytes, 0);
  assert.equal(unknown.provenance.kind, 'unknown');
  const bytes = Buffer.alloc(4096, 0);
  bytes[4095] = 0x42;
  const raw = new EEPROMStorage(loadEepromInput('fixture.bin', undefined, () => bytes));
  assert.equal(raw.describe().knownBytes, 4096);
  assert.deepEqual([raw.read(0), raw.read(4095)], [0, 0x42]);
  assert.deepEqual(raw.provenance, { kind: 'local-dump', label: resolve('fixture.bin'), sha256: hash(bytes) });
  for (const length of [1, 4095, 4097]) assert.throws(() => loadEepromInput('short.bin', undefined, () => Buffer.alloc(length)), /4096/);
});

test('EEPROM input rejects ambiguous sources, overlapping records, bad checksums, missing EOF and out-of-range offsets', () => {
  assert.throws(() => loadEepromInput('a', 'b', () => assert.fail('Unexpected file read')), /only one/);
  assert.throws(() => loadEepromInput(undefined, '', () => assert.fail('Unexpected file read')), /Missing/);
  assert.throws(() => readHex([firstByte, firstByte, eof].join('\n')), /overlapping/);
  assert.throws(() => readHex(':01000000A559\n' + eof), /checksum/);
  assert.throws(() => readHex(firstByte), /EOF/);
  assert.throws(() => readHex(':01100000A54A\n' + eof), /out of range/);
  assert.throws(() => readHex(':020FFF00AABB8B\n' + eof), /out of range/);
});

test('a synthetic CPU program can consume one captured byte and traps precisely at the adjacent hole', () => {
  const store = new EEPROMStorage(readHex(firstByte + '\n' + eof));
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set([0x60, 0x81, 0x71, 0x81]); // LD R22,Z followed by LDD R23,Z+1.
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }, { eeprom: store });
  const nvm = new NVMController(), events = [];
  nvm.register(cpu.bus.mmio, { fault: (message, detail) => cpu.fault(message, detail), clock: () => cpu.cycles });
  cpu.bus.attachEEPROM(nvm, { onAccess: e => events.push(e) });
  cpu.write(0x01cc, 8);
  cpu.setPair(30, 0x1000);
  cpu.r[23] = 0xcc;
  assert.equal(cpu.step().mnemonic, 'LD');
  assert.equal(cpu.r[22], 0xa5);
  assert.equal(cpu.cycles, 3);
  const before = cpu.state();
  assert.throws(() => cpu.step(), e => e.classification === 'UNKNOWN_EEPROM_DATA' &&
    e.addressByte === 0x1001 && e.trace.instructionCompleted === false);
  assert.deepEqual(cpu.state(), before);
  assert.equal(cpu.steps, 1);
  assert.deepEqual(events.map(e => [e.offset, e.completed, e.value]), [[0, true, 0xa5], [1, false, undefined]]);
});
