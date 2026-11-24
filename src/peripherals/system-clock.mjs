// ATxmega256A3 CLK.CTRL, XMEGA A manual sections 3.12 and 7.9.1. Prescalers are at reset divide-by-one.
export const CLK_CTRL = 0x0040;
export const RESET_CLOCK_HZ = 2000000;
export const TIME_TICKS_PER_SECOND = 512000000; // Exact common multiple of all three internal RC frequencies.
const rates = [RESET_CLOCK_HZ, 32000000, 32768];
const periods = rates.map(hz => TIME_TICKS_PER_SECOND / hz);

function edge(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Clock time must be a nonnegative safe integer');
  return value;
}

export class SystemClock {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.switches = [];
    this.lastAccessCycle = 0;
    this.ccp?.clear();
  }

  // A rate segment begins after the second old-source edge. The next edge uses the new period.
  timeAt(cycle) {
    edge(cycle);
    const s = this.switches.findLast(t => t.rateChangeCycle <= cycle);
    return edge(s ? s.rateChangeTicks + (cycle - s.rateChangeCycle) * periods[s.to] : cycle * periods[0]);
  }

  // The first CPU edge at or after a physical-time deadline.
  cycleAt(ticks) {
    edge(ticks);
    const s = this.switches.findLast(t => t.rateChangeTicks <= ticks);
    return edge(s ? s.rateChangeCycle + Math.ceil((ticks - s.rateChangeTicks) / periods[s.to]) : Math.ceil(ticks / periods[0]));
  }

  deadlineTicks(startCycle, resetClockDuration) {
    return edge(this.timeAt(startCycle) + edge(resetClockDuration) * periods[0]);
  }

  snapshot(cycle = this.lastAccessCycle) {
    const elapsedTicks = this.timeAt(cycle);
    const s = this.switches.findLast(t => t.writeCycle <= cycle);
    const activeSelector = s ? (cycle < s.rateChangeCycle ? s.from : s.to) : 0;
    const inProgress = s && cycle < s.completeCycle;
    return { ctrl: s?.to ?? 0, activeSelector, cpuClockHz: rates[activeSelector], elapsedTicks,
      phase: inProgress ? (cycle < s.rateChangeCycle ? 'old-source' : 'new-source') : 'settled',
      protectedSources: inProgress ? (1 << s.from) | (1 << s.to) : 1 << activeSelector };
  }

  register(bus, oscillator) {
    if (this.ccp || bus.mmio.handlers.has(CLK_CTRL)) throw new Error('CLK.CTRL MMIO registration collision');
    if (oscillator.systemClock !== this) throw new Error('CLK and OSC must share the same time base');
    bus.bindCCP(() => bus.mmio.map(CLK_CTRL, {
      read: cycle => this.access(bus.cpu, oscillator, 'read', null, cycle, false),
      write: (value, cycle, grant) => this.access(bus.cpu, oscillator, 'write', value, cycle, grant),
    }));
    this.ccp = bus.ccp;
  }

  access(cpu, oscillator, kind, value, cycle, grant) {
    if (cycle < this.lastAccessCycle) throw new RangeError('Clock MMIO accesses must be monotonic');
    const before = this.snapshot(cycle);
    let outcome = 'read', classification, reason, change = null;
    if (kind === 'read') value = before.ctrl;
    else if (!grant) outcome = 'no-ccp-grant';
    else {
      const target = value & 7; // Bits 7:3 are reserved and read zero.
      const bit = 1 << target;
      const source = oscillator.snapshot(cycle);
      if (target > 4) {
        classification = 'CLK_RESERVED_SOURCE'; reason = 'Reserved CLK.CTRL source selection';
      } else if (target === before.ctrl) outcome = 'already-selected';
      else if (!(source.ctrl & bit)) outcome = 'source-disabled';
      else if (source.unknownBits & bit) {
        classification = 'CLK_SOURCE_READY_UNKNOWN'; reason = 'CLK.CTRL selection needs a known ready bit for the requested source';
      } else if (!(source.readyBits & bit)) outcome = 'source-not-ready';
      else if (before.phase !== 'settled') {
        classification = 'CLK_SWITCH_IN_PROGRESS'; reason = 'Overlapping changes to different ready clock sources are unmodeled';
      } else {
        // OSC does not permit enabling XOSC or PLL, so a ready source here is an internal RC oscillator.
        const rateChangeCycle = edge(cycle + 2);
        change = { from: before.activeSelector, to: target, writeCycle: cycle, rateChangeCycle,
          completeCycle: edge(cycle + 4), rateChangeTicks: this.timeAt(rateChangeCycle) };
        this.switches.push(change);
        outcome = 'accepted';
      }
    }
    if (this.onAccess) this.onAccess({ origin: 'peripheral-model', eventType: 'clock-access', pcWord: cpu.pc,
      instructionAttempt: cpu.steps + 1, addressByte: CLK_CTRL, kind, value, cycle, ioGrant: grant,
      completed: !classification, outcome: classification ?? outcome, before, after: this.snapshot(cycle), change });
    if (classification) cpu.fault(reason, { classification, addressByte: CLK_CTRL, accessKind: kind, attemptedValue: value });
    this.lastAccessCycle = cycle;
    return value;
  }
}
