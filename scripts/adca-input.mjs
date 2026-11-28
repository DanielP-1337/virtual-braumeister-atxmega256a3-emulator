// Digitized values are consumed in channel 0 conversion order. Each reset replays the same inputs.
export function adcaSampleInput(phaseText, resultsText) {
  if (phaseText === undefined && resultsText === undefined) return null;
  if (phaseText !== undefined && (typeof phaseText !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,2})$/.test(phaseText) || Number(phaseText) > 511)) {
    throw new Error('Expected --synthetic-adca-clock-phase as a peripheral clock residue from 0 through 511');
  }
  if (resultsText !== undefined && (typeof resultsText !== 'string' ||
      !/^0x[0-9a-f]{3}(?:,0x[0-9a-f]{3})*$/i.test(resultsText))) {
    throw new Error('Expected --synthetic-adca-ch0-results 0xNNN[,0xNNN...]');
  }
  const clockPhase = phaseText === undefined ? null : Number(phaseText);
  const results = resultsText === undefined ? [] : resultsText.split(',').map(Number);
  return { clockPhase, results };
}
