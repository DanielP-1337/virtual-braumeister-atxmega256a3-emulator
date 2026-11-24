import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonRun, withComparedLog } from '../scripts/compare-run.mjs';

const privateRoot = realpathSync(fileURLToPath(new URL('../private/', import.meta.url)));
const sha = data => createHash('sha256').update(data).digest('hex');
const firmwareHash = 'a'.repeat(64);
const diagnostic = JSON.stringify({ origin: 'emulator', eventType: 'diagnostic', instructionCompleted: false, step: 4, before: { pcWord: 3 } }) + '\n';
function fixture(t, prefix) {
  const dir = mkdtempSync(join(privateRoot, 'test-log-prefix-'));
  t.after(() => { for (const f of readdirSync(dir)) unlinkSync(join(dir, f)); rmdirSync(dir); });
  writeFileSync(join(dir, 'trace.jsonl'), prefix + diagnostic);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'CONTROLLED_STOP', firmwareSha256: firmwareHash, deterministicReplay: true,
    attemptedInstructions: 4, lastPcWord: 3, traceSha256: sha(prefix + diagnostic) }));
  writeFileSync(join(dir, 'nvm-accesses.jsonl'), 'first\n');
  return { dir, ref: comparisonRun(privateRoot, basename(dir), firmwareHash) };
}
const emit = values => append => { for (const value of values) append(value); return 'executed'; };

test('Trace comparison reconstructs exact multiblock UTF-8 output and can append new NVM events', t => {
  const rows = ['a'.repeat(40000) + '\n', 'é'.repeat(44000) + '\n', 'third\n'], prefix = rows.join('');
  const { dir, ref } = fixture(t, prefix);
  for (const [source, previous, chunks, extra, name] of [
    [ref.trace, prefix, rows, 'new\nstop\n', 'cpu-suffix'], [ref.nvm, 'first\n', ['first\n'], 'write\n', 'nvm-suffix'],
  ]) {
    const path = join(dir, name);
    const a = withComparedLog(path, true, source, emit([...chunks, extra]));
    const b = withComparedLog(path, false, source, emit([...chunks, extra]));
    assert.deepEqual(a, b); assert.equal(a.result, 'executed'); assert.equal(a.count, chunks.length + 1);
    assert.deepEqual(a.receipt, { prefixBytes: Buffer.byteLength(previous), prefixSha256: sha(previous), suffixBytes: Buffer.byteLength(extra), sha256: sha(previous + extra) });
    assert.equal(readFileSync(path, 'utf8'), extra);
    assert.equal(sha(Buffer.concat([readFileSync(source.file).subarray(0, a.receipt.prefixBytes), readFileSync(path)])), a.receipt.sha256);
    assert.throws(() => withComparedLog(path, true, source, emit(chunks)), { code: 'EEXIST' });
  }
  assert.equal(readFileSync(ref.trace.file, 'utf8'), prefix + diagnostic);
});

test('Trace comparison rejects an altered or short prefix, corrupt receipt, and changed or truncated replay suffix', t => {
  const { dir, ref } = fixture(t, 'abc\n');
  const run = (file, save, input, reference = ref.trace) => withComparedLog(join(dir, file), save, reference, emit(input));
  assert.throws(() => run('changed', true, ['abd\n']), /Byte mismatch/);
  assert.throws(() => run('short', true, ['ab']), /ended before/);
  assert.throws(() => run('digest', true, ['abc\n'], { ...ref.trace, originalSha256: '0'.repeat(64) }), /SHA-256/);
  run('verified', true, ['abc\n', 'xy']);
  assert.throws(() => run('verified', false, ['abc\n', 'xz']), /Byte mismatch/);
  assert.throws(() => run('verified', false, ['abc\n', 'x']), /Extra recorded/);
  assert.throws(() => run('verified', false, ['abc\n', 'xyz']), /Truncated/);
  assert.equal(readFileSync(ref.trace.file, 'utf8'), 'abc\n' + diagnostic);
});

test('Trace comparison requires a complete diagnostic from the correct local run and handles an empty suffix', t => {
  const { dir, ref } = fixture(t, 'A\n');
  assert.throws(() => comparisonRun(privateRoot, '../other', firmwareHash), /direct private run/);
  assert.throws(() => comparisonRun(privateRoot, basename(dir), '0'.repeat(64)), /same firmware/);
  const file = join(dir, 'empty');
  const a = withComparedLog(file, true, ref.nvm, emit(['first\n']));
  assert.equal(a.receipt.suffixBytes, 0);
  assert.deepEqual(a, withComparedLog(file, false, ref.nvm, emit(['first\n'])));
  writeFileSync(ref.trace.file, 'A\n' + diagnostic.trimEnd());
  assert.throws(() => comparisonRun(privateRoot, basename(dir), firmwareHash), /complete diagnostic/);
});
