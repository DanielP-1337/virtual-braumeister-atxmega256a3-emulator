import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';

// Independent ATxmega256A3 data-byte addresses and command values from the device pack and XMEGA A manual.
const CLK = 0x0900, FCLR = 0x0908, FSET = 0x0909, GCLR = 0x090a, GSET = 0x090b, TEMP = 0x090f;
const PER = 0x0926, C = 0x092c, D = 0x092e, CBUF = 0x093c, DBUF = 0x093e;
const C_VALID = 8, D_VALID = 16, BOTH = 24, LOCK = 2, UPDATE = 4;

function fixture({ mapC = true, mapD = true, words = [], record = false } = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const view = new DataView(flash.buffer);
  words.forEach((word, i) => view.setUint16(i * 2, word, true));
  present.fill(1, 0, words.length * 2);
  const cpu = new XmegaCPU({ flash, present }), bus = cpu.bus, events = [];
  const timer = new TC0Counter('TCD0'), clock = new TC0Clock('TCD0', { counter: timer });
  const fault = (message, details) => cpu.fault(message, details);
  timer.register(bus.mmio, { mapCounter: false, mapPeriod: true, mapCompareC: mapC, mapCompareD: mapD,
    onCompareAccess: record ? e => events.push(e) : null, context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }), fault });
  clock.register(bus.mmio, { fault });
  return { cpu, bus, events, timer, clock };
}

function writeWord(bus, address, word, cycle = 0) {
  bus.write(address, word % 256, cycle);
  bus.write(address + 1, Math.floor(word / 256), cycle);
}

function readWord(bus, address, cycle = 0) {
  const lower = bus.read(address, cycle);
  return lower + 256 * bus.read(address + 1, cycle);
}

test('TCD0 CCDBUF maps exactly the selected channels and resets D, its own active word and both flags', () => {
  const { bus, timer } = fixture();
  assert.deepEqual([readWord(bus, D), readWord(bus, DBUF), readWord(bus, C), bus.read(GCLR), bus.read(FSET)], [0, 0, 0, 0, 0]);
  const other = fixture({ mapC: false }).bus;
  writeWord(other, DBUF, 0x27ac);
  assert.equal(other.read(GSET), D_VALID);
  other.write(FSET, UPDATE);
  assert.equal(readWord(other, D), 0x27ac);
  for (const address of [C, C + 1, CBUF, CBUF + 1, 0x083e, 0x093b, 0x0940, 0x0901]) {
    for (const kind of ['read', 'write']) assert.throws(() => kind === 'write' ? other.write(address, 0) : other.read(address),
      e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === address && e.accessKind === kind);
  }
  assert.throws(() => other.write(GSET, BOTH), e => e.classification === 'TCD0_BUFFER_FLAGS_UNMODELED');
  writeWord(bus, C, 0x1337); writeWord(bus, DBUF, 0xa541); bus.write(FSET, LOCK); bus.write(CLK, 1);
  timer.reset(5);
  assert.deepEqual([readWord(bus, C, 5), readWord(bus, D, 5), readWord(bus, DBUF, 5), bus.read(GSET, 5),
    bus.read(TEMP, 5), bus.read(FCLR, 5), bus.read(CLK, 5)], [0, 0, 0, 0, 0, 0, 0]);
});

test('TCD0 CCDBUF stages and commits all 65536 D words with independent active and buffer readback', () => {
  const { bus, cpu } = fixture();
  writeWord(bus, C, 0xc531);
  let lastActive = 0;
  for (let expected = 0; expected <= 65535; expected++) {
    const low = expected % 256, high = Math.floor(expected / 256);
    bus.write(DBUF, low);
    assert.equal(bus.read(TEMP), low);
    assert.equal(bus.read(GSET), 0);
    bus.write(DBUF + 1, high);
    assert.equal(bus.read(GCLR), D_VALID);
    assert.equal(readWord(bus, DBUF), expected);
    assert.equal(readWord(bus, D), lastActive);
    bus.write(FSET, UPDATE);
    assert.equal(readWord(bus, D), expected);
    assert.equal(readWord(bus, DBUF), expected);
    assert.equal(readWord(bus, C), 0xc531);
    assert.equal(bus.read(GSET), 0);
    cpu.accesses.length = 0;
    lastActive = expected;
  }
});

