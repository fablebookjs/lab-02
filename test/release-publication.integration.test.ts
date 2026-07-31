import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';
import {
  finalizeRelease,
  preparePublication,
} from '../scripts/github/release-publication/controller.ts';

const execute = promisify(execFile);
const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  execute(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });
const git = (args: string[], cwd: string) => run('git', args, cwd);
const invokeController = (operation: string, input: unknown, cwd: string) =>
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const controller = await import('./scripts/github/release-publication/controller.ts');",
        'await controller[process.env.TEST_OPERATION](JSON.parse(process.env.TEST_INPUT));',
      ].join('\n'),
    ],
    cwd,
    {
      ...process.env,
      TEST_INPUT: JSON.stringify(input),
      TEST_OPERATION: operation,
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

test('the authorized native snapshot seals the complete stable publication plan', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-publication-test-'));
  const repository = join(temporaryRoot, 'repository');
  const authorityPath = join(temporaryRoot, 'authority.json');
  const output = join(temporaryRoot, 'output');
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await git(['config', 'maintenance.auto', 'false'], repository);
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'seed'], repository);
    await run(process.execPath, ['scripts/version/set-version.ts', '1.0.0'], repository);
    await writeFile(
      join(repository, 'releases/v1.0.0.md'),
      '# v1.0.0 changes\n\nNo changes were recorded for this release.\n',
      'utf8',
    );
    await git(['add', 'package.json', 'package-lock.json', 'packages', 'releases'], repository);
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
          releaseCommunication: {
            changes: [],
            kind: 'initial',
            releaseHighlights: '**Worth upgrading:** Exercise the complete release flow.',
          },
          repository: 'fablebookjs/lab-02',
          schema: 2,
          snapshotOid,
          sourceOid: '1'.repeat(40),
          version: '1.0.0',
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    await invokeController(
      'preparePublication',
      { authority: authorityPath, output, snapshot: repository },
      repository,
    );

    const manifest: unknown = JSON.parse(
      await readFile(join(output, 'publication.json'), 'utf8'),
    );
    assert.ok(manifest !== null && typeof manifest === 'object');
    assert.ok('snapshotOid' in manifest);
    assert.ok('version' in manifest);
    assert.ok('channel' in manifest);
    assert.ok('schema' in manifest);
    assert.ok('releaseBody' in manifest);
    assert.ok('packages' in manifest && Array.isArray(manifest.packages));
    const manifestPackages = manifest.packages.map((pkg) => {
      assert.ok(pkg !== null && typeof pkg === 'object');
      assert.ok('name' in pkg && typeof pkg.name === 'string');
      assert.ok('filename' in pkg && typeof pkg.filename === 'string');
      assert.ok('integrity' in pkg && typeof pkg.integrity === 'string');
      return {
        filename: pkg.filename,
        integrity: pkg.integrity,
        name: pkg.name,
      };
    });
    assert.equal(manifest.snapshotOid, snapshotOid);
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.channel, 'v-1.0');
    assert.equal(manifest.schema, 3);
    assert.equal(
      manifest.releaseBody,
      '# Lab-02 1.0.0\n\n## Release highlights\n\n' +
        '**Worth upgrading:** Exercise the complete release flow.\n',
    );
    assert.ok(!('releaseCommunication' in manifest));
    assert.ok(
      manifest.packages.every(
        (pkg) =>
          pkg !== null &&
          typeof pkg === 'object' &&
          !('location' in pkg) &&
          !('version' in pkg),
      ),
    );
    assert.deepEqual(
      manifestPackages.map(({ name }) => name),
      ['@fablebook/lab-02-addon', '@fablebook/lab-02-core']
    );
    assert.deepEqual(
      (await readdir(join(output, 'tarballs'))).sort(),
      manifestPackages.map(({ filename }) => filename).sort()
    );
    assert.ok(manifestPackages.every(({ integrity }) => integrity.startsWith('sha512-')));
  } finally {
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});

