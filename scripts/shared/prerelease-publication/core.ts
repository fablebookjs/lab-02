import {
  extractPrereleasePrIdentity,
  validatePrereleasePrBody,
} from '../prerelease-proposal/body.ts';
import type { PrereleasePrChange } from '../prerelease-proposal/body.ts';
import {
  parsePrereleaseProposalMessage,
} from '../prerelease-proposal/core.ts';
import { cleanReleaseTitle } from '../release-communication/records.ts';
import { parseDevelopmentVersion } from '../release-proposal/core.ts';
import type { ManualPrereleasePhase } from '../prerelease-phase-entry/core.ts';

export const PILOT_REPOSITORY = 'fablebookjs/lab-02';
export const PRERELEASE_CHANNEL = 'next';

export type PrereleaseAuthorityBase = {
  boundaryOid: string;
  channel: typeof PRERELEASE_CHANNEL;
  snapshotOid: string;
  sourceOid: string;
  version: string;
};

export type OrdinaryPrereleaseAuthority = PrereleaseAuthorityBase & {
  proposalOid: string;
  pullRequest: number;
};

export type PhaseEntryPrereleaseAuthority = PrereleaseAuthorityBase & {
  phase: ManualPrereleasePhase;
};

export type BootstrapPrereleaseAuthority = PrereleaseAuthorityBase & {
  cutLine: string;
};

export type PrereleaseAuthority =
  | BootstrapPrereleaseAuthority
  | OrdinaryPrereleaseAuthority
  | PhaseEntryPrereleaseAuthority;

type GitCommit = {
  message?: string;
  parents?: Array<{ sha: string }>;
  sha: string;
  tree?: { sha: string };
};

type PrereleasePull = {
  base: { ref: string; repo: { full_name: string }; sha: string };
  body: unknown;
  head: { ref: string; repo: { full_name: string }; sha: string };
  merge_commit_sha: string | null;
  merged_at: unknown;
  number: number;
  state: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

export function derivePrereleaseAuthority({
  headCommit,
  mergeCommit,
  pull,
}: {
  headCommit: GitCommit;
  mergeCommit: GitCommit;
  pull: PrereleasePull;
}): OrdinaryPrereleaseAuthority {
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) {
    throw new Error('Prerelease authority requires a positive pull request number.');
  }
  if (
    pull.state !== 'closed' ||
    pull.merged_at === null ||
    pull.base.repo.full_name !== PILOT_REPOSITORY ||
    pull.head.repo.full_name !== PILOT_REPOSITORY ||
    pull.base.ref !== 'main' ||
    pull.head.ref !== 'prerelease'
  ) {
    throw new Error(
      'Prerelease authority must be a merged canonical same-repository pull request.',
    );
  }

  const sourceOid = fullOid(pull.base.sha, 'Prerelease source');
  const proposalOid = fullOid(pull.head.sha, 'Prerelease proposal');
  const snapshotOid = fullOid(
    pull.merge_commit_sha,
    'Prerelease snapshot',
  );
  if (headCommit.sha !== proposalOid || mergeCommit.sha !== snapshotOid) {
    throw new Error(
      'GitHub commit observations do not match the Prerelease PR.',
    );
  }
  if (typeof headCommit.message !== 'string') {
    throw new Error('Prerelease proposal commit has no commit message.');
  }
  const proposal = parsePrereleaseProposalMessage(headCommit.message);
  if (proposal.sourceOid !== sourceOid) {
    throw new Error(
      'The merged prerelease proposal is not bound to the pull request source.',
    );
  }
  const parents = mergeCommit.parents?.map(({ sha }) => sha) ?? [];
  if (
    parents.length !== 2 ||
    parents[0] !== sourceOid ||
    parents[1] !== proposalOid ||
    mergeCommit.tree?.sha !== headCommit.tree?.sha
  ) {
    throw new Error(
      'The prerelease snapshot is not the exact merge of the reviewed proposal.',
    );
  }
  parseDevelopmentVersion(proposal.version);
  return {
    boundaryOid: proposal.boundaryOid,
    channel: PRERELEASE_CHANNEL,
    proposalOid,
    pullRequest: pull.number,
    snapshotOid,
    sourceOid,
    version: proposal.version,
  };
}

export function derivePrereleaseCommunication({
  authority,
  body,
}: {
  authority: OrdinaryPrereleaseAuthority;
  body: unknown;
}): PrereleasePrChange[] {
  const identity = extractPrereleasePrIdentity(body);
  if (
    identity === null ||
    identity.boundaryOid !== authority.boundaryOid ||
    identity.proposalOid !== authority.proposalOid ||
    identity.sourceOid !== authority.sourceOid ||
    identity.version !== authority.version
  ) {
    throw new Error(
      'Prerelease communication is not bound to the authorized proposal.',
    );
  }
  return validatePrereleaseCommunication(
    validatePrereleasePrBody(body, identity),
  );
}

export function validatePrereleaseCommunication(
  input: unknown,
): PrereleasePrChange[] {
  if (!Array.isArray(input)) {
    throw new Error('Prerelease communication must be an array.');
  }
  const identities = new Set<string>();
  return input.map((change) => {
    if (!isRecord(change)) {
      throw new Error('Prerelease communication change must be an object.');
    }
    const key = change['key'];
    if (
      typeof key !== 'string' ||
      !/^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/.test(key) ||
      identities.has(key) ||
      typeof change['releaseNoteSkip'] !== 'boolean' ||
      typeof change['title'] !== 'string' ||
      cleanReleaseTitle(change['title'], '') !== change['title']
    ) {
      throw new Error(
        `Invalid prerelease communication change: ${String(key)}`,
      );
    }
    const url = key.startsWith('pr:')
      ? `https://github.com/${PILOT_REPOSITORY}/pull/${key.slice(3)}`
      : `https://github.com/${PILOT_REPOSITORY}/commit/${key.slice(7)}`;
    if (change['url'] !== url) {
      throw new Error(`Contradictory prerelease communication change: ${key}`);
    }
    identities.add(key);
    return {
      key,
      releaseNoteSkip: change['releaseNoteSkip'],
      title: change['title'],
      url,
    };
  });
}

export function composePrereleaseGitHubReleaseBody({
  changes,
  version,
}: {
  changes: readonly PrereleasePrChange[];
  version: string;
}): string {
  parseDevelopmentVersion(version);
  const publicChanges = validatePrereleaseCommunication(changes).filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip,
  );
  const rendered =
    publicChanges.length === 0
      ? 'This prerelease contains no user-facing changes worth mentioning.'
      : publicChanges
          .map(({ title, url }) => `- [${title}](${url})`)
          .join('\n');
  return [
    `# Lab-02 ${version}`,
    '',
    `## What's changed`,
    '',
    rendered,
    '',
  ].join('\n');
}

export function registryNextVersion({
  document,
  name,
}: {
  document: unknown;
  name: string;
}): string | null {
  if (document === null) {
    return null;
  }
  if (!isRecord(document) || document['name'] !== name) {
    throw new Error(`npm returned contradictory metadata for ${name}.`);
  }
  const distTags = document['dist-tags'];
  if (!isRecord(distTags)) {
    throw new Error(`npm returned contradictory metadata for ${name}.`);
  }
  const next = distTags['next'];
  if (next === undefined) {
    return null;
  }
  if (typeof next !== 'string') {
    throw new Error(`npm returned a contradictory next tag for ${name}.`);
  }
  return next;
}
