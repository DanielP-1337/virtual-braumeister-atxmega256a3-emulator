import assert from 'node:assert/strict';
import test from 'node:test';
import { XmegaCPU } from '../src/xmega.mjs';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TCD1Period } from '../src/peripherals/tcd1-period.mjs';
import { TC0Counter } from '../src/peripherals/tc0-counter.mjs';
import { TC0Clock } from '../src/peripherals/tc0-clock.mjs';
import { TC0WaveformControl } from '../src/peripherals/tc0-ctrlb.mjs';

// Absolute byte addresses and bit masks from ATxmega256A3.atdf and XMEGA A sections 3.11 and 14.5.
const FCLR = 0x0948, FSET = 0x0949, GCLR = 0x094a, GSET = 0x094b, TEMP = 0x094f;
const PER = 0x0966, CCA = 0x0968, CCB = 0x096a, ABUF = 0x0978, BBUF = 0x097a;
const AV = 0x02, BV = 0x04, LOCK = 0x02, UPDATE = 0x04;

function fixture({ words = [], mapA = true, mapB = true, record = false } = {}) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const view = new DataView(flash.buffer);
  words.forEach((word, i) => view.setUint16(2 * i, word, true));
  present.fill(1, 0, 2 * words.length);
  const cpu = new XmegaCPU({ flash, present }), timer = new TCD1Period(), events = [];
  timer.register(cpu.bus.mmio, {
    mapCompareA: mapA, mapCompareB: mapB,
    context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (reason, details) => cpu.fault(reason, details),
    onCompareAccess: record ? event => events.push(event) : null,
  });
  return { cpu, bus: cpu.bus, timer, events };
}

function put(bus, address, word, cycle = 0) {
  bus.write(address, word % 256, cycle);
  bus.write(address + 1, Math.floor(word / 256), cycle);
}

function get(bus, address, cycle = 0) {
  return bus.read(address, cycle) + 256 * bus.read(address + 1, cycle);
}

test('TCD1 CCBBUF registers B independently, resets both bytes and leaves unsupported TC1 addresses unmapped', () => {
  for (const [mapA, mapB] of [[false,false],[true,false],[false,true],[true,true]]) {
    const { bus } = fixture({ mapA, mapB });
    const expected = [TEMP, PER, PER + 1];
    if (mapA || mapB) expected.push(FCLR, FSET, GCLR, GSET);
    if (mapA) expected.push(CCA, CCA + 1, ABUF, ABUF + 1);
    if (mapB) expected.push(CCB, CCB + 1, BBUF, BBUF + 1);
    assert.deepEqual([...bus.mmio.handlers.keys()].filter(a => a >= 0x0940).sort((a,b) => a-b), expected.sort((a,b) => a-b));
    if (mapB) {
      assert.deepEqual([bus.read(BBUF + 1), get(bus, BBUF), get(bus, CCB), bus.read(GSET), bus.read(FCLR)], [0,0,0,0,0]);
      bus.write(BBUF + 1, 0x73); // A high-first write uses reset TEMP.
      assert.deepEqual([get(bus, BBUF), get(bus, CCB), bus.read(GCLR)], [0x7300,0,BV]);
      bus.write(FSET, UPDATE);
      assert.deepEqual([get(bus, CCB), bus.read(GSET)], [0x7300,0]);
    }
    for (const address of [0x0941,0x094c,0x096c,0x096e,0x0976,0x097c,0x097e]) {
      assert.throws(() => bus.read(address), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === address);
      assert.throws(() => bus.write(address, 0), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === address);
    }
  }
});

test('TCD1 CCBBUF stages and commits all 65536 words and transfers only B when A has no valid data', () => {
  const { bus, cpu, timer } = fixture();
  put(bus, CCA, 0x29c7); put(bus, ABUF, 0xa74d); bus.write(GCLR, AV);
  let previous = 0;
  for (let word = 0; word <= 0xffff; word++) {
    const low = word % 256, high = Math.floor(word / 256);
    bus.write(BBUF, low);
    assert.equal(bus.read(TEMP), low);
    assert.equal(timer.snapshotCompareB().ccbbuf, previous);
    assert.equal(bus.read(GSET), 0);
    bus.write(BBUF + 1, high);
    assert.deepEqual([bus.read(GCLR), get(bus, BBUF), get(bus, CCB)], [BV, word, previous]);
    bus.write(FSET, UPDATE);
    assert.equal(get(bus, CCB), word);
    assert.equal(get(bus, BBUF), word);
    assert.equal(bus.read(GSET), 0);
    assert.equal(get(bus, CCA), 0x29c7);
    assert.equal(get(bus, ABUF), 0xa74d);
    previous = word;
    cpu.accesses.length = 0;
  }
});

