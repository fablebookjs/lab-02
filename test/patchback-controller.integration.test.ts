import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyPatchback } from '../scripts/github/patchback/controller.ts';
import {
  PATCHBACK_EXAMPLES_COMMENT,
  renderPatchbackPrBody,
} from '../scripts/github/patchback/templates.ts';
import {
  patchbackCommitMessage,
  patchbackIdentity,
} from '../scripts/shared/patchback/core.ts';
import { renderReleaseRecord } from '../scripts/shared/release-communication/records.ts';
import { proposalCommitMessage } from '../scripts/shared/release-proposal/core.ts';

const repository = 'fablebookjs/lab-02';
const version = '10.4.3';
const line = 'v10.4';
const sourceOid = '1'.repeat(40);
const proposalOid = '2'.repeat(40);
const snapshotOid = '3'.repeat(40);
const proposalTreeOid = '4'.repeat(40);
const baseMainOid = '5'.repeat(40);
const baseMainTreeOid = '6'.repeat(40);
const coordinationOid = '7'.repeat(40);
const coordinationTreeOid = '8'.repeat(40);
const releaseBlobOid = '9'.repeat(40);
const boundaryOid = 'a'.repeat(40);
const identity = patchbackIdentity(version);
const releaseRecord = {
  content: renderReleaseRecord({ changes: [], version }),
  path: `releases/v${version}.md`,
};
const authority = {
  assignee: null,
  channel: 'v-10.4',
  line,
  proposalOid,
  pullRequest: 99,
  snapshotOid,
  sourceOid,
  version,
};
const body = renderPatchbackPrBody({
  boundaryLabel: 'completed v10.4.2 snapshot',
  boundaryOid,
  items: [],
  line,
  migrationConflicts: [],
  migrationRecords: [],
  recordPath: releaseRecord.path,
  snapshotOid,
  version,
});
const coordinationMessage = patchbackCommitMessage({
  baseMainOid,
  boundaryOid,
  line,
  migrationRecordPaths: [],
  recordPath: releaseRecord.path,
  snapshotOid,
  version,
});
const manifest = {
  authority,
  baseMainOid,
  baseMainTreeOid,
  body,
  boundaryLabel: 'completed v10.4.2 snapshot',
  boundaryOid,
  branch: identity.branch,
  comment: PATCHBACK_EXAMPLES_COMMENT,
  coordinationMessage,
  items: [],
  migrationConflicts: [],
  migrationRecords: [],
  releaseRecord,
  repository,
  schema: 4,
  title: identity.title,
};

const gitIdentity = {
  date: '2026-08-02T00:00:00Z',
  email: 'release@example.com',
  name: 'Release bot',
};

const commit = ({
  message,
  parents,
  sha,
  tree,
}: {
  message: string;
  parents: string[];
  sha: string;
  tree: string;
}) => ({
  author: gitIdentity,
  committer: gitIdentity,
  message,
  parents: parents.map((parent) => ({ sha: parent })),
  sha,
  tree: { sha: tree },
});

const releasePull = {
  base: {
    ref: `releases/${line}`,
    repo: { full_name: repository },
    sha: sourceOid,
  },
  body: '',
  head: {
    ref: `staged/${line}`,
    repo: { full_name: repository },
    sha: proposalOid,
  },
  labels: [],
  merge_commit_sha: snapshotOid,
  merged_at: '2026-08-02T00:00:00Z',
  number: 99,
  state: 'closed',
  title: `Release ${version}`,
};

