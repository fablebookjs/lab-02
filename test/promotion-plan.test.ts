import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPromotionManifest,
  promoteSealedPackageSet,
  validatePromotionManifest,
} from '../scripts/shared/release-publication/promotion.ts';

const snapshotOid = '1'.repeat(40);
const binding = {
  repository: 'fablebookjs/lab-02',
  snapshotOid,
  version: '3.0.0',
};
const validManifest = () => ({
  packages: ['independent-package', '@scope/other-package'],
  repository: 'fablebookjs/lab-02',
  schema: 1,
  snapshotOid,
  version: '3.0.0',
});

test('the promotion manifest is exact, ordered, and not restricted to Lab-02 names', () => {
  assert.deepEqual(validatePromotionManifest(validManifest(), binding), validManifest());
  assert.deepEqual(
    createPromotionManifest({
      packages: ['independent-package', '@scope/other-package'],
      snapshotOid,
      version: '3.0.0',
    }),
    validManifest(),
  );
});

for (const {
  name,
  value,
  pattern,
} of [
  {
    name: 'an unknown field',
    value: { ...validManifest(), location: 'packages/core' },
    pattern: /exactly the schema-1 fields/,
  },
  {
    name: 'a missing field',
    value: {
      packages: ['package'],
      repository: 'fablebookjs/lab-02',
      schema: 1,
      snapshotOid,
    },
    pattern: /exactly the schema-1 fields/,
  },
  {
    name: 'the wrong schema',
    value: { ...validManifest(), schema: 2 },
    pattern: /schema 1/,
  },
  {
    name: 'the wrong repository',
    value: { ...validManifest(), repository: 'fablebookjs/other' },
    pattern: /expected repository/,
  },
  {
    name: 'the wrong snapshot',
    value: { ...validManifest(), snapshotOid: '2'.repeat(40) },
    pattern: /expected release binding/,
  },
  {
    name: 'the wrong version',
    value: { ...validManifest(), version: '3.0.1' },
    pattern: /expected release binding/,
  },
  {
    name: 'an invalid snapshot',
    value: { ...validManifest(), snapshotOid: 'main' },
    pattern: /full commit OID/,
  },
  {
    name: 'an empty plan',
    value: { ...validManifest(), packages: [] },
    pattern: /nonempty array/,
  },
  {
    name: 'duplicate names',
    value: { ...validManifest(), packages: ['package', 'package'] },
    pattern: /must be unique/,
  },
  {
    name: 'an option-shaped name',
    value: { ...validManifest(), packages: ['--registry'] },
    pattern: /syntactically safe npm name/,
  },
  {
    name: 'an unsafe scoped name',
    value: { ...validManifest(), packages: ['@scope/../package'] },
    pattern: /syntactically safe npm name/,
  },
  {
    name: 'a non-string name',
    value: { ...validManifest(), packages: [{ name: 'package' }] },
    pattern: /syntactically safe npm name/,
  },
]) {
  test(`promotion validation rejects ${name}`, () => {
    assert.throws(() => validatePromotionManifest(value, binding), pattern);
  });
}

test('a transient dist-tag failure succeeds within three attempts', async () => {
  const manifest = createPromotionManifest({
    packages: ['package'],
    snapshotOid,
    version: '3.0.0',
  });
  const waits: number[] = [];
  let attempts = 0;

  await promoteSealedPackageSet(manifest, {
    addLatest: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`transient ${attempts}`);
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test('three-attempt failures are aggregated after every package is attempted', async () => {
  const manifest = createPromotionManifest({
    packages: ['first-package', 'second-package', 'successful-package'],
    snapshotOid,
    version: '3.0.0',
  });
  const attempts: string[] = [];
  const waits: number[] = [];

  await assert.rejects(
    promoteSealedPackageSet(manifest, {
      addLatest: async (name) => {
        attempts.push(name);
        if (name !== 'successful-package') {
          throw new Error(`${name} unavailable`);
        }
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exhausted retries for 2 package/);
      assert.match(error.message, /first-package@3\.0\.0: first-package unavailable/);
      assert.match(error.message, /second-package@3\.0\.0: second-package unavailable/);
      return true;
    },
  );

  assert.deepEqual(attempts, [
    'first-package',
    'first-package',
    'first-package',
    'second-package',
    'second-package',
    'second-package',
    'successful-package',
  ]);
  assert.deepEqual(waits, [1_000, 2_000, 1_000, 2_000]);
});

test('a rerun safely repeats every sealed dist-tag update', async () => {
  const manifest = createPromotionManifest({
    packages: ['first-package', 'second-package'],
    snapshotOid,
    version: '3.0.0',
  });
  const calls: string[] = [];
  const operations = {
    addLatest: async (name: string, version: string) => {
      calls.push(`${name}@${version}`);
    },
    wait: async () => {},
  };

  await promoteSealedPackageSet(manifest, operations);
  await promoteSealedPackageSet(manifest, operations);

  assert.deepEqual(calls, [
    'first-package@3.0.0',
    'second-package@3.0.0',
    'first-package@3.0.0',
    'second-package@3.0.0',
  ]);
});
