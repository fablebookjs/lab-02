import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/list-public-packages.mjs';
import {
  deriveReleasePrChanges,
  extractReleasePrCheckboxes,
  extractReleasePrIdentity,
  extractReleaseQaIssueNumber,
  renderReleasePrBody,
} from '../scripts/release-pr-body.mjs';

const template = await readFile(join(repositoryRoot, '.github/release-pr-template.md'), 'utf8');
const releaseOid = 'a'.repeat(40);
const proposalOid = 'b'.repeat(40);
const qaIssue = {
  number: 41,
  url: 'https://github.com/fablebookjs/lab-02/issues/41',
};
const initialChanges = [
  {
    key: 'pr:3',
    oid: 'c'.repeat(40),
    title: 'Fix the release fixture',
    url: 'https://github.com/fablebookjs/lab-02/pull/3',
  },
  {
    key: `commit:${'d'.repeat(40)}`,
    oid: 'd'.repeat(40),
    title: 'fix: direct release correction',
    url: `https://github.com/fablebookjs/lab-02/commit/${'d'.repeat(40)}`,
  },
];

const render = (overrides = {}) =>
  renderReleasePrBody({
    changes: initialChanges,
    line: 'v1.0',
    packageNames: ['@fablebook/lab-02-core', '@fablebook/lab-02-addon'],
    proposalOid,
    qaIssue,
    releaseOid,
    template,
    version: '1.0.0',
    ...overrides,
  });

test('the Markdown template renders linked release facts and required maintainer tasks', () => {
  const body = render();
  assert.match(body, /<!-- fablebook:release-pr=v1 -->/);
  assert.match(body, /<!-- fablebook:qa-issue=41 -->/);
  assert.deepEqual(extractReleasePrIdentity(body), {
    proposalOid,
    releaseOid,
    version: '1.0.0',
  });
  assert.match(body, new RegExp(`https://github.com/fablebookjs/lab-02/commit/${releaseOid}`));
  assert.match(body, new RegExp(`https://github.com/fablebookjs/lab-02/commit/${proposalOid}`));
  assert.match(body, /- \[ \] \[Fix the release fixture\]\(https:\/\/github\.com\/fablebookjs\/lab-02\/pull\/3\) <!-- fablebook:change=pr:3 -->/);
  assert.match(body, new RegExp(`fablebook:change=commit:${'d'.repeat(40)}`));
  assert.match(body, /<details>\n<summary>Clean-install smoke-test commands<\/summary>/);
  assert.match(body, /@fablebook\/lab-02-core@v-1\.0 @fablebook\/lab-02-addon@v-1\.0/);
  assert.match(body, /Promote latest/);
  assert.equal(extractReleaseQaIssueNumber(body), 41);
});

test('an in-place refresh preserves known checks and adds a new change unchecked', () => {
  const manuallyChecked = render()
    .replace('- [ ] [Fix the release fixture]', '- [x] [Fix the release fixture]')
    .replace(
      '- [ ] Ensure all discussions on the release have been resolved',
      '- [x] Ensure all discussions on the release have been resolved'
    );
  const newChange = {
    key: 'pr:12',
    oid: 'e'.repeat(40),
    title: 'Prevent Git fixture cleanup races',
    url: 'https://github.com/fablebookjs/lab-02/pull/12',
  };
  const refreshed = render({
    changes: [...initialChanges, newChange],
    previousBody: manuallyChecked,
    proposalOid: 'f'.repeat(40),
    releaseOid: 'e'.repeat(40),
  });
  const states = extractReleasePrCheckboxes(refreshed);
  assert.equal(states.get('change:pr:3'), true);
  assert.equal(states.get(`change:commit:${'d'.repeat(40)}`), false);
  assert.equal(states.get('change:pr:12'), false);
  assert.equal(states.get('check:discussions-resolved'), true);
  assert.equal(states.get('check:release-docs-reviewed'), false);
  assert.match(refreshed, /Proposal commit[^\n]+fffffff/);
});

test('a recreated proposal starts with fresh checks and can adopt template prose changes', () => {
  const checked = render().replaceAll('- [ ]', '- [x]');
  const refreshed = render({ previousBody: checked });
  assert.equal([...extractReleasePrCheckboxes(refreshed).values()].every(Boolean), true);

  const recreated = render({ supersededPr: 9 });
  assert.equal([...extractReleasePrCheckboxes(recreated).values()].some(Boolean), false);
  assert.match(recreated, /supersedes \[#9\]/);

  const revisedTemplate = template.replace('## Maintainer procedure', '## Release operator guide');
  assert.match(render({ template: revisedTemplate }), /## Release operator guide/);
});

test('duplicate identities and noncanonical links fail closed', () => {
  assert.throws(() => render({ changes: [...initialChanges, initialChanges[0]] }), /repeat identity/);
  assert.throws(
    () => render({ changes: [{ ...initialChanges[0], url: 'https://example.com/pull/3' }] }),
    /noncanonical pull request URL/
  );
  assert.throws(
    () => extractReleasePrCheckboxes('- [ ] A <!-- fablebook:check=same -->\n- [x] B <!-- fablebook:check=same -->'),
    /repeats checkbox identity/
  );
});

test('release history prefers one canonical merged PR and keeps direct commits visible', () => {
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

  assert.deepEqual(changes, [
    {
      key: 'pr:17',
      oid: pullOid,
      title: 'Fix QA finding',
      url: 'https://github.com/fablebookjs/lab-02/pull/17',
    },
    {
      key: `commit:${directOid}`,
      oid: directOid,
      title: 'fix: direct release correction',
      url: `https://github.com/fablebookjs/lab-02/commit/${directOid}`,
    },
  ]);
});
