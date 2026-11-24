import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';
import { EEPROMPageBuffer } from '../src/peripherals/eeprom-page-buffer.mjs';
import { EEPROMStorage } from '../src/eeprom-storage.mjs';

// All programs and input bytes are synthetic. The oracle uses absolute EEPROM
// offsets and published AVRxm instruction durations, independent of the model.
const address = 0x25f, replacement = 0xa6;
const durations = { eraseWriteCycles: 8, eraseBufferCycles: 5 };
const NOP = [0], ST_X = [0x931c]; // ST X,R17; X points to CTRLA.
const STD = [0x8713]; // STD Z+11,R17; Z points to the NVM controller.
const sts = (addr, r) => [0x9200 + 16 * r, addr];
const ldi = (r, k) => [0xe000 + (k >>> 4) * 256 + (r - 16) * 16 + k % 16];
const io = (base, addr, r) => [base + Math.floor(addr / 16) * 512 + 16 * r + addr % 16];
const KEY = io(0xb800, 0x34, 16); // OUT CCP,R16
const READ_CCP = io(0xb000, 0x34, 19); // IN R19,CCP

function fixture(body, { signature = 0xd8, command = 0x35, programming = durations } = {}) {
  const beforeBytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 93 + 17) % 256);
  const beforeValid = Uint8Array.from({ length: 4096 }, (_, i) => Number(i % 2 === 0));
  const storage = new EEPROMStorage({ bytes: beforeBytes, valid: beforeValid,
    provenance: { kind: 'synthetic', label: 'Independent CCP tests' } });
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const prefix = [];
  for (const [reg, val] of [[0x1ca, 0x33], [0x1c0, address % 256], [0x1c1, address >>> 8],
    [0x1c2, 0], [0x1c4, replacement], [0x1ca, command]]) {
    prefix.push(ldi(20, val), sts(reg, 20));
  }
  prefix.push(ldi(16, signature), ldi(17, 1), ldi(18, 0), ldi(26, 0xcb), ldi(27, 1),
    ldi(30, 0xc0), ldi(31, 1));
  let i = 0;
  for (const instruction of [...prefix, ...body, ...Array(32).fill(NOP)]) {
    for (const word of instruction) {
      flash[i++] = word % 256;
      flash[i++] = Math.floor(word / 256);
    }
  }
  present.fill(1, 0, i);
  flash[0x1c0] = 0x4e; // Explicit synthetic lookup byte for the LPM cancellation case.
  present[0x1c0] = 1;
  const cpu = new XmegaCPU({ flash, present }, { eeprom: storage });
  const pageBuffer = new EEPROMPageBuffer(storage);
  const nvm = new NVMController({ pageBuffer });
  nvm.register(cpu.bus.mmio, { fault: (message, detail) => cpu.fault(message, detail),
    clock: () => cpu.cycles });
  cpu.bus.attachEEPROM(nvm, { programming });
  const step = count => Array.from({ length: count }, () => cpu.step());
  step(prefix.length);
  const busy = () => Boolean(cpu.read(0x01cf) & 0x80);
  function verifyStorage(written) {
    const expected = beforeBytes.slice(), known = beforeValid.slice();
    if (written) {
      expected[address] = replacement;
      known[address] = 1;
    }
    assert.deepEqual(storage.bytes, expected);
    assert.deepEqual(storage.valid, known);
  }
  assert.equal(cpu.read(0x01cf), 2);
  verifyStorage(false);
  return { cpu, nvm, pageBuffer, storage, step, busy, verifyStorage };
}

test('CCP accepts only the IOREG signature for CMDEX across all 256 key bytes', () => {
  for (let signature = 0; signature < 256; signature++) {
    const f = fixture([KEY, READ_CCP, ST_X], { signature });
    const events = f.step(3);
    assert.equal(events[1].after.registers[19], signature === 0xd8 ? 1 : signature === 0x9d ? 2 : 0);
    assert.equal(f.busy(), signature === 0xd8, 'signature ' + signature);
    f.verifyStorage(false);
    f.step(8);
    assert.equal(f.busy(), false);
    f.verifyStorage(signature === 0xd8);
  }
  const noKey = fixture([ST_X]);
  noKey.step(1);
  assert.equal(noKey.busy(), false);
  noKey.step(9);
  noKey.verifyStorage(false);
  const sameEdge = fixture([]);
  sameEdge.cpu.write(0x34, 0xd8);
  sameEdge.cpu.write(0x1cb, 1);
  assert.equal(sameEdge.busy(), false);
  sameEdge.verifyStorage(false);
});

test('CCP accepts write edges one through four and ignores later ST, STD and STS write edges', () => {
  for (const [store, clocks] of [[ST_X, 1], [STD, 2], [sts(0x1cb, 17), 2]]) {
    for (let delay = 0; delay <= 5; delay++) {
      const f = fixture([KEY, ...Array(delay).fill(NOP), store]);
      const grant = f.step(1)[0];
      const [strobe] = f.step(delay + 1).slice(-1);
      const elapsed = delay + clocks;
      assert.equal(strobe.after.cycles - grant.after.cycles, elapsed);
      const starts = elapsed <= 4;
      assert.equal(f.busy(), starts, strobe.mnemonic + ' at grant +' + elapsed);
      f.verifyStorage(false);
      f.step(8);
      assert.equal(f.busy(), false);
      f.verifyStorage(starts);
    }
  }
  // A two-cycle branch + a one-cycle NOP + a two-cycle STS fit in three
  // instructions, but their write edge is five cycles after the key.
  const f = fixture([KEY, [0xc000], NOP, sts(0x1cb, 17)]);
  f.step(4);
  assert.equal(f.busy(), false);
  f.step(8);
  f.verifyStorage(false);
});

