// Assemble every MUL encoding and compare execution of the same synthetic program in GDB and the JS core.
import assert from 'node:assert/strict';
import { XmegaCPU } from '../../src/xmega.mjs';
import { decodeAt } from '../../src/discovery.mjs';
import { runAvrProbe } from '../gnu-avr-probe.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node verification/mul/check-gnu.mjs AVR_GNU_BIN');
const cases = [
  // Rd, Rr, their input bytes, incoming SREG, expected unsigned product and outgoing SREG.
  [28, 24, 0x26, 1, 0x35, 0x0026, 0x34], [28, 25, 0x26, 0, 0x34, 0, 0x36],
  [0, 1, 0x97, 0xd9, 0xff, 0x7fff, 0xfc], [1, 0, 0xff, 0x81, 0x40, 0x807f, 0x41],
  [0, 0, 0xff, 0xff, 0, 0xfe01, 1], [1, 1, 0x80, 0x80, 0x83, 0x4000, 0x80],
  [0, 31, 0x10, 0x10, 3, 0x0100, 0], [31, 0, 0, 0xab, 0xa9, 0, 0xaa],
  [1, 30, 0xff, 0xff, 0xaa, 0xfe01, 0xa9], [30, 1, 0xf0, 0x0f, 0x7f, 0x0e10, 0x7c],
  [2, 23, 1, 1, 0xff, 1, 0xfc], [31, 31, 0x10, 0x10, 0x55, 0x0100, 0x54],
];
const asm = ['.text', '.global _start', '_start:'], gdb = [];
for (const [i, [rd, rr, a, b, flags]] of cases.entries()) {
  asm.push('ldi r18,0xa6', 'mov r0,r18', 'ldi r18,0x59', 'mov r1,r18',
    'ldi r18,' + a, 'mov r' + rd + ',r18', 'ldi r18,' + b, 'mov r' + rr + ',r18',
    'ldi r18,' + flags, 'out 0x3f,r18', 'mul r' + rd + ',r' + rr, 'in r19,0x3f', 'nop');
  gdb.push(i === 0 ? 'stepi 12' : 'stepi 13', 'printf "OBS ' + i +
    ' %u %u %u %u %u\\n", ($r0 & 255), ($r1 & 255), ($r' + rd + ' & 255), ($r' + rr + ' & 255), ($r19 & 255)');
}
asm.push('break');
for (let rd = 0; rd < 32; rd++) for (let rr = 0; rr < 32; rr++) asm.push('mul r' + rd + ',r' + rr);
const { bytes, output, assembler, simulator } = runAvrProbe(process.argv[2], 'mul', asm, gdb);
const observations = [...output.matchAll(/^OBS (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)\r?$/gm)].map(m => m.slice(1).map(Number));
assert.equal(observations.length, cases.length, output);
const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
flash.set(bytes); present.fill(1, 0, bytes.length);
const cpu = new XmegaCPU({ flash, present });
for (const [i, [rd, rr, a, b, flags, product, expectedFlags]] of cases.entries()) {
  for (let j = 0; j < 10; j++) cpu.step();
  const t = cpu.step();
  assert.deepEqual([t.mnemonic, t.after.cycles - t.before.cycles, t.before.registers[rd], t.before.registers[rr], t.before.sreg],
    ['MUL', 2, a, b, flags]);
  cpu.step(); // IN R19,SREG reads the same flags captured in GDB.
  const lo = product % 256, hi = Math.floor(product / 256);
  const after = (r, original) => r === 0 ? lo : r === 1 ? hi : original;
  const expected = [i, lo, hi, after(rd, a), after(rr, b), expectedFlags];
  assert.deepEqual(observations[i], expected);
  assert.deepEqual([i, cpu.r[0], cpu.r[1], cpu.r[rd], cpu.r[rr], cpu.r[19]], expected);
  cpu.step();
}
let pc = cpu.pc + 1; // The encoding table follows BREAK.
for (let rd = 0; rd < 32; rd++) for (let rr = 0; rr < 32; rr++) {
  const decoded = decodeAt(cpu, pc++);
  assert.deepEqual([decoded.mnemonic, decoded.operands], ['MUL', { leftRegister: rd, rightRegister: rr }]);
}
assert.equal(pc * 2, bytes.length);
console.log(JSON.stringify({ status: 'PASS', assembler, simulator, assembledEncodings: 1024, registerAndSregCases: cases.length, observations }, null, 2));
