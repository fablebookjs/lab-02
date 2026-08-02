import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderPatchbackPrBody } from '../scripts/github/patchback/templates.ts';

const inspector = fileURLToPath(
  new URL(
    '../.agents/skills/gh-finish-patchback/scripts/inspect-patchback-pr.mjs',
    import.meta.url
  )
);

test('the Patchback inspector loads the current release modules', () => {
  const result = spawnSync(process.execPath, [inspector], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'inspect-patchback-pr: usage: inspect-patchback-pr.mjs <pr-number-or-url>\n'
  );
});

test('the Patchback inspector accepts generated divergent Migration tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'patchback-inspector-'));
  const fakeGh = join(directory, 'gh');
  const version = '10.4.3';
  const snapshotOid = '3'.repeat(40);
  const boundaryOid = 'a'.repeat(40);
  const coordinationOid = '7'.repeat(40);
  const migrationPath = 'migration-notes/v10.4/correct-existing-guidance.md';
  const body = renderPatchbackPrBody({
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
    recordPath: 'releases/v10.4.3.md',
    snapshotOid,
    version,
  });
  const pull = {
    baseRefName: 'main',
    body,
    commits: [
      {
        messageBody: [
          `Patchback-Version: ${version}`,
          `Patchback-Snapshot: ${snapshotOid}`,
          `Patchback-Boundary: ${boundaryOid}`,
        ].join('\n'),
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
  };

  try {
    await writeFile(
      fakeGh,
      '#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE ?? "");\n'
    );
    await chmod(fakeGh, 0o755);
    const result = spawnSync(process.execPath, [inspector, '194'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_RESPONSE: JSON.stringify(pull),
        PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}`,
      },
    });

    assert.equal(result.stderr, '');
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
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
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