test('CCP readback expires after four cycles; SRAM and ordinary I/O reads preserve a live grant', () => {
  for (const [signature, mode] of [[0xd8, 1], [0x9d, 2]]) {
    const f = fixture([KEY, ...Array(5).fill(READ_CCP)], { signature });
    f.step(1);
    assert.deepEqual(f.step(5).map(e => e.after.registers[19]), [mode, mode, mode, mode, 0]);
  }
  const f = fixture([KEY, [0x9130, 0x2000], io(0xb000, 0x3f, 19), ST_X]);
  f.step(4);
  assert.equal(f.busy(), true);
  f.step(8);
  f.verifyStorage(true);
  const reset = fixture([KEY]);
  reset.step(1);
  reset.nvm.reset();
  assert.equal(reset.cpu.read(0x34), 0);
  assert.equal(reset.pageBuffer.loaded, false);
  reset.verifyStorage(false);
});

test('CCP loses authorization on intervening data writes or LPM and requires a fresh key', () => {
  const interruptions = [
    sts(0x2000, 18), // SRAM
    io(0xb800, 0x3b, 18), // RAMPZ
    sts(0x1ca, 20), // same value in NVM.CMD
    sts(0x1cb, 18), // CMDEX=0 consumes the grant without starting a command
    io(0xb800, 0x34, 18), // replace CCP with an invalid signature
    [0x9134], // LPM R19,Z, three cycles, followed by ST X on edge four
  ];
  for (const interruption of interruptions) {
    const f = fixture([KEY, interruption, ST_X, KEY, ST_X]);
    f.step(3);
    assert.equal(f.busy(), false, 'interruption ' + interruption);
    assert.equal(f.pageBuffer.loaded, true);
    f.verifyStorage(false);
    f.step(2);
    assert.equal(f.busy(), true);
    f.step(8);
    f.verifyStorage(true);
  }
  const ext = fixture([KEY, [0x9136]]); // ELPM R19,Z during the active grant.
  ext.step(1);
  const before = ext.cpu.state();
  assert.throws(() => ext.cpu.step(), e => e.classification === 'CCP_PROGRAM_READ_UNSUPPORTED');
  assert.deepEqual(ext.cpu.state(), before);
  ext.verifyStorage(false);
});

test('CCP protected erase/write is busy until its deadline and commits only the tagged byte once', () => {
  function run() {
    const f = fixture([KEY, STD, ...Array(8).fill(NOP), ST_X]);
    const events = f.step(2);
    assert.equal(f.busy(), true);
    f.verifyStorage(false);
    for (let elapsed = 1; elapsed < 8; elapsed++) {
      events.push(f.cpu.step());
      assert.equal(f.busy(), true, 'early clear at ' + elapsed);
      f.verifyStorage(false);
    }
    events.push(f.cpu.step());
    assert.equal(f.busy(), false);
    assert.equal(f.pageBuffer.loaded, false);
    assert.equal(f.storage.provenanceAt(address).kind, 'emulated-write');
    f.verifyStorage(true);
    assert.equal(f.cpu.read(0x1cb), 0);
    events.push(f.cpu.step());
    assert.equal(f.busy(), false);
    f.verifyStorage(true);
    return events;
  }
  assert.deepEqual(run(), run());
  // An unimplemented read at the completion edge must leave the stopped
  // machine at the previous retired cycle. A successful poll can then retire.
  const f = fixture([KEY, STD, ...Array(7).fill(NOP), [0x9130, 0x01d0]]);
  f.step(9);
  const before = f.cpu.state();
  assert.throws(() => f.cpu.step(), e => e.classification === 'NVM_LOCKBITS_UNKNOWN');
  assert.deepEqual(f.cpu.state(), before);
  assert.equal(f.busy(), true);
  f.verifyStorage(false);
  const poll = fixture([KEY, STD, ...Array(7).fill(NOP), [0x9130, 0x01cf]]);
  const events = poll.step(10);
  assert.equal(events.at(-1).after.registers[19], 0);
  poll.verifyStorage(true);
});

test('CCP protected buffer erase clears only the volatile slots at its own deadline', () => {
  const f = fixture([ST_X, KEY, sts(0x1cb, 17)], { command: 0x36 });
  f.step(1);
  assert.equal(f.busy(), false);
  assert.equal(f.pageBuffer.loaded, true);
  f.step(2);
  assert.equal(f.busy(), true);
  f.step(4);
  assert.equal(f.busy(), true);
  f.verifyStorage(false);
  f.step(1);
  assert.equal(f.busy(), false);
  assert.equal(f.pageBuffer.loaded, false);
  f.verifyStorage(false);
});

test('CCP reports an uncalibrated authorized buffer erase without inventing a completion', () => {
  const f = fixture([ST_X, KEY, ST_X], { command: 0x36, programming: { eraseWriteCycles: 8 } });
  f.step(1);
  assert.equal(f.busy(), false);
  f.step(1);
  assert.throws(() => f.cpu.step(), e => e.classification === 'NVM_TIMING_UNAVAILABLE');
  assert.equal(f.busy(), false);
  assert.equal(f.pageBuffer.loaded, true);
  f.verifyStorage(false);
});
