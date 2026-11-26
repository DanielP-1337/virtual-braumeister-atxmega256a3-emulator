import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

function fixture() {
  const flash = new Uint8Array(0x42000);
  return new XmegaCPU({ flash, present: new Uint8Array(flash.length) });
}

function encode(destination, source) {
  const d = destination.toString(2).padStart(5, '0');
  const r = source.toString(2).padStart(5, '0');
  return Number.parseInt('001010' + r[0] + d + r.slice(1), 2);
}

function loadWord(cpu, pc, opcode) {
  cpu.flash[2 * pc] = opcode & 0xff;
  cpu.flash[2 * pc + 1] = opcode >>> 8;
  cpu.present.fill(1, 2 * pc, 2 * pc + 2);
}

test('OR decodes and executes all 1024 register pairs in one word and one AVRxm clock', () => {
  const cpu = fixture();
  const initial = Array.from({ length: 32 }, (_, index) => 7 * index);
  for (let destination = 0; destination < 32; destination++) {
    for (let source = 0; source < 32; source++) {
      cpu.pc = 0;
      cpu.r.set(initial);
      const opcode = encode(destination, source);
      loadWord(cpu, 0, opcode);
      const decoded = decodeAt(cpu);
      assert.deepEqual([decoded.mnemonic, decoded.opcodeWords, decoded.operands],
        ['OR', [opcode], { destinationRegister: destination, sourceRegister: source }]);
      const step = cpu.step();
      const expected = initial.slice();
      expected[destination] = initial[destination] | initial[source];
      assert.deepEqual(step.after.registers, expected);
      assert.deepEqual([step.mnemonic, step.after.pcWord, step.after.cycles - step.before.cycles], ['OR', 1, 1]);
      assert.deepEqual(step.accesses.map(access => [access.kind, access.space, access.addressByte]),
        [['fetch', 'flash', 0], ['fetch', 'flash', 1]]);
    }
  }
});

test('OR combines each byte pair and updates Z, N, V and S while preserving I, T, H and C', () => {
  const cpu = fixture();
  loadWord(cpu, 0, encode(3, 25));
  function check(left, right, incoming, expected) {
    cpu.pc = 0;
    cpu.r[3] = left;
    cpu.r[25] = right;
    cpu.sreg = incoming;
    cpu.step();
    assert.equal(cpu.r[3], expected);
    const resultFlags = expected === 0 ? 0x02 : expected >= 128 ? 0x14 : 0;
    assert.equal(cpu.sreg, (incoming & 0xe1) | resultFlags);
  }
  for (let left = 0; left < 256; left++) {
    for (let right = 0; right < 256; right++) {
      let expected = 0;
      for (let bit = 1; bit < 256; bit *= 2) {
        if (left % (2 * bit) >= bit || right % (2 * bit) >= bit) expected += bit;
      }
      check(left, right, (left + right) % 256, expected);
    }
  }
  for (let incoming = 0; incoming < 256; incoming++) {
    check(0, 0, incoming, 0);
    check(1, 2, incoming, 3);
    check(0x80, 1, incoming, 0x81);
  }
});

test('OR with an out-of-range fall-through faults before writing registers or SREG', () => {
  const cpu = fixture();
  cpu.pc = cpu.flash.length / 2 - 1;
  loadWord(cpu, cpu.pc, encode(5, 23));
  cpu.r[5] = 4;
  cpu.r[23] = 0x80;
  cpu.sreg = 0xff;
  const before = cpu.state();
  assert.throws(() => cpu.step(), /PC target outside device/);
  assert.deepEqual(cpu.state(), before);
  assert.equal(cpu.steps, 0);
});
