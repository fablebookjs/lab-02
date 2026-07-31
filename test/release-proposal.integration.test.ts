import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  developmentCommitMessage,
  parseProposalMessage,
} from '../scripts/shared/release-proposal/core.ts';
import {
  cutPrereleaseAuthority,
} from '../scripts/github/release-proposal/controller.ts';
import {
  prereleaseProposalCommitMessage,
} from '../scripts/shared/prerelease-proposal/core.ts';
import { renderReleaseRecord } from '../scripts/shared/release-communication/records.ts';
import {
  EMPTY_RELEASE_HIGHLIGHTS,
  renderReleasePrBody,
} from '../scripts/shared/release-proposal/body.ts';
import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const execute = promisify(execFile);

const stringProperty = (
  value: object,
  name:
    | 'developmentOid'
    | 'developmentVersion'
    | 'line'
    | 'proposalOid'
    | 'releaseVersion'
    | 'sourceOid',
): string => {
  const property = Object.entries(value).find(([key]) => key === name)?.[1];
  if (typeof property !== 'string') {
    throw new Error(`Cut transition has no ${name}.`);
  }
  return property;
};

const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  execute(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });

const git = (args: string[], cwd: string) => run('git', args, cwd);
const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
};
const invokeController = (
  operation: string,
  input: unknown,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const controller = await import('./scripts/github/release-proposal/controller.ts');",
        'await controller[process.env.TEST_OPERATION](JSON.parse(process.env.TEST_INPUT));',
      ].join('\n'),
    ],
    cwd,
    {
      ...env,
      TEST_INPUT: JSON.stringify(input),
      TEST_OPERATION: operation,
    },
  );
const invokeControllerResult = (
  operation: string,
  input: unknown,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const controller = await import('./scripts/github/release-proposal/controller.ts');",
        'const result = await controller[process.env.TEST_OPERATION](process.env.TEST_TOKEN, JSON.parse(process.env.TEST_INPUT));',
        'console.log(JSON.stringify(result));',
      ].join('\n'),
    ],
    cwd,
    {
      ...env,
      TEST_INPUT: JSON.stringify(input),
      TEST_OPERATION: operation,
      TEST_TOKEN: 'test-token',
    },
  );

