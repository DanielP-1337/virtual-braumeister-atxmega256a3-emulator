// Public synthetic programs only. No proprietary input is read by this probe.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir = resolve(process.argv[2]);
const require = createRequire(resolve(dir, 'package.json'));
const { CPU, avrInstruction } = require('avr8js');
const results = [];
function probe(name, run) { results.push({ name, ...run() }); }
function fresh(words) { const mem = new Uint16Array(0x21000); mem.set(words); return new CPU(mem, 0x5f00); }
probe('avr8js separate XMEGA IO versus register file', () => {
  const c = fresh([0xb900]); // OUT IO 00,r16: XMEGA writes data 0000, classic AVR writes 0020.
  c.data[16] = 0x42; let observed = null; c.writeHooks[0] = () => { observed = 0; }; c.writeHooks[32] = () => { observed = 32; };
  avrInstruction(c); return { xmegaCompatible: observed === 0, observedAddress: observed, expectedAddress: 0 };
});
probe('avr8js ST X+ timing', () => { const c = fresh([0x920d]); c.dataView.setUint16(26, 0x2000, true); avrInstruction(c); return { xmegaCompatible: c.cycles === 1, observedCycles: c.cycles, expectedCycles: 1 }; });
probe('avr8js three-byte RCALL and RET', () => {
  const c = fresh([]); c.pc = 0x10020; c.progMem[0x10020] = 0xd001; c.progMem[0x10022] = 0x9508;
  avrInstruction(c); const stack = Array.from(c.data.slice(0x5ffd, 0x6000)); const callCycles = c.cycles; avrInstruction(c);
  return { stateCompatible: c.pc === 0x10021 && stack.join() === '1,0,33', stack, callCycles, xmegaTimingCompatible: callCycles === 3 };
});
probe('avr8js ELPM carry with 264 KiB flash at boot-section boundary', () => {
  const c = fresh([0x9007]); c.data[0x5b] = 3; c.dataView.setUint16(30, 0xffff, true); c.progBytes[0x3ffff] = 0x6a; avrInstruction(c);
  return { xmegaCompatible: c.data[0] === 0x6a && c.data[0x5b] === 4, observedRAMPZ: c.data[0x5b], expectedRAMPZ: 4 };
});
probe('avr8js unknown opcode trapping', () => { const c = fresh([0xffff]); let trapped = false; try { avrInstruction(c); } catch { trapped = true; } return { explicitFailure: trapped, pcAfter: c.pc }; });
const qemu = readFileSync(resolve(dir, 'qemu-cpu.c'), 'utf8');
const translate = readFileSync(resolve(dir, 'qemu-translate.c'), 'utf8');
results.push({ name: 'QEMU source inspection, NOT an execution test', commit: readFileSync(resolve(dir, 'qemu-commit.txt'), 'utf8').trim(), registeredModels: [...qemu.matchAll(/DEFINE_AVR_CPU_TYPE\("([^"]+)"/g)].map(x => x[1]), classicIoOffset: translate.includes('port + NUMBER_OF_CPU_REGISTERS'), desUnimplemented: /trans_DES[\s\S]{0,300}not implemented/.test(translate) });
writeFileSync(resolve(dir, 'probe-results.json'), JSON.stringify(results, null, 2) + '\n'); console.log(JSON.stringify(results, null, 2));
