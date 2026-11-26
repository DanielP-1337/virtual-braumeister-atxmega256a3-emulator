// XMEGA A manual sections 14.5, 14.6 and 14.12.2, table 14-4. Default non-U A3 pin multiplexing.
const MODE_MASK = 0x07, SINGLE_SLOPE = 3;
const instances = new Map([
  ['TCC0', { channelMask: 0xf0, singleSlope: false }],
  ['TCD0', { channelMask: 0xf0, singleSlope: true, firstPin: 0, outputs: ['TCD0.OC0A', 'TCD0.OC0B', 'TCD0.OC0C', 'TCD0.OC0D'] }],
  ['TCD1', { channelMask: 0x30, singleSlope: true, firstPin: 4, outputs: ['TCD1.OC1A', 'TCD1.OC1B'] }],
]);

// Consume actual timer input edges. Selecting a mode at CNT=0 does not generate a BOTTOM event.
export function countTimerUp(timer, edges, waveform) {
  if (!Number.isSafeInteger(edges) || edges < 0) throw new RangeError('Expected a nonnegative count of timer edges');
  // A period write below the current count misses TOP until the 16-bit counter wraps.
  const firstWrap = (timer.cnt > timer.per ? 0xffff : timer.per) - timer.cnt + 1;
  const firstTop = timer.cnt < timer.per ? timer.per - timer.cnt : firstWrap + timer.per;
  if (edges < firstWrap) timer.cnt += edges;
  else timer.cnt = (edges - firstWrap) % (timer.per + 1);
  const reached = edges >= (waveform?.updateAtBottom ? firstWrap : firstTop);
  if (reached) timer.compare?.update();
  return reached;
}

export class TimerWaveformControl {
  constructor(peripheral) {
    this.layout = instances.get(peripheral);
    if (!this.layout) throw new RangeError('Unsupported waveform control instance: ' + peripheral);
    this.peripheral = peripheral;
    this.reset();
  }

  reset() { this.ctrlb = 0; }

  get updateAtBottom() { return (this.ctrlb & MODE_MASK) === SINGLE_SLOPE; }

  snapshot() { return { ctrlb: this.ctrlb, wgmode: this.ctrlb & MODE_MASK, channelEnables: this.ctrlb >>> 4 }; }

  outputSource(port, pin) {
    if (!this.layout.outputs || !this.updateAtBottom || port !== 'D' || !Number.isInteger(pin)) return null;
    const index = pin - this.layout.firstPin;
    if (index < 0 || index >= this.layout.outputs.length) return null;
    return (this.ctrlb & (0x10 << index)) ? this.layout.outputs[index] : null;
  }

  writeIssue(value) {
    const mode = value & MODE_MASK;
    if (mode === 2 || mode === 4) {
      return { code: 'RESERVED_WGMODE', reason: 'Reserved ' + this.peripheral + ' waveform generation mode' };
    }
    if (mode !== 0 && !(this.layout.singleSlope && mode === SINGLE_SLOPE)) {
      const modes = this.layout.singleSlope ? 'frequency and dual-slope' : 'frequency and PWM';
      return { code: 'WAVEFORM_MODE_UNMODELED', reason: this.peripheral + ' ' + modes + ' waveform generation are unmodeled' };
    }
  }

  mapControl(base, mapByte, report) {
    mapByte(base + 1, 'CTRLB', () => this.ctrlb, value => {
      this.ctrlb = value & (this.layout.channelMask | MODE_MASK);
    }, report, () => this.snapshot(), value => this.writeIssue(value));
  }
}
