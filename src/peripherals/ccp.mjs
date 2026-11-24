// XMEGA A manual, 3.12.1 and 3.14.1. Times are absolute CPU clock edges.
export const CCP_ADDRESS = 0x34;

export class ConfigurationChangeProtection {
  constructor() { this.clear(); }

  clear() {
    this.mode = 0;
    this.keyCycle = 0;
  }

  write(signature, cycle) {
    this.mode = signature === 0xd8 ? 1 : signature === 0x9d ? 2 : 0;
    this.keyCycle = cycle;
  }

  read(cycle) {
    const elapsed = cycle - this.keyCycle;
    return elapsed >= 0 && elapsed <= 4 ? this.mode : 0;
  }

  allowsIO(cycle) {
    return cycle > this.keyCycle && this.read(cycle) === 1;
  }
}
