import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveHeadOid } from '../../shared/git/repository.ts';

import {
  compareReleaseLines,
  deriveProposalAccountingBoundary,
  deriveCutVersions,
  developmentCommitMessage,
  parsePrereleaseBootstrapCommitMessageIfPresent,
  parseProposalMessage,
  parseReleaseLine,
  parseStableVersion,
  planProposalMaintenance,
  proposalCommitMessage,
  ZERO_OID,
} from '../../shared/release-proposal/core.ts';
import {
  PILOT_REPOSITORY,
  PRIMARY_BRANCH,
} from '../../shared/repository.ts';
import { getReleaseByTag } from '../release-repository/releases.ts';
import { getRepository } from '../release-repository/repository.ts';
import {
  closePullRequest,
  createDraftReleasePr,
  getPullRequest,
  listPrereleasePulls,
  listReleasePulls,
  updatePullRequestBody,
} from '../release-repository/pull-requests.ts';
import { getGitCommit } from '../release-repository/commits.ts';
import {
  createRefUpdate,
  getRef,
  listMatchingRefs,
  resolveRefObject,
  updateRefs,
} from '../release-repository/refs.ts';
import type { GitReference } from '../release-repository/refs.ts';
import type { GitPullRequest } from '../release-repository/pull-requests.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import {
  composeMigrationRecords,
  derivePrereleaseChanges,
  deriveReleaseChanges,
  migrationRecordDirectory,
  normalizeReleaseChanges,
  releaseRecordPath,
  renderReleaseRecord,
} from '../../shared/release-communication/records.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import {
  extractReleasePrIdentity,
  renderReleasePrBody,
  selectLatestMatchingReleasePrBody,
  validateReleasePrBody,
} from '../../shared/release-proposal/body.ts';
import type { ValidatedPullRequest } from '../events.ts';
import { requireControllerGitHubToken } from '../controller-inputs.ts';
import {
  commitMessageAt,
  commitParents,
  ensureCleanReleaseRepository,
  publicPackagesAt,
  rootVersionAt,
  validateFullOid,
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
  developmentCommitFacts,
  findDevelopmentBootstrap,
  findReleaseCut,
  firstParentCommitFacts,
} from '../release-history/history.ts';
const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';

type ProposalBodyAction = {
  changes: unknown[];
  line: string;
  previousHighlightsBody?: string | undefined;
  releaseOid: string;
  supersededPr?: number | undefined;
  version: string;
};

type CutTransition = {
  changes: ReleaseChange[];
  developmentBundleRef: string;
  developmentOid: string;
  developmentVersion: string;
  expectedPrereleaseOid: string | null;
  kind: 'cut';
  line: string;
  openPrereleasePr: number | undefined;
  proposalBundleRef: string;
  proposalOid: string;
  releaseVersion: string;
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
  sourceOid: string;
};

type MaintenanceActionBase = {
  expectedStagedOid: string | null;
  line: string;
  previousHighlightsBody: string | undefined;
  releaseOid: string;
  supersededPr: number | undefined;
};

type DormantAction = MaintenanceActionBase & {
  changes: undefined;
  kind: 'dormant';
  openPr: number | undefined;
};

type OpenAction = MaintenanceActionBase & {
  changes: unknown[];
  kind: 'open';
  openPr: undefined;
  proposalOid: string;
  version: string;
};

type SyncAction = MaintenanceActionBase & {
  changes: unknown[];
  kind: 'sync';
  openPr: number;
  proposalOid: string;
  version: string;
};

type MaterializedAction = MaintenanceActionBase & {
  bundleRef: string;
  changes: unknown[];
  kind: 'create' | 'recreate';
  openPr: number | undefined;
  proposalOid: string;
  version: string;
};

type ReplacementAction = MaintenanceActionBase & {
  bundleRef: string;
  changes: unknown[];
  kind: 'refresh' | 'replace';
  openPr: number;
  proposalOid: string;
  version: string;
};

type MaintenanceAction =
  | DormantAction
  | MaterializedAction
  | OpenAction
  | ReplacementAction
  | SyncAction;

type MaintenanceTransition = {
  actions: MaintenanceAction[];
  kind: 'maintenance';
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
};

type MaintenanceState = {
  accountingOid: string | null;
  closedPrs: Array<{ body: string; number: number; state: string }>;
  latestClosedPr: {
    headOid: string;
    merged: boolean;
    number: number;
    version: string;
  } | null;
  line: string;
  lineVersion: string;
  openPr: {
    bodyCurrent: boolean;
    number: number;
    replaceRequired: boolean;
  } | null;
  releaseOid: string;
  staged: (ReturnType<typeof parseProposalMessage> & { oid: string }) | null;
};

export type PrepareCutOptions = {
  'github-token': string;
  'next-development': string;
  output: string;
};

export type ApplyCutOptions = {
  bundle: string;
  'github-token': string;
  transition: string;
};

export type PrepareMaintenanceOptions = {
  'github-token': string;
  output: string;
};

export type ApplyMaintenanceOptions = {
  bundle?: string;
  'github-token': string;
  transition: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  return stringValue(value, label);
};

const optionalPositiveInteger = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const nullableOid = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  validateFullOid(value, label);
  return value;
};

