// Strict Intel HEX loading. Addresses in this module are bytes, never PC words.
export const FLASH_SIZE = 0x42000; // 256 KiB application + 8 KiB boot

export function parseHex(text, size = FLASH_SIZE) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid flash size');
  const flash = new Uint8Array(size).fill(0xff);
  const present = new Uint8Array(size);
  let base = 0, eof = false, count = 0, startAddress = null;
  const fail = (line, reason) => { throw new Error(`HEX line ${line}: ${reason}`); };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (!raw.trim()) continue;
    if (eof) fail(line, 'record after EOF');
    if (!/^:[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 1) fail(line, 'invalid record syntax');
    const bytes = Array.from(raw.slice(1).matchAll(/../g), m => parseInt(m[0], 16));
    if (bytes.length < 5 || bytes.length !== bytes[0] + 5) fail(line, 'length mismatch');
    if (bytes.reduce((a, b) => a + b, 0) % 256) fail(line, 'checksum mismatch');
    const n = bytes[0], address = bytes[1] * 256 + bytes[2], type = bytes[3];
    const data = bytes.slice(4, -1);
    if (type === 0) {
      if (address + n > 0x10000) fail(line, 'record crosses 64 KiB address window');
      for (let i = 0; i < n; i++) {
        const a = base + address + i;
        if (a >= size) fail(line, `flash address out of range: 0x${a.toString(16)}`);
        if (present[a]) fail(line, `overlapping byte: 0x${a.toString(16)}`);
        present[a] = 1; flash[a] = data[i]; count++;
      }
    } else if (type === 1) {
      if (n || address) fail(line, 'invalid EOF');
      eof = true;
    } else if (type === 2 || type === 4) {
      if (n !== 2 || address) fail(line, 'invalid extended address record');
      base = (data[0] * 256 + data[1]) * (type === 2 ? 16 : 65536);
    } else if (type === 3 || type === 5) {
      if (n !== 4 || address || startAddress !== null) fail(line, 'invalid/duplicate start address');
      startAddress = { type, bytes: data }; // Metadata only; never overrides reset PC.
    } else fail(line, `unsupported record type ${type}`);
  }
  if (!eof) throw new Error('HEX missing EOF');
  if (!count) throw new Error('HEX contains no data');
  const ranges = [];
  for (let i = 0; i < size;) {
    if (!present[i]) { i++; continue; }
    const first = i;
    while (i < size && present[i]) i++;
    ranges.push([first, i - 1]);
  }
  return { flash, present, count, ranges, startAddress };
}
