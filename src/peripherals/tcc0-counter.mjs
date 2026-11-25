// ATxmega256A3 TCC0, XMEGA A manual §§3.11, 14.6.1, 14.6.4 and 14.12.11–15.
const TEMP = 0x080f, CNTL = 0x0820, PERL = 0x0826;
const MAX = 0xffff;

export class TCC0Counter {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset(cycle = 0) {
    this.clock?.reset(cycle);
    this.cnt = 0;
    this.temp = 0;
    this.per = MAX;
  }

  snapshot() { return { cnt: this.cnt, temp: this.temp }; }
  snapshotPeriod() { return { per: this.per, cnt: this.cnt, temp: this.temp }; }

  countUp(edges) {
    // Below or at TOP, the edge after the TOP match takes CNT to zero.
    // A direct write that leaves CNT above TOP misses that match until 16-bit wrap.
    const firstWrap = (this.cnt > this.per ? MAX : this.per) - this.cnt + 1;
    // NORMAL sets OVFIF when counting reaches TOP. If already at or above
    // TOP, it must wrap and count up to TOP again (including PER = 0).
    const firstTop = this.cnt < this.per ? this.per - this.cnt : firstWrap + this.per;
    if (edges < firstWrap) this.cnt += edges;
    else this.cnt = (edges - firstWrap) % (this.per + 1);
    return edges >= firstTop;
  }

  register(registry, { context = () => ({}), mapPeriod = false, onPeriodAccess = this.onAccess } = {}) {
    const addresses = [TEMP, CNTL, CNTL + 1];
    if (mapPeriod) addresses.push(PERL, PERL + 1);
    if (this.registered || addresses.some(address => registry.handlers.has(address))) {
      throw new Error('TCC0 counter MMIO registration collision');
    }

    const mapByte = (addressByte, register, read, write, report, state) => {
      const access = (kind, value, cycle) => {
        this.clock?.advanceTo(cycle, kind === 'write' && addressByte === CNTL + 1);
        const before = report ? state() : null;
        if (kind === 'read') value = read();
        else write(value);
        report?.({ origin: 'peripheral-model', eventType: 'timer-access', ...context(), peripheral: 'TCC0',
          register, addressByte, kind, cycle, value, completed: true, before, after: state() });
        return value;
      };
      registry.map(addressByte, {
        read: cycle => access('read', undefined, cycle),
        write: (value, cycle) => access('write', value, cycle),
      });
    };
    const mapWord = (lowAddress, name, readWord, writeWord, report, state) => {
      mapByte(lowAddress, name + 'L', () => {
        const word = readWord();
        this.temp = word >>> 8;
        return word & 0xff;
      }, value => { this.temp = value; }, report, state);
      mapByte(lowAddress + 1, name + 'H', () => this.temp,
        value => writeWord((value << 8) | this.temp), report, state);
    };

    const counterState = () => this.snapshot();
    mapByte(TEMP, 'TEMP', () => this.temp, value => { this.temp = value; }, this.onAccess, counterState);
    mapWord(CNTL, 'CNT', () => this.cnt, value => { this.cnt = value; }, this.onAccess, counterState);
    if (mapPeriod) {
      mapWord(PERL, 'PER', () => this.per, value => { this.per = value; }, onPeriodAccess, () => this.snapshotPeriod());
    }
    this.registry = registry;
    this.registered = true;
  }
}