const cutTransitionValue = (value: unknown): CutTransition => {
  if (!isRecord(value)) throw new Error('Cut transition must be an object.');
  if (
    value['schema'] !== 1 ||
    value['kind'] !== 'cut' ||
    value['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Cut transition is outside the accepted schema.');
  }
  return {
    changes: normalizeReleaseChanges(value['changes']),
    developmentBundleRef: stringValue(
      value['developmentBundleRef'],
      'Cut development bundle ref',
    ),
    developmentOid: stringValue(value['developmentOid'], 'Cut development OID'),
    developmentVersion: stringValue(
      value['developmentVersion'],
      'Cut development version',
    ),
    expectedPrereleaseOid: nullableOid(
      value['expectedPrereleaseOid'],
      'Cut prerelease ref expectation',
    ),
    kind: 'cut',
    line: stringValue(value['line'], 'Cut release line'),
    openPrereleasePr: optionalPositiveInteger(
      value['openPrereleasePr'],
      'Cut open Prerelease PR',
    ),
    proposalBundleRef: stringValue(value['proposalBundleRef'], 'Cut proposal bundle ref'),
    proposalOid: stringValue(value['proposalOid'], 'Cut proposal OID'),
    releaseVersion: stringValue(value['releaseVersion'], 'Cut release version'),
    repository: PILOT_REPOSITORY,
    schema: 1,
    sourceOid: stringValue(value['sourceOid'], 'Cut source OID'),
  };
};

const maintenanceActionValue = (value: unknown): MaintenanceAction => {
  if (!isRecord(value)) throw new Error('Maintenance action must be an object.');
  const kind = value['kind'];
  if (
    kind !== 'create' &&
    kind !== 'dormant' &&
    kind !== 'open' &&
    kind !== 'recreate' &&
    kind !== 'refresh' &&
    kind !== 'replace' &&
    kind !== 'sync'
  ) {
    throw new Error(`Unknown maintenance action: ${String(kind)}`);
  }
  const base: MaintenanceActionBase = {
    expectedStagedOid: nullableOid(
      value['expectedStagedOid'],
      'Maintenance staged expectation',
    ),
    line: stringValue(value['line'], 'Maintenance release line'),
    previousHighlightsBody: optionalString(
      value['previousHighlightsBody'],
      'Maintenance previous highlights',
    ),
    releaseOid: stringValue(value['releaseOid'], 'Maintenance release OID'),
    supersededPr: optionalPositiveInteger(
      value['supersededPr'],
      'Maintenance superseded PR',
    ),
  };
  const openPr = optionalPositiveInteger(value['openPr'], 'Maintenance open PR');
  if (kind === 'dormant') return { ...base, changes: undefined, kind, openPr };

  const changes = value['changes'];
  if (!Array.isArray(changes)) {
    throw new Error(`${kind} maintenance action requires a changes array.`);
  }
  const proposalOid = stringValue(value['proposalOid'], 'Maintenance proposal OID');
  const version = stringValue(value['version'], 'Maintenance version');
  if (kind === 'open') {
    return { ...base, changes, kind, openPr: undefined, proposalOid, version };
  }
  if (kind === 'sync') {
    if (openPr === undefined) throw new Error('Sync maintenance action requires an open PR.');
    return { ...base, changes, kind, openPr, proposalOid, version };
  }

  const bundleRef = stringValue(value['bundleRef'], 'Maintenance bundle ref');
  if (kind === 'refresh' || kind === 'replace') {
    if (openPr === undefined) {
      throw new Error(`${kind} maintenance action requires an open PR.`);
    }
    return { ...base, bundleRef, changes, kind, openPr, proposalOid, version };
  }
  return { ...base, bundleRef, changes, kind, openPr, proposalOid, version };
};

const maintenanceTransitionValue = (value: unknown): MaintenanceTransition => {
  if (
    !isRecord(value) ||
    value['schema'] !== 1 ||
    value['kind'] !== 'maintenance' ||
    value['repository'] !== PILOT_REPOSITORY ||
    !Array.isArray(value['actions'])
  ) {
    throw new Error('Maintenance transition is outside the accepted schema.');
  }
  return {
    actions: value['actions'].map(maintenanceActionValue),
    kind: 'maintenance',
    repository: PILOT_REPOSITORY,
    schema: 1,
  };
};

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

const releasePrTemplate = (version: string): Promise<string> => {
  const { patch } = parseStableVersion(version);
  const filename =
    patch === 0 ? 'release-pr-initial.md' : 'release-pr-patch.md';
  return readFile(
    join(repositoryRoot, '.github/release-templates', filename),
    'utf8'
  );
};

const developmentLineChanges = async (
  token: string,
  {
    boundaryOid,
    sourceOid,
  }: {
    boundaryOid: string;
    sourceOid: string;
  },
): Promise<ReleaseChange[]> => {
  const commits = (
    await developmentCommitFacts(token, { boundaryOid, sourceOid })
  ).filter(({ mechanical }) => !mechanical);
  return derivePrereleaseChanges({ commits });
};