test('TCD1 CCBBUF UPDATE transfers exactly the valid channels for every A and B flag combination and either write order', () => {
  for (const valid of [0, AV, BV, AV | BV]) for (const bFirst of [true, false]) {
    const { bus } = fixture();
    put(bus, CCA, 0x193e); put(bus, CCB, 0x640d);
    if (bFirst) { put(bus, BBUF, 0x82a7); put(bus, ABUF, 0x15c3); }
    else { put(bus, ABUF, 0x15c3); put(bus, BBUF, 0x82a7); }
    assert.equal(bus.read(GSET), AV | BV);
    bus.write(GCLR, AV | BV); bus.write(GSET, valid);
    assert.equal(bus.read(GCLR), valid);
    bus.write(FSET, UPDATE);
    assert.deepEqual([get(bus, CCA), get(bus, CCB), get(bus, ABUF), get(bus, BBUF), bus.read(GSET)],
      [valid & AV ? 0x15c3 : 0x193e, valid & BV ? 0x82a7 : 0x640d, 0x15c3, 0x82a7, 0]);
    put(bus, CCA, 0x3412); put(bus, CCB, 0x7856); bus.write(FSET, UPDATE);
    assert.deepEqual([get(bus, CCA), get(bus, CCB)], [0x3412,0x7856]);
  }
});

test('TCD1 CCBBUF uses the same TEMP as A and PER while active words and buffers retain separate values', () => {
  const { bus } = fixture();
  put(bus, CCA, 0xa14c); put(bus, CCB, 0x602b);
  bus.write(BBUF, 0x11); bus.write(ABUF, 0x27); bus.write(BBUF + 1, 0xa3);
  bus.write(ABUF, 0x3e); bus.write(BBUF, 0x58); bus.write(ABUF + 1, 0x9c);
  assert.deepEqual([get(bus, BBUF),get(bus, ABUF),bus.read(GSET)], [0xa327,0x9c58,AV | BV]);
  bus.write(BBUF, 0xed);
  assert.equal(bus.read(CCA), 0x4c); // Captures the A active high byte into TEMP.
  assert.equal(bus.read(BBUF + 1), 0xa1);
  bus.write(BBUF + 1, 0x76);
  assert.equal(get(bus, BBUF), 0x76a1);
  bus.write(PER, 0x69); bus.write(CCB + 1, 0xc5);
  assert.deepEqual([get(bus, CCB),get(bus, CCA),get(bus, PER),bus.read(GCLR)], [0xc569,0xa14c,0xffff,AV | BV]);
  bus.write(TEMP,0xbb); bus.write(ABUF + 1,0x4e);
  assert.deepEqual([get(bus, ABUF),get(bus, BBUF)], [0x4ebb,0x76a1]);
});

test('TCD1 CCBBUF keeps a pending word through a new low byte and sets only CCBBV for a subsequent zero commit', () => {
  const { bus } = fixture();
  put(bus, ABUF, 0x5381); put(bus, BBUF, 0x742d);
  bus.write(BBUF, 0);
  assert.equal(bus.read(GCLR), AV | BV);
  bus.write(FSET, UPDATE);
  assert.deepEqual([bus.read(TEMP),bus.read(GSET)], [0,0]);
  bus.write(BBUF + 1, 0); // The transfer left the staged replacement low byte intact.
  assert.deepEqual([get(bus, BBUF),get(bus, CCB),get(bus, CCA),bus.read(GCLR)], [0,0x742d,0x5381,BV]);
  bus.write(FSET, UPDATE);
  assert.deepEqual([get(bus, CCB),get(bus, CCA),get(bus, ABUF),bus.read(GSET)], [0,0x5381,0x5381,0]);
});

