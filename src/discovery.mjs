// Application-independent diagnostic runner. Does not change PC or install peripherals.
import { decodeWordImmediateOperands, ExecutionFault } from './xmega.mjs';

const registerMnemonics = new Map([[0x0800, 'SBC'], [0x0c00, 'ADD'], [0x1c00, 'ADC'], [0x2c00, 'MOV']]);

export function decodeAt(cpu, pc = cpu.pc) {
  const address = pc * 2;
  const word = a => a >= 0 && a + 1 < cpu.flash.length && cpu.present[a] && cpu.present[a + 1] ? cpu.flash[a] | (cpu.flash[a + 1] << 8) : null;
  const op = word(address), second = word(address + 2);
  const base = { pcWord: pc, pcByte: address, opcode: op, opcodeWords: op === null ? [] : [op], mnemonic: 'UNKNOWN', operands: {} };
  if (op === null) return { ...base, mnemonic: 'UNFETCHABLE' };
  const d = (op >>> 4) & 31, rr = (op & 15) | ((op >>> 5) & 16);
  if ((op & 0xfc00) === 0x9c00) {
    return { ...base, mnemonic: 'MUL', operands: { leftRegister: d, rightRegister: rr } };
  }
  if ((op & 0xf800) === 0x1000) { // CPSE and CP have the same two register fields.
    return { ...base, mnemonic: op & 0x0400 ? 'CP' : 'CPSE', operands: { leftRegister: d, rightRegister: rr } };
  }
  const mnemonic = registerMnemonics.get(op & 0xfc00);
  if (mnemonic) return { ...base, mnemonic, operands: {
    destinationRegister: d, sourceRegister: rr,
  } };
  // The MOVW operands identify the low register of each aligned pair.
  if ((op & 0xff00) === 0x0100) return { ...base, mnemonic: 'MOVW', operands: { destinationLowRegister: ((op >>> 4) & 15) * 2, sourceLowRegister: (op & 15) * 2 } };
  if ((op & 0xfe00) === 0x9600) {
    return { ...base, mnemonic: (op & 0x0100) ? 'SBIW' : 'ADIW', operands: decodeWordImmediateOperands(op) };
  }
  if ((op & 0xfc0f) === 0x900f) {
    const push = (op & 0x0200) !== 0;
    return { ...base, mnemonic: push ? 'PUSH' : 'POP', operands: {
      register: d, addressByte: push ? cpu.sp : cpu.sp + 1, ...(push ? { value: cpu.r[d] } : {}),
    } };
  }
  const family = op >>> 12;
  if (family >= 4 && family <= 7) {
    return { ...base, mnemonic: ['SBCI', 'SUBI', 'ORI', 'ANDI'][family - 4], operands: {
      register: 16 + ((op >>> 4) & 15), immediate: (op & 15) | ((op >>> 4) & 240),
    } };
  }
  if ((op & 0xfc08) === 0xfc00 || (op & 0xfd00) === 0x9900) {
    const io=(op & 0xfd00)===0x9900, set=!!(op & 0x200);
    return {...base,mnemonic:io?(set?'SBIS':'SBIC'):(set?'SBRS':'SBRC'),operands:{bit:op&7,...(io?{addressByte:(op>>>3)&31}:{register:d,value:cpu.r[d]})}};
  }
  if ((op & 0xfe0f) === 0x9402) return { ...base, mnemonic: 'SWAP', operands: { register: d } };
  if ((op & 0xfe0f) === 0x9403) return { ...base, mnemonic: 'INC', operands: { register: d } };
  if ((op & 0xfe0f) === 0x940a) return { ...base, mnemonic: 'DEC', operands: { register: d } };
  if ((op & 0xfe0f) === 0x9001 || (op & 0xfe0f) === 0x900d) {
    const pointer = (op & 0x0f) === 0x0d ? 'X' : 'Z';
    return { ...base, mnemonic: 'LD', operands: { register: d, pointer, postIncrement: true } };
  }
  if ((op & 0xd000) === 0x8000) {
    const displacement = (op & 7) | ((op >>> 7) & 0x18) | ((op >>> 8) & 0x20);
    const store = !!(op & 0x200), pointer = op & 8 ? 'Y' : 'Z';
    const baseAddressByte = cpu.pair(pointer === 'Y' ? 28 : 30);
    return { ...base, mnemonic: store ? (displacement ? 'STD' : 'ST') : (displacement ? 'LDD' : 'LD'), operands: { register: d, pointer, displacement, baseAddressByte, addressByte: (baseAddressByte + displacement) & 0xffff, ...(store ? { value: cpu.r[d] } : {}) } };
  }
  if ((op & 0xfe0f) === 0x9200 || (op & 0xfe0f) === 0x9000) {
    const store = !!(op & 0x200);
    return { ...base, opcodeWords: [op, second], mnemonic: store ? 'STS' : 'LDS', operands: { register: d, addressByte: second, ...(store ? { value: cpu.r[d] } : {}) } };
  }
  if ((op & 0xf800) === 0xb800 || (op & 0xf800) === 0xb000) return { ...base, mnemonic: op & 0x800 ? 'OUT' : 'IN', operands: { register: d, addressByte: (op & 15) | ((op >>> 5) & 48), ...(op & 0x800 ? { value: cpu.r[d] } : {}) } };
  if ((op & 0xf000) === 0xe000) return { ...base, mnemonic: 'LDI', operands: { register: 16 + ((op >>> 4) & 15), immediate: (op & 15) | ((op >>> 4) & 240) } };
  if ((op & 0xfe0e) === 0x940c || (op & 0xfe0e) === 0x940e) return { ...base, opcodeWords: [op, second], mnemonic: op & 2 ? 'CALL' : 'JMP', operands: { targetWord: second === null ? null : second | ((op & 1) << 16) | ((op & 0x1f0) << 13) } };
  if ((op & 0xf000) === 0xc000 || (op & 0xf000) === 0xd000) { const k = op & 4095, offset = k >= 2048 ? k - 4096 : k; return { ...base, mnemonic: op & 0x1000 ? 'RCALL' : 'RJMP', operands: { offsetWords: offset, targetWord: pc + 1 + offset } }; }
  // Unknown instructions are explicitly left undecoded. This decoder is diagnostic-only.
  if (op === 0) base.mnemonic = 'NOP';
  if (op === 0x9508) base.mnemonic = 'RET';
  if (op === 0x9518) base.mnemonic = 'RETI';
  if (op === 0x9478) base.mnemonic = 'SEI';
  if (op === 0x94f8) base.mnemonic = 'CLI';
  return base;
}