const combineReleaseChanges = (
  ...groups: readonly ReleaseChange[][]
): ReleaseChange[] => {
  const seen = new Set<string>();
  return normalizeReleaseChanges(
    groups
      .flat()
      .filter(({ key }) => {
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
  );
};

const releaseChanges = async (
  token: string,
  {
    boundaryOid,
    line,
    releaseOid,
  }: { boundaryOid: string; line: string; releaseOid: string },
): Promise<ReleaseChange[]> => {
  const commits = await firstParentCommitFacts(token, {
    boundaryOid,
    headOid: releaseOid,
    label: line,
  });
  return deriveReleaseChanges({ commits, line });
};

export const initialReleaseChanges = async (
  token: string,
  {
    line,
    releaseOid,
  }: {
    line: string;
    releaseOid: string;
  },
): Promise<ReleaseChange[]> => {
  const cut = await findReleaseCut(line);
  const bootstrap = await findDevelopmentBootstrap({
    line,
    sourceOid: cut.sourceOid,
  });
  return combineReleaseChanges(
    await developmentLineChanges(token, {
      boundaryOid: bootstrap.oid,
      sourceOid: cut.sourceOid,
    }),
    await releaseChanges(token, {
      boundaryOid: cut.sourceOid,
      line,
      releaseOid,
    }),
  );
};

const migrationRecordsAt = async (
  oid: string,
  line: string,
): Promise<Array<{ body: string; filename: string; title: string }>> => {
  const directory = migrationRecordDirectory(line);
  let filenames: string[];
  try {
    const { stdout } = await git([
      'ls-tree',
      '-r',
      '--name-only',
      `${oid}:${directory}`,
    ]);
    filenames = stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (
    filenames.some(
      (filename) => filename.includes('/') || !filename.endsWith('.md')
    )
  ) {
    throw new Error(`${directory} contains an unsupported migration record path.`);
  }
  const records = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      source: (await git(['show', `${oid}:${directory}/${filename}`])).stdout,
    }))
  );
  return composeMigrationRecords(records);
};

const renderProposalBody = async ({
  action,
  previousBody = '',
  proposalOid,
  contentOid = proposalOid,
}: {
  action: ProposalBodyAction;
  contentOid?: string;
  previousBody?: string;
  proposalOid: string;
}): Promise<string> => {
  const { packages } = await publicPackagesAt(contentOid);
  return renderReleasePrBody({
    changes: action.changes,
    line: action.line,
    migrationRecords: await migrationRecordsAt(contentOid, action.line),
    packageNames: packages.map(({ name }) => name),
    previousBody,
    previousHighlightsBody: action.previousHighlightsBody ?? previousBody,
    proposalOid,
    releaseOid: action.releaseOid,
    ...(action.supersededPr === undefined ? {} : { supersededPr: action.supersededPr }),
    template: await releasePrTemplate(action.version),
    version: action.version,
  });
};

const createReleasePr = async (
  token: string,
  action: ProposalBodyAction,
  proposalOid: string,
  contentOid = proposalOid,
): Promise<GitPullRequest> => {
  const body = await renderProposalBody({ action, contentOid, proposalOid });
  return createDraftReleasePr(token, { ...action, body });
};

const validateProposalCommit = async (
  oid: string,
  expected: {
    changes?: unknown;
    line: string;
    sourceOid: string;
    version: string;
  },
): Promise<void> => {
  assert.deepEqual(await commitParents(oid), [expected.sourceOid]);
  const metadata = parseProposalMessage(await commitMessageAt(oid));
  assert.equal(metadata.line, expected.line);
  assert.equal(metadata.sourceOid, expected.sourceOid);
  assert.equal(metadata.version, expected.version);
  await validateVersionTree(oid, expected.version);
  const path = releaseRecordPath(expected.version);
  let record;
  try {
    record = (await git(['show', `${oid}:${path}`])).stdout;
  } catch {
    throw new Error(`${oid} does not contain its generated release record at ${path}.`);
  }
  if (expected.changes !== undefined) {
    assert.equal(
      record,
      renderReleaseRecord({ changes: expected.changes, version: expected.version })
    );
  } else if (
    !record.startsWith(`# v${expected.version} changes\n`)
  ) {
    throw new Error(`${path} is not the generated record for v${expected.version}.`);
  }
};

const validateDevelopmentCommit = async (
  oid: string,
  expected: { line: string; sourceOid: string; version: string },
): Promise<void> => {
  assert.deepEqual(await commitParents(oid), [expected.sourceOid]);
  const message = await commitMessageAt(oid);
  assert.deepEqual(
    parsePrereleaseBootstrapCommitMessageIfPresent(message),
    expected,
  );
  assert.match(message, new RegExp(`^release: begin ${expected.version.replaceAll('.', '\\.')} development`));
  assert.match(message, new RegExp(`Release-Cut-Line: ${expected.line.replace('.', '\\.')}`));
  assert.match(message, new RegExp(`Release-Cut-Source: ${expected.sourceOid}`));
  assert.match(message, new RegExp(`Development-Version: ${expected.version.replaceAll('.', '\\.')}`));
  await validateVersionTree(oid, expected.version);
};

