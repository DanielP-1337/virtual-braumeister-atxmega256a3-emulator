import { ADCA } from '../src/peripherals/adca.mjs';
import { XmegaCPU } from '../src/xmega.mjs';

export function adcStoreFixture(address, sourceRegister, mappings) {
  const flash = new Uint8Array(0x42000), present = new Uint8Array(flash.length);
  const opcode = 0x9200 | (sourceRegister << 4); // Two-word STS, little endian.
  flash.set([opcode & 0xff, opcode >>> 8, address & 0xff, address >>> 8]);
  present.fill(1, 0, 4);
  const cpu = new XmegaCPU({ flash, present }), events = [];
  const adc = new ADCA({ onAccess: event => events.push(event) });
  adc.register(cpu.bus.mmio, { ...mappings, context: () => ({ pcWord: cpu.pc, instructionAttempt: cpu.steps + 1 }),
    fault: (message, details) => cpu.fault(message, details) });
  return { cpu, adc, events };
}
