// XMEGA A manual 8077I, sections 13.3 and 13.13; A3 device address map.
// Latches and drive intent are modeled. No external wiring or pin samples are assumed.
export const PORT_BASES = Object.freeze({ A: 0x600, B: 0x620, C: 0x640, D: 0x660, E: 0x680, F: 0x6a0 });
const NAMES = ['DIR', 'DIRSET', 'DIRCLR', 'DIRTGL', 'OUT', 'OUTSET', 'OUTCLR', 'OUTTGL', 'IN'];
const OFFSETS = [...Array(9).keys(), ...Array.from({ length: 8 }, (_, n) => 0x10 + n)];
const byte = value => { if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Expected an unsigned byte'); return value; };

export class GPIOController {
  constructor({ onAccess = null } = {}) {
    this.onAccess = onAccess; this.registered = false;
    this.context = () => ({});
    this.fault = (message, details) => { throw Object.assign(new Error(message), details); };
    this.reset();
  }
  reset() {
    this.ports = Object.fromEntries(Object.keys(PORT_BASES).map(name => [name, { dir: 0, out: 0, pinctrl: new Uint8Array(8), inputSample: 0, inputKnownMask: 0 }]));
  }
  port(name) { if (!Object.hasOwn(this.ports, name)) throw new RangeError('Unknown A3 port'); return this.ports[name]; }
  snapshot(name) {
    const p = this.port(name); return { dir: p.dir, out: p.out, pinctrl: Array.from(p.pinctrl), inputSample: p.inputSample, inputKnownMask: p.inputKnownMask };
  }
  snapshotAll() { return Object.fromEntries(Object.keys(PORT_BASES).map(n => [n, this.snapshot(n)])); }
  // Explicit external digital samples, not a network/electrical simulation. Caller owns time.
  setInputSample(name, value, knownMask = 255) {
    byte(value); byte(knownMask); const p = this.port(name); p.inputSample = value; p.inputKnownMask = knownMask;
  }
  drive(name, pin) {
    if (!Number.isInteger(pin) || pin < 0 || pin > 7) throw new RangeError('Invalid pin index');
    const p = this.port(name), cfg = p.pinctrl[pin], opc = (cfg >>> 3) & 7;
    const output = !!(p.dir & (1 << pin)), logical = (p.out >>> pin) & 1, inverted = !!(cfg & 0x40);
    const level = logical ^ +inverted;
    let drive = null;
    if (output) {
      if (opc <= 3) drive = level;
      else if ((opc === 4 || opc === 6) && level === 1) drive = 1;
      else if ((opc === 5 || opc === 7) && level === 0) drive = 0;
    }
    let bias = 'none';
    if (opc === 1) bias = 'keeper-unresolved';
    if ((!output && opc === 2) || opc === 6) bias = 'pull-down';
    if ((!output && opc === 3) || opc === 7) bias = 'pull-up';
    return { direction: output ? 'output' : 'input', latch: logical, inverted, drive, highImpedance: drive === null, bias, inputEnabled: (cfg & 7) !== 7, slewRateLimited: !!(cfg & 0x80) };
  }
  register(registry, { fault, context = () => ({}) } = {}) {
    if (this.registered) throw new Error('GPIO already registered');
    // Preflight avoids a partially registered bank on collision.
    for (const base of Object.values(PORT_BASES)) for (const offset of OFFSETS) if (registry.handlers.has(base + offset)) throw new Error('GPIO MMIO registration collision');
    if (fault) this.fault = fault; this.context = context;
    for (const [name, base] of Object.entries(PORT_BASES)) for (const offset of OFFSETS) {
      registry.map(base + offset, { read: () => this.read(name, offset), write: value => this.write(name, offset, value) });
    }
    this.registered = true;
  }
  fail(name, offset, kind, classification, reason, value = null) {
    this.fault(reason, { classification, addressByte: PORT_BASES[name] + offset, accessKind: kind, attemptedValue: value });
  }
  read(name, offset) {
    const p = this.port(name), before = this.onAccess ? this.snapshot(name) : null; let value;
    if (!Number.isInteger(offset)) this.fail(name, offset, 'read', 'GPIO_UNSUPPORTED_REGISTER', 'Invalid GPIO register offset');
    if (offset >= 0 && offset <= 3) value = p.dir;
    else if (offset >= 4 && offset <= 7) value = p.out;
    else if (offset === 8) {
      if (p.pinctrl.some(c => (c & 7) === 7)) this.fail(name, offset, 'read', 'GPIO_INPUT_DISABLED_UNMODELED', 'GPIO input-buffer-disabled sampling behavior is not modeled');
      if (p.inputKnownMask !== 255) this.fail(name, offset, 'read', 'GPIO_UNRESOLVED_INPUT', 'GPIO IN requires explicit samples for every pin; no external level is assumed');
      value = p.inputSample;
      for (let pin = 0; pin < 8; pin++) if (p.pinctrl[pin] & 0x40) value ^= 1 << pin;
    } else if (offset >= 0x10 && offset <= 0x17) value = p.pinctrl[offset - 0x10];
    else this.fail(name, offset, 'read', 'GPIO_UNSUPPORTED_REGISTER', 'Unsupported GPIO register');
    this.emit(name, offset, 'read', value, before); return value;
  }
  write(name, offset, value) {
    byte(value); const p = this.port(name), before = this.onAccess ? this.snapshot(name) : null;
    if (!Number.isInteger(offset)) this.fail(name, offset, 'write', 'GPIO_UNSUPPORTED_REGISTER', 'Invalid GPIO register offset', value);
    if (offset >= 0 && offset <= 7) {
      const field = offset < 4 ? 'dir' : 'out', action = offset & 3;
      if (action === 0) p[field] = value;
      if (action === 1) p[field] |= value;
      if (action === 2) p[field] &= ~value & 255;
      if (action === 3) p[field] ^= value;
    } else if (offset >= 0x10 && offset <= 0x17) {
      const isc = value & 7;
      if (isc >= 4 && isc <= 6) this.fail(name, offset, 'write', 'GPIO_RESERVED_CONFIGURATION', 'Reserved GPIO input/sense configuration', value);
      p.pinctrl[offset - 0x10] = value;
    } else this.fail(name, offset, 'write', offset === 8 ? 'GPIO_READ_ONLY' : 'GPIO_UNSUPPORTED_REGISTER', 'Read-only or unsupported GPIO register', value);
    this.emit(name, offset, 'write', value, before);
  }
  emit(name, offset, kind, value, before) {
    if (!this.onAccess) return;
    this.onAccess({ eventType: 'gpio-access', origin: 'peripheral-model', ...this.context(), port: name, addressByte: PORT_BASES[name] + offset, register: offset < 9 ? NAMES[offset] : `PIN${offset - 0x10}CTRL`, kind, value, before, after: this.snapshot(name), driveAfter: Array.from({ length: 8 }, (_, pin) => this.drive(name, pin)) });
  }
}
