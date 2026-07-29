import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  average,
  count,
  formatAverageSummary,
  formatCountSummary,
  formatSummary,
  total,
} from '@fablebook/lab-02-addon';
import {
  add,
  multiply,
  normalizeLabel,
  normalizeLabels,
} from '@fablebook/lab-02-core';

import {
  listPublicPackages,
  listWorkspacePackages,
  repositoryRoot,
} from '../scripts/shared/workspace/packages.ts';

const packages = await listPublicPackages();
const rootManifest: unknown = JSON.parse(
  await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
);
assert.ok(rootManifest !== null && typeof rootManifest === 'object');
assert.ok('version' in rootManifest && typeof rootManifest.version === 'string');
const rootVersion = rootManifest.version;

test('the complete public workspace set is discovered in stable order', () => {
  assert.deepEqual(
    packages.map(({ name }) => name),
    ['@fablebook/lab-02-addon', '@fablebook/lab-02-core']
  );
});

test('the workspace catalog includes private packages in location order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-02-workspaces-'));
  try {
    await Promise.all([
      mkdir(join(root, 'packages/a-private'), { recursive: true }),
      mkdir(join(root, 'packages/z-public'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, 'package.json'),
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      ),
      writeFile(
        join(root, 'packages/a-private/package.json'),
        JSON.stringify({ name: 'private-tooling', private: true, version: '1.0.0' }),
      ),
      writeFile(
        join(root, 'packages/z-public/package.json'),
        JSON.stringify({ name: '@fablebook/lab-02-public', version: '1.0.0' }),
      ),
    ]);

    const catalog = await listWorkspacePackages(root);
    assert.deepEqual(
      catalog.map(({ location, name, private: isPrivate, version }) => ({
        location,
        name,
        version,
        private: isPrivate,
      })),
      [
        {
          location: 'packages/a-private',
          name: 'private-tooling',
          version: '1.0.0',
          private: true,
        },
        {
          location: 'packages/z-public',
          name: '@fablebook/lab-02-public',
          version: '1.0.0',
          private: false,
        },
      ],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('all public packages and internal dependencies use the lockstep version', () => {
  for (const pkg of packages) {
    assert.equal(pkg.version, rootVersion, `${pkg.name} diverged from the root version`);
  }

  const addon = packages.find(({ name }) => name === '@fablebook/lab-02-addon');
  assert.ok(addon);
  const dependencies = addon.manifest['dependencies'];
  assert.ok(dependencies !== null && typeof dependencies === 'object');
  assert.ok('@fablebook/lab-02-core' in dependencies);
  assert.equal(
    dependencies['@fablebook/lab-02-core'],
    rootVersion,
    'the addon-to-core dependency must be exact and lockstep'
  );
});

test('the compiled addon exercises the compiled core package', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(multiply(2, 3), 6);
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(formatSummary(' Demo ', [2, 3]), 'demo:5');
});

test('the core label API accepts locale options', () => {
  assert.equal(normalizeLabel(' I ', { locale: 'tr' }), 'ı');
});

test('summary formatting passes its locale to label normalization', () => {
  assert.equal(formatSummary(' I ', [2, 3], { locale: 'tr' }), 'ı:5');
});

test('average summaries handle populated and empty values', () => {
  assert.equal(average([2, 4]), 3);
  assert.equal(average([]), undefined);
  assert.equal(formatAverageSummary(' Demo ', [2, 4]), 'demo:3');
  assert.equal(formatAverageSummary(' Demo ', []), 'demo:n/a');
});

test('count summaries report the number of values', () => {
  assert.equal(count([2, 4, 8]), 3);
  assert.equal(count([]), 0);
  assert.equal(formatCountSummary(' Items ', [2, 4, 8]), 'items:3');
  assert.equal(formatCountSummary(' I ', [2, 4, 8], { locale: 'tr' }), 'ı:3');
});

test('label collections share one locale-aware normalization pass', () => {
  assert.deepEqual(normalizeLabels([' I ', ' İ '], { locale: 'tr' }), ['ı', 'i']);
});
