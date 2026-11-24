import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU, ExecutionFault } from '../src/xmega.mjs';
import { parseHex, FLASH_SIZE } from '../src/hex.mjs';

// Hand-encoded synthetic programs; no firmware, Ghidra output, or CPU decoder reuse.
function cpu(words, at = 0) {
  const image = { flash: new Uint8Array(FLASH_SIZE).fill(255), present: new Uint8Array(FLASH_SIZE) };
  words.forEach((w, i) => { image.flash[(at + i) * 2] = w & 255; image.flash[(at + i) * 2 + 1] = w >>> 8; image.present.fill(1, (at + i) * 2, (at + i) * 2 + 2); });
  const c = new XmegaCPU(image); c.pc = at; return c;
}
function opcode(c, op) { c.pc = 0; c.flash[0] = op & 255; c.flash[1] = op >>> 8; c.present.fill(1, 0, 2); }
function record(type, address, data) {
  const a = [data.length, address >>> 8, address & 255, type, ...data];
  a.push((-a.reduce((s, n) => s + n, 0)) & 255);
  return ':' + a.map(n => n.toString(16).padStart(2, '0')).join('');
}
const eof = record(1, 0, []);
test('HEX: segment/linear addressing, sparse erased data, start metadata cannot redirect reset', () => {
  const image = parseHex([record(0, 0, [0, 0]), record(2, 0, [0x10, 0]), record(0, 1, [0x12]), record(4, 0, [0, 3]), record(0, 2, [0x34]), record(5, 0, [0, 1, 2, 3]), eof].join('\n'));
  assert.equal(image.flash[0x10001], 0x12); assert.equal(image.flash[0x30002], 0x34);
  assert.equal(image.flash[0x10002], 255); assert.equal(image.present[0x10002], 0);
  assert.equal(new XmegaCPU(image).pc, 0); assert.equal(image.count, 4);
});
test('HEX rejects corruption, overlap, bounds, malformed records, missing/trailing EOF', () => {
  const good = record(0, 0, [1, 2]);
  for (const text of [good.slice(0, -2) + '00\n' + eof, ':xyz\n' + eof, good, good + '\n' + good + '\n' + eof, eof + '\n' + good, record(4, 0, [0, 5]) + '\n' + good + '\n' + eof, record(0, 65535, [1, 2]) + '\n' + eof, record(7, 0, []) + '\n' + eof, record(1, 1, [])]) assert.throws(() => parseHex(text));
});
test('reset and XMEGA memory geometry, separate register file, disabled EEPROM mapping', () => {
  const c = cpu([0]); assert.equal(c.pc, 0); assert.equal(c.sp, 0x5fff);
  assert.equal(c.sram.length, 16384); assert.equal(c.eeprom.length, 4096);
  c.r[0] = 0x91; let io = 0x42; c.mapMMIO(0, { read: () => io, write: v => { io = v; } });
  assert.equal(c.read(0), 0x42); c.write(0, 0x33); assert.equal(c.r[0], 0x91);
  assert.throws(() => c.read(0x1000), /unmapped EEPROM/); assert.throws(() => c.write(0x6000, 1));
});
test('IN/OUT use actual XMEGA IO addresses; direct LDS/STS agree', () => {
  const c = cpu([0xe50a, 0xbf0f, 0xb71f, 0x9220, 0x003f, 0x9030, 0x003f]); // LDI r16,5a; OUT 3f,r16; IN r17,3f
  c.r[2] = 0xa6; c.step(); c.step(); assert.equal(c.sreg, 0x5a);
  c.step(); assert.equal(c.r[17], 0x5a); c.step(); c.step(); assert.equal(c.r[3], 0xa6);
});
test('EOR exhaustively preserves I/T/H/C and sets Z/N/V/S correctly', () => {
  const c = cpu([0x2423]); // EOR r2,r3
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    c.pc = 0; c.r[2] = a; c.r[3] = b; c.sreg = 0xff; c.step();
    const r = a ^ b; assert.equal(c.r[2], r); assert.equal(c.sreg, 0xe1 | (r === 0 ? 2 : 0) | (r >= 128 ? 0x14 : 0));
  }
});
// Independent oracle uses the manual's Boolean bit equations, not the CPU's arithmetic borrow tests.
function subtractionFlags(a, b, carry, oldZ, chain) {
  const r = (a - b - carry) & 255;
  const borrow = ((~a & b) | (b & r) | (r & ~a));
  const overflow = ((a & ~b & ~r) | (~a & b & r));
  const n = (r >>> 7) & 1, v = (overflow >>> 7) & 1;
  return 0xc0 | ((borrow >>> 7) & 1) | ((r === 0 && (!chain || oldZ) ? 1 : 0) << 1) | (n << 2) | (v << 3) | ((n ^ v) << 4) | (((borrow >>> 3) & 1) << 5);
}
test('CPI: all 65536 operand pairs, flags and unchanged operand', () => {
  const c = cpu([0]);
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    opcode(c, 0x3000 | ((b & 240) << 4) | (b & 15)); c.r[16] = a; c.sreg = 0xff; c.step();
    assert.equal(c.r[16], a); assert.equal(c.sreg, subtractionFlags(a, b, 0, true, false));
  }
});
test('CPC: all 262144 operand/carry/previous-Z combinations', () => {
  const c = cpu([0x0423]);
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) for (let flags = 0; flags < 4; flags++) {
    c.pc = 0; c.r[2] = a; c.r[3] = b; c.sreg = 0xc0 | flags; c.step();
    assert.equal(c.r[2], a); assert.equal(c.sreg, subtractionFlags(a, b, flags & 1, flags & 2, true));
  }
});
test('signed branches, taken/not-taken timing, RJMP positive/negative offsets', () => {
  const c = cpu([0xf409]); c.sreg = 0; c.step(); assert.equal(c.pc, 2); assert.equal(c.cycles, 2);
  c.pc = 0; c.sreg = 2; c.step(); assert.equal(c.pc, 1); assert.equal(c.cycles, 3);
  opcode(c, 0xf3f9); c.step(); assert.equal(c.pc, 0); // BREQ -1
  opcode(c, 0xc002); c.step(); assert.equal(c.pc, 3);
  c.flash[6] = 0xfd; c.flash[7] = 0xcf; c.present.fill(1, 6, 8); c.step(); assert.equal(c.pc, 1);
});
test('JMP and CALL decode high word address; three-byte stack order and RET', () => {
  const c = cpu([0x940f, 0x0010]); // CALL word 10010
  c.flash[0x20020] = 0x08; c.flash[0x20021] = 0x95; c.present.fill(1, 0x20020, 0x20022);
  c.step(); assert.equal(c.pc, 0x10010); assert.equal(c.sp, 0x5ffc); assert.equal(c.cycles, 4);
  assert.deepEqual(Array.from(c.sram.slice(-3)), [0, 0, 2]); c.step(); assert.equal(c.pc, 2); assert.equal(c.sp, 0x5fff); assert.equal(c.cycles, 9);
  opcode(c, 0x940d); c.step(); assert.equal(c.pc, 0x10010);
});
test('RCALL above 64K words preserves high return byte and takes three AVRxm cycles', () => {
  const c = cpu([0xd001, 0, 0x9508], 0x10020);
  c.step(); assert.equal(c.pc, 0x10022); assert.equal(c.cycles, 3);
  assert.deepEqual(Array.from(c.sram.slice(-3)), [1, 0, 0x21]); c.step(); assert.equal(c.pc, 0x10021); assert.equal(c.sp, 0x5fff);
});
test('EIND drives EIJMP/EICALL; RET restores high return address', () => {
  const c = cpu([0x9519], 0x10000); c.eind = 2; c.setPair(30, 0x10);
  c.flash[0x40020] = 8; c.flash[0x40021] = 0x95; c.present.fill(1, 0x40020, 0x40022);
  c.step(); assert.equal(c.pc, 0x20010); c.step(); assert.equal(c.pc, 0x10001);
  opcode(c, 0x9419); c.step(); assert.equal(c.pc, 0x20010);
});
test('RAMPZ/EIND IO masks and explicit stack initialization writes', () => {
  const c = cpu([0]); c.write(0x3b, 255); c.write(0x3c, 255); assert.equal(c.read(0x3b), 7); assert.equal(c.read(0x3c), 3);
  c.write(0x3d, 0x10); c.write(0x3e, 0x40); assert.equal(c.sp, 0x4010);
});
test('ELPM reads byte addresses across 64 KiB boundary and carries into RAMPZ', () => {
  const c = cpu([0x9007, 0x9017]); c.rampz = 1; c.setPair(30, 0xffff);
  c.flash[0x1ffff] = 0x52; c.flash[0x20000] = 0xa7;
  c.step(); assert.equal(c.r[0], 0x52); assert.equal(c.pair(30), 0); assert.equal(c.rampz, 2);
  c.step(); assert.equal(c.r[1], 0xa7); assert.equal(c.pair(30), 1); assert.equal(c.cycles, 6);
});
test('LPM ignores RAMPZ; explicit and implied LPM/ELPM preserve flags', () => {
  const c = cpu([0x9025, 0x95c8, 0x95d8, 0x9036]); c.setPair(30, 0x100); c.rampz = 1; c.sreg = 0xa5;
  c.flash[0x100] = 0x11; c.flash[0x101] = 0x22; c.flash[0x10101] = 0x33;
  c.step(); assert.equal(c.r[2], 0x11); c.step(); assert.equal(c.r[0], 0x22);
  c.step(); assert.equal(c.r[0], 0x33); c.step(); assert.equal(c.r[3], 0x33); assert.equal(c.sreg, 0xa5);
});
test('ST X+ increments SRAM byte pointer, preserves SREG, takes one AVRxm cycle', () => {
  const c = cpu([0x924d]); c.setPair(26, 0x20ff); c.r[4] = 0x7c; c.sreg = 0xa5;
  const trace = c.step(); assert.equal(c.sram[255], 0x7c); assert.equal(c.pair(26), 0x2100); assert.equal(c.sreg, 0xa5); assert.equal(c.cycles, 1);
  assert.ok(trace.accesses.some(a => a.kind === 'write' && a.addressByte === 0x20ff));
});
test('unsupported instruction/MMIO, holes, undefined operand and stack errors trap with location', () => {
  for (const op of [0xffff, 0x95a8, 0x91e7]) {
    const c = cpu([op]); assert.throws(() => c.step(), e => e instanceof ExecutionFault && e.pcWord === 0 && e.opcode === op);
  }
  const mmio = cpu([0x9200, 0x04a1]); assert.throws(() => mmio.step(), /0x4a1/);
  const hole = cpu([0]); hole.pc = 20; assert.throws(() => hole.step(), /HEX hole/);
  const stack = cpu([0xd000]); stack.sp = 0x2001; assert.throws(() => stack.step(), /stack overflow/);
  const ret = cpu([0x9508]); assert.throws(() => ret.step(), /stack underflow/);
});
