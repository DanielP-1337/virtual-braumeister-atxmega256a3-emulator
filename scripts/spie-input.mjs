import { spicFrameInput } from './spic-input.mjs';

// One wire byte per SPIE master transfer. A new reset starts a new exchange.
export function spieFrameInput(sequence) {
  if (sequence === undefined) return null;
  if (typeof sequence !== 'string' || !/^0x[0-9a-f]{2}(?:,0x[0-9a-f]{2})*$/i.test(sequence)) {
    throw new Error('Expected --synthetic-spie-rx 0xNN[,0xNN...]');
  }
  const [first, ...remaining] = sequence.split(',');
  const peer = spicFrameInput(first, remaining.length ? remaining.join(',') : undefined);
  return { report: { ...peer.report, peripheral: 'SPIE' }, createExchange: peer.createExchange };
}
