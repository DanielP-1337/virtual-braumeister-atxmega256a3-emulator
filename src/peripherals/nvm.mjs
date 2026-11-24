// Legacy XMEGA A NVM: 8077I sections 4.15 and 4.21; A3 base 0x01c0.
// CMDEX starts supported EEPROM commands only after bus-level CCP authorization.
import { EEPROM_SIZE } from '../eeprom-storage.mjs';
import { EEPROMPageBuffer } from './eeprom-page-buffer.mjs';
export const NVM_BASE = 0x1c0;
export const NVM_REGISTERS = Object.freeze({ADDR0:0, ADDR1:1, ADDR2:2, DATA0:4, DATA1:5, DATA2:6, CMD:10, CTRLA:11, CTRLB:12, INTCTRL:13, STATUS:15, LOCKBITS:16});
const offsets = Object.values(NVM_REGISTERS);
const cycle = n => { if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid virtual cycle'); return n; };
const byte = n => { if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError('Invalid byte'); return n; };

// Activity uses virtual CPU cycles. EEPROM command durations come from the caller's
// timing profile. Synthetic fixture deadlines are not estimates of device timing.
export class NVMActivity {
  constructor(pageBuffer=null) {
    if (pageBuffer !== null && !(pageBuffer instanceof EEPROMPageBuffer)) throw new TypeError('Invalid EEPROM page buffer');
    this.pageBuffer=pageBuffer; this.now=0; this.pending=null; this.standaloneEepromLoaded=false; this.flashLoaded=false;
  }
  get eepromLoaded() { return this.pageBuffer?.loaded ?? this.standaloneEepromLoaded; }
  set eepromLoaded(value) {
    if (this.pageBuffer) throw new Error('EELOAD is derived from tagged EEPROM slots');
    this.standaloneEepromLoaded=value;
  }
  get status() { return (this.pending ? 0x80 : 0) | (this.pending?.kind === 'flash' ? 0x40 : 0) | (this.eepromLoaded ? 2 : 0) | (this.flashLoaded ? 1 : 0); }
  snapshot() { return {cycle:this.now,pending:this.pending ? {...this.pending}:null,eepromLoaded:this.eepromLoaded,flashLoaded:this.flashLoaded,status:this.status}; }
  begin(kind, deadline) {
    const completeCycle = typeof deadline === 'function' ? deadline() : deadline;
    if (!['flash','eeprom','lockbits'].includes(kind)) throw new RangeError('Unsupported activity kind');
    cycle(completeCycle);
    if (this.pending) throw new Error('NVM operation already pending');
    if (completeCycle <= this.now) throw new RangeError('Completion must follow current cycle');
    // A wall-time programming deadline can move to a different CPU edge after a clock switch.
    this.pending = { kind, startCycle: this.now, get completeCycle() {
      return typeof deadline === 'function' ? deadline() : deadline;
    } };
  }
  advanceTo(now) {
    cycle(now); if(now < this.now) throw new RangeError('NVM time cannot move backward');
    const completed=this.pending && now >= this.pending.completeCycle ? {...this.pending}:null;
    this.now=now; if(completed) this.pending=null;
    return completed; // Does not commit data or invent buffer flush semantics.
  }
  reset() {
    if(this.pending) throw new Error('Reset during NVM programming is not modeled');
    this.pageBuffer?.clear(); this.standaloneEepromLoaded=false; this.flashLoaded=false;
  }
}

export class NVMController {
  constructor({onAccess=null, onTransition=null, lockbits=null, pageBuffer=null, timeBase=null, activity=new NVMActivity(pageBuffer)}={}) {
    this.timeBase=timeBase;
    if (pageBuffer && activity.pageBuffer !== pageBuffer) throw new Error('NVM activity and controller must share one page buffer');
    if(lockbits!==null) byte(lockbits);
    this.activity=activity; this.lockbits=lockbits; this.onAccess=onAccess; this.onTransition=onTransition;
    this.eepromMapping=null; this.registered=false; this.context=()=>({}); this.clock=()=>this.activity.now;
    this.fault=(message,details)=>{throw Object.assign(new Error(message),details);};
    this.registers=new Uint8Array(17);
    this.programming=null;
    this.operation=null;
    this.ccp=null;
  }
  enableProgramming(programming,ccp) {
    if(this.programming) throw new Error('EEPROM programming already enabled');
    if(!this.activity.pageBuffer || !ccp || typeof ccp.clear !== 'function') throw new TypeError('EEPROM programming needs a page buffer and CCP');
    if(!programming || typeof programming !== 'object') throw new TypeError('Expected an EEPROM programming timing profile');
    const {eraseWriteCycles,eraseBufferCycles}=programming;
    for(const duration of [eraseWriteCycles,eraseBufferCycles]) {
      if(duration!==undefined && (!Number.isSafeInteger(duration) || duration<1)) throw new RangeError('Programming durations must be positive whole CPU cycles');
    }
    this.programming=Object.freeze({eraseWriteCycles,eraseBufferCycles});
    this.ccp=ccp;
  }
  snapshot() { return {registers:Array.from(this.registers),lockbits:this.lockbits,activity:this.activity.snapshot()}; }
  advanceTo(now) {
    const completed=this.activity.advanceTo(now);
    if(!completed) return;
    const operation=this.operation;
    if(operation) {
      if(operation.command===0x35) this.activity.pageBuffer.completeEraseWrite(operation.address);
      else this.activity.pageBuffer.clear();
      this.operation=null;
    }
    this.onTransition?.({origin:'emulator',eventType:'nvm-activity-completed',...completed,...operation,observedCycle:now});
  }
  reset() {
    if(this.activity.pending) this.fail(15,'reset','NVM_RESET_DURING_OPERATION_UNSUPPORTED','Reset during active NVM programming is not modeled');
    this.ccp?.clear();
    this.activity.reset(); this.registers.fill(0); // Persistent lockbits and external NVM contents are untouched.
  }
  register(registry,{fault,clock=()=>this.activity.now,context=()=>({})}={}) {
    if(this.registered) throw new Error('NVM already registered');
    for(const offset of offsets) if(registry.handlers.has(NVM_BASE+offset)) throw new Error('NVM MMIO registration collision');
    if(fault) this.fault=fault; this.clock=clock; this.context=context;
    for(const offset of offsets) registry.map(NVM_BASE+offset,{
      read:edge=>this.read(offset,edge),
      write:(value,edge,authorized=false)=>this.write(offset,value,edge,authorized)
    });
    this.registered=true;
  }
  fail(offset,kind,classification,message,value=null) { this.fault(message,{classification,addressByte:NVM_BASE+offset,accessKind:kind,attemptedValue:value}); }
  check(offset,kind,value=null,edge,authorized=false) {
    if(!offsets.includes(offset)) this.fail(offset,kind,'NVM_UNSUPPORTED_REGISTER','Reserved or unknown NVM register',value);
    if(this.operation) {
      const observed=edge ?? this.clock();
      if(offset!==15 && observed<this.activity.pending.completeCycle) this.fail(offset,kind,'NVM_BUSY_ACCESS_UNSUPPORTED','Non-STATUS accesses during NVM activity are not modeled',value);
      // Validate before completing an in-flight command. A failed access does
      // not retire, even when its hypothetical bus edge falls on the deadline.
      const prepared=this.validateAccess(offset,kind,value,edge,authorized);
      this.advanceTo(observed);
      return prepared;
    }
    this.advanceTo(this.clock());
    if(this.activity.pending && offset!==15) this.fail(offset,kind,'NVM_BUSY_ACCESS_UNSUPPORTED','Non-STATUS accesses during NVM activity are not modeled',value);
    return this.validateAccess(offset,kind,value,edge,authorized);
  }
  record(kind,offset,value,before,ignored=false) {
    this.onAccess?.({origin:'emulator',eventType:'nvm-access',...this.context(),kind,addressByte:NVM_BASE+offset,value,ignored,before,after:this.snapshot()});
  }
  read(offset,edge) {
    this.check(offset,'read',null,edge); const before=this.snapshot(); let value;
    if(offset===15) value=this.activity.status;
    else if(offset===16) value=this.lockbits;
    else value=this.registers[offset];
    this.record('read',offset,value,before); return value;
  }
  prepareEEPROMCommand(edge) {
    const command=this.registers[NVM_REGISTERS.CMD];
    if(command!==0x35 && command!==0x36) this.fail(11,'write','NVM_COMMAND_EXECUTION_UNSUPPORTED','Protected execution of this NVM command is not implemented',1);
    const duration=command===0x35 ? this.programming.eraseWriteCycles : this.programming.eraseBufferCycles;
    if(duration===undefined) this.fail(11,'write','NVM_TIMING_UNAVAILABLE','No programming duration supplied for the protected EEPROM command',1);
    const operation={command};
    if(command===0x35) {
      operation.address=this.registers[0] + 256*this.registers[1] + 65536*this.registers[2];
      if(operation.address>=EEPROM_SIZE) this.fail(11,'write','INVALID_EEPROM_ADDRESS','Erase/write destination is outside ATxmega256A3 EEPROM',1);
    }
    if (!this.timeBase) return {operation,edge,completeCycle:cycle(edge+duration)};
    const deadlineTicks = this.timeBase.deadlineTicks(edge, duration);
    return {operation, edge, completeCycle: () => this.timeBase.cycleAt(deadlineTicks)};
  }
  validateAccess(offset,kind,value,edge,authorized) {
    if(kind==='read') {
      if(offset===16 && this.lockbits===null) this.fail(offset,kind,'NVM_LOCKBITS_UNKNOWN','Actual lock bits were not supplied');
      return;
    }
    if(offset===10 && value!==0 && !(value===0x33 && this.activity.pageBuffer && !this.eepromMapping?.enabled) && !(this.programming && (value===0x35 || value===0x36))) {
      this.fail(offset,'write','NVM_UNSUPPORTED_COMMAND','Unsupported NVM command in the current configuration',value);
    }
    if(offset===11 && value!==0) {
      if(!this.programming) this.fail(offset,'write','NVM_COMMAND_EXECUTION_UNSUPPORTED','CMDEX/CCP command execution is not implemented; no protection bypass',value);
      if(value!==1) this.fail(offset,'write','NVM_COMMAND_EXECUTION_UNSUPPORTED','Unsupported NVM.CTRLA write in the current configuration',value);
      if(authorized===true) return this.prepareEEPROMCommand(edge ?? this.clock());
    }
    if(offset===12 && value!==0 && !(value===8 && this.eepromMapping)) this.fail(offset,'write','NVM_CONTROL_UNSUPPORTED',this.eepromMapping?'Power reduction, SPMLOCK and reserved CTRLB bits are not implemented':'EEPROM mapping, power reduction and SPMLOCK are not implemented',value);
    if(offset===13 && value!==0) this.fail(offset,'write','NVM_INTERRUPTS_UNSUPPORTED','NVM ready interrupts are not implemented',value);
    if(offset===4 && this.eepromMapping?.enabled) this.fail(offset,'write','NVM_DATA0_MAPPED_UNSUPPORTED','DATA0 side effects while EEPROM is mapped are not implemented',value);
  }
  write(offset,value,edge,authorized=false) {
    byte(value);
    const prepared=this.check(offset,'write',value,edge,authorized);
    const before=this.snapshot();
    if(offset===15 || offset===16) { this.record('write',offset,value,before,true); return; }
    if(offset===11 && value===1) {
      if(prepared) {
        this.advanceTo(prepared.edge);
        this.activity.begin('eeprom',prepared.completeCycle);
        this.operation=prepared.operation;
        this.onTransition?.({origin:'emulator',eventType:'nvm-activity-started',...this.activity.pending,...this.operation});
      }
      this.record('write',offset,value,before,!prepared);
      return; // CMDEX is a strobe and reads back as zero.
    }
    if(offset===4 && this.registers[10]===0x33) {
      // A3 ADDR[4:0] selects the slot. A load starts no programming operation.
      this.activity.pageBuffer.load(this.registers[0] & 31, value);
    }
    this.registers[offset]=value; this.record('write',offset,value,before);
  }
}

