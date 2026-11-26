// ATxmega256A3 DACB control registers. XMEGA A manual, section 26.10.
const CTRLA = { register: 'CTRLA', addressByte: 0x0320, mask: 0x1f };
const CTRLB = { register: 'CTRLB', addressByte: 0x0321, mask: 0x63 };
const CTRLC = { register: 'CTRLC', addressByte: 0x0322, mask: 0x19 };

export class DACBControl {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.ctrla = 0;
    this.ctrlb = 0;
    this.ctrlc = 0;
  }

  snapshot() {
    return { ctrla: this.ctrla, ctrlb: this.ctrlb, ctrlc: this.ctrlc };
  }

  register(registry, { mapCtrla = true, mapCtrlb = true, mapCtrlc = true, context = () => ({}), fault = (message, details) => {
    throw Object.assign(new Error(message), details);
  } } = {}) {
    const registers = [];
    if (mapCtrla) registers.push(CTRLA);
    if (mapCtrlb) registers.push(CTRLB);
    if (mapCtrlc) registers.push(CTRLC);
    if (this.registered || registers.some(({ addressByte }) => registry.handlers.has(addressByte))) {
      throw new Error('DACB MMIO registration collision');
    }
    for (const { register, addressByte, mask } of registers) {
      const key = register.toLowerCase();
      const access = (kind, value, cycle) => {
        const before = this.onAccess ? this.snapshot() : null;
        // CHSEL 01 and 11 are reserved.
        const reservedChannel = kind === 'write' && register === 'CTRLB' && (value & 0x20) !== 0;
        if (kind === 'write' && !reservedChannel) this[key] = value & mask;
        this.onAccess?.({ origin: 'peripheral-model', eventType: 'dac-access', ...context(),
          peripheral: 'DACB', register, addressByte, kind, cycle, value,
          completed: !reservedChannel, before, after: this.snapshot() });
        if (reservedChannel) {
          return fault('Reserved DACB.CTRLB channel selection', { classification: 'DACB_RESERVED_CHSEL',
            addressByte, accessKind: kind, attemptedValue: value });
        }
        return value;
      };
      registry.map(addressByte, {
        read: cycle => access('read', this[key], cycle),
        write: (value, cycle) => access('write', value, cycle),
      });
    }
    this.registered = true;
  }
}
