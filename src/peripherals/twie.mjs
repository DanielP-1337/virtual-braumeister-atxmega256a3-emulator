// ATxmega256A3 two-wire master, XMEGA A manual 8077I, sections 19.4, 19.5 and 19.9.
// respond(request) supplies test-bus evidence: boolean ACK on address/write, byte on read.
// The callback is a look-ahead query. onTransfer reports committed bus events at their deadlines.
export const TWIE_BASE = 0x04a0;
export const TWIE_MASTER_VECTOR_WORD = 0x005c;
const REGISTERS = ['CTRL', 'MASTER.CTRLA', 'MASTER.CTRLB', 'MASTER.CTRLC',
  'MASTER.STATUS', 'MASTER.BAUD', 'MASTER.ADDR', 'MASTER.DATA'];
const ENABLE = 0x08, WIEN = 0x10, RIEN = 0x20;
const RIF = 0x80, WIF = 0x40, CLKHOLD = 0x20, RXACK = 0x10, BUSERR = 0x04;
const UNKNOWN = 0, IDLE = 1, OWNER = 2;

export class TWIMaster {
  constructor({ respond = null, onAccess = null, onTransfer = null, onInterrupt = null } = {}) {
    this.respond = respond;
    this.onAccess = onAccess;
    this.onTransfer = onTransfer;
    this.onInterrupt = onInterrupt;
    this.context = () => ({});
    this.fault = (message, details) => { throw Object.assign(new Error(message), details); };
    this.registered = false;
    this.reset();
  }

  reset() {
    const released = this.lastRequest;
    this.ctrl = 0;
    this.ctrla = 0;
    this.ackAction = 0;
    this.baud = 0;
    this.addr = 0;
    this.data = 0;
    this.flags = 0;
    this.busState = UNKNOWN;
    this.phase = 'idle';
    this.byteIndex = 0;
    this.timeline = [];
    this.lastCycle = 0;
    this.lastRequest = released ?? null;
    this.updateInterrupt(0);
  }

  get status() {
    return this.busState | this.flags | ((this.flags & (WIF | RIF)) ? CLKHOLD : 0);
  }

  get needsClock() { return this.timeline.length !== 0; }
  get clockPeriod() { return 2 * (5 + this.baud); }

  get interruptRequest() {
    const level = this.ctrla >>> 6;
    if (!level || !(this.ctrla & ENABLE)) return null;
    let source;
    if ((this.flags & WIF) && (this.ctrla & WIEN)) source = 'write';
    else if ((this.flags & RIF) && (this.ctrla & RIEN)) source = 'read';
    else return null;
    return { peripheral: 'TWIE', vectorWord: TWIE_MASTER_VECTOR_WORD, level, source };
  }

  updateInterrupt(cycle) {
    const request = this.interruptRequest;
    if (request?.level === this.lastRequest?.level && request?.source === this.lastRequest?.source) return;
    this.lastRequest = request;
    this.onInterrupt?.({ origin: 'peripheral-model', eventType: 'twi-interrupt', peripheral: 'TWIE',
      vectorWord: TWIE_MASTER_VECTOR_WORD, cycle, asserted: Boolean(request), level: request?.level ?? 0,
      source: request?.source ?? null });
  }

  snapshot() {
    return { ctrl: this.ctrl, ctrla: this.ctrla, ctrlb: 0, ctrlc: this.ackAction,
      status: this.status, baud: this.baud, addr: this.addr, data: this.data, phase: this.phase,
      byteIndex: this.byteIndex, interrupt: this.interruptRequest, pending: this.timeline.map(e => ({ ...e })) };
  }

  register(registry, { fault, context = () => ({}) } = {}) {
    if (this.registered || REGISTERS.some((_, i) => registry.handlers.has(TWIE_BASE + i))) {
      throw new Error('TWIE MMIO registration collision');
    }
    if (fault) this.fault = fault;
    this.context = context;
    for (const [index, name] of REGISTERS.entries()) {
      registry.map(TWIE_BASE + index, {
        read: cycle => this.access(index, name, 'read', null, cycle),
        write: (value, cycle) => this.access(index, name, 'write', value, cycle),
      });
    }
    this.registered = true;
  }

  emit(event) {
    this.onTransfer?.({ origin: 'peripheral-model', eventType: 'twi-transfer', peripheral: 'TWIE', ...event });
  }

