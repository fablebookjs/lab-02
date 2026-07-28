import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  average,
  count,
  formatAverageSummary,
  formatCountSummary,
  formatSummary,
  total,
} from '@fablebook/lab-02-addon';
import { add, normalizeLabel, normalizeLabels } from '@fablebook/lab-02-core';

import { listPublicPackages, repositoryRoot } from '../scripts/list-public-packages.mjs';

const packages = await listPublicPackages();
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const pullRequestDescriptionWorkflow = await readFile(
  join(repositoryRoot, '.github/workflows/pull-request-description-check.yml'),
  'utf8'
);
const releaseProposalController = await readFile(
  join(repositoryRoot, 'scripts/release-proposal.mjs'),
  'utf8'
);

test('the complete public workspace set is discovered in stable order', () => {
  assert.deepEqual(
    packages.map(({ name }) => name),
    ['@fablebook/lab-02-addon', '@fablebook/lab-02-core']
  );
});

test('all public packages and internal dependencies use the lockstep version', () => {
  for (const pkg of packages) {
    assert.equal(pkg.version, rootManifest.version, `${pkg.name} diverged from the root version`);
  }

  const addon = packages.find(({ name }) => name === '@fablebook/lab-02-addon');
  assert.equal(
    addon.manifest.dependencies['@fablebook/lab-02-core'],
    rootManifest.version,
    'the addon-to-core dependency must be exact and lockstep'
  );
});

test('the compiled addon exercises the compiled core package', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(formatSummary(' Demo ', [2, 3]), 'demo:5');
});

test('the core label API accepts locale options', () => {
  assert.equal(normalizeLabel(' I ', { locale: 'tr' }), 'ı');
});

test('the trusted PR description check requires highlights on every canonical release line', () => {
  assert.match(pullRequestDescriptionWorkflow, /pull_request_target:/);
  assert.match(pullRequestDescriptionWorkflow, /PR_HEAD_REPOSITORY:/);
  assert.match(pullRequestDescriptionWorkflow, /staged\/\$\{line\[1\]\}/);
  assert.match(pullRequestDescriptionWorkflow, /fablebook:release-highlights:start/);
  assert.match(pullRequestDescriptionWorkflow, /fablebook:release-highlights=empty/);
});

test('newly uploaded proposals render from the prepared local content tree', () => {
  assert.match(
    releaseProposalController,
    /contentOid = proposalOid[\s\S]*publicPackagesAt\(contentOid\)/
  );
  assert.match(
    releaseProposalController,
    /uploadedProposalOid,\s+transition\.proposalOid\s+\)/
  );
  assert.match(
    releaseProposalController,
    /contentOid: action\.proposalOid,[\s\S]*proposalOid: uploadedProposalOid/
  );
  assert.match(
    releaseProposalController,
    /createReleasePr\(token, action, uploadedProposalOid, action\.proposalOid\)/
  );
});

test('summary formatting passes its locale to label normalization', () => {
  assert.equal(formatSummary(' I ', [2, 3], { locale: 'tr' }), 'ı:5');
});

test('average summaries handle populated and empty values', () => {
  assert.equal(average([2, 4]), 3);
  assert.equal(average([]), undefined);
  assert.equal(formatAverageSummary(' Demo ', [2, 4]), 'demo:3');
  assert.equal(formatAverageSummary(' Demo ', []), 'demo:n/a');
});

test('count summaries report the number of values', () => {
  assert.equal(count([2, 4, 8]), 3);
  assert.equal(count([]), 0);
  assert.equal(formatCountSummary(' Items ', [2, 4, 8]), 'items:3');
});

test('label collections share one locale-aware normalization pass', () => {
  assert.deepEqual(normalizeLabels([' I ', ' İ '], { locale: 'tr' }), ['ı', 'i']);
});
