import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU, ExecutionFault } from '../src/xmega.mjs';
import { EEPROMStorage } from '../src/eeprom-storage.mjs';
import { EEPROMPageBuffer } from '../src/peripherals/eeprom-page-buffer.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';

// Standalone synthetic AVR program. Its reset entry, code layout, input bytes
// and timings belong to this test. No firmware image or EEPROM dump is loaded.
const cmd = 0x01ca, ctrla = 0x01cb, ctrlb = 0x01cc, status = 0x01cf;
const addr0 = 0x01c0, data0 = 0x01c4;
const pageCycles = 40, flushCycles = 16;
const low = 0x5a, high = 0xc3;

function wordWriter(offset, dirty, probeNeighbor) {
  const words = [], labels = {}, references = [];
  const label = name => { labels[name] = words.length; };
  const emit = (...opcodes) => words.push(...opcodes);
  const ldi = (r, k) => emit(0xe000 | ((k & 0xf0) << 4) | ((r - 16) << 4) | (k & 15));
  const store = (address, r) => emit(0x9200 | (r << 4), address);
  const load = (r, address) => emit(0x9000 | (r << 4), address);
  const select = command => { ldi(19, command); store(cmd, 19); };
  function branch(opcode, target) {
    references.push({ pc: words.length, opcode, target });
    emit(opcode);
    if (opcode === 0x940e) emit(0); // Absolute CALL, two words.
  }
  function waitReady(name) {
    label(name);
    load(19, status);
    emit(0xfd37); // SBRC R19,7
    branch(0xc000, name);
  }

  ldi(16, 0xd8); ldi(17, 1);
  ldi(24, offset & 255); ldi(25, offset >>> 8);
  ldi(20, low); ldi(21, high);
  if (dirty) {
    select(0x33);
    ldi(19, 17); store(addr0, 19); // A stale tag in slot 17.
    ldi(19, 0); store(data0, 19);
  }
  ldi(19, 8); store(ctrlb, 19); // Begin with the EEPROM window enabled.
  branch(0x940e, 'writeWord');
  waitReady('callerPoll');
  // Re-enable mapping and read the word back without changing NVM.CMD.
  ldi(19, 8); store(ctrlb, 19);
  ldi(30, offset & 255); ldi(31, (0x1000 + offset) >>> 8);
  emit(0x8160, 0x8171); // LD R22,Z; LDD R23,Z+1
  if (probeNeighbor) emit(0x8182); // LDD R24,Z+2
  label('done'); emit(0); // Retire this NOP after the caller observes ready.

  label('writeWord');
  branch(0xd000, 'writeLow');
  label('highByte'); emit(0x2f25); // MOV R18,R21
  branch(0xc000, 'writeByte'); // Tail call uses the caller's original stack frame.
  label('writeLow'); emit(0x2f24); // MOV R18,R20
  label('writeByte');
  waitReady('writerPoll');
  load(19, ctrlb); emit(0x7f37); store(ctrlb, 19); // ANDI R19,0xF7
  load(19, status); emit(0xff31); // SBRS R19,1 (EELOAD)
  branch(0xc000, 'loadByte');
  select(0x36); emit(0xbf04); store(ctrla, 17); // OUT 0x34,R16, then CMDEX.
  waitReady('flushPoll');
  label('loadByte'); select(0x33);
  store(addr0, 24); store(addr0 + 1, 25); store(addr0 + 2, 1);
  store(data0, 18); select(0x35);
  emit(0xbf04);
  label('commit'); store(ctrla, 17);
  emit(0x9601, 0x9508); // ADIW R25:R24,1; RET

  for (const { pc, opcode, target } of references) {
    assert.ok(Object.hasOwn(labels, target));
    if (opcode === 0x940e) words[pc + 1] = labels[target];
    else words[pc] = opcode | ((labels[target] - pc - 1) & 0xfff);
  }
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((w, i) => flash.set([w & 255, w >>> 8], i * 2));
  present.fill(1, 0, words.length * 2);
  return { image: { flash, present }, labels };
}

