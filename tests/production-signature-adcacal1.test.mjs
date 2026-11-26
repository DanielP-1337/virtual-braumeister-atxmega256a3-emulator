import test from 'node:test';
import assert from 'node:assert/strict';
import { productionSignatureInput } from '../scripts/production-signature-input.mjs';

test('ADCACAL1 input preserves both individual bytes and their source offsets', () => {
  for (let high = 0; high < 256; high++) {
    const input = productionSignatureInput(true, '0x5A', '0x' + high.toString(16).padStart(2, '0'));
    assert.deepEqual([...input.bytes], [[0x20, 0x5a], [0x21, high]]);
    assert.deepEqual(input.report, { provenance: 'synthetic', suppliedBytes: [
      { name: 'ADCACAL0', offset: 0x20, value: 0x5a }, { name: 'ADCACAL1', offset: 0x21, value: high },
    ] });
  }
});

test('ADCACAL1 input leaves the other factory byte unknown unless supplied', () => {
  const highOnly = productionSignatureInput(true, undefined, '0x03');
  assert.deepEqual([...highOnly.bytes], [[0x21, 3]]);
  assert.deepEqual(highOnly.report.suppliedBytes, [{ name: 'ADCACAL1', offset: 0x21, value: 3 }]);
  const lowOnly = productionSignatureInput(true, '0x5A');
  assert.equal(lowOnly.bytes.has(0x21), false);
  assert.deepEqual(productionSignatureInput(true).report, { provenance: 'unknown' });
});

test('ADCACAL1 input rejects malformed bytes and inactive program-memory mapping', () => {
  for (const input of [null, 3, '03', '0x3', '0x100', '0xXX']) {
    assert.throws(() => productionSignatureInput(true, '0x5A', input), /--synthetic-adcacal1 as one hex byte/);
  }
  assert.throws(() => productionSignatureInput(false, undefined, '0x03'), /--synthetic-adcacal1 requires mapped/);
});
