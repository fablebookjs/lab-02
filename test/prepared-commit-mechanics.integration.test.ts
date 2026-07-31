import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const execute = promisify(execFile);

const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) => execute(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });

const git = (args: string[], cwd: string) => run('git', args, cwd);

const copySeed = async (destination: string): Promise<void> => {
  await cp(repositoryRoot, destination, {
    filter: (source) => {
      const path = relative(repositoryRoot, source).split(sep);
      return !path.some((part) =>
        ['.cache', '.git', 'dist', 'node_modules'].includes(part),
      );
    },
    recursive: true,
  });
};

const importBundle = (
  repository: string,
  bundle: string,
  refs: readonly { name: string; oid: string }[],
) =>
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const mechanics = await import('./scripts/github/prepared-commit/mechanics.ts');",
        'await mechanics.importBundle(process.env.TEST_BUNDLE, JSON.parse(process.env.TEST_REFS));',
      ].join('\n'),
    ],
    repository,
    {
      ...process.env,
      TEST_BUNDLE: bundle,
      TEST_REFS: JSON.stringify(refs),
    },
  );

test('prepared bundle import accepts exactly the declared refs and rejects extras', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-prepared-bundle-test-'));
  const repository = join(temporaryRoot, 'repository');
  const exactBundle = join(temporaryRoot, 'exact.bundle');
  const extraBundle = join(temporaryRoot, 'extra.bundle');
  const expectedName = 'refs/release-pilot/artifact/expected';
  const extraName = 'refs/release-pilot/artifact/extra';
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'seed'], repository);
    const oid = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();

    await git(['update-ref', expectedName, oid], repository);
    await git(['bundle', 'create', exactBundle, expectedName], repository);
    await git(['update-ref', '-d', expectedName, oid], repository);
    await importBundle(repository, exactBundle, [{ name: expectedName, oid }]);
    assert.equal(
      (
        await git(
          ['rev-parse', 'refs/release-pilot/imported/expected'],
          repository,
        )
      ).stdout.trim(),
      oid,
    );

    await git(['update-ref', expectedName, oid], repository);
    await git(['update-ref', extraName, oid], repository);
    await git(
      ['bundle', 'create', extraBundle, expectedName, extraName],
      repository,
    );
    await git(['update-ref', '-d', expectedName, oid], repository);
    await git(['update-ref', '-d', extraName, oid], repository);
    await assert.rejects(
      importBundle(repository, extraBundle, [{ name: expectedName, oid }]),
      /Bundle refs do not exactly match the prepared transition/,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
