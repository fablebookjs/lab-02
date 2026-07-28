import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOidcPublishEnvironment,
  composeGitHubReleaseBody,
  deriveReleaseAuthority,
  deriveReleaseHighlights,
  exactPublication,
  lineChannel,
  promotionDisposition,
  publicationDisposition,
  SETUP_NODE_AUTH_PLACEHOLDER,
} from '../scripts/release-publication-core.mjs';
import {
  composeMigrationRecords,
  renderReleaseRecord,
} from '../scripts/release-communication.mjs';
import { proposalCommitMessage } from '../scripts/release-proposal-core.mjs';
import {
  RELEASE_HIGHLIGHTS_END,
  RELEASE_HIGHLIGHTS_START,
  RELEASE_PR_TEMPLATE_MARKER,
} from '../scripts/release-pr-body.mjs';

const sourceOid = '1'.repeat(40);
const proposalOid = '2'.repeat(40);
const snapshotOid = '3'.repeat(40);
const treeOid = '4'.repeat(40);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const highlights = '**Worth upgrading:** The release workflow is ready to test.';
const migration = ({ priority, title }) => `---
priority: ${priority}
---
# ${title}

## Who is affected

Consumers exercising this test migration.

## How to migrate

Follow the complete instructions in the canonical Markdown record.
`;

const authorityFixture = () => ({
  headCommit: {
    message: proposalCommitMessage({
      attempt: 'test-attempt',
      line: 'v1.0',
      sourceOid,
      version: '1.0.0',
    }),
    sha: proposalOid,
    tree: { sha: treeOid },
  },
  mergeCommit: {
    parents: [{ sha: sourceOid }, { sha: proposalOid }],
    sha: snapshotOid,
    tree: { sha: treeOid },
  },
  pull: {
    base: {
      ref: 'releases/v1.0',
      repo: { full_name: 'fablebookjs/lab-02' },
      sha: sourceOid,
    },
    head: {
      ref: 'staged/v1.0',
      repo: { full_name: 'fablebookjs/lab-02' },
      sha: proposalOid,
    },
    merge_commit_sha: snapshotOid,
    merged_at: '2026-07-21T10:00:00Z',
    number: 42,
    state: 'closed',
  },
});

const registryDocument = (overrides = {}) => ({
  'dist-tags': { 'v-1.0': '1.0.0', latest: '0.9.0' },
  name: '@fablebook/lab-02-core',
  versions: {
    '1.0.0': {
      dist: { integrity },
      name: '@fablebook/lab-02-core',
      version: '1.0.0',
    },
  },
  ...overrides,
});

test('OIDC publication allows only setup-node’s inert auth placeholder', () => {
  assert.doesNotThrow(() =>
    assertOidcPublishEnvironment({
      nodeAuthToken: SETUP_NODE_AUTH_PLACEHOLDER,
      npmToken: undefined,
    })
  );
  assert.doesNotThrow(() =>
    assertOidcPublishEnvironment({ nodeAuthToken: undefined, npmToken: undefined })
  );
  assert.throws(() =>
    assertOidcPublishEnvironment({ nodeAuthToken: 'real-token', npmToken: undefined })
  );
  assert.throws(() =>
    assertOidcPublishEnvironment({ nodeAuthToken: undefined, npmToken: 'real-token' })
  );
});

test('a canonical merge commit is the sole stable publication authority', () => {
  assert.deepEqual(deriveReleaseAuthority(authorityFixture()), {
    channel: 'v-1.0',
    line: 'v1.0',
    proposalOid,
    pullRequest: 42,
    snapshotOid,
    sourceOid,
    version: '1.0.0',
  });
  assert.equal(lineChannel('v10.4'), 'v-10.4');

  const wrongParents = authorityFixture();
  wrongParents.mergeCommit.parents.reverse();
  assert.throws(() => deriveReleaseAuthority(wrongParents));

  const wrongTree = authorityFixture();
  wrongTree.mergeCommit.tree.sha = '5'.repeat(40);
  assert.throws(() => deriveReleaseAuthority(wrongTree));
});

test('release highlights remain bound to the authorized proposal', () => {
  const authority = deriveReleaseAuthority(authorityFixture());
  const body = `${RELEASE_PR_TEMPLATE_MARKER}
<!-- fablebook:proposal=${proposalOid} source=${sourceOid} version=1.0.0 -->
${RELEASE_HIGHLIGHTS_START}
${highlights}
${RELEASE_HIGHLIGHTS_END}`;
  assert.equal(deriveReleaseHighlights({ authority, body }), highlights);
  assert.throws(() =>
    deriveReleaseHighlights({
      authority,
      body: body.replace(`proposal=${proposalOid}`, `proposal=${'5'.repeat(40)}`),
    })
  );
});

