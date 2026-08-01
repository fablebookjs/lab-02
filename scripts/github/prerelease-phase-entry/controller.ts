import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  extractPrereleasePrIdentity,
} from '../../shared/prerelease-proposal/body.ts';
import { nextPrereleaseVersion } from '../../shared/prerelease-proposal/core.ts';
import {
  parseManualPrereleasePhase,
  parsePhaseEntryCommitMessageIfPresent,
  phaseEntryCommitMessage,
  planPhaseEntry,
} from '../../shared/prerelease-phase-entry/core.ts';
import type {
  ManualPrereleasePhase,
  PhaseEntryCommit,
  PhaseEntrySnapshot,
} from '../../shared/prerelease-phase-entry/core.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { derivePrereleaseChanges } from '../../shared/release-communication/records.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import {
  parseDevelopmentVersion,
  ZERO_OID,
} from '../../shared/release-proposal/core.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import {
  PILOT_REPOSITORY,
  PRIMARY_BRANCH,
} from '../../shared/repository.ts';
import { requireControllerGitHubToken } from '../controller-inputs.ts';
import {
  commitMessageAt,
  commitParents,
  rootVersionAt,
  validateVersionTree,
} from '../../shared/prepared-commit/inspection.ts';
import {
  assertExpectedRef,
  importBundle,
  materializeCommit,
  prepareOutput,
  uploadCommitObject,
  writeBundle,
} from '../prepared-commit/mechanics.ts';
import {
  findManagedPrereleaseBoundary,
  firstParentCommitFacts,
} from '../release-history/history.ts';
import {
  getRepository,
} from '../release-repository/repository.ts';
import {
  closePullRequest,
  listPrereleasePulls,
} from '../release-repository/pull-requests.ts';
import { createRefUpdate, updateRefs } from '../release-repository/refs.ts';
import {
  observeStagedPrereleaseProposal,
  parseStagedPrereleaseProposal,
  validateStagedPrereleaseProposal,
} from '../staged-prerelease-proposal/observation.ts';
import {
  parsePhaseEntryTransition,
  PHASE_ENTRY_BUNDLE_REF,
} from './transition-schema.ts';
import type {
  CanonicalPrereleaseState,
  PhaseEntryAction,
  PhaseEntryActionBase,
} from './transition-schema.ts';

export type PhaseEntryApplication = {
  established: boolean;
  snapshot: string;
  version: string;
};

export function phaseEntryRefUpdates({
  currentMainOid,
  expectedStagedOid,
  snapshotOid,
}: {
  currentMainOid: string;
  expectedStagedOid: string | null;
  snapshotOid: string;
}): ReturnType<typeof createRefUpdate>[] {
  return [
    createRefUpdate({
      afterOid: snapshotOid,
      beforeOid: currentMainOid,
      name: `refs/heads/${PRIMARY_BRANCH}`,
    }),
    ...(expectedStagedOid === null
      ? []
      : [
          createRefUpdate({
            afterOid: ZERO_OID,
            beforeOid: expectedStagedOid,
            force: true,
            name: 'refs/heads/prerelease',
          }),
        ]),
  ];
}

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
};

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

const ensureRepository = async (): Promise<void> => {
  const root = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
  if (resolve(root) !== resolve(repositoryRoot)) {
    throw new Error(
      'Phase-entry commands must run from the Lab-02 repository.',
    );
  }
  if ((await git(['status', '--porcelain'])).stdout.trim().length > 0) {
    throw new Error('Phase-entry preparation requires a clean working tree.');
  }
};

const currentOid = async (): Promise<string> =>
  oidValue(
    await resolveHeadOid(repositoryRoot),
    'Current repository commit',
  );

const prereleaseChanges = async (
  token: string,
  range: { boundaryOid: string; sourceOid: string },
): Promise<ReleaseChange[]> =>
  derivePrereleaseChanges({
    commits: await firstParentCommitFacts(repositoryRoot, token, {
      boundaryOid: range.boundaryOid,
      headOid: range.sourceOid,
      label: 'main prerelease',
    }),
  });

