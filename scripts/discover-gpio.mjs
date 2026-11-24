// Local application fixture. No firmware-specific addresses enter the CPU/bus.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHex } from '../src/hex.mjs';
import { XmegaCPU } from '../src/xmega.mjs';
import { discover } from '../src/discovery.mjs';
import { GPIOController } from '../src/peripherals/gpio.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), args = {};
if (argv.length % 2) throw new Error('Arguments require --name value pairs');
for (let i = 0; i < argv.length; i += 2) { if (!['--firmware', '--output', '--max-steps', '--max-cycles'].includes(argv[i]) || args[argv[i]]) throw new Error('Unknown/duplicate argument'); args[argv[i]] = argv[i + 1]; }
const firmware = args['--firmware'] ?? 'C:/dev/BraumeisterSoftwareUpdater-1.1.27-120918/BrewControl-1-1-27.hex';
if (!args['--output']) throw new Error('Required --output NEW_PRIVATE_DIRECTORY');
const output = resolve(args['--output']), privateRoot = realpathSync(resolve(root, 'private')), rel = relative(privateRoot, output);
if (!rel || rel.startsWith('..') || isAbsolute(rel) || realpathSync(dirname(output)) !== privateRoot) throw new Error('Output must be a new direct child of workspace/private');
mkdirSync(output); // Never overwrite an existing diagnostic run.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let result;
try {
  const raw = readFileSync(firmware), firmwareSha256 = sha(raw);
  assert.equal(firmwareSha256, 'c5cea66ff95f62b9e487559d9b2177b84956033854a54ea670a7927731c71847', 'Unexpected firmware revision');
  const baseline = JSON.parse(readFileSync(resolve(root, 'private/poc-001-validation/result.json')));
  assert.equal(baseline.status, 'PASS');
  const image = parseHex(raw.toString('utf8'));
  const maxSteps = args['--max-steps'] === undefined ? 100000 : Number(args['--max-steps']);
  const maxCycles = args['--max-cycles'] === undefined ? 200000 : Number(args['--max-cycles']);
  function run(save) {
    const c = new XmegaCPU(image); let checkpoint = null;
    const gpioEvents = [], applicationPCs = new Set();
    const gpio = new GPIOController({ onAccess: e => gpioEvents.push(e) });
    gpio.register(c.bus.mmio, { fault: (m, d) => c.fault(m, d), context: () => ({ pcWord: c.pc, cyclesBefore: c.cycles, instructionAttempt: c.steps + 1 }) });
    let firstApplicationInstruction = null;
    const hash = createHash('sha256'); const fd = save ? openSync(resolve(output, 'trace.jsonl'), 'wx') : null;
    let diagnostic;
    try {
      diagnostic = discover(c, { maxSteps, maxCycles, onTrace: t => {
        const line = JSON.stringify({ origin: t.eventType === 'instruction' ? 'original-firmware' : 'emulator', ...t }) + '\n';
        hash.update(line); if (save) writeSync(fd, line);
        if (checkpoint && t.eventType === 'instruction') {
          applicationPCs.add(t.before.pcWord);
          firstApplicationInstruction ??= t;
        }
        if (t.eventType === 'instruction' && t.after.pcWord === 0x7b43 && checkpoint === null) {
          const prefixSha256 = hash.copy().digest('hex');
          assert.equal(prefixSha256, baseline.traceSha256, 'PoC 001 trace prefix regressed');
          assert.equal(c.steps, 46682); assert.equal(c.cycles, 61883);
          assert.deepEqual(c.sram.slice(0, 0x7e2), image.flash.slice(0x29d80, 0x2a562));
          assert.ok(c.sram.slice(0x7e2, 0x2b97).every(v => v === 0));
          assert.equal(c.sp, 0x5ffc); assert.deepEqual(Array.from(c.sram.slice(-3)), [0, 0x78, 0x48]);
          checkpoint = { verified: true, instructions: c.steps, cycles: c.cycles, tracePrefixSha256: prefixSha256 };
        }
      }});
    } finally { if (fd !== null) closeSync(fd); }
    return { diagnostic, checkpoint, traceSha256: hash.digest('hex'), sram: c.sram, gpioEvents, gpioState: gpio.snapshotAll(), applicationPCs: [...applicationPCs], firstApplicationInstruction };
  }
  const a = run(true), b = run(false);
  assert.deepEqual(a.diagnostic, b.diagnostic, 'Diagnostic replay differs'); assert.equal(a.traceSha256, b.traceSha256, 'Trace replay differs'); assert.deepEqual(a.sram, b.sram);
  assert.deepEqual(a.gpioEvents, b.gpioEvents); assert.deepEqual(a.gpioState, b.gpioState);
  if (a.firstApplicationInstruction) {
    assert.equal(a.firstApplicationInstruction.before.pcWord, 0x7b43);
    assert.equal(a.firstApplicationInstruction.mnemonic, 'STS');
    assert.ok(a.firstApplicationInstruction.accesses.some(x => x.kind === 'write' && x.addressByte === 0x604 && x.value === 0));
  }
  assert.equal(sha(readFileSync(firmware)), firmwareSha256);
  result = { ...a.diagnostic, firmwareSha256, nodeVersion: process.version, deterministicReplay: true, traceSha256: a.traceSha256, startupCheckpoint: a.checkpoint, completedApplicationInstructions: a.checkpoint ? a.diagnostic.completedInstructions - a.checkpoint.instructions : null };
  result.gpioEnabled = true; result.gpioAccesses = a.gpioEvents.length; result.gpioState = a.gpioState;
  result.uniqueCompletedApplicationPcWords = a.applicationPCs;
  result.firstApplicationInstructionCompleted = a.firstApplicationInstruction !== null;
  writeFileSync(resolve(output, 'gpio-accesses.jsonl'), a.gpioEvents.map(e => JSON.stringify(e) + '\n').join(''));
  writeFileSync(resolve(output, 'final-sram.bin'), a.sram);
  writeFileSync(resolve(output, 'mmio-inventory.json'), JSON.stringify(result.mmioInventory, null, 2) + '\n');
  writeFileSync(resolve(output, 'opcode-coverage.json'), JSON.stringify(result.opcodeCoverage, null, 2) + '\n');
  const f = result.firstBlockingEvent;
  writeFileSync(resolve(output, 'diagnostic-events.json'), JSON.stringify([{ origin: 'emulator', eventType: 'diagnostic', ...f }], null, 2) + '\n');
  result.sourceSha256 = Object.fromEntries(['src/xmega.mjs', 'src/memory-bus.mjs', 'src/peripherals/mmio-registry.mjs', 'src/peripherals/gpio.mjs', 'src/discovery.mjs', 'src/hex.mjs', 'scripts/discover-gpio.mjs', 'tests/gpio.test.mjs'].map(p => [p, sha(readFileSync(resolve(root, p)))]));
  process.exitCode = 2; // Controlled stop is NOT successful application boot.
} catch (error) { result = { status: 'HARNESS_ERROR', applicationBootSuccessful: false, reason: error.message }; process.exitCode = 1; }
writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, completedInstructions: result.completedInstructions, cycles: result.cycles, completedApplicationInstructions: result.completedApplicationInstructions, firstBlockingEvent: result.firstBlockingEvent, reason: result.reason }, null, 2));
