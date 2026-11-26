// ATxmega256A3 TC0 instances. XMEGA A manual §§3.11, 14.6.1, 14.6.4, 14.12.11–15.
import { TC0CompareBank, compareOffsets } from './tc0-compare.mjs';
import { countTimerUp } from './timer-waveform.mjs';
import { PERIOD_OFFSET, TEMP_OFFSET, resetTimerRegisters, timerRegisterMappers } from './timer-registers.mjs';

const BASE = new Map([['TCC0', 0x0800], ['TCD0', 0x0900]]);

export class TC0Counter {
  constructor(peripheral, { onAccess = null } = {}) {
    if (!BASE.has(peripheral)) throw new RangeError('Unsupported TC0 instance: ' + peripheral);
    this.peripheral = peripheral;
    this.base = BASE.get(peripheral);
    this.onAccess = onAccess;
    this.reset();
  }

  reset(cycle = 0) {
    this.clock?.reset(cycle);
    this.compare?.reset();
    this.cnt = 0;
    resetTimerRegisters(this);
  }

  snapshot() { return { cnt: this.cnt, temp: this.temp }; }
  snapshotPeriod() { return { per: this.per, cnt: this.cnt, temp: this.temp }; }

  countUp(edges) { return countTimerUp(this, edges, this.clock?.waveform); }

  register(registry, { context = () => ({}), mapCounter = true, mapPeriod = false, onPeriodAccess = this.onAccess,
    mapCompareC = false, mapCompareD = false, onCompareAccess = this.onAccess, fault } = {}) {
    const base = this.base;
    const cntLow = base + 0x20, perLow = base + PERIOD_OFFSET;
    const addresses = [base + TEMP_OFFSET];
    if (mapCounter) addresses.push(cntLow, cntLow + 1);
    if (mapPeriod) addresses.push(perLow, perLow + 1);
    if (mapCompareC || mapCompareD) addresses.push(...compareOffsets(mapCompareC, mapCompareD).map(offset => base + offset));
    const { mapByte, mapWord, mapTemp, mapPeriod: mapActivePeriod } = timerRegisterMappers(this, registry, addresses, {
      context, fault, beforeAccess: (address, kind, cycle) => {
        this.clock?.advanceTo(cycle, kind === 'write' && address === cntLow + 1);
      },
    });
    const counterState = () => this.snapshot();
    mapTemp(counterState);
    if (mapCounter) {
      mapWord(cntLow, 'CNT', () => this.cnt, value => { this.cnt = value; }, this.onAccess, counterState);
    }
    if (mapPeriod) mapActivePeriod(onPeriodAccess);
    if (mapCompareC || mapCompareD) {
      this.compare = new TC0CompareBank(this, { mapCompareC, mapCompareD });
      if (mapCompareC) this.compareC = this.compare;
      this.compare.register(base, mapByte, mapWord, onCompareAccess);
    }
    this.registry = registry;
    this.registered = true;
  }
}