const validateCutTransition = async (transition: CutTransition): Promise<void> => {
  parseReleaseLine(transition.line);
  parseStableVersion(transition.releaseVersion);
  validateFullOid(transition.sourceOid, 'Cut source');
  validateFullOid(transition.proposalOid, 'Proposal');
  validateFullOid(transition.developmentOid, 'Development commit');
  const sourceVersion = await rootVersionAt(transition.sourceOid);
  const minor = deriveCutVersions(sourceVersion, 'minor');
  const major = deriveCutVersions(sourceVersion, 'major');
  const matches = [minor, major].some(
    (candidate) =>
      candidate.line === transition.line &&
      candidate.releaseVersion === transition.releaseVersion &&
      candidate.developmentVersion === transition.developmentVersion
  );
  if (!matches) {
    throw new Error('Cut versions are not a minor or major transition from their source.');
  }
};

export async function prepareCut(options: PrepareCutOptions): Promise<void> {
  await ensureCleanReleaseRepository();
  const nextDevelopment = requireOption(options, 'next-development');
  const output = await prepareOutput(requireOption(options, 'output'));
  const token = requireControllerGitHubToken(options);
  const sourceOid = await resolveHeadOid(repositoryRoot);
  const versions = deriveCutVersions(await rootVersionAt(sourceOid), nextDevelopment);
  const bootstrap = await findDevelopmentBootstrap({
    line: versions.line,
    sourceOid,
  });
  const changes = await developmentLineChanges(token, {
    boundaryOid: bootstrap.oid,
    sourceOid,
  });
  const prereleaseRef = await getRef(token, 'heads/prerelease');
  const openPrereleasePulls = (await listPrereleasePulls(token)).filter(
    ({ state }) => state === 'open',
  );
  if (openPrereleasePulls.length > 1) {
    throw new Error('More than one canonical Prerelease PR is open.');
  }
  const openPrereleasePull = openPrereleasePulls[0];
  if (
    openPrereleasePull !== undefined &&
    (prereleaseRef === null ||
      openPrereleasePull.head.sha !== prereleaseRef.oid)
  ) {
    throw new Error(
      'The open Prerelease PR contradicts its canonical proposal ref.',
    );
  }
  const attempt = randomUUID();

  const proposalOid = await materializeCommit({
    files: [
      {
        content: renderReleaseRecord({ changes, version: versions.releaseVersion }),
        path: releaseRecordPath(versions.releaseVersion),
      },
    ],
    message: proposalCommitMessage({
      attempt,
      line: versions.line,
      sourceOid,
      version: versions.releaseVersion,
    }),
    sourceOid,
    version: versions.releaseVersion,
  });
  const developmentOid = await materializeCommit({
    message: developmentCommitMessage({
      line: versions.line,
      sourceOid,
      version: versions.developmentVersion,
    }),
    sourceOid,
    version: versions.developmentVersion,
  });

  await validateProposalCommit(proposalOid, {
    changes,
    line: versions.line,
    sourceOid,
    version: versions.releaseVersion,
  });
  await validateDevelopmentCommit(developmentOid, {
    line: versions.line,
    sourceOid,
    version: versions.developmentVersion,
  });

  const proposalBundleRef = `${ARTIFACT_PREFIX}cut-proposal`;
  const developmentBundleRef = `${ARTIFACT_PREFIX}cut-development`;
  await writeBundle(join(output, 'objects.bundle'), [
    { name: proposalBundleRef, oid: proposalOid },
    { name: developmentBundleRef, oid: developmentOid },
  ]);

  await writeJsonFile(join(output, 'transition.json'), {
    changes,
    developmentBundleRef,
    developmentOid,
    developmentVersion: versions.developmentVersion,
    expectedPrereleaseOid: prereleaseRef?.oid ?? null,
    kind: 'cut',
    line: versions.line,
    ...(openPrereleasePull === undefined
      ? {}
      : { openPrereleasePr: openPrereleasePull.number }),
    proposalBundleRef,
    proposalOid,
    releaseVersion: versions.releaseVersion,
    repository: PILOT_REPOSITORY,
    schema: 1,
    sourceOid,
  });
  console.log(`Prepared ${versions.line} from ${sourceOid}.`);
}

export function cutPrereleaseAuthority({
  developmentVersion,
  line,
  snapshotOid,
  sourceOid,
}: {
  developmentVersion: string;
  line: string;
  snapshotOid: string;
  sourceOid: string;
}) {
  return {
    boundaryOid: snapshotOid,
    changes: [],
    channel: 'next',
    cutLine: line,
    repository: PILOT_REPOSITORY,
    schema: 1,
    snapshotOid,
    sourceOid,
    version: developmentVersion,
  };
}

export function cutRefUpdates({
  developmentOid,
  expectedPrereleaseOid,
  line,
  proposalOid,
  sourceOid,
}: {
  developmentOid: string;
  expectedPrereleaseOid: string | null;
  line: string;
  proposalOid: string;
  sourceOid: string;
}): ReturnType<typeof createRefUpdate>[] {
  return [
    createRefUpdate({
      afterOid: sourceOid,
      name: `refs/heads/releases/${line}`,
    }),
    createRefUpdate({
      afterOid: proposalOid,
      name: `refs/heads/staged/${line}`,
    }),
    createRefUpdate({
      afterOid: developmentOid,
      beforeOid: sourceOid,
      name: `refs/heads/${PRIMARY_BRANCH}`,
    }),
    ...(expectedPrereleaseOid === null
      ? []
      : [
          createRefUpdate({
            afterOid: ZERO_OID,
            beforeOid: expectedPrereleaseOid,
            force: true,
            name: 'refs/heads/prerelease',
          }),
        ]),
  ];
}

