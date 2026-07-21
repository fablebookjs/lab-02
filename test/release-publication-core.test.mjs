import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOidcPublishEnvironment,
  deriveReleaseAuthority,
  exactPublication,
  lineChannel,
  promotionDisposition,
  publicationDisposition,
  SETUP_NODE_AUTH_PLACEHOLDER,
} from '../scripts/release-publication-core.mjs';
import { proposalCommitMessage } from '../scripts/release-proposal-core.mjs';

const sourceOid = '1'.repeat(40);
const proposalOid = '2'.repeat(40);
const snapshotOid = '3'.repeat(40);
const treeOid = '4'.repeat(40);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

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
