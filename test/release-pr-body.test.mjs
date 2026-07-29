import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/list-public-packages.mjs';
import {
  deriveReleasePrChanges,
  EMPTY_RELEASE_HIGHLIGHTS,
  extractReleaseHighlights,
  extractReleasePrChanges,
  extractReleasePrCheckboxes,
  extractReleasePrIdentity,
  recoverReleaseHighlights,
  RELEASE_HIGHLIGHTS_EMPTY_MARKER,
  requireReleaseHighlights,
  renderReleasePrBody,
  selectLatestMatchingReleasePrBody,
  validateReleasePrBody,
} from '../scripts/release-pr-body.mjs';

const templateDirectory = join(repositoryRoot, '.github', 'release-templates');
const templates = {
  initial: await readFile(join(templateDirectory, 'release-pr-initial.md'), 'utf8'),
  patch: await readFile(join(templateDirectory, 'release-pr-patch.md'), 'utf8'),
};
const releaseOid = 'a'.repeat(40);
const proposalOid = 'b'.repeat(40);
const initialChanges = [
  {
    key: 'pr:3',
    oid: 'c'.repeat(40),
    qaSkip: false,
    releaseNoteSkip: false,
    title: 'Fix the release fixture',
    url: 'https://github.com/fablebookjs/lab-02/pull/3',
  },
  {
    key: 'pr:4',
    oid: 'd'.repeat(40),
    qaSkip: true,
    releaseNoteSkip: false,
    title: 'Refresh browser metadata',
    url: 'https://github.com/fablebookjs/lab-02/pull/4',
  },
  {
    key: 'pr:5',
    oid: 'e'.repeat(40),
    qaSkip: false,
    releaseNoteSkip: true,
    title: 'Simplify retry accounting',
    url: 'https://github.com/fablebookjs/lab-02/pull/5',
  },
  {
    key: 'pr:6',
    oid: 'f'.repeat(40),
    qaSkip: true,
    releaseNoteSkip: true,
    title: 'Update CI metadata',
    url: 'https://github.com/fablebookjs/lab-02/pull/6',
  },
  {
    key: `commit:${'1'.repeat(40)}`,
    oid: '1'.repeat(40),
    qaSkip: false,
    releaseNoteSkip: false,
    title: 'fix: direct release correction',
    url: `https://github.com/fablebookjs/lab-02/commit/${'1'.repeat(40)}`,
  },
];

const render = (overrides = {}) => {
  const version = overrides.version ?? '1.0.0';
  const kind = version.endsWith('.0') ? 'initial' : 'patch';
  return renderReleasePrBody({
    changes: initialChanges,
    line: 'v1.0',
    packageNames: ['@fablebook/lab-02-core', '@fablebook/lab-02-addon'],
    proposalOid,
    releaseOid,
    template: templates[kind],
    version,
    ...overrides,
  });
};

const authoredHighlights = [
  '### Faster setup',
  '',
  'New projects reach their first rendered story with fewer steps.',
].join('\n');

const writeHighlights = (body, highlights = authoredHighlights) =>
  body.replace(EMPTY_RELEASE_HIGHLIGHTS, highlights);

