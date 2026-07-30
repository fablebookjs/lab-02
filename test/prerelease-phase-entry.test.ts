import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  parseManualPrereleasePhase,
  parsePhaseEntryCommitMessage,
  phaseEntryCommitMessage,
  planPhaseEntry,
} from '../scripts/shared/prerelease-phase-entry/core.ts';
import type {
  PhaseEntryCommit,
  PhaseEntrySnapshot,
} from '../scripts/shared/prerelease-phase-entry/core.ts';
import {
  phaseEntryRefUpdates,
} from '../scripts/github/prerelease-phase-entry/controller.ts';
import { ZERO_OID } from '../scripts/shared/release-proposal/core.ts';
import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const oid = (character: string): string => character.repeat(40);
const execute = promisify(execFile);
const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) => execute(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 });
const git = (args: string[], cwd: string) => run('git', args, cwd);

const copySeed = async (destination: string): Promise<void> => {
  await cp(repositoryRoot, destination, {
    filter: (source) => {
      const path = relative(repositoryRoot, source).split(sep);
      return !path.some((part) =>
        ['.cache', '.git', 'dist', 'node_modules'].includes(part),
      );
    },
    recursive: true,
  });
};

test('manual phase entry moves forward, may skip beta, and never moves backward', () => {
  assert.equal(parseManualPrereleasePhase('beta'), 'beta');
  assert.equal(parseManualPrereleasePhase('rc'), 'rc');
  assert.throws(
    () => parseManualPrereleasePhase('alpha'),
    /must be beta or rc/,
  );
  assert.deepEqual(
    planPhaseEntry({
      currentVersion: '3.2.0-alpha.7',
      entry: null,
      target: 'beta',
    }),
    { kind: 'establish', version: '3.2.0-beta.0' },
  );
  assert.deepEqual(
    planPhaseEntry({
      currentVersion: '3.2.0-alpha.7',
      entry: null,
      target: 'rc',
    }),
    { kind: 'establish', version: '3.2.0-rc.0' },
  );
  assert.deepEqual(
    planPhaseEntry({
      currentVersion: '3.2.0-beta.3',
      entry: null,
      target: 'rc',
    }),
    { kind: 'establish', version: '3.2.0-rc.0' },
  );
  assert.throws(
    () =>
      planPhaseEntry({
        currentVersion: '3.2.0-rc.0',
        entry: null,
        target: 'beta',
      }),
    /cannot move backward/,
  );
});

test('same-target runs reconcile only the exact managed .0 snapshot', () => {
  const entry: PhaseEntrySnapshot = {
    boundaryOid: oid('1'),
    phase: 'beta',
    snapshotOid: oid('3'),
    sourceOid: oid('2'),
    version: '3.2.0-beta.0',
  };
  assert.deepEqual(
    planPhaseEntry({
      currentVersion: '3.2.0-beta.4',
      entry,
      target: 'beta',
    }),
    {
      entry,
      kind: 'reconcile',
      version: '3.2.0-beta.0',
    },
  );
  assert.throws(
    () =>
      planPhaseEntry({
        currentVersion: '3.2.0-beta.4',
        entry: null,
        target: 'beta',
      }),
    /was not established by the managed phase-entry lifecycle/,
  );
});

test('phase-entry commit metadata round-trips without proposal authority', () => {
  const entry: PhaseEntryCommit = {
    boundaryOid: oid('1'),
    phase: 'rc',
    sourceOid: oid('2'),
    version: '3.2.0-rc.0',
  };
  assert.deepEqual(
    parsePhaseEntryCommitMessage(phaseEntryCommitMessage(entry)),
    entry,
  );
  assert.throws(
    () =>
      parsePhaseEntryCommitMessage(
        phaseEntryCommitMessage(entry).replace(
          'Prerelease-Phase-Boundary:',
          'Prerelease-Boundary:',
        ),
      ),
    /Prerelease-Phase-Boundary/,
  );
});

test('phase entry atomically advances main and discards the proposal ref', () => {
  assert.deepEqual(
    phaseEntryRefUpdates({
      currentMainOid: oid('1'),
      expectedStagedOid: oid('2'),
      snapshotOid: oid('3'),
    }),
    [
      {
        afterOid: oid('3'),
        beforeOid: oid('1'),
        force: false,
        name: 'refs/heads/main',
      },
      {
        afterOid: ZERO_OID,
        beforeOid: oid('2'),
        force: true,
        name: 'refs/heads/prerelease',
      },
    ],
  );
});

