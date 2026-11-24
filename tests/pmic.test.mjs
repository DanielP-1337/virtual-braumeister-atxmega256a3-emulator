import test from 'node:test';
import assert from 'node:assert/strict';
import { XmegaCPU } from '../src/xmega.mjs';
import { PMIC } from '../src/peripherals/pmic.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';
import { discover, decodeAt } from '../src/discovery.mjs';

const STATUS = 0xa0, INTPRI = 0xa1, CTRL = 0xa2;
const low = { peripheral: 'TWIE', level: 1, vectorWord: 0x005c, source: 'write' };
const medium = { peripheral: 'USARTF0', level: 2, vectorWord: 0x00ee, source: 'receive' };
const high = { peripheral: 'TCC0', level: 3, vectorWord: 0x001c, source: 'overflow' };
function image(blocks) {
  const flash = new Uint8Array(0x42000).fill(0xff), present = new Uint8Array(flash.length);
  for (const [pc, words] of blocks) {
    let at = pc * 2;
    for (const word of words) {
      assert.equal(present[at], 0);
      flash[at++] = word & 255; flash[at++] = word >>> 8;
    }
    present.fill(1, pc * 2, at);
  }
  return { flash, present };
}
function attached(blocks, sources = []) {
  const cpu = new XmegaCPU(image(blocks));
  const pmic = new PMIC({ sources });
  cpu.bus.attachPMIC(pmic);
  return { cpu, pmic };
}
function entry(cpu, expectedWord) {
  const retired = cpu.steps;
  const event = cpu.step();
  assert.equal(event.eventType, 'interrupt-entry');
  assert.equal(event.vectorPcWord, expectedWord);
  assert.equal(event.after.cycles - event.before.cycles, 2);
  assert.equal(cpu.steps, retired);
  assert.equal(event.before.sreg, event.after.sreg);
  return event;
}

test('PMIC exposes the three A3 registers, reset state, protected IVSEL and strict access faults', () => {
  const { cpu, pmic } = attached([]);
  assert.deepEqual([cpu.read(STATUS), cpu.read(INTPRI), cpu.read(CTRL)], [0, 0, 0]);
  cpu.write(INTPRI, 0x59); cpu.write(CTRL, 0xc7);
  assert.deepEqual(pmic.snapshot(), { status: 0, intpri: 0x59, ctrl: 0x87 });
  assert.throws(() => cpu.write(STATUS, 7), { classification: 'PMIC_READ_ONLY' });
  assert.throws(() => cpu.write(CTRL, 8), { classification: 'PMIC_RESERVED_CONFIGURATION' });
  assert.throws(() => cpu.read(0xa3), { classification: 'UNHANDLED_MMIO' });
  assert.throws(() => cpu.bus.attachPMIC(pmic), /already/);
  pmic.reset();
  assert.deepEqual(pmic.snapshot(), { status: 0, intpri: 0, ctrl: 0 });
  const collision = new XmegaCPU(image([]));
  collision.mapMMIO(0xa1, { read: () => 9 });
  assert.throws(() => collision.bus.attachPMIC(new PMIC()), /collision/);
  assert.equal(collision.bus.pmic, null);
  assert.equal(collision.hooks.has(0x34), false);
  assert.equal(collision.hooks.has(0xa0), false);
});

test('PMIC gates real TWIE RIF/WIF by SREG.I, each peripheral enable, INTLVL and the matching PMIC level', () => {
  const rom = image([[0, [0, 0]], [0x5c, [0, 0x9518]]]);
  for (const read of [false, true]) for (const global of [false, true]) {
    for (let level = 0; level < 4; level++) for (const directionMask of [0, 0x10, 0x20, 0x30]) {
      for (let levels = 0; levels <= 7; levels++) {
        const cpu = new XmegaCPU(rom);
        const twi = new TWIMaster({ respond: q => q.action === 'read' ? 0x39 : true });
        twi.register(cpu.bus.mmio, { fault: (reason, details) => cpu.fault(reason, details) });
        const pmic = new PMIC({ sources: [() => twi.interruptRequest] });
        cpu.bus.attachPMIC(pmic);
        cpu.write(0x04a1, level * 64 + directionMask + 8);
        cpu.write(0x04a4, 1); cpu.write(0x04a6, read ? 0xaf : 0xae);
        cpu.write(CTRL, levels);
        twi.advanceTo(170); cpu.cycles = 170;
        cpu.sreg = global ? 0xb5 : 0x35;
        const mask = [0, 1, 2, 4][level];
        const local = read ? (directionMask & 32) : (directionMask & 16);
        const enabled = Boolean(global && local && (levels & mask));
        const event = cpu.step();
        assert.equal(event.eventType, enabled ? 'interrupt-entry' : 'instruction');
        assert.equal(cpu.pc, enabled ? 0x5c : 1);
        assert.equal(pmic.status, enabled ? mask : 0);
        assert.equal(cpu.sp, enabled ? 0x5ffc : 0x5fff);
        assert.equal(cpu.read(0x04a4), read ? 0xa2 : 0x62); // A PMIC acknowledgment never clears TWIE flags.
      }
    }
  }
});

