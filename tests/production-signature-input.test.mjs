import assert from 'node:assert/strict';
import test from 'node:test';
import { productionSignatureInput } from '../scripts/production-signature-input.mjs';

test('production signature input keeps every byte unknown in the ordinary reset profiles', () => {
  assert.equal(productionSignatureInput(false), null);
  const input = productionSignatureInput(true);
  assert.deepEqual(input, { bytes: new Map(), report: { provenance: 'unknown' } });
  input.bytes.set(0x20, 0);
  assert.equal(productionSignatureInput(true).bytes.size, 0);
});

test('production signature input labels the single supplied ADCACAL0 byte as synthetic', () => {
  for (let value = 0; value <= 0xff; value++) {
    const input = productionSignatureInput(true, '0x' + value.toString(16).toUpperCase().padStart(2, '0'));
    assert.deepEqual([...input.bytes], [[0x20, value]]);
    assert.deepEqual(input.report, { provenance: 'synthetic', suppliedBytes: [{ name: 'ADCACAL0', offset: 0x20, value }] });
  }
});

test('production signature input rejects ambiguous or out-of-range values and disabled calibration reads', () => {
  for (const value of [null, 90, '90', '0x5', '0x100', '0xGG', '0x5A 0x00', '']) {
    assert.throws(() => productionSignatureInput(true, value), /one hex byte/);
  }
  assert.throws(() => productionSignatureInput(false, '0x5A'), /requires mapped/);
});
