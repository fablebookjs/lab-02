import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePrereleaseProposalMessage,
} from '../../shared/prerelease-proposal/core.ts';
import type { PrereleaseProposal } from '../../shared/prerelease-proposal/core.ts';
import {
  parsePhaseEntryCommitMessageIfPresent,
} from '../../shared/prerelease-phase-entry/core.ts';
import {
  parseDevelopmentCommitMessageIfPresent,
  parseDevelopmentVersion,
  parsePrereleaseBootstrapCommitMessageIfPresent,
  parseReleaseLine,
} from '../../shared/release-proposal/core.ts';
import type { DevelopmentCommit } from '../../shared/release-proposal/core.ts';
import type {
  ReleaseHistoryCommit,
  ReleaseHistoryPull,
} from '../../shared/release-communication/records.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { materializeVersion } from '../../shared/version/materialize.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import {
  commitMessageAt,
  commitParents,
  manifestAt,
  rootVersionAt,
  validateVersionTree,
} from '../../shared/prepared-commit/inspection.ts';
import { listAssociatedPullRequests } from '../release-repository/pull-requests.ts';
import type { GitPullRequest } from '../release-repository/pull-requests.ts';

type ManagedPrereleaseBoundary = Readonly<{
  kind: 'bootstrap' | 'ordinary' | 'phase-entry';
  oid: string;
  version: string;
}>;

/** First-parent Git fact enriched with normalized associated-PR observations. */
export type ReleaseCommitFact = ReleaseHistoryCommit &
  Readonly<{
    parents: readonly string[];
  }>;

/** Development history fact additionally classified as mechanical or product work. */
export type DevelopmentCommitFact = ReleaseCommitFact &
  Readonly<{
    mechanical: boolean;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const releaseHistoryPull = (pull: GitPullRequest): ReleaseHistoryPull => ({
  baseBranch: pull.base.ref,
  canonicalRepository: pull.base.repo.full_name === PILOT_REPOSITORY,
  labels: pull.labels.map(({ name }) => name),
  mergeCommitOid: pull.merge_commit_sha,
  merged: pull.merged_at !== null,
  number: pull.number,
  title: pull.title,
});

const associatedPulls = async (
  token: string,
  oid: string,
): Promise<ReleaseHistoryPull[]> =>
  (await listAssociatedPullRequests(token, oid)).map(releaseHistoryPull);

const git = (root: string, args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? root });

const firstParentRange = async ({
  boundaryOid,
  headOid,
  label,
  root,
}: {
  boundaryOid: string;
  headOid: string;
  label: string;
  root: string;
}): Promise<string[]> => {
  const { stdout: ancestry } = await git(root, ['rev-list', '--first-parent', headOid]);
  if (!ancestry.trim().split('\n').includes(boundaryOid)) {
    throw new Error(`${boundaryOid} is not on the ${label} first-parent history.`);
  }
  const { stdout } = await git(root, [
    'rev-list',
    '--first-parent',
    '--reverse',
    `${boundaryOid}..${headOid}`,
  ]);
  return stdout.trim().split('\n').filter(Boolean);
};

const commitFacts = async (
  root: string,
  token: string,
  oids: readonly string[],
): Promise<ReleaseCommitFact[]> => {
  return Promise.all(
    oids.map(async (oid) => ({
      associatedPulls: await associatedPulls(token, oid),
      oid,
      parents: await commitParents(root, oid),
      subject: (await commitMessageAt(root, oid)).split('\n', 1)[0] ?? '',
    })),
  );
};

/**
 * Returns oldest-to-newest facts strictly after a proven first-parent boundary.
 * The boundary itself is excluded.
 */
export async function firstParentCommitFacts(
  root: string,
  token: string,
  range: { boundaryOid: string; headOid: string; label: string },
): Promise<ReleaseCommitFact[]> {
  return commitFacts(root, token, await firstParentRange({ ...range, root }));
}