  advanceTo(cycle) {
    if (!Number.isSafeInteger(cycle) || cycle < this.lastCycle) throw new RangeError('TWIE requires a monotonic cycle count');
    this.lastCycle = cycle;
    while (this.needsClock && this.timeline[0].cycle <= cycle) {
      const event = this.timeline.shift();
      switch (event.action) {
        case 'start':
        case 'repeated-start':
          this.busState = OWNER;
          this.phase = this.needsClock ? 'active' : 'restarted';
          break;
        case 'address':
        case 'write':
          this.flags = event.ack ? 0 : RXACK;
          if (!event.ack || event.action === 'write' || !event.read) {
            this.flags |= WIF;
            this.phase = event.ack ? 'write' : 'nacked';
          }
          break;
        case 'read':
          this.data = event.value;
          this.flags = RIF;
          this.phase = 'read'; // The ninth bit awaits a command even after DATA clears RIF.
          break;
        case 'master-ack':
          break;
        case 'stop':
          this.busState = IDLE;
          this.phase = 'idle';
          break;
        default: throw new Error('Invalid internal TWIE event');
      }
      this.emit(event);
      this.updateInterrupt(event.cycle);
    }
  }

  response(request, fail) {
    const result = this.respond?.(Object.freeze(request));
    const reading = request.action === 'read';
    if (result === null || result === undefined) {
      fail(reading ? 'TWI_UNKNOWN_DATA' : 'TWI_UNKNOWN_ACK', 'Missing wire evidence for TWIE ' + request.action +
        ' at 7-bit address 0x' + request.address.toString(16).padStart(2, '0'));
    }
    if (reading ? !Number.isInteger(result) || result < 0 || result > 255 : typeof result !== 'boolean') {
      fail('TWI_INVALID_RESPONSE', 'The TWIE peer must supply a byte for read or a boolean ACK for address/write');
    }
    return result;
  }

  beginAddress(value, cycle, fail) {
    this.requireReady(fail);
    if (this.busState === UNKNOWN) {
      this.addr = value;
      this.flags = (this.flags & RXACK) | WIF | BUSERR;
      this.emit({ action: 'unknown-bus-start', cycle, addressByte: value });
      return;
    }
    const repeated = this.busState === OWNER;
    const read = Boolean(value & 1), address = value >>> 1;
    // Validate every input needed by this command before committing any register or bus event.
    const ack = this.response({ action: 'address', address, read, repeated }, fail);
    const firstByte = read && ack ? this.response({ action: 'read', address, index: 0 }, fail) : null;
    let start = cycle;
    if (this.phase === 'read') start = this.queueMasterAck(cycle, this.ackAction);
    if (this.phase !== 'restarted') {
      this.timeline.push({ action: repeated ? 'repeated-start' : 'start', cycle: start });
    }
    const addressEnd = start + 9 * this.clockPeriod;
    this.timeline.push({ action: 'address', cycle: addressEnd, address, addressByte: value, read, ack });
    if (firstByte !== null) {
      this.timeline.push({ action: 'read', cycle: addressEnd + 8 * this.clockPeriod, address, index: 0, value: firstByte });
    }
    this.flags &= RXACK; // ADDR clears RIF, WIF, ARBLOST and BUSERR.
    this.addr = value;
    this.byteIndex = firstByte === null ? 0 : 1;
    this.phase = 'active';
    this.advanceTo(cycle);
  }

  queueMasterAck(cycle, ackAction) {
    const end = cycle + this.clockPeriod;
    this.timeline.push({ action: 'master-ack', cycle: end, address: this.addr >>> 1, ack: !ackAction });
    return end;
  }

  command(value, cycle, fail) {
    const cmd = value & 3, action = value & 4;
    if (cmd === 0) { this.ackAction = action; return; }
    this.requireReady(fail);
    if (this.busState !== OWNER) fail('TWI_COMMAND_WITHOUT_OWNER', 'A TWIE command needs ownership of the bus');
    const reading = this.phase === 'read';
    const address = this.addr >>> 1;
    let nextByte;
    if (cmd === 2 && reading) {
      if (action) fail('TWI_UNSUPPORTED_SEQUENCE', 'Receiving another byte after a master NACK needs new slave evidence');
      nextByte = this.response({ action: 'read', address, index: this.byteIndex }, fail);
    }
    if (cmd === 2 && (this.addr & 1) && !reading) {
      fail('TWI_UNSUPPORTED_SEQUENCE', 'Byte receive requires an acknowledged read address and a received byte');
    }
    this.ackAction = action;
    this.flags &= ~(WIF | RIF);
    const commandCycle = reading ? this.queueMasterAck(cycle, action) : cycle;
    if (cmd === 2 && !reading) return; // BYTEREC has no wire action in write mode.
    if (cmd === 2) {
      this.timeline.push({ action: 'read', cycle: commandCycle + 8 * this.clockPeriod,
        address, index: this.byteIndex++, value: nextByte });
    } else {
      this.timeline.push({ action: cmd === 3 ? 'stop' : 'repeated-start', cycle: commandCycle });
    }
    this.phase = 'active';
    this.advanceTo(cycle);
  }

