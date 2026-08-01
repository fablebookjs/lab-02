import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';
import {
  assertOidcPublishEnvironment,
  registryIntegrity,
  SETUP_NODE_AUTH_PLACEHOLDER,
} from '../scripts/shared/package-publication/core.ts';
import {
  deriveReleaseAuthority,
  deriveReleaseCommunication,
  lineChannel,
  validateReleaseCommunication,
} from '../scripts/shared/release-publication/core.ts';
import { renderStableGitHubReleaseBody } from '../scripts/github/release-publication/templates.ts';
import {
  composeMigrationRecords,
  renderReleaseRecord,
} from '../scripts/shared/release-communication/records.ts';
import { proposalCommitMessage } from '../scripts/shared/release-proposal/core.ts';
import {
  EMPTY_RELEASE_HIGHLIGHTS,
  renderReleasePrBody,
} from '../scripts/shared/release-proposal/body.ts';

const sourceOid = '1'.repeat(40);
const proposalOid = '2'.repeat(40);
const snapshotOid = '3'.repeat(40);
const treeOid = '4'.repeat(40);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const highlights =
  '### Faster setup\n\nThe release workflow is ready for user evaluation.';
const templateDirectory = join(repositoryRoot, '.github', 'release-templates');
const releasePrInitialTemplate = await readFile(
  join(templateDirectory, 'release-pr-initial.md'),
  'utf8'
);
const changes = [
  {
    key: 'pr:41',
    oid: '5'.repeat(40),
    qaSkip: false,
    releaseNoteSkip: false,
    title: 'Add portable stories',
    url: 'https://github.com/fablebookjs/lab-02/pull/41',
  },
  {
    key: 'pr:42',
    oid: '6'.repeat(40),
    qaSkip: true,
    releaseNoteSkip: false,
    title: 'Repair browser cleanup',
    url: 'https://github.com/fablebookjs/lab-02/pull/42',
  },
  {
    key: 'pr:43',
    oid: '7'.repeat(40),
    qaSkip: false,
    releaseNoteSkip: true,
    title: 'Simplify internal accounting',
    url: 'https://github.com/fablebookjs/lab-02/pull/43',
  },
];
const communicationChanges = changes.map(
  ({ key, qaSkip, releaseNoteSkip, title, url }) => ({
    key,
    qaSkip,
    releaseNoteSkip,
    title,
    url,
  })
);
const initialCommunication = {
  changes: communicationChanges,
  kind: 'initial',
  releaseHighlights: highlights,
};
const migration = ({
  priority,
  title,
}: {
  priority: string;
  title: string;
}): string => `---
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

type RegistryDocument = {
  'dist-tags': Record<string, string>;
  name: string;
  versions: Record<
    string,
    {
      dist: { integrity: string };
      name: string;
      version: string;
    }
  >;
};

const registryDocument = (
  overrides: Partial<RegistryDocument> = {},
): RegistryDocument => ({
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
    assertOidcPublishEnvironment({
      nodeAuthToken: undefined,
      npmToken: undefined,
    })
  );
  assert.throws(() =>
    assertOidcPublishEnvironment({
      nodeAuthToken: 'real-token',
      npmToken: undefined,
    })
  );
  assert.throws(() =>
    assertOidcPublishEnvironment({
      nodeAuthToken: undefined,
      npmToken: 'real-token',
    })
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

test('release communication remains bound to the authorized reviewed proposal', () => {
  const authority = deriveReleaseAuthority(authorityFixture());
  const body = renderReleasePrBody({
    changes,
    line: 'v1.0',
    packageNames: ['@fablebook/lab-02-core'],
    proposalOid,
    releaseOid: sourceOid,
    template: releasePrInitialTemplate,
    version: '1.0.0',
  })
    .replace(EMPTY_RELEASE_HIGHLIGHTS, highlights)
    .replaceAll('- [ ]', '- [x]');
  assert.deepEqual(
    deriveReleaseCommunication({ authority, body }),
    initialCommunication
  );
  assert.throws(() =>
    deriveReleaseCommunication({
      authority,
      body: body.replace(`proposal=${proposalOid}`, `proposal=${'8'.repeat(40)}`),
    })
  );
  assert.throws(() =>
    deriveReleaseCommunication({
      authority,
      body: body.replace(
        '- [x] Confirm that included change titles',
        '- [ ] Confirm that included change titles'
      ),
    })
  );
});

test('the initial GitHub Release renders curated highlights, public changes, and optional migrations', () => {
  const migrationRecords = composeMigrationRecords([
    {
      filename: 'cleanup-old-usage.md',
      source: migration({
        priority: '10 - cleanup',
        title: 'Clean up old usage',
      }),
    },
    {
      filename: 'adopt-new-api.md',
      source: migration({ priority: '2 - setup', title: 'Adopt the new API' }),
    },
  ]);
  const body = renderStableGitHubReleaseBody({
    communication: initialCommunication,
    migrationRecords,
    releaseRecord: renderReleaseRecord({ changes, version: '1.0.0' }),
    version: '1.0.0',
  });
  assert.equal(
    body,
    `# Lab-02 1.0.0

## Release highlights

${highlights}

## Noteworthy changes