function classify(error) {
  if (error.classification) return error.classification;
  if (/Unsupported instruction/.test(error.message)) return 'UNSUPPORTED_OPCODE';
  if (/stack (overflow|underflow)/.test(error.message)) return 'INVALID_STACK_ACCESS';
  if (/PC target outside/.test(error.message)) return 'INVALID_CONTROL_FLOW';
  if (/Undefined /.test(error.message)) return 'UNDEFINED_OPERANDS';
  return 'UNCLASSIFIED_EXECUTION_FAULT';
}

export function discover(cpu, { maxSteps = 100000, maxCycles = 200000, recentLimit = 32, pendingInterrupt = null, onTrace = () => {} } = {}) {
  if (![maxSteps, maxCycles, recentLimit].every(Number.isSafeInteger) || Math.min(maxSteps, maxCycles, recentLimit) < 1) throw new Error('Invalid diagnostic execution limits');
  if (cpu.pc !== 0 || cpu.steps !== 0 || cpu.cycles !== 0) throw new Error('Discovery must start from reset');
  const callStack = [], recentControlFlow = [], mmio = new Map(), coverage = new Map();
  let attempts = 0, interruptEntries = 0, lastCompleted = null, failure;
  function recordFlow(event) {
    recentControlFlow.push(event);
    if (recentControlFlow.length > recentLimit) recentControlFlow.shift();
  }
  function inventory(kind, space, address, value, completed, pc) {
    const key = `${space}:${address}:${kind}:${completed}`;
    const row = mmio.get(key) ?? { space, addressByte: address, kind, completed, count: 0, firstPcWord: pc, lastPcWord: pc, values: [] };
    row.count++; row.lastPcWord = pc; if (value !== null && !row.values.includes(value)) row.values.push(value); mmio.set(key, row);
  }
  while (true) {
    if (cpu.steps >= maxSteps || cpu.cycles >= maxCycles) {
      failure = { classification: 'EXECUTION_LIMIT', reason: 'Deterministic instruction/cycle limit reached', instructionCompleted: false, ...decodeAt(cpu), stateBefore: cpu.state(), stateAtStop: cpu.state() }; break;
    }
    const before = cpu.state();
    // Preserve the explicit boundary for profiles that observe requests without a PMIC.
    const request = !cpu.bus.pmic && (cpu.sreg & 0x80) && pendingInterrupt?.();
    if (request) {
      const reason = 'Pending ' + request.peripheral + ' interrupt requires PMIC arbitration';
      failure = { classification: 'UNMODELED_INTERRUPT_DELIVERY', reason, instructionCompleted: false,
        instructionAttempted: false, interruptRequest: request, ...decodeAt(cpu), stateBefore: before, stateAtStop: before };
      onTrace({ eventType: 'diagnostic', instructionCompleted: false, instructionAttempted: false,
        step: cpu.steps + 1, before, accesses: [], interruptRequest: request, fault: reason });
      break;
    }
    let t;
    try { t = cpu.step(); }
    catch (error) {
      if (!(error instanceof ExecutionFault)) throw error;
      if (error.trace) onTrace(error.trace);
      const entering = error.trace?.instructionAttempted === false;
      if (!entering) attempts++;
      const operation = entering ? { pcWord: before.pcWord, pcByte: before.pcWord * 2, opcode: null, opcodeWords: [],
        mnemonic: 'INTERRUPT_ENTRY', instructionAttempted: false, interruptRequest: error.trace.interruptRequest } : decodeAt(cpu, before.pcWord);
      failure = { classification: classify(error), reason: error.message, instructionCompleted: false, ...operation, stateBefore: before, stateAtStop: cpu.state(), memoryAccess: error.addressByte === undefined ? null : { addressByte: error.addressByte, kind: error.accessKind, attemptedValue: error.attemptedValue ?? null } };
      if (error.classification !== 'INVALID_STACK_ACCESS' && Number.isInteger(error.addressByte) && error.addressByte >= 0 && error.addressByte < 0x1000 && ['read', 'write'].includes(error.accessKind)) inventory(error.accessKind, 'mmio', error.addressByte, error.attemptedValue ?? null, false, before.pcWord);
      break;
    }
    if (t.eventType === 'interrupt-entry') {
      interruptEntries++;
      callStack.push({ frameKind: 'interrupt', entryPcWord: t.vectorPcWord, returnPcWord: t.returnPcWord,
        level: t.interruptRequest.level, spBeforeCall: before.sp, spAfterCall: t.after.sp });
      recordFlow({ eventType: t.eventType, afterStep: t.afterStep, fromWord: before.pcWord,
        toWord: t.vectorPcWord, cyclesAfter: t.after.cycles });
      onTrace(t);
      continue;
    }
    attempts++;
    lastCompleted = { pcWord: before.pcWord, opcode: t.opcode, mnemonic: t.mnemonic };
    const key = `${t.mnemonic}:${t.opcode}`;
    const row = coverage.get(key) ?? { mnemonic: t.mnemonic, opcode: t.opcode, count: 0 };
    row.count++; coverage.set(key, row);
    for (const a of t.accesses) if (a.space === 'cpu-io' || a.space === 'mmio') inventory(a.kind, a.space, a.addressByte, a.value, true, before.pcWord);
    if (['CALL', 'RCALL', 'ICALL', 'EICALL'].includes(t.mnemonic)) {
      callStack.push({ callPcWord: before.pcWord, entryPcWord: t.after.pcWord, returnPcWord: before.pcWord + t.accesses.filter(a => a.kind === 'fetch').length / 2, spBeforeCall: before.sp, spAfterCall: t.after.sp });
    } else if (t.mnemonic === 'RET' || t.mnemonic === 'RETI') {
      const top = callStack.at(-1);
      const reti = t.mnemonic === 'RETI';
      if (!top || reti !== (top.frameKind === 'interrupt') || top.returnPcWord !== t.after.pcWord || top.spBeforeCall !== t.after.sp) {
        failure = { classification: reti ? 'INTERRUPT_STACK_MISMATCH' : 'CALL_STACK_MISMATCH',
          reason: 'Executed ' + t.mnemonic + ' does not match the observed call history', instructionCompleted: true, ...decodeAt(cpu, before.pcWord), stateBefore: before, stateAtStop: cpu.state() };
      } else callStack.pop();
    }
    if (['JMP', 'RJMP', 'IJMP', 'EIJMP', 'CALL', 'RCALL', 'ICALL', 'EICALL', 'RET', 'RETI', 'BRBC', 'BRBS', 'CPSE', 'SBRC', 'SBRS', 'SBIC', 'SBIS'].includes(t.mnemonic)) {
      recordFlow({ step: t.step, fromWord: before.pcWord, toWord: t.after.pcWord, mnemonic: t.mnemonic, cyclesAfter: t.after.cycles });
    }
    onTrace(t);
    if (failure) break;
    if (cpu.cycles > maxCycles) { failure = { classification: 'EXECUTION_LIMIT', reason: 'Last instruction exceeded the cycle budget', instructionCompleted: true, ...decodeAt(cpu, before.pcWord), stateBefore: before, stateAtStop: cpu.state() }; break; }
  }
  return { status: 'CONTROLLED_STOP', applicationBootSuccessful: false, completedInstructions: cpu.steps, attemptedInstructions: attempts, cycles: cpu.cycles, lastPcWord: cpu.pc, lastPcByte: cpu.pc * 2, lastCompletedInstruction: lastCompleted, firstBlockingEvent: failure, callStack, ...(cpu.bus.pmic ? { interruptEntries } : {}), callStackMethod: interruptEntries ? 'observed subroutine and interrupt frames with checked RET and RETI' : 'shadow stack from executed CALL/RCALL/ICALL/EICALL and checked RET; not a heuristic SRAM unwind', recentControlFlow, mmioInventory: [...mmio.values()], opcodeCoverage: [...coverage.values()] };
}


