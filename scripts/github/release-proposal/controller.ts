import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  compareReleaseLines,
  deriveCutVersions,
  developmentCommitMessage,
  parseDevelopmentCommitMessageIfPresent,
  parseDevelopmentVersion,
  parsePrereleaseBootstrapCommitMessageIfPresent,
  parseProposalMessage,
  parseReleaseLine,
  parseStableVersion,
  planProposalMaintenance,
  proposalCommitMessage,
  ZERO_OID,
} from '../../shared/release-proposal/core.ts';
import type { DevelopmentCommit } from '../../shared/release-proposal/core.ts';
import {
  parsePrereleaseProposalMessage,
} from '../../shared/prerelease-proposal/core.ts';
import {
  parsePhaseEntryCommitMessageIfPresent,
} from '../../shared/prerelease-phase-entry/core.ts';
import {
  closePullRequest,
  createDraftReleasePr,
  createRefUpdate,
  getGitCommit,
  getRef,
  getPullRequest,
  getReleaseByTag,
  getRepository,
  githubRequest,
  listMatchingRefs,
  listPrereleasePulls,
  listReleasePulls,
  PILOT_REPOSITORY,
  resolveRefObject,
  updatePullRequestBody,
  updateRefs,
  validatedGitCommitResponse,
  validatedPullRequestResponse,
  withPullRequestMergeCommit,
} from './github.ts';
import type { GitCommit, GitPullRequest, GitReference } from './github.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
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
import {
  extractReleasePrIdentity,
  renderReleasePrBody,
  selectLatestMatchingReleasePrBody,
  validateReleasePrBody,
} from '../../shared/release-proposal/body.ts';
import { materializeVersion } from '../../shared/version/materialize.ts';
import type { ValidatedPullRequest } from '../events.ts';
import {
  readJson,
  requireGithubToken,
  requireOption,
  run,
  writeJson,
} from '../controller-support.ts';
import type { RunOptions } from '../controller-support.ts';
const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';
const IMPORT_PREFIX = 'refs/release-pilot/imported/';

type RootManifest = {
  version?: string;
  workspaces?: string[];
};

type PublicPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
};

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

type BundleRef = {
  name: string;
  oid: string;
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
  closedPrs: Array<{ body: string; number: number; state: string }>;
  completedOid: string | null;
  latestClosedPr: {
    headOid: string;
    mergeCommitOid: string | null;
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

const stringRecord = (value: unknown, label: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must map names to versions.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, version]) => [name, stringValue(version, `${label}.${name}`)]),
  );
};

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

const ensureSeedRepository = async (): Promise<void> => {
  const { stdout } = await git(['rev-parse', '--show-toplevel']);
  if (resolve(stdout.trim()) !== resolve(repositoryRoot)) {
    throw new Error(
      'Release proposal commands must run after the Lab-02 seed becomes the root of its own Git repository.'
    );
  }
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim()) {
    throw new Error('Release proposal preparation requires a clean working tree.');
  }
};

const commitParents = async (oid: string): Promise<string[]> => {
  const { stdout } = await git(['show', '-s', '--format=%P', oid]);
  return stdout.trim().split(/\s+/).filter(Boolean);
};

const commitMessage = async (oid: string): Promise<string> => {
  const { stdout } = await git(['show', '-s', '--format=%B', oid]);
  return stdout.trimEnd();
};

const manifestAt = async (oid: string, path: string): Promise<unknown> => {
  const { stdout } = await git(['show', `${oid}:${path}`]);
  const value: unknown = JSON.parse(stdout);
  return value;
};

