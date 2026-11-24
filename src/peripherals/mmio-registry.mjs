// Registry only: no hardware model or default-ready behavior is installed.
export class MMIORegistry {
  constructor() { this.handlers = new Map(); }
  map(address, handler) {
    if (!Number.isInteger(address) || address < 0 || address >= 0x1000 || (address >= 0x38 && address <= 0x3f)) throw new Error('Invalid/custom CPU register hook');
    if (this.handlers.has(address)) throw new Error('Duplicate MMIO handler');
    if (!handler || (typeof handler.read !== 'function' && typeof handler.write !== 'function')) throw new Error('MMIO handler needs read or write');
    this.handlers.set(address, handler);
  }
}
