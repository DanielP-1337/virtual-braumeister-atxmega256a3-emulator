import { PORT_BASES } from './gpio.mjs';

// Non-U ATxmega256A3, XMEGA A manual section 13.13.
export class PortEInterrupts {
  constructor({ gpio = null, onAccess = null } = {}) {
    this.gpio = gpio;
    this.onAccess = onAccess;
    this.reset();
  }

  reset() {
    this.int0Mask = 0;
    this.intctrl = 0;
    this.lastCycle = 0;
    this.sensingMask = 0;
    this.invertedPins = 0;
    this.unobservedPins = 0;
  }

  snapshot() {
    return { int0Mask: this.int0Mask, ...(this.mapIntctrl ? {intctrl:this.intctrl,unobservedPins:this.unobservedPins} : {}) };
  }

  // Only a continuous interval can exclude an edge between instruction boundaries.
  observe(cycle) {
    if (!this.mapIntctrl) return;
    const config = this.gpio?.port('E').pinctrl;
    const highThroughout = this.gpio?.stableHighMask?.('E', this.lastCycle, cycle) ?? 0;
    const highNow = this.gpio?.stableHighMask?.('E', cycle, cycle) ?? 0;
    let sensing = 0, inverted = 0, lowLevel = 0;
    for (let pin=0; pin<8; pin++) {
      const bit = 1 << pin, control = config?.[pin] ?? 0, sense = control & 7;
      if (control & 0x40) inverted |= bit;
      if (!(this.int0Mask & bit) || sense === 7) continue;
      sensing |= bit;
      if (sense === 3) lowLevel |= bit;
    }
    if (cycle > this.lastCycle) this.unobservedPins |= this.sensingMask & ~highThroughout;
    // Changing input inversion can change the sensed level even with a stable external signal.
    this.unobservedPins |= this.sensingMask & (inverted ^ this.invertedPins) & highNow;
    this.unobservedPins |= lowLevel & (~highNow | inverted);
    this.sensingMask = sensing;
    this.invertedPins = inverted;
    this.lastCycle = cycle;
  }

  request(cycle) {
    if (!this.mapIntctrl) return null;
    this.observe(cycle);
    const level = this.intctrl & 3;
    if (!level || !this.unobservedPins) return null;
    const pins = Array.from({length:8}, (_,i) => i).filter(i => this.unobservedPins & (1 << i));
    return { peripheral:'PORTE',source:'INT0',level,vectorWord:0x56,unobservedPins:this.unobservedPins,
      uncertainty:{classification:'PORTE_INT0_INPUT_HISTORY_UNKNOWN',
        reason:'PORTE.INT0 requires the input-sense history of ' + pins.map(i => 'PE'+i).join(', ')} };
  }

  register(registry, { mapInt0Mask = true, mapIntctrl = false, context = () => ({}) } = {}) {
    const registers = [];
    if (mapInt0Mask) registers.push(['INT0MASK', PORT_BASES.E + 0x0a]);
    if (mapIntctrl) registers.push(['INTCTRL', PORT_BASES.E + 0x09]);
    if (this.registered || registers.some(([,addr]) => registry.handlers.has(addr))) throw new Error('PORTE interrupt register collision');
    this.mapIntctrl = mapIntctrl;
    const access = (register, addressByte, kind, value, cycle) => {
      this.observe(cycle);
      const before = this.snapshot();
      if (register === 'INT0MASK') {
        if (kind === 'read') value = this.int0Mask;
        else { this.int0Mask = value; this.observe(cycle); }
      } else if (kind === 'read') value = this.intctrl;
      else this.intctrl = value & 0x0f;
      this.onAccess?.({ origin:'peripheral-model',eventType:'port-interrupt-access',...context(),
        peripheral:'PORTE',register,addressByte,kind,value,cycle,before,after:this.snapshot() });
      return value;
    };
    for (const [register,addr] of registers) {
      registry.map(addr, { read:cycle => access(register,addr,'read',undefined,cycle),
        write:(value,cycle) => access(register,addr,'write',value,cycle) });
    }
    this.registered = true;
  }
}
