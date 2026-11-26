// One explicit peer response for the initial address phase of a reset run.
export function twieAddressAck(spec) {
  if (spec === undefined) return null;
  if (typeof spec !== 'string' || !/^0x[\da-f]{2}$/i.test(spec)) {
    throw new Error('Expected --synthetic-twie-address-ack as one hex address byte including the direction bit');
  }
  const addressByte = Number(spec), address = addressByte >>> 1, read = Boolean(addressByte & 1);
  return {
    report: { provenance: 'synthetic', peripheral: 'TWIE', phase: 'initial-address', addressByte, address, read, ack: true },
    respond(request, committedBusEvents) {
      // The master asks before committing START. A retry of a rejected command sees the same evidence.
      if (committedBusEvents === 0 && request.action === 'address' && !request.repeated &&
          request.address === address && request.read === read) return true;
      return undefined;
    },
  };
}
