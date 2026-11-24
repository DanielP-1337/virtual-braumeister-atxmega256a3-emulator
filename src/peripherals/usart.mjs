// ATxmega256A3 USARTF0, XMEGA A manual section 21.15.4.
export const USARTF0_CTRLB = 0x0ba4;
const RXEN = 0x10, TXEN = 0x08;
const WRITABLE = RXEN | TXEN | 0x07; // CLK2X, MPCM, TXB8

export class USARTF0Control {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.ctrlb = 0;
  }

  snapshot() {
    return { ctrlb: this.ctrlb, receiverEnabled: Boolean(this.ctrlb & RXEN),
      transmitterEnabled: Boolean(this.ctrlb & TXEN) };
  }

  register(registry, { context = () => ({}) } = {}) {
    if (this.registered) throw new Error('USARTF0 control already registered');
    registry.map(USARTF0_CTRLB, {
      read: cycle => this.access('read', this.ctrlb, cycle, context),
      write: (value, cycle) => this.access('write', value, cycle, context),
    });
    this.registered = true;
  }

  access(kind, value, cycle, context) {
    const before = this.onAccess ? this.snapshot() : null;
    // DATA and the serial line are outside this register model. No frame can be pending.
    if (kind === 'write') this.ctrlb = value & WRITABLE;
    this.onAccess?.({ origin: 'peripheral-model', eventType: 'usart-access', ...context(),
      peripheral: 'USARTF0', register: 'CTRLB', addressByte: USARTF0_CTRLB, kind,
      cycle, value, completed: true, before, after: this.snapshot() });
    return value;
  }
}
