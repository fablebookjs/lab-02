import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseProposalMessage } from '../scripts/release-proposal-core.mjs';
import { repositoryRoot } from '../scripts/list-public-packages.mjs';

const execute = promisify(execFile);

const run = (command, args, cwd, env = process.env) =>
  execute(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });

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

test('prepare-cut creates two validated children and no repository refs', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-cut-test-'));
  const repository = join(temporaryRoot, 'repository');
  const artifact = join(temporaryRoot, 'artifact');
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await run(
      process.execPath,
      ['scripts/set-version.mjs', '1.0.0-alpha.0'],
      repository
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'seed'], repository);
    const sourceOid = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();

    await run(
      process.execPath,
      [
        'scripts/release-proposal.mjs',
        'prepare-cut',
        '--next-development',
        'minor',
        '--output',
        artifact,
      ],
      repository
    );

    const transition = JSON.parse(await readFile(join(artifact, 'transition.json'), 'utf8'));
    assert.equal(transition.sourceOid, sourceOid);
    assert.equal(transition.line, 'v1.0');
    assert.equal(transition.releaseVersion, '1.0.0');
    assert.equal(transition.developmentVersion, '1.1.0-alpha.0');

    assert.equal(
      (await git(['show', '-s', '--format=%P', transition.proposalOid], repository)).stdout.trim(),
      sourceOid
    );
    assert.equal(
      (await git(['show', '-s', '--format=%P', transition.developmentOid], repository)).stdout.trim(),
      sourceOid
    );
    const proposal = parseProposalMessage(
      (await git(['show', '-s', '--format=%B', transition.proposalOid], repository)).stdout
    );
    assert.equal(proposal.sourceOid, sourceOid);
    assert.equal(proposal.version, '1.0.0');

    const proposalRoot = JSON.parse(
      (await git(['show', `${transition.proposalOid}:package.json`], repository)).stdout
    );
    const developmentRoot = JSON.parse(
      (await git(['show', `${transition.developmentOid}:package.json`], repository)).stdout
    );
    assert.equal(proposalRoot.version, '1.0.0');
    assert.equal(developmentRoot.version, '1.1.0-alpha.0');
    assert.equal((await git(['rev-parse', 'main'], repository)).stdout.trim(), sourceOid);
    assert.equal((await git(['branch', '--list'], repository)).stdout.trim(), '* main');

    const eventPath = join(temporaryRoot, 'pull-request.json');
    const pullRequest = {
      pull_request: {
        base: {
          ref: 'releases/v1.0',
          repo: { full_name: 'fablebookjs/lab-02' },
          sha: sourceOid,
        },
        head: {
          ref: 'staged/v1.0',
          repo: { full_name: 'fablebookjs/lab-02' },
          sha: transition.proposalOid,
        },
      },
    };
    await writeFile(eventPath, JSON.stringify(pullRequest), 'utf8');
    await run(process.execPath, ['scripts/release-proposal.mjs', 'check-pr'], repository, {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
    });
    pullRequest.pull_request.base.sha = transition.developmentOid;
    await writeFile(eventPath, JSON.stringify(pullRequest), 'utf8');
    await assert.rejects(() =>
      run(process.execPath, ['scripts/release-proposal.mjs', 'check-pr'], repository, {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
      })
    );

    await git(['bundle', 'verify', join(artifact, 'objects.bundle')], repository);
    await git(
      [
        'fetch',
        '--no-tags',
        join(artifact, 'objects.bundle'),
        '+refs/release-pilot/artifact/*:refs/release-pilot/imported/*',
      ],
      repository
    );
    assert.equal(
      (
        await git(['rev-parse', 'refs/release-pilot/imported/cut-proposal'], repository)
      ).stdout.trim(),
      transition.proposalOid
    );
    assert.equal(
      (
        await git(['rev-parse', 'refs/release-pilot/imported/cut-development'], repository)
      ).stdout.trim(),
      transition.developmentOid
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
