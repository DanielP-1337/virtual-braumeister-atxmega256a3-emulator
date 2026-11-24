export const EEPROM_SIZE=0x1000;
export const EEPROM_PAGE_SIZE=32;
const programmedSource = Object.freeze({kind:'emulated-write',label:'Modeled EEPROM erase/write'});
// Persistent contents and per-byte evidence. Placeholder bytes are not readable data.
export class EEPROMStorage {
  #programmed = new Uint8Array(EEPROM_SIZE);
  constructor({bytes=null,valid=null,provenance={kind:'unknown',label:'No EEPROM image supplied'}}={}) {
    if(!['unknown','synthetic','local-dump'].includes(provenance.kind) || typeof provenance.label!=='string' || !provenance.label) throw new Error('Explicit EEPROM provenance required');
    if(bytes!==null && (!(bytes instanceof Uint8Array) || bytes.length!==EEPROM_SIZE)) throw new Error('EEPROM must be 4096 bytes');
    if(valid!==null && (!(valid instanceof Uint8Array) || valid.length!==EEPROM_SIZE || !valid.every(v=>v===0||v===1))) throw new Error('Invalid EEPROM validity map');
    if(provenance.kind==='unknown' && (bytes!==null || valid!==null)) throw new Error('Unknown provenance cannot declare loaded contents');
    if(provenance.kind!=='unknown' && bytes===null) throw new Error('Initialized provenance requires bytes');
    this.bytes=bytes?Uint8Array.from(bytes):new Uint8Array(EEPROM_SIZE).fill(255);
    this.valid=valid?Uint8Array.from(valid):new Uint8Array(EEPROM_SIZE).fill(bytes?1:0);
    this.provenance=Object.freeze({...provenance});
  }
  describe(){
    const programmedBytes=this.#programmed.reduce((n,v)=>n+v,0);
    return {capacityBytes:EEPROM_SIZE,pageSizeBytes:EEPROM_PAGE_SIZE,pages:128,knownBytes:this.valid.reduce((n,v)=>n+v,0),provenance:{...this.provenance},...(programmedBytes?{programmedBytes}:{})};
  }
  provenanceAt(offset) { return this.#programmed[offset] ? programmedSource : this.provenance; }
  programByte(offset, value) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= EEPROM_SIZE) throw new RangeError('Offset outside device EEPROM');
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Invalid EEPROM byte');
    this.bytes[offset] = value;
    this.valid[offset] = 1;
    this.#programmed[offset] = 1;
  }
  read(offset){
    if(!Number.isInteger(offset)||offset<0||offset>=EEPROM_SIZE) throw Object.assign(new Error('EEPROM offset outside device'),{classification:'INVALID_EEPROM_ADDRESS',offset});
    if(!this.valid[offset]) throw Object.assign(new Error('EEPROM byte has no supplied data'),{classification:'UNKNOWN_EEPROM_DATA',offset,provenance:this.provenance});
    return this.bytes[offset];
  }
}