test('PMIC samples current requests and honors the one-clock level-disable delay', () => {
  let asserted = true;
  const { cpu, pmic } = attached([], [() => asserted ? low : null]);
  cpu.write(CTRL, 1, 4);
  assert.equal(pmic.pending(4), low);
  asserted = false;
  assert.equal(pmic.pending(5), null);
  asserted = true;
  cpu.write(CTRL, 0, 8);
  assert.equal(cpu.read(CTRL, 8), 0);
  assert.equal(pmic.pending(8), low);
  assert.equal(pmic.pending(9), null);
  cpu.write(CTRL, 1, 10);
  assert.equal(pmic.pending(10), low);
});

test('PMIC chooses level before vector and tracks low round-robin priority in vector numbers', () => {
  const other = { ...low, peripheral: 'TWIC', vectorWord: 0x001a };
  const { cpu, pmic } = attached([], [() => low, () => medium, () => other, () => high]);
  cpu.write(CTRL, 7);
  assert.equal(pmic.pending(1), high);
  cpu.write(CTRL, 3, 2);
  assert.equal(pmic.pending(3), medium);
  cpu.write(CTRL, 0x81, 4);
  assert.equal(pmic.pending(5), other);
  pmic.acknowledge(other);
  assert.equal(cpu.read(INTPRI, 5), 13);
  assert.equal(pmic.pending(5), null);
  pmic.finishInterrupt();
  assert.equal(pmic.pending(6), low);
  pmic.acknowledge(low); pmic.finishInterrupt();
  assert.equal(cpu.read(INTPRI, 7), 46); // Table slot, not word 92 or byte 184.
  cpu.write(CTRL, 1, 7); cpu.write(INTPRI, 13, 8);
  assert.equal(pmic.pending(8), low);
  pmic.acknowledge(low); pmic.finishInterrupt();
  assert.equal(cpu.read(INTPRI, 9), 13); // RREN off freezes the rotation pointer.
  cpu.write(INTPRI, 0, 10);
  assert.equal(pmic.pending(10), other);
});

test('PMIC nested higher levels preserve suspended levels and three separate stack frames', () => {
  let med = false, hi = false;
  const { cpu, pmic } = attached([[0, [0,0]], [0x5c, [0,0,0x9518]], [0xee, [0,0,0x9518]], [0x1c, [0,0x9518]]],
    [() => low, () => med ? medium : null, () => hi ? high : null]);
  cpu.write(CTRL, 7); cpu.sreg = 0xe5;
  entry(cpu, 0x5c); med = true;
  assert.equal(cpu.step().mnemonic, 'NOP'); // The vector instruction actually executes.
  entry(cpu, 0xee); hi = true;
  assert.equal(cpu.step().mnemonic, 'NOP');
  entry(cpu, 0x1c);
  assert.deepEqual([pmic.status,cpu.sp], [7,0x5ff6]);
  assert.deepEqual([...cpu.sram.slice(-9)], [0,0,0xef, 0,0,0x5d, 0,0,0]);
  hi = false; med = false;
  assert.equal(cpu.step().mnemonic, 'NOP');
  for (const [status, pc, sp] of [[3,0xef,0x5ff9],[1,0x5d,0x5ffc],[0,0,0x5fff]]) {
    const ret = cpu.step();
    assert.equal(ret.mnemonic, 'RETI');
    assert.equal(ret.after.cycles - ret.before.cycles, 5);
    assert.deepEqual([pmic.status,cpu.pc,cpu.sp,cpu.sreg], [status,pc,sp,0xe5]);
    assert.equal(cpu.step().mnemonic, 'NOP'); // One resumed instruction, including at the outermost level.
  }
  entry(cpu, 0x5c); // The low request remained asserted.
});

