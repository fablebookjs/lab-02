import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  reconcilePublicationPlan,
} from '../scripts/shared/package-publication/publication.ts';
import {
  type PublicationManifest,
  validatePublicationManifest,
} from '../scripts/shared/release-publication/publication.ts';

const snapshotOid = '3'.repeat(40);
const integrityA = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const integrityB = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;

const manifestFixture = () => ({
  channel: 'v-1.0',
  line: 'v1.0',
  packages: [
    {
      filename: 'example-addon-1.0.0.tgz',
      integrity: integrityA,
      name: '@example/addon',
    },
    {
      filename: 'plain-core-1.0.0.tgz',
      integrity: integrityB,
      name: 'plain-core',
    },
  ],
  proposalOid: '2'.repeat(40),
  pullRequest: 42,
  releaseBody: '# Example 1.0.0\n',
  repository: 'fablebookjs/lab-02',
  schema: 3,
  snapshotOid,
  sourceOid: '1'.repeat(40),
  version: '1.0.0',
});

const withArtifacts = async (
  exercise: (tarballs: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-02-publication-plan-'));
  const tarballs = join(root, 'tarballs');
  try {
    await mkdir(tarballs);
    await Promise.all([
      writeFile(join(tarballs, 'example-addon-1.0.0.tgz'), 'addon', 'utf8'),
      writeFile(join(tarballs, 'plain-core-1.0.0.tgz'), 'core', 'utf8'),
    ]);
    await exercise(tarballs);
  } finally {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
};

const validatedManifest = (
  tarballs: string,
  input: unknown = manifestFixture(),
): Promise<PublicationManifest> =>
  validatePublicationManifest(input, tarballs, {
    repository: 'fablebookjs/lab-02',
    snapshotOid,
    version: '1.0.0',
  });

test('schema 3 accepts safe npm names and binds regular tarballs without a package prefix', async () => {
  await withArtifacts(async (tarballs) => {
    assert.deepEqual(await validatedManifest(tarballs), manifestFixture());
  });
});

test('schema 3 rejects unknown data, wrong bindings, empty plans, and duplicate packages', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = manifestFixture();
    await assert.rejects(
      validatedManifest(tarballs, { ...manifest, unexpected: true }),
      /outside the expected schema-3 binding/,
    );
    await assert.rejects(
      validatedManifest(tarballs, { ...manifest, schema: 2 }),
      /outside the expected schema-3 binding/,
    );
    await assert.rejects(
      validatedManifest(tarballs, { ...manifest, snapshotOid: '4'.repeat(40) }),
      /outside the expected schema-3 binding/,
    );
    await assert.rejects(
      validatedManifest(tarballs, { ...manifest, packages: [] }),
      /outside the expected schema-3 binding/,
    );
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [manifest.packages[0], manifest.packages[0]],
      }),
      /must be unique/,
    );
    const first = manifest.packages[0];
    const second = manifest.packages[1];
    assert.ok(first && second);
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [first, { ...second, filename: first.filename }],
      }),
      /must be unique/,
    );
  });
});

test('schema 3 rejects unsafe names, unsafe paths, invalid integrity, and missing tarballs', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = manifestFixture();
    const first = manifest.packages[0];
    assert.ok(first);
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [{ ...first, name: '@Example/Uppercase' }],
      }),
      /Unsafe npm package name/,
    );
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [{ ...first, filename: '../escape.tgz' }],
      }),
      /Unsafe publication tarball filename/,
    );
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [{ ...first, integrity: 'sha512-not-base64' }],
      }),
      /Invalid npm SHA-512 integrity/,
    );
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [{ ...first, version: '1.0.0' }],
      }),
      /outside schema 3/,
    );
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [{ ...first, filename: 'missing-1.0.0.tgz' }],
      }),
      /missing or not a regular file/,
    );
    await mkdir(join(tarballs, 'directory-1.0.0.tgz'));
    await assert.rejects(
      validatedManifest(tarballs, {
        ...manifest,
        packages: [{ ...first, filename: 'directory-1.0.0.tgz' }],
      }),
      /missing or not a regular file/,
    );
  });
});

test('matching registry integrity completes without publishing', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = await validatedManifest(tarballs);
    let observations = 0;
    let publications = 0;
    await reconcilePublicationPlan(manifest, {
      observeIntegrity: async (pkg) => {
        observations += 1;
        return pkg.integrity;
      },
      publish: async () => {
        publications += 1;
      },
      wait: async () => undefined,
    });
    assert.equal(observations, 2);
    assert.equal(publications, 0);
  });
});

test('a successful publish completes without a registry readback', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = await validatedManifest(tarballs);
    let observations = 0;
    let publications = 0;
    await reconcilePublicationPlan(manifest, {
      observeIntegrity: async () => {
        observations += 1;
        return null;
      },
      publish: async () => {
        publications += 1;
      },
      wait: async () => undefined,
    });
    assert.equal(observations, 2);
    assert.equal(publications, 2);
  });
});

test('a conflicting registry integrity is permanent and prominent', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = await validatedManifest(tarballs);
    let publications = 0;
    await assert.rejects(
      reconcilePublicationPlan(manifest, {
        observeIntegrity: async (pkg) =>
          pkg.name === '@example/addon' ? integrityB : pkg.integrity,
        publish: async () => {
          publications += 1;
        },
        wait: async () => undefined,
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /@example\/addon@1\.0\.0/);
        assert.match(error.message, new RegExp(integrityA.replaceAll('+', '\\+')));
        assert.match(error.message, new RegExp(integrityB.replaceAll('+', '\\+')));
        return true;
      },
    );
    assert.equal(publications, 0);
  });
});

test('an ambiguous publish failure converges when the next query observes success', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = await validatedManifest(tarballs);
    const observations = new Map<string, number>();
    const waits: number[] = [];
    await reconcilePublicationPlan(manifest, {
      observeIntegrity: async (pkg) => {
        const count = (observations.get(pkg.name) ?? 0) + 1;
        observations.set(pkg.name, count);
        return count === 1 ? null : pkg.integrity;
      },
      publish: async () => {
        throw new Error('registry accepted the upload but lost the response');
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.deepEqual([...observations.values()], [2, 2]);
    assert.deepEqual(waits, [1_000, 1_000]);
  });
});

test('three-attempt exhaustion aggregates every unresolved package', async () => {
  await withArtifacts(async (tarballs) => {
    const manifest = await validatedManifest(tarballs);
    let publications = 0;
    const waits: number[] = [];
    await assert.rejects(
      reconcilePublicationPlan(manifest, {
        observeIntegrity: async () => null,
        publish: async (pkg) => {
          publications += 1;
          throw new Error(`temporary failure for ${pkg.name}`);
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.message, /@example\/addon@1\.0\.0 failed after three attempts/);
        assert.match(error.message, /plain-core@1\.0\.0 failed after three attempts/);
        return true;
      },
    );
    assert.equal(publications, 6);
    assert.deepEqual(waits, [1_000, 2_000, 1_000, 2_000]);
  });
});
