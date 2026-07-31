import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { preparePromotion } from '../scripts/github/release-publication/promotion-controller.ts';

const execute = promisify(execFile);
const version = '3.0.0';

process.env['GITHUB_REPOSITORY'] = 'fablebookjs/lab-02';
process.env['GITHUB_REF'] = 'refs/heads/main';

const withSnapshot = async (
  sources: Readonly<Record<string, string>>,
  exercise: (snapshot: string, snapshotOid: string, manifest: string) => Promise<void>,
): Promise<void> => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'lab-02-promotion-preparation-'));
  const snapshot = join(temporaryRoot, 'snapshot');
  const manifest = join(temporaryRoot, 'output', 'promotion.json');
  try {
    await mkdir(snapshot);
    for (const [relativePath, source] of Object.entries(sources)) {
      const target = join(snapshot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }
    await execute('git', ['init', '-b', 'main'], { cwd: snapshot });
    await execute('git', ['config', 'user.name', 'Lab 02 test'], { cwd: snapshot });
    await execute('git', ['config', 'user.email', 'lab-02-test@example.com'], {
      cwd: snapshot,
    });
    await execute('git', ['add', '.'], { cwd: snapshot });
    await execute('git', ['commit', '-m', 'fixture'], { cwd: snapshot });
    const snapshotOid = (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: snapshot })
    ).stdout.trim();
    await exercise(snapshot, snapshotOid, manifest);
  } finally {
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
};

const nativeSources = {
  'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
  'scripts/api/v1/workspace-packages.ts': `
export async function listWorkspacePackages() {
  return [
    {
      location: 'packages/second',
      name: 'second-package',
      version: '${version}',
      private: false,
    },
    {
      location: 'packages/private',
      name: 'private-package',
      version: '0.0.0',
      private: true,
    },
    {
      location: 'packages/first',
      name: 'first-package',
      version: '${version}',
      private: false,
    },
  ];
}
`,
};

const legacySources = {
  'package.json': JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: { 'list-packages': 'node scripts/list-packages.ts' },
    type: 'module',
  }),
  'scripts/list-packages.ts': `
console.log(JSON.stringify([
  { location: 'packages/second', name: 'second-package', version: '${version}' },
  { location: 'packages/first', name: 'first-package', version: '${version}' },
]));
`,
};

const sourceCases: ReadonlyArray<
  readonly [name: string, sources: Readonly<Record<string, string>>]
> = [
  ['native', nativeSources],
  ['legacy', legacySources],
];

for (const [sourceName, sources] of sourceCases) {
  test(`${sourceName} package-set preparation writes the same ordered sealed plan`, async () => {
    await withSnapshot(sources, async (snapshot, snapshotOid, manifest) => {
      await preparePromotion({
        manifest,
        snapshot,
        'snapshot-oid': snapshotOid,
        version,
      });
      assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), {
        packages: ['first-package', 'second-package'],
        repository: 'fablebookjs/lab-02',
        schema: 1,
        snapshotOid,
        version,
      });
    });
  });
}

test('promotion preparation rejects unsupported snapshots', async () => {
  await withSnapshot(
    {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    },
    async (snapshot, snapshotOid, manifest) => {
      await assert.rejects(
        preparePromotion({
          manifest,
          snapshot,
          'snapshot-oid': snapshotOid,
          version,
        }),
        /Unsupported release 3\.0\.0/,
      );
    },
  );
});

test('promotion preparation is bound to the exact checked-out commit', async () => {
  await withSnapshot(nativeSources, async (snapshot, _snapshotOid, manifest) => {
    await assert.rejects(
      preparePromotion({
        manifest,
        snapshot,
        'snapshot-oid': '2'.repeat(40),
        version,
      }),
      /checked-out snapshot does not match promotion authority/,
    );
  });
});
