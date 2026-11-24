import assert from 'node:assert/strict';
import { XmegaCPU } from '../../src/xmega.mjs';
import { decodeAt } from '../../src/discovery.mjs';
import { runAvrProbe } from '../gnu-avr-probe.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node verification/ld-x/check-gnu.mjs AVR_GNU_BIN');
const start = 0x23fe, flags = 0xd7;
const cases = [[0, 0xa5], [18, 0], [30, 0xff], [31, 0x3c]];
const setup = [];
for (const [i, [, value]] of cases.entries()) setup.push('ldi r16,' + value, 'sts ' + (start + i) + ',r16');
setup.push('ldi r26,' + (start & 255), 'ldi r27,' + (start >>> 8), 'ldi r16,' + flags, 'out 0x3f,r16');
const asm = ['.text', '.global _start', '_start:', ...setup], steps = [];
for (const [i, [rd]] of cases.entries()) {
  asm.push('ld r' + rd + ',X+', 'in r17,0x3f', 'nop');
  steps.push('stepi ' + (i === 0 ? setup.length + 2 : 3),
    'printf "OBS ' + i + ' %u %u %u %u\\n", ($r' + rd + ' & 255), ($r26 & 255), ($r27 & 255), ($r17 & 255)');
}
asm.push('break');
// The last table is assembled and decoded only. R26 and R27 overlaps have undefined execution results.
for (let rd = 0; rd < 32; rd++) asm.push('ld r' + rd + ',X+');
const probe = runAvrProbe(process.argv[2], 'ldx', asm, steps);
const observations = [...probe.output.matchAll(/^OBS (\d+) (\d+) (\d+) (\d+) (\d+)\r?$/gm)].map(m => m.slice(1).map(Number));
assert.equal(observations.length, cases.length, probe.output);
const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
flash.set(probe.bytes); present.fill(1, 0, probe.bytes.length);
const cpu = new XmegaCPU({ flash, present });
for (let i = 0; i < setup.length; i++) cpu.step();
for (const [i, [rd, value]] of cases.entries()) {
  const address = start + i, next = address + 1;
  const t = cpu.step();
  assert.deepEqual([t.mnemonic, t.accesses.at(-1), t.after.cycles - t.before.cycles],
    ['LD', { kind: 'read', space: 'sram', addressByte: address, value }, 2]);
  cpu.step(); // Sample SREG through IN, just as the GNU simulator did.
  const expected = [i, value, next & 255, next >>> 8, flags];
  assert.deepEqual(observations[i], expected);
  assert.deepEqual([i, cpu.r[rd], cpu.r[26], cpu.r[27], cpu.r[17]], expected);
  cpu.step();
}
let pc = cpu.pc + 1;
for (let rd = 0; rd < 32; rd++) {
  const op = decodeAt(cpu, pc++);
  assert.deepEqual([op.mnemonic, op.operands], ['LD', { register: rd, pointer: 'X', postIncrement: true }]);
}
assert.equal(pc * 2, probe.bytes.length);
console.log(JSON.stringify({ status: 'PASS', assembler: probe.assembler, simulator: probe.simulator,
  assembledEncodings: 32, observedLoads: cases.length, observations }, null, 2));
