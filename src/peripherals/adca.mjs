// ATxmega256A3 ADC control and calibration. XMEGA A manual sections 3.11 and 25.16.
const BASE = 0x0200;

export class ADCA {
  constructor({ onAccess = null, conversion = null } = {}) {
    this.onAccess = onAccess;
    this.conversion = conversion;
    this.controlFields = [];
    this.reset();
  }

  reset() {
    this.cal = 0;
    this.temp = 0;
    this.ctrla = 0;
    this.ctrlb = 0;
    this.refctrl = 0;
    this.evctrl = 0;
    this.prescaler = 0;
    this.ch0Ctrl = 0;
    this.ch0Muxctrl = 0;
    this.ch0Intctrl = 0;
    this.ch0Intflags = 0;
    this.conversion?.reset();
  }

  snapshot() {
    const state = { cal: this.cal, temp: this.temp };
    for (const field of this.controlFields) state[field] = this[field];
    if (Object.hasOwn(state, 'prescaler')) state.divider = 4 << state.prescaler;
    if (this.conversion?.requestCount) state.channel0Conversion = this.conversion.snapshot();
    return state;
  }

  get needsClock() { return Boolean(this.conversion?.pending); }

  advanceTo(cycle) { this.conversion?.advanceTo(this, cycle); }

  controlWriteIssue(register, value, cycle) {
    if (register === 'CH0.CTRL' && (value & 0x80)) {
      if (this.conversion) return this.conversion.startIssue(this, register, value, cycle);
      return { classification: 'ADCA_CONVERSION_START_UNSUPPORTED', reason: 'ADCA channel 0 conversion start requires a conversion model' };
    }
    if (register === 'CTRLA') {
      if (this.conversion && (value & 0x3e) === 0x04) return this.conversion.startIssue(this, register, value, cycle);
      if (value & 0x3c) return { classification: 'ADCA_CONVERSION_START_UNSUPPORTED', reason: 'ADCA conversion start requires a conversion model' };
      if (value & 0x02) return { classification: 'ADCA_PIPELINE_FLUSH_UNSUPPORTED', reason: 'ADCA pipeline flush requires a conversion model' };
    }
    if (register === 'CTRLB' && (value & 0x06) === 0x02) {
      return { classification: 'ADCA_RESERVED_RESOLUTION', reason: 'Reserved ADCA.CTRLB resolution selection' };
    }
    if (register === 'EVCTRL' && (value & 0x07) === 0x07) {
      return { classification: 'ADCA_RESERVED_EVENT_ACTION', reason: 'Reserved ADCA.EVCTRL event action selection' };
    }
    // The non-U A3 has positive selectors 0–7. Their sources depend on the channel input mode.
    if (register === 'CH0.MUXCTRL' && (value & 0x40)) {
      return { classification: 'ADCA_RESERVED_MUXPOS', reason: 'Unsupported ATxmega256A3 positive ADC input selection' };
    }
    if (register === 'CH0.INTCTRL' && (value & 0x0c) === 0x08) {
      return { classification: 'ADCA_RESERVED_INTMODE', reason: 'Reserved ADCA channel interrupt mode' };
    }
    const enablesFreeRun = register === 'CTRLA' && (value & 0x01) && (this.ctrlb & 0x08);
    const selectsFreeRun = register === 'CTRLB' && (value & 0x08) && (this.ctrla & 0x01);
    if (enablesFreeRun || selectsFreeRun) {
      return { classification: 'ADCA_FREE_RUNNING_UNSUPPORTED', reason: 'ADCA free-running conversions require a conversion model' };
    }
  }