export async function applyCut(options: ApplyCutOptions): Promise<void> {
  await ensureCleanReleaseRepository();
  const transitionPath = resolve(requireOption(options, 'transition'));
  const bundlePath = resolve(requireOption(options, 'bundle'));
  const transition = cutTransitionValue(await readJsonFile(transitionPath));
  const token = requireControllerGitHubToken(options);
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== `refs/heads/${PRIMARY_BRANCH}`
  ) {
    throw new Error('Cut transition is outside the trusted pilot context.');
  }

  const repository = await getRepository(token);
  await importBundle(bundlePath, [
    { name: transition.proposalBundleRef, oid: transition.proposalOid },
    { name: transition.developmentBundleRef, oid: transition.developmentOid },
  ]);
  await validateCutTransition(transition);
  await validateProposalCommit(transition.proposalOid, {
    changes: transition.changes,
    line: transition.line,
    sourceOid: transition.sourceOid,
    version: transition.releaseVersion,
  });
  await validateDevelopmentCommit(transition.developmentOid, {
    line: transition.line,
    sourceOid: transition.sourceOid,
    version: transition.developmentVersion,
  });
  const uploadedProposalOid = await uploadCommitObject(token, transition.proposalOid);
  const uploadedDevelopmentOid = await uploadCommitObject(token, transition.developmentOid);

  const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
  if (main?.oid !== transition.sourceOid) {
    throw new Error('main advanced after cut preparation; no refs were changed.');
  }
  if (
    (await getRef(token, `heads/releases/${transition.line}`)) !== null ||
    (await getRef(token, `heads/staged/${transition.line}`)) !== null
  ) {
    throw new Error(`${transition.line} already exists; no refs were changed.`);
  }
  const livePrerelease = await getRef(token, 'heads/prerelease');
  if ((livePrerelease?.oid ?? null) !== transition.expectedPrereleaseOid) {
    throw new Error(
      'The canonical prerelease proposal changed after cut preparation.',
    );
  }
  const openPrereleasePulls = (await listPrereleasePulls(token)).filter(
    ({ state }) => state === 'open',
  );
  if (
    openPrereleasePulls.length !==
      (transition.openPrereleasePr === undefined ? 0 : 1) ||
    (transition.openPrereleasePr !== undefined &&
      openPrereleasePulls[0]?.number !== transition.openPrereleasePr)
  ) {
    throw new Error('The canonical Prerelease PR changed after cut preparation.');
  }

  await updateRefs(
    token,
    repository.node_id,
    cutRefUpdates({
      developmentOid: uploadedDevelopmentOid,
      expectedPrereleaseOid: transition.expectedPrereleaseOid,
      line: transition.line,
      proposalOid: uploadedProposalOid,
      sourceOid: transition.sourceOid,
    }),
  );
  if (transition.openPrereleasePr !== undefined) {
    await closePullRequest(token, transition.openPrereleasePr);
  }

  const openPulls = (await listReleasePulls(token, transition.line)).filter(
    ({ state }) => state === 'open'
  );
  if (openPulls.length === 0) {
    await createReleasePr(
      token,
      {
        changes: transition.changes,
        line: transition.line,
        releaseOid: transition.sourceOid,
        version: transition.releaseVersion,
      },
      uploadedProposalOid,
      transition.proposalOid
    );
  } else if (openPulls.length !== 1) {
    throw new Error(`${transition.line} has more than one open canonical release PR.`);
  }
  await writeJsonFile(
    join(dirname(transitionPath), 'authority.json'),
    cutPrereleaseAuthority({
      developmentVersion: transition.developmentVersion,
      line: transition.line,
      snapshotOid: uploadedDevelopmentOid,
      sourceOid: transition.sourceOid,
    }),
  );
  console.log(`Cut ${transition.line} and opened its draft ${transition.releaseVersion} proposal.`);
}

const refOid = (ref: GitReference): string => ref.object.sha;

