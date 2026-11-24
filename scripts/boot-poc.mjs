// Firmware-specific acceptance belongs here, not in the instruction interpreter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHex } from '../src/hex.mjs';
import { XmegaCPU } from '../src/xmega.mjs';
import { execute } from '../src/run.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, v, i, all) => { if (i % 2 === 0) rows.push([v.replace(/^--/, ''), all[i + 1]]); return rows; }, []));
const firmware = args.firmware;
const evidence = args.evidence;
const output = resolve(args.output ?? resolve(root, 'private/poc-001'));
const privateRoot = realpathSync(resolve(root, 'private'));
const rel = relative(privateRoot, output);
if (!rel || rel.startsWith('..') || isAbsolute(rel) || realpathSync(dirname(output)) !== privateRoot) throw new Error('Output must be a new direct child of workspace/private');
if (!firmware || !evidence) throw new Error('Required: --firmware PATH --evidence instructions.csv --output NEW_PRIVATE_DIRECTORY');
mkdirSync(output); // No overwrite of an earlier result.
const sha = data => createHash('sha256').update(data).digest('hex');
const raw = readFileSync(firmware);
const result = { status: 'FAIL', firmwareSha256: sha(raw), nodeVersion: process.version, milestone: 'reset word 000000 to entry word 007b43, before executing main' };
let activeCPU;
try {
  assert.equal(result.firmwareSha256, 'c5cea66ff95f62b9e487559d9b2177b84956033854a54ea670a7927731c71847', 'Unexpected firmware revision');
  const image = parseHex(raw.toString('utf8'));
  // Existing exported byte strings are an independent location/decoding check, not execution instructions.
  const expected = new Map();
  for (const line of readFileSync(evidence, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^"?code:([0-9a-f]+)"?,"?([0-9a-f]+)"?,/i);
    if (match) expected.set(parseInt(match[1], 16), match[2].toLowerCase());
  }
  assert.ok(expected.size > 1000, 'Ghidra evidence CSV could not be parsed');
  const traceFile = resolve(output, 'trace.jsonl');
  let firstTrace = null, lastTrace = null, initializedSP = false, sawEIND = false, sawRAMPZ = false;
  let dataReads = 0, dataWrites = 0, bssWrites = 0, checkedInstructions = 0;
  const executedPCs = new Set();
  const run = (fill, save) => {
    const c = new XmegaCPU(image, { sramFill: fill }); activeCPU = c;
    const hash = createHash('sha256'); let fd;
    if (save) fd = openSync(traceFile, 'wx');
    try {
      execute(c, { stopPcWord: 0x7b43, maxSteps: 100000, maxCycles: 200000, onTrace: t => {
        const line = JSON.stringify({ origin: t.fault ? 'emulator' : 'original-firmware', ...t }) + '\n'; hash.update(line); if (save) writeSync(fd, line);
        if (t.fault) return;
        if (save) {
          assert.ok(t.before.pcWord === 0 || (t.before.pcWord >= 0x782a && t.before.pcWord <= 0x7847), `Unexpected control flow at word ${t.before.pcWord.toString(16)}`);
          firstTrace ??= t; lastTrace = t; executedPCs.add(t.before.pcWord);
          const bytes = t.accesses.filter(a => a.kind === 'fetch').map(a => a.value.toString(16).padStart(2, '0')).join('');
          assert.equal(bytes, expected.get(t.before.pcWord), `Ghidra byte mismatch at word ${t.before.pcWord.toString(16)}`); checkedInstructions++;
          if (t.before.pcWord === 0x782f) initializedSP = t.after.sp === 0x5fff && t.accesses.some(a => a.kind === 'write' && a.addressByte === 0x3e && a.value === 0x5f);
          if (t.before.pcWord === 0x7831) sawEIND = t.after.eind === 0 && t.accesses.some(a => a.kind === 'write' && a.addressByte === 0x3c);
          if (t.before.pcWord === 0x7838) sawRAMPZ = t.after.rampz === 2 && t.accesses.some(a => a.kind === 'write' && a.addressByte === 0x3b);
          for (const a of t.accesses) {
            if (a.space === 'flash' && a.kind === 'read') { assert.equal(a.addressByte, 0x29d80 + dataReads); dataReads++; }
            if (a.space === 'sram' && a.kind === 'write' && a.addressByte < 0x27e2) { assert.equal(a.addressByte, 0x2000 + dataWrites); dataWrites++; }
            if (a.space === 'sram' && a.kind === 'write' && a.addressByte >= 0x27e2 && a.addressByte < 0x4b97) { assert.equal(a.addressByte, 0x27e2 + bssWrites); assert.equal(a.value, 0); bssWrites++; }
          }
        }
      }});
    } finally { if (fd !== undefined) closeSync(fd); }
    assert.equal(c.pc, 0x7b43);
    assert.deepEqual(c.sram.slice(0, 0x7e2), image.flash.slice(0x29d80, 0x2a562), '.data differs from original flash');
    assert.ok(c.sram.slice(0x7e2, 0x2b97).every(x => x === 0), 'BSS not cleared');
    assert.ok(c.sram.slice(0x2b97, 0x3ffd).every(x => x === fill), 'Untouched SRAM guard modified');
    assert.deepEqual(Array.from(c.sram.slice(-3)), [0, 0x78, 0x48], 'RCALL must push word return address 007848');
    assert.equal(c.sp, 0x5ffc); assert.equal(c.eind, 0); assert.equal(c.rampz, 2);
    assert.equal(c.pair(30), 0xa562); assert.equal(c.pair(26), 0x4b97);
    return { cpu: c, traceSha256: hash.digest('hex') };
  };
  const primary = run(0xa5, true), repeat = run(0xa5, false), poisoned = run(0x5a, false);
  assert.equal(primary.traceSha256, repeat.traceSha256, 'Repeated execution trace differs');
  assert.equal(primary.traceSha256, poisoned.traceSha256, 'Startup unexpectedly reads poisoned SRAM');
  assert.equal(firstTrace.before.pcWord, 0); assert.equal(firstTrace.mnemonic, 'JMP'); assert.equal(firstTrace.after.pcWord, 0x782a);
  assert.equal(lastTrace.before.pcWord, 0x7847); assert.equal(lastTrace.mnemonic, 'RCALL'); assert.equal(lastTrace.after.pcWord, 0x7b43);
  assert.ok(initializedSP && sawEIND && sawRAMPZ, 'Required CPU initialization writes absent');
  assert.equal(dataReads, 2018); assert.equal(dataWrites, 2018); assert.equal(bssWrites, 9141);
  // Independent loop accounting from the reviewed startup listing and AVRxm timing table.
  assert.equal(primary.cpu.steps, 1 + 16 + 3 + 2018 * 5 + 4 + 3 + 9141 * 4 + 1);
  assert.equal(primary.cpu.cycles, 3 + 17 + 4 + (2018 * 8 - 1) + 5 + 4 + (9141 * 5 - 1) + 3);
  assert.ok(!executedPCs.has(0x7b43), 'Must stop before main executes');
  assert.equal(sha(readFileSync(firmware)), result.firmwareSha256, 'Firmware changed during run');
  Object.assign(result, { status: 'PASS', steps: primary.cpu.steps, cycles: primary.cpu.cycles, final: primary.cpu.state(), traceSha256: primary.traceSha256, deterministicRepeats: 2, alternateSramFillPass: true, checkedInstructions, uniquePcWords: [...executedPCs].sort((a, b) => a - b), dataReads, dataWrites, bssWrites, firstTransition: [0, 0x782a], lastTransition: [0x7847, 0x7b43], sramSha256: sha(primary.cpu.sram), eepromUnchanged: primary.cpu.eeprom.every(v => v === 255) });
  writeFileSync(resolve(output, 'final-sram.bin'), primary.cpu.sram);
  const sources = ['src/hex.mjs', 'src/xmega.mjs', 'src/run.mjs', 'scripts/boot-poc.mjs', 'tests/cpu.test.mjs'];
  result.sourceSha256 = Object.fromEntries(sources.map(p => [p, sha(readFileSync(resolve(root, p)))]));
} catch (error) {
  result.reason = error.message; result.pcWord = error.pcWord ?? activeCPU?.pc ?? null; result.opcode = error.opcode ?? activeCPU?.currentOpcode ?? null;
  result.steps = activeCPU?.steps ?? 0; result.cycles = activeCPU?.cycles ?? 0; process.exitCode = 1;
}
result.lastPcWord = activeCPU?.pc ?? null;
result.firstFailureReason = result.reason ?? null;
writeFileSync(resolve(output, 'diagnostic-events.json'), JSON.stringify([{ eventType: 'diagnostic', origin: 'emulator', status: result.status, lastPcWord: result.lastPcWord, firstFailureReason: result.firstFailureReason }], null, 2) + '\n');
writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
