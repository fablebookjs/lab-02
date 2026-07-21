import assert from 'node:assert/strict';
import test from 'node:test';

import {
  developmentCommitMessage,
  deriveCutVersions,
  nextReleaseVersion,
  parseDevelopmentCommitMessage,
  parseDevelopmentVersion,
  parseProposalMessage,
  planProposalMaintenance,
  proposalCommitMessage,
  refreshReleasePrBody,
} from '../scripts/release-proposal-core.mjs';
import { createRefUpdate } from '../scripts/release-proposal-github.mjs';

const lineState = (overrides = {}) => ({
  completedOid: null,
  completedVersion: null,
  latestClosedPr: null,
  line: 'v1.0',
  openPr: null,
  releaseOid: '1'.repeat(40),
  staged: null,
  ...overrides,
});

test('a cut strips alpha, beta, or rc and advances only minor or major development', () => {
  assert.deepEqual(deriveCutVersions('10.4.0-beta.3', 'minor'), {
    developmentVersion: '10.5.0-alpha.0',
    line: 'v10.4',
    releaseVersion: '10.4.0',
  });
  assert.deepEqual(deriveCutVersions('10.4.0-rc.7', 'major'), {
    developmentVersion: '11.0.0-alpha.0',
    line: 'v10.4',
    releaseVersion: '10.4.0',
  });
  assert.equal(parseDevelopmentVersion('1.2.0-alpha.0').prerelease, 'alpha');
  assert.throws(() => deriveCutVersions('10.4.0', 'minor'));
  assert.throws(() => deriveCutVersions('10.4.1-alpha.0', 'minor'));
  assert.throws(() => deriveCutVersions('10.4.0-alpha.0', 'patch'));
});

test('development commits retain the durable release-cut boundary', () => {
  const sourceOid = '1'.repeat(40);
  const message = developmentCommitMessage({
    line: 'v10.4',
    sourceOid,
    version: '10.5.0-alpha.0',
  });
  assert.deepEqual(parseDevelopmentCommitMessage(message), {
    line: 'v10.4',
    sourceOid,
    version: '10.5.0-alpha.0',
  });
});

test('the first proposal is stable zero and later proposals advance only patch', () => {
  assert.equal(nextReleaseVersion('v10.4', null), '10.4.0');
  assert.equal(nextReleaseVersion('v10.4', '10.4.7'), '10.4.8');
  assert.throws(() => nextReleaseVersion('v10.4', '10.5.0'));
  assert.throws(() =>
    parseProposalMessage(
      proposalCommitMessage({
        attempt: 'test',
        line: 'v10.4',
        sourceOid: '1'.repeat(40),
        version: '10.5.0',
      })
    )
  );
});

