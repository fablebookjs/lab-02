export const ZERO_OID = '0000000000000000000000000000000000000000';

const developmentPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0-(alpha|beta|rc)\.(0|[1-9]\d*)$/;
const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const linePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type DevelopmentVersion = {
  major: number;
  minor: number;
  prerelease: 'alpha' | 'beta' | 'rc';
  prereleaseNumber: number;
};

export type StableVersion = {
  major: number;
  minor: number;
  patch: number;
};

export type ReleaseLine = {
  major: number;
  minor: number;
};

/** Provider-neutral commit evidence used to prove release ancestry and tree identity. */
export type ReleaseCommitView = {
  message?: string;
  parents?: Array<{ sha: string }>;
  sha: string;
  tree?: { sha: string };
};

type ProposalCommit = {
  attempt: string;
  line: string;
  sourceOid: string;
  version: string;
};

/** Durable release-cut boundary recovered from the development commit trailers. */
export type DevelopmentCommit = {
  line: string;
  sourceOid: string;
  version: string;
};

const developmentTrailerNames: readonly string[] = [
  'Release-Cut-Line',
  'Release-Cut-Source',
  'Development-Version',
];
const prereleaseBootstrapTrailer = 'Prerelease-Bootstrap';

/**
 * Complete observed state for one stable release line. The maintenance planner
 * treats this as a snapshot and never performs repository I/O itself.
 */
export type ProposalState = {
  accountingOid: string | null;
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
  staged: {
    oid: string;
    sourceOid: string;
    version: string;
  } | null;
};

/**
 * Selects the newest trusted completion already present on first-parent release
 * history. Any candidate outside that history is a contradiction, not absence.
 */
export function deriveProposalAccountingBoundary({
  completedOid,
  mergedProposalOids,
  releaseHistory,
}: {
  completedOid: string | null;
  mergedProposalOids: readonly string[];
  releaseHistory: readonly string[];
}): string | null {
  const history = new Set(releaseHistory);
  const candidates = new Set([
    ...(completedOid === null ? [] : [completedOid]),
    ...mergedProposalOids,
  ]);

  for (const oid of candidates) {
    if (!history.has(oid)) {
      throw new Error(`Proposal accounting snapshot ${oid} is not on release-line history.`);
    }
  }

  return releaseHistory.find((oid) => candidates.has(oid)) ?? null;
}

const integer = (match: RegExpExecArray, index: number): number => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Version pattern omitted capture ${index}.`);
  }
  return Number.parseInt(value, 10);
};

const capture = (match: RegExpExecArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Version pattern omitted capture ${index}.`);
  }
  return value;
};

/** Parses the restricted development SemVer forms understood by release automation. */
export function parseDevelopmentVersion(version: string): DevelopmentVersion {
  const match = developmentPattern.exec(version);
  if (!match) {
    throw new Error(
      `Development version must be X.Y.0-alpha.N, X.Y.0-beta.N, or X.Y.0-rc.N: ${version}`
    );
  }
  const prerelease = capture(match, 3);
  if (prerelease !== 'alpha' && prerelease !== 'beta' && prerelease !== 'rc') {
    throw new Error(`Unsupported prerelease kind: ${prerelease}`);
  }
  return {
    major: integer(match, 1),
    minor: integer(match, 2),
    prerelease,
    prereleaseNumber: integer(match, 4),
  };
}

/** Parses stable SemVer without accepting build metadata or prerelease syntax. */
export function parseStableVersion(version: string): StableVersion {
  const match = stablePattern.exec(version);
  if (!match) {
    throw new Error(`Release version must be stable SemVer: ${version}`);
  }
  return {
    major: integer(match, 1),
    minor: integer(match, 2),
    patch: integer(match, 3),
  };
}

/** Parses the canonical `vX.Y` release-line identity. */
export function parseReleaseLine(line: string): ReleaseLine {
  const match = linePattern.exec(line);
  if (!match) {
    throw new Error(`Release line must be vX.Y: ${line}`);
  }
  return { major: integer(match, 1), minor: integer(match, 2) };
}

/** Orders canonical release lines numerically rather than lexicographically. */
export function compareReleaseLines(left: string, right: string): number {
  const a = parseReleaseLine(left);
  const b = parseReleaseLine(right);
  return a.major - b.major || a.minor - b.minor;
}

/**
 * Derives both sides of a release cut: the stable line being opened and the
 * next alpha.0 development line. It does not inspect or mutate repository state.
 */