const validatePhaseEntrySnapshot = async (
  snapshot: PhaseEntrySnapshot,
): Promise<void> => {
  const message = await commitMessageAt(repositoryRoot, snapshot.snapshotOid);
  const parsed = parsePhaseEntryCommitMessageIfPresent(message);
  if (parsed === null) {
    throw new Error(`${snapshot.snapshotOid} has no phase-entry metadata.`);
  }
  assert.deepEqual(parsed, {
    boundaryOid: snapshot.boundaryOid,
    phase: snapshot.phase,
    sourceOid: snapshot.sourceOid,
    version: snapshot.version,
  });
  assert.deepEqual(
    await commitParents(repositoryRoot, snapshot.snapshotOid),
    [snapshot.sourceOid],
  );
  await validateVersionTree(repositoryRoot, snapshot.snapshotOid, snapshot.version);
};

const findPhaseEntrySnapshot = async (
  mainOid: string,
  phase: ManualPrereleasePhase,
  series: { major: number; minor: number },
): Promise<PhaseEntrySnapshot | null> => {
  const history = (
    await git(['rev-list', '--first-parent', mainOid])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const snapshotOid of history) {
    const entry = parsePhaseEntryCommitMessageIfPresent(
      await commitMessageAt(repositoryRoot, snapshotOid),
    );
    if (entry === null) continue;
    const parsed = planPhaseEntry({
      currentVersion: entry.version,
      entry: { ...entry, snapshotOid },
      target: entry.phase,
    });
    if (
      entry.phase === phase &&
      parsed.kind === 'reconcile' &&
      entry.version.startsWith(`${series.major}.${series.minor}.`)
    ) {
      const snapshot = { ...entry, snapshotOid };
      await validatePhaseEntrySnapshot(snapshot);
      return snapshot;
    }
  }
  return null;
};

const canonicalPrereleaseState = async (
  token: string,
  {
    boundaryOid,
    currentVersion,
    mainOid,
  }: {
    boundaryOid: string;
    currentVersion: string;
    mainOid: string;
  },
): Promise<CanonicalPrereleaseState> => {
  const observation = await observeStagedPrereleaseProposal(token);
  const pull = observation.openPull ?? undefined;
  const staged = await parseStagedPrereleaseProposal(observation.stagedOid);
  if (pull !== undefined && staged === null) {
    throw new Error('The open Prerelease PR has no canonical proposal ref.');
  }
  if (staged !== null) {
    await validateStagedPrereleaseProposal(staged);
    if (
      staged.boundaryOid !== boundaryOid ||
      staged.version !== nextPrereleaseVersion(currentVersion)
    ) {
      throw new Error(
        'The canonical prerelease proposal contradicts the current managed phase.',
      );
    }
    const ancestry = (
      await git(['rev-list', '--first-parent', mainOid])
    ).stdout
      .trim()
      .split('\n');
    if (!ancestry.includes(staged.sourceOid)) {
      throw new Error(
        'The canonical prerelease proposal source is not on current main.',
      );
    }
    if (pull !== undefined) {
      const identity = extractPrereleasePrIdentity(pull.body);
      if (
        pull.head.sha !== staged.oid ||
        identity === null ||
        identity.boundaryOid !== staged.boundaryOid ||
        identity.proposalOid !== staged.oid ||
        identity.sourceOid !== staged.sourceOid ||
        identity.version !== staged.version
      ) {
        throw new Error(
          'The open Prerelease PR contradicts its canonical proposal ref.',
        );
      }
    }
  }
  return {
    expectedStagedOid: staged?.oid ?? null,
    openPr: pull?.number,
  };
};

