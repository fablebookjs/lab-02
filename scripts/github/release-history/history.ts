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
import { materializeVersion } from '../../shared/version/materialize.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import {
  commitMessageAt,
  commitParents,
  manifestAt,
  rootVersionAt,
  validateVersionTree,
} from '../../shared/prepared-commit/inspection.ts';
import {
  githubRequest,
  validatedPullRequestResponse,
  withPullRequestMergeCommit,
} from '../release-repository/github.ts';
import type { GitPullRequest } from '../release-repository/github.ts';

export type ManagedPrereleaseBoundary = Readonly<{
  kind: 'bootstrap' | 'ordinary' | 'phase-entry';
  oid: string;
  version: string;
}>;

export type ReleaseCommitFact = Readonly<{
  associatedPulls: readonly GitPullRequest[];
  oid: string;
  subject: string;
}>;

export type DevelopmentCommitFact = ReleaseCommitFact &
  Readonly<{
    mechanical: boolean;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

const associatedPulls = async (
  token: string,
  oid: string,
): Promise<GitPullRequest[]> => {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/commits/${oid}/pulls?${query}`,
      { token },
    );
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub associated pull requests for ${oid} must be an array.`);
    }
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) break;
  }
  return Promise.all(pulls.map((pull) => withPullRequestMergeCommit(token, pull)));
};

const firstParentRange = async ({
  boundaryOid,
  headOid,
  label,
}: {
  boundaryOid: string;
  headOid: string;
  label: string;
}): Promise<string[]> => {
  const { stdout: ancestry } = await git(['rev-list', '--first-parent', headOid]);
  if (!ancestry.trim().split('\n').includes(boundaryOid)) {
    throw new Error(`${boundaryOid} is not on the ${label} first-parent history.`);
  }
  const { stdout } = await git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${boundaryOid}..${headOid}`,
  ]);
  return stdout.trim().split('\n').filter(Boolean);
};

const commitFacts = async (
  token: string,
  oids: readonly string[],
): Promise<ReleaseCommitFact[]> => {
  return Promise.all(
    oids.map(async (oid) => ({
      associatedPulls: await associatedPulls(token, oid),
      oid,
      subject: (await commitMessageAt(oid)).split('\n', 1)[0] ?? '',
    })),
  );
};

export async function firstParentCommitFacts(
  token: string,
  range: { boundaryOid: string; headOid: string; label: string },
): Promise<ReleaseCommitFact[]> {
  return commitFacts(token, await firstParentRange(range));
}

export const findReleaseCut = async (
  line: string,
): Promise<DevelopmentCommit & { oid: string }> => {
  const { stdout } = await git(['rev-list', '--first-parent', 'HEAD']);
  const matches: Array<DevelopmentCommit & { oid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const cut = parseDevelopmentCommitMessageIfPresent(await commitMessageAt(oid));
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
  if (match === undefined) throw new Error(`Expected one ${line} release-cut record.`);
  return match;
};

export const findDevelopmentBootstrap = async ({
  line,
  sourceOid,
}: {
  line: string;
  sourceOid: string;
}): Promise<DevelopmentCommit & { oid: string }> => {
  const target = parseReleaseLine(line);
  const { stdout } = await git(['rev-list', '--first-parent', sourceOid]);
  const matches: Array<DevelopmentCommit & { oid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const bootstrap = parseDevelopmentCommitMessageIfPresent(
      await commitMessageAt(oid),
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
    const parents = await commitParents(oid);
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

const mechanicalDevelopmentCommit = async (oid: string): Promise<boolean> => {
  const message = await commitMessageAt(oid);
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
        await commitMessageAt(proposalOid),
      );
      const tree = (await git(['show', '-s', '--format=%T', oid])).stdout.trim();
      const proposalTree = (
        await git(['show', '-s', '--format=%T', proposalOid])
      ).stdout.trim();
      if (parents[0] === proposal.sourceOid && tree === proposalTree) return true;
    } catch {
      // Ordinary product merge commits remain product history facts.
    }
  }
  const parent = parents[0];
  if (parent === undefined) return false;
  const changedPaths = (
    await git(['diff-tree', '--no-commit-id', '--name-only', '-r', parent, oid])
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
  const target = await rootVersionAt(oid);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-version-only-check-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, parent]);
    added = true;
    await materializeVersion(worktree, target);
    const generatedLockPath = join(worktree, 'package-lock.json');
    const generatedLock: unknown = JSON.parse(await readFile(generatedLockPath, 'utf8'));
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
    await git(['add', 'package.json', 'package-lock.json', 'packages'], { cwd: worktree });
    try {
      await git(['diff', '--cached', '--quiet', oid, '--'], { cwd: worktree });
      return true;
    } catch {
      return false;
    }
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

export async function developmentCommitFacts(
  token: string,
  range: { boundaryOid: string; sourceOid: string },
): Promise<DevelopmentCommitFact[]> {
  const oids = await firstParentRange({
    boundaryOid: range.boundaryOid,
    headOid: range.sourceOid,
    label: 'main development',
  });
  return Promise.all(
    oids.map(async (oid) => ({
      associatedPulls: await associatedPulls(token, oid),
      mechanical: await mechanicalDevelopmentCommit(oid),
      oid,
      subject: (await commitMessageAt(oid)).split('\n', 1)[0] ?? '',
    })),
  );
}

export const findManagedPrereleaseBoundary = async (
  mainOid: string,
): Promise<ManagedPrereleaseBoundary | null> => {
  const history = (await git(['rev-list', '--first-parent', mainOid])).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const oid of history) {
    const parents = await commitParents(oid);
    const message = await commitMessageAt(oid);
    const bootstrap = parsePrereleaseBootstrapCommitMessageIfPresent(message);
    if (bootstrap !== null) {
      if (parents.length !== 1 || parents[0] !== bootstrap.sourceOid) {
        throw new Error(
          `${oid} resembles a prerelease bootstrap but does not directly advance its cut source.`,
        );
      }
      await validateVersionTree(oid, bootstrap.version);
      return { kind: 'bootstrap', oid, version: bootstrap.version };
    }
    const phaseEntry = parsePhaseEntryCommitMessageIfPresent(message);
    if (phaseEntry !== null) {
      if (parents.length !== 1 || parents[0] !== phaseEntry.sourceOid) {
        throw new Error(
          `${oid} resembles a phase-entry snapshot but does not directly advance its source.`,
        );
      }
      await validateVersionTree(oid, phaseEntry.version);
      return { kind: 'phase-entry', oid, version: phaseEntry.version };
    }

    const proposalOid = parents[1];
    if (parents.length !== 2 || proposalOid === undefined) continue;
    let proposal: PrereleaseProposal;
    try {
      proposal = parsePrereleaseProposalMessage(
        await commitMessageAt(proposalOid),
      );
    } catch {
      continue;
    }
    const tree = (await git(['show', '-s', '--format=%T', oid])).stdout.trim();
    const proposalTree = (
      await git(['show', '-s', '--format=%T', proposalOid])
    ).stdout.trim();
    if (parents[0] !== proposal.sourceOid || tree !== proposalTree) {
      throw new Error(
        `${oid} resembles a prerelease snapshot but does not exactly merge its proposal.`,
      );
    }
    await validateVersionTree(oid, proposal.version);
    return { kind: 'ordinary', oid, version: proposal.version };
  }
  return null;
};
