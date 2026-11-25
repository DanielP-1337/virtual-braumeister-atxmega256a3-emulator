// XMEGA A manual §§7.3, 14.4, 14.6.1 and 14.12.1. Peripheral edges of the common timer prescaler.
const CTRLA = 0x0800;
const divisors = [0, 1, 2, 4, 8, 64, 256, 1024];

export class TCC0Clock {
  constructor({ counter, onAccess = null }) {
    this.counter = counter;
    this.onAccess = onAccess;
    this.reset();
  }

  reset(cycle = 0) {
    if (!Number.isSafeInteger(cycle) || cycle < 0) throw new RangeError('Invalid TCC0 reset cycle');
    this.waveform?.reset();
    this.interruptControl?.reset();
    this.ctrla = 0;
    this.lastCycle = cycle;
  }

  advanceTo(cycle, counterWrite = false) {
    if (!Number.isSafeInteger(cycle) || cycle < this.lastCycle) throw new RangeError('TCC0 clock requires monotonic peripheral cycles');
    const divider = divisors[this.ctrla];
    if (divider) {
      // The common prescaler runs even while the timer is off. Our reset epoch
      // puts the selected tap's edges at multiples of its divisor.
      let edges = Math.floor(cycle / divider) - Math.floor(this.lastCycle / divider);
      // Committing CNT on this edge suppresses its hardware count and TOP event.
      if (counterWrite && edges > 0 && cycle % divider === 0) edges--;
      if (this.counter.countUp(edges) && this.interruptControl) this.interruptControl.overflowFlag = true;
    }
    this.lastCycle = cycle;
  }

  snapshot(cycle = this.lastCycle) {
    this.advanceTo(cycle);
    return { ctrla: this.ctrla, divider: divisors[this.ctrla] };
  }

  register(registry, { context = () => ({}), fault = (message, details) => {
    throw Object.assign(new Error(message), details);
  } } = {}) {
    if (this.counter.registry !== registry || this.counter.clock || registry.handlers.has(CTRLA)) {
      throw new Error('TCC0 clock needs its registered counter and a free CTRLA handler');
    }
    const access = (kind, value, cycle) => {
      const selector = value & 0x0f;
      const before = { ctrla: this.ctrla, divider: divisors[this.ctrla] };
      const unsupported = kind === 'write' && selector >= divisors.length;
      if (!unsupported) {
        // Count through the MMIO completion edge using the previous selection.
        this.advanceTo(cycle);
        if (kind === 'write') this.ctrla = selector;
        else value = this.ctrla;
      }
      const classification = 'TCC0_EVENT_CLOCK_UNMODELED';
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'timer-access', ...context(),
        peripheral: 'TCC0', register: 'CTRLA', addressByte: CTRLA, kind, cycle, value,
        completed: !unsupported, ...(unsupported ? { classification } : {}),
        before, after: { ctrla: this.ctrla, divider: divisors[this.ctrla] } });
      if (unsupported) return fault('TCC0 event-channel clock input is unmodeled', {
        classification, addressByte: CTRLA, accessKind: kind, attemptedValue: value,
      });
      return value;
    };
    registry.map(CTRLA, {
      read: cycle => access('read', undefined, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.counter.clock = this;
  }
}