  requireReady(fail) {
    if (!(this.ctrla & ENABLE)) fail('TWI_DISABLED', 'The TWIE master is disabled');
    if (this.needsClock) fail('TWI_TRANSFER_IN_PROGRESS', 'A TWIE wire operation is in progress');
  }

  accessData(kind, value, cycle, fail) {
    this.requireReady(fail);
    if (!(this.status & CLKHOLD)) fail('TWI_DATA_WITHOUT_HOLD', 'TWIE.DATA requires master clock hold');
    if (kind === 'read') {
      if (this.phase !== 'read') fail('TWI_DATA_DIRECTION', 'No received TWIE byte is available in this phase');
      this.flags &= ~(WIF | RIF);
      return this.data;
    }
    if (this.phase !== 'write') fail('TWI_DATA_DIRECTION', 'Transmitting TWIE data requires an acknowledged write');
    const request = { action: 'write', address: this.addr >>> 1, index: this.byteIndex, value };
    const ack = this.response(request, fail);
    this.flags &= ~(WIF | RIF);
    this.phase = 'active';
    this.data = value;
    this.byteIndex++;
    this.timeline.push({ ...request, ack, cycle: cycle + 9 * this.clockPeriod });
    return value;
  }

  writeRegister(index, value, cycle, fail) {
    switch (index) {
      case 0:
        if (value & ~2) fail('TWI_UNSUPPORTED_CONFIGURATION', 'Only normal two-wire mode and SDAHOLD are modeled');
        this.ctrl = value;
        break;
      case 1:
        if (value & 7) fail('TWI_RESERVED_CONFIGURATION', 'Reserved TWIE.MASTER.CTRLA bits must be zero');
        if (!(value & ENABLE)) {
          if (this.busState === OWNER) fail('TWI_ACTIVE_RECONFIGURATION', 'Disabling TWIE during a transaction is unmodeled');
          this.busState = UNKNOWN;
          this.phase = 'idle';
        }
        this.ctrla = value;
        break;
      case 2:
        if (value) fail('TWI_UNSUPPORTED_MODE', 'Smart mode, quick commands, timeout and reserved bits are outside the normal TWI profile');
        break;
      case 3:
        if (value & ~7) fail('TWI_RESERVED_CONFIGURATION', 'Reserved TWIE.MASTER.CTRLC bits must be zero');
        this.command(value, cycle, fail);
        break;
      case 4:
        if ((value & 3) === IDLE && (this.ctrla & ENABLE)) {
          if (this.busState === OWNER) fail('TWI_ACTIVE_RECONFIGURATION', 'Forcing IDLE during an owned transaction is unmodeled');
          this.busState = IDLE;
        }
        this.flags &= ~(value & 0xcc); // W1C interrupt/error flags. RXACK and CLKHOLD are read-only.
        break;
      case 5:
        // The manual recommends writing BAUD while disabled. The AVR1308 setup also
        // writes it immediately after enable, before forcing IDLE or issuing any START.
        if ((this.ctrla & ENABLE) && (this.busState !== UNKNOWN || this.flags)) {
          fail('TWI_ACTIVE_RECONFIGURATION', 'BAUD changes after TWIE bus initialization require timing evidence');
        }
        this.baud = value;
        break;
      case 6: this.beginAddress(value, cycle, fail); break;
      case 7: this.accessData('write', value, cycle, fail); break;
    }
  }

  access(index, name, kind, value, cycle) {
    this.advanceTo(cycle);
    const addressByte = TWIE_BASE + index;
    const before = this.onAccess ? this.snapshot() : null;
    const event = () => ({ origin: 'peripheral-model', eventType: 'twi-access', ...this.context(),
      peripheral: 'TWIE', register: name, addressByte, kind, value, cycle, before });
    const fail = (classification, reason) => {
      this.onAccess?.({ ...event(), completed: false, classification, after: this.snapshot() });
      this.fault(reason, { classification, addressByte, accessKind: kind, attemptedValue: value });
    };
    if (kind === 'write') this.writeRegister(index, value, cycle, fail);
    else if (index === 7) value = this.accessData('read', null, cycle, fail);
    else value = [this.ctrl, this.ctrla, 0, this.ackAction, this.status, this.baud, this.addr][index];
    this.updateInterrupt(cycle);
    this.onAccess?.({ ...event(), completed: true, after: this.snapshot() });
    return value;
  }
}
