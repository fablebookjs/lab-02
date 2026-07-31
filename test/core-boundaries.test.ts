import assert from 'node:assert/strict';
import test from 'node:test';

import { add, normalizeLabel } from '@fablebook/lab-02-core';

test('addition preserves zero as the neutral operand', () => {
  assert.equal(add(7, 0), 7);
  assert.equal(add(0, -7), -7);
});

test('normalizing a whitespace-only label produces an empty label', () => {
  assert.equal(normalizeLabel(' \t\n '), '');
});
