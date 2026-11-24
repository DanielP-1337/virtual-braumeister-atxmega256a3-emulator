// ATxmega256A3 SPIC, XMEGA A manual 8077I, sections 20.2–20.7.
// Byte-level master with a synchronous virtual clock and an optional explicit wire peer.
export const SPIC_BASE = 0x08c0;
const NAMES = ['CTRL', 'INTCTRL', 'STATUS', 'DATA'];
const ENABLE = 0x40, MASTER = 0x10, IF = 0x80, WRCOL = 0x40;
const DIVISORS = [4, 16, 64, 128];

function reverseBits(byte) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((byte >>> bit) & 1);
  return reversed;
}

export class SPIController {
  constructor({ gpio, exchange = null, onAccess = null, onTransfer = null } = {}) {
    if (!gpio || typeof gpio.port !== 'function') throw new TypeError('SPIC needs the PORTC controller');
    this.gpio = gpio;
    this.exchange = exchange;
    this.onAccess = onAccess;
    this.onTransfer = onTransfer;
    this.context = () => ({});
    this.fault = (message, details) => { throw Object.assign(new Error(message), details); };
    this.registered = false;
    this.reset();
  }

  reset() {
    this.ctrl = 0;
    this.flags = 0;
    this.observedFlags = 0;
    this.rx = 0; // Documented DATA reset value. A subsequent unsampled byte is unknown.
    this.pending = null;
    this.selectUnresolved = false;
    this.lastCycle = 0;
  }

  get needsClock() { return (this.ctrl & (ENABLE | MASTER)) === (ENABLE | MASTER); }
  get busy() { return this.pending !== null; }

  snapshot() {
    return { ctrl: this.ctrl, intctrl: 0, status: this.flags, observedFlags: this.observedFlags,
      rx: this.rx, selectUnresolved: this.selectUnresolved, busy: this.busy, pending: this.busy ? { ...this.pending.frame } : null };
  }

  register(registry, { fault, context = () => ({}) } = {}) {
    if (this.registered || NAMES.some((_, i) => registry.handlers.has(SPIC_BASE + i))) {
      throw new Error('SPIC MMIO registration collision');
    }
    if (fault) this.fault = fault;
    this.context = context;
    for (const [index] of NAMES.entries()) {
      registry.map(SPIC_BASE + index, {
        read: cycle => this.access(index, 'read', null, cycle),
        write: (value, cycle) => this.access(index, 'write', value, cycle),
      });
    }
    this.registered = true;
  }

  transferEvent(action, cycle, details) {
    this.onTransfer?.({ origin: 'peripheral-model', eventType: 'spi-transfer', peripheral: 'SPIC', action, cycle, ...details });
  }

  selectLevel() {
    const port = this.gpio.port('C');
    if (port.dir & 0x10) return 'output';
    if (!(port.inputKnownMask & 0x10) || (port.pinctrl[4] & 7) === 7) return 'unknown';
    return ((port.inputSample >>> 4) ^ (port.pinctrl[4] >>> 6)) & 1;
  }

  observeSelect(cycle) {
    if (!this.needsClock || this.selectUnresolved) return;
    const ss = this.selectLevel();
    if (ss === 1 || ss === 'output') return;
    const interruptedTx = this.pending?.frame.tx ?? null;
    this.pending = null;
    if (ss === 'unknown') {
      // Either master operation or a mode fault may have occurred. A later
      // known-high sample cannot resolve that history. Resume from reset.
      this.selectUnresolved = true;
      this.transferEvent('unknown-select', cycle, { interruptedTx });
    } else {
      this.ctrl &= ~MASTER;
      this.flags |= IF;
      this.observedFlags &= ~IF;
      this.transferEvent('master-lost', cycle, { interruptedTx });
    }
  }

  advanceTo(cycle) {
    if (!Number.isSafeInteger(cycle) || cycle < this.lastCycle) throw new RangeError('SPIC needs a monotonically increasing cycle count');
    this.lastCycle = cycle;
    // A newly observed SS change at this boundary cannot cancel a byte whose
    // deadline already passed. For simultaneous events this model samples SS first.
    if (this.busy && this.pending.frame.completeCycle < cycle) this.complete();
    this.observeSelect(cycle);
    if (this.busy && this.pending.frame.completeCycle === cycle) this.complete();
  }

  complete() {
    const { frame, rx } = this.pending;
    this.pending = null;
    this.rx = rx;
    this.flags |= IF;
    this.observedFlags &= ~IF;
    this.transferEvent('complete', frame.completeCycle, { ...frame, rx });
  }

