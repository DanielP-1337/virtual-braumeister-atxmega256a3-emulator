import { MemoryBus } from './memory-bus.mjs';
// PoC-only AVRxm instruction interpreter. No firmware-specific addresses or shortcuts.
// Specification: Microchip AVR Instruction Set Manual, AVRxm timing column;
// XMEGA A manual 8077I, CPU and memory chapters. Unimplemented operations trap.
export class ExecutionFault extends Error {
  constructor(reason, context = {}) { super(reason); this.name = 'ExecutionFault'; Object.assign(this, context); }
}
// AVRxm has four 32-bit encoding families. Unsupported execution is independent
// of instruction width: skipped opcodes need length decoding, not execution.
export function instructionWords(opcode) {
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xffff) throw new RangeError('Expected a 16-bit opcode');
  return (opcode & 0xfe0e) === 0x940c || (opcode & 0xfe0e) === 0x940e ||
    (opcode & 0xfe0f) === 0x9000 || (opcode & 0xfe0f) === 0x9200 ? 2 : 1;
}
export function decodeWordImmediateOperands(opcode) {
  return {
    destinationLowRegister: 24 + 2 * ((opcode >>> 4) & 3),
    immediate: (opcode & 15) | ((opcode >>> 2) & 0x30),
  };
}
export { decodeWordImmediateOperands as decodeSbiwOperands };
export class XmegaCPU {
  constructor(image, { sramFill = 0xa5, eeprom = null } = {}) {
    this.bus = new MemoryBus(image, this, { sramFill, eeprom });
    this.flash = this.bus.flash; this.present = this.bus.present;
    this.sram = this.bus.sram; this.eeprom = this.bus.eeprom;
    this.r = new Uint8Array(32); // XMEGA registers are separate from data memory.
    this.pc = 0; this.cycles = 0; this.steps = 0;
    this.interruptEnableStep = 0;
    this.sreg = 0; this.sp = 0x5fff; this.rampz = 0; this.eind = 0;
    this.hooks = this.bus.mmio.handlers; this.accesses = [];
  }
  fault(reason, details = {}) { throw new ExecutionFault(reason, { pcWord: this.pc, opcode: this.currentOpcode ?? null, ...details }); }
  state() { return { pcWord: this.pc, cycles: this.cycles, registers: Array.from(this.r), sreg: this.sreg, sp: this.sp, rampz: this.rampz, eind: this.eind }; }
  pair(n) { return this.r[n] | (this.r[n + 1] << 8); }
  setPair(n, value) { this.r[n] = value & 255; this.r[n + 1] = (value >>> 8) & 255; }
  mapMMIO(address, handler) { this.bus.mmio.map(address, handler); }
  read(address, cycle = this.cycles) { return this.bus.read(address, cycle); }
  write(address, value, cycle = this.cycles) { return this.bus.write(address, value, cycle); }
  flashByte(address, kind) { return this.bus.flashByte(address, kind); }
  word(pc) { return this.flashByte(pc * 2, 'fetch') | (this.flashByte(pc * 2 + 1, 'fetch') << 8); }
  checkPcTarget(pcWord) {
    if (pcWord < 0 || pcWord >= this.flash.length / 2) this.fault(`PC target outside device: word 0x${pcWord.toString(16)}`);
  }
  pushReturn(value) {
    if (this.sp > 0x5fff || this.sp - 2 < 0x2000) this.fault('Return-address stack overflow/outside SRAM');
    for (let i = 0; i < 3; i++) this.write(this.sp--, value >>> (8 * i));
  }
  popReturn() {
    if (this.sp < 0x1fff || this.sp + 3 > 0x5fff) this.fault('Return-address stack underflow/outside SRAM');
    let value = 0;
    for (let i = 1; i <= 3; i++) value = value * 256 + this.read(this.sp + i);
    this.checkPcTarget(value); // A bad saved PC must not partially pop a strict return.
    this.sp += 3;
    return value;
  }
  setLogicalResult(register, result) {
    this.r[register] = result;
    // Preserve I/T/H/C. V clears and S equals N.
    this.sreg = (this.sreg & 0xe1) | (result === 0 ? 2 : 0) | (result & 128 ? 0x14 : 0);
  }
  compare(a, b, carry, chained) {
    const result = (a - b - carry) & 255;
    const c = a < b + carry, h = (a & 15) < (b & 15) + carry;
    const n = !!(result & 128), v = !!((a ^ b) & (a ^ result) & 128);
    const z = result === 0 && (!chained || !!(this.sreg & 2));
    this.sreg = (this.sreg & 0xc0) | +c | (+z << 1) | (+n << 2) | (+v << 3) | (+(n !== v) << 4) | (+h << 5);
    return result; // Compare instructions discard the difference. Subtract instructions write it back.
  }
  advanceCycles(cycles) {
    this.cycles += cycles;
    if (this.bus.programmingNvm?.operation) this.bus.programmingNvm.advanceTo(this.cycles);
  }
  enterInterrupt(pmic, request, before) {
    const target = pmic.vectorTarget(request, this.pc, (reason, details) => this.fault(reason, details));
    this.checkPcTarget(target);
    this.pushReturn(this.pc); // PC already names the next unexecuted word at this boundary.
    this.pc = target;
    this.interruptEnableStep = this.steps + 1; // Execute the vector instruction before resampling.
    this.advanceCycles(2); // XMEGA A 12.4.2, PC-store portion after the interrupted instruction.
    pmic.acknowledge(request, this.cycles);
    return { eventType: 'interrupt-entry', afterStep: this.steps, interruptRequest: { ...request },
      vectorPcWord: target, returnPcWord: before.pcWord, before, after: this.state(), accesses: this.accesses };
  }
  step() {
    const before = this.state(); this.accesses = []; this.currentOpcode = null;
    let interruptRequest = null;
    try {
      const pmic = this.bus.pmic;
      if (pmic && (this.sreg & 0x80) && this.steps >= this.interruptEnableStep && !this.bus.interruptsInhibited()) {
        interruptRequest = pmic.pending(this.cycles);
        if (interruptRequest) return this.enterInterrupt(pmic, interruptRequest, before);
      }
      const op = this.word(this.pc); this.currentOpcode = op;
      const d = (op >>> 4) & 31, rr = (op & 15) | ((op >>> 5) & 16);
      const imm = (op & 15) | ((op >>> 4) & 240);
      let next = this.pc + 1, cycles = 1, name, skip;
      if (op === 0) name = 'NOP';
      else if (op === 0x9478 || op === 0x94f8) {
        this.checkPcTarget(next);
        if (op === 0x9478) {
          name = 'SEI'; this.sreg |= 0x80;
          this.interruptEnableStep = this.steps + 2; // One following opcode retires before dispatch.
        } else { name = 'CLI'; this.sreg &= 0x7f; }
      }
      else if ((op & 0xfc00) === 0x2c00) {
        name = 'MOV';
        this.checkPcTarget(next);
        this.r[d] = this.r[rr];
      }
      else if ((op & 0xff00) === 0x0100) {
        // MOVW encodes pair numbers. Each pair starts at an even register.
        name = 'MOVW';
        const destinationLow = 2 * ((op >>> 4) & 0x0f);
        const sourceLow = 2 * (op & 0x0f);
        this.checkPcTarget(next); // Keep both bytes intact on a strict fall-through fault.
        this.setPair(destinationLow, this.pair(sourceLow));
      }
      else if ((op & 0xfc00) === 0x1000) {
        name = 'CPSE';
        const leftValue = this.r[d], rightValue = this.r[rr];
        skip = { taken: leftValue === rightValue, leftRegister: d, rightRegister: rr, leftValue, rightValue, skippedWords: 0 };
      }
      else if ((op & 0xfc08) === 0xfc00 || (op & 0xfd00) === 0x9900) {
        const io = (op & 0xfd00) === 0x9900;
        const skipOnSet = !!(op & 0x200);
        const bit = op & 7, operand = io ? (op >>> 3) & 31 : d;
        name = io ? (skipOnSet ? 'SBIS' : 'SBIC') : (skipOnSet ? 'SBRS' : 'SBRC');
        cycles = io ? 2 : 1; // AVRxm I/O skips cost one more cycle than register skips.
        const value = io ? this.read(operand, this.cycles + cycles) : this.r[operand];
        const taken = !!(value & (1 << bit)) === skipOnSet;
        skip = { taken, bit, value, ...(io ? {addressByte:operand} : {register:operand}), skippedWords:0 };
      }
      else if ((op & 0xf000) === 0xe000) { name = 'LDI'; this.r[16 + ((op >>> 4) & 15)] = imm; }
      else if ((op & 0xfe00) === 0x9600) {
        const subtract = (op & 0x0100) !== 0;
        name = subtract ? 'SBIW' : 'ADIW';
        const { destinationLowRegister, immediate } = decodeWordImmediateOperands(op);
        const original = this.pair(destinationLowRegister);
        const wide = subtract ? original - immediate : original + immediate;
        const result = wide & 0xffff;
        const wasNegative = (original & 0x8000) !== 0;
        const negative = (result & 0x8000) !== 0;
        const overflow = subtract ? wasNegative && !negative : !wasNegative && negative;
        const carry = wide < 0 || wide > 0xffff;
        this.checkPcTarget(next);
        this.setPair(destinationLowRegister, result);
        // I, T and H survive both operations. Z tests the entire new word.
        this.sreg = (this.sreg & 0xe0) | (negative !== overflow ? 0x10 : 0) |
          (overflow ? 8 : 0) | (negative ? 4 : 0) | (result === 0 ? 2 : 0) |
          (carry ? 1 : 0);
        cycles = 2;
      }
      else if ((op & 0xe000) === 0x4000) {
        const withCarry = (op >>> 12) === 4;
        name = withCarry ? 'SBCI' : 'SUBI';
        const dest = 16 + ((op >>> 4) & 15);
        this.checkPcTarget(next);
        this.r[dest] = this.compare(this.r[dest], imm, withCarry ? this.sreg & 1 : 0, withCarry);
      }
      else if ((op & 0xf000) === 0x6000 || (op & 0xf000) === 0x7000) {
        const dest = 16 + ((op >>> 4) & 15), and = !!(op & 0x1000);
        name = and ? 'ANDI' : 'ORI';
        const result = and ? this.r[dest] & imm : this.r[dest] | imm;
        this.setLogicalResult(dest, result);
      }
      else if ((op & 0xfc00) === 0x0800) {
        name = 'SBC';
        this.checkPcTarget(next);
        this.r[d] = this.compare(this.r[d], this.r[rr], this.sreg & 1, true);
      }
      else if ((op & 0xfc00) === 0x9c00) {
        name = 'MUL';
        this.checkPcTarget(next);
        const product = this.r[d] * this.r[rr]; // Sample both inputs before overwriting R1:R0.
        this.setPair(0, product);
        this.sreg = (this.sreg & 0xfc) | (product === 0 ? 2 : 0) | (product >>> 15);
        cycles = 2;
      }
      else if ((op & 0xec00) === 0x0c00) { // ADD and ADC differ only in bit 12.
        const withCarry = (op & 0x1000) !== 0;
        name = withCarry ? 'ADC' : 'ADD';
        this.checkPcTarget(next);
        const left = this.r[d], right = this.r[rr];
        const carryIn = withCarry ? this.sreg & 1 : 0;
        const sum = left + right + carryIn, result = sum & 0xff;
        const halfCarry = (left & 15) + (right & 15) + carryIn > 15;
        const negative = (result & 0x80) !== 0;
        const overflow = (~(left ^ right) & (left ^ result) & 0x80) !== 0;
        this.r[d] = result;
        this.sreg = (this.sreg & 0xc0) | (halfCarry ? 0x20 : 0) |
          (negative !== overflow ? 0x10 : 0) | (overflow ? 8 : 0) |
          (negative ? 4 : 0) | (result === 0 ? 2 : 0) | (sum > 0xff ? 1 : 0);
      }
      else if ((op & 0xfe0f) === 0x9402) {
        name = 'SWAP';
        this.checkPcTarget(next);
        const value = this.r[d];
        this.r[d] = ((value & 0x0f) << 4) | (value >>> 4);
      }
      else if ((op & 0xfe0f) === 0x9403 || (op & 0xfe0f) === 0x940a) {
        const decrement = (op & 0x0f) === 0x0a;
        name = decrement ? 'DEC' : 'INC';
        this.checkPcTarget(next);
        const original = this.r[d];
        const result = (original + (decrement ? -1 : 1)) & 0xff;
        const negative = result >= 0x80, overflow = original === (decrement ? 0x80 : 0x7f);
        this.r[d] = result;
        // Both operations preserve I, T, H and C and derive Z from the new byte.
        this.sreg = (this.sreg & 0xe1) | (negative !== overflow ? 0x10 : 0) |
          (overflow ? 8 : 0) | (negative ? 4 : 0) | (result === 0 ? 2 : 0);
      }
      else if ((op & 0xfc00) === 0x2000) {
        name = 'AND';
        this.checkPcTarget(next);
        this.setLogicalResult(d, this.r[d] & this.r[rr]);
      } else if ((op & 0xfc00) === 0x2400) {
        name = 'EOR';
        this.setLogicalResult(d, this.r[d] ^ this.r[rr]);
      } else if ((op & 0xfc00) === 0x2800) {
        name = 'OR';
        this.checkPcTarget(next);
        this.setLogicalResult(d, this.r[d] | this.r[rr]);
      } else if ((op & 0xf800) === 0xb800) {
        name = 'OUT';
        this.checkPcTarget(next);
        cycles += this.write((op & 15) | ((op >>> 5) & 48), this.r[d], this.cycles + cycles);
      } else if ((op & 0xf800) === 0xb000) {
        name = 'IN';
        this.checkPcTarget(next);
        this.r[d] = this.read((op & 15) | ((op >>> 5) & 48), this.cycles + cycles);
      } else if ((op & 0xf000) === 0x3000) { name = 'CPI'; this.compare(this.r[16 + ((op >>> 4) & 15)], imm, 0, false); }
      else if ((op & 0xfc00) === 0x1400) {
        name = 'CP';
        this.checkPcTarget(next);
        this.compare(this.r[d], this.r[rr], 0, false);
      }
      else if ((op & 0xfc00) === 0x0400) { name = 'CPC'; this.compare(this.r[d], this.r[rr], this.sreg & 1, true); }
      else if ((op & 0xfc00) === 0xf000 || (op & 0xfc00) === 0xf400) {
        name = (op & 0x400) ? 'BRBC' : 'BRBS';
        const set = !!(this.sreg & (1 << (op & 7)));
        if (set !== !!(op & 0x400)) { const k = (op >>> 3) & 127; next += k >= 64 ? k - 128 : k; cycles = 2; }
      } else if ((op & 0xf000) === 0xc000 || (op & 0xf000) === 0xd000) {
        const call = (op & 0xf000) === 0xd000; name = call ? 'RCALL' : 'RJMP';
        const k = op & 4095;
        next += k >= 2048 ? k - 4096 : k; cycles = call ? 3 : 2;
        if (call) { this.checkPcTarget(next); this.pushReturn(this.pc + 1); }
      } else if ((op & 0xfe0e) === 0x940c || (op & 0xfe0e) === 0x940e) {
        const call = !!(op & 2); name = call ? 'CALL' : 'JMP';
        next = this.word(this.pc + 1) | ((op & 1) << 16) | ((op & 0x1f0) << 13);
        if (call) { this.checkPcTarget(next); this.pushReturn(this.pc + 2); }
        cycles = call ? 4 : 3;
      } else if ([0x9409, 0x9419, 0x9509, 0x9519].includes(op)) {
        const extended = !!(op & 16), call = !!(op & 256);
        name = (extended ? 'E' : '') + (call ? 'ICALL' : 'IJMP');
        next = this.pair(30) | (extended ? this.eind << 16 : 0);
        if (call) { this.checkPcTarget(next); this.pushReturn(this.pc + 1); }
        cycles = call ? 3 : 2;
      } else if (op === 0x9508) { name = 'RET'; next = this.popReturn(); cycles = 5; }
      else if (op === 0x9518) {
        if (!pmic?.executingLevel) this.fault('RETI has no active PMIC interrupt level',
          { classification: 'RETI_WITHOUT_ACTIVE_INTERRUPT' });
        name = 'RETI'; next = this.popReturn(); cycles = 5;
        pmic.finishInterrupt();
        this.interruptEnableStep = this.steps + 2;
        // AVRxm preserves SREG, including I, across RETI.
      }
      else if ((op & 0xfc0f) === 0x900f) {
        const push = (op & 0x0200) !== 0;
        name = push ? 'PUSH' : 'POP';
        cycles = push ? 1 : 2; // AVRxm internal SRAM, instruction set manual 6.85 and 6.86.
        const address = push ? this.sp : this.sp + 1;
        this.checkPcTarget(next);
        if (!Number.isInteger(address) || address < 0x2000 || address > 0x5fff) {
          this.fault(name + ' outside internal SRAM', { classification: 'INVALID_STACK_ACCESS',
            addressByte: address, accessKind: push ? 'write' : 'read', attemptedValue: push ? this.r[d] : null });
        }
        if (push) {
          this.write(address, this.r[d], this.cycles + cycles);
          this.sp = address - 1;
        } else {
          this.r[d] = this.read(address, this.cycles + cycles);
          this.sp = address;
        }
      }
      else if ((op & 0xfe0f) === 0x920d || (op & 0xfe0f) === 0x920c || (op & 0xfe0f) === 0x9201) {
        const pair = (op & 15) === 1 ? 30 : 26;
        const pointer = pair === 30 ? 'Z' : 'X', postIncrement = Boolean(op & 1);
        name = 'ST ' + pointer + (postIncrement ? '+' : '');
        if (postIncrement && (d === pair || d === pair + 1)) {
          this.fault('Undefined ' + name + ' with source overlapping ' + pointer, {classification:'UNDEFINED_OPERANDS'});
        }
        this.checkPcTarget(next);
        const address = this.pair(pair);
        cycles += this.write(address, this.r[d], this.cycles + cycles);
        if (postIncrement) this.setPair(pair, (address + 1) & 0xffff);
      } else if ((op & 0xfe0f) === 0x900c || (op & 0xfe0f) === 0x900d || (op & 0xfe0f) === 0x9001) {
        name = 'LD';
        const pair = (op & 0x0f) === 1 ? 30 : 26;
        const postIncrement = Boolean(op & 1);
        if (postIncrement && (d === pair || d === pair + 1)) {
          const pointer = pair === 26 ? 'X' : 'Z';
          this.fault('Undefined LD Rd,' + pointer + '+ with destination overlapping ' + pointer, { classification: 'UNDEFINED_OPERANDS' });
        }
        this.checkPcTarget(next);
        const address = this.pair(pair); // The A3 data map fits in the 16-bit pointer.
        cycles = address < 0x1000 ? 1 : 2; // The bus adds the mapped EEPROM read wait.
        this.r[d] = this.read(address, this.cycles + cycles);
        if (postIncrement) this.setPair(pair, (address + 1) & 0xffff);
      } else if ((op & 0xd000) === 0x8000) {
        // 10q0 qqsr rrrr pqqq: p selects Y; s selects store.
        const q = (op & 7) | ((op >>> 7) & 0x18) | ((op >>> 8) & 0x20);
        const store = !!(op & 0x200), pair = op & 8 ? 28 : 30;
        // A3 has a 16-bit data space. RAMPZ extends flash reads, not these accesses.
        const address = (this.pair(pair) + q) & 0xffff;
        name = store ? (q ? 'STD' : 'ST') : (q ? 'LDD' : 'LD');
        // q=0 aliases plain LD/ST. AVRxm loads from I/O save one cycle.
        cycles = store ? (q ? 2 : 1) : (q ? 3 : 2) - (address < 0x1000 ? 1 : 0);
        this.checkPcTarget(next);
        if (store) cycles += this.write(address, this.r[d], this.cycles + cycles);
        else this.r[d] = this.read(address, this.cycles + cycles);
      } else if ((op & 0xfe0f) === 0x9000 || (op & 0xfe0f) === 0x9200) {
        const store = !!(op & 0x200); name = store ? 'STS' : 'LDS';
        const address = this.word(this.pc + 1); next++;
        cycles = store || address >= 0x1000 ? 2 : 1;
        this.checkPcTarget(next);
        if (store) cycles += this.write(address, this.r[d], this.cycles + cycles);
        else this.r[d] = this.read(address, this.cycles + cycles);
      } else if (op === 0x95c8 || op === 0x95d8 || (op & 0xfe0c) === 0x9004) {
        const implied = op === 0x95c8 || op === 0x95d8;
        const extended = implied ? op === 0x95d8 : !!(op & 2), inc = !implied && !!(op & 1);
        const dest = implied ? 0 : d; name = extended ? 'ELPM' : 'LPM';
        if (inc && (dest === 30 || dest === 31)) this.fault('Undefined LPM/ELPM postincrement destination overlaps Z');
        const address = this.pair(30) + (extended ? this.rampz * 65536 : 0);
        this.checkPcTarget(next);
        const ccpMode = this.bus.ccp?.read(this.cycles + 1);
        if (ccpMode === 2 || (ccpMode === 1 && extended)) {
          const reason = ccpMode === 2 ? 'Protected program-memory reads are unimplemented' :
            'ELPM during an IOREG grant has no specified CCP behavior in XMEGA A section 3.12.1';
          this.fault(reason, { classification: 'CCP_PROGRAM_READ_UNSUPPORTED', addressByte: address, accessKind: 'read' });
        }
        this.r[dest] = this.bus.readProgramData(address, extended);
        if (ccpMode === 1) this.bus.ccp.clear(); // Section 3.12.1 explicitly lists LPM.
        if (inc) { this.setPair(30, (address + 1) & 0xffff); if (extended) this.rampz = ((address + 1) >>> 16) & 7; }
        cycles = 3;
      } else this.fault(`Unsupported instruction 0x${op.toString(16).padStart(4, '0')}`);
      if (skip?.taken) {
        const following = this.word(next);
        const words = instructionWords(following);
        if (words === 2) this.word(next + 1); // Validate the operand word without executing the instruction.
        skip.skippedWords = words;
        skip.skippedPcWord = next;
        skip.skippedOpcode = following;
        next += words;
        cycles += words;
      }
      this.checkPcTarget(next);
      this.pc = next; this.steps++; this.advanceCycles(cycles);
      return { eventType: 'instruction', step: this.steps, opcode: op, mnemonic: name, before, after: this.state(), accesses: this.accesses, ...(skip ? {skip} : {}) };
    } catch (error) {
      if (!(error instanceof ExecutionFault)) throw error;
      error.trace = { eventType: 'diagnostic', instructionCompleted: false, step: this.steps + 1, before, opcode: this.currentOpcode, accesses: this.accesses, fault: error.message,
        ...(interruptRequest ? { instructionAttempted: false, interruptRequest: { ...interruptRequest } } : {}) };
      throw error;
    }
  }
}



