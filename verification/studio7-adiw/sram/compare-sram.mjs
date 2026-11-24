import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const firstByte = 0x2000;
const stateSize = 33;
const rows = 16;
const dumpSize = stateSize * rows;
const finishedWord = 0x04a8;
const knownFixtureHash = '17c81735e5cf3c6b3a31a6269a745ebb6bde0e17690d75a1eea2ea24d9dac26c';
// Program byte addresses and machine words independently taken from avr-objdump -d.
const sites = new Map([
  [0x00f2 / 2, 0x9600], [0x0210 / 2, 0x9611], [0x032e / 2, 0x9621], [0x044c / 2, 0x9631],
  [0x056a / 2, 0x96cf], [0x0688 / 2, 0x9690], [0x07a6 / 2, 0x9620], [0x08c4 / 2, 0x9670],
]);

function hexWord(flash, pc) {
  return flash[2 * pc] | (flash[2 * pc + 1] << 8);
}

function snapshot(cpu) {
  return Buffer.from([...cpu.r, cpu.sreg]);
}

function readCapture(path) {
  const input = readFileSync(path);
  if (extname(path).toLowerCase() === '.bin') {
    assert.equal(input.length, dumpSize, 'Expected exactly 528 binary data bytes starting at 0x2000');
    return input;
  }
  assert.equal(extname(path).toLowerCase(), '.txt', 'Use a raw .bin or ASCII hexadecimal .txt capture');
  const raw = input.toString('utf8').trim();
  const tokens = raw.split(/\s+/);
  assert.ok(/^[0-9a-f]{1056}$/i.test(raw) ||
    (tokens.length === dumpSize && tokens.every(value => /^[0-9a-f]{2}$/i.test(value))),
  'Expected exactly 528 hexadecimal bytes without addresses, gutters or prefixes');
  return Buffer.from(tokens.join(''), 'hex');
}

async function main() {
  const [hexPath, capturePath] = process.argv.slice(2);
  assert.ok(hexPath && process.argv.length <= 4, 'Usage: node compare-sram.mjs fixture.hex [studio.bin|studio.txt]');
  const root = process.env.ADIW_EMULATOR_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
  const { parseHex } = await import(pathToFileURL(resolve(root, 'src/hex.mjs')));
  const { XmegaCPU } = await import(pathToFileURL(resolve(root, 'src/xmega.mjs')));
  const hex = readFileSync(hexPath);
  const hexSha256 = createHash('sha256').update(hex).digest('hex');
  assert.equal(hexSha256, knownFixtureHash, 'Unexpected fixture image');
  const cpu = new XmegaCPU(parseHex(hex.toString('ascii')));
  assert.equal(cpu.pc, 0);
  const snapshots = [];
  const observations = [];
  while (cpu.pc !== finishedWord) {
    assert.ok(cpu.steps < 700, 'Fixture exceeded the instruction limit');
    const pcWord = cpu.pc;
    if (!sites.has(pcWord)) {
      cpu.step();
      continue;
    }
    const opcode = hexWord(cpu.flash, pcWord);
    assert.equal(opcode, sites.get(pcWord));
    assert.equal(pcWord, [...sites.keys()][observations.length], 'Cases executed out of order');
    const before = snapshot(cpu);
    const cyclesBefore = cpu.cycles;
    cpu.step();
    assert.equal(cpu.pc, pcWord + 1);
    const after = snapshot(cpu);
    observations.push({ case: observations.length + 1, pcWord, opcode,
      sregBefore: before[32], sregAfter: after[32], cyclesBefore, cyclesAfter: cpu.cycles,
      cycleDelta: cpu.cycles - cyclesBefore });
    snapshots.push(before, after);
  }
  assert.equal(hexWord(cpu.flash, finishedWord), 0xcfff, 'Missing terminal RJMP');
  assert.equal(snapshots.length, rows, 'Missing ADIW observations');
  const expected = Buffer.concat(snapshots);
  const simulatedRam = Buffer.from(cpu.sram.subarray(0, dumpSize));
  assert.ok(simulatedRam.equals(expected), 'Simulated RAM records differ from live emulator CPU states');
  const report = { status: 'EMULATOR_ONLY', hexSha256, startDataByte: firstByte, byteCount: dumpSize,
    finishedWord, instructions: cpu.steps, cycles: cpu.cycles,
    jsRamSha256: createHash('sha256').update(simulatedRam).digest('hex'), observations };
  if (capturePath) {
    const actual = readCapture(capturePath);
    const differences = [];
    for (let offset = 0; offset < expected.length; offset++) {
      if (expected[offset] === actual[offset]) continue;
      const row = Math.floor(offset / stateSize);
      const field = offset % stateSize;
      differences.push({ dataAddressByte: firstByte + offset, case: 1 + Math.floor(row / 2),
        phase: row % 2 === 0 ? 'before' : 'after', field: field === 32 ? 'SREG' : 'R' + field,
        js: expected[offset], captured: actual[offset] });
    }
    Object.assign(report, { status: differences.length ? 'RAM_MISMATCH' : 'RAM_MATCH',
      captureRamSha256: createHash('sha256').update(actual).digest('hex'), matchedBytes: dumpSize - differences.length,
      differences });
    if (differences.length) process.exitCode = 1;
  }
  return report;
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'INVALID_INPUT_OR_RUN', error: error.message }, null, 2));
  process.exitCode = 2;
}
