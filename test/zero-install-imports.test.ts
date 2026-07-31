import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkZeroInstallImports } from '../scripts/zero-install/check-imports.ts';

async function withFixture(
  sources: Record<string, string>,
  check: (diagnostics: ReturnType<typeof checkZeroInstallImports>) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lab-02-zero-install-'));
  try {
    const scripts = join(root, 'scripts');
    await Promise.all(
      ['api', 'github', 'shared'].map((zone) => mkdir(join(scripts, zone), { recursive: true })),
    );
    for (const [path, source] of Object.entries(sources)) {
      const target = join(scripts, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, source, 'utf8');
    }
    check(checkZeroInstallImports(scripts));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test('accepts every allowed zero-install zone direction and declaration-only package type', async () => {
  await withFixture(
    {
      'api/v1/entry.ts':
        "import { local } from './local.ts';\nimport { shared } from '../../shared/value.ts';\nimport type { Context } from '@actions/github';\nexport const apiValue = (_context: Context) => `${local}:${shared}`;\n",
      'api/v1/local.ts': "export const local = 'api';\n",
      'github/handler.ts':
        "import { local } from './local.ts';\nimport { shared } from '../shared/value.ts';\nimport type { Context } from '@actions/github';\nexport default (_context: Context) => `${local}:${shared}`;\n",
      'github/local.ts': "export const local = 'github';\n",
      'shared/value.ts':
        "import { basename } from 'node:path';\nimport { suffix } from './suffix.ts';\nexport const shared = `${basename('/safe/value')}:${suffix}`;\n",
      'shared/suffix.ts': "export const suffix = 'shared';\n",
    },
    (diagnostics) => assert.deepEqual(diagnostics, []),
  );
});

for (const fixture of [
  {
    name: 'shared modules that reach into the GitHub zone',
    sources: {
      'github/target.ts': "export const value = 'github';\n",
      'shared/source.ts': "export { value } from '../github/target.ts';\n",
    },
  },
  {
    name: 'shared modules that reach into the API zone',
    sources: {
      'api/v1/target.ts': "export const value = 'api';\n",
      'shared/source.ts': "export { value } from '../api/v1/target.ts';\n",
    },
  },
  {
    name: 'GitHub modules that reach into the API zone',
    sources: {
      'api/v1/target.ts': "export const value = 'api';\n",
      'github/source.ts': "export { value } from '../api/v1/target.ts';\n",
    },
  },
  {
    name: 'API modules that reach into the GitHub zone',
    sources: {
      'api/v1/source.ts': "export { value } from '../../github/target.ts';\n",
      'github/target.ts': "export const value = 'github';\n",
    },
  },
]) {
  test(`rejects ${fixture.name}`, async () => {
    await withFixture(fixture.sources, (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'ZONE_ESCAPE');
    });
  });
}

test('rejects runtime package imports before execution', async () => {
  await withFixture(
    {
      'api/v1/entry.ts': "import github from '@actions/github';\nexport default github;\n",
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'RUNTIME_SPECIFIER');
      assert.equal(diagnostics[0]?.specifier, '@actions/github');
    },
  );
});

test('accepts only the structurally confined release package-set import', async () => {
  await withFixture(
    {
      'shared/release-publication/package-set.ts':
        "import { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst supportedWorkspacePackageApiPaths: readonly string[] = [\n  'scripts/api/v2/workspace-packages.ts',\n  'scripts/api/v1/workspace-packages.ts',\n];\nexport async function loadReleasePackageSet(\n  snapshotRoot: string,\n  expectedVersion: string,\n): Promise<unknown> {\n  void expectedVersion;\n  for (const relativeEntrypoint of supportedWorkspacePackageApiPaths) {\n    const selectedEntrypoint = join(snapshotRoot, relativeEntrypoint);\n    return import(pathToFileURL(selectedEntrypoint).href);\n  }\n  throw new Error('No supported API.');\n}\n",
    },
    (diagnostics) => assert.deepEqual(diagnostics, []),
  );
});

test('rejects the release package-set import outside its exact production function', async () => {
  await withFixture(
    {
      'shared/release-publication/package-set.ts':
        "import { pathToFileURL } from 'node:url';\nconst supportedWorkspacePackageApiPaths: readonly string[] = [\n  'scripts/api/v1/workspace-packages.ts',\n];\nexport async function loadSomethingElse(selectedEntrypoint: string): Promise<unknown> {\n  return import(pathToFileURL(selectedEntrypoint).href);\n}\n",
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'UNKNOWN_DYNAMIC_IMPORT');
    },
  );
});

test('rejects the release package-set import without a fixed supported-path table', async () => {
  await withFixture(
    {
      'shared/release-publication/package-set.ts':
        "import { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst otherPaths = ['scripts/api/v1/workspace-packages.ts'];\nexport async function loadReleasePackageSet(snapshotRoot: string, expectedVersion: string): Promise<unknown> {\n  void expectedVersion;\n  for (const relativeEntrypoint of otherPaths) {\n    const selectedEntrypoint = join(snapshotRoot, relativeEntrypoint);\n    return import(pathToFileURL(selectedEntrypoint).href);\n  }\n  throw new Error('No supported API.');\n}\n",
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'UNKNOWN_DYNAMIC_IMPORT');
    },
  );
});

test('rejects a selected entrypoint that is not derived from the supported-path table', async () => {
  await withFixture(
    {
      'shared/release-publication/package-set.ts':
        "import { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst supportedWorkspacePackageApiPaths: readonly string[] = [\n  'scripts/api/v1/workspace-packages.ts',\n];\nexport async function loadReleasePackageSet(snapshotRoot: string, expectedVersion: string): Promise<unknown> {\n  void expectedVersion;\n  for (const relativeEntrypoint of supportedWorkspacePackageApiPaths) {\n    void relativeEntrypoint;\n    const selectedEntrypoint = join(snapshotRoot, 'untrusted.ts');\n    return import(pathToFileURL(selectedEntrypoint).href);\n  }\n  throw new Error('No supported API.');\n}\n",
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'UNKNOWN_DYNAMIC_IMPORT');
    },
  );
});

for (const path of ['api/v1/source.ts', 'github/source.ts', 'shared/source.ts']) {
  test(`rejects a general computed import in ${path.split('/')[0]}`, async () => {
    await withFixture(
      {
        [path]:
          "const target = './target.ts';\nexport const load = async (): Promise<unknown> => import(target);\n",
        [join(path, '../target.ts')]: "export const value = 'target';\n",
      },
      (diagnostics) => {
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0]?.code, 'UNKNOWN_DYNAMIC_IMPORT');
      },
    );
  });
}

test('rejects top-level await in every zero-install zone', async () => {
  await withFixture(
    {
      'api/v1/entry.ts': 'await Promise.resolve();\nexport const api = true;\n',
      'github/handler.ts': 'await Promise.resolve();\nexport default () => undefined;\n',
      'shared/value.ts': 'await Promise.resolve();\nexport const shared = true;\n',
    },
    (diagnostics) => {
      assert.deepEqual(
        diagnostics.map(({ code }) => code),
        ['TOP_LEVEL_AWAIT', 'TOP_LEVEL_AWAIT', 'TOP_LEVEL_AWAIT'],
      );
    },
  );
});
