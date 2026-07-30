import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  composePrereleaseGitHubReleaseBody,
  derivePrereleaseAuthority,
  derivePrereleaseCommunication,
  registryNextVersion,
} from '../scripts/shared/prerelease-publication/core.ts';
import {
  reconcileNextPackageSet,
  validatePrereleasePublicationManifest,
} from '../scripts/shared/prerelease-publication/publication.ts';
import { renderPrereleasePrBody } from '../scripts/shared/prerelease-proposal/body.ts';
import { prereleaseProposalCommitMessage } from '../scripts/shared/prerelease-proposal/core.ts';

const oid = (character: string): string => character.repeat(40);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

const authorityFixture = () => {
  const boundaryOid = oid('0');
  const sourceOid = oid('1');
  const proposalOid = oid('2');
  const snapshotOid = oid('3');
  const version = '3.2.0-alpha.1';
  const changes = [
    {
      key: 'pr:91',
      oid: oid('5'),
      qaSkip: false,
      releaseNoteSkip: false,
      title: 'Add chapter navigation',
      url: 'https://github.com/fablebookjs/lab-02/pull/91',
    },
    {
      key: 'pr:92',
      oid: oid('6'),
      qaSkip: false,
      releaseNoteSkip: true,
      title: 'Refine internal release diagnostics',
      url: 'https://github.com/fablebookjs/lab-02/pull/92',
    },
  ];
  const body = renderPrereleasePrBody({
    boundaryOid,
    changes,
    proposalOid,
    sourceOid,
    version,
  });
  const headCommit = {
    message: prereleaseProposalCommitMessage({
      attempt: 'attempt-one',
      boundaryOid,
      sourceOid,
      version,
    }),
    parents: [{ sha: sourceOid }],
    sha: proposalOid,
    tree: { sha: oid('4') },
  };
  const mergeCommit = {
    parents: [{ sha: sourceOid }, { sha: proposalOid }],
    sha: snapshotOid,
    tree: { sha: oid('4') },
  };
  const pull = {
    base: {
      ref: 'main',
      repo: { full_name: 'fablebookjs/lab-02' },
      sha: sourceOid,
    },
    body,
    head: {
      ref: 'prerelease',
      repo: { full_name: 'fablebookjs/lab-02' },
      sha: proposalOid,
    },
    merge_commit_sha: snapshotOid,
    merged_at: '2026-07-31T10:00:00Z',
    number: 93,
    state: 'closed',
  };
  return { body, changes, headCommit, mergeCommit, pull };
};

test('the merged canonical PR authorizes its exact materialized snapshot', () => {
  const fixture = authorityFixture();
  const authority = derivePrereleaseAuthority(fixture);
  assert.deepEqual(authority, {
    boundaryOid: oid('0'),
    channel: 'next',
    proposalOid: oid('2'),
    pullRequest: 93,
    snapshotOid: oid('3'),
    sourceOid: oid('1'),
    version: '3.2.0-alpha.1',
  });
  assert.deepEqual(
    derivePrereleaseCommunication({
      authority,
      body: fixture.body,
    }),
    fixture.changes.map(({ key, releaseNoteSkip, title, url }) => ({
      key,
      releaseNoteSkip,
      title,
      url,
    })),
  );

  assert.throws(
    () =>
      derivePrereleaseAuthority({
        ...fixture,
        mergeCommit: {
          ...fixture.mergeCommit,
          tree: { sha: oid('9') },
        },
      }),
    /exact merge/,
  );
});

test('prerelease communication is incremental, filtered, and output-only', () => {
  const fixture = authorityFixture();
  const authority = derivePrereleaseAuthority(fixture);
  const body = composePrereleaseGitHubReleaseBody({
    changes: derivePrereleaseCommunication({
      authority,
      body: fixture.body,
    }),
    version: authority.version,
  });
  assert.equal(
    body,
    `# Lab-02 3.2.0-alpha.1

## What's changed

- [Add chapter navigation](https://github.com/fablebookjs/lab-02/pull/91)
`,
  );
  assert.doesNotMatch(body, /Refine internal|migration|checkbox/i);
  assert.equal(
    composePrereleaseGitHubReleaseBody({
      changes: [
        {
          key: 'pr:92',
          releaseNoteSkip: true,
          title: 'Refine internal release diagnostics',
          url: 'https://github.com/fablebookjs/lab-02/pull/92',
        },
      ],
      version: '3.2.0-alpha.2',
    }),
    `# Lab-02 3.2.0-alpha.2

## What's changed

This prerelease contains no user-facing changes worth mentioning.
`,
  );
});

