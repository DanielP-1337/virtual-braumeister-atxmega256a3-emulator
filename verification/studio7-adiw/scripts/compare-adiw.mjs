import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Usage: node compare-adiw.mjs fixture.hex [studio.json]
const [hexPath, studioPath] = process.argv.slice(2);
if (!hexPath || process.argv.length > 4) throw new Error('Supply the assembled synthetic fixture HEX and optionally one Studio capture JSON file.');
const root = process.env.ADIW_EMULATOR_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
const { parseHex } = await import(pathToFileURL(resolve(root, 'src/hex.mjs')));
const { XmegaCPU } = await import(pathToFileURL(resolve(root, 'src/xmega.mjs')));
const image = readFileSync(hexPath);
const hexSha256 = createHash('sha256').update(image).digest('hex');
assert.equal(hexSha256, '6e74ddc4bf4da30abeef346e57c107ce2005bee592c3503b909a26e34a1310c4', 'Unexpected fixture HEX');
const cpu = new XmegaCPU(parseHex(image.toString('ascii')));
// From the assembler listing. Addresses are flash words and opcodes are little-endian words.
const sites = new Map([[52, 0x9600], [58, 0x9611], [64, 0x9621], [70, 0x9631],
  [76, 0x96cf], [82, 0x9690], [88, 0x9620], [94, 0x9670]]);
const snapshot = () => ({ pcWord: cpu.pc, sreg: cpu.sreg, registers: Array.from(cpu.r), cycles: cpu.cycles });
const observations = [];
while (cpu.pc < 96) {
  assert.ok(cpu.steps < 110, 'Fixture exceeded the instruction limit');
  if (sites.has(cpu.pc)) {
    const offset = cpu.pc * 2;
    const opcode = cpu.flash[offset] | (cpu.flash[offset + 1] << 8);
    assert.equal(opcode, sites.get(cpu.pc));
    const before = snapshot();
    cpu.step();
    const after = snapshot();
    assert.equal(after.pcWord, before.pcWord + 1);
    observations.push({ opcode, before, after });
  } else {
    cpu.step();
  }
}
assert.equal(observations.length, sites.size);
const result = { status: 'EMULATOR_ONLY', hexSha256, observations };

function requireInteger(value, max, field) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= max, 'Invalid ' + field);
}

function validateCapture(capture) {
  assert.ok(capture && typeof capture === 'object' && !Array.isArray(capture), 'Expected a capture object');
  assert.equal(capture.device, 'ATxmega256A3');
  assert.equal(capture.tool, 'Atmel Studio 7');
  assert.equal(capture.hexSha256, hexSha256);
  assert.match(capture.version, /^7\.0\.\d+/);
  assert.ok(Array.isArray(capture.observations), 'Expected an observations array');
  assert.equal(capture.observations.length, observations.length);
  for (const [index, observation] of capture.observations.entries()) {
    const where = 'case ' + (index + 1);
    assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation), 'Invalid ' + where);
    if (Object.hasOwn(observation, 'opcode')) requireInteger(observation.opcode, 0xffff, where + ' opcode');
    for (const side of ['before', 'after']) {
      const state = observation[side];
      const field = where + ' ' + side + ' ';
      assert.ok(state && typeof state === 'object' && !Array.isArray(state), 'Invalid ' + field + 'state');
      requireInteger(state.pcWord, cpu.flash.length / 2 - 1, field + 'pcWord');
      requireInteger(state.sreg, 255, field + 'sreg');
      requireInteger(state.cycles, Number.MAX_SAFE_INTEGER, field + 'cycles');
      assert.ok(Array.isArray(state.registers) && state.registers.length === 32, 'Invalid ' + field + 'register array');
      for (const [reg, value] of state.registers.entries()) {
        requireInteger(value, 255, field + 'R' + reg);
      }
    }
    assert.ok(observation.after.cycles >= observation.before.cycles, where + ' cycle counter went backward during the instruction');
  }
}

function endpoints(sample) {
  return {
    pcWord: { before: sample.before.pcWord, after: sample.after.pcWord },
    sreg: { before: sample.before.sreg, after: sample.after.sreg },
    cycles: { before: sample.before.cycles, after: sample.after.cycles, delta: sample.after.cycles - sample.before.cycles },
  };
}

function compare(sample, js, index) {
  const differences = [];
  function check(field, studioValue, jsValue) {
    if (studioValue !== jsValue) differences.push({ field, studio: studioValue, js: jsValue });
  }
  if (Object.hasOwn(sample, 'opcode')) check('opcode', sample.opcode, js.opcode);
  for (const side of ['before', 'after']) {
    check(side + '.pcWord', sample[side].pcWord, js[side].pcWord);
    check(side + '.sreg', sample[side].sreg, js[side].sreg);
    for (let reg = 0; reg < 32; reg++) {
      check(side + '.R' + reg, sample[side].registers[reg], js[side].registers[reg]);
    }
  }
  const studio = endpoints(sample), emulator = endpoints(js);
  // A debugger may start the counter at a different origin. Instruction cost
  // uses the delta within each measured single-step, even when it is zero.
  check('cycles.delta', studio.cycles.delta, emulator.cycles.delta);
  return { case: index + 1, opcode: js.opcode, studio, js: emulator, differences };
}

if (studioPath) {
  try {
    const capture = JSON.parse(readFileSync(studioPath, 'utf8').replace(/^\uFEFF/, ''));
    validateCapture(capture);
    result.studioVersion = capture.version;
    result.cases = capture.observations.map((sample, index) => compare(sample, observations[index], index));
    const mismatched = result.cases.filter(row => row.differences.length > 0).length;
    result.matchedCases = result.cases.length - mismatched;
    result.mismatchedCases = mismatched;
    result.status = mismatched ? 'MISMATCH' : 'MATCH';
    if (mismatched) process.exitCode = 1;
  } catch (e) {
    result.status = 'INVALID_CAPTURE';
    result.reason = e.message;
    process.exitCode = 2;
  }
}
console.log(JSON.stringify(result, null, 2));
