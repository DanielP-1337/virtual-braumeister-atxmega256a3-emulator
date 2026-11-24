// ATxmega256A3 DFLL32M control. XMEGA A manual 7.7 and 7.11.1.
export const DFLLRC32M_CTRL = 0x0060;
const referenceBits = { RC32K: 0x04, XOSC32: 0x08 };

function referenceState(source, osc) {
  const bit = referenceBits[source];
  if (!(osc.ctrl & bit)) return 'disabled';
  if (osc.unknownBits & bit) return 'unknown';
  return osc.readyBits & bit ? 'ready' : 'starting';
}

function enableIssue(source, osc) {
  switch (referenceState(source, osc)) {
    case 'ready': return null;
    case 'disabled': return { classification: 'DFLL_REFERENCE_DISABLED', reason: 'Selected DFLL reference ' + source + ' is disabled' };
    case 'starting': return { classification: 'DFLL_REFERENCE_NOT_READY', reason: 'Selected DFLL reference ' + source + ' is still starting' };
    case 'unknown': return { classification: 'DFLL_REFERENCE_READY_UNKNOWN', reason: 'Startup time of selected DFLL reference ' + source + ' is unknown' };
  }
}

export class DFLL32M {
  constructor(oscillator, onAccess) {
    this.oscillator = oscillator;
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.ctrl = 0;
    this.pendingRelease = 0;
  }

  get activeReferenceBit() {
    return this.ctrl ? referenceBits[this.oscillator.referenceSelection().rc32m] : 0;
  }

  snapshot(osc) {
    const reference = this.oscillator.referenceSelection().rc32m;
    return { ctrl: this.ctrl, reference, referenceState: referenceState(reference, osc),
      heldReferenceMask: this.activeReferenceBit | this.pendingRelease, awaitingDisableReadback: this.pendingRelease !== 0 };
  }

  // The selector lives in OSC. A failed change must leave both modules untouched.
  checkReferenceSelection(source, osc) {
    if (!this.ctrl || source === this.oscillator.referenceSelection().rc32m) return null;
    return enableIssue(source, osc);
  }

  checkOscillatorControl(control) {
    if (this.activeReferenceBit & ~control) {
      return { classification: 'DFLL_REFERENCE_IN_USE', reason: 'Disabling the selected reference while DFLLRC32M is enabled' };
    }
    if (this.pendingRelease & ~control) {
      return { classification: 'DFLL_DISABLE_READBACK_REQUIRED', reason: 'Read DFLLRC32M.CTRL as zero before disabling its reference' };
    }
    return null;
  }

  access(kind, value, cycle, osc) {
    const before = this.snapshot(osc);
    let issue = null;
    if (kind === 'read') {
      value = this.ctrl;
      if (!value) this.pendingRelease = 0;
    } else if (!osc.inReset) {
      if (value & 1) {
        issue = enableIssue(before.reference, osc);
        if (!issue) this.ctrl = 1;
      } else {
        this.pendingRelease |= this.activeReferenceBit;
        this.ctrl = 0; // Only a software read of zero releases the reference.
      }
    }

    if (this.onAccess) this.onAccess({ origin: 'peripheral-model', eventType: 'dfll32m-access', ...this.oscillator.context(),
      addressByte: DFLLRC32M_CTRL, kind, cycle, value, completed: !issue, before, after: this.snapshot(osc),
      ...(issue ? { classification: issue.classification } : {}) });
    if (issue) return this.oscillator.fault(issue.reason, { classification: issue.classification,
      addressByte: DFLLRC32M_CTRL, accessKind: kind, attemptedValue: value });
    return value;
  }
}
