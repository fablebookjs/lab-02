import assert from 'node:assert/strict';

import {
  parsePrereleaseProposalMessage,
} from '../../shared/prerelease-proposal/core.ts';
import type { PrereleaseProposal } from '../../shared/prerelease-proposal/core.ts';
import {
  commitMessageAt,
  commitParents,
  validateVersionTree,
} from '../../shared/prepared-commit/inspection.ts';
import { run } from '../../shared/process/run.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { listPrereleasePulls } from '../release-repository/pull-requests.ts';
import type { GitPullRequest } from '../release-repository/pull-requests.ts';
import { getRef } from '../release-repository/refs.ts';

export type StagedPrereleaseProposal = PrereleaseProposal & { oid: string };

/** Joint observation of the canonical proposal ref and its optional open PR. */
export type StagedPrereleaseProposalObservation = {
  openPull: GitPullRequest | null;
  stagedOid: string | null;
};

/** Observes one canonical prerelease ref and at most one open matching PR. */
export async function observeStagedPrereleaseProposal(
  token: string,
): Promise<StagedPrereleaseProposalObservation> {
  const ref = await getRef(token, 'heads/prerelease');
  const openPulls = (await listPrereleasePulls(token)).filter(
    ({ state }) => state === 'open',
  );
  if (openPulls.length > 1) {
    throw new Error('More than one canonical Prerelease PR is open.');
  }
  return {
    openPull: openPulls[0] ?? null,
    stagedOid: ref?.oid ?? null,
  };
}

/** Fetches and parses the staged proposal commit when the canonical ref exists. */
export async function parseStagedPrereleaseProposal(
  stagedOid: string | null,
): Promise<StagedPrereleaseProposal | null> {
  if (stagedOid === null) return null;
  await run(
    'git',
    [
      'fetch',
      '--no-tags',
      'origin',
      '+refs/heads/prerelease:refs/remotes/origin/prerelease',
    ],
    { cwd: repositoryRoot },
  );
  return {
    ...parsePrereleaseProposalMessage(
      await commitMessageAt(repositoryRoot, stagedOid),
    ),
    oid: stagedOid,
  };
}

/** Proves a staged proposal is a single-parent, lockstep version transition. */
export async function validateStagedPrereleaseProposal(
  proposal: StagedPrereleaseProposal,
): Promise<void> {
  assert.deepEqual(await commitParents(repositoryRoot, proposal.oid), [
    proposal.sourceOid,
  ]);
  await validateVersionTree(repositoryRoot, proposal.oid, proposal.version);
}