  register(registry, { mapCalibration = true, mapCtrla = false, mapCtrlb = false, mapRefctrl = false, mapEvctrl = false,
    mapPrescaler = false, mapCh0Ctrl = false, mapCh0Muxctrl = false, mapCh0Intctrl = false, mapCh0Intflags = false,
    mapInterruptFlags = false, mapChannel0Result = false, context = () => ({}),
    fault = (message, details) => { throw Object.assign(new Error(message), details); } } = {}) {
    const writeTemp = value => { this.temp = value; };
    const registers = mapCalibration ? [
      ['TEMP', 0x07, () => this.temp, writeTemp],
      ['CALL', 0x0c, () => {
        this.temp = this.cal >>> 8;
        return this.cal & 0xff;
      }, writeTemp],
      ['CALH', 0x0d, () => this.temp, value => { this.cal = ((value & 0x0f) << 8) | this.temp; }],
    ] : [];
    const controls = [
      [mapCtrla, 'CTRLA', 0x00, 0xff],
      [mapCtrlb, 'CTRLB', 0x01, 0x1e],
      [mapRefctrl, 'REFCTRL', 0x02, 0x33],
      [mapEvctrl, 'EVCTRL', 0x03, 0xff],
      [mapPrescaler, 'PRESCALER', 0x04, 0x07],
      [mapCh0Ctrl, 'CH0.CTRL', 0x20, 0x1f, 'ch0Ctrl'],
      [mapCh0Muxctrl, 'CH0.MUXCTRL', 0x21, 0x7b, 'ch0Muxctrl'],
      [mapCh0Intctrl, 'CH0.INTCTRL', 0x22, 0x0f, 'ch0Intctrl'],
    ].filter(([mapped]) => mapped);
    const fields = [];
    for (const [, name, offset, mask, field = name.toLowerCase()] of controls) {
      fields.push(field);
      const startBit = name === 'CTRLA' ? 0x04 : name === 'CH0.CTRL' ? 0x80 : 0;
      const read = cycle => this[field] | (startBit && this.conversion?.startBit(cycle) ? startBit : 0);
      const write = (value, cycle) => {
        if (this.conversion && name === 'CTRLA') {
          if ((this.ctrla ^ value) & 1) this.conversion.setEnable(Boolean(value & 1), cycle);
          this.ctrla = value & 0xc1;
        } else {
          if (name === 'PRESCALER' && (value & mask) !== this.prescaler) {
            this.conversion?.prescalerChanged(this.prescaler, cycle);
          }
          this[field] = value & mask;
        }
        if (this.conversion && (value & startBit)) this.conversion.start(this, cycle);
      };
      registers.push([name, offset, read, write]);
    }
    if (mapCh0Intflags) {
      fields.push('ch0Intflags');
      registers.push(['CH0.INTFLAGS', 0x23, () => this.ch0Intflags, value => { this.ch0Intflags &= ~(value & 0x01); }]);
    }
    if (mapInterruptFlags) {
      registers.push(['INTFLAGS', 0x06, () => this.ch0Intflags, value => { this.ch0Intflags &= ~(value & 1); }]);
    }
    if (mapChannel0Result) {
      if (!this.conversion) throw new Error('Channel 0 result registers require an ADC conversion model');
      const low = () => {
        this.temp = this.conversion.result >>> 8;
        return this.conversion.result & 0xff;
      };
      for (const [name, offset] of [['CH0RES', 0x10], ['CH0.RES', 0x24]]) {
        registers.push([name + 'L', offset, low], [name + 'H', offset + 1, () => this.temp]);
      }
    }
    if (this.registered || registers.some(([, offset]) => registry.handlers.has(BASE + offset))) {
      throw new Error('ADCA MMIO registration collision');
    }
    this.controlFields = fields;
    for (const [register, offset, read, write] of registers) {
      const addressByte = BASE + offset;
      const access = (kind, value, cycle) => {
        this.advanceTo(cycle);
        const before = this.onAccess ? this.snapshot() : null;
        const issue = this.conversion?.accessIssue(this, register, kind, value, cycle) ||
          (kind === 'write' && this.controlWriteIssue(register, value, cycle));
        if (!issue) {
          if (kind === 'read') value = read(cycle);
          else write(value, cycle);
        }
        this.onAccess?.({ origin: 'peripheral-model', eventType: 'adc-access', ...context(),
          peripheral: 'ADCA', register, addressByte, kind, value, cycle, completed: !issue,
          ...(issue ? { classification: issue.classification } : {}), before, after: this.snapshot() });
        if (issue) return fault(issue.reason, { classification: issue.classification, addressByte, accessKind: kind, attemptedValue: value });
        return value;
      };
      registry.map(addressByte, { read: cycle => access('read', undefined, cycle), write: (value, cycle) => access('write', value, cycle) });
    }
    this.registered = true;
  }
}