  access(index, kind, value, cycle) {
    this.advanceTo(cycle);
    const addressByte = SPIC_BASE + index;
    const fail = (classification, reason) => this.fault(reason, { classification, addressByte,
      accessKind: kind, attemptedValue: value });
    const before = this.onAccess ? this.snapshot() : null;
    const reading = kind === 'read';
    const port = this.gpio.port('C');
    if (this.selectUnresolved && index !== 1) {
      fail('SPI_UNKNOWN_SS', 'SPIC master history is unknown after losing the SS input sample');
    }
    if (reading) {
      if (index === 0) value = this.ctrl;
      if (index === 1) value = 0; // Polling profile requires INTLVL=OFF.
      if (index === 2) { value = this.flags; this.observedFlags = this.flags; }
      if (index === 3) {
        if (this.rx === null) fail('SPI_UNKNOWN_RX', 'SPIC.DATA contains a byte received without supplied MISO data');
        value = this.rx;
        this.acknowledge();
      }
    } else if (index === 0) {
      if (this.busy && value !== this.ctrl) fail('SPI_ACTIVE_RECONFIGURATION', 'Changing SPIC.CTRL during a transfer is unmodeled');
      if ((value & (ENABLE | MASTER)) === (ENABLE | MASTER) && this.selectLevel() === 'unknown') {
        fail('SPI_UNKNOWN_SS', 'Enabling SPIC master needs a known SS input or an output SS');
      }
      this.ctrl = value;
      this.observeSelect(cycle);
    } else if (index === 1) {
      if (value & 3) fail('SPI_INTERRUPT_UNMODELED', 'SPIC interrupt delivery requires a PMIC model');
      if (value & 0xfc) fail('SPI_RESERVED_CONFIGURATION', 'Reserved SPIC.INTCTRL bits must be zero');
    } else if (index === 2) {
      fail('SPI_READ_ONLY', 'SPIC.STATUS is read-only');
    } else {
      if (!(this.ctrl & ENABLE)) fail('SPI_DISABLED_WRITE', 'DATA writes with SPIC disabled are unmodeled');
      if (!(this.ctrl & MASTER)) fail('SPI_SLAVE_UNMODELED', 'Externally clocked SPIC slave transfers are unmodeled');
      if (this.busy) {
        this.acknowledge();
        this.flags |= WRCOL;
        this.transferEvent('collision', cycle, { tx: value, inFlightTx: this.pending.frame.tx });
      } else {
        if ((port.dir & 0xa0) !== 0xa0) fail('SPI_PIN_CONFIGURATION_UNMODELED', 'SPIC wire transfer needs PC5/MOSI and PC7/SCK configured as outputs');
        if ((port.pinctrl[5] & 0x60) || (port.pinctrl[6] & 0x40) ||
            (port.pinctrl[6] & 7) === 7 || (port.pinctrl[7] & 0x60)) {
          fail('SPI_PIN_CONFIGURATION_UNMODELED', 'Disabled MISO input or inverted/wired SPI signals require a pin-level model');
        }
        this.start(value, cycle, fail);
      }
    }
    this.onAccess?.({ origin: 'peripheral-model', eventType: 'spi-access', ...this.context(), peripheral: 'SPIC',
      addressByte, register: NAMES[index], kind, value, cycle, before, after: this.snapshot() });
    return value;
  }

  acknowledge() {
    this.flags &= ~this.observedFlags;
    this.observedFlags = 0;
  }

  start(tx, startCycle, fail) {
    const divider = DIVISORS[this.ctrl & 3] / ((this.ctrl & 0x80) ? 2 : 1);
    const lsbFirst = Boolean(this.ctrl & 0x20);
    const wireTx = lsbFirst ? reverseBits(tx) : tx;
    const frame = Object.freeze({ tx, wireTx, lsbFirst, mode: (this.ctrl >>> 2) & 3,
      divider, startCycle, completeCycle: startCycle + 8 * divider });
    // Wire bytes put the first serial bit in bit 7. Null means the host has no
    // input evidence. Completion still occurs and the data is replaced at the deadline.
    const wireRx = this.exchange?.(frame) ?? null;
    if (wireRx !== null && (!Number.isInteger(wireRx) || wireRx < 0 || wireRx > 255)) {
      fail('SPI_INVALID_RESPONSE', 'SPIC peer must return a wire byte or null');
    }
    const rx = wireRx === null || !lsbFirst ? wireRx : reverseBits(wireRx);
    this.acknowledge();
    this.pending = { frame, rx };
    this.transferEvent('start', startCycle, frame);
  }
}
