import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAt } from '../src/discovery.mjs';
import { ExecutionFault, XmegaCPU } from '../src/xmega.mjs';

function imageForRotate() {
  const flash = new Uint8Array(0x42000);
  const present = new Uint8Array(flash.length);
  for (let register = 0; register < 32; register++) {
    const opcode = 0x9407 | (register << 4);
    flash.set([opcode & 255, opcode >>> 8], 2 * register);
  }
  present.fill(1, 0, 64);
  return { flash, present };
}

test('ROR decodes every register and rotates through the incoming carry in one AVRxm clock', () => {
  const cpu = new XmegaCPU(imageForRotate());
  for (let register = 0; register < 32; register++) {
    cpu.pc = register;
    cpu.sreg = 1;
    cpu.r.fill(0x55);
    cpu.r[register] = 0xa6;
    const start = cpu.cycles;
    const decoded = decodeAt(cpu);
    assert.equal(decoded.mnemonic, 'ROR');
    assert.deepEqual(decoded.operands, { register });
    const trace = cpu.step();
    assert.equal(trace.mnemonic, 'ROR');
    assert.equal(cpu.pc, register + 1);
    assert.equal(cpu.cycles, start + 1);
    assert.deepEqual(trace.accesses.map(a => [a.kind, a.addressByte]), [['fetch', 2 * register], ['fetch', 2 * register + 1]]);
    assert.ok(cpu.r.every((byte, i) => byte === (i === register ? 0xd3 : 0x55)));
  }
});

test('ROR produces the nine-bit rotation and all SREG flags for every initial register and status byte', () => {
  const cpu = new XmegaCPU(imageForRotate());
  for (let byte = 0; byte < 256; byte++) {
    for (let initial = 0; initial < 256; initial++) {
      const nineBits = (initial % 2) * 256 + byte;
      const rotated = Math.floor(nineBits / 2) + (nineBits % 2) * 256;
      const result = rotated % 256;
      const carry = rotated >= 256;
      const negative = result >= 128;
      const overflow = negative !== carry;
      const flags = (initial & 0xe0) | (negative !== overflow ? 16 : 0) | (overflow ? 8 : 0) |
        (negative ? 4 : 0) | (result === 0 ? 2 : 0) | (carry ? 1 : 0);
      cpu.pc = 22;
      cpu.r[22] = byte;
      cpu.sreg = initial;
      cpu.step();
      assert.equal(cpu.r[22], result);
      assert.equal(cpu.sreg, flags);
    }
  }
});

test('ROR leaves the CPU untouched on a fall-through outside flash', () => {
  const image = imageForRotate();
  const end = image.flash.length - 2;
  image.flash.set([0x67, 0x95], end);
  image.present.fill(1, end);
  const cpu = new XmegaCPU(image);
  cpu.pc = end / 2;
  cpu.r[22] = 0xa6;
  cpu.sreg = 0x99;
  const before = cpu.state();
  assert.throws(() => cpu.step(), ExecutionFault);
  assert.deepEqual(cpu.state(), before);
});
