// Each explicit wire byte belongs to one SPIC frame. Each reset creates its own peer.
export function spicFrameInput(first, following) {
  if (first === undefined && following === undefined) return null;
  const hexByte = /^0x[0-9a-f]{2}$/i;
  if (typeof first !== 'string' || !hexByte.test(first)) {
    throw new Error('Expected --synthetic-spic-first-rx 0xNN');
  }
  if (following !== undefined && (typeof following !== 'string' || !following.split(',').every(value=>hexByte.test(value)))) {
    throw new Error('Expected --synthetic-spic-next-rx 0xNN[,0xNN...] following the first frame');
  }
  const bytes = [first,...(following === undefined ? [] : following.split(','))].map(value=>Number.parseInt(value.slice(2),16));
  return {
    report:{provenance:'synthetic',peripheral:'SPIC',frameIndex:0,wireRx:bytes[0],
      ...(bytes.length > 1 ? {additionalWireRx:bytes.slice(1)} : {})},
    createExchange() {
      let index = 0;
      return () => index < bytes.length ? bytes[index++] : null;
    },
  };
}

export { spicFrameInput as firstSpicInput };