test('TCD0 CCDBUF shares TEMP with CCC and PER while leaving the other timer and both active words independent', () => {
  const { bus } = fixture();
  new TC0Counter('TCC0').register(bus.mmio, { mapPeriod: true });
  bus.write(0x0826, 0x91);
  bus.write(DBUF, 0x45); bus.write(CBUF, 0x6e); bus.write(DBUF + 1, 0xbb);
  bus.write(PER, 0x51); bus.write(CBUF + 1, 0x3a);
  assert.deepEqual([readWord(bus, DBUF), readWord(bus, CBUF), readWord(bus, D), readWord(bus, C)], [0xbb6e, 0x3a51, 0, 0]);
  assert.equal(bus.read(DBUF), 0x6e); // Latch D's buffered high byte into the common D0 TEMP.
  bus.write(C + 1, 0x54);
  assert.equal(readWord(bus, C), 0x54bb);
  bus.write(D, 0xfd); bus.write(D + 1, 0x81);
  assert.deepEqual([readWord(bus, D), bus.read(GSET)], [0x81fd, BOTH]);
  bus.write(0x0827, 0x20);
  assert.equal(readWord(bus, 0x0826), 0x2091);
});

test('TCD0 CCDBUF sets and clears every C and D valid-mask combination without cross-channel effects', () => {
  const { bus } = fixture();
  for (const initial of [0, C_VALID, D_VALID, BOTH]) {
    for (const mask of [0, C_VALID, D_VALID, BOTH]) {
      bus.write(GCLR, BOTH); bus.write(GSET, initial); bus.write(GCLR, mask);
      assert.deepEqual([bus.read(GCLR), bus.read(GSET)], [initial & ~mask, initial & ~mask]);
      bus.write(GCLR, BOTH); bus.write(GSET, initial); bus.write(GSET, mask);
      assert.deepEqual([bus.read(GCLR), bus.read(GSET)], [initial | mask, initial | mask]);
    }
  }
  bus.write(GCLR, BOTH); writeWord(bus, DBUF, 0);
  assert.equal(bus.read(GSET), D_VALID); // A high-byte commit of the reset value still sets CCDBV.
  bus.write(GSET, 0xe0); bus.write(GCLR, 0xe0);
  assert.equal(bus.read(GCLR), D_VALID);
});

test('TCD0 CCDBUF software UPDATE copies exactly the selected valid channels and retains both buffer words', () => {
  const { bus } = fixture();
  for (const flags of [0, C_VALID, D_VALID, BOTH]) {
    writeWord(bus, C, 0x1234); writeWord(bus, D, 0x5678);
    writeWord(bus, CBUF, 0x9abc); writeWord(bus, DBUF, 0xdef0);
    bus.write(GCLR, BOTH); bus.write(GSET, flags); bus.write(TEMP, 0xdf);
    bus.write(FSET, UPDATE);
    assert.equal(bus.read(TEMP), 0xdf);
    assert.deepEqual([readWord(bus, C), readWord(bus, D), bus.read(GCLR)],
      [flags & C_VALID ? 0x9abc : 0x1234, flags & D_VALID ? 0xdef0 : 0x5678, 0]);
    assert.deepEqual([readWord(bus, CBUF), readWord(bus, DBUF)], [0x9abc, 0xdef0]);
    writeWord(bus, D, 0x7524); bus.write(FSET, UPDATE);
    assert.equal(readWord(bus, D), 0x7524);
  }
});

test('TCD0 CCDBUF both channels transfer on one unlocked divided-clock TOP and ignore locked TOP and force UPDATE', () => {
  const { bus, timer } = fixture();
  writeWord(bus, PER, 3); writeWord(bus, C, 0x1357); writeWord(bus, D, 0x2468);
  writeWord(bus, CBUF, 0x5aa5); writeWord(bus, DBUF, 0x7be1);
  bus.write(FSET, LOCK); bus.write(CLK, 3); // Divide by four, with TOP on bus cycles 12 and 28.
  bus.write(FSET, UPDATE, 12);
  assert.deepEqual([readWord(bus, C, 12), readWord(bus, D, 12), bus.read(GSET, 12), timer.cnt], [0x1357, 0x2468, BOTH, 3]);
  bus.write(FCLR, LOCK, 13);
  assert.deepEqual([bus.read(GCLR, 27), readWord(bus, D, 27), timer.cnt], [BOTH, 0x2468, 2]);
  assert.deepEqual([readWord(bus, C, 28), readWord(bus, D, 28), bus.read(GSET, 28), timer.cnt], [0x5aa5, 0x7be1, 0, 3]);
});

