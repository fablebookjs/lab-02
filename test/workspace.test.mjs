import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { formatSummary, total } from '@fablebook/lab-02-addon';
import { add } from '@fablebook/lab-02-core';

import { listPublicPackages, repositoryRoot } from '../scripts/list-public-packages.mjs';

const packages = await listPublicPackages();
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));

test('the complete public workspace set is discovered in stable order', () => {
  assert.deepEqual(
    packages.map(({ name }) => name),
    ['@fablebook/lab-02-addon', '@fablebook/lab-02-core']
  );
});

test('all public packages and internal dependencies use the lockstep version', () => {
  for (const pkg of packages) {
    assert.equal(pkg.version, rootManifest.version, `${pkg.name} diverged from the root version`);
  }

  const addon = packages.find(({ name }) => name === '@fablebook/lab-02-addon');
  assert.equal(
    addon.manifest.dependencies['@fablebook/lab-02-core'],
    rootManifest.version,
    'the addon-to-core dependency must be exact and lockstep'
  );
});

test('the compiled addon exercises the compiled core package', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(formatSummary(' Demo ', [2, 3]), 'demo:5');
});