const rootManifestValue = (value: unknown): RootManifest => {
  if (!isRecord(value)) throw new Error('Root package.json must contain one object.');
  const workspaces = value['workspaces'];
  if (
    workspaces !== undefined &&
    (!Array.isArray(workspaces) || workspaces.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error('Root package.json workspaces must be strings.');
  }
  return {
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
    ...(Array.isArray(workspaces)
      ? { workspaces: workspaces.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
};

const packageManifestValue = (value: unknown, path: string): PublicPackageManifest => {
  if (!isRecord(value)) throw new Error(`${path} must contain one object.`);
  const dependencies = stringRecord(value['dependencies'], `${path}.dependencies`);
  const devDependencies = stringRecord(
    value['devDependencies'],
    `${path}.devDependencies`,
  );
  const optionalDependencies = stringRecord(
    value['optionalDependencies'],
    `${path}.optionalDependencies`,
  );
  const peerDependencies = stringRecord(
    value['peerDependencies'],
    `${path}.peerDependencies`,
  );
  return {
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(typeof value['private'] === 'boolean' ? { private: value['private'] } : {}),
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
  };
};

const publicPackagesAt = async (
  oid: string,
): Promise<{
  packages: Array<{ manifest: PublicPackageManifest; name: string }>;
  root: RootManifest;
}> => {
  const root = rootManifestValue(await manifestAt(oid, 'package.json'));
  if (JSON.stringify(root.workspaces) !== JSON.stringify(['packages/*'])) {
    throw new Error('The release controller supports only the accepted packages/* seed workspace.');
  }
  const { stdout } = await git(['ls-tree', '-d', '--name-only', `${oid}:packages`]);
  const packages: Array<{ manifest: PublicPackageManifest; name: string }> = [];
  for (const directory of stdout.trim().split('\n').filter(Boolean)) {
    const manifestPath = `packages/${directory}/package.json`;
    const manifest = packageManifestValue(
      await manifestAt(oid, manifestPath),
      manifestPath,
    );
    if (manifest.private !== true) {
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`packages/${directory}/package.json has no package name.`);
      }
      packages.push({ manifest, name: manifest.name });
    }
  }
  return { packages, root };
};

const releasePrTemplate = (version: string): Promise<string> => {
  const { patch } = parseStableVersion(version);
  const filename =
    patch === 0 ? 'release-pr-initial.md' : 'release-pr-patch.md';
  return readFile(
    join(repositoryRoot, '.github/release-templates', filename),
    'utf8'
  );
};

const associatedPulls = async (token: string, oid: string): Promise<GitPullRequest[]> => {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/commits/${oid}/pulls?${query}`,
      { token }
    );
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub associated pull requests for ${oid} must be an array.`);
    }
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) {
      break;
    }
  }
  return Promise.all(pulls.map((pull) => withPullRequestMergeCommit(token, pull)));
};

const findReleaseCut = async (
  line: string,
): Promise<DevelopmentCommit & { oid: string }> => {
  const { stdout } = await git(['rev-list', '--first-parent', 'HEAD']);
  const matches: Array<DevelopmentCommit & { oid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const cut = parseDevelopmentCommitMessageIfPresent(await commitMessage(oid));
    if (cut?.line === line) {
      const parents = await commitParents(oid);
      if (parents.length !== 1 || parents[0] !== cut.sourceOid) {
        throw new Error(`Release-cut commit ${oid} is not a child of its recorded source.`);
      }
      matches.push({ ...cut, oid });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one ${line} release-cut record on main, found ${matches.length}.`);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`Expected one ${line} release-cut record.`);
  }
  return match;
};

const findDevelopmentBootstrap = async ({
  line,
  sourceOid,
}: {
  line: string;
  sourceOid: string;
}): Promise<DevelopmentCommit & { oid: string }> => {
  const target = parseReleaseLine(line);
  const { stdout } = await git([
    'rev-list',
    '--first-parent',
    sourceOid,
  ]);
  const matches: Array<DevelopmentCommit & { oid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const bootstrap = parseDevelopmentCommitMessageIfPresent(
      await commitMessage(oid),
    );
    if (bootstrap === null) {
      continue;
    }
    const version = parseDevelopmentVersion(bootstrap.version);
    if (
      version.major !== target.major ||
      version.minor !== target.minor ||
      version.prerelease !== 'alpha' ||
      version.prereleaseNumber !== 0
    ) {
      continue;
    }
    const parents = await commitParents(oid);
    if (parents.length !== 1 || parents[0] !== bootstrap.sourceOid) {
      throw new Error(
        `Development bootstrap ${oid} is not a child of its recorded source.`,
      );
    }
    matches.push({ ...bootstrap, oid });
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${line} development bootstrap through ${sourceOid}, found ${matches.length}.`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`Expected one ${line} development bootstrap.`);
  }
  return match;
};

