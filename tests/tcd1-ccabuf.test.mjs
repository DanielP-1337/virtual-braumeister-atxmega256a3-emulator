import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCD1Period } from '../src/peripherals/tcd1-period.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';
import { TC0WaveformControl } from '../src/peripherals/tc0-ctrlb.mjs';

// Independent absolute data addresses and masks from ATxmega256A3.atdf and XMEGA A sections 3.11 and 14.5.
const FCLR = 0x0948, FSET = 0x0949, GCLR = 0x094a, GSET = 0x094b, TEMP = 0x094f;
const PER = 0x0966, CCA = 0x0968, BUF = 0x0978, VALID = 2, LOCK = 2, UPDATE = 4;
const mapped = [FCLR,FSET,GCLR,GSET,TEMP,PER,PER+1,CCA,CCA+1,BUF,BUF+1];

function fixture(words = [], record = false) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  words.forEach((word, i) => { flash[i * 2] = word & 255; flash[i * 2 + 1] = word >>> 8; });
  present.fill(1, 0, 2 * words.length);
  const cpu = new XmegaCPU({ flash, present }), timer = new TCD1Period(), events = [];
  timer.register(cpu.bus.mmio, {
    mapCompareA: true, context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (reason, details) => cpu.fault(reason, details),
    onCompareAccess: record ? event => events.push(event) : null,
  });
  return { cpu, bus: cpu.bus, timer, events };
}

function writeWord(bus, low, word, cycle = 0) {
  bus.write(low, word % 256, cycle);
  bus.write(low + 1, Math.floor(word / 256), cycle);
}

function readWord(bus, low, cycle = 0) {
  return bus.read(low, cycle) + 256 * bus.read(low + 1, cycle);
}

test('TCD1 CCABUF resets both words and both G aliases and maps only verified TC1 addresses', () => {
  const { bus, timer } = fixture();
  assert.deepEqual([...bus.mmio.handlers.keys()].filter(n => n >= 0x0940).sort((a,b) => a-b), mapped);
  assert.deepEqual([bus.read(TEMP),bus.read(BUF+1),readWord(bus,BUF),readWord(bus,CCA),bus.read(FCLR),bus.read(FSET),bus.read(GCLR),bus.read(GSET)], Array(8).fill(0));
  assert.deepEqual(timer.snapshotPeriod(), { per: 65535, temp: 0 });
  const excluded = [0x0940, 0x0941, 0x0947, 0x094c, 0x0960, 0x096a, 0x0976, 0x097a, 0x097b, 0x097c, 0x097e];
  for (const a of excluded) for (const k of ['read','write']) {
    assert.throws(() => k === 'write' ? bus.write(a, 0) : bus.read(a), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === a && e.accessKind === k);
  }
  const legacy = new MMIORegistry();
  new TCD1Period().register(legacy);
  assert.deepEqual([...legacy.handlers.keys()], [TEMP,PER,PER+1]);
});

test('TCD1 CCABUF stages and commits every 16-bit word and transfers it to active CCA once under CPU UPDATE', () => {
  const { bus, cpu } = fixture();
  let active = 0;
  for (let word = 0; word < 65536; word++) {
    const low = word % 256, high = Math.floor(word / 256);
    bus.write(BUF, low);
    assert.equal(bus.read(TEMP), low);
    assert.equal(bus.read(GCLR), 0);
    bus.write(BUF+1, high);
    assert.equal(bus.read(GSET), VALID);
    assert.equal(readWord(bus, BUF), word);
    assert.equal(readWord(bus, CCA), active);
    assert.equal(bus.read(GCLR), VALID);
    bus.write(FSET, UPDATE);
    assert.equal(readWord(bus, CCA), word);
    assert.equal(readWord(bus, BUF), word);
    assert.equal(bus.read(GSET), 0);
    active = word;
    cpu.accesses.length = 0;
  }
  writeWord(bus, CCA, 0x39e4);
  bus.write(FSET, UPDATE);
  assert.equal(readWord(bus, CCA), 0x39e4);
});

test('TCD1 CCABUF shares TEMP with CCA and PER and low-byte staging preserves a previously valid word', () => {
  const { bus } = fixture();
  bus.write(BUF+1, 0x37); // A high-first write consumes reset TEMP.
  assert.deepEqual([readWord(bus, BUF), bus.read(GSET)], [0x3700, VALID]);
  writeWord(bus, CCA, 0x194f);
  bus.write(BUF, 0x63); bus.write(PER, 0xb8); bus.write(BUF+1, 0x4d);
  assert.deepEqual([readWord(bus, BUF), readWord(bus, CCA), bus.read(GSET)], [0x4db8,0x194f,VALID]);
  bus.write(BUF, 0x71); bus.write(FSET, UPDATE);
  assert.deepEqual([bus.read(TEMP), bus.read(GCLR)], [0x71,0]);
  bus.write(BUF+1, 0x82);
  assert.deepEqual([readWord(bus, CCA), readWord(bus, BUF)], [0x4db8,0x8271]);
  assert.equal(bus.read(CCA), 0xb8); // Captures active high byte into local TEMP.
  assert.equal(bus.read(BUF+1), 0x4d);
  bus.write(BUF+1, 0xa6);
  assert.equal(readWord(bus, BUF), 0xa64d);
  bus.write(TEMP, 0xee); bus.write(CCA+1, 0x29);
  assert.deepEqual([readWord(bus, CCA), readWord(bus, PER), bus.read(GCLR)], [0x29ee,0xffff,VALID]);
});

