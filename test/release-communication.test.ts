import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';
import {
  composeMigrationRecords,
  deriveReleaseChanges,
  extractReleaseRecordChanges,
  loadMigrationRecords,
  migrationRecordsForVersion,
  migrationRecordDirectory,
  parseReleaseRecordChanges,
  parseMigrationRecord,
  releaseRecordPath,
  renderReleaseRecord,
} from '../scripts/shared/release-communication/records.ts';
import type { ReleaseHistoryPull } from '../scripts/shared/release-communication/records.ts';

const oid = (character: string): string => character.repeat(40);

const historyPull = ({
  baseBranch = 'releases/v2.1',
  labels = [],
  mergeCommitOid,
  number,
  title,
}: {
  baseBranch?: string;
  labels?: readonly string[];
  mergeCommitOid: string;
  number: number;
  title: string;
}): ReleaseHistoryPull => ({
  baseBranch,
  canonicalRepository: true,
  labels,
  mergeCommitOid,
  merged: true,
  number,
  title,
});

const migration = ({
  introducedIn = '2.1.0',
  priority,
  title = 'Move to the new API',
}: {
  introducedIn?: string;
  priority: string;
  title?: string;
}): string => `---
introduced-in: ${introducedIn}
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
          historyPull({
            mergeCommitOid: oid('a'),
            number: 41,
            title: 'Add portable stories',
          }),
        ],
        oid: oid('a'),
        subject: 'Merge pull request #41',
      },
      {
        associatedPulls: [],
        oid: oid('b'),
        subject: 'fix: correct the release branch directly',
      },
      {
        associatedPulls: [
          historyPull({
            labels: ['release-note:skip'],
            mergeCommitOid: oid('c'),
            number: 42,
            title: 'Refine internal release accounting',
          }),
        ],
        oid: oid('c'),
        subject: 'Merge pull request #42',
      },
    ],
    line: 'v2.1',
  });

  assert.equal(changes.length, 3);
  assert.equal(changes[2]?.releaseNoteSkip, true);
  assert.equal(releaseRecordPath('2.1.0'), 'releases/v2.1.0.md');
  assert.equal(
    renderReleaseRecord({ changes, version: '2.1.0' }),
    `# v2.1.0 changes

- [Add portable stories](https://github.com/fablebookjs/lab-02/pull/41)
- [fix: correct the release branch directly](https://github.com/fablebookjs/lab-02/commit/${oid('b')})
`
  );
  assert.deepEqual(
    parseReleaseRecordChanges({
      source: renderReleaseRecord({ changes, version: '2.1.0' }),
      version: '2.1.0',
    }),
    [
      {
        title: 'Add portable stories',
        url: 'https://github.com/fablebookjs/lab-02/pull/41',
      },
      {
        title: 'fix: correct the release branch directly',
        url: `https://github.com/fablebookjs/lab-02/commit/${oid('b')}`,
      },
    ]
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

test('an entirely excluded release record uses the same concise visible format', () => {
  assert.equal(
    renderReleaseRecord({
      changes: [
        {
          key: 'pr:42',
          oid: oid('c'),
          qaSkip: false,
          releaseNoteSkip: true,
          title: 'Refine internal release accounting',
          url: 'https://github.com/fablebookjs/lab-02/pull/42',
        },
      ],
      version: '2.1.1',
    }),
    `# v2.1.1 changes

No changes were recorded for this release.
`
  );
});

test('the normalized checked-in release record omits its excluded change', async () => {
  const source = await readFile(
    join(repositoryRoot, 'releases/v2.0.3.md'),
    'utf8'
  );
  assert.deepEqual(
    parseReleaseRecordChanges({ source, version: '2.0.3' }),
    [
      {
        title: 'Add count-based summary formatting',
        url: 'https://github.com/fablebookjs/lab-02/pull/44',
      },
    ]
  );
  assert.doesNotMatch(source, /Document adopting count-based summaries|pull\/46/);
});

