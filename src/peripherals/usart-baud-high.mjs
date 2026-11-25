// ATxmega256A3 USARTF0 baud rate register B, XMEGA A manual section 21.15.7.
export const USARTF0_BAUDCTRLB = 0x0ba7;

export class USARTF0BaudHighControl {
  constructor({ low, onAccess = null }) {
    this.low = low;
    this.onAccess = onAccess;
    this.reset();
  }

  reset() { this.baudctrlb = 0; }

  snapshot() {
    const bselHigh = this.baudctrlb & 0x0f;
    const scale = this.baudctrlb >>> 4;
    // This is the programmed register pair. BAUDCTRLA triggers a prescaler update.
    return { baudctrlb: this.baudctrlb, bselHigh, bscale: scale < 8 ? scale : scale - 16,
      bsel: (bselHigh << 8) | this.low.snapshot().bselLow };
  }

  register(registry, { context = () => ({}), fault = (message, details) => {
    throw Object.assign(new Error(message), details);
  } } = {}) {
    if (this.registered) throw new Error('USARTF0 high baud control already registered');
    const access = (kind, value, cycle) => {
      const before = this.onAccess ? this.snapshot() : null;
      const reserved = kind === 'write' && (value >>> 4) === 8;
      if (kind === 'write' && !reserved) this.baudctrlb = value;
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'usart-access', ...context(),
        peripheral: 'USARTF0', register: 'BAUDCTRLB', addressByte: USARTF0_BAUDCTRLB, kind,
        cycle, value, completed: !reserved, ...(reserved ? { classification: 'USART_RESERVED_BSCALE' } : {}),
        before, after: this.snapshot() });
      if (reserved) return fault('Reserved USARTF0 BSCALE encoding (0x8)', {
        classification: 'USART_RESERVED_BSCALE', accessKind: kind, addressByte: USARTF0_BAUDCTRLB, attemptedValue: value,
      });
      return value;
    };
    registry.map(USARTF0_BAUDCTRLB, {
      read: cycle => access('read', this.baudctrlb, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.registered = true;
  }
}