export function deriveCutVersions(
  developmentVersion: string,
  nextDevelopment: string,
): { developmentVersion: string; line: string; releaseVersion: string } {
  if (nextDevelopment !== 'minor' && nextDevelopment !== 'major') {
    throw new Error(`Next development line must be minor or major: ${nextDevelopment}`);
  }

  const current = parseDevelopmentVersion(developmentVersion);
  const releaseVersion = `${current.major}.${current.minor}.0`;
  const line = `v${current.major}.${current.minor}`;
  const development =
    nextDevelopment === 'major'
      ? `${current.major + 1}.0.0-alpha.0`
      : `${current.major}.${current.minor + 1}.0-alpha.0`;

  return { developmentVersion: development, line, releaseVersion };
}

/**
 * Selects the initial stable version or next patch for a release line, rejecting
 * version evidence that belongs to a different line.
 */
export function nextReleaseVersion(line: string, lineVersion: string): string {
  const parsedLine = parseReleaseLine(line);
  if (developmentPattern.test(lineVersion)) {
    const development = parseDevelopmentVersion(lineVersion);
    if (
      development.major !== parsedLine.major ||
      development.minor !== parsedLine.minor
    ) {
      throw new Error(`${lineVersion} does not belong to release line ${line}`);
    }
    return `${development.major}.${development.minor}.0`;
  }

  const current = parseStableVersion(lineVersion);
  if (current.major !== parsedLine.major || current.minor !== parsedLine.minor) {
    throw new Error(`${lineVersion} does not belong to release line ${line}`);
  }
  return `${current.major}.${current.minor}.${current.patch + 1}`;
}

/**
 * Encodes stable proposal authority as commit trailers. The paired parser is
 * the protocol boundary; changing trailer meaning requires coordinated readers.
 */
export function proposalCommitMessage({
  attempt,
  line,
  sourceOid,
  version,
}: ProposalCommit): string {
  return [
    `release: propose v${version}`,
    '',
    `Release-Line: ${line}`,
    `Release-Version: ${version}`,
    `Release-Source: ${sourceOid}`,
    `Proposal-Attempt: ${attempt}`,
  ].join('\n');
}

/**
 * Encodes the durable release-cut boundary and alpha.0 bootstrap authority in
 * the development commit created by a managed cut.
 */
export function developmentCommitMessage({
  line,
  sourceOid,
  version,
}: DevelopmentCommit): string {
  return [
    `release: begin ${version} development`,
    '',
    `Release-Cut-Line: ${line}`,
    `Release-Cut-Source: ${sourceOid}`,
    `Development-Version: ${version}`,
    `${prereleaseBootstrapTrailer}: next`,
  ].join('\n');
}

const trailersFrom = (message: string): Record<string, string> => {
  const trailers = Object.fromEntries(
    message
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [capture(match, 1), capture(match, 2)])
  );
  return trailers;
};

const requiredTrailer = (trailers: Record<string, string>, name: string): string => {
  const value = trailers[name];
  if (value === undefined) {
    throw new Error(`Commit is missing required ${name} trailer.`);
  }
  return value;
};

const developmentCommitFrom = (
  trailers: Record<string, string>,
): DevelopmentCommit => {
  const metadata = {
    line: requiredTrailer(trailers, 'Release-Cut-Line'),
    sourceOid: requiredTrailer(trailers, 'Release-Cut-Source'),
    version: requiredTrailer(trailers, 'Development-Version'),
  };

  parseReleaseLine(metadata.line);
  parseDevelopmentVersion(metadata.version);
  if (!/^[0-9a-f]{40}$/.test(metadata.sourceOid)) {
    throw new Error(`Release-cut source is not a full commit OID: ${metadata.sourceOid}`);
  }
  return metadata;
};

/** Requires and validates a complete managed release-cut trailer set. */
export function parseDevelopmentCommitMessage(message: string): DevelopmentCommit {
  return developmentCommitFrom(trailersFrom(message));
}

/**
 * Returns `null` only when every release-cut trailer is absent; partial or
 * malformed metadata fails so history is never silently misclassified.
 */
export function parseDevelopmentCommitMessageIfPresent(
  message: string,
): DevelopmentCommit | null {
  const trailers = trailersFrom(message);
  if (developmentTrailerNames.every((name) => !Object.hasOwn(trailers, name))) {
    return null;
  }
  return developmentCommitFrom(trailers);
}

/**
 * Recognizes managed alpha.0 bootstrap authority. Presence of its marker makes
 * malformed or contradictory release-cut metadata a caller-visible failure.
 */
export function parsePrereleaseBootstrapCommitMessageIfPresent(
  message: string,
): DevelopmentCommit | null {
  const trailers = trailersFrom(message);
  if (!Object.hasOwn(trailers, prereleaseBootstrapTrailer)) {
    return null;
  }
  if (trailers[prereleaseBootstrapTrailer] !== 'next') {
    throw new Error(
      `${prereleaseBootstrapTrailer} must identify the next channel.`,
    );
  }
  const metadata = developmentCommitFrom(trailers);
  const version = parseDevelopmentVersion(metadata.version);
  if (version.prerelease !== 'alpha' || version.prereleaseNumber !== 0) {
    throw new Error(
      'A prerelease bootstrap commit must establish an alpha.0 version.',
    );
  }
  return metadata;
}

