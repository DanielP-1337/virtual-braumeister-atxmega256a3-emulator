import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { discover, decodeAt } from '../src/discovery.mjs';
function cpu(words) {
  const flash = new Uint8Array(0x42000).fill(255), present = new Uint8Array(0x42000);
  words.forEach((w, i) => { flash[i * 2] = w & 255; flash[i * 2 + 1] = w >>> 8; present.fill(1, i * 2, i * 2 + 2); });
  return new XmegaCPU({ flash, present });
}
test('unhandled STS reports operands and attempted value without completing the write', () => {
  const c = cpu([0x9230, 0x0604]); c.r[3] = 0x67; const traces = [];
  const result = discover(c, { onTrace: t => traces.push(t) });
  assert.equal(result.status, 'CONTROLLED_STOP'); assert.equal(result.applicationBootSuccessful, false);
  assert.equal(result.completedInstructions, 0); assert.equal(result.attemptedInstructions, 1); assert.equal(result.cycles, 0);
  const f = result.firstBlockingEvent; assert.equal(f.classification, 'UNHANDLED_MMIO');
  assert.equal(f.pcWord, 0); assert.equal(f.pcByte, 0); assert.deepEqual(f.opcodeWords, [0x9230, 0x0604]);
  assert.deepEqual(f.operands, { register: 3, addressByte: 0x604, value: 0x67 });
  assert.equal(result.mmioInventory[0].completed, false); assert.deepEqual(result.mmioInventory[0].values, [0x67]);
  assert.deepEqual(f.stateBefore, f.stateAtStop); assert.equal(traces[0].eventType, 'diagnostic');
  assert.equal(c.hooks.size, 0); // No default peripheral implementation was installed.
});
test('unknown opcode is not confused with MMIO and is not counted as an instruction', () => {
  const r = discover(cpu([0, 0xffff]));
  assert.equal(r.completedInstructions, 1); assert.equal(r.firstBlockingEvent.classification, 'UNSUPPORTED_OPCODE');
  assert.equal(r.firstBlockingEvent.pcWord, 1); assert.equal(r.firstBlockingEvent.pcByte, 2);
  assert.equal(r.firstBlockingEvent.opcode, 0xffff); assert.equal(r.firstBlockingEvent.mnemonic, 'UNKNOWN');
});
test('shadow stack follows nested real RCALL/RET and preserves outer frame', () => {
  const c = cpu([0xd001, 0xffff, 0xd001, 0xffff, 0x9508]); const r = discover(c);
  assert.equal(r.completedInstructions, 3); assert.equal(r.cycles, 11); assert.equal(c.sp, 0x5ffc);
  assert.deepEqual(r.callStack, [{ callPcWord: 0, entryPcWord: 2, returnPcWord: 1, spBeforeCall: 0x5fff, spAfterCall: 0x5ffc }]);
  assert.deepEqual(r.recentControlFlow.map(e => [e.fromWord, e.toWord]), [[0, 2], [2, 4], [4, 3]]);
});
test('stack bounds, invalid data addresses, disabled EEPROM and flash holes have distinct classes', () => {
  for (const [address, classification] of [[0x6000, 'INVALID_DATA_ADDRESS'], [0x1000, 'UNMAPPED_EEPROM'], [0x4a1, 'UNHANDLED_MMIO']]) {
    const r = discover(cpu([0x9200, address])); assert.equal(r.firstBlockingEvent.classification, classification); assert.equal(r.firstBlockingEvent.memoryAccess.addressByte, address);
  }
  assert.equal(discover(cpu([0x9508])).firstBlockingEvent.classification, 'INVALID_STACK_ACCESS');
  assert.equal(discover(cpu([0xc010])).firstBlockingEvent.classification, 'FLASH_HOLE');
  assert.equal(discover(cpu([0x940f, 0xffff])).firstBlockingEvent.classification, 'FLASH_HOLE');
  assert.equal(discover(cpu([0x941d, 0xffff])).firstBlockingEvent.classification, 'INVALID_CONTROL_FLOW');
});
test('instruction and cycle limits stop deterministically, with no fabricated entry transition', () => {
  const a = discover(cpu([0xcfff]), { maxSteps: 3 }), b = discover(cpu([0xcfff]), { maxSteps: 3 });
  assert.deepEqual(a, b); assert.equal(a.completedInstructions, 3); assert.equal(a.cycles, 6);
  assert.equal(a.lastPcWord, 0); assert.equal(a.firstBlockingEvent.classification, 'EXECUTION_LIMIT');
  const c = discover(cpu([0xcfff]), { maxCycles: 1 }); assert.equal(c.cycles, 2); assert.equal(c.firstBlockingEvent.instructionCompleted, true);
});
test('MMIO registry is explicit, validates hooks, and never aliases CPU register file', () => {
  const c = cpu([0x9200, 0x0000, 0xffff]); c.r[0] = 0x77; let stored = null;
  c.mapMMIO(0, { write: v => { stored = v; } });
  const r = discover(c); assert.equal(stored, 0x77); assert.equal(c.r[0], 0x77); assert.equal(r.mmioInventory[0].completed, true);
  assert.throws(() => c.mapMMIO(0, { read: () => 1 }), /Duplicate/);
  assert.throws(() => c.mapMMIO(0x3f, { read: () => 1 }));
  assert.throws(() => c.mapMMIO(1, {})); assert.throws(() => c.read(0x2000 + 0.5), /Unsupported data read/);
});
test('diagnostic decode is read-only and preserves word/byte units', () => {
  const c = cpu([0, 0x9200, 0x620]); const before = c.state();
  const d = decodeAt(c, 1); assert.equal(d.pcWord, 1); assert.equal(d.pcByte, 2); assert.equal(d.operands.addressByte, 0x620);
  assert.deepEqual(c.state(), before); assert.equal(c.accesses.length, 0);
});
test('harness exceptions propagate instead of being mislabeled a firmware controlled stop', () => {
  assert.throws(() => discover(cpu([0]), { onTrace: () => { throw new Error('disk full'); } }), /disk full/);
  const c = cpu([0]); c.pc = 1; assert.throws(() => discover(c), /reset/);
});
