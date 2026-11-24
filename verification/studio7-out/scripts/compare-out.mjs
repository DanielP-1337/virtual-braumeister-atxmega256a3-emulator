import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Fixture labels from avr-objdump, converted to program words. Constants come
// from the assembly input. The oracle does not calculate them from emulator state.
const vectors = [
  { pcWord: 0x04, seed: 0xa1, source: 0x0b },
  { pcWord: 0x10, seed: 0x53, source: 0xac },
  { pcWord: 0x1c, seed: 0xb6, source: 0xc9 },
  { pcWord: 0x28, seed: 0x65, source: 0x1a },
];
const finishedWord = 0x30;
const expectedHexHash = 'e224cf4c1bf9ba06baa20c19f95822db8fbce4866fab5b9735a74ac11bca0927';
const byteFields = ['sregBefore', 'r16', 'sregAfter'];
const expectedRam = vectors.flatMap(v => [v.seed, v.source, v.source]);

function readCapture(path) {
  const hex = readFileSync(path, 'utf8').trim();
  const compact = /^(?:[0-9a-f]{2}){12}$/i;
  const spaced = /^[0-9a-f]{2}(?:\s+[0-9a-f]{2}){11}$/i;
  assert.ok(compact.test(hex) || spaced.test(hex), 'Expected exactly 12 hexadecimal bytes in SRAM address order');
  return Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'));
}

function recordDifference(differences, field, expected, observed) {
  if (expected !== observed) differences.push({ field, expected, observed });
}

function checkIoStep(cpu, pcWord, opcode, register, value, isWrite, differences, label) {
  assert.equal(cpu.pc, pcWord, 'Unexpected control flow before ' + label);
  const flags = cpu.sreg;
  const registers = Array.from(cpu.r);
  const startCycle = cpu.cycles;
  const event = cpu.step();
  assert.equal(event.opcode, opcode, 'Unexpected opcode for ' + label);
  assert.equal(cpu.pc, pcWord + 1, 'Unexpected control flow after ' + label);
  const io = event.accesses.filter(access => access.kind !== 'fetch');
  assert.equal(io.length, 1, 'Expected one I/O operation for ' + label);
  assert.equal(io[0].kind, isWrite ? 'write' : 'read');
  assert.equal(io[0].space, 'cpu-io');
  assert.equal(io[0].addressByte, 0x3f);
  recordDifference(differences, label + '.busValue', value, io[0].value);
  if (isWrite) {
    recordDifference(differences, label + '.source', value, registers[register]);
  } else {
    registers[register] = value;
  }
  for (let r = 0; r < registers.length; r++) {
    recordDifference(differences, label + '.R' + r, registers[r], cpu.r[r]);
  }
  recordDifference(differences, label + '.SREG', isWrite ? value : flags, cpu.sreg);
  const duration = cpu.cycles - startCycle;
  return { pcWord, opcode, startCycle, endCycle: cpu.cycles, duration };
}