test('an open proposal refreshes in place when its release source advances', () => {
  const [action] = planProposalMaintenance([
    lineState({
      openPr: { number: 12 },
      releaseOid: '2'.repeat(40),
      staged: {
        oid: '3'.repeat(40),
        sourceOid: '1'.repeat(40),
        version: '1.0.0',
      },
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'refresh',
    line: 'v1.0',
    openPr: { number: 12 },
    reason: 'release line advanced',
    version: '1.0.0',
  });
});

test('refreshing a proposal body updates only its exact source line', () => {
  const oldSource = '1'.repeat(40);
  const newSource = '2'.repeat(40);
  const body = [
    'Release proposal for **1.0.0**.',
    '',
    `Source: \`${oldSource}\``,
    '',
    'Merging this PR authorizes publication of its exact merge commit.',
    '',
    'This clean proposal supersedes #2.',
  ].join('\n');

  assert.equal(
    refreshReleasePrBody(body, { sourceOid: newSource, version: '1.0.0' }),
    body.replace(oldSource, newSource)
  );
  assert.throws(() =>
    refreshReleasePrBody('manually replaced body', {
      sourceOid: newSource,
      version: '1.0.0',
    })
  );
});

test('a closed unmerged proposal gets a clean draft replacement', () => {
  const [action] = planProposalMaintenance([
    lineState({ latestClosedPr: { merged: false, number: 15, version: '1.0.0' } }),
  ]);
  assert.deepEqual(action, {
    kind: 'recreate',
    line: 'v1.0',
    reason: 'the previous proposal was closed unmerged',
    supersededPr: 15,
    version: '1.0.0',
  });
});

test('a current staged proposal recovers an interrupted PR creation without a new commit', () => {
  const [action] = planProposalMaintenance([
    lineState({
      staged: {
        oid: '3'.repeat(40),
        sourceOid: '1'.repeat(40),
        version: '1.0.0',
      },
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'open',
    line: 'v1.0',
    reason: 'current staged proposal has no open PR',
    version: '1.0.0',
  });
});

test('a fresh replacement proposal recovers PR creation after the previous PR closed', () => {
  const [action] = planProposalMaintenance([
    lineState({
      latestClosedPr: {
        headOid: '2'.repeat(40),
        merged: false,
        number: 15,
        version: '1.0.0',
      },
      staged: {
        oid: '3'.repeat(40),
        sourceOid: '1'.repeat(40),
        version: '1.0.0',
      },
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'open',
    line: 'v1.0',
    reason: 'fresh replacement proposal has no open PR',
    version: '1.0.0',
  });
});

test('a merged proposal is not recreated while its release completion is pending', () => {
  const releaseOid = '4'.repeat(40);
  const [action] = planProposalMaintenance([
    lineState({
      latestClosedPr: {
        mergeCommitOid: releaseOid,
        merged: true,
        number: 16,
        version: '1.0.0',
      },
      releaseOid,
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'none',
    line: 'v1.0',
    reason: 'merged proposal is awaiting release completion',
  });
});

test('late work waits for the already-authorized release version to complete', () => {
  const [action] = planProposalMaintenance([
    lineState({
      completedOid: '4'.repeat(40),
      completedVersion: '1.0.0',
      latestClosedPr: {
        mergeCommitOid: '5'.repeat(40),
        merged: true,
        number: 17,
        version: '1.0.1',
      },
      releaseOid: '6'.repeat(40),
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'none',
    line: 'v1.0',
    reason: 'merged proposal is awaiting release completion',
  });
});

test('an older completed line goes dormant but new work activates it again', () => {
  const completedOid = '5'.repeat(40);
  const staged = {
    oid: '6'.repeat(40),
    sourceOid: completedOid,
    version: '1.0.1',
  };
  const dormant = planProposalMaintenance([
    lineState({
      completedOid,
      completedVersion: '1.0.0',
      openPr: { number: 20 },
      releaseOid: completedOid,
      staged,
    }),
    lineState({ line: 'v1.1', releaseOid: '7'.repeat(40) }),
  ])[0];
  assert.equal(dormant.kind, 'dormant');

  const active = planProposalMaintenance([
    lineState({
      completedOid,
      completedVersion: '1.0.0',
      releaseOid: '8'.repeat(40),
    }),
    lineState({ line: 'v1.1', releaseOid: '7'.repeat(40) }),
  ])[0];
  assert.deepEqual(active, {
    kind: 'create',
    line: 'v1.0',
    reason: 'line has unreleased work',
    version: '1.0.1',
  });
});

test('the newest completed line remains active for its next patch', () => {
  const completedOid = '9'.repeat(40);
  const [action] = planProposalMaintenance([
    lineState({
      completedOid,
      completedVersion: '1.0.3',
      releaseOid: completedOid,
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'create',
    line: 'v1.0',
    reason: 'newest line stays active',
    version: '1.0.4',
  });
});

test('GitHub mutations accept only main and canonical release ref names', () => {
  assert.equal(
    createRefUpdate({ afterOid: '1'.repeat(40), name: 'refs/heads/releases/v10.4' }).name,
    'refs/heads/releases/v10.4'
  );
  assert.throws(() =>
    createRefUpdate({ afterOid: '1'.repeat(40), name: 'refs/heads/releases/v10.4/extra' })
  );
  assert.throws(() =>
    createRefUpdate({ afterOid: '1'.repeat(40), name: 'refs/heads/feature/release' })
  );
});
