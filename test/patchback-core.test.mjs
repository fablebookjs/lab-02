import assert from 'node:assert/strict';
import test from 'node:test';

import {
  derivePatchbackItems,
  parsePatchbackCommitMessage,
  patchbackCommitMessage,
  patchbackExamplesComment,
  patchbackIdentity,
  previousReleaseVersion,
  renderPatchbackBody,
} from '../scripts/patchback-core.mjs';

const containsUncheckedMarkdownTask = (body) =>
  /^\s*[-*+]\s+\[ \](?:\s|$)/m.test(String(body ?? ''));

const baseMainOid = '0'.repeat(40);
const boundaryOid = '1'.repeat(40);
const directOid = '2'.repeat(40);
const squashOid = '3'.repeat(40);
const pullMergeOid = '4'.repeat(40);
const snapshotOid = '5'.repeat(40);
const directMergeOid = '6'.repeat(40);

test('patchback identity and coordination commit are version-bound', () => {
  assert.deepEqual(patchbackIdentity('10.4.3'), {
    branch: 'patchbacks/v10.4.3',
    line: 'v10.4',
    title: 'Patch back v10.4.3 to main',
  });
  assert.equal(previousReleaseVersion('10.4.0'), null);
  assert.equal(previousReleaseVersion('10.4.3'), '10.4.2');

  const message = patchbackCommitMessage({
    baseMainOid,
    boundaryOid,
    line: 'v10.4',
    snapshotOid,
    version: '10.4.3',
  });
  assert.deepEqual(parsePatchbackCommitMessage(message), {
    baseMainOid,
    boundaryOid,
    line: 'v10.4',
    snapshotOid,
    version: '10.4.3',
  });
});

test('scope preserves first-parent order and accounts for every product entry shape', () => {
  const items = derivePatchbackItems({
    commits: [
      {
        associatedPulls: [],
        oid: directOid,
        parents: [boundaryOid],
        subject: 'fix: direct release correction',
      },
      {
        associatedPulls: [
          {
            base: {
              ref: 'releases/v10.4',
              repo: { full_name: 'fablebookjs/lab-02' },
            },
            head: { repo: { full_name: 'fablebookjs/lab-02' } },
            merge_commit_sha: squashOid,
            merged_at: '2026-07-21T10:00:00Z',
            number: 73,
            title: 'fix: PR-backed release correction',
          },
        ],
        oid: squashOid,
        parents: [directOid],
        subject: 'squashed subject',
      },
      {
        associatedPulls: [
          {
            base: {
              ref: 'releases/v10.4',
              repo: { full_name: 'fablebookjs/lab-02' },
            },
            head: { repo: { full_name: 'outside/contributor-fork' } },
            merge_commit_sha: pullMergeOid,
            merged_at: '2026-07-21T11:00:00Z',
            number: 74,
            title: 'fix: merged PR correction',
          },
        ],
        oid: pullMergeOid,
        parents: [squashOid, '9'.repeat(40)],
        subject: 'Merge PR 74',
      },
      {
        associatedPulls: [],
        oid: directMergeOid,
        parents: [pullMergeOid, '7'.repeat(40)],
        subject: 'Merge a direct maintenance branch',
      },
      {
        associatedPulls: [],
        oid: snapshotOid,
        parents: [directMergeOid, '8'.repeat(40)],
        subject: 'Merge the release proposal',
      },
    ],
    line: 'v10.4',
    snapshotOid,
  });

  assert.deepEqual(
    items.map(({ command, kind, oid, pullRequest }) => ({ command, kind, oid, pullRequest })),
    [
      {
        command: `git cherry-pick ${directOid}`,
        kind: 'direct-commit',
        oid: directOid,
        pullRequest: null,
      },
      {
        command: `git cherry-pick ${squashOid}`,
        kind: 'pull-request',
        oid: squashOid,
        pullRequest: 73,
      },
      {
        command: `git cherry-pick -m 1 ${pullMergeOid}`,
        kind: 'pull-request',
        oid: pullMergeOid,
        pullRequest: 74,
      },
      {
        command: `git cherry-pick -m 1 ${directMergeOid}`,
        kind: 'direct-merge',
        oid: directMergeOid,
        pullRequest: null,
      },
    ]
  );
});

test('ambiguous PR metadata never drops a commit from scope', () => {
  const pull = (number) => ({
    base: { ref: 'releases/v10.4', repo: { full_name: 'fablebookjs/lab-02' } },
    head: { repo: { full_name: 'fablebookjs/lab-02' } },
    merge_commit_sha: directOid,
    merged_at: '2026-07-21T10:00:00Z',
    number,
    title: `PR ${number}`,
  });
  const [item] = derivePatchbackItems({
    commits: [
      {
        associatedPulls: [pull(1), pull(2)],
        oid: directOid,
        parents: [boundaryOid],
        subject: 'still included',
      },
      { oid: snapshotOid, parents: [], subject: '' },
    ],
    line: 'v10.4',
    snapshotOid,
  });
  assert.equal(item.kind, 'direct-commit');
  assert.equal(item.oid, directOid);
});

test('the generated queue is unchecked while the examples and empty path are mergeable', () => {
  const [item] = derivePatchbackItems({
    commits: [
      {
        associatedPulls: [],
        oid: directOid,
        parents: [boundaryOid],
        subject: 'fix: release only',
      },
      { oid: snapshotOid, parents: [], subject: '' },
    ],
    line: 'v10.4',
    snapshotOid,
  });
  const body = renderPatchbackBody({
    boundaryLabel: 'completed v10.4.0 snapshot',
    boundaryOid,
    items: [item],
    line: 'v10.4',
    snapshotOid,
    version: '10.4.1',
  });
  assert.equal(containsUncheckedMarkdownTask(body), true);
  assert.match(body, new RegExp(directOid));
  assert.match(body, new RegExp(`git cherry-pick ${directOid}`));
  assert.equal(containsUncheckedMarkdownTask(body.replace('- [ ]', '- [x]')), false);
  assert.equal(containsUncheckedMarkdownTask(patchbackExamplesComment()), false);

  const empty = renderPatchbackBody({
    boundaryLabel: 'release cut for v10.4',
    boundaryOid,
    items: [],
    line: 'v10.4',
    snapshotOid,
    version: '10.4.0',
  });
  assert.equal(containsUncheckedMarkdownTask(empty), false);
  assert.match(empty, /empty draft is intentionally left for a maintainer to close/);
});