- [Add portable stories](https://github.com/fablebookjs/lab-02/pull/41)
- [Repair browser cleanup](https://github.com/fablebookjs/lab-02/pull/42)

## Migrations

- [Adopt the new API](https://github.com/fablebookjs/lab-02/blob/v1.0.0/migration-notes/v1.0/adopt-new-api.md)
- [Clean up old usage](https://github.com/fablebookjs/lab-02/blob/v1.0.0/migration-notes/v1.0/cleanup-old-usage.md)
`
  );
  assert.doesNotMatch(body, /Simplify internal accounting/);
  assert.doesNotMatch(body, /Who is affected|How to migrate|priority:/);
});

test('ordinary and maintenance patches render distinct succinct outputs', () => {
  const patchChanges = changes.map((change) => ({ ...change }));
  const patchCommunication = {
    changes: communicationChanges,
    kind: 'patch',
    releaseHighlights: null,
  };
  const patchBody = renderStableGitHubReleaseBody({
    communication: patchCommunication,
    releaseRecord: renderReleaseRecord({
      changes: patchChanges,
      version: '1.0.1',
    }),
    version: '1.0.1',
  });
  assert.equal(
    patchBody,
    `# Lab-02 1.0.1

## What's changed

- [Add portable stories](https://github.com/fablebookjs/lab-02/pull/41)
- [Repair browser cleanup](https://github.com/fablebookjs/lab-02/pull/42)
`
  );
  assert.doesNotMatch(patchBody, /Migrations|Release highlights/);

  const maintenanceChanges = changes.map((change) => ({
    ...change,
    releaseNoteSkip: true,
  }));
  const maintenanceBody = renderStableGitHubReleaseBody({
    communication: {
      changes: maintenanceChanges.map(
        ({ key, qaSkip, releaseNoteSkip, title, url }) => ({
          key,
          qaSkip,
          releaseNoteSkip,
          title,
          url,
        })
      ),
      kind: 'maintenance',
      releaseHighlights: null,
    },
    releaseRecord: renderReleaseRecord({
      changes: maintenanceChanges,
      version: '1.0.2',
    }),
    version: '1.0.2',
  });
  assert.equal(
    maintenanceBody,
    `# Lab-02 1.0.2

This maintenance release contains no user-facing changes worth mentioning.
`
  );
});

test('release records contain only public changes while contradictions fail closed', () => {
  const historicalChanges = [
    {
      key: 'pr:44',
      qaSkip: false,
      releaseNoteSkip: false,
      title: 'Add count-based summary formatting',
      url: 'https://github.com/fablebookjs/lab-02/pull/44',
    },
    {
      key: 'pr:46',
      qaSkip: false,
      releaseNoteSkip: true,
      title: 'Document adopting count-based summaries',
      url: 'https://github.com/fablebookjs/lab-02/pull/46',
    },
  ];
  const releaseRecord = `<!-- fablebook:release-record=v1 -->
# v2.0.3

> Generated from the exact release-line history. Do not edit manually.

## Changes

- [Add count-based summary formatting](https://github.com/fablebookjs/lab-02/pull/44)
`;
  const input = {
    communication: {
      changes: historicalChanges,
      kind: 'patch',
      releaseHighlights: null,
    },
    releaseRecord,
    version: '2.0.3',
  };
  const body = renderStableGitHubReleaseBody(input);
  assert.match(body, /Add count-based summary formatting/);
  assert.doesNotMatch(
    body,
    /Document adopting count-based summaries|fablebook:release-record|Generated from/
  );
  assert.throws(
    () =>
      renderStableGitHubReleaseBody({
        ...input,
        releaseRecord: releaseRecord.replace(
          '- [Add count-based summary formatting](https://github.com/fablebookjs/lab-02/pull/44)\n',
          [
            '- [Add count-based summary formatting](https://github.com/fablebookjs/lab-02/pull/44)',
            '- [Document adopting count-based summaries](https://github.com/fablebookjs/lab-02/pull/46)',
            '',
          ].join('\n')
        ),
      }),
    /release record contradicts/
  );
  assert.throws(() =>
    renderStableGitHubReleaseBody({
      ...input,
      communication: {
        ...input.communication,
        changes: [
          {
            ...historicalChanges[0],
            title: 'Contradictory generated title',
          },
          historicalChanges[1],
        ],
      },
    })
  );
});

test('migration links and communication schemas fail closed', () => {
  const input = {
    communication: initialCommunication,
    releaseRecord: renderReleaseRecord({ changes, version: '1.0.0' }),
    version: '1.0.0',
  };
  assert.throws(() =>
    renderStableGitHubReleaseBody({
      ...input,
      migrationRecords: [{ filename: 'unsafe.md', title: '[Unsafe link]' }],
    })
  );
  assert.throws(() =>
    validateReleaseCommunication(
      {
        changes: communicationChanges,
        kind: 'maintenance',
        releaseHighlights: null,
      },
      '1.0.1'
    )
  );
});

test('stable publication observes only the exact registry version integrity', () => {
  const input = {
    name: '@fablebook/lab-02-core',
    version: '1.0.0',
  };
  assert.equal(registryIntegrity({ ...input, document: null }), null);
  assert.equal(registryIntegrity({ ...input, document: registryDocument() }), integrity);

  const otherVersion = registryDocument({
    'dist-tags': { 'v-1.0': '0.9.0' },
    versions: {},
  });
  assert.equal(registryIntegrity({ ...input, document: otherVersion }), null);

  const wrongIntegrity = registryDocument();
  const published = wrongIntegrity.versions['1.0.0'];
  assert.ok(published);
  published.dist.integrity =
    `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
  assert.equal(
    registryIntegrity({ ...input, document: wrongIntegrity }),
    published.dist.integrity,
  );

  const wrongChannel = registryDocument();
  wrongChannel['dist-tags']['v-1.0'] = '1.0.1';
  assert.equal(
    registryIntegrity({
      document: wrongChannel,
      name: input.name,
      version: input.version,
    }),
    integrity,
    'a completed older release remains exact after its line channel advances',
  );
});
