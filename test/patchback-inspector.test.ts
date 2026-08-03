import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderPatchbackPrBody } from '../scripts/github/patchback/templates.ts';
import { patchbackCommitMessage } from '../scripts/shared/patchback/core.ts';
import { inspectPatchbackPullRequest } from '../scripts/shared/patchback/inspection.ts';

const inspector = fileURLToPath(
  new URL(
    '../.agents/skills/gh-finish-patchback/scripts/inspect-patchback-pr.ts',
    import.meta.url
  )
);

const version = '10.4.3';
const snapshotOid = '3'.repeat(40);
const boundaryOid = 'a'.repeat(40);
const coordinationOid = '7'.repeat(40);
const baseMainOid = 'b'.repeat(40);
const migrationPath = 'migration-notes/v10.4/correct-existing-guidance.md';

const patchbackPull = () => ({
  baseRefName: 'main',
  body: renderPatchbackPrBody({
    boundaryLabel: 'completed v10.4.2 snapshot',
    boundaryOid,
    items: [],
    line: 'v10.4',
    migrationConflicts: [
      {
        path: migrationPath,
        title: 'Correct existing guidance',
      },
    ],
    migrationRecords: [],
    recordPath: `releases/v${version}.md`,
    snapshotOid,
    version,
  }),
  commits: [
    {
      messageBody: patchbackCommitMessage({
        baseMainOid,
        boundaryOid,
        line: 'v10.4',
        migrationRecordPaths: [],
        recordPath: `releases/v${version}.md`,
        snapshotOid,
        version,
      }),
      messageHeadline: `patchback: coordinate v${version}`,
      oid: coordinationOid,
    },
  ],
  headRefName: `patchbacks/v${version}`,
  headRefOid: coordinationOid,
  isDraft: true,
  mergeCommit: null,
  mergeable: 'MERGEABLE',
  mergedAt: null,
  number: 194,
  state: 'OPEN',
  statusCheckRollup: [],
  title: `Patch back v${version} to main`,
  url: 'https://github.com/fablebookjs/lab-02/pull/194',
});

test('the Patchback inspector loads the shared TypeScript modules', () => {
  const result = spawnSync(process.execPath, [inspector], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'inspect-patchback-pr: usage: inspect-patchback-pr.ts <pr-number-or-url>\n'
  );
});

test('shared Patchback inspection accepts generated divergent Migration tasks', () => {
  const report = inspectPatchbackPullRequest(patchbackPull());

  assert.equal(report.valid, true);
  assert.equal(report.queueResolved, false);
  assert.deepEqual(report.items, [
    {
      checked: false,
      heading: 'Resolve divergent Migration guidance — Correct existing guidance',
      kind: 'migration-conflict',
      outcome:
        '_preserve or manually reconcile the newer `main` guidance, then record the resolution_',
      path: migrationPath,
      resolved: false,
    },
  ]);
});

test('the skill-local TypeScript adapter passes gh output to shared inspection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patchback-inspector-'));
  const fakeGh = join(directory, 'gh');

  try {
    await writeFile(
      fakeGh,
      '#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? "");\n'
    );
    await chmod(fakeGh, 0o755);
    const result = spawnSync(
      process.execPath,
      [inspector, 'https://github.com/fablebookjs/lab-02/pull/194'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_GH_RESPONSE: JSON.stringify(patchbackPull()),
          PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}`,
        },
      }
    );

    assert.equal(result.stderr, '');
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.queueResolved, false);
    assert.equal(report.coordinationCommit, coordinationOid);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
