// TC0 control accounts for clock edges through the MMIO completion cycle in the previously selected mode.
import { timerRegisterMappers } from './timer-registers.mjs';
import { TimerWaveformControl } from './timer-waveform.mjs';

export class TC0WaveformControl extends TimerWaveformControl {
  constructor(peripheral, { clock, onAccess = null }) {
    if (peripheral !== 'TCC0' && peripheral !== 'TCD0') throw new RangeError('Unsupported TC0 instance');
    super(peripheral);
    this.clock = clock;
    this.onAccess = onAccess;
  }

  register(registry, { context, fault } = {}) {
    const counter = this.clock.counter, peripheral = this.peripheral;
    const addressByte = counter.base + 1;
    if (counter.peripheral !== peripheral || this.clock.peripheral !== peripheral || counter.clock !== this.clock ||
        counter.registry !== registry || this.clock.waveform || registry.handlers.has(addressByte)) {
      throw new Error(peripheral + ' waveform control requires its registered clock and a free CTRLB handler');
    }
    const { mapByte } = timerRegisterMappers(this, registry, [addressByte], {
      context, fault, beforeAccess: (_address, _kind, cycle) => this.clock.advanceTo(cycle),
    });
    this.mapControl(counter.base, mapByte, this.onAccess);
    this.clock.waveform = this;
  }
}
