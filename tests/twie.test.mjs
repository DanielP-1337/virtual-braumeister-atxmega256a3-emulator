import test from 'node:test';
import assert from 'node:assert/strict';
import { MMIORegistry } from '../src/peripherals/mmio-registry.mjs';
import { TWIMaster } from '../src/peripherals/twie.mjs';
import { XmegaCPU } from '../src/xmega.mjs';
import { discover } from '../src/discovery.mjs';
import { runCombined, verifyCombinedProbes } from '../verification/twie/master-read.mjs';

// Literal device addresses, flags and expected bus clocks come from A3 table 31
// and XMEGA A manual sections 19.4, 19.5, 19.9, 19.14.
const CTRL = 0x4a0, A = 0x4a1, B = 0x4a2, C = 0x4a3, STATUS = 0x4a4, BAUD = 0x4a5, ADDR = 0x4a6, DATA = 0x4a7;
function bus(respond = null) {
  const mmio = new MMIORegistry(), events = [], irqs = [], accesses = [];
  const master = new TWIMaster({ respond, onTransfer: e => events.push(e), onInterrupt: e => irqs.push(e),
    onAccess: e => accesses.push(e) });
  master.register(mmio);
  const read = (address, cycle = 0) => mmio.handlers.get(address).read(cycle);
  const write = (address, value, cycle = 0) => mmio.handlers.get(address).write(value, cycle);
  function init(baud = 0, control = 0x78) {
    write(BAUD, baud); write(A, control); write(STATUS, 1);
  }
  return { mmio, master, read, write, init, events, irqs, accesses };
}

test('TWIE maps only the common and seven master registers and resets to UNKNOWN', () => {
  const { master, mmio, read, write, accesses } = bus();
  assert.deepEqual([...mmio.handlers.keys()], [CTRL, A, B, C, STATUS, BAUD, ADDR, DATA]);
  for (const reg of [CTRL, A, B, C, STATUS, BAUD, ADDR]) assert.equal(read(reg), 0);
  assert.equal(master.snapshot().data, 0);
  assert.throws(() => read(DATA), { classification: 'TWI_DISABLED', addressByte: DATA });
  assert.equal(accesses.at(-1).completed, false);
  write(STATUS, 1);
  assert.equal(read(STATUS), 0);
  write(CTRL, 2);
  assert.equal(read(CTRL), 2);
  assert.throws(() => master.register(mmio), /collision/);
  const occupied = new MMIORegistry();
  occupied.map(DATA, { read: () => 1 });
  assert.throws(() => new TWIMaster().register(occupied), /collision/);
  assert.deepEqual([...occupied.handlers.keys()], [DATA]);
  for (const byte of [0x0480, 0x049f, 0x04a8, 0x04ad]) assert.equal(mmio.handlers.has(byte), false);
  master.reset();
  assert.equal(read(CTRL), 0);
});

test('TWIE flags a START from UNKNOWN and implements status W1C and read-only bits', () => {
  const { read, write, events, irqs } = bus();
  write(A, 0x58);
  write(STATUS, 3);
  assert.equal(read(STATUS), 0);
  write(ADDR, 0xbe);
  assert.equal(read(STATUS), 0x64); // WIF, CLKHOLD, BUSERR, UNKNOWN.
  assert.equal(read(ADDR), 0xbe);
  write(STATUS, 0x30);
  assert.equal(read(STATUS), 0x64);
  write(STATUS, 0x41);
  assert.equal(read(STATUS), 5);
  write(STATUS, 4);
  assert.equal(read(STATUS), 1);
  assert.deepEqual(irqs.map(e => e.asserted), [true, false]);
  assert.deepEqual(events.map(e => e.action), ['unknown-bus-start']);
});

test('TWIE sets WIF exactly on the ninth SCL clock for all 256 baud settings', () => {
  for (let baud = 0; baud <= 255; baud++) {
    const { init, write, read, events } = bus(() => true);
    init(baud);
    const deadline = 11 + 9 * (10 + 2 * baud);
    write(ADDR, 0x34, 11);
    assert.equal(read(STATUS, deadline - 1), 2);
    assert.equal(read(STATUS, deadline), 0x62);
    assert.deepEqual(events.map(e => [e.action, e.cycle]), [['start', 11], ['address', deadline]]);
    assert.equal(read(ADDR, deadline + 1), 0x34);
  }
});

