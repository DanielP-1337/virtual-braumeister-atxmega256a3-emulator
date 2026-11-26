// ATxmega256A3 TC0 compare channels. The TC0 G aliases include PERBV and CC[A-D]BV.
import { TimerCompareBank, timerCompareOffsets } from './timer-compare.mjs';

const C = { name: 'CCC', active: 'ccc', buffer: 'cccbuf', valid: 'cccbv', mask: 0x08, activeOffset: 0x2c, bufferOffset: 0x3c };
// The existing channel D trace includes the state of both modeled channels.
const D = { name: 'CCD', active: 'ccd', buffer: 'ccdbuf', valid: 'ccdbv', mask: 0x10, activeOffset: 0x2e, bufferOffset: 0x3e, traceAllChannels: true };

function channels(mapCompareC, mapCompareD) {
  const selected = [];
  if (mapCompareC) selected.push(C);
  if (mapCompareD) selected.push(D);
  return selected;
}

export function compareOffsets(mapCompareC, mapCompareD) {
  return timerCompareOffsets(channels(mapCompareC, mapCompareD));
}

export const compareCOffsets = Object.freeze(compareOffsets(true, false));

export class TC0CompareBank extends TimerCompareBank {
  constructor(counter, { mapCompareC = true, mapCompareD = false } = {}) {
    super(counter, channels(mapCompareC, mapCompareD), 0x1f);
  }

  snapshot() { return this.channelState(C); }
  snapshotD() { return this.channelState(D); }
}
