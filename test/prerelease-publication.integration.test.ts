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

import {
  checkPrereleaseCompletion,
  finalizePrerelease,
  preparePrereleasePublication,
} from '../scripts/github/prerelease-publication/controller.ts';
import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const execute = promisify(execFile);
const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) => execute(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });
const git = (args: string[], cwd: string) => run('git', args, cwd);

const copyCompiledSeed = async (destination: string): Promise<void> => {
  await cp(repositoryRoot, destination, {
    filter: (source) => {
      const path = relative(repositoryRoot, source).split(sep);
      return !path.some((part) =>
        ['.cache', '.git', 'node_modules'].includes(part),
      );
    },
    recursive: true,
  });
};

test('the exact prerelease snapshot seals the complete package set without a release file', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-prerelease-publication-'),
  );
  const repository = join(temporaryRoot, 'repository');
  const authorityPath = join(temporaryRoot, 'authority.json');
  const output = join(temporaryRoot, 'output');
  try {
    await copyCompiledSeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '3.2.0-alpha.0'],
      repository,
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'release: begin 3.2.0-alpha.0'], repository);
    const bootstrapOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await writeFile(
      authorityPath,
      `${JSON.stringify(
        {
          boundaryOid: bootstrapOid,
          changes: [],
          channel: 'next',
          cutLine: 'v3.1',
          repository: 'fablebookjs/lab-02',
          schema: 1,
          snapshotOid: bootstrapOid,
          sourceOid: '1'.repeat(40),
          version: '3.2.0-alpha.0',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const bootstrapOutput = join(temporaryRoot, 'bootstrap-output');
    await preparePrereleasePublication({
      authority: authorityPath,
      output: bootstrapOutput,
      snapshot: repository,
    });
    const bootstrapManifest: unknown = JSON.parse(
      await readFile(join(bootstrapOutput, 'publication.json'), 'utf8'),
    );
    assert.ok(
      bootstrapManifest !== null &&
        typeof bootstrapManifest === 'object' &&
        'cutLine' in bootstrapManifest &&
        bootstrapManifest.cutLine === 'v3.1' &&
        'releaseBody' in bootstrapManifest &&
        typeof bootstrapManifest.releaseBody === 'string',
    );
    assert.match(
      bootstrapManifest.releaseBody,
      /no user-facing changes worth mentioning/,
    );

    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '3.2.0-alpha.1'],
      repository,
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'release: materialize 3.2.0-alpha.1'], repository);
    const snapshotOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await writeFile(
      authorityPath,
      `${JSON.stringify(
        {
          boundaryOid: '0'.repeat(40),
          changes: [
            {
              key: 'pr:91',
              releaseNoteSkip: false,
              title: 'Add chapter navigation',
              url: 'https://github.com/fablebookjs/lab-02/pull/91',
            },
          ],
          channel: 'next',
          proposalOid: '2'.repeat(40),
          pullRequest: 93,
          repository: 'fablebookjs/lab-02',
          schema: 1,
          snapshotOid,
          sourceOid: '1'.repeat(40),
          version: '3.2.0-alpha.1',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await preparePrereleasePublication({
      authority: authorityPath,
      output,
      snapshot: repository,
    });

    const manifest: unknown = JSON.parse(
      await readFile(join(output, 'publication.json'), 'utf8'),
    );
    assert.ok(manifest !== null && typeof manifest === 'object');
    assert.ok('schema' in manifest && manifest.schema === 1);
    assert.ok('channel' in manifest && manifest.channel === 'next');
    assert.ok('snapshotOid' in manifest && manifest.snapshotOid === snapshotOid);
    assert.ok('releaseBody' in manifest && typeof manifest.releaseBody === 'string');
    assert.match(manifest.releaseBody, /Add chapter navigation/);
    assert.doesNotMatch(manifest.releaseBody, /migration/i);
    assert.ok('packages' in manifest && Array.isArray(manifest.packages));
    assert.deepEqual(
      manifest.packages.map((pkg) => {
        assert.ok(pkg !== null && typeof pkg === 'object' && 'name' in pkg);
        return pkg.name;
      }),
      ['@fablebook/lab-02-addon', '@fablebook/lab-02-core'],
    );
    assert.deepEqual(
      (await readdir(join(output, 'tarballs'))).sort(),
      manifest.packages
        .map((pkg) => {
          assert.ok(
            pkg !== null &&
              typeof pkg === 'object' &&
              'filename' in pkg &&
              typeof pkg.filename === 'string',
          );
          return pkg.filename;
        })
        .sort(),
    );
    assert.ok(
      !(await readdir(join(repository, 'releases'))).some((path) =>
        path.includes('3.2.0-alpha.1'),
      ),
    );

    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '3.2.0-beta.0'],
      repository,
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'release: enter 3.2.0-beta.0'], repository);
    const phaseSnapshotOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await writeFile(
      authorityPath,
      `${JSON.stringify(
        {
          boundaryOid: snapshotOid,
          changes: [
            {
              key: 'pr:94',
              releaseNoteSkip: false,
              title: 'Collect beta feedback',
              url: 'https://github.com/fablebookjs/lab-02/pull/94',
            },
          ],
          channel: 'next',
          phase: 'beta',
          repository: 'fablebookjs/lab-02',
          schema: 1,
          snapshotOid: phaseSnapshotOid,
          sourceOid: snapshotOid,
          version: '3.2.0-beta.0',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const phaseOutput = join(temporaryRoot, 'phase-output');
    await preparePrereleasePublication({
      authority: authorityPath,
      output: phaseOutput,
      snapshot: repository,
    });
    const phaseManifest: unknown = JSON.parse(
      await readFile(join(phaseOutput, 'publication.json'), 'utf8'),
    );
    assert.ok(phaseManifest !== null && typeof phaseManifest === 'object');
    assert.ok('phase' in phaseManifest && phaseManifest.phase === 'beta');
    assert.ok(!('proposalOid' in phaseManifest));
    assert.ok(!('pullRequest' in phaseManifest));
    assert.ok(
      'releaseBody' in phaseManifest &&
        typeof phaseManifest.releaseBody === 'string',
    );
    assert.match(phaseManifest.releaseBody, /Collect beta feedback/);
  } finally {
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});

test('prerelease finalization creates an exact tag and prerelease GitHub Release', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-prerelease-finalize-'),
  );
  const tarballs = join(temporaryRoot, 'tarballs');
  const manifestPath = join(temporaryRoot, 'publication.json');
  const snapshotOid = '3'.repeat(40);
  const tagOid = '4'.repeat(40);
  const filename = 'fablebook-lab-02-core-3.2.0-alpha.1.tgz';
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const releaseBody = '# Lab-02 3.2.0-alpha.1\n';
  const previousRepository = process.env['GITHUB_REPOSITORY'];
  const previousRef = process.env['GITHUB_REF'];
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    body: unknown;
    method: string;
    url: string;
  }> = [];
  let tagVisible = false;
  let releaseVisible = false;
  try {
    await mkdir(tarballs);
    await writeFile(join(tarballs, filename), 'prepared tarball', 'utf8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          boundaryOid: '0'.repeat(40),
          channel: 'next',
          packages: [
            {
              filename,
              integrity,
              name: '@fablebook/lab-02-core',
            },
          ],
          proposalOid: '2'.repeat(40),
          pullRequest: 93,
          releaseBody,
          repository: 'fablebookjs/lab-02',
          schema: 1,
          snapshotOid,
          sourceOid: '1'.repeat(40),
          version: '3.2.0-alpha.1',
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
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ body, method, url });
      const json = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
          status,
        });
      if (url.endsWith('/git/ref/tags%2Fv3.2.0-alpha.1')) {
        return tagVisible
          ? json({ object: { sha: tagOid, type: 'tag' } })
          : json({ message: 'Not Found' }, 404);
      }
      if (url.endsWith('/releases/tags/v3.2.0-alpha.1')) {
        return releaseVisible
          ? json({
              body: releaseBody,
              draft: false,
              prerelease: true,
              tag_name: 'v3.2.0-alpha.1',
            })
          : json({ message: 'Not Found' }, 404);
      }
      if (url.endsWith('/git/tags') && method === 'POST') {
        return json({
          object: { sha: snapshotOid, type: 'commit' },
          sha: tagOid,
          tag: 'v3.2.0-alpha.1',
        });
      }
      if (url.endsWith('/git/refs') && method === 'POST') {
        tagVisible = true;
        return json({ ref: 'refs/tags/v3.2.0-alpha.1' }, 201);
      }
      if (url.endsWith('/releases') && method === 'POST') {
        releaseVisible = true;
        return json(
          {
            body: releaseBody,
            draft: false,
            prerelease: true,
            tag_name: 'v3.2.0-alpha.1',
          },
          201,
        );
      }
      if (url.endsWith(`/git/tags/${tagOid}`)) {
        return json({
          object: { sha: snapshotOid, type: 'commit' },
          sha: tagOid,
          tag: 'v3.2.0-alpha.1',
        });
      }
      throw new Error(`Unexpected prerelease finalization request: ${method} ${url}`);
    };

    await finalizePrerelease({
      'expected-snapshot': snapshotOid,
      'expected-version': '3.2.0-alpha.1',
      'github-token': 'test-token',
      manifest: manifestPath,
      tarballs,
    });

    const releaseCreate = requests.find(
      ({ method, url }) => method === 'POST' && url.endsWith('/releases'),
    );
    assert.ok(
      releaseCreate?.body !== null &&
        typeof releaseCreate?.body === 'object' &&
        'prerelease' in releaseCreate.body &&
        'target_commitish' in releaseCreate.body,
    );
    assert.equal(releaseCreate.body.prerelease, true);
    assert.equal(releaseCreate.body.target_commitish, snapshotOid);
    assert.ok(tagVisible && releaseVisible);
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

test('completed phase-entry publication is observed as a visible skip', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-prerelease-completion-'),
  );
  const tarballs = join(temporaryRoot, 'tarballs');
  const manifestPath = join(temporaryRoot, 'publication.json');
  const snapshotOid = '3'.repeat(40);
  const tagOid = '4'.repeat(40);
  const filename = 'fablebook-lab-02-core-3.2.0-beta.0.tgz';
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const releaseBody = '# Lab-02 3.2.0-beta.0\n';
  const previousRepository = process.env['GITHUB_REPOSITORY'];
  const previousRef = process.env['GITHUB_REF'];
  const originalFetch = globalThis.fetch;
  let nextVersion = '3.2.0-beta.0';
  try {
    await mkdir(tarballs);
    await writeFile(join(tarballs, filename), 'prepared tarball', 'utf8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          boundaryOid: '0'.repeat(40),
          channel: 'next',
          packages: [
            {
              filename,
              integrity,
              name: '@fablebook/lab-02-core',
            },
          ],
          phase: 'beta',
          releaseBody,
          repository: 'fablebookjs/lab-02',
          schema: 1,
          snapshotOid,
          sourceOid: '1'.repeat(40),
          version: '3.2.0-beta.0',
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
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const json = (value: unknown): Response =>
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      if (url.startsWith('https://registry.npmjs.org/')) {
        return json({
          'dist-tags': { next: nextVersion },
          name: '@fablebook/lab-02-core',
          versions: {
            '3.2.0-beta.0': {
              dist: { integrity },
              name: '@fablebook/lab-02-core',
              version: '3.2.0-beta.0',
            },
          },
        });
      }
      if (url.endsWith('/git/ref/tags%2Fv3.2.0-beta.0')) {
        return json({ object: { sha: tagOid, type: 'tag' } });
      }
      if (url.endsWith(`/git/tags/${tagOid}`)) {
        return json({
          object: { sha: snapshotOid, type: 'commit' },
          sha: tagOid,
          tag: 'v3.2.0-beta.0',
        });
      }
      if (url.endsWith('/releases/tags/v3.2.0-beta.0')) {
        return json({
          body: releaseBody,
          draft: false,
          prerelease: true,
          tag_name: 'v3.2.0-beta.0',
        });
      }
      throw new Error(`Unexpected prerelease completion request: ${url}`);
    };

    assert.deepEqual(
      await checkPrereleaseCompletion({
        'expected-snapshot': snapshotOid,
        'expected-version': '3.2.0-beta.0',
        'github-token': 'test-token',
        manifest: manifestPath,
        tarballs,
      }),
      { complete: true },
    );

    nextVersion = '3.2.0-alpha.2';
    assert.deepEqual(
      await checkPrereleaseCompletion({
        'expected-snapshot': snapshotOid,
        'expected-version': '3.2.0-beta.0',
        'github-token': 'test-token',
        manifest: manifestPath,
        tarballs,
      }),
      { complete: false },
    );
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
