// XMEGA A manual sections 14.5 and 14.12.8–21. Each timer owns its compare buffers and CPU TEMP.
const FCLR = 0x08, FSET = 0x09, GCLR = 0x0a, GSET = 0x0b;
const LUPD = 0x02, CMD_MASK = 0x0c, CMD_UPDATE = 0x04;

export function timerCompareOffsets(channels) {
  return [FCLR, FSET, GCLR, GSET, ...channels.flatMap(({ activeOffset, bufferOffset }) =>
    [activeOffset, activeOffset + 1, bufferOffset, bufferOffset + 1])];
}

export class TimerCompareBank {
  constructor(counter, channels, hardwareFlags) {
    this.counter = counter;
    this.channels = channels;
    this.hardwareFlags = hardwareFlags;
    this.supportedFlags = channels.reduce((bits, channel) => bits | channel.mask, 0);
    this.reset();
  }

  reset() {
    this.lupd = false;
    for (const { active, buffer, valid } of this.channels) {
      this[active] = 0;
      this[buffer] = 0;
      this[valid] = false;
    }
  }

  channelState({ active, buffer, valid, mask }) {
    if (this.supportedFlags & mask) {
      return { [active]: this[active], [buffer]: this[buffer], [valid]: this[valid], lupd: this.lupd, temp: this.counter.temp };
    }
  }

  snapshotAll() {
    return Object.assign({}, ...this.channels.map(channel => this.channelState(channel)));
  }

  update() {
    if (this.lupd) return;
    for (const { active, buffer, valid } of this.channels) {
      if (this[valid]) {
        this[active] = this[buffer];
        this[valid] = false;
      }
    }
  }

  validFlags() {
    let bits = 0;
    for (const { valid, mask } of this.channels) if (this[valid]) bits |= mask;
    return bits;
  }

  writeFlags(bits, enabled) {
    for (const { valid, mask } of this.channels) if (bits & mask) this[valid] = enabled;
  }

  register(base, mapByte, mapWord, report) {
    const sharedState = () => this.snapshotAll();
    const readF = () => this.lupd ? LUPD : 0;
    const readG = () => this.validFlags();
    const validateFSet = value => {
      if (value & 1) return { code: 'DIRECTION_UNMODELED', reason: 'Down-counting is unmodeled' };
      if ((value & CMD_MASK) > CMD_UPDATE) return { code: 'COMMAND_UNMODELED', reason: 'Restart and hard reset commands are unmodeled' };
    };
    const validateG = value => {
      if (value & this.hardwareFlags & ~this.supportedFlags) {
        return { code: 'BUFFER_FLAGS_UNMODELED', reason: 'Write to an unmodeled timer buffer-valid flag' };
      }
    };

    mapByte(base + FCLR, 'CTRLFCLR', readF, value => { if (value & LUPD) this.lupd = false; }, report, sharedState);
    mapByte(base + FSET, 'CTRLFSET', readF, value => {
      if (value & LUPD) this.lupd = true;
      if ((value & CMD_MASK) === CMD_UPDATE) this.update();
    }, report, sharedState, validateFSet);
    mapByte(base + GCLR, 'CTRLGCLR', readG, value => this.writeFlags(value, false), report, sharedState, validateG);
    mapByte(base + GSET, 'CTRLGSET', readG, value => this.writeFlags(value, true), report, sharedState, validateG);

    for (const channel of this.channels) {
      const { name, activeOffset, bufferOffset, active, buffer, valid } = channel;
      const state = channel.traceAllChannels ? sharedState : () => this.channelState(channel);
      mapWord(base + activeOffset, name, () => this[active], word => { this[active] = word; }, report, state);
      mapWord(base + bufferOffset, name + 'BUF', () => this[buffer], word => {
        this[buffer] = word;
        this[valid] = true;
      }, report, state);
    }
  }
}
