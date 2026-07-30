import { parseDevelopmentVersion } from '../release-proposal/core.ts';

const fullOidPattern = /^[0-9a-f]{40}$/;

export type PrereleaseProposal = {
  attempt: string;
  boundaryOid: string;
  sourceOid: string;
  version: string;
};

export type PrereleaseProposalState = {
  boundaryOid: string | null;
  lineVersion: string;
  mainOid: string;
  openPr: {
    bodyCurrent: boolean;
    number: number;
  } | null;
  staged: (PrereleaseProposal & { oid: string }) | null;
};

export type PrereleaseProposalPlan =
  | { kind: 'inactive'; reason: string }
  | { kind: 'none'; reason: string }
  | {
      kind: 'clear';
      openPr: number | undefined;
      reason: string;
    }
  | {
      kind: 'sync';
      openPr: number;
      reason: string;
      version: string;
    }
  | {
      kind: 'create' | 'recreate' | 'refresh';
      openPr: number | undefined;
      reason: string;
      version: string;
    };

const trailersFrom = (message: string): Record<string, string> =>
  Object.fromEntries(
    message
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [capture(match, 1), capture(match, 2)]),
  );

const capture = (match: RegExpExecArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Prerelease metadata omitted capture ${index}.`);
  }
  return value;
};

const requiredTrailer = (
  trailers: Record<string, string>,
  name: string,
): string => {
  const value = trailers[name];
  if (value === undefined) {
    throw new Error(`Commit is missing required ${name} trailer.`);
  }
  return value;
};

const fullOid = (value: string, label: string): string => {
  if (!fullOidPattern.test(value)) {
    throw new Error(`${label} is not a full commit OID: ${value}`);
  }
  return value;
};

export function nextPrereleaseVersion(lineVersion: string): string {
  const current = parseDevelopmentVersion(lineVersion);
  return [
    `${current.major}.${current.minor}.0`,
    `${current.prerelease}.${current.prereleaseNumber + 1}`,
  ].join('-');
}

export function prereleaseProposalCommitMessage(
  proposal: PrereleaseProposal,
): string {
  parseDevelopmentVersion(proposal.version);
  fullOid(proposal.boundaryOid, 'Prerelease boundary');
  fullOid(proposal.sourceOid, 'Prerelease source');
  if (proposal.attempt.trim().length === 0 || proposal.attempt.includes('\n')) {
    throw new Error('Prerelease proposal attempt must be one nonempty line.');
  }
  return [
    `release: propose ${proposal.version}`,
    '',
    `Prerelease-Version: ${proposal.version}`,
    `Prerelease-Source: ${proposal.sourceOid}`,
    `Prerelease-Boundary: ${proposal.boundaryOid}`,
    `Prerelease-Attempt: ${proposal.attempt}`,
  ].join('\n');
}

export function parsePrereleaseProposalMessage(
  message: string,
): PrereleaseProposal {
  const trailers = trailersFrom(message);
  const proposal = {
    attempt: requiredTrailer(trailers, 'Prerelease-Attempt'),
    boundaryOid: requiredTrailer(trailers, 'Prerelease-Boundary'),
    sourceOid: requiredTrailer(trailers, 'Prerelease-Source'),
    version: requiredTrailer(trailers, 'Prerelease-Version'),
  };
  parseDevelopmentVersion(proposal.version);
  fullOid(proposal.boundaryOid, 'Prerelease boundary');
  fullOid(proposal.sourceOid, 'Prerelease source');
  if (proposal.attempt.includes('\n')) {
    throw new Error('Prerelease proposal attempt must be one line.');
  }
  return proposal;
}

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be one positive integer.`);
  }
};

const validateState = (state: PrereleaseProposalState): void => {
  fullOid(state.mainOid, 'Prerelease main source');
  parseDevelopmentVersion(state.lineVersion);
  if (state.boundaryOid !== null) {
    fullOid(state.boundaryOid, 'Prerelease snapshot boundary');
  }
  if (state.openPr !== null) {
    positiveInteger(state.openPr.number, 'Prerelease pull request');
  }
  if (state.staged !== null) {
    fullOid(state.staged.oid, 'Prerelease proposal');
    parsePrereleaseProposalMessage(
      prereleaseProposalCommitMessage(state.staged),
    );
  }
};

export function planPrereleaseProposal(
  state: PrereleaseProposalState,
): PrereleaseProposalPlan {
  validateState(state);
  if (state.boundaryOid === null) {
    if (state.openPr !== null || state.staged !== null) {
      throw new Error(
        'An unmanaged development line cannot contain canonical prerelease proposal state.',
      );
    }
    return {
      kind: 'inactive',
      reason: 'development line has no managed prerelease snapshot',
    };
  }

  if (state.mainOid === state.boundaryOid) {
    if (state.openPr !== null || state.staged !== null) {
      return {
        kind: 'clear',
        openPr: state.openPr?.number,
        reason: 'no product work exists after the latest prerelease snapshot',
      };
    }
    return {
      kind: 'none',
      reason: 'no product work exists after the latest prerelease snapshot',
    };
  }

  const version = nextPrereleaseVersion(state.lineVersion);
  if (state.openPr !== null) {
    if (state.staged === null) {
      throw new Error(
        'The canonical Prerelease PR has no prerelease proposal branch.',
      );
    }
    if (state.staged.version !== version) {
      throw new Error(
        `Prerelease proposal reserves ${state.staged.version}, expected ${version}.`,
      );
    }
    if (
      state.staged.sourceOid === state.mainOid &&
      state.staged.boundaryOid === state.boundaryOid
    ) {
      if (state.openPr.bodyCurrent) {
        return {
          kind: 'none',
          reason: 'open prerelease proposal is current',
        };
      }
      return {
        kind: 'sync',
        openPr: state.openPr.number,
        reason: 'Prerelease PR body is stale',
        version,
      };
    }
    return {
      kind: 'refresh',
      openPr: state.openPr.number,
      reason: 'main advanced after prerelease proposal preparation',
      version,
    };
  }

  return {
    kind: state.staged === null ? 'create' : 'recreate',
    openPr: undefined,
    reason:
      state.staged === null
        ? 'main contains unreleased product work'
        : 'the previous Prerelease PR is no longer open',
    version,
  };
}