const withManifest = async (
  exercise: (
    manifest: Awaited<ReturnType<typeof validatePrereleasePublicationManifest>>,
  ) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-02-prerelease-manifest-'));
  try {
    const tarballs = join(root, 'tarballs');
    await mkdir(tarballs);
    await writeFile(join(tarballs, 'lab-02-core-3.2.0-alpha.1.tgz'), 'core');
    const value = {
      boundaryOid: oid('0'),
      channel: 'next',
      packages: [
        {
          filename: 'lab-02-core-3.2.0-alpha.1.tgz',
          integrity,
          name: '@fablebook/lab-02-core',
        },
      ],
      proposalOid: oid('2'),
      pullRequest: 93,
      releaseBody: '# Lab-02 3.2.0-alpha.1\n',
      repository: 'fablebookjs/lab-02',
      schema: 1,
      snapshotOid: oid('3'),
      sourceOid: oid('1'),
      version: '3.2.0-alpha.1',
    };
    const manifest = await validatePrereleasePublicationManifest(
      value,
      tarballs,
      {
        repository: 'fablebookjs/lab-02',
        snapshotOid: oid('3'),
        version: '3.2.0-alpha.1',
      },
    );
    await exercise(manifest);
  } finally {
    await rm(root, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
};

test('the sealed manifest binds the complete package set to next', async () => {
  await withManifest(async (manifest) => {
    assert.equal(manifest.channel, 'next');
    assert.equal(manifest.version, '3.2.0-alpha.1');
    assert.deepEqual(
      manifest.packages.map(({ name }) => name),
      ['@fablebook/lab-02-core'],
    );
  });
});

test('the same sealed publisher accepts honest direct phase-entry authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-02-phase-entry-manifest-'));
  try {
    const tarballs = join(root, 'tarballs');
    await mkdir(tarballs);
    await writeFile(join(tarballs, 'lab-02-core-3.2.0-beta.0.tgz'), 'core');
    const value = {
      boundaryOid: oid('0'),
      channel: 'next',
      packages: [
        {
          filename: 'lab-02-core-3.2.0-beta.0.tgz',
          integrity,
          name: '@fablebook/lab-02-core',
        },
      ],
      phase: 'beta',
      releaseBody: '# Lab-02 3.2.0-beta.0\n',
      repository: 'fablebookjs/lab-02',
      schema: 1,
      snapshotOid: oid('3'),
      sourceOid: oid('1'),
      version: '3.2.0-beta.0',
    };
    const manifest = await validatePrereleasePublicationManifest(
      value,
      tarballs,
      {
        repository: 'fablebookjs/lab-02',
        snapshotOid: oid('3'),
        version: '3.2.0-beta.0',
      },
    );
    assert.ok('phase' in manifest);
    assert.equal(manifest.phase, 'beta');
    assert.ok(!('proposalOid' in manifest));
    assert.ok(!('pullRequest' in manifest));
    await assert.rejects(
      validatePrereleasePublicationManifest(
        { ...value, pullRequest: 93 },
        tarballs,
        {
          repository: 'fablebookjs/lab-02',
          snapshotOid: oid('3'),
          version: '3.2.0-beta.0',
        },
      ),
      /outside the expected schema/,
    );
  } finally {
    await rm(root, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});

test('the same sealed publisher accepts an honest cut bootstrap authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-02-bootstrap-manifest-'));
  try {
    const tarballs = join(root, 'tarballs');
    await mkdir(tarballs);
    await writeFile(join(tarballs, 'lab-02-core-3.2.0-alpha.0.tgz'), 'core');
    const value = {
      boundaryOid: oid('3'),
      channel: 'next',
      cutLine: 'v3.1',
      packages: [
        {
          filename: 'lab-02-core-3.2.0-alpha.0.tgz',
          integrity,
          name: '@fablebook/lab-02-core',
        },
      ],
      releaseBody: '# Lab-02 3.2.0-alpha.0\n',
      repository: 'fablebookjs/lab-02',
      schema: 1,
      snapshotOid: oid('3'),
      sourceOid: oid('1'),
      version: '3.2.0-alpha.0',
    };
    const manifest = await validatePrereleasePublicationManifest(
      value,
      tarballs,
      {
        repository: 'fablebookjs/lab-02',
        snapshotOid: oid('3'),
        version: '3.2.0-alpha.0',
      },
    );
    assert.ok('cutLine' in manifest);
    assert.equal(manifest.cutLine, 'v3.1');
    assert.ok(!('proposalOid' in manifest));
    assert.ok(!('pullRequest' in manifest));
    await assert.rejects(
      validatePrereleasePublicationManifest(
        { ...value, boundaryOid: oid('0') },
        tarballs,
        {
          repository: 'fablebookjs/lab-02',
          snapshotOid: oid('3'),
          version: '3.2.0-alpha.0',
        },
      ),
      /alpha\.0 boundary/,
    );
  } finally {
    await rm(root, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});

test('next reconciliation queries first, repairs only drift, and reads back all packages', async () => {
  await withManifest(async (manifest) => {
    let current: string | null = null;
    const observations: Array<string | null> = [];
    const updates: string[] = [];
    await reconcileNextPackageSet(manifest, {
      addNext: async (name, version) => {
        updates.push(`${name}@${version}`);
        current = version;
      },
      observeNext: async () => {
        observations.push(current);
        return current;
      },
      wait: async () => {},
    });
    assert.deepEqual(updates, ['@fablebook/lab-02-core@3.2.0-alpha.1']);
    assert.deepEqual(observations, [null, '3.2.0-alpha.1']);

    updates.length = 0;
    observations.length = 0;
    await reconcileNextPackageSet(manifest, {
      addNext: async (name, version) => {
        updates.push(`${name}@${version}`);
      },
      observeNext: async () => {
        observations.push(current);
        return current;
      },
      wait: async () => {},
    });
    assert.deepEqual(updates, []);
    assert.deepEqual(observations, [
      '3.2.0-alpha.1',
      '3.2.0-alpha.1',
    ]);
  });
});

test('npm next observation rejects contradictory registry metadata', () => {
  assert.equal(
    registryNextVersion({
      document: {
        'dist-tags': { next: '3.2.0-alpha.1' },
        name: '@fablebook/lab-02-core',
      },
      name: '@fablebook/lab-02-core',
    }),
    '3.2.0-alpha.1',
  );
  assert.throws(
    () =>
      registryNextVersion({
        document: {
          'dist-tags': { next: 42 },
          name: '@fablebook/lab-02-core',
        },
        name: '@fablebook/lab-02-core',
      }),
    /contradictory next tag/,
  );
});