test('PMIC from reset stacks the next word PC above 64K and fetches the vector JMP before RETI', () => {
  const blocks = [[0,[0x940d,0x2340]], [0x12340,[0xe001,0x9300,CTRL,0x9478,0xe54a,0,0xffff]],
    [0x5c,[0x940c,0x80]], [0x80,[0xe205,0xbf0f,0x9518]]]; // ISR writes 0x25 to SREG.
  function run() {
    const { cpu, pmic } = attached(blocks, [() => low]);
    const trace = [];
    const result = discover(cpu, { onTrace: e => trace.push(e) });
    assert.equal(result.firstBlockingEvent.classification, 'UNSUPPORTED_OPCODE');
    assert.equal(result.interruptEntries, 1);
    assert.equal(result.completedInstructions, 10);
    assert.equal(result.attemptedInstructions, 11);
    assert.equal(result.cycles, 22);
    assert.deepEqual(result.callStack, []);
    assert.equal(result.opcodeCoverage.reduce((n,r) => n+r.count,0), result.completedInstructions);
    const irq = trace.find(e => e.eventType === 'interrupt-entry');
    assert.equal(irq.returnPcWord, 0x12345);
    assert.equal(irq.vectorPcWord, 0x5c);
    assert.equal(irq.afterStep, 5);
    assert.equal(irq.before.registers[20], 0x5a);
    assert.equal(irq.before.sreg, 0x80);
    assert.deepEqual(irq.accesses.map(a => [a.kind,a.addressByte,a.value]), [
      ['write',0x5fff,0x45],['write',0x5ffe,0x23],['write',0x5ffd,0x01],
    ]);
    const vector = trace[trace.indexOf(irq)+1];
    assert.deepEqual([vector.mnemonic,vector.before.pcWord,vector.after.pcWord], ['JMP',0x5c,0x80]);
    const ret = trace.find(e => e.mnemonic === 'RETI');
    assert.deepEqual([ret.opcode,ret.after.sreg,ret.after.sp,ret.after.pcWord], [0x9518,0x25,0x5fff,0x12345]);
    assert.deepEqual(ret.accesses.filter(a => a.space === 'sram').map(a => a.value), [1,0x23,0x45]);
    assert.equal(cpu.sram.at(-4), 0xa5);
    assert.equal(pmic.status, 0);
    assert.equal(result.recentControlFlow.filter(e => e.eventType === 'interrupt-entry').length, 1);
    return trace;
  }
  assert.deepEqual(run(), run());
});

test('PMIC preserves every SREG bit across entry and RETI, including an I bit cleared by the ISR', () => {
  const rom = image([[0, [0]], [0x5c,[0xbf0f,0x9518]]]);
  for (let sreg = 0; sreg < 256; sreg++) {
    const cpu = new XmegaCPU(rom);
    const pmic = new PMIC({ sources: [() => low] });
    cpu.bus.attachPMIC(pmic); cpu.write(CTRL, 1);
    cpu.r[16] = sreg; cpu.sreg = sreg | 0x80;
    entry(cpu, 0x5c);
    cpu.step(); // OUT SREG,R16 in the ISR.
    const ret = cpu.step();
    assert.equal(ret.mnemonic, 'RETI');
    assert.equal(ret.after.sreg, sreg);
    assert.equal(ret.after.cycles - ret.before.cycles, 5);
    assert.equal(pmic.status, 0);
  }
});

test('PMIC CLI masks immediately and SEI postpones dispatch for one full multicycle instruction', () => {
  let asserted = false;
  const { cpu } = attached([[0,[0x94f8,0x9478,0x9601,0]], [0x5c,[0x9518]]], [() => asserted ? low : null]);
  cpu.write(CTRL, 1); cpu.sreg = 0xb5;
  assert.equal(cpu.step().mnemonic, 'CLI');
  assert.equal(cpu.sreg, 0x35);
  asserted = true;
  assert.equal(cpu.step().mnemonic, 'SEI');
  assert.equal(cpu.sreg, 0xb5);
  const adiw = cpu.step();
  assert.equal(adiw.mnemonic, 'ADIW');
  assert.equal(adiw.after.cycles - adiw.before.cycles, 2);
  assert.equal(entry(cpu, 0x5c).returnPcWord, 3);
  assert.equal(decodeAt(cpu,0).mnemonic, 'CLI');
  assert.equal(decodeAt(cpu,1).mnemonic, 'SEI');
  assert.equal(decodeAt(cpu,0x5c).mnemonic, 'RETI');
});