const copySeed = async (destination: string): Promise<void> => {
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
  const github = await listen((request, response) => {
    if (
      request.method === 'GET' &&
      request.url?.includes('/commits/') &&
      request.url.includes('/pulls?')
    ) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }
    if (
      request.method === 'GET' &&
      request.url?.includes('/git/ref/heads%2Fprerelease')
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (
      request.method === 'GET' &&
      request.url?.startsWith('/repos/fablebookjs/lab-02/pulls?')
    ) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }
    response.writeHead(500);
    response.end(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await git(['config', 'maintenance.auto', 'false'], repository);
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'seed'], repository);
    const predecessorOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '1.0.0-alpha.0'],
      repository
    );
    await git(['add', '.'], repository);
    await git([
      'commit',
      '-m',
      developmentCommitMessage({
        line: 'v0.9',
        sourceOid: predecessorOid,
        version: '1.0.0-alpha.0',
      }),
    ], repository);
    const bootstrapOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await git(['checkout', '-b', 'test-prerelease-proposal'], repository);
    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '1.0.0-alpha.1'],
      repository
    );
    await git(['add', '.'], repository);
    await git([
      'commit',
      '-m',
      prereleaseProposalCommitMessage({
        attempt: 'test-alpha-one',
        boundaryOid: bootstrapOid,
        sourceOid: bootstrapOid,
        version: '1.0.0-alpha.1',
      }),
    ], repository);
    await git(['checkout', 'main'], repository);
    await git([
      'merge',
      '--no-ff',
      'test-prerelease-proposal',
      '-m',
      'Merge the mechanical alpha.1 proposal',
    ], repository);
    await git(['branch', '-d', 'test-prerelease-proposal'], repository);
    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '1.0.0-alpha.2'],
      repository
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'release: advance alpha'], repository);
    await writeFile(
      join(repository, 'cumulative-history.txt'),
      'included in the initial stable release\n',
      'utf8',
    );
    await git(['add', 'cumulative-history.txt'], repository);
    await git(['commit', '-m', 'Add cumulative stable history'], repository);
    const sourceOid = (await git(['rev-parse', 'HEAD'], repository)).stdout.trim();
    const changes = [
      {
        key: `commit:${sourceOid}`,
        oid: sourceOid,
        qaSkip: false,
        releaseNoteSkip: false,
        title: 'Add cumulative stable history',
        url: `https://github.com/fablebookjs/lab-02/commit/${sourceOid}`,
      },
    ];

    await invokeController(
      'prepareCut',
      {
        'github-token': 'test-token',
        'next-development': 'minor',
        output: artifact,
      },
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.url,
      },
    );

    const transition: unknown = JSON.parse(
      await readFile(join(artifact, 'transition.json'), 'utf8'),
    );
    assert.ok(transition !== null && typeof transition === 'object');
    const cut = {
      developmentOid: stringProperty(transition, 'developmentOid'),
      developmentVersion: stringProperty(transition, 'developmentVersion'),
      line: stringProperty(transition, 'line'),
      proposalOid: stringProperty(transition, 'proposalOid'),
      releaseVersion: stringProperty(transition, 'releaseVersion'),
      sourceOid: stringProperty(transition, 'sourceOid'),
    };
    assert.equal(cut.sourceOid, sourceOid);
    assert.equal(cut.line, 'v1.0');
    assert.equal(cut.releaseVersion, '1.0.0');
    assert.equal(cut.developmentVersion, '1.1.0-alpha.0');

    assert.equal(
      (await git(['show', '-s', '--format=%P', cut.proposalOid], repository)).stdout.trim(),
      sourceOid
    );
    assert.equal(
      (await git(['show', '-s', '--format=%P', cut.developmentOid], repository)).stdout.trim(),
      sourceOid
    );
    const proposal = parseProposalMessage(
      (await git(['show', '-s', '--format=%B', cut.proposalOid], repository)).stdout
    );
    assert.equal(proposal.sourceOid, sourceOid);
    assert.equal(proposal.version, '1.0.0');

    const proposalRoot: unknown = JSON.parse(
      (await git(['show', `${cut.proposalOid}:package.json`], repository)).stdout
    );
    const developmentRoot: unknown = JSON.parse(
      (await git(['show', `${cut.developmentOid}:package.json`], repository)).stdout
    );
    assert.ok(proposalRoot !== null && typeof proposalRoot === 'object');
    assert.ok(developmentRoot !== null && typeof developmentRoot === 'object');
    assert.ok('version' in proposalRoot);
    assert.ok('version' in developmentRoot);
    assert.equal(proposalRoot.version, '1.0.0');
    assert.equal(developmentRoot.version, '1.1.0-alpha.0');
    assert.equal(
      (
        await git(
          ['show', `${cut.proposalOid}:releases/v1.0.0.md`],
          repository
        )
      ).stdout,
      renderReleaseRecord({ changes, version: '1.0.0' })
    );
    await assert.rejects(() =>
      git(
        ['show', `${cut.developmentOid}:releases/v1.0.0.md`],
        repository
      )
    );
    assert.equal((await git(['rev-parse', 'main'], repository)).stdout.trim(), sourceOid);
    assert.equal((await git(['branch', '--list'], repository)).stdout.trim(), '* main');

    const releasePrTemplate = await readFile(
      join(repository, '.github', 'release-templates', 'release-pr-initial.md'),
      'utf8'
    );
    const validReleaseBody = renderReleasePrBody({
      changes,
      line: cut.line,
      packageNames: [
        '@fablebook/lab-02-addon',
        '@fablebook/lab-02-core',
      ],
      proposalOid: cut.proposalOid,
      releaseOid: cut.sourceOid,
      template: releasePrTemplate,
      version: cut.releaseVersion,
    }).replace(
      EMPTY_RELEASE_HIGHLIGHTS,
      '**Worth upgrading:** The release proposal is ready for user evaluation.'
    );
    const pullRequest = {
      pull_request: {
        body: validReleaseBody,
        base: {
          ref: 'releases/v1.0',
          repo: { full_name: 'fablebookjs/lab-02' },
          sha: sourceOid,
        },
        head: {
          ref: 'staged/v1.0',
          repo: { full_name: 'fablebookjs/lab-02' },
          sha: cut.proposalOid,
        },
      },
    };
    await invokeController('checkPullRequest', pullRequest.pull_request, repository);
    pullRequest.pull_request.body = validReleaseBody.replace(
      '**Worth upgrading:** The release proposal is ready for user evaluation.',
      EMPTY_RELEASE_HIGHLIGHTS
    );
    await assert.rejects(
      () => invokeController('checkPullRequest', pullRequest.pull_request, repository),
      /blocking empty placeholder/,
    );
    pullRequest.pull_request.body = validReleaseBody;
    pullRequest.pull_request.base.sha = cut.developmentOid;
    await assert.rejects(() =>
      invokeController('checkPullRequest', pullRequest.pull_request, repository),
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
      cut.proposalOid
    );
    assert.equal(
      (
        await git(['rev-parse', 'refs/release-pilot/imported/cut-development'], repository)
      ).stdout.trim(),
      cut.developmentOid
    );
    await assert.rejects(
      readFile(join(artifact, 'authority.json'), 'utf8'),
      /ENOENT/,
    );
    const appliedDevelopmentOid = 'a'.repeat(40);
    assert.notEqual(appliedDevelopmentOid, cut.developmentOid);
    assert.deepEqual(cutPrereleaseAuthority({
      developmentVersion: cut.developmentVersion,
      line: cut.line,
      snapshotOid: appliedDevelopmentOid,
      sourceOid,
    }), {
      boundaryOid: appliedDevelopmentOid,
      changes: [],
      channel: 'next',
      cutLine: 'v1.0',
      repository: 'fablebookjs/lab-02',
      schema: 1,
      snapshotOid: appliedDevelopmentOid,
      sourceOid,
      version: '1.1.0-alpha.0',
    });

    await git(['branch', 'releases/v1.0', sourceOid], repository);
    await git(['checkout', 'releases/v1.0'], repository);
    await writeFile(
      join(repository, 'post-cut-fix.txt'),
      'included after the release line was cut\n',
      'utf8',
    );
    await git(['add', 'post-cut-fix.txt'], repository);
    await git(['commit', '-m', 'Fix the cut release line'], repository);
    const postCutOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await git(['branch', '-f', 'main', cut.developmentOid], repository);
    await git(['checkout', 'main'], repository);
    const cumulative = await invokeControllerResult(
      'proposalInitialReleaseChanges',
      { line: 'v1.0', releaseOid: postCutOid },
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.url,
      },
    );
    assert.deepEqual(JSON.parse(cumulative.stdout.trim()), [
      changes[0],
      {
        key: `commit:${postCutOid}`,
        oid: postCutOid,
        qaSkip: false,
        releaseNoteSkip: false,
        title: 'Fix the cut release line',
        url: `https://github.com/fablebookjs/lab-02/commit/${postCutOid}`,
      },
    ]);
  } finally {
    await github.close();
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});