test('the GitHub Release links ordered migration records between highlights and changes', () => {
  const releaseRecord = renderReleaseRecord({ changes: [], version: '1.0.0' });
  const migrationRecords = composeMigrationRecords([
    {
      filename: 'cleanup-old-usage.md',
      source: migration({ priority: '10 - cleanup', title: 'Clean up old usage' }),
    },
    {
      filename: 'adopt-new-api.md',
      source: migration({ priority: '2 - setup', title: 'Adopt the new API' }),
    },
  ]);
  const body = composeGitHubReleaseBody({
    highlights,
    migrationRecords,
    releaseRecord,
    version: '1.0.0',
  });
  assert.equal(
    body,
    `${highlights}

## Migrations

- [Adopt the new API](https://github.com/fablebookjs/lab-02/blob/v1.0.0/migration-notes/v1.0/adopt-new-api.md)
- [Clean up old usage](https://github.com/fablebookjs/lab-02/blob/v1.0.0/migration-notes/v1.0/cleanup-old-usage.md)

<details>
<summary>All changes</summary>

No changes were recorded for this release.

</details>
`
  );
  assert.doesNotMatch(body, /Who is affected/);
  assert.doesNotMatch(body, /How to migrate/);
  assert.doesNotMatch(body, /priority:/);
  assert.doesNotMatch(body, /Generated from the exact release-line history/);
  assert.doesNotMatch(body, /^# v1\.0\.0 changes$/m);
  assert.doesNotMatch(body, /^## Changes$/m);
  assert.throws(() =>
    composeGitHubReleaseBody({
      highlights,
      releaseRecord: releaseRecord.replace('# v1.0.0', '# v1.0.1'),
      version: '1.0.0',
    })
  );
});

test('the GitHub Release makes an empty migration set explicit', () => {
  const body = composeGitHubReleaseBody({
    highlights,
    migrationRecords: [],
    releaseRecord: renderReleaseRecord({ changes: [], version: '1.0.0' }),
    version: '1.0.0',
  });
  assert.match(
    body,
    /## Migrations\n\n_No migrations are required for this release\._/
  );
});

test('the GitHub Release rejects malformed or repeated migration links', () => {
  const input = {
    highlights,
    releaseRecord: renderReleaseRecord({ changes: [], version: '1.0.0' }),
    version: '1.0.0',
  };
  assert.throws(() =>
    composeGitHubReleaseBody({
      ...input,
      migrationRecords: [{ filename: 'unsafe.md', title: '[Unsafe link]' }],
    })
  );
  assert.throws(() =>
    composeGitHubReleaseBody({
      ...input,
      migrationRecords: [
        { filename: 'repeated.md', title: 'First title' },
        { filename: 'repeated.md', title: 'Second title' },
      ],
    })
  );
});

test('stable publication publishes missing versions and skips only exact completed results', () => {
  const input = {
    channel: 'v-1.0',
    integrity,
    name: '@fablebook/lab-02-core',
    version: '1.0.0',
  };
  assert.equal(publicationDisposition({ ...input, document: null }), 'publish');
  assert.equal(
    publicationDisposition({ ...input, document: registryDocument() }),
    'skip'
  );

  const otherVersion = registryDocument({
    'dist-tags': { 'v-1.0': '0.9.0' },
    versions: {},
  });
  assert.equal(publicationDisposition({ ...input, document: otherVersion }), 'publish');

  const wrongIntegrity = registryDocument();
  wrongIntegrity.versions['1.0.0'].dist.integrity = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
  assert.throws(() => publicationDisposition({ ...input, document: wrongIntegrity }));

  const wrongChannel = registryDocument();
  wrongChannel['dist-tags']['v-1.0'] = '1.0.1';
  assert.throws(() => publicationDisposition({ ...input, document: wrongChannel }));
  assert.equal(
    exactPublication({
      document: wrongChannel,
      integrity,
      name: input.name,
      version: input.version,
    }),
    true,
    'a completed older release remains exact after its line channel advances'
  );
});

test('latest promotion is restartable and permits an intentional lower target', () => {
  const document = registryDocument();
  document['dist-tags'].latest = '2.0.0';
  assert.equal(
    promotionDisposition({
      document,
      name: '@fablebook/lab-02-core',
      version: '1.0.0',
    }),
    'update'
  );
  document['dist-tags'].latest = '1.0.0';
  assert.equal(
    promotionDisposition({
      document,
      name: '@fablebook/lab-02-core',
      version: '1.0.0',
    }),
    'skip'
  );
  document.versions = {};
  assert.throws(() =>
    promotionDisposition({
      document,
      name: '@fablebook/lab-02-core',
      version: '1.0.0',
    })
  );
});
