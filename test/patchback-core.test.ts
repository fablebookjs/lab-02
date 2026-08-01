import assert from 'node:assert/strict';
import test from 'node:test';

import {
  derivePatchbackItems,
  parsePatchbackCommitMessage,
  PATCHBACK_BODY_MARKER,
  PATCHBACK_BODY_SCHEMA_VERSION,
  PATCHBACK_FULL_OID_PATTERN_SOURCE,
  patchbackCommitMessage,
  patchbackExamplesComment,
  patchbackIdentity,
  patchbackMigrationRecords,
  patchbackReleaseRecord,
  previousReleaseVersion,
  releaseMergerAssignee,
  renderPatchbackBody,
} from '../scripts/shared/patchback/core.ts';
import { renderReleaseRecord } from '../scripts/shared/release-communication/records.ts';
import { PILOT_REPOSITORY } from '../scripts/shared/repository.ts';

const containsUncheckedMarkdownTask = (body: unknown): boolean =>
  /^\s*[-*+]\s+\[ \](?:\s|$)/m.test(String(body ?? ''));

const baseMainOid = '0'.repeat(40);
const boundaryOid = '1'.repeat(40);
const directOid = '2'.repeat(40);
const squashOid = '3'.repeat(40);
const pullMergeOid = '4'.repeat(40);
const snapshotOid = '5'.repeat(40);
const directMergeOid = '6'.repeat(40);
const recordPath = 'releases/v10.4.3.md';
const migrationPath = 'migration-notes/v10.4/adopt-new-api.md';
const migrationSource = `---
priority: first
---
# Adopt the new API

## Who is affected

Users of the old API.

## How to migrate

Use the new API.
`;

test('patchback protocol constants describe one shared generated surface', () => {
  assert.equal(PILOT_REPOSITORY, 'fablebookjs/lab-02');
  assert.equal(
    PATCHBACK_BODY_MARKER,
    `<!-- fablebook-patchback-coordination:v${PATCHBACK_BODY_SCHEMA_VERSION} -->`
  );
  assert.match(directOid, new RegExp(`^${PATCHBACK_FULL_OID_PATTERN_SOURCE}$`));
});

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
    migrationRecordPaths: [migrationPath],
    recordPath,
    snapshotOid,
    version: '10.4.3',
  });
  assert.deepEqual(parsePatchbackCommitMessage(message), {
    baseMainOid,
    boundaryOid,
    line: 'v10.4',
    migrationRecordPaths: [migrationPath],
    recordPath,
    snapshotOid,
    version: '10.4.3',
  });
});

test('patchback release records are exact generated version files', () => {
  const content = renderReleaseRecord({ changes: [], version: '10.4.3' });
  assert.deepEqual(patchbackReleaseRecord({ source: content, version: '10.4.3' }), {
    content,
    path: recordPath,
  });
  assert.throws(
    () => patchbackReleaseRecord({ source: content, version: '10.4.2' }),
    /Expected the generated v10.4.2 release record/
  );
});

test('patchback migration records preserve exact validated source content', () => {
  assert.deepEqual(
    patchbackMigrationRecords({
      line: 'v10.4',
      records: [
        {
          filename: 'adopt-new-api.md',
          source: migrationSource,
        },
      ],
    }),
    [
      {
        content: migrationSource,
        path: migrationPath,
        title: 'Adopt the new API',
      },
    ]
  );
  assert.throws(
    () =>
      patchbackMigrationRecords({
        line: 'v10.4',
        records: [{ filename: 'adopt-new-api.md', source: '# Missing template' }],
      }),
    /must start with frontmatter/
  );
});

test('patchback assignment uses only a valid release-PR merger login', () => {
  assert.equal(
    releaseMergerAssignee({ merged_by: { login: 'release-maintainer' } }),
    'release-maintainer'
  );
  assert.equal(releaseMergerAssignee({ merged_by: null }), null);
  assert.equal(releaseMergerAssignee({ merged_by: { login: '<script>' } }), null);
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
            baseBranch: 'releases/v10.4',
            canonicalRepository: true,
            labels: [],
            mergeCommitOid: squashOid,
            merged: true,
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
            baseBranch: 'releases/v10.4',
            canonicalRepository: true,
            labels: [],
            mergeCommitOid: pullMergeOid,
            merged: true,
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
  const pull = (number: number) => ({
    baseBranch: 'releases/v10.4',
    canonicalRepository: true,
    labels: [],
    mergeCommitOid: directOid,
    merged: true,
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
  assert.ok(item);
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
  assert.ok(item);
  const body = renderPatchbackBody({
    boundaryLabel: 'completed v10.4.0 snapshot',
    boundaryOid,
    items: [item],
    line: 'v10.4',
    migrationRecords: [
      {
        path: migrationPath,
        title: 'Adopt the new API',
      },
    ],
    recordPath: 'releases/v10.4.1.md',
    snapshotOid,
    version: '10.4.1',
  });
  assert.equal(containsUncheckedMarkdownTask(body), true);
  assert.match(body, /fablebook-patchback-coordination:v3/);
  assert.match(body, new RegExp(directOid));
  assert.match(body, new RegExp(`git cherry-pick ${directOid}`));
  assert.match(body, /releases\/v10\.4\.1\.md/);
  assert.match(body, /migration-notes\/v10\.4\/adopt-new-api\.md/);
  assert.equal(containsUncheckedMarkdownTask(body.replace('- [ ]', '- [x]')), false);
  assert.equal(containsUncheckedMarkdownTask(patchbackExamplesComment()), false);

  const empty = renderPatchbackBody({
    boundaryLabel: 'release cut for v10.4',
    boundaryOid,
    items: [],
    line: 'v10.4',
    migrationRecords: [],
    recordPath: 'releases/v10.4.0.md',
    snapshotOid,
    version: '10.4.0',
  });
  assert.equal(containsUncheckedMarkdownTask(empty), false);
  assert.match(empty, /synchronized release communication above is the complete patchback/);
});
