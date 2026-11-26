// Firmware discovery input for the ATxmega256A3 production signature row.
export function productionSignatureInput(mapped, syntheticAdcaCal0, syntheticAdcaCal1) {
  const bytes = new Map(), suppliedBytes = [];
  for (const [name, offset, input] of [['ADCACAL0', 0x20, syntheticAdcaCal0], ['ADCACAL1', 0x21, syntheticAdcaCal1]]) {
    if (input === undefined) continue;
    const option = '--synthetic-' + name.toLowerCase();
    if (!mapped) throw new Error(option + ' requires mapped NVM calibration reads');
    if (typeof input !== 'string' || !/^0x[\da-f]{2}$/i.test(input)) throw new Error('Expected ' + option + ' as one hex byte');
    const value = Number(input);
    bytes.set(offset, value);
    suppliedBytes.push({ name, offset, value });
  }
  if (!mapped) return null;
  return { bytes, report: suppliedBytes.length ? { provenance: 'synthetic', suppliedBytes } : { provenance: 'unknown' } };
}