test('TCD1 CCBBUF G aliases independently set and clear A and B for all input bytes and reject unmodeled PERBV atomically', () => {
  const { bus } = fixture();
  for (const start of [0,AV,BV,AV | BV]) for (const address of [GCLR,GSET]) for (let value = 0; value < 256; value++) {
    bus.write(GCLR, AV | BV); bus.write(GSET, start);
    let expected = start;
    if (value & 1) {
      assert.throws(() => bus.write(address,value), e => e.classification === 'TCD1_BUFFER_FLAGS_UNMODELED' && e.addressByte === address && e.attemptedValue === value);
    } else {
      bus.write(address, value);
      const selected = value & (AV | BV);
      expected = address === GSET ? start | selected : start & ~selected;
    }
    assert.deepEqual([bus.read(GCLR),bus.read(GSET)], [expected,expected]);
  }
  const onlyB = fixture({ mapA:false }).bus;
  onlyB.write(GSET, BV);
  assert.throws(() => onlyB.write(GCLR, AV | BV), e => e.classification === 'TCD1_BUFFER_FLAGS_UNMODELED');
  assert.equal(onlyB.read(GSET), BV);
});

test('TCD1 CCBBUF lock is shared and clearing it waits for the next UPDATE with each channel independently eligible', () => {
  const { bus, timer } = fixture();
  put(bus, CCA, 0x193e); put(bus, CCB, 0x640d); put(bus, ABUF, 0x15c3); put(bus, BBUF, 0x82a7);
  bus.write(FSET, LOCK);
  bus.write(FSET, UPDATE); timer.compare.update(); // A separate synthetic hardware UPDATE.
  assert.deepEqual([get(bus, CCA),get(bus, CCB),bus.read(GSET),bus.read(FCLR)], [0x193e,0x640d,AV | BV,LOCK]);
  bus.write(GCLR, AV); put(bus, BBUF, 0x7ad2); bus.write(FCLR, LOCK); bus.write(FCLR, UPDATE);
  assert.deepEqual([get(bus, CCA),get(bus, CCB),bus.read(GCLR),bus.read(FSET)], [0x193e,0x640d,BV,0]);
  bus.write(TEMP,0xe4); timer.compare.update();
  assert.deepEqual([bus.read(TEMP),get(bus, CCA),get(bus, CCB),bus.read(GSET)], [0xe4,0x193e,0x7ad2,0]);
  bus.write(GSET,AV); bus.write(FSET,UPDATE);
  assert.deepEqual([get(bus, CCA),get(bus, CCB),bus.read(GSET)], [0x15c3,0x7ad2,0]);
});

test('TCD1 CCBBUF and CCABUF remain pending through an unrelated running TCD0 PWM update', () => {
  const { bus } = fixture();
  const d0 = new TC0Counter('TCD0'), clock = new TC0Clock('TCD0',{ counter:d0 });
  d0.register(bus.mmio,{ mapPeriod:true,mapCompareC:true,mapCompareD:true });
  clock.register(bus.mmio);
  new TC0WaveformControl('TCD0',{clock}).register(bus.mmio);
  put(bus,0x0926,3); put(bus,0x093c,0x3526); put(bus,0x093e,0x7189);
  bus.write(0x0926,0x5d); bus.write(0x0901,0xc3); bus.write(0x0900,1);
  put(bus,CCA,0x1234); put(bus,CCB,0x394a); put(bus,ABUF,0x8351); put(bus,BBUF,0x76a2);
  clock.advanceTo(4);
  assert.deepEqual([d0.cnt,d0.temp,d0.compare.ccc,d0.compare.ccd,bus.read(0x090a,4)], [0,0x5d,0x3526,0x7189,0]);
  assert.deepEqual([get(bus,CCA,4),get(bus,CCB,4),bus.read(GSET,4)], [0x1234,0x394a,AV | BV]);
  put(bus,0x093c,0xbe51,4); bus.write(GCLR,AV,4); bus.write(FSET,UPDATE,4);
  assert.deepEqual([get(bus,CCA,4),get(bus,CCB,4),d0.compare.ccc,bus.read(0x090a,4)], [0x1234,0x76a2,0x3526,8]);
});

