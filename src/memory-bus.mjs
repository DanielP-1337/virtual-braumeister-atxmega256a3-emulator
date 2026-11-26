import { MMIORegistry } from './peripherals/mmio-registry.mjs';
import { EEPROMStorage } from './eeprom-storage.mjs';
import { EEPROMMapping } from './eeprom-mapping.mjs';
import { CCP_ADDRESS, ConfigurationChangeProtection } from './peripherals/ccp.mjs';

// A3 memory geometry and access routing. CPU registers are supplied by the CPU;
// device behaviors belong to separately registered peripheral models.
export class MemoryBus {
  constructor(image, cpu, { sramFill = 0xa5, eeprom = null } = {}) {
    if (image.flash.length !== 0x42000 || image.present.length !== 0x42000) throw new Error('Expected A3 flash geometry');
    this.cpu = cpu; this.flash = image.flash; this.present = image.present;
    this.sram = new Uint8Array(0x4000).fill(sramFill);
    this.eepromStorage = eeprom instanceof EEPROMStorage ? eeprom : eeprom === null ? new EEPROMStorage() : new EEPROMStorage({bytes:Uint8Array.from(eeprom),provenance:{kind:'synthetic',label:'Explicit constructor byte image'}});
    this.eeprom = this.eepromStorage.bytes; this.eepromMapping = null;
    if (this.eeprom.length !== 0x1000) throw new Error('EEPROM must be 4096 bytes');
    this.mmio = new MMIORegistry();
    this.ccp = null;
    this.programmingNvm = null;
    this.pmic = null;
    this.splEnableStep = 0;
  }
  // CPU.CCP is shared by NVM programming and the PMIC vector-table selector.
  // Validate the consumer before installing the first hook, so a failed attach can be retried.
  bindCCP(configure) {
    if (!this.ccp && this.mmio.handlers.has(CCP_ADDRESS)) throw new Error('CPU.CCP registration collision');
    const ccp = this.ccp ?? new ConfigurationChangeProtection();
    configure(ccp);
    if (!this.ccp) {
      this.mmio.map(CCP_ADDRESS, {
        read: cycle => ccp.read(cycle),
        write: (value, cycle) => ccp.write(value, cycle),
      });
      this.ccp = ccp;
    }
  }
  attachPMIC(pmic) {
    if (this.pmic) throw new Error('PMIC already attached');
    const cpu = this.cpu;
    this.bindCCP(() => pmic.register(this.mmio, {
      fault: (reason, details) => cpu.fault(reason, details),
      context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    }));
    this.pmic = pmic;
  }
  interruptsInhibited() {
    // Check the first clock after this retirement boundary against the live CCP window.
    return this.cpu.steps < this.splEnableStep || Boolean(this.ccp?.read(this.cpu.cycles + 1));
  }
  attachEEPROM(nvm,{onAccess=null,programming=null}={}) {
    if(this.eepromMapping || nvm.eepromMapping) throw new Error('EEPROM mapping already attached');
    if(nvm.activity.pageBuffer && nvm.activity.pageBuffer.storage !== this.eepromStorage) throw new Error('EEPROM mapping and page buffer must share one storage instance');
    if(nvm.registers[12]!==0 || nvm.activity.pending) throw new Error('Attach EEPROM to an idle reset controller');
    const c=this.cpu;
    const mapping=new EEPROMMapping({storage:this.eepromStorage,nvm,fault:(m,d)=>c.fault(m,d),clock:()=>c.cycles,context:()=>({pcWord:c.pc,cyclesBefore:c.cycles,instructionAttempt:c.steps+1}),onAccess});
    if (programming !== null) {
      this.bindCCP(ccp => nvm.enableProgramming(programming, ccp));
      this.programmingNvm = nvm;
    }
    nvm.eepromMapping=mapping;this.eepromMapping=mapping;return mapping;
  }
  failData(address, kind, value) {
    const classification = !Number.isInteger(address) || address < 0 || address >= 0x6000 ? 'INVALID_DATA_ADDRESS' : address >= 0x1000 && address < 0x2000 ? 'UNMAPPED_EEPROM' : 'UNHANDLED_MMIO';
    this.cpu.fault(`Unsupported data ${kind} at byte 0x${address.toString(16)} (MMIO, reserved, or unmapped EEPROM)`, { classification, addressByte: address, accessKind: kind, attemptedValue: value ?? null });
  }
  read(address, cycle = this.cpu.cycles) {
    const c = this.cpu; let value, space, waitCycles=0;
    if (!Number.isInteger(address) || address < 0) this.failData(address, 'read');
    if (address >= 0x2000 && address <= 0x5fff) { value = this.sram[address - 0x2000]; space = 'sram'; }
    else if (address >= 0x1000 && address < 0x2000 && this.eepromMapping) { value=this.eepromMapping.read(address); space='eeprom'; waitCycles=1; }
    else if (address === 0x3b) { value = c.rampz; space = 'cpu-io'; }
    else if (address === 0x3c) { value = c.eind; space = 'cpu-io'; }
    else if (address === 0x3d) { value = c.sp & 255; space = 'cpu-io'; }
    else if (address === 0x3e) { value = c.sp >>> 8; space = 'cpu-io'; }
    else if (address === 0x3f) { value = c.sreg; space = 'cpu-io'; }
    else if (this.mmio.handlers.get(address)?.read) { value = this.mmio.handlers.get(address).read(cycle); space = 'mmio'; }
    else this.failData(address, 'read');
    if (!Number.isInteger(value) || value < 0 || value > 255) c.fault('MMIO returned invalid byte', { classification: 'INVALID_MMIO_VALUE', addressByte: address, accessKind: 'read' });
    // XMEGA A 4.11: EEPROM read takes three cycles versus SRAM's two.
    c.cycles += waitCycles;
    c.accesses.push({ kind: 'read', space, addressByte: address, value, ...(waitCycles?{waitCycles}:{}) }); return value;
  }
  write(address, value, cycle = this.cpu.cycles) {
    const c = this.cpu; value &= 255; let space;
    let waitCycles = 0;
    if (!Number.isInteger(address) || address < 0) this.failData(address, 'write', value);
    if (address >= 0x2000 && address <= 0x5fff) { this.sram[address - 0x2000] = value; space = 'sram'; }
    else if (address >= 0x1000 && address < 0x2000 && this.eepromMapping) { this.eepromMapping.write(address,value); space='eeprom'; }
    else if (address === 0x3b) { c.rampz = value & 7; space = 'cpu-io'; }
    else if (address === 0x3c) { c.eind = value & 3; space = 'cpu-io'; }
    else if (address === 0x3d) { c.sp = (c.sp & 0xff00) | value; space = 'cpu-io'; }
    else if (address === 0x3e) { c.sp = (c.sp & 255) | (value << 8); space = 'cpu-io'; }
    else if (address === 0x3f) {
      // XMEGA A manual 3.14.9: changing I through the SREG I/O register adds a wait state.
      waitCycles = (c.sreg ^ value) >>> 7;
      c.sreg = value; space = 'cpu-io';
    }
    else if (this.mmio.handlers.get(address)?.write) { this.mmio.handlers.get(address).write(value, cycle, this.ccp?.allowsIO(cycle) ?? false); space = 'mmio'; }
    else this.failData(address, 'write', value);
    if (address < 0x1000) this.splEnableStep = address === 0x3d ? c.steps + 5 : 0;
    if (this.ccp && address !== CCP_ADDRESS) this.ccp.clear();
    c.accesses.push({ kind: 'write', space, addressByte: address, value, ...(waitCycles ? {waitCycles} : {}) });
    return waitCycles;
  }
  readProgramData(address, extended) {
    const nvm = this.mmio.programReadNvm;
    if (!nvm?.productionSignatureSelected) return this.flashByte(address, 'read');
    const value = nvm.readProductionSignature(address, extended);
    this.cpu.accesses.push({ kind: 'read', space: 'production-signature', addressByte: address, value });
    return value;
  }
  flashByte(address, kind) {
    const c = this.cpu;
    if (!Number.isInteger(address) || address < 0 || address >= this.flash.length) c.fault(`Flash ${kind} outside device at byte 0x${address.toString(16)}`, { classification: 'INVALID_FLASH_ADDRESS', addressByte: address, accessKind: kind });
    if (kind === 'fetch' && !this.present[address]) c.fault(`Instruction fetch in HEX hole at byte 0x${address.toString(16)}`, { classification: 'FLASH_HOLE', addressByte: address, accessKind: kind });
    const value = this.flash[address];
    c.accesses.push({ kind, space: 'flash', addressByte: address, value, loaded: !!this.present[address] }); return value;
  }
}

