import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionFault, XmegaCPU } from '../src/xmega.mjs';

// XMEGA A manual 3.14.9 and the AVRxm timing table. Words below are fixed
// AVR encodings, independent of the interpreter's address and register decoders.
const sreg = 0x003f;
const writes = [
  { words: [0xbf0f], name: 'OUT', baseCycles: 1 },
  { words: [0x9300, sreg], name: 'STS', baseCycles: 2 },
  { words: [0x930c], name: 'ST X', pair: 26, baseCycles: 1 },
  { words: [0x930d], name: 'ST X+', pair: 26, baseCycles: 1 },
  { words: [0x8308], name: 'ST', pair: 28, baseCycles: 1 },
  { words: [0x8300], name: 'ST', pair: 30, baseCycles: 1 },
  { words: [0x830f], name: 'STD', pair: 28, displacement: 7, baseCycles: 2 },
  { words: [0x8307], name: 'STD', pair: 30, displacement: 7, baseCycles: 2 },
];

function cpuWith(words, startWord = 0) {
  const flash = new Uint8Array(0x42000);
  const present = new Uint8Array(flash.length);
  let index = startWord * 2;
  for (const word of words) {
    flash[index++] = word & 0xff;
    flash[index++] = word >>> 8;
  }
  present.fill(1, startWord * 2, index);
  const cpu = new XmegaCPU({ flash, present });
  cpu.pc = startWord;
  return cpu;
}

test('writes through every supported SREG store wait only for an actual I-bit transition', () => {
  // Cross both I values and vary all seven lower flags independently of that bit.
  const patterns = [
    [0x00, 0x7f, 0], [0xff, 0x80, 0], [0xa1, 0xa1, 0], [0x0b, 0x0b, 0],
    [0x00, 0x80, 1], [0x80, 0x00, 1], [0xa1, 0x0b, 1], [0x0b, 0xa1, 1],
  ];
  for (const { words, name, pair, displacement = 0, baseCycles } of writes) {
    for (const [before, value, wait] of patterns) {
      const cpu = cpuWith(words);
      cpu.sreg = before;
      cpu.r[16] = value;
      if (pair !== undefined) cpu.setPair(pair, sreg - displacement);
      const trace = cpu.step();
      assert.equal(trace.mnemonic, name);
      assert.equal(trace.after.pcWord, words.length);
      assert.equal(trace.after.cycles - trace.before.cycles, baseCycles + wait);
      assert.equal(cpu.steps, 1);
      assert.equal(cpu.sreg, value);
      assert.equal(cpu.r[16], value);
      if (pair !== undefined) {
        assert.equal(cpu.pair(pair), sreg - displacement + Number(name === 'ST X+'));
      }
      assert.deepEqual(trace.accesses.filter(access => access.kind === 'write'), [
        { kind: 'write', space: 'cpu-io', addressByte: sreg, value, ...(wait ? { waitCycles: 1 } : {}) },
      ]);
    }
  }
});

test('SREG reads, register arithmetic and unrelated writes retain their timing', () => {
  // OUT SREG,r16; IN r17,SREG; EOR r16,r16; OUT 0,r16; STS 0x2000,r16.
  const cpu = cpuWith([0xbf0f, 0xb71f, 0x2700, 0xb900, 0x9300, 0x2000]);
  let mmioWrite;
  cpu.mapMMIO(0, { write(value, cycle) { mmioWrite = { value, cycle }; } });
  cpu.r[16] = 0x80;
  for (const expected of [2, 3, 4, 5, 7]) assert.equal(cpu.step().after.cycles, expected);
  assert.equal(cpu.r[17], 0x80);
  assert.equal(cpu.sreg, 0x82);
  assert.deepEqual(mmioWrite, { value: 0, cycle: 5 });
  assert.equal(cpu.sram[0], 0);
  assert.equal(cpu.steps, 5);
});

test('invalid SREG store fall-through, missing address and rejected MMIO retire no wait', () => {
  const lastWord = 0x42000 / 2 - 1;
  for (const [words, pc, error] of [
    [[0xbf0f], lastWord, /outside device/],
    [[0x9300, sreg], lastWord - 1, /outside device/],
    [[0x9300], 0, /HEX hole/],
    [[0x9300, 0x0400], 0, /Unsupported data write/],
  ]) {
    const cpu = cpuWith(words, pc);
    cpu.r[16] = 0x80;
    const before = cpu.state();
    assert.throws(() => cpu.step(), fault => {
      assert.ok(fault instanceof ExecutionFault);
      assert.match(fault.message, error);
      assert.equal(fault.trace.instructionCompleted, false);
      assert.equal(fault.trace.accesses.some(access => access.kind === 'write'), false);
      return true;
    });
    assert.deepEqual(cpu.state(), before);
    assert.equal(cpu.steps, 0);
  }
});
