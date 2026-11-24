// ATxmega256A3, XMEGA A manual 7.4, 7.5, 7.10 and 9.3. Startup durations use 2 MHz reference clocks.
import { DFLL32M, DFLLRC32M_CTRL } from './dfll32m.mjs';

const CTRL = 0x0050, STATUS = 0x0051, DFLLCTRL = 0x0056;
// The non-U ATxmega256A3 device pack defines one reference bit per oscillator.
const RC32MCREF = 0x02, RC2MCREF = 0x01;
const RC2M = 0x01;
const sources = [['rc2m', RC2M], ['rc32m', 0x02], ['rc32k', 0x04]];

export class OscillatorController {
  constructor({ startupCycles = {}, onAccess = null, systemClock = null } = {}) {
    this.systemClock = systemClock;
    this.startupCycles = Object.freeze(Object.fromEntries(sources.map(([name]) => {
      const delay = startupCycles[name] ?? null;
      if (delay !== null && (!Number.isSafeInteger(delay) || delay < 1)) throw new RangeError('Expected a positive oscillator startup delay in CPU clocks');
      return [name, delay];
    })));
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.inReset = true;
    this.control = RC2M;
    this.dfllctrl = 0;
    this.dfll32m?.reset();
    this.enabledAt = { rc32m: null, rc32k: null };
    this.lastAccessCycle = 0;
  }

  releaseReset() {
    // The CPU begins fetching only after its selected RC2M clock has started.
    this.inReset = false;
  }

  snapshot(cycle = this.lastAccessCycle) {
    if (!Number.isSafeInteger(cycle) || cycle < this.lastAccessCycle) throw new RangeError('Expected a monotonic oscillator clock');
    const readyAt = { rc32m: null, rc32k: null };
    let readyBits = 0, unknownBits = 0;
    for (const [name, bit] of sources) {
      const start = this.enabledAt[name], delay = this.startupCycles[name];
      if (this.inReset || !(this.control & bit)) continue;
      if (bit === RC2M && start === undefined) {
        readyBits |= RC2M; // Already stable at CPU reset release. A subsequent enable starts a new interval.
        continue;
      }
      if (delay === null) unknownBits |= bit;
      else {
        readyAt[name] = this.systemClock
          ? this.systemClock.cycleAt(this.systemClock.deadlineTicks(start, delay))
          : start + delay;
        if (cycle >= readyAt[name]) readyBits |= bit;
      }
    }
    return { inReset: this.inReset, ctrl: this.control, status: unknownBits ? null : readyBits,
      readyBits, unknownBits, enabledAt: { ...this.enabledAt }, readyAt };
  }

  referenceSelection(bits = this.dfllctrl) {
    return { dfllctrl: bits,
      rc32m: bits & RC32MCREF ? 'XOSC32' : 'RC32K',
      rc2m: bits & RC2MCREF ? 'XOSC32' : 'RC32K' };
  }

  register(registry, { fault = (message, details) => { throw Object.assign(new Error(message), details); },
    context = () => ({}), dfllReference = false, dfll32m = false, onDfllAccess = null } = {}) {
    if (dfll32m && !dfllReference) throw new Error('DFLLRC32M requires the OSC reference selector');
    const addresses = dfllReference ? [CTRL, STATUS, DFLLCTRL] : [CTRL, STATUS];
    if (dfll32m) addresses.push(DFLLRC32M_CTRL);
    if (this.registered || addresses.some(address => registry.handlers.has(address))) throw new Error('OSC MMIO registration collision');
    if (dfll32m) this.dfll32m = new DFLL32M(this, onDfllAccess);
    this.fault = fault;
    this.context = context;
    for (const address of addresses) registry.map(address, {
      read: cycle => this.access(address, 'read', null, cycle),
      write: (byte, cycle) => this.access(address, 'write', byte, cycle),
    });
    this.registered = true;
  }

  access(addressByte, kind, value, cycle) {
    const before = this.snapshot(cycle);
    if (addressByte === DFLLRC32M_CTRL) {
      const result = this.dfll32m.access(kind, value, cycle, before);
      this.lastAccessCycle = cycle;
      return result;
    }
    const referenceBefore = addressByte === DFLLCTRL ? this.referenceSelection() : null;
    let classification, reason;
    if (addressByte === DFLLCTRL) {
      // Selecting a reference neither enables its oscillator nor starts the calibration loop.
      if (kind === 'read') value = this.dfllctrl;
      else if (!this.inReset) {
        const bits = value & (RC32MCREF | RC2MCREF);
        const issue = this.dfll32m?.checkReferenceSelection(this.referenceSelection(bits).rc32m, before);
        if (issue) ({ classification, reason } = issue);
        else this.dfllctrl = bits;
      }
    } else if (kind === 'read') {
      value = addressByte === CTRL ? before.ctrl : before.status;
      if (value === null) {
        classification = 'OSC_STARTUP_TIMING_UNKNOWN';
        reason = 'OSC.STATUS read needs an enable-to-ready delay for ' +
          sources.filter(([, bit]) => before.unknownBits & bit).map(([name]) => name.toUpperCase()).join(' and ');
      }
    } else if (addressByte === CTRL && !this.inReset) {
      if (value & 0x18) {
        classification = 'OSC_SOURCE_UNMODELED';
        reason = 'OSC.CTRL requests an unmodeled external oscillator or PLL';
      } else {
        // Both sources are protected during a handover. Standalone OSC uses its reset system source.
        const protectedSources = this.systemClock?.snapshot(cycle).protectedSources ?? RC2M;
        const control = (value & 0x07) | protectedSources;
        const issue = this.dfll32m?.checkOscillatorControl(control);
        if (issue) ({ classification, reason } = issue);
        else {
          for (const [name, bit] of sources) {
            if ((this.control ^ control) & bit) this.enabledAt[name] = (control & bit) ? cycle : null;
          }
          this.control = control;
        }
      }
    } // STATUS is read-only. Writes during reset also leave the reset values intact.
    if (this.onAccess) this.onAccess({ origin: 'peripheral-model', eventType: 'osc-access', ...this.context(),
      cycle, addressByte, kind, value, completed: !classification, before, after: this.snapshot(cycle),
      ...(referenceBefore ? { referenceBefore, referenceAfter: this.referenceSelection() } : {}), ...(classification ? { classification } : {}) });
    if (classification) return this.fault(reason, { classification, addressByte, accessKind: kind, attemptedValue: kind === 'write' ? value : null });
    this.lastAccessCycle = cycle;
    return value;
  }
}