const mechanicalDevelopmentCommit = async (oid: string): Promise<boolean> => {
  const message = await commitMessage(oid);
  if (
    parseDevelopmentCommitMessageIfPresent(message) !== null ||
    parsePhaseEntryCommitMessageIfPresent(message) !== null
  ) {
    return true;
  }
  const parents = await commitParents(oid);
  const proposalOid = parents[1];
  if (parents.length === 2 && proposalOid !== undefined) {
    try {
      const proposal = parsePrereleaseProposalMessage(
        await commitMessage(proposalOid),
      );
      const tree = (await git(['show', '-s', '--format=%T', oid])).stdout.trim();
      const proposalTree = (
        await git(['show', '-s', '--format=%T', proposalOid])
      ).stdout.trim();
      if (parents[0] === proposal.sourceOid && tree === proposalTree) {
        return true;
      }
    } catch {
      // Ordinary product merge commits remain part of release communication.
    }
  }
  const parent = parents[0];
  if (parent === undefined) {
    return false;
  }
  const changedPaths = (
    await git([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      parent,
      oid,
    ])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  if (
    changedPaths.length === 0 ||
    changedPaths.some(
      (path) =>
        path !== 'package.json' &&
        path !== 'package-lock.json' &&
        !/^packages\/[^/]+\/package\.json$/.test(path),
    )
  ) {
    return false;
  }
  const target = await proposalRootVersionAt(oid);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'fablebook-version-only-check-'),
  );
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, parent]);
    added = true;
    await materializeVersion(worktree, target);
    const generatedLockPath = join(worktree, 'package-lock.json');
    const generatedLock: unknown = JSON.parse(
      await readFile(generatedLockPath, 'utf8'),
    );
    const targetLock = await manifestAt(oid, 'package-lock.json');
    if (
      isRecord(generatedLock) &&
      isRecord(targetLock) &&
      typeof targetLock['version'] === 'string'
    ) {
      generatedLock['version'] = targetLock['version'];
      await writeFile(
        generatedLockPath,
        `${JSON.stringify(generatedLock, null, 2)}\n`,
        'utf8',
      );
    }
    await git(
      ['add', 'package.json', 'package-lock.json', 'packages'],
      { cwd: worktree },
    );
    try {
      await git(['diff', '--cached', '--quiet', oid, '--'], {
        cwd: worktree,
      });
      return true;
    } catch {
      return false;
    }
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree]).catch(
        () => undefined,
      );
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
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
  const { stdout: ancestry } = await git([
    'rev-list',
    '--first-parent',
    sourceOid,
  ]);
  if (!ancestry.trim().split('\n').includes(boundaryOid)) {
    throw new Error(
      `${boundaryOid} is not on the main first-parent development history.`,
    );
  }
  const { stdout } = await git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${boundaryOid}..${sourceOid}`,
  ]);
  const productOids: string[] = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    if (!(await mechanicalDevelopmentCommit(oid))) {
      productOids.push(oid);
    }
  }
  const commits = await Promise.all(
    productOids.map(async (oid) => ({
      associatedPulls: await associatedPulls(token, oid),
      oid,
      subject: (await commitMessage(oid)).split('\n', 1)[0] ?? '',
    })),
  );
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
  const { stdout: ancestry } = await git(['rev-list', '--first-parent', releaseOid]);
  if (!ancestry.trim().split('\n').includes(boundaryOid)) {
    throw new Error(`${boundaryOid} is not on the ${line} first-parent release history.`);
  }
  const { stdout } = await git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${boundaryOid}..${releaseOid}`,
  ]);
  const commits = await Promise.all(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(async (oid) => ({
        associatedPulls: await associatedPulls(token, oid),
        oid,
        subject: (await commitMessage(oid)).split('\n', 1)[0] ?? '',
      }))
  );
  return deriveReleaseChanges({ commits, line });
};

