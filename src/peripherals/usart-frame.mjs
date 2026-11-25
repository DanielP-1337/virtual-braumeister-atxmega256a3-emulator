// ATxmega256A3 USARTF0.CTRLC, XMEGA A manual 8077I section 21.15.5.
export const USARTF0_CTRLC = 0x0ba5;
const RESET_VALUE = 0x06; // Printed initial bits. CHSIZE=110 has no defined character size.
const DATA_BITS = [5, 6, 7, 8, null, null, null, 9];
const PARITY = ['none', null, 'even', 'odd'];

export class USARTF0FrameControl {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.ctrlc = RESET_VALUE;
  }

  snapshot() {
    return { ctrlc: this.ctrlc, mode: 'asynchronous', dataBits: DATA_BITS[this.ctrlc & 7],
      parity: PARITY[(this.ctrlc >> 4) & 3], stopBits: (this.ctrlc & 8) ? 2 : 1 };
  }

  register(registry, { context = () => ({}), fault = (message, details) => {
    throw Object.assign(new Error(message), details);
  } } = {}) {
    if (this.registered) throw new Error('USARTF0 frame control already registered');
    const access = (kind, value, cycle) => {
      const before = this.onAccess ? this.snapshot() : null;
      let classification = null;
      if (kind === 'write') {
        if ((value & 0xc0) !== 0) classification = 'USART_MODE_UNMODELED';
        else if (DATA_BITS[value & 7] === null || PARITY[(value >> 4) & 3] === null) classification = 'USART_RESERVED_FRAME';
        else this.ctrlc = value;
      }
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'usart-access', ...context(),
        peripheral: 'USARTF0', register: 'CTRLC', addressByte: USARTF0_CTRLC, kind, cycle, value,
        completed: classification === null, classification, before, after: this.snapshot() });
      if (classification) {
        const reason = classification === 'USART_MODE_UNMODELED' ? 'Unmodeled USARTF0 communication mode' : 'Reserved USARTF0 frame encoding';
        return fault(reason, { classification, addressByte: USARTF0_CTRLC, accessKind: kind, attemptedValue: value });
      }
      return value;
    };
    registry.map(USARTF0_CTRLC, {
      read: cycle => access('read', this.ctrlc, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.registered = true;
  }
}
