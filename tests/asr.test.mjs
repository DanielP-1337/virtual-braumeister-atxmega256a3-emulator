import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { ExecutionFault, XmegaCPU } from '../src/xmega.mjs';

function imageWithAsr() {
  const flash = new Uint8Array(0x42000);
  const present = new Uint8Array(flash.length);
  for (let register = 0; register < 32; register++) {
    const opcode = 0x9405 | (register << 4);
    flash[2 * register] = opcode & 0xff;
    flash[2 * register + 1] = opcode >>> 8;
    present.fill(1, 2 * register, 2 * register + 2);
  }
  return { flash, present };
}

test('ASR decodes all 32 registers and uses one AVRxm clock without accessing data memory', () => {
  const cpu = new XmegaCPU(imageWithAsr());
  for (let register = 0; register < 32; register++) {
    cpu.pc = register;
    cpu.r.fill(0x55);
    cpu.r[register] = 0x81;
    cpu.sreg = 0x20;
    const decoded = decodeAt(cpu);
    assert.equal(decoded.mnemonic, 'ASR');
    assert.deepEqual(decoded.operands, { register });
    const before = cpu.cycles;
    const trace = cpu.step();
    assert.equal(trace.mnemonic, 'ASR');
    assert.equal(cpu.pc, register + 1);
    assert.equal(cpu.cycles - before, 1);
    assert.deepEqual(trace.accesses.map(a => [a.kind, a.addressByte]), [['fetch', 2 * register], ['fetch', 2 * register + 1]]);
    assert.ok(cpu.r.every((value, i) => value === (i === register ? 0xc0 : 0x55)));
  }
});

test('ASR matches signed division and all status flags for every byte and incoming SREG', () => {
  const cpu = new XmegaCPU(imageWithAsr());
  for (let byte = 0; byte < 256; byte++) {
    const signed = byte >= 128 ? byte - 256 : byte;
    const shifted = Math.floor(signed / 2) & 0xff;
    const carry = byte % 2 !== 0;
    const negative = shifted >= 128;
    const overflow = negative !== carry;
    const lowFlags = (negative !== overflow ? 16 : 0) | (overflow ? 8 : 0) | (negative ? 4 : 0) |
      (shifted === 0 ? 2 : 0) | (carry ? 1 : 0);
    for (let initial = 0; initial < 256; initial++) {
      cpu.pc = 23;
      cpu.r[23] = byte;
      cpu.sreg = initial;
      cpu.step();
      assert.equal(cpu.r[23], shifted);
      assert.equal(cpu.sreg, (initial & 0xe0) | lowFlags);
    }
  }
});

test('ASR preserves registers and flags when fall-through is outside the device', () => {
  const image = imageWithAsr();
  const end = image.flash.length - 2;
  image.flash.set([0x75, 0x95], end);
  image.present.fill(1, end);
  const cpu = new XmegaCPU(image);
  cpu.pc = end / 2;
  cpu.r[23] = 0x11;
  cpu.sreg = 0x82;
  const before = cpu.state();
  assert.throws(() => cpu.step(), ExecutionFault);
  assert.deepEqual(cpu.state(), before);
});
