import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPrereleasePrChanges,
  extractPrereleasePrIdentity,
  renderPrereleasePrBody,
  validatePrereleasePrBody,
} from '../scripts/shared/prerelease-proposal/body.ts';
import {
  nextPrereleaseVersion,
  parsePrereleaseProposalMessage,
  planPrereleaseProposal,
  prereleaseProposalCommitMessage,
} from '../scripts/shared/prerelease-proposal/core.ts';
import {
  derivePrereleaseChanges,
} from '../scripts/shared/release-communication/records.ts';

const oid = (character: string): string => character.repeat(40);

const staged = ({
  boundaryOid = oid('1'),
  sourceOid = oid('2'),
  version = '3.2.0-alpha.1',
}: {
  boundaryOid?: string;
  sourceOid?: string;
  version?: string;
} = {}) => ({
  attempt: 'attempt-one',
  boundaryOid,
  oid: oid('3'),
  sourceOid,
  version,
});

test('the root development version selects the next ordinary prerelease', () => {
  assert.equal(nextPrereleaseVersion('3.2.0-alpha.0'), '3.2.0-alpha.1');
  assert.equal(nextPrereleaseVersion('3.2.0-alpha.9'), '3.2.0-alpha.10');
  assert.equal(nextPrereleaseVersion('3.2.0-beta.0'), '3.2.0-beta.1');
  assert.equal(nextPrereleaseVersion('3.2.0-rc.4'), '3.2.0-rc.5');
  assert.throws(
    () => nextPrereleaseVersion('3.2.0'),
    /Development version must be/,
  );
});

test('proposal commit metadata round-trips distinct ordinary authority', () => {
  const proposal = {
    attempt: 'attempt-one',
    boundaryOid: oid('1'),
    sourceOid: oid('2'),
    version: '3.2.0-beta.1',
  };
  assert.deepEqual(
    parsePrereleaseProposalMessage(prereleaseProposalCommitMessage(proposal)),
    proposal,
  );
  assert.throws(
    () =>
      parsePrereleaseProposalMessage(
        prereleaseProposalCommitMessage(proposal).replace(
          'Prerelease-Boundary:',
          'Release-Boundary:',
        ),
      ),
    /Prerelease-Boundary/,
  );
});

test('the legacy development line stays inactive without managed state', () => {
  assert.deepEqual(
    planPrereleaseProposal({
      boundaryOid: null,
      lineVersion: '3.1.0-alpha.0',
      mainOid: oid('1'),
      openPr: null,
      staged: null,
    }),
    {
      kind: 'inactive',
      reason: 'development line has no managed prerelease snapshot',
    },
  );
  assert.throws(
    () =>
      planPrereleaseProposal({
        boundaryOid: null,
        lineVersion: '3.1.0-alpha.0',
        mainOid: oid('1'),
        openPr: { bodyCurrent: true, number: 91 },
        staged: staged(),
      }),
    /unmanaged development line/,
  );
});

test('one rolling proposal creates, refreshes, syncs, and then clears', () => {
  const boundaryOid = oid('1');
  const mainOid = oid('2');
  const base = {
    boundaryOid,
    lineVersion: '3.2.0-alpha.0',
    mainOid,
  };
  assert.equal(
    planPrereleaseProposal({
      ...base,
      openPr: null,
      staged: null,
    }).kind,
    'create',
  );
  assert.equal(
    planPrereleaseProposal({
      ...base,
      openPr: { bodyCurrent: true, number: 91 },
      staged: staged(),
    }).kind,
    'none',
  );
  assert.equal(
    planPrereleaseProposal({
      ...base,
      openPr: { bodyCurrent: false, number: 91 },
      staged: staged(),
    }).kind,
    'sync',
  );
  assert.equal(
    planPrereleaseProposal({
      ...base,
      mainOid: oid('4'),
      openPr: { bodyCurrent: true, number: 91 },
      staged: staged(),
    }).kind,
    'refresh',
  );
  assert.equal(
    planPrereleaseProposal({
      ...base,
      openPr: null,
      staged: staged(),
    }).kind,
    'recreate',
  );
  assert.equal(
    planPrereleaseProposal({
      ...base,
      mainOid: boundaryOid,
      openPr: { bodyCurrent: true, number: 91 },
      staged: staged(),
    }).kind,
    'clear',
  );
});

test('the generated Prerelease PR accounts for every change without QA tasks', () => {
  const identity = {
    boundaryOid: oid('1'),
    proposalOid: oid('3'),
    sourceOid: oid('2'),
    version: '3.2.0-alpha.1',
  };
  const body = renderPrereleasePrBody({
    ...identity,
    changes: [
      {
        key: 'pr:91',
        oid: oid('4'),
        qaSkip: false,
        releaseNoteSkip: false,
        title: 'Add chapter navigation',
        url: 'https://github.com/fablebookjs/lab-02/pull/91',
      },
      {
        key: 'pr:92',
        oid: oid('5'),
        qaSkip: true,
        releaseNoteSkip: true,
        title: 'Refine internal release diagnostics',
        url: 'https://github.com/fablebookjs/lab-02/pull/92',
      },
    ],
  });
  assert.deepEqual(extractPrereleasePrIdentity(body), identity);
  assert.deepEqual(validatePrereleasePrBody(body, identity), [
    {
      key: 'pr:91',
      releaseNoteSkip: false,
      title: 'Add chapter navigation',
      url: 'https://github.com/fablebookjs/lab-02/pull/91',
    },
    {
      key: 'pr:92',
      releaseNoteSkip: true,
      title: 'Refine internal release diagnostics',
      url: 'https://github.com/fablebookjs/lab-02/pull/92',
    },
  ]);
  assert.doesNotMatch(body, /^- \[[ xX]\]/m);
  assert.doesNotMatch(body, /qa:skip|manual QA required/i);
  assert.match(body, /release-note:skip/);
  assert.throws(
    () =>
      validatePrereleasePrBody(
        `${body}\n- [ ] Add accidental QA state\n`,
        identity,
      ),
    /must not contain QA checkboxes/,
  );
  assert.equal(extractPrereleasePrChanges(body).length, 2);
});

test('main history uses source PR labels for prerelease accounting', () => {
  const changeOid = oid('4');
  assert.deepEqual(
    derivePrereleaseChanges({
      commits: [
        {
          associatedPulls: [
            {
              baseBranch: 'main',
              canonicalRepository: true,
              labels: ['qa:skip', 'release-note:skip'],
              mergeCommitOid: changeOid,
              merged: true,
              number: 91,
              title: 'Refine internal release diagnostics',
            },
          ],
          oid: changeOid,
          subject: 'Merge pull request #91',
        },
      ],
    }),
    [
      {
        key: 'pr:91',
        oid: changeOid,
        qaSkip: true,
        releaseNoteSkip: true,
        title: 'Refine internal release diagnostics',
        url: 'https://github.com/fablebookjs/lab-02/pull/91',
      },
    ],
  );
});
