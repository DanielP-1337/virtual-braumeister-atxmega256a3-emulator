// Compare a synthetic register-only program with GNU's simulator and assembler.
// The simulator supplies register and SREG observations. AVRxm timing is checked in the CPU tests.
import assert from 'node:assert/strict';
import { runAvrProbe } from '../gnu-avr-probe.mjs';
import { XmegaCPU } from '../../src/xmega.mjs';
import { decodeAt } from '../../src/discovery.mjs';

const option = process.argv[3];
if (process.argv.length !== 3 && !(process.argv.length === 4 && ['--add', '--adc', '--sbc', '--dec', '--swap'].includes(option))) {
  throw new Error('Usage: node verification/inc-cp/check-gnu.mjs AVR_GNU_BIN [--add|--adc|--sbc|--dec|--swap]');
}
const profile = option ? option.slice(2) : 'inc-cp';
// Operation, left input, right input, incoming SREG, expected left output, expected SREG.
const assembly = { INC: 'inc r13', CP: 'cp r13,r19', ADD: 'add r13,r19', LSL: 'lsl r13', ADC: 'adc r13,r19', ROL: 'rol r13', SBC: 'sbc r13,r19', DEC: 'dec r13', SWAP: 'swap r13' };
const aliases = { LSL: 'ADD', ROL: 'ADC' };
const casesByProfile = {
  swap: [
    ['SWAP', 0, 0x49, 0, 0, 0], ['SWAP', 0, 0x55, 0xff, 0, 0xff],
    ['SWAP', 0x02, 0xaa, 2, 0x20, 2], ['SWAP', 0xa5, 0x38, 0x81, 0x5a, 0x81],
    ['SWAP', 0xf0, 0x12, 0x20, 0x0f, 0x20], ['SWAP', 0x0f, 0, 0x40, 0xf0, 0x40],
    ['SWAP', 0xc7, 0x87, 0x55, 0x7c, 0x55], ['SWAP', 0xff, 0xff, 0xaa, 0xff, 0xaa],
  ],
  adc: [
    ['ADC', 0, 0, 0, 0, 2], ['ADC', 0, 0, 3, 1, 0],
    ['ADC', 0xff, 0, 0x41, 0, 0x63], ['ADC', 0x7f, 0, 0x81, 0x80, 0xac],
    ['ADC', 0x80, 0x80, 0xc1, 1, 0xd9], ['ADC', 8, 7, 0x41, 0x10, 0x60],
    ['ADC', 0x80, 0x7f, 0, 0xff, 0x14], ['ADC', 0xff, 1, 0, 0, 0x23],
    ['ROL', 0x80, 0x39, 0xc1, 1, 0xd9], ['ROL', 0x7f, 0x44, 1, 0xff, 0x2c],
    ['ROL', 0x80, 0x71, 0x80, 0, 0x9b], ['ROL', 0, 0xaa, 0, 0, 2],
  ],
  dec: [
    ['DEC', 0x00, 0x44, 0xe3, 0xff, 0xf5], ['DEC', 0x01, 0x55, 0, 0, 2],
    ['DEC', 0x01, 0xaa, 0xff, 0, 0xe3], ['DEC', 0x02, 0x11, 0xfd, 1, 0xe1],
    ['DEC', 0x10, 0x22, 0x20, 0x0f, 0x20], ['DEC', 0x5f, 0x33, 2, 0x5e, 0],
    ['DEC', 0x7f, 0x66, 0x1f, 0x7e, 1], ['DEC', 0x80, 0x77, 0xa1, 0x7f, 0xb9],
    ['DEC', 0x81, 0x88, 0x42, 0x80, 0x54], ['DEC', 0xff, 0x99, 0xdf, 0xfe, 0xd5],
  ],
  add: [
    ['ADD', 0, 0, 0xff, 0, 0xc2], ['ADD', 0x0f, 1, 0x0f, 0x10, 0x20],
    ['ADD', 0x7f, 1, 0x43, 0x80, 0x6c], ['ADD', 0x80, 0x80, 0xa3, 0, 0x9b],
    ['ADD', 0xff, 1, 0x43, 0, 0x63], ['ADD', 0x40, 0x40, 1, 0x80, 0x0c],
    ['ADD', 0xff, 0xff, 0x14, 0xfe, 0x35], ['LSL', 0xff, 0x55, 0x14, 0xfe, 0x35],
    ['LSL', 0x80, 0x33, 0xc1, 0, 0xdb], ['LSL', 0x7f, 0xaa, 0x81, 0xfe, 0xac],
  ],
  'inc-cp': [
    ['INC', 0, 0x44, 0x23, 1, 0x21], ['INC', 0x7f, 0x55, 0xa1, 0x80, 0xad],
    ['INC', 0x80, 0, 0x1f, 0x81, 0x15], ['INC', 0xff, 0x7f, 0xdf, 0, 0xc3],
    ['CP', 0, 1, 0xff, 0, 0xf5], ['CP', 0x80, 0x7f, 0x42, 0x80, 0x78],
    ['CP', 0x7f, 0x80, 0x81, 0x7f, 0x8d], ['CP', 0x55, 0x55, 1, 0x55, 2],
    ['CP', 0x10, 1, 0xc3, 0x10, 0xe0],
  ],
  sbc: [
    ['SBC', 0, 0, 0, 0, 0], ['SBC', 0x55, 0x55, 0xc2, 0, 0xc2],
    ['SBC', 0, 0, 0xff, 0xff, 0xf5], ['SBC', 0, 0xff, 0x83, 0, 0xa3],
    ['SBC', 0x80, 0x7f, 0x43, 0, 0x7a], ['SBC', 0x7f, 0x80, 3, 0xfe, 0x0d],
    ['SBC', 0x10, 0x0f, 0x43, 0, 0x62], ['SBC', 0xff, 0xff, 0x35, 0xff, 0x35],
    ['SBC', 0xff, 0x44, 0x35, 0xff, 0x35, 'sbc r13,r13'],
    ['SBC', 0x10, 0xcc, 2, 0, 2, 'sbc r13,r13'], ['SBC', 0, 0x55, 0xc0, 0, 0xc0, 'sbc r13,r13'],
  ],
};
const cases = casesByProfile[profile];
function checkCases() {
  const asm = ['.text', '.global _start', '_start:'];
  const gdb = [];
  for (const row of cases) {
    const [name, a, b, sreg] = row;
    const instruction = row[6] ?? assembly[name]; // The optional assembly selects an overlapping operand.
    asm.push('ldi r18,' + a, 'mov r13,r18', 'ldi r19,' + b, 'ldi r16,' + sreg, 'out 0x3f,r16',
      instruction, 'in r20,0x3f', 'nop');
  }
  asm.push('break');
  const unary = { add: 'lsl', adc: 'rol', 'inc-cp': 'inc', dec: 'dec', swap: 'swap' }[profile];
  const binary = { add: 'add', adc: 'adc', 'inc-cp': 'cp', sbc: 'sbc' }[profile];
  if (unary) for (let d = 0; d < 32; d++) asm.push(unary + ' r' + d);
  if (binary) for (let d = 0; d < 32; d++) for (let r = 0; r < 32; r++) asm.push(binary + ' r' + d + ',r' + r);
  for (let i = 0; i < cases.length; i++) {
    gdb.push(i === 0 ? 'stepi 7' : 'stepi 8', 'printf "OBS ' + i + ' %u %u %u\\n", ($r13 & 255), ($r19 & 255), ($r20 & 255)');
  }
  const { output, bytes, assembler, simulator } = runAvrProbe(process.argv[2], profile, asm, gdb);
  const observations = [...output.matchAll(/^OBS (\d+) (\d+) (\d+) (\d+)\r?$/gm)].map(m => m.slice(1).map(Number));
  assert.equal(observations.length, cases.length, output);
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  flash.set(bytes); present.fill(1, 0, bytes.length);
  const cpu = new XmegaCPU({ flash, present });
  for (const [i, [name, , right, , leftResult, flags]] of cases.entries()) {
    for (let j = 0; j < 5; j++) cpu.step();
    const op = cpu.step();
    assert.deepEqual([op.mnemonic, op.after.cycles - op.before.cycles], [aliases[name] ?? name, 1]);
    cpu.step(); // IN R20,SREG, the same snapshot read by GDB.
    assert.deepEqual(observations[i], [i, leftResult, right, flags]);
    assert.deepEqual([cpu.r[13], cpu.r[19], cpu.r[20], cpu.sreg], [leftResult, right, flags, flags]);
    cpu.step();
  }
  let pc = cpu.pc + 1; // The encoding table follows the fixture's terminal BREAK.
  const tableStart = pc;
  if (unary) for (let d = 0; d < 32; d++) {
    const op = decodeAt(cpu, pc++);
    const mnemonic = unary.toUpperCase();
    const expected = aliases[mnemonic] ? [aliases[mnemonic], { destinationRegister: d, sourceRegister: d }] : [mnemonic, { register: d }];
    assert.deepEqual([op.mnemonic, op.operands], expected);
  }
  if (binary) for (let d = 0; d < 32; d++) for (let r = 0; r < 32; r++) {
    const op = decodeAt(cpu, pc++);
    const operands = binary === 'cp' ? { leftRegister: d, rightRegister: r } : { destinationRegister: d, sourceRegister: r };
    assert.deepEqual([op.mnemonic, op.operands], [binary.toUpperCase(), operands]);
  }
  assert.equal(pc * 2, bytes.length);
  console.log(JSON.stringify({ status: 'PASS', assembler, simulator, assembledEncodings: pc - tableStart,
    registerAndSregCases: cases.length, observations }, null, 2));
}
checkCases();
