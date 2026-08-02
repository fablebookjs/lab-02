import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPrereleaseGitHubReleaseBody } from '../scripts/github/prerelease-publication/templates.ts';
import {
  derivePrereleaseChanges,
  renderReleaseRecord,
} from '../scripts/shared/release-communication/records.ts';

const oid = 'a'.repeat(40);

test('a labeled Patchback remains visible to accounting but absent from public releases', () => {
  const changes = derivePrereleaseChanges({
    commits: [
      {
        associatedPulls: [
          {
            baseBranch: 'main',
            canonicalRepository: true,
            labels: ['qa:skip', 'release-note:skip'],
            mergeCommitOid: oid,
            merged: true,
            number: 157,
            title: 'Patch back v3.4.1 to main',
          },
        ],
        oid,
        subject: 'Merge pull request #157',
      },
    ],
  });
  const patchback = changes[0];
  if (patchback === undefined) {
    throw new Error('Expected one Patchback accounting entry.');
  }
  assert.deepEqual(patchback, {
    key: 'pr:157',
    oid,
    qaSkip: true,
    releaseNoteSkip: true,
    title: 'Patch back v3.4.1 to main',
    url: 'https://github.com/fablebookjs/lab-02/pull/157',
  });

  const stableRecord = renderReleaseRecord({ changes, version: '3.5.0' });
  const prereleaseBody = renderPrereleaseGitHubReleaseBody({
    changes,
    version: '3.5.0-alpha.1',
  });
  assert.doesNotMatch(stableRecord, /Patch back|pull\/157/);
  assert.doesNotMatch(prereleaseBody, /Patch back|pull\/157/);
});