const latestCompletedOid = async (
  token: string,
  line: string,
  tagRefs: GitReference[],
): Promise<string | null> => {
  const lineVersion = parseReleaseLine(line);
  const candidates = tagRefs
    .map((ref) => ({
      ref,
      version: ref.ref.replace('refs/tags/v', ''),
    }))
    .filter(({ version }) => {
      try {
        const parsed = parseStableVersion(version);
        return parsed.major === lineVersion.major && parsed.minor === lineVersion.minor;
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const a = parseStableVersion(left.version);
      const b = parseStableVersion(right.version);
      return a.patch - b.patch;
    });
  for (const latest of candidates.reverse()) {
    const release = await getReleaseByTag(token, `v${latest.version}`);
    if (release !== null && release.draft === false) {
      return resolveRefObject(token, latest.ref.object);
    }
  }
  return null;
};

const loadMaintenanceStates = async (token: string): Promise<MaintenanceState[]> => {
  await getRepository(token);
  const [releaseRefs, tagRefs] = await Promise.all([
    listMatchingRefs(token, 'heads/releases/'),
    listMatchingRefs(token, 'tags/v'),
  ]);
  const lines = releaseRefs
    .map((ref) => ref.ref.replace('refs/heads/releases/', ''))
    .sort(compareReleaseLines);

  const states: MaintenanceState[] = [];
  for (const line of lines) {
    const releaseRef = releaseRefs.find((ref) => ref.ref === `refs/heads/releases/${line}`);
    if (releaseRef === undefined) {
      throw new Error(`GitHub omitted the discovered releases/${line} ref.`);
    }
    const releaseOid = refOid(releaseRef);
    await git([
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/releases/${line}:refs/remotes/origin/releases/${line}`,
    ]);
    const lineVersion = await rootVersionAt(releaseOid);
    const stagedRef = await getRef(token, `heads/staged/${line}`);
    const pulls = await listReleasePulls(token, line);
    const openPulls = pulls.filter(({ state }) => state === 'open');
    if (openPulls.length > 1) {
      throw new Error(`${line} has more than one open canonical release PR.`);
    }
    const closedPulls = await Promise.all(
      pulls
        .filter(({ state }) => state === 'closed')
        .map(({ number }) => getPullRequest(token, number)),
    );
    const closedProposals = await Promise.all(
      closedPulls.map(async (pull) => {
        const proposal = parseProposalMessage(
          (await getGitCommit(token, pull.head.sha)).message,
        );
        if (proposal.line !== line) {
          throw new Error(
            `Release PR #${pull.number} contains proposal metadata for ${proposal.line}.`,
          );
        }
        return { proposal, pull };
      }),
    );
    const latestClosed = closedProposals
      .sort((left, right) => right.pull.number - left.pull.number)[0] ?? null;
    const completedOid = await latestCompletedOid(token, line, tagRefs);

    let staged: MaintenanceState['staged'] = null;
    if (stagedRef !== null) {
      await git(['fetch', '--no-tags', 'origin', `+refs/heads/staged/${line}:refs/remotes/origin/staged/${line}`]);
      const metadata = parseProposalMessage(await commitMessageAt(stagedRef.oid));
      if (metadata.line !== line) {
        throw new Error(`staged/${line} contains proposal metadata for ${metadata.line}.`);
      }
      staged = { ...metadata, oid: stagedRef.oid };
    }

    let latestClosedPr: MaintenanceState['latestClosedPr'] = null;
    if (latestClosed !== null) {
      latestClosedPr = {
        headOid: latestClosed.pull.head.sha,
        merged: latestClosed.pull.merged_at !== null,
        number: latestClosed.pull.number,
        version: latestClosed.proposal.version,
      };
    }
    const mergedProposalOids: string[] = [];
    for (const { pull } of closedProposals.filter(
      ({ pull }) => pull.merged_at !== null,
    )) {
      validateFullOid(pull.merge_commit_sha, `${line} merged proposal`);
      mergedProposalOids.push(pull.merge_commit_sha);
    }
    const releaseHistory = (
      await git(['rev-list', '--first-parent', releaseOid])
    ).stdout.trim().split('\n').filter(Boolean);
    const accountingOid = deriveProposalAccountingBoundary({
      completedOid,
      mergedProposalOids,
      releaseHistory,
    });
    const openPull = openPulls[0] ?? null;
    const bodyIdentity = extractReleasePrIdentity(openPull?.body);
    const bodyCurrent =
      staged !== null &&
      bodyIdentity !== null &&
      bodyIdentity.proposalOid === staged.oid &&
      bodyIdentity.releaseOid === releaseOid &&
      bodyIdentity.version === staged.version;

    states.push({
      accountingOid,
      closedPrs: pulls
        .filter(({ state }) => state === 'closed')
        .map(({ body, number, state }) => ({ body: body ?? '', number, state })),
      latestClosedPr,
      line,
      lineVersion,
      openPr: openPull
        ? {
            bodyCurrent,
            number: openPull.number,
            replaceRequired: String(openPull.body ?? '').includes(
              '<!-- fablebook:release-pr=v6 -->'
            ),
          }
        : null,
      releaseOid,
      staged,
    });
  }
  return states;
};