test('TWIE accepts the pre-IDLE baud initialization and protects active configuration', () => {
  const { init, read, write, master } = bus(() => true);
  write(A, 0x78); write(BAUD, 0x9b); write(STATUS, 1);
  assert.equal(read(BAUD), 0x9b);
  assert.throws(() => write(BAUD, 7), { classification: 'TWI_ACTIVE_RECONFIGURATION' });
  write(ADDR, 0, 1);
  const active = master.snapshot();
  for (const [address, value] of [[A, 0], [BAUD, 0x11], [STATUS, 1]]) {
    assert.throws(() => write(address, value, 2), { classification: 'TWI_ACTIVE_RECONFIGURATION' });
    assert.deepEqual(master.snapshot(), active);
  }
  for (const [address, value] of [[CTRL, 1], [A, 1], [B, 1], [B, 2], [B, 4], [C, 0x80]]) {
    assert.throws(() => write(address, value, 2));
    assert.deepEqual(master.snapshot(), active);
  }
  assert.throws(() => read(DATA, 2), { classification: 'TWI_TRANSFER_IN_PROGRESS' });
  assert.throws(() => master.advanceTo(1), RangeError);
  master.reset();
  init();
  assert.equal(read(STATUS), 1);
  write(A, 0);
  assert.equal(read(STATUS), 0);
});

test('TWIE preserves a genuine address or data NACK until a later sampled ACK', () => {
  for (const nackAt of ['address', 'write']) {
    const { init, read, write, events } = bus(r => r.address === 0x15 || r.action !== nackAt);
    init();
    write(ADDR, 0x76, 0);
    const deadline = nackAt === 'address' ? 90 : 180;
    if (nackAt === 'write') {
      assert.equal(read(STATUS, 90), 0x62);
      write(DATA, 0x42, 90);
    }
    assert.equal(read(STATUS, deadline), 0x72); // OWNER, WIF, CLKHOLD, RXACK.
    assert.throws(() => write(DATA, 0x99, deadline), { classification: 'TWI_DATA_DIRECTION' });
    write(C, 3, deadline);
    assert.equal(read(C, deadline), 0);
    assert.equal(read(STATUS, deadline), 0x11); // STOP preserves last slave response.
    assert.deepEqual(events.filter(e => e.ack === false).map(e => e.action), [nackAt]);
    write(ADDR, 0x2a, deadline + 1);
    assert.equal(read(STATUS, deadline + 90), 0x12);
    assert.equal(read(STATUS, deadline + 91), 0x62);
  }
});

test('TWIE raises RIF after eight data clocks and clocks the master ACK only on command', () => {
  const { init, read, write, events, irqs } = bus(r => r.action === 'read' ? [0, 255][r.index] : true);
  init();
  write(ADDR, 0x45, 0);
  assert.equal(read(STATUS, 89), 2);
  assert.equal(read(STATUS, 90), 2); // No WIF or spurious RIF on an ACKed read address.
  assert.equal(read(STATUS, 169), 2);
  assert.equal(read(STATUS, 170), 0xa2);
  assert.equal(read(DATA, 172), 0);
  assert.equal(read(STATUS, 172), 2);
  assert.throws(() => read(DATA, 173), { classification: 'TWI_DATA_WITHOUT_HOLD' });
  assert.deepEqual(events.map(e => e.action), ['start', 'address', 'read']);
  write(C, 2, 180);
  assert.equal(read(STATUS, 269), 2);
  assert.equal(read(STATUS, 270), 0xa2);
  assert.equal(read(DATA, 271), 0xff);
  write(C, 7, 280);
  assert.equal(read(C, 281), 4); // CMD self-clears, ACKACT retains the software choice.
  assert.equal(read(STATUS, 289), 2);
  assert.equal(read(STATUS, 290), 1);
  assert.deepEqual(events.filter(e => e.action === 'master-ack').map(e => [e.cycle, e.ack]), [[190, true], [290, false]]);
  assert.deepEqual(irqs.map(e => [e.cycle, e.asserted]), [[170,true],[172,false],[270,true],[271,false]]);
});

