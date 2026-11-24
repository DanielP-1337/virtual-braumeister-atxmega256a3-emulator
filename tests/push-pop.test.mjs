import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU, ExecutionFault, instructionWords } from '../src/xmega.mjs';
import { decodeAt, discover } from '../src/discovery.mjs';

function program(words, startWord = 0) {
  const flash = new Uint8Array(0x42000).fill(0xff);
  const present = new Uint8Array(flash.length);
  let byte = startWord * 2;
  for (const word of words) {
    flash[byte++] = word & 255;
    flash[byte++] = word >>> 8;
  }
  present.fill(1, startWord * 2, byte);
  return new XmegaCPU({ flash, present });
}

// Encode the two published bit strings independently of the interpreter.
function opcode(operation, reg) {
  const field = reg.toString(2).padStart(5, '0');
  return parseInt((operation === 'PUSH' ? '1001001' : '1001000') + field + '1111', 2);
}
function dataAccess(trace) {
  assert.equal(trace.accesses.length, 3);
  const [first, second, access] = trace.accesses;
  assert.deepEqual([first.kind, first.space, first.addressByte], ['fetch', 'flash', trace.before.pcWord * 2]);
  assert.deepEqual([second.kind, second.space, second.addressByte], ['fetch', 'flash', trace.before.pcWord * 2 + 1]);
  return [access.kind, access.space, access.addressByte, access.value];
}

test('Stack decodes each PUSH and POP register as a single word', () => {
  const cpu = program(Array(64).fill(0));
  cpu.sp = 0x4201;
  for (let reg = 0; reg < 32; reg++) {
    cpu.r[reg] = 73 + reg;
    for (const [half, name] of ['PUSH', 'POP'].entries()) {
      const pc = half * 32 + reg, word = opcode(name, reg);
      cpu.flash.set([word & 255, word >>> 8], pc * 2);
      const decoded = decodeAt(cpu, pc);
      assert.equal(instructionWords(word), 1);
      assert.deepEqual(decoded.opcodeWords, [word]);
      assert.equal(decoded.mnemonic, name);
      assert.deepEqual(decoded.operands, name === 'PUSH' ? { register: reg, addressByte: 0x4201, value: 73 + reg }
        : { register: reg, addressByte: 0x4202 });
    }
  }
  assert.deepEqual([opcode('PUSH', 0), opcode('PUSH', 31), opcode('POP', 0), opcode('POP', 31)],
    [0x920f, 0x93ff, 0x900f, 0x91ff]);
});

test('Stack PUSH writes the old SP in one AVRxm clock for all registers, bytes and SREG values', () => {
  for (let reg = 0; reg < 32; reg++) {
    const cpu = program(Array(256).fill(opcode('PUSH', reg)));
    cpu.r.set(Array.from({ length: 32 }, (_, i) => i * 7));
    cpu.sp = 0x4100;
    for (let n = 0; n < 256; n++) {
      const address = 0x4100 - n, flags = 255 - n;
      cpu.r[reg] = n; cpu.sreg = flags;
      const t = cpu.step();
      assert.equal(t.mnemonic, 'PUSH');
      assert.deepEqual(dataAccess(t), ['write', 'sram', address, n]);
      assert.equal(cpu.sram[address - 0x2000], n);
      assert.deepEqual([cpu.sp, cpu.pc, cpu.cycles, cpu.steps, cpu.sreg], [address - 1, n + 1, n + 1, n + 1, flags]);
      assert.deepEqual(t.after.registers, t.before.registers);
    }
    assert.equal(cpu.sram[0x4000 - 0x2000], 0xa5);
    assert.equal(cpu.sram[0x4101 - 0x2000], 0xa5);
  }
});

test('Stack POP reads old SP plus one in two AVRxm clocks for all registers, bytes and SREG values', () => {
  for (let reg = 0; reg < 32; reg++) {
    const cpu = program(Array(256).fill(opcode('POP', reg)));
    cpu.sp = 0x40fe;
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i ^ 0x76);
    const expected = Array.from({ length: 32 }, (_, i) => i + 19);
    cpu.sram.set(bytes, 0x40ff - 0x2000);
    cpu.r.set(expected);
    for (let n = 0; n < 256; n++) {
      const address = 0x40ff + n, value = bytes[n];
      expected[reg] = value;
      cpu.sreg = n;
      const t = cpu.step();
      assert.equal(t.mnemonic, 'POP');
      assert.deepEqual(dataAccess(t), ['read', 'sram', address, value]);
      assert.deepEqual(t.after.registers, expected);
      assert.deepEqual([cpu.sp, cpu.pc, cpu.cycles, cpu.steps, cpu.sreg], [address, n + 1, 2 * (n + 1), n + 1, n]);
    }
    assert.deepEqual(cpu.sram.slice(0x20ff, 0x21ff), bytes);
  }
});

