import assert from 'node:assert/strict';
import test from 'node:test';

import {
  developmentCommitMessage,
  deriveCutVersions,
  nextReleaseVersion,
  parseDevelopmentCommitMessage,
  parseDevelopmentCommitMessageIfPresent,
  parseDevelopmentVersion,
  parsePrereleaseBootstrapCommitMessageIfPresent,
  parseProposalMessage,
  planProposalMaintenance,
  proposalCommitMessage,
  ZERO_OID,
} from '../scripts/shared/release-proposal/core.ts';
import {
  createRefUpdate,
  extractPullRequestMergeCommitOid,
  validatedPullRequestResponse,
} from '../scripts/github/release-proposal/github.ts';
import {
  cutRefUpdates,
} from '../scripts/github/release-proposal/controller.ts';

const lineState = (overrides = {}) => ({
  completedOid: null,
  latestClosedPr: null,
  line: 'v1.0',
  lineVersion: '1.0.0-alpha.0',
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
  assert.deepEqual(parseDevelopmentCommitMessageIfPresent(message), {
    line: 'v10.4',
    sourceOid,
    version: '10.5.0-alpha.0',
  });
  assert.deepEqual(parsePrereleaseBootstrapCommitMessageIfPresent(message), {
    line: 'v10.4',
    sourceOid,
    version: '10.5.0-alpha.0',
  });
  assert.equal(
    parsePrereleaseBootstrapCommitMessageIfPresent(
      message.replace('\nPrerelease-Bootstrap: next', ''),
    ),
    null,
  );
});

test('a cut atomically establishes both lines and discards the old proposal ref', () => {
  assert.deepEqual(
    cutRefUpdates({
      developmentOid: '4'.repeat(40),
      expectedPrereleaseOid: '2'.repeat(40),
      line: 'v10.4',
      proposalOid: '3'.repeat(40),
      sourceOid: '1'.repeat(40),
    }),
    [
      {
        afterOid: '1'.repeat(40),
        beforeOid: ZERO_OID,
        force: false,
        name: 'refs/heads/releases/v10.4',
      },
      {
        afterOid: '3'.repeat(40),
        beforeOid: ZERO_OID,
        force: false,
        name: 'refs/heads/staged/v10.4',
      },
      {
        afterOid: '4'.repeat(40),
        beforeOid: '1'.repeat(40),
        force: false,
        name: 'refs/heads/main',
      },
      {
        afterOid: ZERO_OID,
        beforeOid: '2'.repeat(40),
        force: true,
        name: 'refs/heads/prerelease',
      },
    ],
  );
});

test('release-cut discovery distinguishes ordinary commits from malformed metadata', () => {
  assert.equal(
    parseDevelopmentCommitMessageIfPresent('feat: an ordinary commit'),
    null
  );
  assert.throws(
    () =>
      parseDevelopmentCommitMessageIfPresent([
        'release: incomplete cut',
        '',
        'Release-Cut-Line: v10.4',
      ].join('\n')),
    /missing required Release-Cut-Source trailer/
  );
});