/** Finds exactly one structurally valid durable release-cut record for a line. */
export const findReleaseCut = async (
  root: string,
  line: string,
): Promise<DevelopmentCommit & { oid: string }> => {
  const { stdout } = await git(root, ['rev-list', '--first-parent', 'HEAD']);
  const matches: Array<DevelopmentCommit & { oid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const cut = parseDevelopmentCommitMessageIfPresent(await commitMessageAt(root, oid));
    if (cut?.line === line) {
      const parents = await commitParents(root, oid);
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
  if (match === undefined) throw new Error(`Expected one ${line} release-cut record.`);
  return match;
};

/**
 * Finds the unique alpha.0 development bootstrap for a line on history through
 * the supplied source commit.
 */
export const findDevelopmentBootstrap = async ({
  line,
  root,
  sourceOid,
}: {
  line: string;
  root: string;
  sourceOid: string;
}): Promise<DevelopmentCommit & { oid: string }> => {
  const target = parseReleaseLine(line);
  const { stdout } = await git(root, ['rev-list', '--first-parent', sourceOid]);
  const matches: Array<DevelopmentCommit & { oid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const bootstrap = parseDevelopmentCommitMessageIfPresent(
      await commitMessageAt(root, oid),
    );
    if (bootstrap === null) continue;
    const version = parseDevelopmentVersion(bootstrap.version);
    if (
      version.major !== target.major ||
      version.minor !== target.minor ||
      version.prerelease !== 'alpha' ||
      version.prereleaseNumber !== 0
    ) {
      continue;
    }
    const parents = await commitParents(root, oid);
    if (parents.length !== 1 || parents[0] !== bootstrap.sourceOid) {
      throw new Error(`${oid} is not a child of its recorded development source.`);
    }
    matches.push({ ...bootstrap, oid });
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${line} development bootstrap through ${sourceOid}, found ${matches.length}.`,
    );
  }
  const match = matches[0];
  if (match === undefined) throw new Error(`Expected one ${line} development bootstrap.`);
  return match;
};

const mechanicalDevelopmentCommit = async (root: string, oid: string): Promise<boolean> => {
  const message = await commitMessageAt(root, oid);
  if (
    parseDevelopmentCommitMessageIfPresent(message) !== null ||
    parsePhaseEntryCommitMessageIfPresent(message) !== null
  ) {
    return true;
  }
  const parents = await commitParents(root, oid);
  const proposalOid = parents[1];
  if (parents.length === 2 && proposalOid !== undefined) {
    try {
      const proposal = parsePrereleaseProposalMessage(
        await commitMessageAt(root, proposalOid),
      );
      const tree = (await git(root, ['show', '-s', '--format=%T', oid])).stdout.trim();
      const proposalTree = (
        await git(root, ['show', '-s', '--format=%T', proposalOid])
      ).stdout.trim();
      if (parents[0] === proposal.sourceOid && tree === proposalTree) return true;
    } catch {
      // Ordinary product merge commits remain product history facts.
    }
  }
  const parent = parents[0];
  if (parent === undefined) return false;
  const changedPaths = (
    await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', parent, oid])
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
  const target = await rootVersionAt(root, oid);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-version-only-check-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    await git(root, ['worktree', 'add', '--detach', worktree, parent]);
    added = true;
    await materializeVersion(worktree, target);
    const generatedLockPath = join(worktree, 'package-lock.json');
    const generatedLock: unknown = JSON.parse(await readFile(generatedLockPath, 'utf8'));
    const targetLock = await manifestAt(root, oid, 'package-lock.json');
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
    await git(root, ['add', 'package.json', 'package-lock.json', 'packages'], { cwd: worktree });
    try {
      await git(root, ['diff', '--cached', '--quiet', oid, '--'], { cwd: worktree });
      return true;
    } catch {
      return false;
    }
  } finally {
    if (added) {
      await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

/**
 * Returns development first-parent facts and distinguishes reproducible
 * lifecycle-only commits from product work without trusting commit subjects.
 */
export async function developmentCommitFacts(
  root: string,
  token: string,
  range: { boundaryOid: string; sourceOid: string },
): Promise<DevelopmentCommitFact[]> {
  const oids = await firstParentRange({
    boundaryOid: range.boundaryOid,
    headOid: range.sourceOid,
    label: 'main development',
    root,
  });
  return Promise.all(
    oids.map(async (oid) => ({
      associatedPulls: await associatedPulls(token, oid),
      mechanical: await mechanicalDevelopmentCommit(root, oid),
      oid,
      parents: await commitParents(root, oid),
      subject: (await commitMessageAt(root, oid)).split('\n', 1)[0] ?? '',
    })),
  );
}

/**
 * Finds the newest structurally proven bootstrap, ordinary merge, or phase-entry
 * snapshot on main. A lookalike with contradictory ancestry or tree fails.
 */
export const findManagedPrereleaseBoundary = async (
  root: string,
  mainOid: string,
): Promise<ManagedPrereleaseBoundary | null> => {
  const history = (await git(root, ['rev-list', '--first-parent', mainOid])).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const oid of history) {
    const parents = await commitParents(root, oid);
    const message = await commitMessageAt(root, oid);
    const bootstrap = parsePrereleaseBootstrapCommitMessageIfPresent(message);
    if (bootstrap !== null) {
      if (parents.length !== 1 || parents[0] !== bootstrap.sourceOid) {
        throw new Error(
          `${oid} resembles a prerelease bootstrap but does not directly advance its cut source.`,
        );
      }
      await validateVersionTree(root, oid, bootstrap.version);
      return { kind: 'bootstrap', oid, version: bootstrap.version };
    }
    const phaseEntry = parsePhaseEntryCommitMessageIfPresent(message);
    if (phaseEntry !== null) {
      if (parents.length !== 1 || parents[0] !== phaseEntry.sourceOid) {
        throw new Error(
          `${oid} resembles a phase-entry snapshot but does not directly advance its source.`,
        );
      }
      await validateVersionTree(root, oid, phaseEntry.version);
      return { kind: 'phase-entry', oid, version: phaseEntry.version };
    }

    const proposalOid = parents[1];
    if (parents.length !== 2 || proposalOid === undefined) continue;
    let proposal: PrereleaseProposal;
    try {
      proposal = parsePrereleaseProposalMessage(
        await commitMessageAt(root, proposalOid),
      );
    } catch {
      continue;
    }
    const tree = (await git(root, ['show', '-s', '--format=%T', oid])).stdout.trim();
    const proposalTree = (
      await git(root, ['show', '-s', '--format=%T', proposalOid])
    ).stdout.trim();
    if (parents[0] !== proposal.sourceOid || tree !== proposalTree) {
      throw new Error(
        `${oid} resembles a prerelease snapshot but does not exactly merge its proposal.`,
      );
    }
    await validateVersionTree(root, oid, proposal.version);
    return { kind: 'ordinary', oid, version: proposal.version };
  }
  return null;
};
