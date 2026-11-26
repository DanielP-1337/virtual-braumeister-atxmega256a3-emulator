import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { discover } from '../src/discovery.mjs';
import { NVMController } from '../src/peripherals/nvm.mjs';

const cmd = 0x01ca;
function fixture(words, productionSignature = new Map()) {
  const flash = new Uint8Array(0x42000).fill(0xff);
  const present = new Uint8Array(flash.length);
  words.forEach((word, index) => {
    flash[2 * index] = word & 255;
    flash[2 * index + 1] = word >>> 8;
  });
  present.fill(1, 0, 2 * words.length);
  flash[0x20] = 0x64;
  present[0x20] = 1;
  const cpu = new XmegaCPU({ flash, present });
  const accesses = [], transitions = [];
  const nvm = new NVMController({ productionSignature, onAccess: e => accesses.push(e), onTransition: e => transitions.push(e) });
  nvm.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details), clock: () => cpu.cycles });
  cpu.setPair(30, 0x20);
  return { cpu, nvm, accesses, transitions };
}

test('READ_CALIB_ROW selects a separate LPM source while instruction fetch still uses flash', () => {
  // STS NVM.CMD,R16 / LPM R19,Z+ / LPM R0,Z / STS NVM.CMD,R1 / LPM R17,Z
  const input = new Map([[0x20, 0xa5], [0x21, 0]]);
  const { cpu, nvm, accesses, transitions } = fixture([0x9300, cmd, 0x9135, 0x95c8, 0x9210, cmd, 0x9114], input);
  input.set(0x20, 0x55);
  cpu.r[16] = 2;
  cpu.rampz = 1;
  const select = cpu.step(), first = cpu.step(), second = cpu.step();
  assert.deepEqual([select.mnemonic, select.after.cycles, first.after.cycles, second.after.cycles], ['STS', 2, 5, 8]);
  assert.deepEqual([cpu.r[19], cpu.r[0], cpu.pair(30), cpu.rampz], [0xa5, 0, 0x21, 1]);
  assert.deepEqual(first.accesses.slice(0, 2).map(a => [a.kind, a.space, a.addressByte]), [['fetch', 'flash', 4], ['fetch', 'flash', 5]]);
  assert.deepEqual([first.accesses.at(-1), second.accesses.at(-1)], [
    { kind: 'read', space: 'production-signature', addressByte: 0x20, value: 0xa5 },
    { kind: 'read', space: 'production-signature', addressByte: 0x21, value: 0 },
  ]);
  assert.equal(nvm.productionSignatureKnownBytes, 2);
  assert.equal(cpu.read(cmd), 2);
  cpu.step();
  cpu.setPair(30, 0x20);
  assert.equal(cpu.step().accesses.at(-1).space, 'flash');
  assert.equal(cpu.r[17], 0x64);
  assert.deepEqual(accesses.filter(e => e.kind === 'write').map(e => [e.value, e.ignored]), [[2, false], [0, false]]);
  assert.equal(nvm.activity.status, 0);
  assert.deepEqual(transitions, []);
});

test('READ_CALIB_ROW reports missing bytes without retiring LPM or recording an MMIO access', () => {
  for (const [opcode, register, increment] of [[0x91e4, 30, false], [0x9125, 18, true]]) {
    const { cpu, nvm } = fixture([opcode], new Map([[0x21, 0x6b]]));
    cpu.write(cmd, 2);
    cpu.r[18] = 0x6c;
    cpu.sreg = 0xa4;
    const before = cpu.state(), trace = [];
    const r = discover(cpu, { onTrace: e => trace.push(e) });
    const f = r.firstBlockingEvent;
    assert.deepEqual([f.mnemonic, f.classification, f.instructionCompleted], ['LPM', 'UNKNOWN_PRODUCTION_SIGNATURE_BYTE', false]);
    assert.deepEqual(f.operands, { register, pointer: 'Z', postIncrement: increment, addressByte: 0x20 });
    assert.deepEqual(f.memoryAccess, { kind: 'read', space: 'production-signature', addressByte: 0x20, attemptedValue: null });
    assert.deepEqual([r.completedInstructions, r.attemptedInstructions, r.cycles], [0, 1, 0]);
    assert.deepEqual([f.stateBefore, f.stateAtStop], [before, before]);
    assert.ok(trace[0].accesses.every(a => a.kind === 'fetch' && a.space === 'flash'));
    assert.deepEqual(r.mmioInventory, []);
    assert.equal(nvm.registers[10], 2);
  }
});

test('READ_CALIB_ROW supports Z as destination and preserves supplied factory bytes across NVM reset', () => {
  const { cpu, nvm } = fixture([0x91e4, 0x91e4, 0x91e4], new Map([[0x20, 0xff]]));
  cpu.write(cmd, 2);
  assert.equal(cpu.step().accesses.at(-1).addressByte, 0x20);
  assert.equal(cpu.r[30], 0xff);
  nvm.reset();
  cpu.setPair(30, 0x20);
  assert.equal(cpu.step().accesses.at(-1).space, 'flash');
  assert.equal(cpu.r[30], 0x64);
  cpu.write(cmd, 2);
  cpu.setPair(30, 0x20);
  assert.equal(cpu.step().accesses.at(-1).value, 0xff);
});

test('READ_CALIB_ROW keeps unsupported triggers and addresses explicit and validates supplied byte values', () => {
  for (const input of [{}, new Map([[-1, 0]]), new Map([[0x34, 0]]), new Map([[0x20, 256]])]) {
    assert.throws(() => new NVMController({ productionSignature: input }));
  }
  const { cpu } = fixture([0x9126], new Map([[0x20, 0x8b]]));
  cpu.write(cmd, 2);
  assert.throws(() => cpu.write(0x01cb, 1), e => e.classification === 'NVM_COMMAND_EXECUTION_UNSUPPORTED');
  assert.throws(() => cpu.step(), e => e.classification === 'NVM_COMMAND_TRIGGER_UNSUPPORTED' && e.accessSpace === 'production-signature');
  assert.equal(cpu.steps, 0);
  const boundary = fixture([0x9004]);
  boundary.cpu.write(cmd, 2);
  boundary.cpu.setPair(30, 0x34);
  assert.throws(() => boundary.cpu.step(), e => e.classification === 'NVM_PRODUCTION_SIGNATURE_ADDRESS_UNSUPPORTED');
});