test('TWIE sends exactly one repeated START via ADDR or an explicit START command', () => {
  for (const explicit of [false, true]) {
    const { init, read, write, events } = bus(r => r.action === 'read' ? 0x62 : true);
    init();
    write(ADDR, 0x81);
    assert.equal(read(DATA, 170), 0x62);
    write(C, 4, 171);
    if (explicit) {
      write(C, 5, 172);
      assert.equal(read(C, 182), 4);
      write(ADDR, 0xc0, 183);
    } else write(ADDR, 0xc0, 172);
    const end = explicit ? 273 : 272;
    assert.equal(read(STATUS, end), 0x62);
    write(C, 3, end);
    assert.deepEqual(events.map(e => e.action), ['start','address','read','master-ack','repeated-start','address','stop']);
    assert.equal(events[3].ack, false);
    assert.equal(events[3].cycle, 182);
    assert.equal(events[4].cycle, 182);
    assert.equal(Object.hasOwn(events[4], 'address'), false); // Sr carries no address bits.
    assert.equal(events[5].cycle, end);
  }
});

test('TWIE request level follows RIEN, WIEN, INTLVL and hardware flags independently', () => {
  for (const mode of ['read', 'write']) {
    const { init, read, write, master, irqs } = bus(r => r.action === 'read' ? 0xaa : true);
    init(0, 8);
    write(ADDR, mode === 'read' ? 1 : 0);
    const at = mode === 'read' ? 170 : 90;
    assert.equal(read(STATUS, at), mode === 'read' ? 0xa2 : 0x62);
    for (let level = 0; level <= 3; level++) {
      for (const mask of [0, 0x10, 0x20, 0x30]) {
        write(A, (level << 6) | mask | 8, at);
        const requested = level !== 0 && Boolean(mask & (mode === 'read' ? 0x20 : 0x10));
        assert.deepEqual(master.interruptRequest, requested ? { peripheral: 'TWIE', vectorWord: 0x5c, level, source: mode } : null);
      }
    }
    const count = irqs.length;
    read(STATUS, at); read(STATUS, at);
    assert.equal(irqs.length, count);
    write(STATUS, mode === 'read' ? 0x80 : 0x40, at);
    assert.equal(master.interruptRequest, null);
    assert.equal(irqs.at(-1).asserted, false);
    assert.equal(read(STATUS, at), 2);
  }
});

test('TWIE distinguishes unknown and invalid peer input from ACK, NACK, zero and 0xff', () => {
  for (const [respond, address, classification] of [
    [null, 0xae, 'TWI_UNKNOWN_ACK'], [() => 0, 0xae, 'TWI_INVALID_RESPONSE'],
    [r => r.action === 'address' ? true : null, 0xaf, 'TWI_UNKNOWN_DATA'],
    [r => r.action === 'address' ? true : 256, 0xaf, 'TWI_INVALID_RESPONSE'],
  ]) {
    const { init, write, master, accesses, events, irqs } = bus(respond);
    init();
    const prior = master.snapshot();
    assert.throws(() => write(ADDR, address, 1), { classification, addressByte: ADDR });
    assert.deepEqual(master.snapshot(), prior);
    assert.equal(accesses.at(-1).completed, false);
    assert.equal(events.length + irqs.length, 0);
  }
  for (const receiving of [false, true]) {
    const { init, read, write, master } = bus(r => {
      if (r.action === 'address') return true;
      if (r.action === 'read' && r.index === 0) return 0xff;
      return undefined;
    });
    init(); write(ADDR, receiving ? 0xaf : 0xae);
    const at = receiving ? 170 : 90;
    read(STATUS, at);
    const held = master.snapshot();
    assert.throws(() => receiving ? write(C, 2, at) : write(DATA, 0xa5, at), {
      classification: receiving ? 'TWI_UNKNOWN_DATA' : 'TWI_UNKNOWN_ACK',
      addressByte: receiving ? C : DATA,
    });
    assert.deepEqual(master.snapshot(), held);
  }
});

