// ATxmega256A3 PMIC, XMEGA A manual chapter 12 and application note AVR1305.
const BASE = 0x00a0;
const REGISTERS = ['STATUS', 'INTPRI', 'CTRL'];
const IVSEL = 0x40, RREN = 0x80;
const BOOT_BASE_WORD = 0x20000;

export class PMIC {
  constructor({ sources = [], onAccess = null } = {}) {
    // Each source presents its current request until the peripheral clears it.
    // Sampling by level also honors requests withdrawn before an instruction boundary.
    if (!sources.every(source => typeof source === 'function')) throw new TypeError('Expected PMIC request sources');
    this.sources = [...sources];
    this.onAccess = onAccess;
    this.registered = false;
    this.reset();
  }

  reset() {
    this.status = 0;
    this.intpri = 0;
    this.ctrl = 0;
    this.lastLevelWrite = -1;
    this.justDisabled = 0;
  }

  snapshot() { return { status: this.status, intpri: this.intpri, ctrl: this.ctrl }; }

  get executingLevel() {
    if (this.status & 4) return 3;
    if (this.status & 2) return 2;
    return this.status & 1;
  }

  enabledLevels(cycle) {
    // Section 12.8.3, note 1. Disabling a level takes effect one clock after the write.
    return (this.ctrl & 7) | (cycle === this.lastLevelWrite ? this.justDisabled : 0);
  }

  register(registry, { fault, context }) {
    if (this.registered || REGISTERS.some((_, i) => registry.handlers.has(BASE + i))) {
      throw new Error('PMIC MMIO registration collision');
    }
    for (const [index, register] of REGISTERS.entries()) {
      const addressByte = BASE + index;
      const event = (kind, value, cycle, completed, details = {}) => {
        this.onAccess?.({ origin: 'peripheral-model', eventType: 'pmic-access', ...context(), peripheral: 'PMIC',
          addressByte, register, kind, value, cycle, completed, ...details });
      };
      registry.map(addressByte, {
        read: cycle => {
          const value = [this.status, this.intpri, this.ctrl][index];
          event('read', value, cycle, true);
          return value;
        },
        write: (value, cycle, ioGrant) => {
          if (index === 0 || (index === 2 && (value & 0x38))) {
            const classification = index === 0 ? 'PMIC_READ_ONLY' : 'PMIC_RESERVED_CONFIGURATION';
            event('write', value, cycle, false, { classification });
            fault('Invalid write to PMIC.' + register, { classification, addressByte, accessKind: 'write', attemptedValue: value });
          }
          if (index === 1) this.intpri = value;
          else {
            this.justDisabled = this.enabledLevels(cycle) & ~value & 7;
            this.lastLevelWrite = cycle;
            // Only IVSEL is CCP-protected. Unqualified writes still update the other bits.
            this.ctrl = ioGrant ? value : (value & ~IVSEL) | (this.ctrl & IVSEL);
          }
          event('write', value, cycle, true);
        },
      });
    }
    this.registered = true;
  }

  pending(cycle) {
    const enabled = this.enabledLevels(cycle);
    const active = this.executingLevel;
    if (!enabled || active === 3) return null;
    let best = null, bestRank = 0;
    for (const source of this.sources) {
      const request = source(cycle);
      if (!request) continue;
      const { level, vectorWord } = request;
      if (!Number.isInteger(level) || level < 1 || level > 3 ||
          !Number.isInteger(vectorWord) || vectorWord < 2 || vectorWord > 0x1fe || (vectorWord & 1)) {
        throw new TypeError('Invalid maskable PMIC request or vector unit');
      }
      if (level <= active || !(enabled & (1 << (level - 1)))) continue;
      const vectorNumber = vectorWord / 2;
      // AVR1305: INTPRI retains its effect when RREN is cleared. RREN controls the automatic update.
      const rank = level === 1 ? (vectorNumber - this.intpri - 1) & 0xff : vectorNumber;
      if (!best || level > best.level || (level === best.level && rank < bestRank)) {
        best = request;
        bestRank = rank;
      }
    }
    return best;
  }

  vectorTarget(request, returnWord, fault) {
    const base = this.ctrl & IVSEL ? BOOT_BASE_WORD : 0;
    if ((base !== 0) !== (returnWord >= BOOT_BASE_WORD)) {
      fault('Interrupt crosses the application/boot boundary with unknown lock permissions',
        { classification: 'PMIC_CROSS_SECTION_LOCK_UNKNOWN' });
    }
    return base + request.vectorWord;
  }

  acknowledge(request) {
    this.status |= 1 << (request.level - 1);
    if (request.level === 1 && (this.ctrl & RREN)) this.intpri = request.vectorWord / 2;
  }

  finishInterrupt() {
    this.status &= ~(1 << (this.executingLevel - 1));
  }
}