export async function prepareMaintenance(
  options: PrepareMaintenanceOptions,
): Promise<void> {
  await ensureCleanReleaseRepository();
  const output = await prepareOutput(requireOption(options, 'output'));
  const token = requireControllerGitHubToken(options);
  const states = await loadMaintenanceStates(token);
  const planned = planProposalMaintenance(states);
  const actions: unknown[] = [];
  const bundleRefs: Array<{ name: string; oid: string }> = [];

  for (const plan of planned) {
    if (plan.kind === 'none') {
      continue;
    }
    const state = states.find(({ line }) => line === plan.line);
    if (state === undefined) {
      throw new Error(`Maintenance plan references unknown release line ${plan.line}.`);
    }
    let changes;
    if (plan.kind !== 'dormant') {
      await git([
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/releases/${plan.line}:refs/remotes/origin/releases/${plan.line}`,
      ]);
      changes =
        state.accountingOid === null
          ? await initialReleaseChanges(token, {
              line: plan.line,
              releaseOid: state.releaseOid,
            })
          : await releaseChanges(token, {
              boundaryOid: state.accountingOid,
              line: plan.line,
              releaseOid: state.releaseOid,
            });
    }
    const base = {
      changes,
      expectedStagedOid: state.staged?.oid ?? null,
      kind: plan.kind,
      line: plan.line,
      openPr: plan.openPr?.number,
      releaseOid: state.releaseOid,
      previousHighlightsBody:
        plan.kind === 'open' || plan.kind === 'recreate'
          ? selectLatestMatchingReleasePrBody({
              pulls: state.closedPrs,
              version: plan.version,
            })
          : undefined,
    };

    if (plan.kind === 'dormant' || plan.kind === 'open' || plan.kind === 'sync') {
      actions.push({
        ...base,
        proposalOid: state.staged?.oid,
        version: plan.version,
      });
      continue;
    }

    const attempt = randomUUID();
    const proposalOid = await materializeCommit({
      ...(changes === undefined
        ? {}
        : {
            files: [
              {
                content: renderReleaseRecord({ changes, version: plan.version }),
                path: releaseRecordPath(plan.version),
              },
            ],
          }),
      message: proposalCommitMessage({
        attempt,
        line: plan.line,
        sourceOid: state.releaseOid,
        version: plan.version,
      }),
      sourceOid: state.releaseOid,
      version: plan.version,
    });
    await validateProposalCommit(proposalOid, {
      ...(changes === undefined ? {} : { changes }),
      line: plan.line,
      sourceOid: state.releaseOid,
      version: plan.version,
    });
    const bundleRef = `${ARTIFACT_PREFIX}proposal-${plan.line}-${attempt}`;
    bundleRefs.push({ name: bundleRef, oid: proposalOid });
    actions.push({
      ...base,
      bundleRef,
      proposalOid,
      supersededPr: plan.supersededPr,
      version: plan.version,
    });
  }

  if (bundleRefs.length > 0) {
    await writeBundle(join(output, 'objects.bundle'), bundleRefs);
  }
  await writeJsonFile(join(output, 'transition.json'), {
    actions,
    kind: 'maintenance',
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  console.log(`Prepared ${actions.length} release proposal maintenance actions.`);
}

export async function applyMaintenance(
  options: ApplyMaintenanceOptions,
): Promise<void> {
  await ensureCleanReleaseRepository();
  const transitionPath = resolve(requireOption(options, 'transition'));
  const transition = maintenanceTransitionValue(await readJsonFile(transitionPath));
  const bundle = options.bundle ? resolve(options.bundle) : null;
  const token = requireControllerGitHubToken(options);
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== `refs/heads/${PRIMARY_BRANCH}`
  ) {
    throw new Error('Maintenance transition is outside the trusted pilot context.');
  }

  const repository = await getRepository(token);
  if (
    transition.actions.some(
      (action) => 'bundleRef' in action && action.bundleRef.length > 0,
    ) &&
    bundle === null
  ) {
    throw new Error('Maintenance transition requires its Git object bundle.');
  }
  if (bundle !== null) {
    await importBundle(
      bundle,
      transition.actions.flatMap((action) =>
        'bundleRef' in action
          ? [{ name: action.bundleRef, oid: action.proposalOid }]
          : [],
      ),
    );
  }

  for (const action of transition.actions) {
    parseReleaseLine(action.line);
    if (
      ![
        'create',
        'dormant',
        'open',
        'recreate',
        'refresh',
        'replace',
        'sync',
      ].includes(action.kind)
    ) {
      throw new Error(`Unknown maintenance action: ${action.kind}`);
    }
    validateFullOid(action.releaseOid, `${action.line} release source`);
    if (action.expectedStagedOid !== null) {
      validateFullOid(action.expectedStagedOid, `${action.line} staged expectation`);
    }
    await assertExpectedRef(token, `heads/releases/${action.line}`, action.releaseOid);
    await assertExpectedRef(token, `heads/staged/${action.line}`, action.expectedStagedOid);
    const openPulls = (await listReleasePulls(token, action.line)).filter(
      ({ state }) => state === 'open'
    );

    if (action.kind === 'dormant') {
      if (action.expectedStagedOid !== null) {
        await updateRefs(token, repository.node_id, [
          createRefUpdate({
            afterOid: action.releaseOid,
            beforeOid: action.releaseOid,
            name: `refs/heads/releases/${action.line}`,
          }),
          createRefUpdate({
            afterOid: ZERO_OID,
            beforeOid: action.expectedStagedOid,
            force: true,
            name: `refs/heads/staged/${action.line}`,
          }),
        ]);
      }
      await assertExpectedRef(token, `heads/releases/${action.line}`, action.releaseOid);
      await assertExpectedRef(token, `heads/staged/${action.line}`, null);
      for (const pull of openPulls) {
        await closePullRequest(token, pull.number);
      }
      continue;
    }

    if (action.kind === 'open' || action.kind === 'sync') {
      parseStableVersion(action.version);
      validateFullOid(action.proposalOid, `${action.line} proposal`);
      if (
        action.expectedStagedOid === null ||
        action.proposalOid !== action.expectedStagedOid ||
        (action.kind === 'open' && openPulls.length !== 0) ||
        (action.kind === 'sync' &&
          (openPulls.length !== 1 || openPulls[0]?.number !== action.openPr))
      ) {
        throw new Error(`${action.line} can no longer use its prepared staged proposal.`);
      }
      await git([
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/staged/${action.line}:refs/remotes/origin/staged/${action.line}`,
      ]);
      const metadata = parseProposalMessage(await commitMessageAt(action.expectedStagedOid));
      if (
        metadata.line !== action.line ||
        metadata.sourceOid !== action.releaseOid ||
        metadata.version !== action.version
      ) {
        throw new Error(`${action.line} staged proposal changed before PR creation.`);
      }
      await assertExpectedRef(token, `heads/releases/${action.line}`, action.releaseOid);
      await assertExpectedRef(token, `heads/staged/${action.line}`, action.expectedStagedOid);
      if (action.kind === 'open') {
        await createReleasePr(token, action, action.proposalOid);
      } else {
        const openPull = openPulls[0];
        if (openPull === undefined) {
          throw new Error(`${action.line} no longer has its expected open release PR.`);
        }
        const body = await renderProposalBody({
          action,
          previousBody: openPull.body ?? '',
          proposalOid: action.proposalOid,
        });
        await updatePullRequestBody(token, action.openPr, body);
      }
      continue;
    }

    if (action.kind === 'refresh' || action.kind === 'replace') {
      if (openPulls.length !== 1 || openPulls[0]?.number !== action.openPr) {
        throw new Error(`${action.line} no longer has the expected open release PR.`);
      }
    } else if (openPulls.length !== 0) {
      throw new Error(`${action.line} gained an open release PR after preparation.`);
    }

    validateFullOid(action.proposalOid, `${action.line} proposal`);
    parseStableVersion(action.version);
    await validateProposalCommit(action.proposalOid, {
      changes: action.changes,
      line: action.line,
      sourceOid: action.releaseOid,
      version: action.version,
    });
    const uploadedProposalOid = await uploadCommitObject(token, action.proposalOid);
    await updateRefs(token, repository.node_id, [
      createRefUpdate({
        afterOid: action.releaseOid,
        beforeOid: action.releaseOid,
        name: `refs/heads/releases/${action.line}`,
      }),
      createRefUpdate({
        afterOid: uploadedProposalOid,
        beforeOid: action.expectedStagedOid ?? ZERO_OID,
        force: action.expectedStagedOid !== null,
        name: `refs/heads/staged/${action.line}`,
      }),
    ]);

    if (action.kind === 'refresh') {
      const openPull = openPulls[0];
      if (openPull === undefined) {
        throw new Error(`${action.line} no longer has its expected open release PR.`);
      }
      const body = await renderProposalBody({
        action,
        contentOid: action.proposalOid,
        previousBody: openPull.body ?? '',
        proposalOid: uploadedProposalOid,
      });
      await updatePullRequestBody(token, action.openPr, body);
    }

    if (action.kind === 'replace') {
      await closePullRequest(token, action.openPr);
      await createReleasePr(token, action, uploadedProposalOid, action.proposalOid);
    }

    if (action.kind === 'create' || action.kind === 'recreate') {
      await createReleasePr(token, action, uploadedProposalOid, action.proposalOid);
    }
  }
  console.log(`Applied ${transition.actions.length} release proposal maintenance actions.`);
}

