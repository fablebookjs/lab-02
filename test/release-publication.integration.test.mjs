import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { repositoryRoot } from '../scripts/list-public-packages.mjs';

const execute = promisify(execFile);
const run = (command, args, cwd) =>
  execute(command, args, { cwd, env: process.env, maxBuffer: 20 * 1024 * 1024 });
const git = (args, cwd) => run('git', args, cwd);

const copySeed = async (destination) => {
  await cp(repositoryRoot, destination, {
    filter: (source) => {
      const path = relative(repositoryRoot, source).split(sep);
      return !path.some((part) => ['.cache', '.git', 'dist', 'node_modules'].includes(part));
    },
    recursive: true,
  });
};

test('the authorized stable snapshot packs the complete lockstep package set', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-publication-test-'));
  const repository = join(temporaryRoot, 'repository');
  const authorityPath = join(temporaryRoot, 'authority.json');
  const output = join(temporaryRoot, 'output');
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'seed'], repository);
    await run(process.execPath, ['scripts/set-version.mjs', '1.0.0'], repository);
    await git(['add', 'package.json', 'package-lock.json', 'packages'], repository);
    await git(['commit', '--allow-empty', '-m', 'release: materialize 1.0.0'], repository);
    const snapshotOid = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();

    await writeFile(
      authorityPath,
      `${JSON.stringify(
        {
          channel: 'v-1.0',
          line: 'v1.0',
          proposalOid: '2'.repeat(40),
          pullRequest: 42,
          repository: 'fablebookjs/lab-02',
          schema: 1,
          snapshotOid,
          sourceOid: '1'.repeat(40),
          version: '1.0.0',
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    await run(
      process.execPath,
      [
        'scripts/release-publication.mjs',
        'prepare',
        '--authority',
        authorityPath,
        '--snapshot',
        repository,
        '--output',
        output,
      ],
      repository
    );

    const manifest = JSON.parse(await readFile(join(output, 'publication.json'), 'utf8'));
    assert.equal(manifest.snapshotOid, snapshotOid);
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.channel, 'v-1.0');
    assert.deepEqual(
      manifest.packages.map(({ name }) => name),
      ['@fablebook/lab-02-addon', '@fablebook/lab-02-core']
    );
    assert.deepEqual(
      (await readdir(join(output, 'tarballs'))).sort(),
      manifest.packages.map(({ filename }) => filename).sort()
    );
    assert.ok(manifest.packages.every(({ integrity }) => integrity.startsWith('sha512-')));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
