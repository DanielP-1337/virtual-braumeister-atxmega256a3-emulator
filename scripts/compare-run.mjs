import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// A reference supplies bytes for comparison only. The executor never receives a byte from either log.
export function comparisonRun(privateRoot, runName, firmwareSha256) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(runName)) throw new Error('Expected a direct private run name');
  const dir = realpathSync(join(privateRoot, runName));
  assert.equal(dirname(dir), privateRoot, 'Reference run outside private directory');
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.deepEqual([result.status, result.deterministicReplay, result.firmwareSha256],
    ['CONTROLLED_STOP', true, firmwareSha256], 'Expected a verified reference run of the same firmware');
  const file = join(dir, 'trace.jsonl'), fd = openSync(file, 'r');
  let bytes, trailer;
  try {
    bytes = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(bytes, 65536));
    assert.equal(readSync(fd, tail, 0, tail.length, bytes - tail.length), tail.length);
    assert.equal(tail.at(-1), 10, 'Expected a complete diagnostic line');
    const start = tail.lastIndexOf(10, tail.length - 2) + 1;
    assert.ok(start || bytes === tail.length, 'Reference diagnostic exceeds the bounded tail');
    trailer = tail.subarray(start);
    const last = JSON.parse(trailer.toString());
    assert.deepEqual([last.origin, last.eventType, last.instructionCompleted, last.step, last.before.pcWord],
      ['emulator', 'diagnostic', false, result.attemptedInstructions, result.lastPcWord]);
  } finally { closeSync(fd); }
  const nvmFile = join(dir, 'nvm-accesses.jsonl');
  return { runName, trace: { file, bytes: bytes - trailer.length, trailer, originalSha256: result.traceSha256 },
    nvm: { file: nvmFile, bytes: statSync(nvmFile).size } };
}

function compareBytes(fd, bytes, label) {
  if (!bytes.length) return;
  const reference = Buffer.allocUnsafe(bytes.length);
  for (let offset = 0; offset < bytes.length;) {
    const n = readSync(fd, reference, offset, bytes.length - offset, null);
    assert.ok(n, 'Truncated ' + label);
    offset += n;
  }
  assert.ok(reference.equals(bytes), 'Byte mismatch in ' + label);
}

// Both passes execute every event. Capture stores the suffix; replay compares it as well.
export function withComparedLog(suffixPath, recording, prefix, execute) {
  const prior = openSync(prefix.file, 'r');
  let suffix;
  try {
    suffix = openSync(suffixPath, recording ? 'wx' : 'r');
    const prefixHash = createHash('sha256'), fullHash = createHash('sha256');
    let buffer = '', remaining = prefix.bytes, suffixBytes = 0, count = 0;
    function flush() {
      if (!buffer) return;
      const bytes = Buffer.from(buffer);
      buffer = '';
      const n = Math.min(bytes.length, remaining);
      const common = bytes.subarray(0, n), extra = bytes.subarray(n);
      compareBytes(prior, common, 'archived prefix');
      prefixHash.update(common);
      remaining -= n;
      if (recording) {
        if (extra.length) writeFileSync(suffix, extra);
      } else compareBytes(suffix, extra, 'replayed suffix');
      suffixBytes += extra.length;
      fullHash.update(bytes);
    }
    const result = execute(line => {
      buffer += line;
      count++;
      if (buffer.length >= 65536) flush();
    });
    flush();
    assert.equal(remaining, 0, 'Execution ended before the complete reference prefix');
    assert.equal(fstatSync(prior).size, prefix.bytes + (prefix.trailer?.length ?? 0), 'Reference size changed');
    if (prefix.trailer) {
      compareBytes(prior, prefix.trailer, 'archived diagnostic');
      assert.equal(prefixHash.copy().update(prefix.trailer).digest('hex'), prefix.originalSha256, 'Reference trace SHA-256');
    }
    if (!recording) assert.equal(readSync(suffix, Buffer.alloc(1), 0, 1, null), 0, 'Extra recorded suffix bytes');
    return { result, count, receipt: { prefixBytes: prefix.bytes, prefixSha256: prefixHash.digest('hex'), suffixBytes, sha256: fullHash.digest('hex') } };
  } finally {
    if (suffix !== undefined) closeSync(suffix);
    closeSync(prior);
  }
}