test('the initial-line template renders all classification combinations and blocks for release highlights', () => {
  const body = render();
  assert.match(body, /<!-- fablebook:release-pr=v7 -->/);
  assert.match(body, /<!-- fablebook:release-kind=initial -->/);
  assert.deepEqual(extractReleasePrIdentity(body), {
    proposalOid,
    releaseOid,
    version: '1.0.0',
  });
  assert.match(body, /## Release highlights/);
  assert.equal(extractReleaseHighlights(body), EMPTY_RELEASE_HIGHLIGHTS);
  assert.match(body, new RegExp(RELEASE_HIGHLIGHTS_EMPTY_MARKER));
  assert.throws(() => requireReleaseHighlights(body), /blocking empty placeholder/);
  assert.doesNotMatch(body, /## Migrations/);

  const changes = extractReleasePrChanges(body);
  assert.deepEqual(
    changes.map(({ checked, key, qaSkip, releaseNoteSkip }) => ({
      checked,
      key,
      qaSkip,
      releaseNoteSkip,
    })),
    [
      {
        checked: false,
        key: 'pr:3',
        qaSkip: false,
        releaseNoteSkip: false,
      },
      {
        checked: true,
        key: 'pr:4',
        qaSkip: true,
        releaseNoteSkip: false,
      },
      {
        checked: false,
        key: 'pr:5',
        qaSkip: false,
        releaseNoteSkip: true,
      },
      {
        checked: true,
        key: 'pr:6',
        qaSkip: true,
        releaseNoteSkip: true,
      },
      {
        checked: false,
        key: `commit:${'1'.repeat(40)}`,
        qaSkip: false,
        releaseNoteSkip: false,
      },
    ]
  );
  assert.match(body, /No manual QA required \(`qa:skip`\)/);
  assert.match(body, /Not included in public release notes \(`release-note:skip`\)/);
  assert.match(body, /\[Fix the release fixture\]\(https:\/\/github\.com\/fablebookjs\/lab-02\/pull\/3\)/);
  assert.match(body, /fablebook:check=source-metadata-current/);
  assert.match(body, /fablebook:check=release-docs-reviewed/);
});

test('the patch template omits release highlights and renders migrations only when present', () => {
  const withoutMigrations = render({ version: '1.0.1' });
  assert.match(withoutMigrations, /<!-- fablebook:release-kind=patch -->/);
  assert.doesNotMatch(withoutMigrations, /## Release highlights/);
  assert.doesNotMatch(withoutMigrations, /## Migrations/);
  assert.deepEqual(
    validateReleasePrBody({ body: withoutMigrations, version: '1.0.1' }).kind,
    'patch'
  );

  const withMigrations = render({
    migrationRecords: [
      {
        filename: 'adopt-portable-stories.md',
        title: 'Adopt portable stories',
      },
      {
        filename: 'remove-legacy-api.md',
        title: 'Remove the legacy API',
      },
    ],
    version: '1.0.1',
  });
  assert.match(withMigrations, /## Migrations/);
  assert.match(
    withMigrations,
    new RegExp(
      `https://github.com/fablebookjs/lab-02/blob/${releaseOid}/migration-notes/v1\\.0/adopt-portable-stories\\.md`
    )
  );
  assert.ok(
    withMigrations.indexOf('Adopt portable stories') <
      withMigrations.indexOf('Remove the legacy API')
  );
});

test('regeneration preserves compatible QA while resetting generated review attestations', () => {
  const checked = writeHighlights(render())
    .replace(
      '- [ ] [Fix the release fixture]',
      '- [x] [Fix the release fixture]'
    )
    .replace(
      '- [ ] Resolve all release discussions.',
      '- [x] Resolve all release discussions.'
    )
    .replace(
      '- [ ] Confirm that included change titles',
      '- [x] Confirm that included change titles'
    )
    .replace(
      '- [ ] Review the release communication',
      '- [x] Review the release communication'
    );
  const changed = [
    {
      ...initialChanges[0],
      releaseNoteSkip: true,
      title: 'Renamed release fixture fix',
    },
    {
      ...initialChanges[1],
      qaSkip: false,
    },
    {
      ...initialChanges[2],
      qaSkip: true,
    },
    ...initialChanges.slice(3),
    {
      key: 'pr:7',
      oid: '2'.repeat(40),
      qaSkip: false,
      releaseNoteSkip: false,
      title: 'Add a new release fix',
      url: 'https://github.com/fablebookjs/lab-02/pull/7',
    },
  ];
  const refreshed = render({
    changes: changed,
    previousBody: checked,
    proposalOid: '3'.repeat(40),
    releaseOid: '4'.repeat(40),
  });
  const states = extractReleasePrCheckboxes(refreshed);
  assert.equal(states.get('change:pr:3'), true);
  assert.equal(states.get('change:pr:4'), false);
  assert.equal(states.get('change:pr:5'), true);
  assert.equal(states.get('change:pr:7'), false);
  assert.equal(states.get('check:discussions-resolved'), true);
  assert.equal(states.get('check:source-metadata-current'), false);
  assert.equal(states.get('check:release-docs-reviewed'), false);
  assert.equal(requireReleaseHighlights(refreshed), authoredHighlights);
});

test('clean replacement preserves same-version release highlights but no QA state', () => {
  const predecessor = writeHighlights(render()).replaceAll('- [ ]', '- [x]');
  const recreated = render({
    previousHighlightsBody: predecessor,
    supersededPr: 9,
  });
  const states = extractReleasePrCheckboxes(recreated);
  assert.equal(states.get('change:pr:3'), false);
  assert.equal(states.get('change:pr:4'), true);
  assert.equal(states.get('check:discussions-resolved'), false);
  assert.equal(requireReleaseHighlights(recreated), authoredHighlights);
  assert.match(recreated, /supersedes \[#9\]/);
});

test('replacement chooses the highest-numbered closed predecessor for the same version', () => {
  const older = writeHighlights(render(), 'Older reasons');
  const latest = writeHighlights(render(), 'Latest reasons');
  const anotherVersion = render({ version: '1.0.1' });
  const selected = selectLatestMatchingReleasePrBody({
    pulls: [
      { body: older, number: 5, state: 'closed' },
      { body: anotherVersion, number: 20, state: 'closed' },
      { body: latest, number: 12, state: 'closed' },
      { body: latest, number: 30, state: 'open' },
    ],
    version: '1.0.0',
  });
  assert.equal(requireReleaseHighlights(selected), 'Latest reasons');
  assert.equal(
    selectLatestMatchingReleasePrBody({
      pulls: [{ body: anotherVersion, number: 20, state: 'closed' }],
      version: '1.0.0',
    }),
    ''
  );
});

test('failed release-highlight extraction falls back to the blocking placeholder', () => {
  const valid = writeHighlights(render());
  for (const body of [
    '',
    valid.replace('fablebook:release-highlights:start', 'release-highlights:start'),
    valid.replace(
      '<!-- fablebook:release-highlights:end -->',
      '<!-- fablebook:release-highlights:start -->'
    ),
    render().replace('- [ ] Replace this placeholder', '- [x] Replace this placeholder'),
  ]) {
    assert.equal(recoverReleaseHighlights(body), EMPTY_RELEASE_HIGHLIGHTS);
  }
});

test('template and generated metadata failures are detected before mutation', () => {
  assert.throws(
    () => render({ template: `${templates.initial}\n{{unknown_value}}\n` }),
    /unknown placeholder/
  );
  assert.throws(
    () =>
      render({
        template: templates.initial.replaceAll(
          '{{npm_channel}}',
          'stable channel'
        ),
      }),
    /omits placeholders: npm_channel/
  );
  assert.throws(
    () => render({ template: templates.patch }),
    /initial template is missing its canonical markers/
  );
  const malformed = render({ version: '1.0.1' }).replace(
    'release-note=include qa=required',
    'release-note=include qa=skip'
  );
  assert.throws(
    () => extractReleasePrChanges(malformed),
    /contradictory generated metadata/
  );
});

test('approval validation binds the generated shape and required attestations', () => {
  const reviewed = writeHighlights(render()).replaceAll('- [ ]', '- [x]');
  assert.deepEqual(
    validateReleasePrBody({
      body: reviewed,
      requireAttestations: true,
      version: '1.0.0',
    }).kind,
    'initial'
  );
  assert.throws(
    () =>
      validateReleasePrBody({
        body: writeHighlights(render()),
        requireAttestations: true,
        version: '1.0.0',
      }),
    /has not satisfied required check/
  );
  const older = reviewed.replace(
    'fablebook:release-pr=v7',
    'fablebook:release-pr=v6'
  );
  assert.equal(extractReleasePrIdentity(older), null);
});

test('release history requires unambiguous source metadata and defaults direct commits', () => {
  const pullOid = '7'.repeat(40);
  const directOid = '8'.repeat(40);
  const changes = deriveReleasePrChanges({
    commits: [
      {
        associatedPulls: [
          {
            base: {
              ref: 'releases/v1.0',
              repo: { full_name: 'fablebookjs/lab-02' },
            },
            labels: [{ name: 'qa:skip' }],
            merge_commit_sha: pullOid,
            merged_at: '2026-07-22T12:00:00Z',
            number: 17,
            title: 'Fix QA finding',
          },
        ],
        oid: pullOid,
        subject: 'Merge pull request #17',
      },
      {
        associatedPulls: [],
        oid: directOid,
        subject: 'fix: direct release correction',
      },
    ],
    line: 'v1.0',
  });

  assert.equal(changes[0].qaSkip, true);
  assert.equal(changes[0].releaseNoteSkip, false);
  assert.equal(changes[1].qaSkip, false);
  assert.equal(changes[1].releaseNoteSkip, false);
});
