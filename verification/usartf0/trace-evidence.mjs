import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (dir, name) => readFileSync(join(dir, name));
const json = (dir, name) => JSON.parse(read(dir, name).toString('utf8').replace(/^\uFEFF/, ''));
const lines = buf => buf.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const sha = data => createHash('sha256').update(data).digest('hex');
async function fileHash(file, limit) {
  const hash = createHash('sha256');
  const options = { highWaterMark: 1024 * 1024 };
  if (limit !== undefined) options.end = limit - 1;
  for await (const chunk of createReadStream(file, options)) hash.update(chunk);
  return hash;
}
function finalLine(buffer) {
  assert.equal(buffer.at(-1), 10);
  const start = buffer.lastIndexOf(10, buffer.length - 2) + 1;
  return { before: buffer.subarray(0, start), diagnostic: buffer.subarray(start) };
}
function tailAt(file, start) {
  const size = statSync(file).size - start;
  assert.ok(size > 0 && size < 65536);
  const fd = openSync(file, 'r'), buf = Buffer.alloc(size);
  try { assert.equal(readSync(fd, buf, 0, size, start), size); } finally { closeSync(fd); }
  return buf;
}

// Rehash the raw base, its old terminal diagnostic, and both generations of suffixes.
async function compareStored(priv, dir, priorDir, current, prior, { allowNvmAppend = false } = {}) {
  const m = json(dir, 'trace-reference.json'), oldM = json(priorDir, 'trace-reference.json');
  assert.deepEqual(m, current.traceStorage);
  assert.deepEqual(oldM, prior.traceStorage);
  assert.equal(m.format, 'jsonl-prefix-v1');
  assert.equal(m.referenceRun, oldM.referenceRun);
  const base = join(priv, m.referenceRun), raw = join(base, 'trace.jsonl');
  const original = json(base, 'result.json');
  const prefix = await fileHash(raw, m.trace.prefixBytes);
  assert.equal(prefix.copy().digest('hex'), m.trace.prefixSha256);
  const oldEnd = tailAt(raw, m.trace.prefixBytes);
  assert.equal(lines(oldEnd).length, 1);
  assert.equal(lines(oldEnd)[0].origin, 'emulator');
  assert.equal(prefix.copy().update(oldEnd).digest('hex'), original.traceSha256);
  assert.equal(original.traceSha256, m.referenceTraceSha256);
  assert.equal(oldM.trace.prefixBytes, m.trace.prefixBytes);
  assert.equal(oldM.trace.prefixSha256, m.trace.prefixSha256);
  const nvm = join(base, 'nvm-accesses.jsonl'), nvmPrefix = await fileHash(nvm);
  const oldNvm = read(priorDir, 'nvm-suffix.jsonl'), newNvm = read(dir, 'nvm-suffix.jsonl');
  assert.deepEqual(newNvm.subarray(0, oldNvm.length), oldNvm);
  for (const [suffix, manifest] of [[oldNvm, oldM], [newNvm, m]]) {
    if (!allowNvmAppend) assert.equal(suffix.length, 0);
    assert.deepEqual(manifest.nvm, { prefixBytes: statSync(nvm).size, prefixSha256: nvmPrefix.copy().digest('hex'),
      suffixBytes: suffix.length, sha256: nvmPrefix.copy().update(suffix).digest('hex') });
  }
  const old = read(priorDir, 'trace-suffix.jsonl'), now = read(dir, 'trace-suffix.jsonl');
  for (const [suffix, manifest, result] of [[old, oldM, prior], [now, m, current]]) {
    assert.equal(suffix.length, manifest.trace.suffixBytes);
    assert.equal(prefix.copy().update(suffix).digest('hex'), manifest.trace.sha256);
    assert.equal(manifest.trace.sha256, result.traceSha256);
    const completed = prefix.copy(), before = finalLine(suffix).before;
    if (result.interruptEntries) {
      // The shared reset prefix ends before the first interrupt. Only instructions enter its instruction hash.
      assert.equal(prefix.copy().digest('hex'), original.completedInstructionSha256);
      let entries = 0;
      for (const line of before.toString().matchAll(/[^\n]+\n/g)) {
        const type = JSON.parse(line[0]).eventType;
        if (type === 'instruction') completed.update(line[0]);
        else { assert.equal(type,'interrupt-entry'); entries++; }
      }
      assert.equal(entries,result.interruptEntries);
    } else completed.update(before);
    assert.equal(completed.digest('hex'), result.completedInstructionSha256);
  }
  const joint = finalLine(old);
  assert.deepEqual(lines(joint.diagnostic)[0].before, prior.firstBlockingEvent.stateBefore);
  assert.deepEqual(now.subarray(0, joint.before.length), joint.before);
  return now.subarray(joint.before.length);
}

export { compareStored, fileHash, finalLine, json, lines, read, sha };
