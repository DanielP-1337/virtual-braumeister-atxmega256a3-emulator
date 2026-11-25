// ATxmega256A3 TC0, XMEGA A manual §14.12.2. CTRLD remains at reset (no capture).
const CTRLB = 0x0801;
const modeMask = 0x07;
const channelMask = 0xf0;

export class TCC0WaveformControl {
  constructor({ clock, onAccess = null }) {
    this.clock = clock;
    this.onAccess = onAccess;
    this.reset();
  }

  reset() { this.ctrlb = 0; }

  snapshot() {
    return { ctrlb: this.ctrlb, wgmode: this.ctrlb & modeMask, channelEnables: this.ctrlb >>> 4 };
  }

  register(registry, { context = () => ({}), fault = (reason, details) => {
    throw Object.assign(new Error(reason), details);
  } } = {}) {
    const counter = this.clock.counter;
    if (counter.clock !== this.clock || counter.registry !== registry || this.clock.waveform || registry.handlers.has(CTRLB)) {
      throw new Error('TCC0 waveform control requires its registered clock and a free CTRLB handler');
    }
    const access = (kind, value, cycle) => {
      const before = this.onAccess ? this.snapshot() : null;
      const mode = kind === 'write' ? value & modeMask : 0;
      let classification, reason;
      if (mode === 2 || mode === 4) {
        classification = 'TCC0_RESERVED_WGMODE';
        reason = 'Reserved TCC0 waveform generation mode';
      } else if (mode !== 0) {
        classification = 'TCC0_WAVEFORM_MODE_UNMODELED';
        reason = 'TCC0 frequency and PWM waveform generation are unmodeled';
      } else {
        this.clock.advanceTo(cycle);
        // NORMAL generates no waveform. CCxEN does not enable or reset the timer clock.
        if (kind === 'write') this.ctrlb = value & (channelMask | modeMask);
        else value = this.ctrlb;
      }
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'timer-access', ...context(),
        peripheral: 'TCC0', register: 'CTRLB', addressByte: CTRLB, kind, cycle, value,
        completed: !classification, ...(classification ? { classification } : {}),
        before, after: this.snapshot() });
      if (classification) return fault(reason, { classification, addressByte: CTRLB, accessKind: kind, attemptedValue: value });
      return value;
    };
    registry.map(CTRLB, {
      read: cycle => access('read', undefined, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.clock.waveform = this;
  }
}