test('TCD0 CCDBUF keeps a coincident D high-byte write pending after both prior words transfer at TOP', () => {
  const { bus } = fixture();
  writeWord(bus, PER, 2); writeWord(bus, CBUF, 0xc901); writeWord(bus, DBUF, 0xd902); bus.write(CLK, 1);
  bus.write(DBUF, 0x77, 1); bus.write(DBUF + 1, 0x66, 2);
  assert.deepEqual([readWord(bus, C, 2), readWord(bus, D, 2), readWord(bus, DBUF, 2), bus.read(GSET, 2)],
    [0xc901, 0xd902, 0x6677, D_VALID]);
  assert.deepEqual([readWord(bus, D, 5), bus.read(GCLR, 5)], [0x6677, 0]);
});

test('TCD0 CCDBUF rejects unmodeled flag combinations and colliding addresses before changing either channel', () => {
  const { bus, clock, timer } = fixture();
  writeWord(bus, CBUF, 0xf081); writeWord(bus, DBUF, 0xc721); bus.write(CLK, 1);
  const saved = [timer.compare.snapshot(), timer.compare.snapshotD()];
  for (const reg of [GSET, GCLR]) for (const unknown of [1, 2, 4]) {
    assert.throws(() => bus.write(reg, BOTH | unknown, 17), e => e.classification === 'TCD0_BUFFER_FLAGS_UNMODELED');
    assert.deepEqual([timer.compare.snapshot(), timer.compare.snapshotD()], saved);
    assert.equal(clock.lastCycle, 0);
  }
  for (const address of [D, D + 1, DBUF, DBUF + 1, GCLR]) {
    const registry = new MMIORegistry(), reserved = { read: () => 3 }, instance = new TC0Counter('TCD0');
    registry.map(address, reserved);
    assert.throws(() => instance.register(registry, { mapCompareC: true, mapCompareD: true }), /collision/);
    assert.deepEqual([...registry.handlers], [[address, reserved]]);
    assert.equal(instance.compare, undefined);
  }
});

test('TCD0 CCDBUF replays real STS, valid reads and a force UPDATE before an unhandled neighboring register', () => {
  function run() {
    const { cpu, events } = fixture({ words: [0x9320, 0x093e, 0x9330, 0x093f, 0x8562, 0x8711, 0xa546, 0xa557, 0x8573, 0x9360, 0x0901, 0], record: true });
    cpu.setPair(30, 0x0900); cpu.r[18] = 0x74; cpu.r[19] = 0xa2; cpu.r[17] = UPDATE; cpu.sreg = 0x75;
    const steps = Array.from({ length: 7 }, () => cpu.step());
    assert.deepEqual(steps.map(t => t.mnemonic), ['STS', 'STS', 'LDD', 'STD', 'LDD', 'LDD', 'LDD']);
    assert.deepEqual(steps.map(t => t.after.pcWord), [2, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(steps.map(t => t.after.cycles), [2, 4, 6, 8, 10, 12, 14]);
    assert.deepEqual([cpu.r[20], cpu.r[21], cpu.r[22], cpu.r[23], cpu.pair(30), cpu.sp, cpu.sreg], [0x74, 0xa2, D_VALID, 0, 0x900, 0x5fff, 0x75]);
    assert.deepEqual(events.map(e => e.register), ['CCDBUFL', 'CCDBUFH', 'CTRLGCLR', 'CTRLFSET', 'CCDL', 'CCDH', 'CTRLGSET']);
    assert.deepEqual(events.map(e => e.addressByte), [DBUF, DBUF + 1, GCLR, FSET, D, D + 1, GSET]);
    assert.ok(events.every(e => e.completed && e.origin === 'peripheral-model'));
    assert.deepEqual([events[1].after.cccbv, events[1].after.ccdbv, events[3].after.ccd], [false, true, 0xa274]);
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x0901 && e.attemptedValue === D_VALID);
    assert.deepEqual(cpu.state(), before);
    return { steps, events };
  }
  assert.deepEqual(run(), run());
});