function execute(offset, { dirty = false, calibrated = true, probeNeighbor = false } = {}) {
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 53 + 11) % 256);
  const valid = Uint8Array.from({ length: 4096 }, (_, i) => Number(i % 3 === 1));
  const storage = new EEPROMStorage({ bytes, valid, provenance: { kind: 'synthetic', label: 'Word writer fixture' } });
  const { image, labels } = wordWriter(offset, dirty, probeNeighbor);
  const cpu = new XmegaCPU(image, { eeprom: storage });
  const pageBuffer = new EEPROMPageBuffer(storage);
  const transitions = [], instructions = [], mappedAccesses = [];
  const nvm = new NVMController({ pageBuffer, onTransition(e) {
    transitions.push({ ...e, bytes: storage.bytes.slice(), valid: storage.valid.slice() });
  } });
  nvm.register(cpu.bus.mmio, { clock: () => cpu.cycles, fault: (m, d) => cpu.fault(m, d) });
  const programming = { eraseWriteCycles: pageCycles };
  if (calibrated) programming.eraseBufferCycles = flushCycles;
  cpu.bus.attachEEPROM(nvm, { programming, onAccess: event => mappedAccesses.push(event) });
  let fault;
  while (cpu.steps < 500) {
    try { instructions.push(cpu.step()); }
    catch (e) {
      if (!(e instanceof ExecutionFault)) throw e;
      fault = e;
      break;
    }
    if (instructions.at(-1).before.pcWord === labels.done) break;
  }
  assert.ok(cpu.steps < 500, 'Synthetic word writer exceeded instruction limit');
  return { cpu, nvm, fault, labels, instructions, transitions, mappedAccesses, storage, pageBuffer, bytes, valid };
}

function verifyPersistence(f, offset, count, state = f.storage) {
  const expected = f.bytes.slice(), known = f.valid.slice();
  for (let i = 0; i < count; i++) {
    expected[offset + i] = [low, high][i];
    known[offset + i] = 1;
  }
  assert.deepEqual(state.bytes, expected);
  assert.deepEqual(state.valid, known);
}

function verifySuccess(f, offset, dirty) {
  assert.equal(f.fault, undefined);
  const trace = f.instructions;
  assert.equal(trace[0].before.pcWord, 0);
  assert.equal(trace.at(-1).before.pcWord, f.labels.done);
  const operations = dirty ? [0x36, 0x35, 0x35] : [0x35, 0x35];
  assert.equal(f.transitions.length, 2 * operations.length);
  let written = 0, lastDeadline = 0;
  for (const [i, command] of operations.entries()) {
    const [start, end] = f.transitions.slice(i * 2, i * 2 + 2);
    assert.deepEqual([start.eventType, end.eventType], ['nvm-activity-started', 'nvm-activity-completed']);
    assert.deepEqual([start.command, end.command], [command, command]);
    assert.ok(start.startCycle > lastDeadline);
    assert.equal(start.completeCycle - start.startCycle, command === 0x35 ? pageCycles : flushCycles);
    assert.equal(end.completeCycle, start.completeCycle);
    assert.ok(end.observedCycle >= end.completeCycle);
    lastDeadline = end.completeCycle;
    verifyPersistence(f, offset, written, start);
    if (command === 0x35) {
      assert.equal(start.address, offset + written);
      written++;
    }
    verifyPersistence(f, offset, written, end);
  }
  verifyPersistence(f, offset, 2);
  assert.equal(f.storage.describe().programmedBytes, 2);
  assert.equal(f.storage.provenanceAt(offset).kind, 'emulated-write');
  assert.equal(f.storage.provenanceAt(offset + 1).kind, 'emulated-write');
  assert.equal(f.pageBuffer.loaded, false);
  assert.equal(f.nvm.registers[10], 0x35);
  assert.deepEqual(Array.from(f.cpu.r.slice(22, 24)), [low, high]);
  assert.deepEqual(f.mappedAccesses.map(a => [a.kind, a.offset, a.value, a.provenance.kind]), [
    ['read', offset, low, 'emulated-write'], ['read', offset + 1, high, 'emulated-write'],
  ]);
  assert.deepEqual(trace.filter(t => t.accesses.some(a => a.space === 'eeprom'))
    .map(t => [t.mnemonic, t.after.cycles - t.before.cycles]), [['LD', 3], ['LDD', 4]]);

  const writes = trace.flatMap(t => t.accesses.filter(a => a.kind === 'write')
    .map(a => ({ address: a.addressByte, value: a.value, cycle: t.after.cycles })));
  const keys = writes.filter(w => w.address === 0x34);
  const triggers = writes.filter(w => w.address === ctrla);
  assert.equal(keys.length, operations.length);
  assert.equal(triggers.length, operations.length);
  for (const [i, trigger] of triggers.entries()) {
    assert.equal(keys[i].value, 0xd8);
    assert.equal(trigger.value, 1);
    assert.equal(trigger.cycle - keys[i].cycle, 2);
    assert.equal(trigger.cycle, f.transitions[2 * i].startCycle);
  }
  const polling = name => trace.filter(e => e.before.pcWord === f.labels[name])
    .map(e => e.accesses.find(a => a.kind === 'read' && a.addressByte === status).value);
  for (const name of ['writerPoll', 'callerPoll', ...(dirty ? ['flushPoll'] : [])]) {
    const values = polling(name);
    assert.ok(values.some(value => value & 0x80), name + ' observes busy');
    assert.equal(values.at(-1) & 0x80, 0, name + ' observes completion');
  }
  const calls = trace.filter(e => ['CALL', 'RCALL', 'RET'].includes(e.mnemonic));
  assert.deepEqual(calls.map(e => [e.mnemonic, e.after.pcWord, e.after.sp]), [
    ['CALL', f.labels.writeWord, 0x5ffc], ['RCALL', f.labels.writeLow, 0x5ff9],
    ['RET', f.labels.highByte, 0x5ffc], ['RET', f.labels.callerPoll, 0x5fff],
  ]);
  const increments = trace.filter(e => e.mnemonic === 'ADIW');
  assert.deepEqual(increments.map(e => e.after.registers[24] + 256 * e.after.registers[25]),
    [offset + 1, offset + 2]);
}