test('Stack restores distinct bytes in reverse order across a low-byte rollover', () => {
  // PUSH r0, r15, r16, r31, then POP into four different registers.
  const words = [0x920f, 0x92ff, 0x930f, 0x93ff, 0x903f, 0x905f, 0x907f, 0x909f];
  const run = () => {
    const c = program(words);
    c.sp = 0x3201; c.sreg = 0x97;
    [c.r[0], c.r[15], c.r[16], c.r[31]] = [0, 0xff, 0x7a, 0xe3];
    const trace = words.map(() => c.step());
    assert.deepEqual(trace.map(t => t.after.sp), [0x3200, 0x31ff, 0x31fe, 0x31fd, 0x31fe, 0x31ff, 0x3200, 0x3201]);
    assert.deepEqual(Array.from(c.sram.slice(0x11fd, 0x1203)), [0xa5, 0xe3, 0x7a, 0xff, 0, 0xa5]);
    assert.deepEqual([c.r[3], c.r[5], c.r[7], c.r[9]], [0xe3, 0x7a, 0xff, 0]);
    assert.deepEqual([c.cycles, c.sreg], [12, 0x97]);
    return trace;
  };
  assert.deepEqual(run(), run());
});

test('Stack accepts both endpoint bytes of A3 SRAM including a POP from SP one below SRAM', () => {
  for (const address of [0x2000, 0x5fff]) {
    const c = program([0x932f, 0x902f]);
    c.sp = address; c.r[18] = 0x8a;
    assert.deepEqual(dataAccess(c.step()), ['write', 'sram', address, 0x8a]);
    assert.equal(c.sp, address - 1);
    assert.deepEqual(dataAccess(c.step()), ['read', 'sram', address, 0x8a]);
    assert.deepEqual([c.r[2], c.sp, c.cycles], [0x8a, address, 3]);
  }
});

test('Stack faults atomically on invalid SRAM addresses without calling an I/O handler', () => {
  for (const name of ['PUSH', 'POP']) {
    for (const sp of [0x003e, 0x003f, 0x1000, 0x1ffe, 0x6000, 0xffff, name === 'PUSH' ? 0x1fff : 0x5fff]) {
      const c = program([opcode(name, 7)]);
      c.sp = sp; c.sreg = 0x63; c.r[7] = 0xca;
      c.mapMMIO(0x0040, { read: () => assert.fail('Unexpected MMIO read'), write: () => assert.fail('Unexpected MMIO write') });
      const before = c.state(), ram = c.sram.slice();
      const diag = discover(c);
      const f = diag.firstBlockingEvent, push = name === 'PUSH';
      assert.equal(f.classification, 'INVALID_STACK_ACCESS');
      assert.deepEqual([f.pcWord, f.opcode, f.mnemonic, f.operands.register], [0, opcode(name, 7), name, 7]);
      assert.deepEqual(f.memoryAccess, { addressByte: push ? sp : sp + 1, kind: push ? 'write' : 'read', attemptedValue: push ? 0xca : null });
      assert.deepEqual([diag.completedInstructions, diag.attemptedInstructions, diag.cycles], [0, 1, 0]);
      assert.deepEqual(diag.mmioInventory, []);
      assert.deepEqual(c.state(), before);
      assert.deepEqual(c.sram, ram);
    }
  }
});

test('Stack rejects truncated fetches and invalid fall-through before changing SP, registers or SRAM', () => {
  for (const name of ['PUSH', 'POP']) {
    for (const missingByte of [0, 1, null]) {
      const pc = missingByte === null ? 0x20fff : 0;
      const c = program([opcode(name, 31)], pc);
      c.pc = pc; c.sp = 0x4000; c.r[31] = 0xda; c.sreg = 0xef;
      if (missingByte !== null) c.present[missingByte] = 0;
      const before = c.state(), ram = c.sram.slice();
      assert.throws(() => c.step(), e => e instanceof ExecutionFault && e.trace.instructionCompleted === false &&
        e.trace.accesses.every(a => a.kind === 'fetch') &&
        (missingByte === null ? /PC target/.test(e.message) : e.classification === 'FLASH_HOLE'));
      assert.deepEqual(c.state(), before); assert.deepEqual(c.sram, ram); assert.equal(c.steps, 0);
    }
  }
});
