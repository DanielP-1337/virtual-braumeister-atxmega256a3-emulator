// Run only the GNU-assembled synthetic probe with its explicit address ACK.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseHex } from '../../src/hex.mjs';
import { execute } from '../../src/run.mjs';
import { XmegaCPU } from '../../src/xmega.mjs';
import { PMIC } from '../../src/peripherals/pmic.mjs';
import { TWIMaster } from '../../src/peripherals/twie.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node verification/stack/trace-twie-stack.mjs SYNTHETIC.hex');
const image = parseHex(readFileSync(process.argv[2], 'utf8'));
const imageSha256 = createHash('sha256').update(image.flash).update(image.present).digest('hex');
assert.equal(imageSha256, 'c2fd181474d78f0dbd2b71f4aa64361a4652a4330f3ae406709970f27f7e5865',
  'This fixture accepts only the synthetic twie-stack.S image');

function run() {
  const cpu = new XmegaCPU(image);
  const events = [], irqEdges = [], peerRequests = [];
  const hash = createHash('sha256');
  const twi = new TWIMaster({ respond(q) {
    assert.deepEqual(q, { action: 'address', address: 0x57, read: false, repeated: false });
    peerRequests.push(q);
    return true;
  }, onInterrupt(e) { irqEdges.push([e.cycle, e.asserted, e.source]); } });
  twi.register(cpu.bus.mmio, { fault: (reason, data) => cpu.fault(reason, data) });
  const pmic = new PMIC({ sources: [cycle => {
    if (twi.needsClock) twi.advanceTo(cycle);
    return twi.interruptRequest;
  }] });
  cpu.bus.attachPMIC(pmic);
  execute(cpu, { stopPcWord: 0x12355, maxSteps: 500, maxCycles: 750, onTrace(t) {
    if (twi.needsClock) twi.advanceTo(cpu.cycles);
    hash.update(JSON.stringify(t) + '\n');
    const entry = t.eventType === 'interrupt-entry', pc = t.before.pcWord;
    if (!entry && (pc < 0x5c || pc >= 0x77)) return;
    events.push({ origin: entry ? 'emulator' : 'synthetic-instruction', operation: t.mnemonic ?? t.eventType,
      pcWord: pc, nextPcWord: t.after.pcWord, opcode: t.opcode ?? null,
      clock: [t.before.cycles, t.after.cycles], sp: [t.before.sp, t.after.sp], sreg: [t.before.sreg, t.after.sreg],
      rampz: [t.before.rampz, t.after.rampz], activeLevels: pmic.status,
      stack: t.accesses.filter(a => a.space === 'sram').map(a => [a.kind, a.addressByte, a.value]) });
  } });
  return { imageSha256, traceSha256: hash.digest('hex'), retired: cpu.steps, cycles: cpu.cycles, finalPcWord: cpu.pc,
    sp: cpu.sp, sreg: cpu.sreg, rampz: cpu.rampz, pmicStatus: pmic.status, twiStatus: twi.status,
    sram2000: Array.from(cpu.sram.slice(0, 6)), irqEdges, peerRequests, events };
}

const proof = run();
assert.deepEqual(run(), proof, 'Replay from reset diverged');
assert.deepEqual([proof.retired, proof.cycles, proof.finalPcWord, proof.sp, proof.sreg, proof.rampz],
  [124, 183, 0x12355, 0x5fff, 0xd5, 3]);
assert.deepEqual(proof.sram2000, [0x47, 0xac, 0x39, 0xd5, 3, 0]);
assert.deepEqual([proof.peerRequests.length, proof.pmicStatus, proof.twiStatus], [1, 0, 1]);
assert.deepEqual(proof.irqEdges, [[105, true, 'write'], [142, false, null]]);
const stack = proof.events.filter(e => e.stack.length);
assert.deepEqual(stack.map(e => e.operation), ['interrupt-entry', 'PUSH', 'PUSH', 'PUSH', 'PUSH', 'PUSH',
  'CALL', 'RET', 'POP', 'POP', 'POP', 'POP', 'POP', 'RETI']);
const writes = stack.flatMap(e => e.stack.filter(([kind]) => kind === 'write'));
const reads = stack.flatMap(e => e.stack.filter(([kind]) => kind === 'read'));
const expected = [0x45, 0x23, 0x01, 0x47, 0xd5, 0xac, 0x03, 0x39, 0x67, 0x00, 0x00];
assert.deepEqual(writes, expected.map((value, i) => ['write', 0x5fff - i, value]));
assert.deepEqual(reads, expected.map((value, i) => ['read', 0x5fff - i, value]).reverse());
for (const e of stack.filter(e => e.operation === 'PUSH' || e.operation === 'POP')) {
  const push = e.operation === 'PUSH';
  assert.equal(e.clock[1] - e.clock[0], push ? 1 : 2);
  assert.equal(e.sp[1] - e.sp[0], push ? -1 : 1);
  assert.equal(e.sreg[1], e.sreg[0]);
}
const landmarks = proof.events.filter(e => ['interrupt-entry', 'JMP', 'CALL', 'RET', 'RETI'].includes(e.operation));
assert.deepEqual(landmarks.map(e => [e.pcWord, e.nextPcWord, e.sp[1], e.activeLevels]), [
  [0x12345, 0x5c, 0x5ffc, 1], [0x5c, 0x5e, 0x5ffc, 1], [0x65, 0x6f, 0x5ff4, 1],
  [0x76, 0x67, 0x5ff7, 1], [0x6e, 0x12345, 0x5fff, 0],
]);
assert.deepEqual(landmarks.map(e => e.clock), [[123, 125], [125, 128], [135, 139], [146, 151], [163, 168]]);
assert.ok(proof.events.some(e => e.operation === 'OUT' && e.sreg[0] === 0xc3 && e.sreg[1] === 0xd5));
assert.ok(proof.events.some(e => e.operation === 'OUT' && e.rampz[0] === 1 && e.rampz[1] === 3));
console.log(JSON.stringify({ status: 'PASS', replays: 2, ...proof }, null, 2));
