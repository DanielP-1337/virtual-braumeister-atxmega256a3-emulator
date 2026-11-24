// Generic bounded runner. The stop address is an observation gate, never assigned to PC.
import { ExecutionFault } from './xmega.mjs';
export function execute(cpu, { stopPcWord, maxSteps = 100000, maxCycles = 200000, onTrace = () => {} }) {
  if (![stopPcWord, maxSteps, maxCycles].every(Number.isSafeInteger) || maxSteps < 1 || maxCycles < 1) throw new Error('Invalid execution limits');
  while (cpu.pc !== stopPcWord) {
    if (cpu.steps >= maxSteps || cpu.cycles >= maxCycles) throw new ExecutionFault('Execution limit reached', { pcWord: cpu.pc, opcode: cpu.flash[cpu.pc * 2] | (cpu.flash[cpu.pc * 2 + 1] << 8) });
    try {
      const trace = cpu.step(); onTrace(trace);
    } catch (error) { if (error.trace) onTrace(error.trace); throw error; }
    if (cpu.cycles > maxCycles) throw new ExecutionFault('Cycle budget exceeded by final instruction', { pcWord: cpu.pc, opcode: cpu.currentOpcode });
  }
  return cpu.state();
}
