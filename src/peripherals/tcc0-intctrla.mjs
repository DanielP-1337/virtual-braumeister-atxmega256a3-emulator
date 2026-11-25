// ATxmega256A3 TC0, XMEGA A manual §§14.12.2, 14.12.6, 14.12.10.
const INTCTRLA = 0x0806;
const OVERFLOW_VECTOR_WORD = 0x001c;

export class TCC0InterruptControl {
  constructor({ clock, onAccess = null }) {
    this.clock = clock;
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.intctrla = 0;
    this.overflowFlag = false;
  }

  snapshot() {
    return { intctrla: this.intctrla, overflowLevel: this.intctrla & 3,
      errorLevel: this.intctrla >>> 2, overflowFlag: this.overflowFlag };
  }

  request(cycle) {
    this.clock.advanceTo(cycle);
    const level = this.intctrla & 3;
    return this.overflowFlag && level ? { peripheral: 'TCC0', source: 'overflow', level,
      vectorWord: OVERFLOW_VECTOR_WORD } : null;
  }

  acknowledge(request, cycle) {
    if (request.peripheral === 'TCC0' && request.vectorWord === OVERFLOW_VECTOR_WORD) {
      // Account for elapsed timer edges up to vector entry before clearing OVFIF.
      this.clock.advanceTo(cycle);
      this.overflowFlag = false;
    }
  }

  register(registry, { context = () => ({}) } = {}) {
    if (this.clock.counter.clock !== this.clock || this.clock.counter.registry !== registry ||
        this.clock.interruptControl || registry.handlers.has(INTCTRLA)) {
      throw new Error('TCC0 interrupts require the registered timer clock and a free INTCTRLA handler');
    }
    const access = (kind, value, cycle) => {
      this.clock.advanceTo(cycle);
      const before = this.onAccess ? this.snapshot() : null;
      if (kind === 'write') this.intctrla = value & 0x0f;
      else value = this.intctrla;
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'timer-access', ...context(),
        peripheral: 'TCC0', register: 'INTCTRLA', addressByte: INTCTRLA, kind, cycle, value,
        completed: true, before, after: this.snapshot() });
      return value;
    };
    registry.map(INTCTRLA, {
      read: cycle => access('read', undefined, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.clock.interruptControl = this;
  }
}
