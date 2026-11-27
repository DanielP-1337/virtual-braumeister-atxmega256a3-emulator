// Each explicit physical sample applies to a PORTF.IN bus read only at its named emulator cycle.
export function portfInput(spec) {
  if (spec === undefined) return null;
  const format = 'Expected --synthetic-portf-in CYCLE:0xNN[,CYCLE:0xNN...] in ascending bus cycles';
  if (typeof spec !== 'string') throw new Error(format);
  const byCycle = new Map();
  let last = -1;
  for (const field of spec.split(',')) {
    const match = /^(\d+):0x([\da-f]{2})$/i.exec(field);
    if (!match) throw new Error(format);
    const cycle = Number(match[1]);
    if (!Number.isSafeInteger(cycle) || cycle <= last) throw new Error(format);
    byCycle.set(cycle, Number.parseInt(match[2], 16));
    last = cycle;
  }
  return {
    report: { provenance:'synthetic', port:'F', register:'IN', samples:Array.from(byCycle, ([cycle,value]) => ({cycle,value})) },
    inputSampleAt(port, cycle) { return port === 'F' ? byCycle.get(cycle) : undefined; },
  };
}