test('a phase-entry snapshot is one direct lockstep child of exact current main', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-prerelease-phase-entry-'),
  );
  const repository = join(temporaryRoot, 'repository');
  try {
    await copySeed(repository);
    await git(['init', '-b', 'main'], repository);
    await git(['config', 'user.name', 'Lab 02 test'], repository);
    await git(['config', 'user.email', 'lab-02-test@example.com'], repository);
    await git(['config', 'maintenance.auto', 'false'], repository);
    await run(
      process.execPath,
      ['scripts/version/set-version.ts', '3.2.0-alpha.1'],
      repository,
    );
    await git(['add', '.'], repository);
    await git(['commit', '-m', 'managed alpha snapshot'], repository);
    const boundaryOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();
    await writeFile(
      join(repository, 'phase-entry-work.txt'),
      'included in beta zero\n',
      'utf8',
    );
    await git(['add', 'phase-entry-work.txt'], repository);
    await git(['commit', '-m', 'Add beta feedback work'], repository);
    const sourceOid = (
      await git(['rev-parse', 'HEAD'], repository)
    ).stdout.trim();

    const prepared = await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const controller = await import('./scripts/github/prerelease-phase-entry/controller.ts');",
          'const entry = await controller.materializePhaseEntryCommit({',
          '  boundaryOid: process.env.BOUNDARY_OID,',
          '  sourceOid: process.env.SOURCE_OID,',
          "  target: 'beta',",
          '});',
          'console.log(JSON.stringify(entry));',
        ].join('\n'),
      ],
      repository,
      {
        ...process.env,
        BOUNDARY_OID: boundaryOid,
        SOURCE_OID: sourceOid,
      },
    );
    const output = prepared.stdout.trim().split('\n').at(-1);
    assert.ok(output);
    const entry: unknown = JSON.parse(output);
    assert.ok(entry !== null && typeof entry === 'object');
    assert.ok('snapshotOid' in entry && typeof entry.snapshotOid === 'string');
    const snapshotOid = entry.snapshotOid;
    assert.equal(
      (
        await git(
          ['show', '-s', '--format=%P', snapshotOid],
          repository,
        )
      ).stdout.trim(),
      sourceOid,
    );
    assert.equal(
      (await git(['rev-parse', 'main'], repository)).stdout.trim(),
      sourceOid,
    );
    const root: unknown = JSON.parse(
      (await git(['show', `${snapshotOid}:package.json`], repository)).stdout,
    );
    assert.ok(root !== null && typeof root === 'object' && 'version' in root);
    assert.equal(root.version, '3.2.0-beta.0');
    const workspaceManifests = [
      'packages/addon/package.json',
      'packages/core/package.json',
    ];
    for (const manifest of workspaceManifests) {
      const value: unknown = JSON.parse(
        (await git(['show', `${snapshotOid}:${manifest}`], repository)).stdout,
      );
      assert.ok(
        value !== null &&
          typeof value === 'object' &&
          'version' in value,
      );
      assert.equal(value.version, '3.2.0-beta.0');
    }
    await git(
      ['update-ref', 'refs/heads/main', snapshotOid, sourceOid],
      repository,
    );
    const discovered = await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const controller = await import('./scripts/github/prerelease-proposal/controller.ts');",
          'const boundary = await controller.findManagedPrereleaseBoundary(',
          '  process.env.SNAPSHOT_OID,',
          ');',
          'console.log(JSON.stringify(boundary));',
        ].join('\n'),
      ],
      repository,
      { ...process.env, SNAPSHOT_OID: snapshotOid },
    );
    assert.deepEqual(
      JSON.parse(discovered.stdout.trim().split('\n').at(-1) ?? 'null'),
      {
        kind: 'phase-entry',
        oid: snapshotOid,
        version: '3.2.0-beta.0',
      },
    );
    assert.equal(
      await readFile(join(repository, 'phase-entry-work.txt'), 'utf8'),
      'included in beta zero\n',
    );
  } finally {
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});
