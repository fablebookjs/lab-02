import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  inspectPrereleaseAuthority,
} from '../scripts/github/prerelease-publication/controller.ts';
import {
  resolvePublication,
} from '../scripts/github/release-publication/controller.ts';
import {
  classifyPublicationRoute,
} from '../scripts/shared/publication-routing/core.ts';
import {
  validatedWorkflowRunCompletion,
} from '../scripts/github/events.ts';

const route = ({
  branch = 'main',
  conclusion = 'success',
  event,
  path,
}: {
  branch?: string | null;
  conclusion?: string;
  event: string;
  path: string;
}) =>
  classifyPublicationRoute({
    branch,
    conclusion,
    event,
    path,
    runId: 42,
  });

test('trusted completed sources map to one explicit publication authority kind', () => {
  assert.deepEqual(
    route({
      branch: 'releases/v4.0',
      event: 'pull_request_target',
      path: '.github/workflows/release-proposal-signal.yml',
    }),
    { authorityKind: 'stable-pr', kind: 'publish', upstreamRunId: 42 },
  );
  assert.deepEqual(
    route({
      event: 'pull_request_target',
      path: '.github/workflows/prerelease-proposal-signal.yml',
    }),
    {
      authorityKind: 'ordinary-prerelease-pr',
      kind: 'publish',
      upstreamRunId: 42,
    },
  );
  assert.deepEqual(
    route({
      event: 'workflow_dispatch',
      path: '.github/workflows/enter-prerelease-phase.yml',
    }),
    { authorityKind: 'phase-entry', kind: 'publish', upstreamRunId: 42 },
  );
  assert.deepEqual(
    route({
      event: 'workflow_dispatch',
      path: '.github/workflows/cut-release-line.yml',
    }),
    {
      authorityKind: 'release-cut-bootstrap',
      kind: 'publish',
      upstreamRunId: 42,
    },
  );
});

test('unsuccessful, unknown, maintenance-only, and wrong-branch runs visibly skip', () => {
  const decisions = [
    route({
      conclusion: 'failure',
      event: 'pull_request_target',
      path: '.github/workflows/prerelease-proposal-signal.yml',
    }),
    route({
      event: 'workflow_dispatch',
      path: '.github/workflows/not-a-publication-source.yml',
    }),
    route({
      branch: 'releases/v4.0',
      event: 'push',
      path: '.github/workflows/release-proposal-signal.yml',
    }),
    route({
      branch: 'feature',
      event: 'workflow_dispatch',
      path: '.github/workflows/enter-prerelease-phase.yml',
    }),
    route({
      branch: null,
      event: 'workflow_dispatch',
      path: '.github/workflows/cut-release-line.yml',
    }),
  ];
  assert.ok(
    decisions.every(
      (decision) => decision.kind === 'skip' && decision.reason.length > 0,
    ),
  );
  assert.match(decisions[0]?.kind === 'skip' ? decisions[0].reason : '', /failure/);
  assert.match(decisions[1]?.kind === 'skip' ? decisions[1].reason : '', /not a publication/);
  assert.match(decisions[2]?.kind === 'skip' ? decisions[2].reason : '', /maintenance/);
  assert.match(decisions[3]?.kind === 'skip' ? decisions[3].reason : '', /main/);
  assert.match(decisions[4]?.kind === 'skip' ? decisions[4].reason : '', /without a branch/);
});

test('the handler boundary validates the completed workflow payload', () => {
  assert.deepEqual(
    validatedWorkflowRunCompletion('workflow_run', {
      action: 'completed',
      workflow_run: {
        conclusion: 'success',
        event: 'workflow_dispatch',
        head_branch: 'main',
        id: 42,
        path: '.github/workflows/cut-release-line.yml',
      },
    }),
    {
      branch: 'main',
      conclusion: 'success',
      event: 'workflow_dispatch',
      path: '.github/workflows/cut-release-line.yml',
      runId: 42,
    },
  );
  assert.throws(
    () =>
      validatedWorkflowRunCompletion('workflow_run', {
        action: 'completed',
        workflow_run: {
          conclusion: null,
          event: 'workflow_dispatch',
          head_branch: 'main',
          id: 42,
          path: '.github/workflows/cut-release-line.yml',
        },
      }),
    /conclusion is missing or unknown/,
  );
  assert.equal(
    validatedWorkflowRunCompletion('workflow_run', {
      action: 'completed',
      workflow_run: {
        conclusion: 'success',
        event: 'workflow_dispatch',
        head_branch: null,
        id: 43,
        path: '.github/workflows/cut-release-line.yml',
      },
    }).branch,
    null,
  );
});

test('publisher authority resolvers reject a route that contradicts the document shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fablebook-publication-route-'));
  const authority = join(root, 'authority.json');
  const previousRepository = process.env['GITHUB_REPOSITORY'];
  const previousRef = process.env['GITHUB_REF'];
  process.env['GITHUB_REPOSITORY'] = 'fablebookjs/lab-02';
  process.env['GITHUB_REF'] = 'refs/heads/main';
  try {
    await writeFile(
      authority,
      `${JSON.stringify({
        boundaryOid: '0'.repeat(40),
        changes: [],
        channel: 'next',
        phase: 'beta',
        repository: 'fablebookjs/lab-02',
        schema: 1,
        snapshotOid: '2'.repeat(40),
        sourceOid: '1'.repeat(40),
        version: '5.0.0-beta.0',
      })}\n`,
      'utf8',
    );
    assert.deepEqual(
      await inspectPrereleaseAuthority({
        'authority-kind': 'phase-entry',
        authority,
      }),
      { publish: true, snapshot: '2'.repeat(40), version: '5.0.0-beta.0' },
    );
    await assert.rejects(
      inspectPrereleaseAuthority({
        'authority-kind': 'release-cut-bootstrap',
        authority,
      }),
      /not routed release-cut-bootstrap/,
    );
    await assert.rejects(
      resolvePublication({
        'authority-kind': 'ordinary-prerelease-pr',
        'github-token': 'unused',
        output: root,
        signal: join(root, 'missing.json'),
      }),
      /Stable publication resolver cannot consume ordinary-prerelease-pr/,
    );
  } finally {
    if (previousRepository === undefined) {
      delete process.env['GITHUB_REPOSITORY'];
    } else {
      process.env['GITHUB_REPOSITORY'] = previousRepository;
    }
    if (previousRef === undefined) {
      delete process.env['GITHUB_REF'];
    } else {
      process.env['GITHUB_REF'] = previousRef;
    }
    await rm(root, { force: true, recursive: true });
  }
});
