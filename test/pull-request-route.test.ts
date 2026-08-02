import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import checkRoute from '../scripts/github/pull-request/check-route.ts';
import type { GitHubHandlerRuntime } from '../scripts/github/runtime.ts';
import { pullRequestRouteError } from '../scripts/shared/pull-request/route.ts';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'fablebookjs/lab-02';

const routeError = (
  headRef: string,
  baseRef: string,
  headRepository = repository,
): string | null =>
  pullRequestRouteError({ baseRef, headRef, headRepository, repository });

test('ordinary topic branches may target integration and ordinary topic branches', () => {
  assert.equal(routeError('feature/summary', 'main'), null);
  assert.equal(routeError('feature/release-fix', 'releases/v5.1'), null);
  assert.equal(routeError('feature/stacked', 'feature/base'), null);
  assert.equal(routeError('main', 'main', 'contributor/lab-02'), null);
});

test('canonical controller branches use their intended integration targets', () => {
  assert.equal(routeError('staged/v5.1', 'releases/v5.1'), null);
  assert.equal(routeError('prerelease', 'main'), null);
  assert.equal(routeError('patchbacks/v5.1.2', 'main'), null);
});

test('release lines and proposals cannot target main', () => {
  assert.match(routeError('releases/v5.1', 'main') ?? '', /cannot target development line main/);
  assert.match(routeError('staged/v5.1', 'main') ?? '', /must target its matching release line/);
  assert.match(routeError('patchbacks/not-a-version', 'main') ?? '', /Unsupported patchback branch/);
});

test('reserved branches fail closed on the wrong release-line route', () => {
  assert.match(
    routeError('staged/v5.0', 'releases/v5.1') ?? '',
    /must target releases\/v5\.0, not releases\/v5\.1/,
  );
  assert.match(routeError('prerelease', 'releases/v5.1') ?? '', /cannot target release line/);
  assert.match(routeError('patchbacks/v5.1.2', 'releases/v5.1') ?? '', /cannot target release line/);
  assert.match(
    routeError('staged/v5.1', 'releases/v5.1', 'contributor/lab-02') ?? '',
    /must come from fablebookjs\/lab-02/,
  );
});

test('the GitHub handler validates untrusted pull-request branch data', async () => {
  const runtime: Pick<GitHubHandlerRuntime, 'context'> = {
    context: {
      eventName: 'pull_request_target',
      payload: {
        pull_request: {
          base: { ref: 'main' },
          head: { ref: 'releases/v5.1', repo: { full_name: repository } },
        },
      },
      repo: { owner: 'fablebookjs', repo: 'lab-02' },
    },
  };
  await assert.rejects(checkRoute(runtime), /cannot target development line main/);
});

test('the readiness workflow skips route checks for ordinary topic bases', async () => {
  const workflow = await readFile(
    join(repositoryRoot, '.github/workflows/pull-request-description-check.yml'),
    'utf8',
  );
  assert.match(workflow, /\n  route:\n    if: >-\n/);
  assert.match(workflow, /github\.event\.pull_request\.base\.ref == 'main'/);
  assert.match(workflow, /startsWith\(github\.event\.pull_request\.base\.ref, 'releases\/v'\)/);
  assert.match(workflow, /name: PR route is allowed/);
});
