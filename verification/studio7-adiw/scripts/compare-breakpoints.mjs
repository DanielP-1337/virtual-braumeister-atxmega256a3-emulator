import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseHex } from '../../../src/hex.mjs';
import { XmegaCPU } from '../../../src/xmega.mjs';

// Word addresses from the synthetic fixture listing. All instructions up to
// the terminal loop occupy one word. Only ADIW and I-changing OUT add a clock.
const hexDigest = '6e74ddc4bf4da30abeef346e57c107ce2005bee592c3503b909a26e34a1310c4';
const adds = [0x34, 0x3a, 0x40, 0x46, 0x4c, 0x52, 0x58, 0x5e];
const interruptBitChanges = [0x33, 0x39, 0x3f, 0x45, 0x4b, 0x57];
const terminalWord = 0x60;

function compareRun(run, image) {
  assert.equal(typeof run.name, 'string', 'Missing run name');
  assert.ok(run.name.trim() && Array.isArray(run.checkpoints) && run.checkpoints.length, 'Empty run');
  const cpu = new XmegaCPU(image);
  assert.equal(cpu.pc, 0);
  assert.equal(cpu.cycles, 0);
  const checkpoints = [];
  for (const { word, cycles } of run.checkpoints) {
    assert.ok(Number.isSafeInteger(word) && word >= cpu.pc && word <= terminalWord, 'Invalid or backwards word PC');
    assert.ok(Number.isSafeInteger(cycles) && cycles >= 0, 'Invalid measured cycle counter');
    while (cpu.pc < word) {
      const previous = cpu.pc;
      cpu.step();
      assert.equal(cpu.pc, previous + 1, 'Fixture left the straight-line path');
    }
    // A repeated debugger stop at the same PC executes zero emulator instructions.
    const expected = word + adds.filter(pc => pc < word).length + interruptBitChanges.filter(pc => pc < word).length;
    checkpoints.push({ word, flashByte: word * 2, studioCycles: cycles, emulatorCycles: cpu.cycles,
      expectedCycles: expected, studioMinusExpected: cycles - expected, emulatorMinusExpected: cpu.cycles - expected });
  }
  return { name: run.name, matched: checkpoints.every(p => p.studioMinusExpected === 0 && p.emulatorMinusExpected === 0), checkpoints };
}

try {
  const [hexPath, capturePath] = process.argv.slice(2);
  assert.ok(process.argv.length === 4, 'Usage: node compare-breakpoints.mjs fixture.hex studio.json');
  const input = readFileSync(hexPath);
  assert.equal(createHash('sha256').update(input).digest('hex'), hexDigest, 'Unexpected fixture bytes');
  const capture = JSON.parse(readFileSync(capturePath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(capture.hexSha256, hexDigest, 'Capture is for another fixture');
  assert.ok(Array.isArray(capture.runs) && capture.runs.length, 'Missing runs');
  const runs = capture.runs.map(run => compareRun(run, parseHex(input.toString('ascii'))));
  const status = runs.every(run => run.matched) ? 'MATCH' : 'MISMATCH';
  console.log(JSON.stringify({ status, hexSha256: hexDigest, runs }, null, 2));
  process.exitCode = status === 'MATCH' ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ status: 'INVALID_INPUT_OR_RUN', reason: error.message }));
  process.exitCode = 2;
}
