import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  loadReleasePackageSet,
  type ReleasePackage,
} from '../scripts/shared/release-publication/package-set.ts';
import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const execute = promisify(execFile);

const expectedPackages: readonly ReleasePackage[] = [
  {
    location: 'packages/addon',
    name: '@fablebook/lab-02-addon',
    version: '3.0.0',
  },
  {
    location: 'packages/core',
    name: '@fablebook/lab-02-core',
    version: '3.0.0',
  },
];

const packageManifest = (listPackages?: string): string =>
  JSON.stringify({
    name: 'package-set-fixture',
    private: true,
    scripts: listPackages === undefined ? {} : { 'list-packages': listPackages },
    type: 'module',
  });

const legacyScript = (packages: unknown): string =>
  `console.log(${JSON.stringify(JSON.stringify(packages))});\n`;

const nativeApi = (catalog: unknown): string =>
  `export async function listWorkspacePackages() {\n  return ${JSON.stringify(catalog)};\n}\n`;

const withSnapshot = async (
  sources: Readonly<Record<string, string>>,
  exercise: (snapshotRoot: string) => Promise<void>,
): Promise<void> => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'lab-02-package-set-'));
  try {
    for (const [relativePath, source] of Object.entries(sources)) {
      const target = join(snapshotRoot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }
    await exercise(snapshotRoot);
  } finally {
    await rm(snapshotRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
};

test('native v1 projects, validates, filters, and orders the release package set', async () => {
  await withSnapshot(
    {
      'package.json': packageManifest(),
      'scripts/api/v1/workspace-packages.ts': nativeApi([
        {
          location: 'packages/core',
          name: '@fablebook/lab-02-core',
          version: '3.0.0',
          private: false,
          futureOptionalProperty: 'ignored',
        },
        {
          location: 'packages/internal',
          name: '@fablebook/lab-02-internal',
          version: '0.0.0',
          private: true,
        },
        {
          location: 'packages/addon',
          name: '@fablebook/lab-02-addon',
          version: '3.0.0',
          private: false,
        },
      ]),
    },
    async (snapshotRoot) => {
      assert.deepEqual(await loadReleasePackageSet(snapshotRoot, '3.0.0'), expectedPackages);
    },
  );
});

test('the current repository snapshot exercises its native v1 interface through the loader', async () => {
  const rootManifest: unknown = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.ok(rootManifest !== null && typeof rootManifest === 'object');
  assert.ok('version' in rootManifest && typeof rootManifest.version === 'string');

  assert.deepEqual(await loadReleasePackageSet(repositoryRoot, rootManifest.version), [
    {
      location: 'packages/addon',
      name: '@fablebook/lab-02-addon',
      version: rootManifest.version,
    },
    {
      location: 'packages/core',
      name: '@fablebook/lab-02-core',
      version: rootManifest.version,
    },
  ]);
});

test('the newest supported native source wins over an available legacy source', async () => {
  await withSnapshot(
    {
      'package.json': packageManifest('node scripts/list-packages.ts'),
      'scripts/api/v1/workspace-packages.ts': nativeApi([
        {
          location: 'packages/native',
          name: 'native-package',
          version: '3.0.0',
          private: false,
        },
      ]),
      'scripts/list-packages.ts': legacyScript([
        { location: 'packages/legacy', name: 'legacy-package', version: '3.0.0' },
      ]),
    },
    async (snapshotRoot) => {
      assert.deepEqual(await loadReleasePackageSet(snapshotRoot, '3.0.0'), [
        {
          location: 'packages/native',
          name: 'native-package',
          version: '3.0.0',
        },
      ]);
    },
  );
});

test('a missing supported native version descends to the legacy adapter', async () => {
  await withSnapshot(
    {
      'package.json': packageManifest('node scripts/list-packages.ts'),
      'scripts/list-packages.ts': legacyScript(expectedPackages),
    },
    async (snapshotRoot) => {
      assert.deepEqual(await loadReleasePackageSet(snapshotRoot, '3.0.0'), expectedPackages);
    },
  );
});

test('the legacy adapter does not pass ambient package credentials to tagged code', async () => {
  const previousToken = process.env['NODE_AUTH_TOKEN'];
  process.env['NODE_AUTH_TOKEN'] = 'fixture-token';
  try {
    await withSnapshot(
      {
        'package.json': packageManifest('node scripts/list-packages.ts'),
        'scripts/list-packages.ts':
          "if (process.env.NODE_AUTH_TOKEN) throw new Error('credential leaked');\n" +
          legacyScript(expectedPackages),
      },
      async (snapshotRoot) => {
        assert.deepEqual(await loadReleasePackageSet(snapshotRoot, '3.0.0'), expectedPackages);
      },
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env['NODE_AUTH_TOKEN'];
    } else {
      process.env['NODE_AUTH_TOKEN'] = previousToken;
    }
  }
});

test('unsupported newer API versions do not change legacy capability selection', async () => {
  await withSnapshot(
    {
      'package.json': packageManifest('node scripts/list-packages.ts'),
      'scripts/api/v2/workspace-packages.ts': "throw new Error('unsupported v2 must not load');\n",
      'scripts/list-packages.ts': legacyScript(expectedPackages),
    },
    async (snapshotRoot) => {
      assert.deepEqual(await loadReleasePackageSet(snapshotRoot, '3.0.0'), expectedPackages);
    },
  );
});

test('native and legacy sources normalize to the same release package set', async () => {
  let nativePackages: readonly ReleasePackage[] | undefined;
  await withSnapshot(
    {
      'package.json': packageManifest(),
      'scripts/api/v1/workspace-packages.ts': nativeApi([
        { ...expectedPackages[1], private: false },
        {
          location: 'packages/private',
          name: 'private-package',
          version: '3.0.0',
          private: true,
        },
        { ...expectedPackages[0], private: false },
      ]),
    },
    async (snapshotRoot) => {
      nativePackages = await loadReleasePackageSet(snapshotRoot, '3.0.0');
    },
  );

  await withSnapshot(
    {
      'package.json': packageManifest('node scripts/list-packages.ts'),
      'scripts/list-packages.ts': legacyScript([...expectedPackages].reverse()),
    },
    async (snapshotRoot) => {
      assert.deepEqual(await loadReleasePackageSet(snapshotRoot, '3.0.0'), nativePackages);
    },
  );
});

test('a broken native source never falls through to a valid legacy adapter', async () => {
  await withSnapshot(
    {
      'package.json': packageManifest('node scripts/list-packages.ts'),
      'scripts/api/v1/workspace-packages.ts': "throw new Error('broken native fixture');\n",
      'scripts/list-packages.ts': legacyScript(expectedPackages),
    },
    async (snapshotRoot) => {
      await assert.rejects(
        loadReleasePackageSet(snapshotRoot, '3.0.0'),
        /broken native fixture/,
      );
    },
  );
});

test('a non-regular native source is fatal rather than a fallback opportunity', async () => {
  await withSnapshot(
    {
      'package.json': packageManifest('node scripts/list-packages.ts'),
      'scripts/list-packages.ts': legacyScript(expectedPackages),
    },
    async (snapshotRoot) => {
      await mkdir(join(snapshotRoot, 'scripts/api/v1/workspace-packages.ts'), {
        recursive: true,
      });
      await assert.rejects(
        loadReleasePackageSet(snapshotRoot, '3.0.0'),
        /is not a regular file/,
      );
    },
  );
});

test('a snapshot without a supported native or legacy source is explicitly unsupported', async () => {
  await withSnapshot(
    { 'package.json': packageManifest() },
    async (snapshotRoot) => {
      await assert.rejects(
        loadReleasePackageSet(snapshotRoot, '3.0.0'),
        /Unsupported release 3\.0\.0.*no supported workspace-packages API or legacy list-packages script/,
      );
    },
  );
});

for (const {
  catalog,
  name,
  pattern,
} of [
  {
    name: 'a non-array catalog',
    catalog: {},
    pattern: /catalog must be an array/,
  },
  {
    name: 'a private package with missing required fields',
    catalog: [{ location: 'packages/private', private: true, version: '3.0.0' }],
    pattern: /name must be a nonempty string/,
  },
  {
    name: 'invalid private metadata',
    catalog: [
      {
        location: 'packages/core',
        name: '@fablebook/lab-02-core',
        version: '3.0.0',
        private: 'false',
      },
    ],
    pattern: /private must be a boolean/,
  },
  {
    name: 'duplicate catalog names',
    catalog: [
      {
        location: 'packages/a',
        name: 'duplicate',
        version: '3.0.0',
        private: true,
      },
      {
        location: 'packages/b',
        name: 'duplicate',
        version: '3.0.0',
        private: false,
      },
    ],
    pattern: /Duplicate workspace package name/,
  },
  {
    name: 'a package outside the expected version',
    catalog: [
      {
        location: 'packages/core',
        name: '@fablebook/lab-02-core',
        version: '2.0.0',
        private: false,
      },
    ],
    pattern: /does not use expected version 3\.0\.0/,
  },
  {
    name: 'an empty public projection',
    catalog: [
      {
        location: 'packages/private',
        name: 'private-package',
        version: '3.0.0',
        private: true,
      },
    ],
    pattern: /must not be empty/,
  },
]) {
  test(`native validation rejects ${name}`, async () => {
    await withSnapshot(
      {
        'package.json': packageManifest(),
        'scripts/api/v1/workspace-packages.ts': nativeApi(catalog),
      },
      async (snapshotRoot) => {
        await assert.rejects(loadReleasePackageSet(snapshotRoot, '3.0.0'), pattern);
      },
    );
  });
}

for (const {
  name,
  packages,
  pattern,
} of [
  {
    name: 'a non-array result',
    packages: {},
    pattern: /Legacy package set must be an array/,
  },
  {
    name: 'a non-canonical location',
    packages: [{ location: '../core', name: 'core', version: '3.0.0' }],
    pattern: /Invalid package location/,
  },
  {
    name: 'duplicate locations',
    packages: [
      { location: 'packages/core', name: 'core-a', version: '3.0.0' },
      { location: 'packages/core', name: 'core-b', version: '3.0.0' },
    ],
    pattern: /Duplicate release package location/,
  },
  {
    name: 'a package outside the expected version',
    packages: [{ location: 'packages/core', name: 'core', version: '2.0.0' }],
    pattern: /does not use expected version 3\.0\.0/,
  },
]) {
  test(`legacy validation rejects ${name}`, async () => {
    await withSnapshot(
      {
        'package.json': packageManifest('node scripts/list-packages.ts'),
        'scripts/list-packages.ts': legacyScript(packages),
      },
      async (snapshotRoot) => {
        await assert.rejects(loadReleasePackageSet(snapshotRoot, '3.0.0'), pattern);
      },
    );
  });
}

const immutableTags: ReadonlyArray<readonly [tag: string, version: string]> = [
  ['v1.0.0', '1.0.0'],
  ['v2.0.0', '2.0.0'],
  ['v2.0.1', '2.0.1'],
  ['v2.0.2', '2.0.2'],
  ['v2.0.3', '2.0.3'],
  ['v2.0.4', '2.0.4'],
  ['v2.0.5', '2.0.5'],
  ['v2.0.6', '2.0.6'],
  ['v2.1.0', '2.1.0'],
  ['v3.0.0', '3.0.0'],
];

test(
  'the legacy adapter loads every existing immutable tag from v1.0.0 through v3.0.0',
  { timeout: 120_000 },
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'lab-02-package-set-tags-'));
    const snapshotRoot = join(temporaryRoot, 'snapshot');
    try {
      await execute('git', ['clone', '--quiet', '--no-checkout', repositoryRoot, snapshotRoot]);
      for (const [tag, version] of immutableTags) {
        await execute(
          'git',
          ['-C', snapshotRoot, 'checkout', '--quiet', '--force', '--detach', tag],
          { maxBuffer: 1024 * 1024 },
        );
        assert.deepEqual(
          await loadReleasePackageSet(snapshotRoot, version),
          expectedPackages.map((pkg) => ({ ...pkg, version })),
          tag,
        );
      }
    } finally {
      await rm(temporaryRoot, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    }
  },
);
