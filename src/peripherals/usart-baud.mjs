// ATxmega256A3 USARTF0 baud rate register A, XMEGA A manual section 21.15.6.
export const USARTF0_BAUDCTRLA = 0x0ba6;

export class USARTF0BaudControl {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset() { this.baudctrla = 0; }

  snapshot() { return { baudctrla: this.baudctrla, bselLow: this.baudctrla }; }

  register(registry, { context = () => ({}) } = {}) {
    if (this.registered) throw new Error('USARTF0 baud control already registered');
    const access = (kind, value, cycle) => {
      const before = this.onAccess ? this.snapshot() : null;
      if (kind === 'write') this.baudctrla = value;
      this.onAccess?.({ origin: 'peripheral-model', eventType: 'usart-access', ...context(),
        peripheral: 'USARTF0', register: 'BAUDCTRLA', addressByte: USARTF0_BAUDCTRLA,
        kind, cycle, value, completed: true, before, after: this.snapshot() });
      return value;
    };
    registry.map(USARTF0_BAUDCTRLA, {
      read: cycle => access('read', this.baudctrla, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
    this.registered = true;
  }
}