test(
  'an immutable legacy snapshot seals the equivalent stable publication plan',
  { timeout: 120_000 },
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-legacy-publication-test-'));
    const snapshot = join(temporaryRoot, 'snapshot');
    const authorityPath = join(temporaryRoot, 'authority.json');
    const output = join(temporaryRoot, 'output');
    try {
      await git(['clone', '--quiet', '--no-checkout', repositoryRoot, snapshot], temporaryRoot);
      await git(['checkout', '--quiet', '--detach', 'v3.0.0'], snapshot);
      await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], snapshot);
      await run('npm', ['run', 'compile'], snapshot);
      const snapshotOid = (await git(['rev-parse', 'HEAD'], snapshot)).stdout.trim();
      await writeFile(
        authorityPath,
        `${JSON.stringify(
          {
            channel: 'v-3.0',
            line: 'v3.0',
            proposalOid: '2'.repeat(40),
            pullRequest: 86,
            releaseCommunication: {
              changes: [
                {
                  key: 'pr:85',
                  qaSkip: false,
                  releaseNoteSkip: false,
                  title: 'Test core boundary behavior',
                  url: 'https://github.com/fablebookjs/lab-02/pull/85',
                },
                {
                  key: 'pr:84',
                  qaSkip: false,
                  releaseNoteSkip: false,
                  title: 'Add a subtraction helper',
                  url: 'https://github.com/fablebookjs/lab-02/pull/84',
                },
              ],
              kind: 'initial',
              releaseHighlights: '**Worth upgrading:** Exercise immutable legacy preparation.',
            },
            repository: 'fablebookjs/lab-02',
            schema: 2,
            snapshotOid,
            sourceOid: '1'.repeat(40),
            version: '3.0.0',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      await preparePublication({ authority: authorityPath, output, snapshot });

      const manifest: unknown = JSON.parse(
        await readFile(join(output, 'publication.json'), 'utf8'),
      );
      assert.ok(manifest !== null && typeof manifest === 'object');
      assert.ok('schema' in manifest && manifest.schema === 3);
      assert.ok('releaseBody' in manifest && typeof manifest.releaseBody === 'string');
      assert.match(manifest.releaseBody, /Exercise immutable legacy preparation/);
      assert.match(manifest.releaseBody, /Test core boundary behavior/);
      assert.ok('packages' in manifest && Array.isArray(manifest.packages));
      assert.deepEqual(
        manifest.packages.map((pkg) => {
          assert.ok(pkg !== null && typeof pkg === 'object');
          assert.ok('name' in pkg);
          return pkg.name;
        }),
        ['@fablebook/lab-02-addon', '@fablebook/lab-02-core'],
      );
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

test('finalization verifies a completed release from only the sealed plan', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-finalization-test-'));
  const tarballs = join(temporaryRoot, 'tarballs');
  const manifestPath = join(temporaryRoot, 'publication.json');
  const snapshotOid = '3'.repeat(40);
  const tagOid = '4'.repeat(40);
  const releaseBody = '# Lab-02 1.0.0\n';
  const filename = 'fablebook-lab-02-core-1.0.0.tgz';
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const previousRepository = process.env['GITHUB_REPOSITORY'];
  const previousRef = process.env['GITHUB_REF'];
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string }> = [];
  try {
    await mkdir(tarballs);
    await writeFile(join(tarballs, filename), 'prepared tarball', 'utf8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          channel: 'v-1.0',
          line: 'v1.0',
          packages: [
            {
              filename,
              integrity,
              name: '@fablebook/lab-02-core',
            },
          ],
          proposalOid: '2'.repeat(40),
          pullRequest: 42,
          releaseBody,
          repository: 'fablebookjs/lab-02',
          schema: 3,
          snapshotOid,
          sourceOid: '1'.repeat(40),
          version: '1.0.0',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    process.env['GITHUB_REPOSITORY'] = 'fablebookjs/lab-02';
    process.env['GITHUB_REF'] = 'refs/heads/main';
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? 'GET';
      requests.push({ method, url });
      const json = (value: unknown): Response =>
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      if (url.endsWith('/git/ref/tags%2Fv1.0.0')) {
        return json({ object: { sha: tagOid, type: 'tag' } });
      }
      if (url.endsWith(`/git/tags/${tagOid}`)) {
        return json({
          object: { sha: snapshotOid, type: 'commit' },
          sha: tagOid,
          tag: 'v1.0.0',
        });
      }
      if (url.endsWith('/releases/tags/v1.0.0')) {
        return json({
          body: releaseBody,
          draft: false,
          prerelease: false,
          tag_name: 'v1.0.0',
        });
      }
      if (url.endsWith('/dispatches') && method === 'POST') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected finalization request: ${method} ${url}`);
    };

    await finalizeRelease({
      'expected-snapshot': snapshotOid,
      'expected-version': '1.0.0',
      'github-token': 'test-token',
      manifest: manifestPath,
      tarballs,
    });

    assert.equal(requests.filter(({ url }) => url.includes('/releases/')).length, 2);
    assert.ok(requests.every(({ url }) => url.startsWith('https://api.github.com/')));
    assert.ok(requests.every(({ url }) => !url.includes('/pulls/') && !url.includes('npmjs')));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRepository === undefined) {
      delete process.env['GITHUB_REPOSITORY'];
    } else {
      process.env['GITHUB_REPOSITORY'] = previousRepository;
    }
    if (previousRef === undefined) {
      delete process.env['GITHUB_REF'];
    } else {
      process.env['GITHUB_REF'] = previousRef;
    }
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});

test('privileged stable jobs receive no release snapshot checkout', async () => {
  const workflow = await readFile(
    join(repositoryRoot, '.github/workflows/complete-stable-publication.yml'),
    'utf8',
  );
  const publishStart = workflow.indexOf('\n  publish:');
  const finalizeStart = workflow.indexOf('\n  finalize:');
  assert.ok(publishStart > 0 && finalizeStart > publishStart);
  const privilegedJobs = workflow.slice(publishStart);
  assert.doesNotMatch(privilegedJobs, /path: snapshot|working-directory: snapshot/);
  assert.doesNotMatch(privilegedJobs, /github\.workspace.*snapshot/);
  assert.doesNotMatch(privilegedJobs, /npm ci|npm run check/);
  assert.match(privilegedJobs, /EXPECTED_SNAPSHOT/);
  assert.match(privilegedJobs, /EXPECTED_VERSION/);
  assert.match(privilegedJobs, /TARBALLS/);
});