test('TCD1 CCABUF aliases cancel or revalidate the retained buffer and zero is a valid compare value', () => {
  const { bus } = fixture();
  writeWord(bus, CCA, 0xc539); writeWord(bus, BUF, 0x4671);
  bus.write(GCLR, 0); bus.write(GSET, 0);
  assert.equal(bus.read(GCLR), VALID);
  bus.write(GCLR, VALID); bus.write(FSET, UPDATE);
  assert.deepEqual([readWord(bus, CCA), readWord(bus, BUF), bus.read(GSET)], [0xc539,0x4671,0]);
  bus.write(GSET, VALID); bus.write(FSET, UPDATE);
  assert.deepEqual([readWord(bus, CCA), bus.read(GCLR)], [0x4671,0]);
  bus.write(BUF, 0); assert.equal(bus.read(GSET), 0);
  bus.write(BUF+1, 0); assert.equal(bus.read(GCLR), VALID);
  bus.write(FSET, UPDATE); assert.deepEqual([readWord(bus, CCA), bus.read(GSET)], [0,0]);
});

test('TCD1 CCABUF lock gates software and peripheral UPDATE and unlocking waits for the next condition', () => {
  const { bus, timer } = fixture();
  writeWord(bus, CCA, 0x1a57); writeWord(bus, BUF, 0x2458);
  bus.write(FSET, LOCK); timer.compare.update(); bus.write(FSET, UPDATE);
  assert.deepEqual([readWord(bus, CCA), bus.read(GSET), bus.read(FCLR), bus.read(FSET)], [0x1a57,VALID,LOCK,LOCK]);
  writeWord(bus, BUF, 0x6e14); bus.write(FCLR, LOCK); bus.write(FCLR, UPDATE);
  assert.deepEqual([readWord(bus, CCA), readWord(bus, BUF), bus.read(GCLR)], [0x1a57,0x6e14,VALID]);
  bus.write(TEMP, 0xe3);
  timer.compare.update(); // An explicit synthetic TCD1 UPDATE condition.
  assert.deepEqual([bus.read(TEMP), readWord(bus, CCA), bus.read(GCLR)], [0xe3,0x6e14,0]);
  writeWord(bus, CCA, 0x9bd2); timer.compare.update();
  assert.deepEqual([readWord(bus, CCA), readWord(bus, BUF), bus.read(FSET)], [0x9bd2,0x6e14,0]);
});

test('TCD1 CCABUF classifies TC1 buffer-valid bits for every alias write and faults atomically on absent models', () => {
  const { bus } = fixture();
  for (const addr of [GCLR,GSET]) for (let value = 0; value < 256; value++) {
    const initiallyValid = addr === GCLR;
    bus.write(initiallyValid ? GSET : GCLR, VALID);
    if (value & 0x05) {
      assert.throws(() => bus.write(addr, value), e => e.classification === 'TCD1_BUFFER_FLAGS_UNMODELED' && e.addressByte === addr && e.attemptedValue === value);
      assert.equal(bus.read(GSET), initiallyValid ? VALID : 0);
    } else {
      bus.write(addr, value);
      const wanted = value & VALID ? !initiallyValid : initiallyValid;
      assert.deepEqual([bus.read(GSET),bus.read(GCLR)], [wanted ? VALID : 0,wanted ? VALID : 0]);
    }
  }
  writeWord(bus, BUF, 0x5193); bus.write(FCLR, LOCK);
  for (const [value, classification] of [[3,'TCD1_DIRECTION_UNMODELED'],[10,'TCD1_COMMAND_UNMODELED'],[14,'TCD1_COMMAND_UNMODELED']]) {
    assert.throws(() => bus.write(FSET, value), e => e.classification === classification);
    assert.deepEqual([bus.read(FSET),bus.read(GSET),readWord(bus,CCA)], [0,VALID,0]);
  }
});