export async function materializePhaseEntryCommit({
  boundaryOid,
  sourceOid,
  target,
}: {
  boundaryOid: string;
  sourceOid: string;
  target: string;
}): Promise<PhaseEntrySnapshot> {
  const sourceVersion = await rootVersionAt(repositoryRoot, sourceOid);
  const phase = parseManualPrereleasePhase(target);
  const plan = planPhaseEntry({
    currentVersion: sourceVersion,
    entry: null,
    target: phase,
  });
  if (plan.kind !== 'establish') {
    throw new Error('A new phase-entry commit requires a forward transition.');
  }
  const entry: PhaseEntryCommit = {
    boundaryOid,
    phase,
    sourceOid,
    version: plan.version,
  };
  const snapshotOid = await materializeCommit({
    message: phaseEntryCommitMessage(entry),
    sourceOid,
    version: plan.version,
  });
  const snapshot = { ...entry, snapshotOid };
  await validatePhaseEntrySnapshot(snapshot);
  return snapshot;
}

export async function preparePhaseEntry(
  options: { 'github-token': string; output: string; target: string },
): Promise<void> {
  await ensureRepository();
  const output = await prepareOutput(
    requireOption(options, 'output'),
  );
  const phase = parseManualPrereleasePhase(
    requireOption(options, 'target'),
  );
  const token = requireControllerGitHubToken(options);
  const mainOid = await currentOid();
  const currentVersion = await rootVersionAt(repositoryRoot, mainOid);
  const current = parseDevelopmentVersion(currentVersion);
  const boundary = await findManagedPrereleaseBoundary(repositoryRoot, mainOid);
  if (boundary === null || boundary.version !== currentVersion) {
    throw new Error(
      'Phase entry requires a current managed prerelease snapshot.',
    );
  }
  const existing = await findPhaseEntrySnapshot(mainOid, phase, current);
  const plan = planPhaseEntry({
    currentVersion,
    entry: existing,
    target: phase,
  });
  const canonical = await canonicalPrereleaseState(token, {
    boundaryOid: boundary.oid,
    currentVersion,
    mainOid,
  });

  let snapshot: PhaseEntrySnapshot;
  let action: PhaseEntryAction;
  if (plan.kind === 'establish') {
    snapshot = await materializePhaseEntryCommit({
      boundaryOid: boundary.oid,
      sourceOid: mainOid,
      target: phase,
    });
    await writeBundle(join(output, 'objects.bundle'), [
      { name: PHASE_ENTRY_BUNDLE_REF, oid: snapshot.snapshotOid },
    ]);
    action = {
      ...canonical,
      boundaryOid: snapshot.boundaryOid,
      bundleRef: PHASE_ENTRY_BUNDLE_REF,
      changes: await prereleaseChanges(token, {
        boundaryOid: snapshot.boundaryOid,
        sourceOid: snapshot.sourceOid,
      }),
      currentMainOid: mainOid,
      kind: 'establish',
      phase,
      snapshotOid: snapshot.snapshotOid,
      sourceOid: snapshot.sourceOid,
      version: snapshot.version,
    };
  } else {
    snapshot = plan.entry;
    action = {
      ...canonical,
      boundaryOid: snapshot.boundaryOid,
      changes: await prereleaseChanges(token, {
        boundaryOid: snapshot.boundaryOid,
        sourceOid: snapshot.sourceOid,
      }),
      currentMainOid: mainOid,
      kind: 'reconcile',
      phase,
      snapshotOid: snapshot.snapshotOid,
      sourceOid: snapshot.sourceOid,
      version: snapshot.version,
    };
  }

  await writeJsonFile(join(output, 'transition.json'), {
    action,
    kind: 'prerelease-phase-entry',
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  console.log(`Prepared phase-entry action: ${action.kind} ${action.version}.`);
}

const ensureTrustedMain = (): void => {
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== `refs/heads/${PRIMARY_BRANCH}`
  ) {
    throw new Error('Phase entry is restricted to trusted main.');
  }
};

const assertCanonicalPrereleaseState = async (
  token: string,
  expected: CanonicalPrereleaseState,
): Promise<void> => {
  await assertExpectedRef(
    token,
    'heads/prerelease',
    expected.expectedStagedOid,
  );
  const open = (await listPrereleasePulls(token)).filter(
    ({ state }) => state === 'open',
  );
  if (
    open.length !== (expected.openPr === undefined ? 0 : 1) ||
    (expected.openPr !== undefined && open[0]?.number !== expected.openPr)
  ) {
    throw new Error('The canonical Prerelease PR changed after preparation.');
  }
};

export function phaseEntryPrereleaseAuthority(
  action: Pick<
    PhaseEntryActionBase,
    'boundaryOid' | 'changes' | 'phase' | 'sourceOid' | 'version'
  >,
  snapshotOid: string,
) {
  return {
    boundaryOid: action.boundaryOid,
    changes: action.changes,
    channel: 'next',
    phase: action.phase,
    repository: PILOT_REPOSITORY,
    schema: 1,
    snapshotOid,
    sourceOid: action.sourceOid,
    version: action.version,
  };
}

const writeAuthority = async (
  output: string,
  action: PhaseEntryAction,
  snapshotOid: string,
): Promise<void> => {
  await writeJsonFile(
    join(output, 'authority.json'),
    phaseEntryPrereleaseAuthority(action, snapshotOid),
  );
};

export async function applyPhaseEntry(
  options: {
    bundle?: string;
    'github-token': string;
    output: string;
    transition: string;
  },
): Promise<PhaseEntryApplication> {
  await ensureRepository();
  ensureTrustedMain();
  const transition = parsePhaseEntryTransition(
    await readJsonFile(resolve(requireOption(options, 'transition'))),
  );
  const output = await prepareOutput(
    requireOption(options, 'output'),
  );
  const token = requireControllerGitHubToken(options);
  const action = transition.action;
  await getRepository(token);
  await assertExpectedRef(
    token,
    `heads/${PRIMARY_BRANCH}`,
    action.currentMainOid,
  );
  await assertCanonicalPrereleaseState(token, action);

  let appliedSnapshotOid = action.snapshotOid;
  if (action.kind === 'establish') {
    const bundle = options.bundle;
    if (bundle === undefined) {
      throw new Error('A new phase entry requires its Git object bundle.');
    }
    await importBundle(resolve(bundle), [
      { name: action.bundleRef, oid: action.snapshotOid },
    ]);
    await validatePhaseEntrySnapshot(action);
    const planned = planPhaseEntry({
      currentVersion: await rootVersionAt(repositoryRoot, action.sourceOid),
      entry: null,
      target: action.phase,
    });
    assert.deepEqual(planned, {
      kind: 'establish',
      version: action.version,
    });
    appliedSnapshotOid = await uploadCommitObject(
      token,
      action.snapshotOid,
    );
    await assertExpectedRef(
      token,
      `heads/${PRIMARY_BRANCH}`,
      action.currentMainOid,
    );
    await assertCanonicalPrereleaseState(token, action);

    const repository = await getRepository(token);
    await updateRefs(
      token,
      repository.node_id,
      phaseEntryRefUpdates({
        currentMainOid: action.currentMainOid,
        expectedStagedOid: action.expectedStagedOid,
        snapshotOid: appliedSnapshotOid,
      }),
    );
    if (action.openPr !== undefined) {
      await closePullRequest(token, action.openPr);
    }
    console.log(`Established ${action.version} directly on main.`);
  } else {
    await validatePhaseEntrySnapshot(action);
    console.log(`Reconciled existing phase entry ${action.version}.`);
  }

  await writeAuthority(output, action, appliedSnapshotOid);
  return {
    established: action.kind === 'establish',
    snapshot: appliedSnapshotOid,
    version: action.version,
  };
}
