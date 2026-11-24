import {EEPROMStorage,EEPROM_SIZE} from './eeprom-storage.mjs';
export const EEPROM_BASE=0x1000;
// Mapping supplies read routing only. It never aliases EEPROM to writable RAM.
export class EEPROMMapping {
  constructor({storage,nvm,fault,clock=()=>0,context=()=>({}),onAccess=null}){
    if(!(storage instanceof EEPROMStorage)) throw new Error('EEPROM storage required');
    this.storage=storage;this.nvm=nvm;this.fault=fault;this.clock=clock;this.context=context;this.onAccess=onAccess;
  }
  get enabled(){return !!(this.nvm.registers[12]&8);}
  snapshot(){return {enabled:this.enabled,baseAddressByte:EEPROM_BASE,endAddressByte:0x1fff,...this.storage.describe()};}
  fail(address,kind,classification,reason,value=null){
    this.onAccess?.({origin:'emulator',eventType:'eeprom-diagnostic',...this.context(),addressByte:address,offset:address-EEPROM_BASE,kind,attemptedValue:value,completed:false,classification,provenance:this.storage.provenance});
    this.fault(reason,{classification,addressByte:address,accessKind:kind,attemptedValue:value});
  }
  check(address,kind,value=null){
    if(!Number.isInteger(address)||address<EEPROM_BASE||address>=EEPROM_BASE+EEPROM_SIZE) this.fail(address,kind,'INVALID_EEPROM_ADDRESS','Address outside mapped EEPROM',value);
    if(!this.enabled) this.fail(address,kind,'UNMAPPED_EEPROM','EEPROM data mapping is disabled',value);
    this.nvm.advanceTo(this.clock());
    if(this.nvm.activity.pending) this.fail(address,kind,'EEPROM_NVM_BUSY','Mapped EEPROM access while NVM is busy is unsupported',value);
    // CMD retains its selection after an atomic page write. Only CMDEX starts
    // that command; an idle, mapped LD can read the committed byte directly.
    const command = this.nvm.registers[10];
    const idlePageWriteRead = kind === 'read' && command === 0x35;
    if (command !== 0 && !idlePageWriteRead) this.fail(address,kind,'EEPROM_COMMAND_UNSUPPORTED','Mapped EEPROM access with this NVM command is unsupported',value);
  }
  read(address){
    this.check(address,'read');const offset=address-EEPROM_BASE;
    if(!this.storage.valid[offset])this.fail(address,'read','UNKNOWN_EEPROM_DATA','EEPROM byte has no supplied data');
    const value=this.storage.read(offset);
    this.onAccess?.({origin:'emulator',eventType:'eeprom-access',...this.context(),kind:'read',addressByte:address,offset,value,completed:true,provenance:this.storage.provenanceAt(offset)});return value;
  }
  write(address,value){this.check(address,'write',value);this.fail(address,'write','EEPROM_PAGE_BUFFER_UNSUPPORTED','Mapped EEPROM stores load a page buffer; page-buffer loading is not implemented',value);}
}