test('the release-line root version chooses the stable proposal successor', () => {
  assert.equal(nextReleaseVersion('v10.4', '10.4.0-alpha.7'), '10.4.0');
  assert.equal(nextReleaseVersion('v10.4', '10.4.0-beta.2'), '10.4.0');
  assert.equal(nextReleaseVersion('v10.4', '10.4.0-rc.1'), '10.4.0');
  assert.equal(nextReleaseVersion('v10.4', '10.4.7'), '10.4.8');
  assert.throws(() => nextReleaseVersion('v10.4', '10.5.0-alpha.0'));
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

test('a current proposal repairs a stale generated body without replacing its commit', () => {
  const [action] = planProposalMaintenance([
    lineState({
      openPr: { bodyCurrent: false, number: 12 },
      staged: {
        oid: '3'.repeat(40),
        sourceOid: '1'.repeat(40),
        version: '1.0.0',
      },
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'sync',
    line: 'v1.0',
    openPr: { bodyCurrent: false, number: 12 },
    reason: 'release PR body is stale',
    version: '1.0.0',
  });
});

test('a matching open patch proposal remains current from its line root version', () => {
  const [action] = planProposalMaintenance([
    lineState({
      line: 'v3.0',
      lineVersion: '3.0.0',
      openPr: { bodyCurrent: true, number: 88, replaceRequired: false },
      releaseOid: '3'.repeat(40),
      staged: {
        oid: '4'.repeat(40),
        sourceOid: '3'.repeat(40),
        version: '3.0.1',
      },
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'none',
    line: 'v3.0',
    reason: 'open proposal is current',
  });
});

test('the disposable legacy proposal is replaced cleanly', () => {
  const [action] = planProposalMaintenance([
    lineState({
      openPr: {
        bodyCurrent: false,
        number: 68,
        replaceRequired: true,
      },
      staged: {
        oid: '3'.repeat(40),
        sourceOid: '1'.repeat(40),
        version: '1.0.1',
      },
      lineVersion: '1.0.0',
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'replace',
    line: 'v1.0',
    openPr: {
      bodyCurrent: false,
      number: 68,
      replaceRequired: true,
    },
    reason: 'legacy release PR is disposable',
    supersededPr: 68,
    version: '1.0.1',
  });
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

test('a merged proposal advances from the line version before publication completes', () => {
  const releaseOid = '4'.repeat(40);
  const [action] = planProposalMaintenance([
    lineState({
      latestClosedPr: {
        mergeCommitOid: releaseOid,
        merged: true,
        number: 16,
        version: '1.0.0',
      },
      lineVersion: '1.0.0',
      releaseOid,
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'create',
    line: 'v1.0',
    reason: 'line has unreleased work',
    version: '1.0.1',
  });
});

test('late work advances from the merged line version without a completion gate', () => {
  const [action] = planProposalMaintenance([
    lineState({
      completedOid: '4'.repeat(40),
      latestClosedPr: {
        mergeCommitOid: '5'.repeat(40),
        merged: true,
        number: 17,
        version: '1.0.1',
      },
      lineVersion: '1.0.1',
      releaseOid: '6'.repeat(40),
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'create',
    line: 'v1.0',
    reason: 'line has unreleased work',
    version: '1.0.2',
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
      lineVersion: '1.0.0',
      openPr: { number: 20 },
      releaseOid: completedOid,
      staged,
    }),
    lineState({
      line: 'v1.1',
      lineVersion: '1.1.0-alpha.0',
      releaseOid: '7'.repeat(40),
    }),
  ])[0];
  assert.ok(dormant);
  assert.equal(dormant.kind, 'dormant');

  const active = planProposalMaintenance([
    lineState({
      completedOid,
      lineVersion: '1.0.0',
      releaseOid: '8'.repeat(40),
    }),
    lineState({
      line: 'v1.1',
      lineVersion: '1.1.0-alpha.0',
      releaseOid: '7'.repeat(40),
    }),
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
      lineVersion: '1.0.3',
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

test('the exact merged staged proposal is replaced before publication completes', () => {
  const completedOid = '9'.repeat(40);
  const completedProposalOid = '8'.repeat(40);
  const [action] = planProposalMaintenance([
    lineState({
      completedOid,
      latestClosedPr: {
        headOid: completedProposalOid,
        mergeCommitOid: completedOid,
        merged: true,
        number: 18,
        version: '1.0.3',
      },
      lineVersion: '1.0.3',
      releaseOid: '7'.repeat(40),
      staged: {
        oid: completedProposalOid,
        sourceOid: '6'.repeat(40),
        version: '1.0.3',
      },
    }),
  ]);
  assert.deepEqual(action, {
    kind: 'create',
    line: 'v1.0',
    reason: 'merged proposal advances to next patch',
    version: '1.0.4',
  });
});

test('an unrelated staged version mismatch still fails closed after completion', () => {
  const completedOid = '9'.repeat(40);
  assert.throws(
    () =>
      planProposalMaintenance([
        lineState({
          completedOid,
          latestClosedPr: {
            headOid: '8'.repeat(40),
            mergeCommitOid: completedOid,
            merged: true,
            number: 18,
            version: '1.0.3',
          },
          lineVersion: '1.0.3',
          releaseOid: completedOid,
          staged: {
            oid: '7'.repeat(40),
            sourceOid: '6'.repeat(40),
            version: '1.0.3',
          },
        }),
      ]),
    /v1\.0 reserves 1\.0\.3, expected 1\.0\.4/
  );
});

test('merged pull request authority comes from the GraphQL merge commit', () => {
  const oid = 'a'.repeat(40);
  assert.equal(
    extractPullRequestMergeCommitOid(
      { data: { repository: { pullRequest: { mergeCommit: { oid } } } } },
      5
    ),
    oid
  );
  assert.throws(() =>
    extractPullRequestMergeCommitOid(
      { data: { repository: { pullRequest: { mergeCommit: null } } } },
      5
    )
  );
});

test('pull request lists may omit the merge commit without weakening its type', () => {
  const response = {
    base: {
      ref: 'releases/v1.0',
      repo: { full_name: 'fablebookjs/lab-02' },
      sha: '1'.repeat(40),
    },
    body: '',
    head: {
      ref: 'staged/v1.0',
      repo: { full_name: 'fablebookjs/lab-02' },
      sha: '2'.repeat(40),
    },
    labels: [{ name: 'qa:skip' }],
    merged_at: null,
    number: 5,
    state: 'open',
    title: 'Release 1.0.0',
  };
  assert.deepEqual(validatedPullRequestResponse(response), {
    ...response,
    merge_commit_sha: null,
  });
  assert.throws(() =>
    validatedPullRequestResponse({ ...response, merge_commit_sha: 42 })
  );
  assert.throws(() => validatedPullRequestResponse({ ...response, labels: undefined }));
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
