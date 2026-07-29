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
    await Promise.all([
      mkdir(join(scripts, 'shared'), { recursive: true }),
      mkdir(join(scripts, 'github'), { recursive: true }),
    ]);
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

test('accepts the closed Node, shared, and declaration-only type graph', async () => {
  await withFixture(
    {
      'github/handler.ts':
        "import { value } from '../shared/value.ts';\nimport type { Context } from '@actions/github';\nexport default (_context: Context) => value;\n",
      'shared/value.ts':
        "import { basename } from 'node:path';\nexport const value = basename('/safe/value');\n",
    },
    (diagnostics) => assert.deepEqual(diagnostics, []),
  );
});

test('rejects runtime package imports before execution', async () => {
  await withFixture(
    {
      'github/handler.ts': "import github from '@actions/github';\nexport default github;\n",
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'RUNTIME_SPECIFIER');
      assert.equal(diagnostics[0]?.specifier, '@actions/github');
    },
  );
});

test('rejects shared modules that reach into the GitHub zone', async () => {
  await withFixture(
    {
      'github/value.ts': "export const value = 'unsafe';\n",
      'shared/value.ts': "export { value } from '../github/value.ts';\n",
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'ZONE_ESCAPE');
    },
  );
});

test('rejects top-level await that breaks the github-script require bridge', async () => {
  await withFixture(
    {
      'github/handler.ts': 'await Promise.resolve();\nexport default () => undefined;\n',
    },
    (diagnostics) => {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.code, 'TOP_LEVEL_AWAIT');
    },
  );
});
