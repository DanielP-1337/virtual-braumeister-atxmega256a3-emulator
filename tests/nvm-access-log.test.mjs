import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withNvmAccessLog } from '../scripts/nvm-access-log.mjs';

function fixture(t) {
  const dir = mkdtempSync(fileURLToPath(new URL('../private/test-nvm-log-', import.meta.url)));
  const file = join(dir, 'accesses.jsonl');
  t.after(() => { if (existsSync(file)) unlinkSync(file); rmdirSync(dir); });
  return file;
}

test('NVM access recording preserves JSONL bytes and checks a multi-block deterministic replay', t => {
  const file = fixture(t);
  const events = Array.from({ length: 2400 }, (_, i) => ({ clock: i, register: 'STATUS', value: i & 0x80 }));
  const execute = emit => { events.forEach(emit); return 'complete'; };
  const expected = events.map(e => JSON.stringify(e) + '\n').join('');
  assert.ok(expected.length > 65536);
  assert.deepEqual(withNvmAccessLog(file, true, execute), { count: events.length, result: 'complete' });
  assert.equal(readFileSync(file, 'utf8'), expected);
  assert.deepEqual(withNvmAccessLog(file, false, execute), { count: events.length, result: 'complete' });
  assert.throws(() => withNvmAccessLog(file, true, execute), { code: 'EEXIST' });
});

test('NVM access replay detects changed, missing and extra rows and leaves the recording intact', t => {
  const file = fixture(t), rows = [1, 2, 3];
  const send = values => emit => { for (const value of values) emit({ value }); };
  withNvmAccessLog(file, true, send(rows));
  const original = readFileSync(file);
  assert.throws(() => withNvmAccessLog(file, false, send([1, 9, 3])), /replay differs/);
  assert.throws(() => withNvmAccessLog(file, false, send([1, 2])), /Extra recorded/);
  assert.throws(() => withNvmAccessLog(file, false, send([1, 2, 3, 4])), /Truncated/);
  assert.doesNotThrow(() => withNvmAccessLog(file, false, send(rows)));
  assert.deepEqual(readFileSync(file), original);
});
