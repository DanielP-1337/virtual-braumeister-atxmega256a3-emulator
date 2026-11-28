// Follow independently variable SPIC wire bytes in the AVR register file and data SRAM.
// Arithmetic or a branch on a variable operand ends the proof at its first use.
const noRegisters = new Set(['NOP','RJMP','JMP','RCALL','CALL','RET','RETI','CLI','SEI','BRBC','BRBS','SBIC','SBIS','SBI','CBI']);
const twoRegisters = new Set(['ADD','ADC','SUB','SBC','AND','OR','EOR','CP','CPC','CPSE','MUL']);
const oneRegister = new Set(['INC','DEC','SWAP','SBRC','SBRS']);
const immediate = new Set(['SBCI','SUBI','ANDI','ORI','CPI']);

export function spicRegisterDataflow(firstFrame = 30) {
  const registers = new Map(), memory = new Map(), opcodes = new Map(), variableStores = new Map();
  let failure = null, reads = 0, first = null, last = null, joins = 0, stackStores = 0, stackLoads = 0, irqWithLiveRegisters = 0;
  function assign(reg, source) {
    if (source) registers.set(reg, source);
    else registers.delete(reg);
  }
  function reject(category, detail) {
    throw Object.assign(new Error(detail), { category });
  }
  function mustBeKnown(reg, role) {
    const symbol = registers.get(reg);
    if (symbol) reject('variable operand', role + ' uses R' + reg + ' from frame ' + symbol.frame);
  }
  function pointerFor(op) {
    if ((op & 0xd000) === 0x8000) return op & 8 ? 28 : 30;
    return (op & 15) === 1 ? 30 : 26;
  }
  function checkPointer(pair) {
    mustBeKnown(pair,'address'); mustBeKnown(pair+1,'address');
  }
  function requireAccess(bus, kind) {
    if (bus.length !== 1 || bus[0].kind !== kind) reject('unsupported access','expected one ' + kind);
    return bus[0];
  }
  function examine(t, frame) {
    const wasLive = registers.size > 0;
    let interesting = wasLive;
    for (const a of t.accesses) {
      if (a.kind === 'read' && ((a.space === 'mmio' && a.addressByte === 0x08c3 && frame >= firstFrame) ||
          (a.space === 'sram' && memory.has(a.addressByte)))) interesting = true;
    }
    if (!interesting) {
      for (const a of t.accesses) if (a.kind === 'write' && a.space === 'sram') memory.delete(a.addressByte);
      return;
    }
    for (const [reg, source] of registers) if (t.before.registers[reg] !== source.value) reject('inconsistent trace','source register before instruction');
    const op=t.opcode, name=t.mnemonic, d=(op>>>4)&31, r=(op&15)|((op>>>5)&16);
    const bus=t.accesses.filter(a=>a.kind!=='fetch');
    let readsMemory=false, writesVariable=false;
    if (t.eventType === 'interrupt-entry') {
      if(wasLive)irqWithLiveRegisters++;
      if (!bus.every(a=>a.kind==='write'&&a.space==='sram')) reject('unsupported access','interrupt stack write');
    } else if (['LDS','LDD','LD','IN','POP'].includes(name)) {
      if (name==='LD'||name==='LDD')checkPointer(pointerFor(op));
      const a=requireAccess(bus,'read');
      let source = a.space==='sram' ? memory.get(a.addressByte) : null;
      if (a.space==='mmio' && a.addressByte===0x08c3 && frame>=firstFrame) {
        if (t.before.pcWord!==0xfd24 || d!==24 || (last && frame!==last.frame+1)) reject('unsupported read','unexpected SPI data read order');
        source={frame,value:a.value}; reads++;
        const point={frame,cycle:t.after.cycles,pc:t.before.pcWord}; first??=point;last=point;
      }
      if (source && a.value!==source.value) reject('inconsistent trace','loaded symbolic value');
      if (source && name==='POP')stackLoads++;
      assign(d,source); readsMemory=true;
    } else if (['STS','STD','ST','ST X','ST X+','ST Z+','OUT','PUSH'].includes(name)) {
      if (!['STS','OUT','PUSH'].includes(name))checkPointer(pointerFor(op));
      const a=requireAccess(bus,'write'),source=registers.get(d);
      if (source) {
        if (a.space!=='sram')reject('variable output','write outside SRAM at '+a.addressByte);
        if (a.value!==source.value)reject('inconsistent trace','stored symbolic value');
        memory.set(a.addressByte,source);writesVariable=true;
        if(name==='PUSH')stackStores++;
        const key=t.before.pcWord+'/'+a.addressByte;
        const n=variableStores.get(key)??{pc:t.before.pcWord,address:a.addressByte,count:0};
        n.count++;variableStores.set(key,n);
      }
    } else if (name==='MOV') assign(d,registers.get(r));
    else if (name==='MOVW') {
      const dest=2*((op>>>4)&15), src=2*(op&15),lo=registers.get(src),hi=registers.get(src+1);
      assign(dest,lo);assign(dest+1,hi);
    } else if (name==='LDI') assign(16+((op>>>4)&15),null);
    else if (name==='EOR'&&d===r) assign(d,null);
    else if (twoRegisters.has(name)) {
      mustBeKnown(d,name);mustBeKnown(r,name);
      if(name==='MUL'){assign(0,null);assign(1,null);}
    } else if (immediate.has(name)) mustBeKnown(16+((op>>>4)&15),name);
    else if (oneRegister.has(name)) mustBeKnown(d,name);
    else if (name==='SBIW'||name==='ADIW') {
      const low=24+2*((op>>>4)&3);mustBeKnown(low,name);mustBeKnown(low+1,name);
    } else if (name==='LPM'||name==='ELPM') {
      checkPointer(30);assign(op===0x95c8||op===0x95d8?0:d,null);
    } else if (['IJMP','EIJMP','ICALL','EICALL'].includes(name)) checkPointer(30);
    else if (!noRegisters.has(name)) reject('unsupported opcode',String(name));
    for (const a of bus) {
      if (a.space==='sram' && a.kind==='read' && memory.has(a.addressByte) && !readsMemory) reject('variable address or return','implicit SRAM read '+a.addressByte);
      if (a.space==='sram' && a.kind==='write' && !writesVariable) memory.delete(a.addressByte);
    }
    for (const [reg, source] of registers) if (t.after.registers[reg]!==source.value) reject('inconsistent trace','source register after instruction');
    if (wasLive && !registers.size) joins++;
    const key=t.eventType==='interrupt-entry'?'interrupt-entry':op.toString(16)+'/'+name;
    opcodes.set(key,(opcodes.get(key)??0)+1);
  }
  return {
    observe(t, frame) {
      if (failure) return;
      try { examine(t,frame); }
      catch(error) {
        if(!error.category)throw error;
        failure={category:error.category,detail:error.message,frame,pc:t.before.pcWord,cycle:t.before.cycles,opcode:t.opcode,mnemonic:t.mnemonic,
          registers:[...registers].map(([reg,s])=>({reg,...s}))};
      }
    },
    result() {
      return { status:failure?'BOUNDARY':'PASS',firstFrame,first,last,reads,joins,stackStores,stackLoads,irqWithLiveRegisters,failure,
        opcodes:Object.fromEntries(opcodes),variableStores:[...variableStores.values()],
        remainingRegisters:[...registers].map(([reg,s])=>({reg,...s})),remainingSram:[...memory].map(([address,s])=>({address,...s})) };
    }
  };
}
