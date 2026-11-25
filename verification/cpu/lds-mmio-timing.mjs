// Microchip AVR Instruction Set Manual, Table 6-70 and note 3; XMEGA A3 datasheet §32.
import assert from 'node:assert/strict';
import { XmegaCPU } from '../../src/xmega.mjs';

// Use two-word LDS and a constant test handler to isolate CPU timing from timer behavior.
const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
flash.set([0x00, 0x91, 0x06, 0x08]); // LDS R16,0x0806
present.fill(1, 0, 4);
const cpu = new XmegaCPU({ flash, present });
let sampledAt;
cpu.mapMMIO(0x806, { read(cycle) { sampledAt = cycle; return 0x0b; } });
const trace = cpu.step();
assert.equal(cpu.r[16], 0x0b);
assert.equal(cpu.pc, 2);
const observed = trace.after.cycles - trace.before.cycles;
const expected = 2;
const status = observed === expected && sampledAt === expected ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ status, instruction: 'LDS R16,0x0806', expected, observed, sampledAt }, null, 2));
if (status === 'FAIL') process.exitCode = 1;
