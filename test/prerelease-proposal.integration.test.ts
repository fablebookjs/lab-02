import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { renderPrereleasePrBody } from '../scripts/shared/prerelease-proposal/body.ts';
import { prereleaseProposalCommitMessage } from '../scripts/shared/prerelease-proposal/core.ts';
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

const invoke = (
  source: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) =>
  run(
    process.execPath,
    ['--input-type=module', '--eval', source],
    cwd,
    { ...process.env, ...env },
  );

test('an ordinary proposal materializes one child and checks exact current main', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-prerelease-proposal-'),
  );
  const repository = join(temporaryRoot, 'repository');
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await git(['config', 'maintenance.auto', 'false'], repository);
    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '3.2.0-alpha.0'],
      repository,
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'release: bootstrap 3.2.0-alpha.0'], repository);
    const boundaryOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();

    await writeFile(
      join(repository, 'product-change.txt'),
      'intentional prerelease work\n',
      'utf8',
    );
    await git(['add', 'product-change.txt'], repository);
    await git(['commit', '-m', 'Add chapter navigation'], repository);
    const sourceOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    const version = '3.2.0-alpha.1';
    const message = prereleaseProposalCommitMessage({
      attempt: 'integration-attempt',
      boundaryOid,
      sourceOid,
      version,
    });
    const prepared = await invoke(
      [
        "const mechanics = await import('./scripts/github/prepared-commit/mechanics.ts');",
        'const oid = await mechanics.materializeCommit({',
        '  message: process.env.MESSAGE,',
        '  sourceOid: process.env.SOURCE_OID,',
        '  version: process.env.VERSION,',
        '});',
        'console.log(oid);',
      ].join('\n'),
      repository,
      {
        MESSAGE: message,
        SOURCE_OID: sourceOid,
        VERSION: version,
      },
    );
    const proposalOid = prepared.stdout.trim().split('\n').at(-1);
    assert.ok(proposalOid);
    assert.equal(
      (
        await git(
          ['show', '-s', '--format=%P', proposalOid],
          repository,
        )
      ).stdout.trim(),
      sourceOid,
    );
    const rootManifest: unknown = JSON.parse(
      (await git(['show', `${proposalOid}:package.json`], repository)).stdout,
    );
    assert.ok(
      rootManifest !== null &&
        typeof rootManifest === 'object' &&
        'version' in rootManifest,
    );
    assert.equal(rootManifest.version, version);
    await assert.rejects(
      git(['show', `${proposalOid}:releases/v${version}.md`], repository),
    );

    const changes = [
      {
        key: `commit:${sourceOid}`,
        oid: sourceOid,
        qaSkip: false,
        releaseNoteSkip: false,
        title: 'Add chapter navigation',
        url: `https://github.com/fablebookjs/lab-02/commit/${sourceOid}`,
      },
    ];
    const body = renderPrereleasePrBody({
      boundaryOid,
      changes,
      proposalOid,
      sourceOid,
      version,
    });
    const pull = {
      base: {
        ref: 'main',
        repo: { full_name: 'fablebookjs/lab-02' },
        sha: sourceOid,
      },
      body,
      head: {
        ref: 'prerelease',
        repo: { full_name: 'fablebookjs/lab-02' },
        sha: proposalOid,
      },
    };
    await invoke(
      [
        "const controller = await import('./scripts/github/prerelease-proposal/controller.ts');",
        'await controller.checkPrereleasePullRequest(',
        '  JSON.parse(process.env.PULL),',
        '  process.env.MAIN_OID,',
        ');',
      ].join('\n'),
      repository,
      {
        MAIN_OID: sourceOid,
        PULL: JSON.stringify(pull),
      },
    );
    await assert.rejects(
      invoke(
        [
          "const controller = await import('./scripts/github/prerelease-proposal/controller.ts');",
          'await controller.checkPrereleasePullRequest(',
          '  JSON.parse(process.env.PULL),',
          '  process.env.MAIN_OID,',
          ');',
        ].join('\n'),
        repository,
        {
          MAIN_OID: boundaryOid,
          PULL: JSON.stringify(pull),
        },
      ),
      /not based on exact current main/,
    );

    assert.equal(
      await readFile(join(repository, 'product-change.txt'), 'utf8'),
      'intentional prerelease work\n',
    );
    assert.equal(
      (await git(['rev-parse', 'main'], repository)).stdout.trim(),
      sourceOid,
    );
  } finally {
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});