const initialReleaseChanges = async (
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

const validateVersionTree = async (oid: string, version: string): Promise<void> => {
  const { packages, root } = await publicPackagesAt(oid);
  if (root.version !== version || packages.length === 0) {
    throw new Error(`${oid} does not materialize root version ${version}.`);
  }
  const publicNames = new Set(packages.map(({ name }) => name));
  for (const pkg of packages) {
    if (pkg.manifest.version !== version) {
      throw new Error(`${pkg.name} does not materialize ${version}.`);
    }
    const dependencyFields: Array<
      'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
    > = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ];
    for (const field of dependencyFields) {
      for (const [name, dependencyVersion] of Object.entries(pkg.manifest[field] ?? {})) {
        if (publicNames.has(name) && dependencyVersion !== version) {
          throw new Error(`${pkg.name} has a non-lockstep dependency on ${name}.`);
        }
      }
    }
  }
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
  const metadata = parseProposalMessage(await commitMessage(oid));
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
  const message = await commitMessage(oid);
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

function validateFullOid(oid: unknown, label: string): asserts oid is string {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
}

const uploadCommitObject = async (token: string, oid: string): Promise<string> => {
  const sourceOid = (await commitParents(oid))[0];
  validateFullOid(sourceOid, 'Uploaded commit parent');
  const changedPaths = (
    await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sourceOid, oid])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  if (changedPaths.length === 0) {
    throw new Error(`Prepared commit ${oid} has no tree changes.`);
  }

  const tree: Array<{
    content: string;
    mode: string;
    path: string;
    type: string;
  }> = [];
  for (const path of changedPaths) {
    const entry = (await git(['ls-tree', oid, '--', path])).stdout.trim();
    const match = /^(\d{6}) (blob) [0-9a-f]{40}\t(.+)$/.exec(entry);
    const mode = match?.[1];
    const type = match?.[2];
    if (mode === undefined || type === undefined || match?.[3] !== path) {
      throw new Error(`Prepared commit has an unsupported tree entry: ${entry}`);
    }
    tree.push({
      content: (await git(['show', `${oid}:${path}`])).stdout,
      mode,
      path,
      type,
    });
  }

  const sourceTree = (await git(['show', '-s', '--format=%T', sourceOid])).stdout.trim();
  const expectedTree = (await git(['show', '-s', '--format=%T', oid])).stdout.trim();
  const remoteTreeResponse = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/trees`, {
    body: { base_tree: sourceTree, tree },
    method: 'POST',
    token,
  });
  if (!isRecord(remoteTreeResponse)) {
    throw new Error('GitHub created-tree response must be an object.');
  }
  const remoteTreeSha = stringValue(remoteTreeResponse['sha'], 'GitHub created tree SHA');
  if (remoteTreeSha !== expectedTree) {
    throw new Error(`GitHub created tree ${remoteTreeSha}, expected ${expectedTree}.`);
  }

  const identity = (
    await git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', oid])
  ).stdout.trimEnd().split('\0');
  if (identity.length !== 6 || identity.some((value) => value.length === 0)) {
    throw new Error(`Prepared commit ${oid} has incomplete author or committer metadata.`);
  }
  const authorName = stringValue(identity[0], 'Prepared author name');
  const authorEmail = stringValue(identity[1], 'Prepared author email');
  const authorDate = stringValue(identity[2], 'Prepared author date');
  const committerName = stringValue(identity[3], 'Prepared committer name');
  const committerEmail = stringValue(identity[4], 'Prepared committer email');
  const committerDate = stringValue(identity[5], 'Prepared committer date');
  const message = await commitMessage(oid);
  const remoteCommit = validatedGitCommitResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits`, {
      body: {
        author: { date: authorDate, email: authorEmail, name: authorName },
        committer: {
          date: committerDate,
          email: committerEmail,
          name: committerName,
        },
        message,
        parents: [sourceOid],
        tree: remoteTreeSha,
      },
      method: 'POST',
      token,
    }),
  );
  validateFullOid(remoteCommit.sha, 'Uploaded GitHub commit');
  const sameIdentity = (
    remote: GitCommit['author'],
    name: string,
    email: string,
    date: string,
  ): boolean =>
    remote.name === name &&
    remote.email === email &&
    Number.isFinite(Date.parse(remote.date)) &&
    Date.parse(remote.date) === Date.parse(date);
  if (
    remoteCommit.message !== message ||
    remoteCommit.tree?.sha !== expectedTree ||
    remoteCommit.parents.length !== 1 ||
    remoteCommit.parents[0]?.sha !== sourceOid ||
    !sameIdentity(remoteCommit.author, authorName, authorEmail, authorDate) ||
    !sameIdentity(remoteCommit.committer, committerName, committerEmail, committerDate)
  ) {
    throw new Error(`GitHub did not preserve the prepared commit ${oid}.`);
  }
  return remoteCommit.sha;
};