const patchbackPull = (labels: string[], state = 'open') => ({
  base: { ref: 'main', repo: { full_name: repository }, sha: baseMainOid },
  body,
  head: {
    ref: identity.branch,
    repo: { full_name: repository },
    sha: coordinationOid,
  },
  labels: labels.map((name) => ({ name })),
  merge_commit_sha: null,
  merged_at: null,
  number: 157,
  state,
  title: identity.title,
});

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const runScenario = async (scenario: 'closed' | 'create' | 'open') => {
  const existing = scenario !== 'create';
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-apply-patchback-'),
  );
  const manifestPath = join(temporaryRoot, 'patchback.json');
  const requests: Array<{ body: unknown; method: string; path: string }> = [];
  const originalFetch = globalThis.fetch;
  const previousRepository = process.env['GITHUB_REPOSITORY'];
  const previousRef = process.env['GITHUB_REF'];
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.env['GITHUB_REPOSITORY'] = repository;
    process.env['GITHUB_REF'] = 'refs/heads/main';
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method = init?.method ?? 'GET';
      const requestBody =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({
        body: requestBody,
        method,
        path: `${url.pathname}${url.search}`,
      });

      if (url.pathname === '/graphql') {
        return json({
          data: { repository: { pullRequest: { mergeCommit: { oid: snapshotOid } } } },
        });
      }
      if (url.pathname.endsWith('/pulls/99') && method === 'GET') {
        return json(releasePull);
      }
      if (url.pathname.endsWith(`/git/commits/${proposalOid}`)) {
        return json(
          commit({
            message: proposalCommitMessage({
              attempt: 'test',
              line,
              sourceOid,
              version,
            }),
            parents: [sourceOid],
            sha: proposalOid,
            tree: proposalTreeOid,
          }),
        );
      }
      if (url.pathname.endsWith(`/git/commits/${snapshotOid}`)) {
        return json(
          commit({
            message: `Merge release ${version}`,
            parents: [sourceOid, proposalOid],
            sha: snapshotOid,
            tree: proposalTreeOid,
          }),
        );
      }
      if (url.pathname.endsWith('/pulls') && method === 'GET') {
        return json(
          existing
            ? [
                patchbackPull(
                  scenario === 'open' ? ['qa:skip'] : [],
                  scenario,
                ),
              ]
            : [],
        );
      }
      if (url.pathname.endsWith('/git/ref/heads%2Fpatchbacks%2Fv10.4.3')) {
        return existing
          ? json({ object: { sha: coordinationOid, type: 'commit' } })
          : json({}, 404);
      }
      if (url.pathname.endsWith('/git/ref/heads%2Fmain')) {
        return json({ object: { sha: baseMainOid, type: 'commit' } });
      }
      if (url.pathname.endsWith(`/git/commits/${baseMainOid}`)) {
        return json(
          commit({
            message: 'main base',
            parents: [],
            sha: baseMainOid,
            tree: baseMainTreeOid,
          }),
        );
      }
      if (url.pathname.endsWith('/git/trees') && method === 'POST') {
        return json({ sha: coordinationTreeOid });
      }
      if (url.pathname.endsWith('/git/commits') && method === 'POST') {
        return json(
          commit({
            message: coordinationMessage,
            parents: [baseMainOid],
            sha: coordinationOid,
            tree: coordinationTreeOid,
          }),
        );
      }
      if (url.pathname.endsWith('/git/refs') && method === 'POST') {
        return json({});
      }
      if (url.pathname.endsWith(`/git/commits/${coordinationOid}`)) {
        return json(
          commit({
            message: coordinationMessage,
            parents: [baseMainOid],
            sha: coordinationOid,
            tree: coordinationTreeOid,
          }),
        );
      }
      if (url.pathname.endsWith(`/git/trees/${coordinationTreeOid}`)) {
        return json({
          tree: [
            {
              mode: '100644',
              path: releaseRecord.path,
              sha: releaseBlobOid,
              type: 'blob',
            },
          ],
          truncated: false,
        });
      }
      if (url.pathname.endsWith(`/git/trees/${baseMainTreeOid}`)) {
        return json({ tree: [], truncated: false });
      }
      if (url.pathname.endsWith(`/git/blobs/${releaseBlobOid}`)) {
        return json({
          content: Buffer.from(releaseRecord.content).toString('base64'),
          encoding: 'base64',
        });
      }
      if (url.pathname.includes(`/compare/${baseMainOid}...${baseMainOid}`)) {
        return json({
          merge_base_commit: { sha: baseMainOid },
          status: 'identical',
        });
      }
      if (url.pathname.endsWith('/pulls') && method === 'POST') {
        return json(patchbackPull([]));
      }
      if (url.pathname.endsWith('/issues/157/labels') && method === 'POST') {
        return json([
          { name: 'qa:skip' },
          { name: 'release-note:skip' },
        ]);
      }
      if (url.pathname.endsWith('/issues/157/comments') && method === 'GET') {
        return json(
          existing ? [{ body: PATCHBACK_EXAMPLES_COMMENT, id: 42 }] : [],
        );
      }
      if (url.pathname.endsWith('/issues/157/comments') && method === 'POST') {
        return json({});
      }
      throw new Error(`Unexpected Patchback request: ${method} ${url.href}`);
    };

    await applyPatchback({
      'github-token': 'test-token',
      manifest: manifestPath,
    });
    return requests;
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRepository === undefined) delete process.env['GITHUB_REPOSITORY'];
    else process.env['GITHUB_REPOSITORY'] = previousRepository;
    if (previousRef === undefined) delete process.env['GITHUB_REF'];
    else process.env['GITHUB_REF'] = previousRef;
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

test('applyPatchback reconciles open PR exclusions without mutating a terminal PR', async () => {
  const created = await runScenario('create');
  assert.deepEqual(
    created.filter(
      ({ method, path }) =>
        method === 'POST' && path.endsWith('/issues/157/labels'),
    ).map(({ body: requestBody }) => requestBody),
    [{ labels: ['qa:skip', 'release-note:skip'] }],
  );
  assert.ok(
    created.some(
      ({ method, path }) => method === 'POST' && path.endsWith('/git/refs'),
    ),
  );
  assert.ok(
    created.some(
      ({ method, path }) => method === 'POST' && path.endsWith('/pulls'),
    ),
  );

  const reconciled = await runScenario('open');
  assert.deepEqual(
    reconciled.filter(
      ({ method, path }) =>
        method === 'POST' && path.endsWith('/issues/157/labels'),
    ).map(({ body: requestBody }) => requestBody),
    [{ labels: ['release-note:skip'] }],
  );
  assert.equal(
    reconciled.filter(({ method, path }) =>
      method === 'POST' && (path.endsWith('/git/refs') || path.endsWith('/pulls'))
    ).length,
    0,
  );

  const closed = await runScenario('closed');
  assert.equal(
    closed.filter(
      ({ method, path }) =>
        method === 'POST' && path.endsWith('/issues/157/labels'),
    ).length,
    0,
  );
});
