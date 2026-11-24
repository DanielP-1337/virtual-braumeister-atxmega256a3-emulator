import assert from 'node:assert/strict';
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';

// Keep only a short run of JSONL records in memory. The replay compares the actual recorded bytes.
export function withNvmAccessLog(path, recording, execute) {
  const fd = openSync(path, recording ? 'wx' : 'r');
  let chunk = '', count = 0, position = 0;
  function flush() {
    if (!chunk.length) return;
    const bytes = Buffer.from(chunk, 'utf8');
    if (recording) {
      writeFileSync(fd, bytes);
    } else {
      const recorded = Buffer.allocUnsafe(bytes.length);
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(fd, recorded, offset, recorded.length - offset, null);
        assert.ok(n > 0, 'Truncated NVM access log at byte ' + (position + offset));
        offset += n;
      }
      assert.ok(recorded.equals(bytes), 'NVM access replay differs in block at byte ' + position);
    }
    position += bytes.length;
    chunk = '';
  }
  function onAccess(event) {
    chunk += JSON.stringify(event) + '\n';
    count++;
    if (chunk.length >= 65536) flush();
  }
  try {
    const result = execute(onAccess);
    flush();
    if (!recording) assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, null), 0, 'Extra recorded NVM accesses');
    return { result, count };
  } finally {
    closeSync(fd);
  }
}