test('PMIC defers interrupts during both CCP signatures and the four-instruction SPL update window', () => {
  const out = a => 0xb900 | ((a & 0x30) << 5) | (a & 15); // OUT A,R16.
  for (const [address,value,following] of [
    [0x34,0xd8,[0,0,0,0]], [0x34,0x9d,[0x9601,0x9601]], [0x3d,0xff,[0x9601,0,0x9601,0]],
  ]) {
    for (const early of [false, true]) {
      let asserted = false;
      const tail = early ? [out(0x3b)] : following;
      const { cpu } = attached([[0,[out(address),...tail,0]], [0x5c,[0x9518]]], [() => asserted ? low : null]);
      cpu.sreg = 0x80; cpu.r[16] = value; cpu.write(CTRL, 1);
      assert.equal(cpu.step().mnemonic, 'OUT');
      asserted = true;
      for (const _ of tail) assert.equal(cpu.step().eventType, 'instruction');
      assert.equal(entry(cpu, 0x5c).returnPcWord, 1 + tail.length);
    }
  }
});

test('PMIC honors protected IVSEL and stops before a cross-section transfer with unknown lock permissions', () => {
  for (const [writeCycle, relocated] of [[4,true],[5,false]]) {
    const { cpu } = attached([[0x20010,[0]], [0x2005c,[0x9518]]], [() => low]);
    cpu.write(0x34,0xd8,0); cpu.write(CTRL,0x41,writeCycle);
    assert.equal(cpu.read(CTRL,writeCycle), relocated ? 0x41 : 1);
    cpu.cycles = writeCycle; cpu.sreg = 0x80; cpu.pc = 0x20010;
    if (relocated) {
      assert.equal(entry(cpu,0x2005c).returnPcWord, 0x20010);
      assert.equal(cpu.step().after.pcWord, 0x20010);
      cpu.write(CTRL,1); assert.equal(cpu.read(CTRL),0x41);
    } else {
      const before = cpu.state();
      assert.throws(() => cpu.step(), { classification: 'PMIC_CROSS_SECTION_LOCK_UNKNOWN' });
      assert.deepEqual(cpu.state(), before);
    }
  }
});

test('PMIC strict frame failures preserve PC, SP, SRAM and active levels', () => {
  const { cpu, pmic } = attached([[0,[0x9518]], [0x5c,[0x9518]]], [() => low]);
  assert.throws(() => cpu.step(), { classification: 'RETI_WITHOUT_ACTIVE_INTERRUPT' });
  cpu.write(CTRL,1); cpu.sreg = 0x80; cpu.sp = 0x2001;
  const before = cpu.state();
  assert.throws(() => cpu.step(), e => e.trace.instructionAttempted === false && e.trace.opcode === null && /stack overflow/.test(e.message));
  assert.deepEqual(cpu.state(), before); assert.equal(pmic.status, 0);
  assert.ok(cpu.sram.every(v => v === 0xa5));
  cpu.sp = 0x2002;
  entry(cpu,0x5c);
  assert.equal(cpu.sp,0x1fff);
  cpu.sram[0] = 3; // Stacked word PC 0x030000 is outside A3 flash.
  const corrupt = cpu.state();
  assert.throws(() => cpu.step(), /PC target outside/);
  assert.deepEqual(cpu.state(), corrupt);
  assert.equal(pmic.status, 1);
  cpu.sram[0] = 0;
  assert.equal(cpu.step().after.sp,0x2002);
});

test('PMIC discovery distinguishes entry faults, vector fetch holes and RET used on an interrupt frame', () => {
  const foreground = [0xe001,0x9300,CTRL,0x9478,0,0];
  for (const mode of ['stack','hole','ret']) {
    const blocks = mode === 'ret' ? [[0,foreground],[0x5c,[0x9508]]] : [[0,foreground]];
    const { cpu, pmic } = attached(blocks, [() => low]);
    if (mode === 'stack') cpu.sp = 0x2001;
    const result = discover(cpu);
    const stop = result.firstBlockingEvent;
    if (mode === 'stack') {
      assert.equal(stop.classification,'INVALID_STACK_ACCESS');
      assert.equal(stop.instructionAttempted,false);
      assert.equal(stop.mnemonic,'INTERRUPT_ENTRY');
      assert.equal(stop.opcode,null);
      assert.equal(result.attemptedInstructions,4);
    } else if (mode === 'hole') {
      assert.equal(stop.classification,'FLASH_HOLE');
      assert.equal(stop.pcWord,0x5c);
      assert.equal(result.attemptedInstructions,5);
      assert.equal(result.callStack[0].frameKind,'interrupt');
    } else {
      assert.equal(stop.classification,'CALL_STACK_MISMATCH');
      assert.equal(stop.instructionCompleted,true);
      assert.equal(stop.mnemonic,'RET');
      assert.equal(pmic.status,1); // An ordinary RET has no PMIC EOI side effect.
    }
  }
});