test('an authorized historical release record remains readable for recovery', () => {
  const source = `<!-- fablebook:release-record=v1 -->
# v2.0.3

> Generated from the exact release-line history. Do not edit manually.

## Changes

- [Add count-based summary formatting](https://github.com/fablebookjs/lab-02/pull/44)
- [Document adopting count-based summaries](https://github.com/fablebookjs/lab-02/pull/46)
`;

  assert.equal(
    extractReleaseRecordChanges({ source, version: '2.0.3' }),
    `- [Add count-based summary formatting](https://github.com/fablebookjs/lab-02/pull/44)
- [Document adopting count-based summaries](https://github.com/fablebookjs/lab-02/pull/46)`
  );
  assert.throws(
    () => extractReleaseRecordChanges({ source, version: '2.0.2' }),
    /Expected the generated v2.0.2 release record/
  );
});

test('ambiguous or malformed PR metadata fails before classification', () => {
  const pull = {
    baseBranch: 'releases/v2.1',
    canonicalRepository: true,
    labels: [],
    mergeCommitOid: oid('c'),
    merged: true,
    title: 'Ambiguous title',
  };
  assert.throws(
    () =>
      deriveReleaseChanges({
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
      }),
    /ambiguous pull request metadata/
  );
  assert.throws(
    () =>
      deriveReleaseChanges({
        commits: [
          {
            associatedPulls: [{ ...pull, labels: [''], number: 42 }],
            oid: oid('c'),
            subject: 'Merge one history',
          },
        ],
        line: 'v2.1',
      }),
    /malformed release metadata/
  );
});

test('source PR opt-out labels classify release notes and QA independently', () => {
  const combinations = [
    { labels: [], qaSkip: false, releaseNoteSkip: false },
    {
      labels: ['release-note:skip'],
      qaSkip: false,
      releaseNoteSkip: true,
    },
    {
      labels: ['qa:skip'],
      qaSkip: true,
      releaseNoteSkip: false,
    },
    {
      labels: ['qa:skip', 'release-note:skip'],
      qaSkip: true,
      releaseNoteSkip: true,
    },
  ];
  for (const [index, expected] of combinations.entries()) {
    const changeOid = String(index + 1).repeat(40);
    const [change] = deriveReleaseChanges({
      commits: [
        {
          associatedPulls: [
            historyPull({
              labels: expected.labels,
              mergeCommitOid: changeOid,
              number: index + 1,
              title: `Change ${index + 1}`,
            }),
          ],
          oid: changeOid,
          subject: `Merge pull request #${index + 1}`,
        },
      ],
      line: 'v2.1',
    });
    assert.ok(change);
    assert.equal(change.qaSkip, expected.qaSkip);
    assert.equal(change.releaseNoteSkip, expected.releaseNoteSkip);
  }
});

test('migration records accept free-text priorities and compose without rendering them', () => {
  const records = composeMigrationRecords(
    [
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
    ],
    'v2.1',
  );

  assert.deepEqual(
    records.map(({ filename }) => filename),
    ['a-first-filename.md', 'z-last-filename.md', 'later-natural-number.md']
  );
  const firstRecord = records[0];
  assert.ok(firstRecord);
  assert.equal(firstRecord.introducedIn, '2.1.0');
  assert.equal(Object.hasOwn(firstRecord, 'priority'), false);
  assert.doesNotMatch(records.map(({ body }) => body).join('\n'), /priority:/);
});

test('introduced-in selects exact Migration membership without later repetition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fablebook-exact-migrations-'));
  try {
    const directory = join(root, migrationRecordDirectory('v5.0'));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'adopt-alpha-api.md'),
      migration({ introducedIn: '5.0.0', priority: 'first' }),
      'utf8',
    );
    await writeFile(
      join(directory, 'adopt-patch-api.md'),
      migration({ introducedIn: '5.0.1', priority: 'second' }),
      'utf8',
    );
    const records = await loadMigrationRecords(root, 'v5.0');
    const initial = migrationRecordsForVersion(records, '5.0.0');
    const patch = migrationRecordsForVersion(records, '5.0.1');
    assert.deepEqual(initial.map(({ filename }) => filename), ['adopt-alpha-api.md']);
    assert.deepEqual(patch.map(({ filename }) => filename), ['adopt-patch-api.md']);

    assert.doesNotMatch(
      patch.map(({ filename }) => filename).join('\n'),
      /adopt-alpha-api/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
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
  assert.equal(parsed.introducedIn, '2.1.0');

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
      migration({ introducedIn: '11.0.1', priority: '10 - cleanup' }),
      'utf8'
    );
    await writeFile(
      join(directory, 'update-framework-config.md'),
      migration({ introducedIn: '11.0.0', priority: '2 - setup' }),
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
