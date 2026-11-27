function hexByte(spec, format) {
  if (spec === undefined) return undefined;
  if (typeof spec !== 'string' || !/^0x[\da-f]{2}$/i.test(spec)) throw new Error('Expected ' + format);
  return Number(spec);
}

// Peer responses apply only to the opening write and its repeated-start read.
export function twieAddressAck(spec, firstDataSpec, { repeatedReadAck, firstReadByte, secondReadByte, thirdReadByte, additionalReadBytes } = {}) {
  const addressByte = hexByte(spec, '--synthetic-twie-address-ack as one hex address byte including the direction bit');
  const data = hexByte(firstDataSpec, '--synthetic-twie-first-data-ack as one hex data byte');
  const readAddress = hexByte(repeatedReadAck, '--synthetic-twie-read-address-ack as one hex address byte');
  const received = hexByte(firstReadByte, '--synthetic-twie-first-read-byte as one hex data byte');
  const second = hexByte(secondReadByte, '--synthetic-twie-second-read-byte as one hex data byte');
  const third = hexByte(thirdReadByte, '--synthetic-twie-third-read-byte as one hex data byte');
  const format = '--synthetic-twie-additional-read-bytes as comma-separated hex bytes';
  if (additionalReadBytes !== undefined && typeof additionalReadBytes !== 'string') throw new Error('Expected ' + format);
  const additional = additionalReadBytes === undefined ? [] : additionalReadBytes.split(',').map(byte => hexByte(byte, format));
  const address = addressByte >>> 1, read = Boolean(addressByte & 1);
  if (data !== undefined && (addressByte === undefined || read)) throw new Error('The first data ACK requires an initial write address ACK');
  if (readAddress !== undefined && (data === undefined || readAddress !== (addressByte | 1))) {
    throw new Error('The repeated read ACK requires the first write data ACK and the read address of the same peer');
  }
  if (received !== undefined && readAddress === undefined) throw new Error('The first read byte requires a repeated read address ACK');
  if (second !== undefined && received === undefined) throw new Error('The second read byte requires the first read byte');
  if (third !== undefined && second === undefined) throw new Error('The third read byte requires the second read byte');
  if (additional.length && third === undefined) throw new Error('Additional read bytes require the third read byte');
  if (addressByte === undefined) return null;
  const firstWrite = data === undefined ? null : { index: 0, value: data, ack: true };
  const repeatedRead = readAddress === undefined ? null : { addressByte: readAddress, ack: true,
    ...(received !== undefined && { firstByte: received }), ...(second !== undefined && { secondByte: second }),
    ...(third !== undefined && { thirdByte: third }), ...(additional.length > 0 && { additionalBytes: additional }) };
  const readBytes = [received, second, third, ...additional];
  return {
    report: { provenance: 'synthetic', peripheral: 'TWIE', phase: 'initial-address', addressByte, address, read, ack: true,
      ...(firstWrite && { firstWrite }), ...(repeatedRead && { repeatedRead }) },
    respond(request, history) {
      const committedBusEvents = Array.isArray(history) ? history.length : history;
      // The master asks before committing START. A retry of a rejected command sees the same evidence.
      if (committedBusEvents === 0 && request.action === 'address' && !request.repeated &&
          request.address === address && request.read === read) return true;
      // At this point only START and the initial address have reached the wire.
      if (firstWrite && committedBusEvents === 2 && request.action === 'write' && request.address === address &&
          request.index === firstWrite.index && request.value === firstWrite.value) return true;
      if (!repeatedRead || !Array.isArray(history) || request.address !== address || history.length < 3) return undefined;
      const [start, initial, written, restart, readAck] = history;
      if (start.action !== 'start' || initial.action !== 'address' || initial.addressByte !== addressByte || initial.ack !== true ||
          written.action !== 'write' || written.address !== address || written.index !== 0 || written.value !== data || written.ack !== true) return undefined;
      if (history.length === 3) {
        if (request.action === 'address' && request.repeated === true && request.read === true) return true;
        if (request.action === 'read' && request.index === 0) return received;
        return undefined;
      }
      const index = request.index;
      if (request.action !== 'read' || !Number.isInteger(index) || index < 1 || index >= readBytes.length ||
          history.length !== 4 + 2 * index) return undefined;
      if (restart.action !== 'repeated-start' || readAck.action !== 'address' || readAck.address !== address ||
          readAck.addressByte !== readAddress || readAck.read !== true || readAck.ack !== true) return undefined;
      // Each additional byte follows the committed read and a master ACK of every earlier byte except the last.
      for (let i = 0; i < index; i++) {
        const readEvent = history[5 + 2 * i];
        if (readEvent.action !== 'read' || readEvent.address !== address || readEvent.index !== i || readEvent.value !== readBytes[i]) return undefined;
        if (i + 1 < index) {
          const ackEvent = history[6 + 2 * i];
          if (ackEvent.action !== 'master-ack' || ackEvent.address !== address || ackEvent.ack !== true) return undefined;
        }
      }
      return readBytes[index];
    },
  };
}
