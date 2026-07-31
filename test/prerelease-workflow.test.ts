import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const workflow = (name: string): Promise<string> =>
  readFile(join(repositoryRoot, '.github', 'workflows', name), 'utf8');

test('ordinary prerelease proposal entrypoints use trusted main and one writer queue', async () => {
  const [maintenance, signal, check] = await Promise.all([
    workflow('maintain-prerelease-proposal.yml'),
    workflow('prerelease-proposal-signal.yml'),
    workflow('prerelease-proposal-check.yml'),
  ]);

  assert.match(maintenance, /push:\n    branches:\n      - main/);
  assert.match(maintenance, /group: release-proposal-writes/);
  assert.match(maintenance, /ref: main/);
  assert.match(maintenance, /prerelease-proposal\/prepare\.ts/);
  assert.match(maintenance, /prerelease-proposal\/apply\.ts/);
  assert.match(maintenance, /environment: release-github/);

  assert.match(signal, /pull_request_target:/);
  assert.match(signal, /types:\n      - closed/);
  assert.match(signal, /ref: main/);
  assert.match(signal, /release-proposal\/signal\.ts/);
  assert.doesNotMatch(signal, /pull_request\.head|github\.head_ref|path: snapshot/);

  assert.match(check, /github\.head_ref == 'prerelease'/);
  assert.match(check, /name: prerelease proposal uses current main/);
  assert.match(check, /prerelease-proposal\/check-pr\.ts/);
});

test('direct prerelease authority paths feed the same publication signal', async () => {
  const [cut, phase, publication] = await Promise.all([
    workflow('cut-release-line.yml'),
    workflow('enter-prerelease-phase.yml'),
    workflow('publish-prerelease.yml'),
  ]);

  const applyStart = cut.indexOf('\n  apply:');
  assert.ok(applyStart > 0);
  const cutPreparation = cut.slice(0, applyStart);
  const cutApplication = cut.slice(applyStart);
  assert.doesNotMatch(cutPreparation, /release-cut\/authority\.json/);
  assert.match(cutApplication, /release-cut\/authority\.json/);
  assert.doesNotMatch(cut, /bootstrap-authority\.json/);
  assert.match(cut, /name: prerelease-authority-\$\{\{ github\.run_id \}\}/);

  assert.match(phase, /name: 'MANUAL - Prerelease: Enter phase'/);
  assert.match(phase, /run-name: 'Enter \$\{\{ inputs\.phase \}\} prerelease phase'/);
  assert.match(phase, /options:\n          - beta\n          - rc/);
  assert.match(phase, /group: release-proposal-writes/);
  assert.match(phase, /prerelease-phase-entry\/prepare\.ts/);
  assert.match(phase, /prerelease-phase-entry\/apply\.ts/);
  assert.match(phase, /name: prerelease-authority-\$\{\{ github\.run_id \}\}/);

  assert.doesNotMatch(publication, /bootstrap-authority|Normalize the release-cut/);
});

test('one sealed workflow publishes every accepted prerelease authority', async () => {
  const [entrypoint, source] = await Promise.all([
    workflow('publish-stable-release.yml'),
    workflow('publish-prerelease.yml'),
  ]);
  const publishStart = source.indexOf('\n  publish:');
  const reconcileStart = source.indexOf('\n  reconcile-next:');
  const finalizeStart = source.indexOf('\n  finalize:');
  assert.ok(
    publishStart > 0 &&
      reconcileStart > publishStart &&
      finalizeStart > reconcileStart,
  );

  assert.match(entrypoint, /'Prerelease: Trigger publication'/);
  assert.match(entrypoint, /'MANUAL - Prerelease: Enter phase'/);
  assert.match(entrypoint, /'MANUAL - Release: Start new release line'/);
  assert.match(entrypoint, /uses: \.\/\.github\/workflows\/publish-prerelease\.yml/);
  assert.match(entrypoint, /id-token: write/);
  assert.match(source, /workflow_call:/);
  assert.match(source, /group: prerelease-publication/);
  assert.match(source, /inspect-authority\.ts/);
  assert.match(source, /npm ci --ignore-scripts --no-audit --no-fund\n          npm run check/);
  assert.match(source, /id-token: write/);
  assert.match(source, /prerelease-publication\/publish\.ts/);
  assert.match(source, /environment: npm-promotion/);
  assert.match(source, /NPM_PROMOTION_TOKEN/);
  assert.match(source, /prerelease-publication\/reconcile-next\.ts/);
  assert.match(source, /environment: release-github/);
  assert.match(source, /prerelease-publication\/finalize\.ts/);
  assert.match(source, /prerelease-publication\/check-completion\.ts/);

  const privilegedJobs = source.slice(publishStart);
  assert.doesNotMatch(
    privilegedJobs,
    /path: snapshot|working-directory: snapshot|npm ci|npm run check/,
  );
  assert.match(privilegedJobs, /EXPECTED_SNAPSHOT/);
  assert.match(privilegedJobs, /EXPECTED_VERSION/);
  assert.match(privilegedJobs, /TARBALLS/);
});

test('activated workflows stay pinned to Node 24 and immutable Actions', async () => {
  const names = [
    'cut-release-line.yml',
    'enter-prerelease-phase.yml',
    'maintain-prerelease-proposal.yml',
    'prerelease-proposal-check.yml',
    'prerelease-proposal-signal.yml',
    'publish-prerelease.yml',
  ];
  for (const name of names) {
    const source = await workflow(name);
    assert.doesNotMatch(source, /uses: [^\s]+@v\d/);
    if (source.includes('actions/setup-node@')) {
      assert.match(source, /node-version: 24/);
    }
    assert.doesNotMatch(source, /3\.1\.0-alpha\.0|backfill|import.*legacy/i);
  }
});
