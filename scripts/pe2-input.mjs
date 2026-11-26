// Synthetic PE2 input on the emulator's CPU cycle timeline. Both endpoints are included.
export function pe2HighInput(spec) {
  if (spec === undefined) return null;
  const match = typeof spec === 'string' && /^(\d+):(\d+)$/.exec(spec);
  if (!match) throw new Error('Expected --synthetic-pe2-high FROM:THROUGH in decimal emulator cycles');
  const fromCycle = Number(match[1]), throughCycle = Number(match[2]);
  if (!Number.isSafeInteger(fromCycle) || !Number.isSafeInteger(throughCycle) || fromCycle > throughCycle) {
    throw new Error('Expected an ordered PE2 interval in safe integer cycles');
  }
  return {
    report: { provenance:'synthetic',pin:'PE2',level:'high',fromCycle,throughCycle,endpoints:'inclusive' },
    stableHighMask(port, from, through) {
      return port === 'E' && from >= fromCycle && from <= through && through <= throughCycle ? 0x04 : 0;
    },
  };
}