/** Parses and validates the stable proposal commit-trailer protocol. */
export function parseProposalMessage(message: string): ProposalCommit {
  const trailers = trailersFrom(message);
  const metadata = {
    attempt: requiredTrailer(trailers, 'Proposal-Attempt'),
    line: requiredTrailer(trailers, 'Release-Line'),
    sourceOid: requiredTrailer(trailers, 'Release-Source'),
    version: requiredTrailer(trailers, 'Release-Version'),
  };

  const line = parseReleaseLine(metadata.line);
  const version = parseStableVersion(metadata.version);
  if (line.major !== version.major || line.minor !== version.minor) {
    throw new Error(`${metadata.version} does not belong to release line ${metadata.line}`);
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.sourceOid)) {
    throw new Error(`Proposal source is not a full commit OID: ${metadata.sourceOid}`);
  }
  return metadata;
}

/**
 * Plans stable proposal maintenance from an immutable observation of every
 * line. Results describe intent only; controllers retain sequencing and writes.
 */
export function planProposalMaintenance(lines: readonly ProposalState[]) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }

  return lines.map((state) => {
    parseReleaseLine(state.line);
    const expectedVersion = nextReleaseVersion(state.line, state.lineVersion);
    const hasUnaccountedWork =
      state.accountingOid === null || state.releaseOid !== state.accountingOid;

    if (!hasUnaccountedWork) {
      if (state.staged !== null || state.openPr !== null) {
        return {
          kind: 'dormant',
          line: state.line,
          openPr: state.openPr,
          reason: 'line has no work after its accounted snapshot',
        };
      }
      return { kind: 'none', line: state.line, reason: 'line has no unaccounted work' };
    }

    if (state.openPr !== null) {
      if (state.staged === null) {
        throw new Error(`${state.line} has an open release PR without a staged ref`);
      }
      if (state.staged.version !== expectedVersion) {
        throw new Error(
          `${state.line} reserves ${state.staged.version}, expected ${expectedVersion}`
        );
      }
      if (state.openPr.replaceRequired === true) {
        return {
          kind: 'replace',
          line: state.line,
          openPr: state.openPr,
          reason: 'legacy release PR is disposable',
          supersededPr: state.openPr.number,
          version: state.staged.version,
        };
      }
      if (state.staged.sourceOid === state.releaseOid) {
        if (state.openPr.bodyCurrent === false) {
          return {
            kind: 'sync',
            line: state.line,
            openPr: state.openPr,
            reason: 'release PR body is stale',
            version: state.staged.version,
          };
        }
        return { kind: 'none', line: state.line, reason: 'open proposal is current' };
      }
      return {
        kind: 'refresh',
        line: state.line,
        openPr: state.openPr,
        reason: 'release line advanced',
        version: state.staged.version,
      };
    }

    if (state.latestClosedPr?.merged === false) {
      if (
        state.staged !== null &&
        state.staged.oid !== state.latestClosedPr.headOid &&
        state.staged.sourceOid === state.releaseOid &&
        state.staged.version === expectedVersion
      ) {
        return {
          kind: 'open',
          line: state.line,
          reason: 'fresh replacement proposal has no open PR',
          version: expectedVersion,
        };
      }
      return {
        kind: 'recreate',
        line: state.line,
        reason: 'the previous proposal was closed unmerged',
        supersededPr: state.latestClosedPr.number,
        version: expectedVersion,
      };
    }

    const mergedProposalIsStillStaged =
      state.staged !== null &&
      state.latestClosedPr?.merged === true &&
      state.latestClosedPr.headOid === state.staged.oid &&
      state.latestClosedPr.version === state.staged.version;
    if (mergedProposalIsStillStaged) {
      return {
        kind: 'create',
        line: state.line,
        reason: 'merged proposal advances to next patch',
        version: expectedVersion,
      };
    }

    if (state.staged !== null) {
      if (state.staged.version !== expectedVersion) {
        throw new Error(
          `${state.line} reserves ${state.staged.version}, expected ${expectedVersion}`
        );
      }
      if (state.staged.sourceOid === state.releaseOid) {
        return {
          kind: 'open',
          line: state.line,
          reason: 'current staged proposal has no open PR',
          version: expectedVersion,
        };
      }
    }

    return {
      kind: 'create',
      line: state.line,
      reason: 'line has unaccounted work',
      version: expectedVersion,
    };
  });
}