async function compare(hexPath, capturePath, timingPath) {
  const root = process.env.OUT_EMULATOR_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
  const { parseHex } = await import(pathToFileURL(resolve(root, 'src/hex.mjs')));
  const { XmegaCPU } = await import(pathToFileURL(resolve(root, 'src/xmega.mjs')));
  const hex = readFileSync(hexPath);
  const hexSha256 = createHash('sha256').update(hex).digest('hex');
  assert.equal(hexSha256, expectedHexHash, 'Unexpected OUT test image');
  const capture = capturePath === undefined ? null : readCapture(capturePath);
  const timing = timingPath === undefined ? null : JSON.parse(readFileSync(timingPath, 'utf8'));
  if (timingPath !== undefined) {
    assert.ok(timing && Array.isArray(timing.breakpoints), 'Expected a Studio timing capture');
    assert.equal(timing.hexSha256, hexSha256, 'Studio timing capture belongs to a different fixture');
    assert.equal(timing.breakpoints.length, vectors.length, 'Expected four breakpoint pairs');
  }
  const cpu = new XmegaCPU(parseHex(hex.toString('ascii')));
  assert.equal(cpu.pc, 0, 'Expected reset word PC');
  const observations = [];
  let priorFlags = 0;
  for (const [index, v] of vectors.entries()) {
    const differences = [];
    assert.equal(cpu.pc, v.pcWord - 4);
    cpu.step(); // LDI seed
    const seedOut = checkIoStep(cpu, v.pcWord - 3, 0xbf0f, 16, v.seed, true, differences, 'seedOut');
    // XMEGA A manual §3.14.9 specifies one wait cycle when an SREG write changes I.
    seedOut.expectedCycles = 1 + ((priorFlags ^ v.seed) >>> 7);
    recordDifference(differences, 'seedOut.cycles', seedOut.expectedCycles, seedOut.duration);
    cpu.step(); // LDI source
    const readBefore = checkIoStep(cpu, v.pcWord - 1, 0xb71f, 17, v.seed, false, differences, 'readBefore');
    recordDifference(differences, 'readBefore.cycles', 1, readBefore.duration);
    recordDifference(differences, 'out.sregBefore', v.seed, cpu.sreg);
    const sregBefore = cpu.sreg;
    const out = checkIoStep(cpu, v.pcWord, 0xbf0f, 16, v.source, true, differences, 'out');
    out.expectedCycles = 1 + ((v.seed ^ v.source) >>> 7);
    recordDifference(differences, 'out.cycles', out.expectedCycles, out.duration);
    const sregAfter = cpu.sreg;
    const readAfter = checkIoStep(cpu, v.pcWord + 1, 0xb72f, 18, v.source, false, differences, 'readAfter');
    recordDifference(differences, 'readAfter.cycles', 1, readAfter.duration);
    for (let store = 0; store < 3; store++) cpu.step();
    const offset = index * 3;
    const expected = expectedRam.slice(offset, offset + 3);
    const emulator = Array.from(cpu.sram.subarray(offset, offset + 3));
    const studio = capture?.slice(offset, offset + 3) ?? null;
    const studioDifferences = [];
    for (const [i, field] of byteFields.entries()) {
      recordDifference(differences, 'sram.' + field, expected[i], emulator[i]);
      if (studio) recordDifference(studioDifferences, field, expected[i], studio[i]);
    }
    const studioState = studio && {
      sregBefore: studio[0], sourceR16: studio[1], sregAfter: studio[2],
      iBefore: studio[0] >>> 7, iAfter: studio[2] >>> 7, differences: studioDifferences,
    };
    observations.push({ case: index + 1, expectedI: [v.seed >>> 7, v.source >>> 7], expectedRam: expected,
      emulator: { sregBefore, sregAfter, seedOut, out, readBefore, readAfter, ram: emulator, differences },
      studio: studioState });
    priorFlags = v.source;
  }
  assert.equal(cpu.steps, 36, 'Unexpected retired instruction count');
  assert.equal(cpu.pc, finishedWord);
  assert.equal(cpu.flash[2 * finishedWord] | (cpu.flash[2 * finishedWord + 1] << 8), 0xcfff, 'Missing terminal RJMP');
  const studioTimingDifferences = [];
  if (timing) {
    for (const [index, { emulator: { out } }] of observations.entries()) {
      const measured = timing.breakpoints[index];
      for (const [field, actual] of Object.entries({
        beforeWord: out.pcWord, afterWord: out.pcWord + 1,
        beforeCycle: out.startCycle, afterCycle: out.endCycle,
      })) {
        assert.ok(Number.isSafeInteger(measured[field]), 'Missing Studio measurement for ' + field);
        recordDifference(studioTimingDifferences, 'case' + (index + 1) + '.' + field, measured[field], actual);
      }
    }
    recordDifference(studioTimingDifferences, 'finishedWord', timing.terminal.word, cpu.pc);
    recordDifference(studioTimingDifferences, 'terminalCycles', timing.terminal.cycles, cpu.cycles);
  }
  const jsPass = observations.filter(o => !o.emulator.differences.length).length;
  const timingPass = observations.filter(({ emulator: { out } }) => out.duration === out.expectedCycles).length;
  const studioPass = capture && observations.filter(o => !o.studio.differences.length).length;
  const pass = jsPass === vectors.length && (!capture || studioPass === vectors.length) && !studioTimingDifferences.length;
  if (!pass) process.exitCode = 1;
  return { status: pass ? (capture ? 'MATCH' : 'EMULATOR_ONLY') : 'MISMATCH', hexSha256,
    cases: vectors.length, emulatorCasesMatched: jsPass, targetOutTimingCasesMatched: timingPass, studioRamCasesMatched: studioPass,
    ...(timing && { studioTimingDifferences }),
    finishedWord, instructions: cpu.steps, cycles: cpu.cycles, sramBaseByte: 0x2000, observations };
}

try {
  const [hexPath, capturePath, timingPath] = process.argv.slice(2);
  assert.ok(hexPath && process.argv.length <= 5, 'Usage: node compare-out.mjs fixture.hex [studio-ram.txt [studio-observations.json]]');
  console.log(JSON.stringify(await compare(hexPath, capturePath, timingPath), null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'INVALID_INPUT_OR_RUN', error: error.message }, null, 2));
  process.exitCode = 2;
}
