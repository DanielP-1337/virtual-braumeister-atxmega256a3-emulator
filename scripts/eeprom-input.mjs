import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EEPROM_SIZE } from '../src/eeprom-storage.mjs';
import { parseHex } from '../src/hex.mjs';

// A sparse capture uses EEPROM byte offsets 0..4095. Only data records establish bytes.
export function loadEepromInput(rawPath, hexPath, read = readFileSync) {
  if (rawPath !== undefined && hexPath !== undefined) {
    throw new Error('Supply only one EEPROM input: --eeprom or --eeprom-ihex');
  }
  const path = rawPath ?? hexPath;
  if (path === undefined) return { provenance: { kind: 'unknown', label: 'No EEPROM image supplied' } };
  if (!path) throw new Error('Missing EEPROM input path');
  const label = resolve(path);
  const source = read(label);
  const provenance = { kind: 'local-dump', label, sha256: createHash('sha256').update(source).digest('hex') };
  if (hexPath === undefined) {
    if (source.length !== EEPROM_SIZE) throw new Error('Raw EEPROM input must be 4096 bytes');
    return { bytes: source, provenance };
  }
  const { flash, present } = parseHex(source.toString('utf8'), EEPROM_SIZE);
  return { bytes: flash, valid: present, provenance: { ...provenance, format: 'intel-hex', addressSpace: 'eeprom-byte-offset' } };
}