test('TCD1 CCBBUF preflights collisions and reset clears both channels and lock while keeping the mapping', () => {
  for (const occupied of [GSET,CCB,CCB+1,BBUF,BBUF+1]) {
    const mmio = new MMIORegistry(), timer = new TCD1Period(), sentinel = { read:() => 1 };
    mmio.map(occupied,sentinel);
    assert.throws(() => timer.register(mmio,{ mapCompareA:true,mapCompareB:true }), /collision/);
    assert.deepEqual([...mmio.handlers],[[occupied,sentinel]]);
    assert.equal(timer.compare,undefined);
    const free = new MMIORegistry();
    timer.register(free,{ mapCompareA:true,mapCompareB:true });
    assert.ok(free.handlers.has(BBUF + 1));
  }
  const { bus,timer } = fixture();
  put(bus,CCA,0x1287); put(bus,CCB,0x248e); put(bus,ABUF,0x3535); put(bus,BBUF,0x6721); bus.write(FSET,LOCK); bus.write(BBUF,0x4c);
  timer.reset();
  assert.deepEqual([bus.read(TEMP),bus.read(FSET),bus.read(GCLR),get(bus,ABUF),get(bus,BBUF),get(bus,CCA),get(bus,CCB),get(bus,PER)],
    [0,0,0,0,0,0,0,0xffff]);
  put(bus,BBUF,0x734e); bus.write(FSET,UPDATE);
  assert.deepEqual([get(bus,CCB),get(bus,CCA),bus.read(GSET)], [0x734e,0,0]);
});

test('TCD1 CCBBUF synthetic AVR instructions transfer B alone, revalidate A, and replay before a precise CTRLB fault', () => {
  function insn(store, register, q) {
    return (store ? 0x8208 : 0x8008) | (register << 4) | ((q & 32) << 8) | ((q & 24) << 7) | (q & 7);
  }
  function run() {
    const words = [insn(true,16,56),insn(true,17,57),insn(true,18,58),insn(true,19,59),
      insn(false,23,10),insn(true,20,10),insn(true,21,9),insn(false,24,40),insn(false,25,41),
      insn(false,26,42),insn(false,27,43),insn(false,22,11),insn(true,20,11),insn(true,21,9),
      insn(false,2,40),insn(false,3,41),insn(true,18,1)];
    const { cpu,bus,events } = fixture({ words,record:true });
    put(bus,CCA,0x193e); put(bus,CCB,0x640d); events.length=0;
    cpu.setPair(28,0x0940); cpu.sreg=0xb5;
    cpu.r.set([0xc3,0x15,0xa7,0x82,AV,UPDATE],16);
    const steps=words.slice(0,-1).map(() => cpu.step());
    assert.deepEqual(steps.map(s => s.after.cycles),Array.from({length:16},(_,i) => 2*(i+1)));
    assert.deepEqual(steps.map(s => s.after.pcWord),Array.from({length:16},(_,i) => i+1));
    assert.deepEqual([cpu.r[23],cpu.r[24],cpu.r[25],cpu.r[26],cpu.r[27],cpu.r[22],cpu.r[2],cpu.r[3]], [AV | BV,0x3e,0x19,0xa7,0x82,0,0xc3,0x15]);
    assert.deepEqual([cpu.sreg,cpu.sp,cpu.pair(28)], [0xb5,0x5fff,0x0940]);
    const commits = events.filter(e => e.register === 'CTRLFSET');
    assert.deepEqual(commits.map(e => [e.cycle,e.before.ccabv,e.before.ccbbv,e.after.cca,e.after.ccb,e.after.ccabv,e.after.ccbbv]), [
      [14,false,true,0x193e,0x82a7,false,false],[28,true,false,0x15c3,0x82a7,false,false],
    ]);
    const high = events[3];
    assert.deepEqual([high.register,high.addressByte,high.before.ccabv,high.before.ccbbv,high.after.ccabv,high.after.ccbbv,high.after.ccbbuf],
      ['CCBBUFH',BBUF+1,true,false,true,true,0x82a7]);
    assert.ok(events.every((e,i) => e.origin === 'peripheral-model' && e.peripheral === 'TCD1' && e.pcWord === i && e.instructionAttempt === i+1 && e.completed));
    const state = cpu.state();
    assert.throws(() => cpu.step(), e => e.classification === 'UNHANDLED_MMIO' && e.addressByte === 0x0941 && e.attemptedValue === 0xa7);
    assert.deepEqual(cpu.state(),state); assert.equal(events.length,16);
    return { steps,events };
  }
  assert.deepEqual(run(),run());
});