test('TCD1 CCABUF is isolated from the running D0 counter, its pending buffers and its BOTTOM event', () => {
  const { bus } = fixture();
  const d0 = new TC0Counter('TCD0'), clock = new TC0Clock('TCD0', { counter: d0 });
  d0.register(bus.mmio, { mapPeriod: true, mapCompareC: true, mapCompareD: true });
  clock.register(bus.mmio);
  new TC0WaveformControl('TCD0', { clock }).register(bus.mmio);
  writeWord(bus, 0x0926, 3); writeWord(bus, 0x093c, 0x3456); writeWord(bus, 0x093e, 0x789a);
  bus.write(0x0926,0x5d); bus.write(0x0901,0xc3); bus.write(0x0900,1);
  writeWord(bus, CCA, 0x1133); writeWord(bus, BUF, 0x8246); bus.write(BUF,0x9e);
  clock.advanceTo(3);
  assert.deepEqual([d0.cnt,d0.temp,bus.read(0x090a,3),bus.read(GCLR,3)], [3,0x5d,0x18,VALID]);
  clock.advanceTo(4);
  assert.deepEqual([d0.cnt,d0.temp,d0.compare.ccc,d0.compare.ccd,bus.read(0x090a,4),bus.read(TEMP,4)], [0,0x5d,0x3456,0x789a,0,0x9e]);
  assert.deepEqual([readWord(bus,CCA,4),bus.read(GCLR,4)], [0x1133,VALID]);
  writeWord(bus, 0x093c, 0x71e4,4); bus.write(FSET,UPDATE,4);
  assert.deepEqual([readWord(bus,CCA,4),bus.read(GSET,4),d0.compare.ccc,bus.read(0x090a,4),d0.per], [0x8246,0,0x3456,8,3]);
});

test('TCD1 CCABUF reset clears pending data, lock and TEMP while keeping its mapped registers usable', () => {
  const { bus, timer } = fixture();
  writeWord(bus, CCA, 0x1356); writeWord(bus, BUF, 0xab47); writeWord(bus, PER, 0x025a); bus.write(FSET, LOCK); bus.write(BUF,0xf4);
  timer.reset();
  assert.deepEqual([bus.read(TEMP),bus.read(FCLR),bus.read(GCLR),readWord(bus,CCA),readWord(bus,BUF),readWord(bus,PER)], [0,0,0,0,0,0xffff]);
  writeWord(bus, BUF, 0x4021); bus.write(FSET, UPDATE);
  assert.deepEqual([readWord(bus,CCA),bus.read(GSET)], [0x4021,0]);
});

test('TCD1 CCABUF preflights collisions at every claimed byte and leaves the entire registry untouched on failure', () => {
  for (const address of mapped) {
    const registry = new MMIORegistry(), timer = new TCD1Period(), sentinel = { read: () => 0x3c };
    registry.map(address, sentinel);
    assert.throws(() => timer.register(registry, { mapCompareA: true }), /collision/);
    assert.deepEqual([...registry.handlers], [[address,sentinel]]);
    const fresh = new MMIORegistry();
    timer.register(fresh, { mapCompareA: true });
    const other = new MMIORegistry();
    assert.throws(() => timer.register(other, { mapCompareA: true }), /collision/);
    assert.equal(other.handlers.size, 0);
  }
});

test('TCD1 CCABUF synthetic AVR stores, flag reads and UPDATE replay before a precise unmapped B-channel fault', () => {
  // Y-displacement forms encode q as q5:q4:q3:q2:q1:q0 in three separate opcode fields.
  function op(store, reg, q) { return (store ? 0x8208 : 0x8008) | (reg << 4) | ((q & 32) << 8) | ((q & 24) << 7) | (q & 7); }
  function run() {
    const words = [op(true,17,56),op(true,20,57),op(false,21,10),op(true,22,9),op(false,23,40),op(false,24,41),op(true,17,58)];
    const { cpu, events } = fixture(words, true);
    cpu.setPair(28, 0x0940); cpu.r[17]=0x3c; cpu.r[20]=0x7e; cpu.r[22]=4; cpu.sreg=0xb5;
    const steps = words.slice(0,-1).map(() => cpu.step());
    assert.deepEqual(steps.map(s => s.mnemonic), ['STD','STD','LDD','STD','LDD','LDD']);
    assert.deepEqual(steps.map(s => [s.after.pcWord,s.after.cycles]), [[1,2],[2,4],[3,6],[4,8],[5,10],[6,12]]);
    assert.deepEqual([cpu.r[21],cpu.r[23],cpu.r[24],cpu.pair(28),cpu.sreg,cpu.sp], [2,0x3c,0x7e,0x0940,0xb5,0x5fff]);
    assert.deepEqual(events.map(e => [e.register,e.addressByte,e.value,e.cycle,e.after.ccabv,e.after.cca]), [
      ['CCABUFL',BUF,0x3c,2,false,0], ['CCABUFH',BUF+1,0x7e,4,true,0], ['CTRLGCLR',GCLR,2,6,true,0],
      ['CTRLFSET',FSET,4,8,false,0x7e3c], ['CCAL',CCA,0x3c,10,false,0x7e3c], ['CCAH',CCA+1,0x7e,12,false,0x7e3c],
    ]);
    assert.ok(events.every((e,i) => e.origin === 'peripheral-model' && e.peripheral === 'TCD1' && e.pcWord === i && e.instructionAttempt === i+1 && e.completed));
    const before = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x097a && e.attemptedValue === 0x3c);
    assert.deepEqual(cpu.state(), before); assert.equal(events.length, 6);
    return { steps, events };
  }
  assert.deepEqual(run(), run());
});