test('EEPROM word writer commits the two little-endian bytes separately within a page and at page edges', () => {
  for (const offset of [0x42, 0x1f, 0xff, 0xffe]) verifySuccess(execute(offset), offset, false);
});

test('EEPROM word writer flushes a stale tag before the first commit and replays deterministically', () => {
  const first = execute(0xff, { dirty: true });
  verifySuccess(first, 0xff, true);
  const replay = execute(0xff, { dirty: true });
  verifySuccess(replay, 0xff, true);
  assert.deepEqual(first.instructions, replay.instructions);
  assert.deepEqual(first.transitions, replay.transitions);
});

test('EEPROM word writer preserves the first committed byte on a second destination outside EEPROM', () => {
  const f = execute(0xfff);
  assert.equal(f.fault?.classification, 'INVALID_EEPROM_ADDRESS');
  assert.equal(f.fault.pcWord, f.labels.commit);
  assert.equal(f.fault.opcode, 0x9310); // STS to CTRLA with R17=1.
  assert.equal(f.fault.addressByte, ctrla);
  assert.equal(f.fault.trace.instructionCompleted, false);
  assert.equal(f.cpu.pair(24), 0x1000);
  assert.deepEqual(f.transitions.map(e => [e.eventType, e.address]), [
    ['nvm-activity-started', 0xfff], ['nvm-activity-completed', 0xfff],
  ]);
  verifyPersistence(f, 0xfff, 1);
  assert.equal(f.pageBuffer.loaded, true);
});

test('EEPROM word writer stops on an uncalibrated dirty-buffer flush before either byte is written', () => {
  const f = execute(0xff, { dirty: true, calibrated: false });
  assert.equal(f.fault?.classification, 'NVM_TIMING_UNAVAILABLE');
  assert.equal(f.fault.addressByte, ctrla);
  assert.equal(f.fault.trace.instructionCompleted, false);
  assert.equal(f.pageBuffer.loaded, true);
  assert.deepEqual(f.transitions, []);
  verifyPersistence(f, 0xff, 0);
});

test('EEPROM word writer readback with CMD 0x35 still rejects the first unknown neighbor', () => {
  const f = execute(0xff, { probeNeighbor: true });
  assert.equal(f.fault?.classification, 'UNKNOWN_EEPROM_DATA');
  assert.equal(f.fault.addressByte, 0x1101);
  assert.equal(f.fault.trace.instructionCompleted, false);
  assert.deepEqual(f.mappedAccesses.map(a => [a.offset, a.completed]), [[0xff, true], [0x100, true], [0x101, false]]);
  assert.deepEqual(f.transitions.map(e => e.command), [0x35, 0x35, 0x35, 0x35]);
  verifyPersistence(f, 0xff, 2);
});
