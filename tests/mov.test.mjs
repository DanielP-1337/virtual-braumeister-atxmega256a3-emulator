import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { ExecutionFault, instructionWords, XmegaCPU } from '../src/xmega.mjs';

function machine() {
  return new XmegaCPU({ flash: new Uint8Array(0x42000), present: new Uint8Array(0x42000) });
}

function place(cpu, pc, word) {
  cpu.flash.set([word % 256, Math.floor(word / 256)], 2 * pc);
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
}

// Assemble from the published bit-field string instead of reversing the CPU decoder.
function encode(destination, source) {
  const d = destination.toString(2).padStart(5, '0');
  const r = source.toString(2).padStart(5, '0');
  return parseInt('001011' + r[0] + d + r.slice(1), 2);
}

test('MOV decodes all 1,024 register pairs as one-word register copies', () => {
  const cpu = machine();
  for (const [d, r, word] of [[0, 0, 0x2c00], [16, 15, 0x2d0f], [0, 31, 0x2e0f],
    [18, 22, 0x2f26], [31, 31, 0x2fff]]) assert.equal(encode(d, r), word);
  const seen = new Set();
  for (let d = 0; d < 32; d++) {
    for (let r = 0; r < 32; r++) {
      const word = encode(d, r);
      place(cpu, 0, word);
      assert.equal(instructionWords(word), 1);
      const decoded = decodeAt(cpu);
      assert.equal(decoded.mnemonic, 'MOV');
      assert.deepEqual(decoded.operands, { destinationRegister: d, sourceRegister: r });
      assert.deepEqual(decoded.opcodeWords, [word]);
      seen.add(word);
    }
  }
  assert.equal(seen.size, 1024);
  assert.deepEqual(cpu.accesses, []);
});

test('MOV preserves all SREG bits and every other register for all pairs in one AVRxm cycle', () => {
  const cpu = machine();
  for (let d = 0; d < 32; d++) {
    for (let r = 0; r < 32; r++) place(cpu, d * 32 + r, encode(d, r));
  }
  cpu.sp = 0x4231;
  cpu.rampz = 3;
  cpu.eind = 1;
  for (let flags = 0; flags < 256; flags++) {
    // Distinct bytes expose wrong-register writes. Each source ranges over all byte values.
    const initial = Uint8Array.from({ length: 32 }, (_, reg) => (flags + reg * 149) % 256);
    const expected = initial.slice();
    cpu.pc = 0;
    for (let d = 0; d < 32; d++) {
      for (let r = 0; r < 32; r++) {
        cpu.r.set(initial);
        cpu.sreg = flags;
        expected[d] = initial[r];
        const event = cpu.step();
        assert.deepEqual(cpu.r, expected);
        assert.equal(cpu.sreg, flags);
        assert.equal(cpu.pc, d * 32 + r + 1);
        assert.equal(event.after.cycles - event.before.cycles, 1);
        expected[d] = initial[d];
      }
    }
  }
  assert.equal(cpu.steps, 262144);
  assert.equal(cpu.cycles, cpu.steps);
  assert.deepEqual([cpu.sp, cpu.rampz, cpu.eind], [0x4231, 3, 1]);
});

test('MOV replays register dependencies across a word-PC bank boundary using only flash fetches', () => {
  function run() {
    const cpu = machine();
    cpu.pc = 0xfffe;
    cpu.sreg = 0xd7;
    cpu.r[1] = 0xab;
    cpu.r[31] = 0x12;
    for (const [i, [d, r]] of [[0, 1], [1, 31], [31, 0], [31, 31]].entries()) {
      place(cpu, cpu.pc + i, encode(d, r));
    }
    return Array.from({ length: 4 }, () => cpu.step());
  }
  const events = run();
  assert.deepEqual(events, run());
  assert.deepEqual(events.map(e => e.after.pcWord), [0xffff, 0x10000, 0x10001, 0x10002]);
  assert.deepEqual(events.map(e => [e.after.registers[0], e.after.registers[1], e.after.registers[31]]),
    [[0xab, 0xab, 0x12], [0xab, 0x12, 0x12], [0xab, 0x12, 0xab], [0xab, 0x12, 0xab]]);
  for (const event of events) {
    const start = event.before.pcWord * 2;
    assert.deepEqual(event.accesses.map(a => [a.kind, a.space, a.addressByte]),
      [['fetch', 'flash', start], ['fetch', 'flash', start + 1]]);
  }
});

test('MOV faults before changing state on a missing byte or out-of-device fall-through', () => {
  const cpu = machine();
  cpu.r[31] = 0xfe;
  cpu.sreg = 0xff;
  function checkFault(reason) {
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e instanceof ExecutionFault && reason.test(e.message) &&
      e.trace.instructionCompleted === false);
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
  for (const missing of [0, 1]) {
    place(cpu, 0, encode(0, 31));
    cpu.present[missing] = 0;
    checkFault(/HEX hole/);
  }
  cpu.pc = cpu.flash.length / 2 - 1;
  place(cpu, cpu.pc, encode(0, 31));
  checkFault(/PC target outside device/);
});
