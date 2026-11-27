// Restore local regression assertions from a user-supplied image. The image is read only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseHex } from '../src/hex.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const snapshots = {
  ldd: '96935a2682818960c5f0c7744a66dbd3fe9e435f3e3e4d15aeb8fe5b439ac554',
  nvm: 'b24b366085976750621e9a9c2b88468669f3731a4228faea20a282f48ba37e14',
  skip: 'f45928d90d45201910f466cd6c530539a0092bb99efc26fb9e7f25b8cb8159a6',
  logical: 'abcf6510a03ca68993438406b3a8e91b82d62debafb2d2e68354f6f5336ad7e0',
  eeprom: '51f8c4751d717cd2e471de3360d6c0fdb4f9fb31ca3cef27e8c389bafd69d3a4',
};

if (process.argv.length !== 3) throw new Error('Usage: node scripts/restore-discovery.mjs PATH_TO_LOCAL_FIRMWARE.hex');
const firmware = readFileSync(process.argv[2]);
if (sha256(firmware) !== 'c5cea66ff95f62b9e487559d9b2177b84956033854a54ea670a7927731c71847') {
  throw new Error('Expected the original BrewControl 1.1.27 Intel HEX file');
}
const { present, flash } = parseHex(firmware.toString('utf8'));
const pending = [];
for (const [name, digest] of Object.entries(snapshots)) {
  const target = new URL('./discover-' + name + '.mjs', import.meta.url);
  const template = new URL('./discovery-templates/discover-' + name + '.mjs.in', import.meta.url);
  const restored = readFileSync(template, 'utf8').replace(/@FLASH_WORD\(([0-9a-f]{6})\)@/g, (_, hexWord) => {
    const offset = 2 * Number.parseInt(hexWord, 16);
    if (!present[offset] || !present[offset + 1]) throw new Error('Unmapped flash at word ' + hexWord);
    return '0x' + (flash[offset] | (flash[offset + 1] << 8)).toString(16).padStart(4, '0');
  });
  if (sha256(restored) !== digest) throw new Error('Restored source digest mismatch for ' + name);
  if (existsSync(target)) {
    if (sha256(readFileSync(target)) !== digest) throw new Error('Existing local script differs: ' + target.pathname);
  } else {
    pending.push({ target, restored });
  }
}
for (const { target, restored } of pending) writeFileSync(target, restored, { flag: 'wx' });
console.log('Verified all five source digests. Created ' + pending.length + ' local discovery scripts.');
