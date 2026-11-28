// Non-U XMEGA A, manual 8077I sections 25.8–25.10, 25.16 and 25.17.
// One settled, unsigned, right-adjusted 12-bit measurement on an external CH0 input.
export class ADCASingleConversion {
  constructor({ clockPhase = null, results = [] } = {}) {
    if (clockPhase !== null && (!Number.isInteger(clockPhase) || clockPhase < 0 || clockPhase > 511)) {
      throw new RangeError('Expected an ADC prescaler phase from 0 through 511');
    }
    if (!Array.isArray(results) || Array.from(results).some(value => !Number.isInteger(value) || value < 0 || value > 0xfff)) {
      throw new RangeError('Expected unsigned 12-bit ADC result codes');
    }
    this.clockPhase = clockPhase;
    this.results = [...results];
    this.reset();
  }

  reset() {
    this.enabledAt = null;
    this.requestCount = 0;
    this.pending = null;
    this.result = 0;
  }

  setEnable(enabled, cycle) {
    this.enabledAt = enabled ? cycle : null;
  }

  prescalerChanged(previous, cycle) {
    // During startup, elapsed peripheral clocks at the old rate cannot be credited at the new rate.
    if (this.enabledAt !== null && cycle - this.enabledAt < 24 * (4 << previous)) this.enabledAt = cycle;
  }

  startIssue(adc, register, value, cycle) {
    const ctrla = register === 'CTRLA' ? value : adc.ctrla;
    const channel = register === 'CH0.CTRL' ? value & 0x1f : adc.ch0Ctrl;
    if (!(adc.ctrla & 1) || (ctrla & 0xc3) !== 1 || (adc.ctrlb & 0x1e) !== 0 ||
        channel !== 1 || adc.ch0Intctrl !== 0 || adc.evctrl !== 0) {
      return { classification: 'ADCA_CONVERSION_CONFIGURATION_UNSUPPORTED',
        reason: 'Expected an enabled ADC, unsigned 12-bit single-ended CH0, software start and polling' };
    }
    const divider = 4 << adc.prescaler;
    if (this.enabledAt === null || cycle - this.enabledAt < 24 * divider) {
      return { classification: 'ADCA_STARTUP_TIMING_UNRESOLVED', reason: 'ADC startup has not passed its specified maximum duration' };
    }
    if (this.pending && cycle >= this.pending.firstStart) {
      return { classification: 'ADCA_OVERLAPPING_START_UNSUPPORTED', reason: 'Another ADC start overlaps an in-flight conversion' };
    }
    return null;
  }

  start(adc, cycle) {
    // Before the sampling clock starts, writing an already-set START bit has no effect.
    if (this.pending) return;
    const divider = 4 << adc.prescaler;
    let firstStart = cycle + 1;
    let lastStart = cycle + divider;
    if (this.clockPhase !== null) {
      firstStart += ((this.clockPhase - firstStart) % divider + divider) % divider;
      lastStart = firstStart;
    }
    this.pending = { index: this.requestCount++, inputPin: (adc.ch0Muxctrl >>> 3) & 7, requestedAt: cycle,
      firstStart, lastStart, firstComplete: firstStart + 7 * divider, lastComplete: lastStart + 7 * divider };
  }

  advanceTo(adc, cycle) {
    if (!this.pending || cycle < this.pending.lastComplete) return;
    this.result = this.results[this.pending.index] ?? null;
    adc.ch0Intflags |= 1;
    this.pending = null;
  }

  accessIssue(adc, register, kind, value, cycle) {
    const isFlag = register === 'INTFLAGS' || register === 'CH0.INTFLAGS';
    const isLow = register === 'CH0RESL' || register === 'CH0.RESL';
    const isHigh = register === 'CH0RESH' || register === 'CH0.RESH';
    if (kind === 'write' && (isLow || isHigh)) {
      return { classification: 'ADCA_RESULT_READ_ONLY', reason: 'ADC result registers are read-only' };
    }
    const p = this.pending;
    if (p) {
      const ambiguousStart = cycle >= p.firstStart && cycle < p.lastStart;
      const ambiguousFinish = cycle >= p.firstComplete && cycle < p.lastComplete;
      const readsStart = kind === 'read' && (register === 'CTRLA' || register === 'CH0.CTRL');
      const checksCompletion = (kind === 'read' && (isLow || (isFlag && !(adc.ch0Intflags & 1)))) ||
        (kind === 'write' && isFlag && (value & 1));
      if ((readsStart && ambiguousStart) || (checksCompletion && ambiguousFinish)) {
        return { classification: 'ADCA_CLOCK_PHASE_UNKNOWN', reason: 'ADC register value depends on the prescaler phase' };
      }
      if (kind === 'write' && !isFlag) {
        const repeatsTrigger = (register === 'CTRLA' && value === (adc.ctrla | 4)) ||
          (register === 'CH0.CTRL' && value === (adc.ch0Ctrl | 0x80));
        if (!repeatsTrigger && register !== 'TEMP' && register !== 'CALL') {
          return { classification: 'ADCA_ACTIVE_CONFIGURATION_UNSUPPORTED', reason: 'ADC configuration write during a conversion' };
        }
      }
    }
    if (kind === 'write' && register === 'CH0.INTCTRL' && (value & 0x0f) && (adc.ch0Intflags & 1)) {
      return { classification: 'ADCA_PENDING_INTERRUPT_UNSUPPORTED', reason: 'ADC interrupt delivery or comparison requires an interrupt source' };
    }
    if (kind === 'read' && isLow && this.result === null) {
      return { classification: 'ADCA_RESULT_UNKNOWN', reason: 'ADC channel 0 requires a digitized input sample' };
    }
    return null;
  }

  startBit(cycle) {
    return Boolean(this.pending && cycle < this.pending.firstStart);
  }

  snapshot() {
    return { requests: this.requestCount, pending: this.pending ? { ...this.pending } : null, result: this.result };
  }
}
