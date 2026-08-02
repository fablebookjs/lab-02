import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensurePullRequestLabels,
  type GitPullRequest,
} from '../scripts/github/release-repository/pull-requests.ts';
import { reconcilePatchbackLabels } from '../scripts/github/patchback/controller.ts';

const pullRequest = (labels: string[]): GitPullRequest => ({
  base: {
    ref: 'main',
    repo: { full_name: 'fablebookjs/lab-02' },
    sha: '1'.repeat(40),
  },
  body: 'Patchback',
  head: {
    ref: 'patchbacks/v3.4.1',
    repo: { full_name: 'fablebookjs/lab-02' },
    sha: '2'.repeat(40),
  },
  labels: labels.map((name) => ({ name })),
  merge_commit_sha: null,
  merged_at: null,
  number: 157,
  state: 'open',
  title: 'Patch back v3.4.1 to main',
});

test('required PR labels are an idempotent reconciliation', async () => {
  const pull = pullRequest(['human-label', 'qa:skip', 'release-note:skip']);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No request was expected.');
  };
  try {
    assert.strictEqual(
      await ensurePullRequestLabels('token', pull, [
        'qa:skip',
        'release-note:skip',
      ]),
      pull,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('required PR labels add only missing labels and preserve human labels', async () => {
  const requests: Array<{ body: string; method: string; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({
      body: String(init?.body ?? ''),
      method: String(init?.method ?? ''),
      url: String(input),
    });
    return new Response(
      JSON.stringify([
        { name: 'human-label' },
        { name: 'qa:skip' },
        { name: 'release-note:skip' },
      ]),
      { status: 200 },
    );
  };
  try {
    const pull = await ensurePullRequestLabels(
      'token',
      pullRequest(['human-label', 'qa:skip']),
      ['qa:skip', 'release-note:skip'],
    );
    assert.deepEqual(pull.labels, [
      { name: 'human-label' },
      { name: 'qa:skip' },
      { name: 'release-note:skip' },
    ]);
    assert.deepEqual(requests, [
      {
        body: JSON.stringify({ labels: ['release-note:skip'] }),
        method: 'POST',
        url: 'https://api.github.com/repos/fablebookjs/lab-02/issues/157/labels',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('required PR labels reject a contradictory GitHub response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ name: 'qa:skip' }]), { status: 200 });
  try {
    await assert.rejects(
      ensurePullRequestLabels('token', pullRequest(['qa:skip']), [
        'qa:skip',
        'release-note:skip',
      ]),
      /did not apply required pull request label.*release-note:skip/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the Patchback controller applies exclusions to every open PR path', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([{ name: 'qa:skip' }, { name: 'release-note:skip' }]),
      { status: 200 },
    );
  try {
    const pull = await reconcilePatchbackLabels(
      'token',
      pullRequest(['qa:skip']),
    );
    assert.deepEqual(pull.labels, [
      { name: 'qa:skip' },
      { name: 'release-note:skip' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the Patchback controller never mutates a terminal PR', async () => {
  const pull = { ...pullRequest([]), state: 'closed' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No request was expected.');
  };
  try {
    assert.strictEqual(await reconcilePatchbackLabels('token', pull), pull);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
