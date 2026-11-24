// Execute the independently assembled IRQ probe. The artificial bus peer belongs to this image only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseHex } from '../../src/hex.mjs';
import { PMIC } from '../../src/peripherals/pmic.mjs';
import { TWIMaster } from '../../src/peripherals/twie.mjs';
import { execute } from '../../src/run.mjs';
import { XmegaCPU } from '../../src/xmega.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node verification/pmic/trace-vector.mjs SYNTHETIC.hex');
const image = parseHex(readFileSync(process.argv[2], 'utf8'));
const imageHash = createHash('sha256').update(image.flash).update(image.present).digest('hex');
assert.equal(imageHash, '390e3e8d006b72d1dcecf25ccc3728bfacd2a01b4b53359fe9e04acdeeea4bed',
  'Expected the sparse GNU-assembled twie-vector.S image');

function run() {
  const cpu = new XmegaCPU(image);
  const hash = createHash('sha256');
  const events = [], lineChanges = [];
  const twi = new TWIMaster({
    respond: request => request.action === 'read' ? 0x39 : true,
    onInterrupt: event => lineChanges.push(event),
  });
  twi.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details) });
  const pmic = new PMIC({ sources: [cycle => {
    if (twi.needsClock) twi.advanceTo(cycle);
    return twi.interruptRequest;
  }] });
  cpu.bus.attachPMIC(pmic);
  execute(cpu, {
    stopPcWord: 0x12352, maxSteps: 1000, maxCycles: 2000,
    onTrace(t) {
      if (twi.needsClock) twi.advanceTo(cpu.cycles);
      hash.update(JSON.stringify(t) + '\n');
      const irq = t.eventType === 'interrupt-entry';
      if (!(irq || t.mnemonic === 'RETI' || [0, 0x005c, 0x12343, 0x12344].includes(t.before.pcWord))) return;
      events.push({
        origin: irq ? 'emulator' : 'synthetic-instruction', eventType: t.eventType,
        operation: irq ? 'interrupt-entry' : t.mnemonic, opcode: t.opcode ?? null, retired: cpu.steps,
        pcWord: [t.before.pcWord, t.after.pcWord], cycles: [t.before.cycles, t.after.cycles],
        sp: [t.before.sp, t.after.sp], sreg: [t.before.sreg, t.after.sreg], pmicStatus: pmic.status,
        source: t.interruptRequest?.source ?? null, level: t.interruptRequest?.level ?? null,
        stack: t.accesses.filter(a => a.space === 'sram').map(a => [a.kind, a.addressByte, a.value]),
      });
    },
  });
  return {
    imageSha256: imageHash, traceSha256: hash.digest('hex'), finalPcWord: cpu.pc,
    retiredInstructions: cpu.steps, cycles: cpu.cycles, finalSP: cpu.sp,
    pmic: pmic.snapshot(), twiStatus: twi.status, sram2000: Array.from(cpu.sram.slice(0, 8)), lineChanges, events,
  };
}

const proof = run();
assert.deepEqual(run(), proof, 'Replay from reset diverged');
assert.deepEqual([proof.finalPcWord, proof.retiredInstructions, proof.cycles, proof.finalSP], [0x12352, 216, 345, 0x5fff]);
assert.deepEqual(proof.sram2000, [0x62, 1, 0xb5, 0x5a, 0xa5, 0xa2, 0x39, 0]);
assert.deepEqual(proof.pmic, { status: 0, intpri: 0, ctrl: 1 });
assert.equal(proof.twiStatus, 1);
assert.deepEqual(proof.lineChanges.map(e => [e.cycle, e.asserted, e.source]),
  [[105, true, 'write'], [136, false, null], [316, true, 'read'], [328, false, null]]);
assert.deepEqual(proof.events.map(e => e.operation),
  ['JMP', 'SEI', 'LDI', 'interrupt-entry', 'JMP', 'RETI', 'interrupt-entry', 'JMP', 'RETI']);
const entries = proof.events.filter(e => e.operation === 'interrupt-entry');
const returns = proof.events.filter(e => e.operation === 'RETI');
const vectors = proof.events.filter(e => e.pcWord[0] === 0x5c);
for (const [i, fixture] of [
  { source: 'write', resume: 0x12345, low: 0x45, sreg: 0xb5, enter: 117, reti: 136, retiPc: 0x6e },
  { source: 'read', resume: 0x1234a, low: 0x4a, sreg: 0xb8, enter: 316, reti: 333, retiPc: 0x78 },
].entries()) {
  const irq = entries[i], vector = vectors[i], ret = returns[i];
  assert.deepEqual([irq.source, irq.level, irq.pmicStatus, irq.opcode], [fixture.source, 1, 1, null]);
  assert.deepEqual(irq.pcWord, [fixture.resume, 0x5c]);
  assert.deepEqual(irq.sp, [0x5fff, 0x5ffc]);
  assert.deepEqual(irq.stack, [['write', 0x5fff, fixture.low], ['write', 0x5ffe, 0x23], ['write', 0x5ffd, 1]]);
  assert.deepEqual(irq.cycles, [fixture.enter, fixture.enter + 2]);
  assert.deepEqual(irq.sreg, [fixture.sreg, fixture.sreg]);
  assert.deepEqual(vector.pcWord, [0x5c, 0x5e]);
  assert.equal(vector.opcode, 0x940c);
  assert.equal(vector.retired, irq.retired + 1);
  assert.deepEqual(vector.cycles, [fixture.enter + 2, fixture.enter + 5]);
  assert.deepEqual(ret.pcWord, [fixture.retiPc, fixture.resume]);
  assert.deepEqual(ret.stack, [['read', 0x5ffd, 1], ['read', 0x5ffe, 0x23], ['read', 0x5fff, fixture.low]]);
  assert.deepEqual(ret.sp, [0x5ffc, 0x5fff]);
  assert.deepEqual(ret.sreg, [fixture.sreg, fixture.sreg]);
  assert.equal(ret.pmicStatus, 0);
  assert.equal(ret.opcode, 0x9518);
  assert.deepEqual(ret.cycles, [fixture.reti, fixture.reti + 5]);
}
console.log(JSON.stringify({ status: 'PASS', replays: 2, ...proof }, null, 2));
