import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Word addresses from the synthetic fixture's assembly listing.
const sites = [0x34, 0x3a, 0x40, 0x46, 0x4c, 0x52, 0x58, 0x5e];
const fixtureHash = '6e74ddc4bf4da30abeef346e57c107ce2005bee592c3503b909a26e34a1310c4';
const lastFlashWord = (256 + 8) * 1024 / 2 - 1;
const systemNames = ['CYCLE_COUNTER', 'FP', 'PC', 'SP', 'X', 'Y', 'Z'];
const gprNames = Array.from({ length: 32 }, (_, i) => `R${String(i).padStart(2, '0')}`);

function lines(path) {
  const buffer = readFileSync(path);
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8';
  return buffer.toString(encoding).replace(/^\uFEFF/, '').split(/\r?\n/).filter(s => s.trim());
}

function integer(raw, max, field) {
  if (typeof raw !== 'string' || !/^(?:0x[\da-f]+|\d+)$/i.test(raw)) {
    throw Error(`Invalid or missing ${field}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw Error(`Out-of-range ${field}: ${raw}`);
  return value;
}

function remember(map, key, value, name) {
  if (map.has(key)) {
    assert.deepStrictEqual(map.get(key), value, `Conflicting ${name} at word PC 0x${key.toString(16)}`);
  } else map.set(key, value);
}

function parseAutos(path) {
  const frames = new Map();
  let frame;
  let group;
  function finish() {
    if (!frame) return;
    for (const name of [...gprNames, ...systemNames]) {
      if (!Object.hasOwn(frame, name)) throw Error(`Missing Autos field ${name} in frame at ${frame.PC ?? 'unknown PC'}`);
    }
    remember(frames, frame.PC, frame, 'Autos frames');
  }
  for (const line of lines(path)) {
    const fields = line.split('\t');
    if (fields.length !== 5) throw Error(`Malformed Autos row: ${line}`);
    const [marker, indent, name, raw, type] = fields.map(s => s.trim());
    if (indent) throw Error(`Malformed Autos indentation: ${line}`);
    if (type === 'Register Group') {
      if (!['+', '-'].includes(marker) || raw) throw Error(`Malformed register group: ${line}`);
      if (name === 'CPU') { finish(); frame = {}; }
      if (!frame) throw Error('Autos export must begin with the CPU group');
      group = name;
      continue;
    }
    const isGpr = group === 'CPU' && type === 'CPU Register' && gprNames.includes(name);
    const isSystem = group === 'System Registers' && type === 'Device Register' && systemNames.includes(name);
    if (marker || (!isGpr && !isSystem)) throw Error(`Unexpected Autos register row: ${line}`);
    if (Object.hasOwn(frame, name)) throw Error(`Duplicate field ${name} within one Autos frame`);
    const limit = isGpr ? 0xff : name === 'CYCLE_COUNTER' ? Number.MAX_SAFE_INTEGER : name === 'PC' ? lastFlashWord : 0xffff;
    frame[name] = integer(raw, limit, name);
  }
  finish();
  return frames;
}

function parseSreg(path) {
  const [header, ...rows] = lines(path);
  if (header?.trim() !== 'pcWord\tsreg') throw Error('Expected the tab-separated header pcWord and sreg');
  const observed = new Map();
  for (const line of rows) {
    const cells = line.split('\t').map(s => s.trim());
    if (cells.length !== 2) throw Error(`Malformed SREG observation: ${line}`);
    remember(observed, integer(cells[0], lastFlashWord, 'pcWord'), integer(cells[1], 0xff, 'sreg'), 'SREG readings');
  }
  return observed;
}

function main(args) {
  const [autosFile, sregFile, hexFile, version] = args;
  if (args.length !== 4 || !/^7\.0\.\d+(?:\.\d+)?$/.test(version)) {
    throw Error('Usage: node parse-studio.mjs studio-autos.txt studio-sreg.tsv fixture.hex 7.0.BUILD');
  }
  const hexSha256 = createHash('sha256').update(readFileSync(hexFile)).digest('hex');
  if (hexSha256 !== fixtureHash) throw Error('Unexpected synthetic fixture HEX hash');
  const frames = parseAutos(autosFile);
  const sregs = parseSreg(sregFile);
  function snapshot(pcWord) {
    const frame = frames.get(pcWord);
    if (!frame || !sregs.has(pcWord)) throw Error(`Missing ${frame ? 'SREG' : 'Autos frame'} at word PC 0x${pcWord.toString(16)}`);
    return { pcWord, registers: gprNames.map(k => frame[k]), sreg: sregs.get(pcWord), cycles: frame.CYCLE_COUNTER };
  }
  const observations = sites.map(pc => ({ before: snapshot(pc), after: snapshot(pc + 1) }));
  console.log(JSON.stringify({ device: 'ATxmega256A3', tool: 'Atmel Studio 7', version, hexSha256, observations }, null, 2));
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