export async function checkPullRequest(
  pull: Pick<ValidatedPullRequest, 'base' | 'body' | 'head'>,
): Promise<void> {
  await ensureCleanReleaseRepository();
  if (
    pull.base.repo.full_name !== PILOT_REPOSITORY ||
    pull.head.repo.full_name !== PILOT_REPOSITORY ||
    pull.base.ref !== `releases/${pull.head.ref.replace('staged/', '')}` ||
    !pull.head.ref.startsWith('staged/')
  ) {
    throw new Error('This is not a canonical same-repository release proposal PR.');
  }
  const line = pull.head.ref.slice('staged/'.length);
  parseReleaseLine(line);
  validateFullOid(pull.base.sha, 'Release PR base');
  validateFullOid(pull.head.sha, 'Release PR head');
  const metadata = parseProposalMessage(await commitMessageAt(pull.head.sha));
  await validateProposalCommit(pull.head.sha, {
    line,
    sourceOid: pull.base.sha,
    version: metadata.version,
  });
  const bodyIdentity = extractReleasePrIdentity(pull.body);
  if (
    bodyIdentity === null ||
    bodyIdentity.proposalOid !== pull.head.sha ||
    bodyIdentity.releaseOid !== pull.base.sha ||
    bodyIdentity.version !== metadata.version
  ) {
    throw new Error('Release PR body is not bound to the current proposal.');
  }
  validateReleasePrBody({
    body: pull.body,
    version: metadata.version,
  });
  console.log(`Release proposal ${pull.head.sha} is current for ${pull.base.sha}.`);
}