const validateCutTransition = async (transition: CutTransition): Promise<void> => {
  parseReleaseLine(transition.line);
  parseStableVersion(transition.releaseVersion);
  validateFullOid(transition.sourceOid, 'Cut source');
  validateFullOid(transition.proposalOid, 'Proposal');
  validateFullOid(transition.developmentOid, 'Development commit');
  const sourceManifest = rootManifestValue(
    await manifestAt(transition.sourceOid, 'package.json'),
  );
  if (typeof sourceManifest.version !== 'string') {
    throw new Error('Cut source manifest has no version.');
  }
  const minor = deriveCutVersions(sourceManifest.version, 'minor');
  const major = deriveCutVersions(sourceManifest.version, 'major');
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

const materializeCommit = async ({
  changes,
  message,
  sourceOid,
  version,
}: {
  changes?: unknown[];
  message: string;
  sourceOid: string;
  version: string;
}) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-release-proposal-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, sourceOid]);
    added = true;
    await materializeVersion(worktree, version);
    await git(['add', 'package.json', 'package-lock.json', 'packages'], { cwd: worktree });
    let recordPath: string | null = null;
    if (changes !== undefined) {
      recordPath = releaseRecordPath(version);
      await mkdir(join(worktree, 'releases'), { recursive: true });
      await writeFile(
        join(worktree, recordPath),
        renderReleaseRecord({ changes, version }),
        'utf8'
      );
      await git(['add', recordPath], { cwd: worktree });
    }

    const changed = (await git(['diff', '--cached', '--name-only'], { cwd: worktree })).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (
      changed.length === 0 ||
      changed.some(
        (path) =>
          path !== recordPath &&
          path !== 'package.json' &&
          path !== 'package-lock.json' &&
          !path.endsWith('/package.json')
      ) ||
      (recordPath !== null && !changed.includes(recordPath))
    ) {
      throw new Error(`Release materialization changed unexpected files: ${changed.join(', ')}`);
    }

    const identity = {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'release-app@users.noreply.github.com',
      GIT_AUTHOR_NAME: 'fablebook-release-app[bot]',
      GIT_COMMITTER_EMAIL: 'release-app@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'fablebook-release-app[bot]',
    };
    await git(['commit', '--no-gpg-sign', '-m', message], { cwd: worktree, env: identity });
    return (await git(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const writeBundle = async (path: string, refs: BundleRef[]): Promise<void> => {
  for (const { name, oid } of refs) {
    await git(['update-ref', name, oid, ZERO_OID]);
  }
  try {
    await git(['bundle', 'create', path, ...refs.map(({ name }) => name)]);
  } finally {
    await Promise.all(refs.map(({ name, oid }) => git(['update-ref', '-d', name, oid])));
  }
};

const importBundle = async (path: string): Promise<void> => {
  await git([
    'fetch',
    '--no-tags',
    path,
    `+${ARTIFACT_PREFIX}*:${IMPORT_PREFIX}*`,
  ]);
};

const importedOid = async (bundleRef: string): Promise<string> => {
  if (!bundleRef.startsWith(ARTIFACT_PREFIX)) {
    throw new Error(`Unexpected bundle ref: ${bundleRef}`);
  }
  const imported = `${IMPORT_PREFIX}${bundleRef.slice(ARTIFACT_PREFIX.length)}`;
  return (await git(['rev-parse', imported])).stdout.trim();
};

const prepareOutput = async (output: string): Promise<string> => {
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  return directory;
};

export async function prepareCut(options: PrepareCutOptions): Promise<void> {
  await ensureSeedRepository();
  const nextDevelopment = requireOption(options, 'next-development');
  const output = await prepareOutput(requireOption(options, 'output'));
  const token = requireGithubToken(options);
  const sourceOid = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const sourceManifest = rootManifestValue(await manifestAt(sourceOid, 'package.json'));
  if (typeof sourceManifest.version !== 'string') {
    throw new Error('Cut source manifest has no version.');
  }
  const versions = deriveCutVersions(sourceManifest.version, nextDevelopment);
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
    changes,
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

  await writeJson(join(output, 'transition.json'), {
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
      name: 'refs/heads/main',
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
  await ensureSeedRepository();
  const transitionPath = resolve(requireOption(options, 'transition'));
  const bundlePath = resolve(requireOption(options, 'bundle'));
  const transition = cutTransitionValue(await readJson(transitionPath));
  const token = requireGithubToken(options);
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== 'refs/heads/main'
  ) {
    throw new Error('Cut transition is outside the trusted pilot context.');
  }

  const repository = await getRepository(token);
  await importBundle(bundlePath);
  await validateCutTransition(transition);
  assert.equal(await importedOid(transition.proposalBundleRef), transition.proposalOid);
  assert.equal(await importedOid(transition.developmentBundleRef), transition.developmentOid);
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

  const main = await getRef(token, 'heads/main');
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
  await writeJson(
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

const latestCompletedTag = async (
  token: string,
  line: string,
  tagRefs: GitReference[],
): Promise<{ oid: string | null; version: string | null }> => {
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
      return {
        oid: await resolveRefObject(token, latest.ref.object),
        version: latest.version,
      };
    }
  }
  return { oid: null, version: null };
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
    const releaseManifest = rootManifestValue(
      await manifestAt(releaseOid, 'package.json'),
    );
    if (typeof releaseManifest.version !== 'string') {
      throw new Error(`releases/${line} root package.json has no version.`);
    }
    const stagedRef = await getRef(token, `heads/staged/${line}`);
    const pulls = await listReleasePulls(token, line);
    const openPulls = pulls.filter(({ state }) => state === 'open');
    if (openPulls.length > 1) {
      throw new Error(`${line} has more than one open canonical release PR.`);
    }
    const latestClosedSummary = pulls
      .filter(({ state }) => state === 'closed')
      .sort((left, right) => right.number - left.number)[0];
    const latestClosed = latestClosedSummary
      ? await getPullRequest(token, latestClosedSummary.number)
      : null;
    const completed = await latestCompletedTag(token, line, tagRefs);

    let staged: MaintenanceState['staged'] = null;
    if (stagedRef !== null) {
      await git(['fetch', '--no-tags', 'origin', `+refs/heads/staged/${line}:refs/remotes/origin/staged/${line}`]);
      const metadata = parseProposalMessage(await commitMessage(stagedRef.oid));
      if (metadata.line !== line) {
        throw new Error(`staged/${line} contains proposal metadata for ${metadata.line}.`);
      }
      staged = { ...metadata, oid: stagedRef.oid };
    }

    let latestClosedPr: MaintenanceState['latestClosedPr'] = null;
    if (latestClosed !== null) {
      const closedProposal = parseProposalMessage(
        (await getGitCommit(token, latestClosed.head.sha)).message
      );
      const mergeCommitOid = latestClosed.merge_commit_sha;
      if (latestClosed.merged_at !== null) {
        validateFullOid(mergeCommitOid, `${line} merged proposal`);
      }
      latestClosedPr = {
        headOid: latestClosed.head.sha,
        mergeCommitOid: mergeCommitOid,
        merged: latestClosed.merged_at !== null,
        number: latestClosed.number,
        version: closedProposal.version,
      };
    }
    const openPull = openPulls[0] ?? null;
    const bodyIdentity = extractReleasePrIdentity(openPull?.body);
    const bodyCurrent =
      staged !== null &&
      bodyIdentity !== null &&
      bodyIdentity.proposalOid === staged.oid &&
      bodyIdentity.releaseOid === releaseOid &&
      bodyIdentity.version === staged.version;

    states.push({
      closedPrs: pulls
        .filter(({ state }) => state === 'closed')
        .map(({ body, number, state }) => ({ body: body ?? '', number, state })),
      completedOid: completed.oid,
      latestClosedPr,
      line,
      lineVersion: releaseManifest.version,
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
  await ensureSeedRepository();
  const output = await prepareOutput(requireOption(options, 'output'));
  const token = requireGithubToken(options);
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
        state.completedOid === null
          ? await initialReleaseChanges(token, {
              line: plan.line,
              releaseOid: state.releaseOid,
            })
          : await releaseChanges(token, {
              boundaryOid: state.completedOid,
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
      ...(changes === undefined ? {} : { changes }),
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
  await writeJson(join(output, 'transition.json'), {
    actions,
    kind: 'maintenance',
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  console.log(`Prepared ${actions.length} release proposal maintenance actions.`);
}

const assertExpectedRef = async (
  token: string,
  ref: string,
  expectedOid: string | null,
): Promise<void> => {
  const live = await getRef(token, ref);
  if ((live?.oid ?? null) !== expectedOid) {
    throw new Error(`${ref} changed after maintenance preparation.`);
  }
};

export async function applyMaintenance(
  options: ApplyMaintenanceOptions,
): Promise<void> {
  await ensureSeedRepository();
  const transitionPath = resolve(requireOption(options, 'transition'));
  const transition = maintenanceTransitionValue(await readJson(transitionPath));
  const bundle = options.bundle ? resolve(options.bundle) : null;
  const token = requireGithubToken(options);
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== 'refs/heads/main'
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
    await importBundle(bundle);
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
      const metadata = parseProposalMessage(await commitMessage(action.expectedStagedOid));
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

    assert.equal(await importedOid(action.bundleRef), action.proposalOid);
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

export const proposalCommitParents = commitParents;
export const proposalCommitMessageAt = commitMessage;
export const proposalImportBundle = importBundle;
export const proposalInitialReleaseChanges = initialReleaseChanges;
export const proposalImportedOid = importedOid;
export const proposalMaterializeCommit = materializeCommit;
export const proposalPrepareOutput = prepareOutput;
export const proposalUploadCommitObject = uploadCommitObject;
export const proposalValidateVersionTree = validateVersionTree;

export async function proposalRootVersionAt(oid: string): Promise<string> {
  const manifest = rootManifestValue(await manifestAt(oid, 'package.json'));
  if (typeof manifest.version !== 'string') {
    throw new Error(`${oid} root package.json has no version.`);
  }
  return manifest.version;
}

export async function proposalWriteBundle(
  path: string,
  refs: Array<{ name: string; oid: string }>,
): Promise<void> {
  await writeBundle(path, refs);
}

export async function proposalAssertExpectedRef(
  token: string,
  ref: string,
  expectedOid: string | null,
): Promise<void> {
  await assertExpectedRef(token, ref, expectedOid);
}

export async function prereleaseChanges(
  token: string,
  {
    boundaryOid,
    sourceOid,
  }: {
    boundaryOid: string;
    sourceOid: string;
  },
): Promise<ReleaseChange[]> {
  const { stdout: ancestry } = await git([
    'rev-list',
    '--first-parent',
    sourceOid,
  ]);
  if (!ancestry.trim().split('\n').includes(boundaryOid)) {
    throw new Error(
      `${boundaryOid} is not on the main first-parent prerelease history.`,
    );
  }
  const { stdout } = await git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${boundaryOid}..${sourceOid}`,
  ]);
  const commits = await Promise.all(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(async (oid) => ({
        associatedPulls: await associatedPulls(token, oid),
        oid,
        subject: (await commitMessage(oid)).split('\n', 1)[0] ?? '',
      })),
  );
  return derivePrereleaseChanges({ commits });
}

export async function checkPullRequest(
  pull: Pick<ValidatedPullRequest, 'base' | 'body' | 'head'>,
): Promise<void> {
  await ensureSeedRepository();
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
  const metadata = parseProposalMessage(await commitMessage(pull.head.sha));
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
