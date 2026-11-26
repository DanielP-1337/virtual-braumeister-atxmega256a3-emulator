// Non-U ATxmega256A3 TC1 register map. XMEGA A manual sections 3.11, 14.5 and 14.12.
import { PERIOD_OFFSET, TEMP_OFFSET, resetTimerRegisters, timerRegisterMappers } from './timer-registers.mjs';
import { TimerClock } from './timer-clock.mjs';
import { TimerCompareBank, timerCompareOffsets } from './timer-compare.mjs';
import { countTimerUp, TimerWaveformControl } from './timer-waveform.mjs';

const A = { name: 'CCA', active: 'cca', buffer: 'ccabuf', valid: 'ccabv', mask: 0x02, activeOffset: 0x28, bufferOffset: 0x38 };
const B = { name: 'CCB', active: 'ccb', buffer: 'ccbbuf', valid: 'ccbbv', mask: 0x04, activeOffset: 0x2a, bufferOffset: 0x3a, traceAllChannels: true };
// Only PERBV, CCABV, and CCBBV exist in the TC1 G aliases.
const TC1_BUFFER_FLAGS = 0x07;

export class TCD1Period {
  constructor({ onAccess = null } = {}) {
    this.peripheral = 'TCD1';
    this.base = 0x0940;
    this.onAccess = onAccess;
    this.reset();
  }

  reset(cycle = 0) {
    this.clock?.reset(cycle);
    this.cnt = 0;
    resetTimerRegisters(this);
    this.waveform?.reset();
    this.compare?.reset();
  }

  countUp(edges) { return countTimerUp(this, edges, this.waveform); }

  snapshotPeriod() { return { per: this.per, temp: this.temp }; }
  snapshotCompareA() { return this.compare?.channelState(A); }
  snapshotCompareB() { return this.compare?.channelState(B); }

  register(registry, { context, fault, mapCompareA = false, mapCompareB = false, onCompareAccess = this.onAccess,
    mapCtrlb = false, onCtrlbAccess = this.onAccess, mapCtrla = false, onCtrlaAccess = this.onAccess } = {}) {
    const lowAddress = this.base + PERIOD_OFFSET;
    const addresses = [this.base + TEMP_OFFSET, lowAddress, lowAddress + 1];
    if (mapCtrla) addresses.push(this.base);
    if (mapCtrlb) addresses.push(this.base + 1);
    const channels = [];
    if (mapCompareA) channels.push(A);
    if (mapCompareB) channels.push(B);
    if (channels.length) addresses.push(...timerCompareOffsets(channels).map(offset => this.base + offset));
    const { mapTemp, mapPeriod, mapByte, mapWord } = timerRegisterMappers(this, registry, addresses, {
      context, fault, beforeAccess: (_address, _kind, cycle) => this.clock?.advanceTo(cycle),
    });
    mapTemp(() => this.snapshotPeriod());
    mapPeriod(this.onAccess);
    if (channels.length) {
      this.compare = new TimerCompareBank(this, channels, TC1_BUFFER_FLAGS);
      this.compare.register(this.base, mapByte, mapWord, onCompareAccess);
    }
    if (mapCtrlb) {
      this.waveform = new TimerWaveformControl(this.peripheral);
      this.waveform.mapControl(this.base, mapByte, onCtrlbAccess);
    }
    this.registry = registry;
    this.registered = true;
    if (mapCtrla) {
      const clock = new TimerClock(this.peripheral, { counter: this, onAccess: onCtrlaAccess });
      clock.register(registry, { context, fault });
    }
  }
}
