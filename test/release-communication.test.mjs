import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  composeMigrationRecords,
  deriveReleaseChanges,
  extractReleaseRecordChanges,
  loadMigrationRecords,
  migrationRecordDirectory,
  parseMigrationRecord,
  releaseRecordPath,
  renderReleaseRecord,
} from '../scripts/release-communication.mjs';

const oid = (character) => character.repeat(40);

const migration = ({ priority, title = 'Move to the new API' }) => `---
priority: ${priority}
---
# ${title}

## Who is affected

Projects using the old API.

## How to migrate

Replace the old call with the new call.
`;

test('one release-history interpretation renders the durable per-version record', () => {
  const changes = deriveReleaseChanges({
    commits: [
      {
        associatedPulls: [
          {
            base: {
              ref: 'releases/v2.1',
              repo: { full_name: 'fablebookjs/lab-02' },
            },
            merge_commit_sha: oid('a'),
            merged_at: '2026-07-28T12:00:00Z',
            number: 41,
            title: 'Add portable stories',
          },
        ],
        oid: oid('a'),
        subject: 'Merge pull request #41',
      },
      {
        associatedPulls: [],
        oid: oid('b'),
        subject: 'fix: correct the release branch directly',
      },
    ],
    line: 'v2.1',
  });

  assert.equal(releaseRecordPath('2.1.0'), 'releases/v2.1.0.md');
  assert.equal(
    renderReleaseRecord({ changes, version: '2.1.0' }),
    `<!-- fablebook:release-record=v2 -->
# v2.1.0 changes

- [Add portable stories](https://github.com/fablebookjs/lab-02/pull/41)
- [fix: correct the release branch directly](https://github.com/fablebookjs/lab-02/commit/${oid('b')})
`
  );
  assert.equal(
    extractReleaseRecordChanges({
      source: renderReleaseRecord({ changes, version: '2.1.0' }),
      version: '2.1.0',
    }),
    `- [Add portable stories](https://github.com/fablebookjs/lab-02/pull/41)
- [fix: correct the release branch directly](https://github.com/fablebookjs/lab-02/commit/${oid('b')})`
  );
});

test('authorized legacy release records remain readable for recovery', () => {
  const source = `<!-- fablebook:release-record=v1 -->
# v2.0.3

> Generated from the exact release-line history. Do not edit manually.

## Changes

- [An authorized change](https://github.com/fablebookjs/lab-02/pull/44)
`;

  assert.equal(
    extractReleaseRecordChanges({ source, version: '2.0.3' }),
    '- [An authorized change](https://github.com/fablebookjs/lab-02/pull/44)'
  );
});

test('an empty release record uses the same concise visible format', () => {
  assert.equal(
    renderReleaseRecord({ changes: [], version: '2.1.1' }),
    `<!-- fablebook:release-record=v2 -->
# v2.1.1 changes

No changes were recorded for this release.
`
  );
});

test('ambiguous PR metadata falls back to the direct commit identity', () => {
  const pull = {
    base: { ref: 'releases/v2.1', repo: { full_name: 'fablebookjs/lab-02' } },
    merge_commit_sha: oid('c'),
    merged_at: '2026-07-28T12:00:00Z',
    title: 'Ambiguous title',
  };
  const [change] = deriveReleaseChanges({
    commits: [
      {
        associatedPulls: [
          { ...pull, number: 42 },
          { ...pull, number: 43 },
        ],
        oid: oid('c'),
        subject: 'Merge two histories directly',
      },
    ],
    line: 'v2.1',
  });
  assert.equal(change.key, `commit:${oid('c')}`);
  assert.equal(change.title, 'Merge two histories directly');
});

test('migration records accept free-text priorities and compose without rendering them', () => {
  const records = composeMigrationRecords([
    {
      filename: 'z-last-filename.md',
      source: migration({ priority: 'wave 2', title: 'A shared title' }),
    },
    {
      filename: 'a-first-filename.md',
      source: migration({ priority: 'wave 2', title: 'A shared title' }),
    },
    {
      filename: 'later-natural-number.md',
      source: migration({ priority: 'wave 10' }),
    },
  ]);

  assert.deepEqual(
    records.map(({ filename }) => filename),
    ['a-first-filename.md', 'z-last-filename.md', 'later-natural-number.md']
  );
  assert.equal(Object.hasOwn(records[0], 'priority'), false);
  assert.doesNotMatch(records.map(({ body }) => body).join('\n'), /priority:/);
});

test('migration records require the agreed template fields but not fixed priority labels', () => {
  const parsed = parseMigrationRecord({
    filename: 'adopt-portable-stories.md',
    source: `${migration({ priority: 'do this whenever it makes sense' })}
## Automatic migration

Run the migration command.
`,
  });
  assert.equal(parsed.priority, 'do this whenever it makes sense');

  assert.throws(
    () =>
      parseMigrationRecord({
        filename: 'missing-priority.md',
        source: migration({ priority: 'temporary' }).replace(
          'priority: temporary\n',
          ''
        ),
      }),
    /missing required priority/
  );
  assert.throws(
    () =>
      parseMigrationRecord({
        filename: 'missing-instructions.md',
        source: migration({ priority: 'first' }).replace(
          'Replace the old call with the new call.',
          ''
        ),
      }),
    /nonempty "How to migrate"/
  );
  assert.throws(
    () =>
      parseMigrationRecord({
        filename: 'Needs_Renaming.md',
        source: migration({ priority: 'first' }),
      }),
    /lowercase hyphenated/
  );
});

test('a target release line loads its tiny migration files in composed order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fablebook-migration-records-'));
  try {
    const directory = join(root, migrationRecordDirectory('v11.0'));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'remove-obsolete-option.md'),
      migration({ priority: '10 - cleanup' }),
      'utf8'
    );
    await writeFile(
      join(directory, 'update-framework-config.md'),
      migration({ priority: '2 - setup' }),
      'utf8'
    );

    const records = await loadMigrationRecords(root, 'v11.0');
    assert.deepEqual(
      records.map(({ filename }) => filename),
      ['update-framework-config.md', 'remove-obsolete-option.md']
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
