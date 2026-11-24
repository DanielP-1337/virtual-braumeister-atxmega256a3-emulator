import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { execute } from '../src/run.mjs';
function loop(op) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(0x42000); flash[0] = op & 255; flash[1] = op >>> 8; present.fill(1, 0, 2);
  return new XmegaCPU({ flash, present });
}
test('instruction limit stops a real infinite RJMP loop without setting PC', () => {
  const c = loop(0xcfff); assert.throws(() => execute(c, { stopPcWord: 5, maxSteps: 3 }), /limit/);
  assert.equal(c.pc, 0); assert.equal(c.steps, 3); assert.equal(c.cycles, 6);
});
test('cycle limit and unsupported instructions fail explicitly', () => {
  assert.throws(() => execute(loop(0xcfff), { stopPcWord: 5, maxCycles: 1 }), /budget/);
  assert.throws(() => execute(loop(0xffff), { stopPcWord: 5 }), /Unsupported instruction/);
});
test('entry gate is observed only after actual instruction execution', () => {
  const c = loop(0); const traces = []; execute(c, { stopPcWord: 1, onTrace: t => traces.push(t) });
  assert.equal(c.steps, 1); assert.equal(traces[0].before.pcWord, 0); assert.equal(traces[0].after.pcWord, 1);
});