test('TWIE reset cancels outstanding wire work and releases a pending interrupt', () => {
  const { init, read, write, master, events, irqs } = bus(() => true);
  init(); write(ADDR, 0xae);
  master.reset(); master.advanceTo(90);
  assert.deepEqual(events.map(e => e.action), ['start']);
  assert.equal(read(STATUS, 90), 0);
  master.reset();
  init(); write(ADDR, 0xae);
  master.advanceTo(90);
  assert.equal(master.interruptRequest.level, 1);
  master.reset();
  assert.equal(irqs.at(-1).asserted, false);
  assert.equal(master.needsClock, false);
});

test('TWIE executes and deterministically replays both combined eight-byte AVR fixtures from reset', () => {
  for (const run of verifyCombinedProbes()) {
    assert.equal(run.transfers[0].cycle, 14);
    assert.equal(run.transfers[1].cycle, 14 + 9 * 320);
    assert.equal(run.transfers[5].cycle - run.transfers[3].cycle, 17 * 320);
    assert.equal(run.transfers.at(-1).cycle, 31869);
    assert.deepEqual([run.steps, run.cycles, run.pcWord], [18219, 31871, 132]);
    assert.equal(run.interrupts.length, 20);
    assert.equal(run.accesses.some(e => !e.completed), false);
  }
});

test('TWIE AVR probe branches on explicit NACK and stops on an unknown bus participant', () => {
  const fixture = { address: 0x57, offset: 0xf0, bytes: [0x24] };
  for (const peer of ['nack-address', 'nack-data', 'nack-read-address']) {
    const run = runCombined(fixture, peer);
    assert.equal(run.stop, null);
    assert.equal(run.resultRegister, 2);
    assert.equal(run.state.status, 0x11);
    assert.equal(run.transfers.filter(e => e.ack === false).length, 1);
    assert.equal(run.transfers.at(-1).action, 'stop');
    assert.deepEqual(run.received, [0xa5]); // Initial SRAM poison, never read from the peer.
  }
  const unknown = runCombined(fixture, 'unknown');
  assert.deepEqual(unknown.stop, { classification: 'TWI_UNKNOWN_ACK', pcWord: 9,
    opcode: 0x8306, addressByte: ADDR, instructionCompleted: false });
  assert.deepEqual(unknown.transfers, []);
  assert.deepEqual(unknown.interrupts, []);
  assert.deepEqual(unknown.received, [0xa5]);
});

test('TWIE discovery stops before the next opcode if global I makes PMIC arbitration necessary', () => {
  for (const global of [true, false]) {
    const words = [global ? 0xe800 : 0xe000, 0xbf0f, // LDI R16,I; OUT SREG,R16.
      0xe508, 0x9300, A, 0xe001, 0x9300, STATUS, 0xea0e, 0x9300, ADDR, 0xcfff];
    const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
    for (const [i, word] of words.entries()) { flash[2*i] = word & 255; flash[2*i+1] = word >>> 8; }
    present.fill(1, 0, words.length * 2);
    const cpu = new XmegaCPU({ flash, present }), master = new TWIMaster({ respond: () => true });
    master.register(cpu.bus.mmio, { fault: (message, details) => cpu.fault(message, details) });
    const diagnostics = [];
    const result = discover(cpu, { maxSteps: 100, pendingInterrupt: () => master.interruptRequest, onTrace: e => {
      if (e.eventType === 'instruction' && master.needsClock) master.advanceTo(cpu.cycles);
      if (e.eventType === 'diagnostic') diagnostics.push(e);
    } });
    assert.equal(cpu.pc, 11);
    assert.equal(cpu.sp, 0x5fff);
    assert.equal(result.lastCompletedInstruction.mnemonic, 'RJMP');
    assert.equal(result.firstBlockingEvent.classification, global ? 'UNMODELED_INTERRUPT_DELIVERY' : 'EXECUTION_LIMIT');
    if (global) {
      assert.equal(result.cycles, 102);
      assert.equal(result.completedInstructions, 53);
      assert.equal(result.attemptedInstructions, 53);
      assert.equal(result.firstBlockingEvent.instructionAttempted, false);
      assert.deepEqual(result.firstBlockingEvent.interruptRequest, { peripheral: 'TWIE', vectorWord: 0x5c, level: 1, source: 'write' });
      assert.deepEqual(diagnostics[0].accesses, []);
    } else assert.equal(diagnostics.length, 0);
  }
});
