// ATxmega256A3 USARTF0.CTRLA, XMEGA A manual section 21.15.3.
export const USARTF0_CTRLA = 0x0ba3;
const WRITABLE_LEVELS = 0x3f;

export class USARTF0InterruptControl {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.ctrla = 0;
  }

  snapshot() {
    return {
      ctrla: this.ctrla,
      rxcLevel: (this.ctrla >> 4) & 3,
      txcLevel: (this.ctrla >> 2) & 3,
      dreLevel: this.ctrla & 3,
    };
  }

  register(registry, { context = () => ({}) } = {}) {
    if (this.registered) throw new Error('USARTF0 interrupt control already registered');
    const access = (kind, value, cycle) => {
      const before = this.onAccess ? this.snapshot() : null;
      // Selecting a level configures the source. Its interrupt flag belongs to STATUS.
      if (kind === 'write') this.ctrla = value & WRITABLE_LEVELS;
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'usart-access', ...context(),
        peripheral: 'USARTF0', register: 'CTRLA', addressByte: USARTF0_CTRLA, kind, cycle, value,
        completed: true, before, after: this.snapshot() });
      return value;
    };
    registry.map(USARTF0_CTRLA, {
      read: cycle => access('read', this.ctrla, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.registered = true;
  }
}
