export const ZERO_OID = '0000000000000000000000000000000000000000';

const developmentPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0-(alpha|beta|rc)\.(0|[1-9]\d*)$/;
const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const linePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const integers = (match, indexes) => indexes.map((index) => Number.parseInt(match[index], 10));

export function parseDevelopmentVersion(version) {
  const match = developmentPattern.exec(version);
  if (!match) {
    throw new Error(
      `Development version must be X.Y.0-alpha.N, X.Y.0-beta.N, or X.Y.0-rc.N: ${version}`
    );
  }
  const [major, minor, prereleaseNumber] = integers(match, [1, 2, 4]);
  return { major, minor, prerelease: match[3], prereleaseNumber };
}

export function parseStableVersion(version) {
  const match = stablePattern.exec(version);
  if (!match) {
    throw new Error(`Release version must be stable SemVer: ${version}`);
  }
  const [major, minor, patch] = integers(match, [1, 2, 3]);
  return { major, minor, patch };
}

export function parseReleaseLine(line) {
  const match = linePattern.exec(line);
  if (!match) {
    throw new Error(`Release line must be vX.Y: ${line}`);
  }
  const [major, minor] = integers(match, [1, 2]);
  return { major, minor };
}

export function compareReleaseLines(left, right) {
  const a = parseReleaseLine(left);
  const b = parseReleaseLine(right);
  return a.major - b.major || a.minor - b.minor;
}

export function deriveCutVersions(developmentVersion, nextDevelopment) {
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

export function nextReleaseVersion(line, completedVersion) {
  const parsedLine = parseReleaseLine(line);
  if (completedVersion === null) {
    return `${parsedLine.major}.${parsedLine.minor}.0`;
  }

  const completed = parseStableVersion(completedVersion);
  if (completed.major !== parsedLine.major || completed.minor !== parsedLine.minor) {
    throw new Error(`${completedVersion} does not belong to release line ${line}`);
  }
  return `${completed.major}.${completed.minor}.${completed.patch + 1}`;
}

const compareStableVersions = (left, right) => {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
};

export function proposalCommitMessage({ attempt, line, sourceOid, version }) {
  return [
    `release: propose v${version}`,
    '',
    `Release-Line: ${line}`,
    `Release-Version: ${version}`,
    `Release-Source: ${sourceOid}`,
    `Proposal-Attempt: ${attempt}`,
  ].join('\n');
}

export function refreshReleasePrBody(body, { sourceOid, version }) {
  parseStableVersion(version);
  if (!/^[0-9a-f]{40}$/.test(sourceOid)) {
    throw new Error(`Release PR source is not a full commit OID: ${sourceOid}`);
  }
  const expectedHeading = `Release proposal for **${version}**.`;
  if (!String(body).startsWith(expectedHeading)) {
    throw new Error('Release PR body does not have the expected canonical heading.');
  }
  const sourceLines = String(body).match(/^Source: `[0-9a-f]{40}`$/gm) ?? [];
  if (sourceLines.length !== 1) {
    throw new Error('Release PR body does not have exactly one canonical source line.');
  }
  return String(body).replace(sourceLines[0], `Source: \`${sourceOid}\``);
}

export function developmentCommitMessage({ line, sourceOid, version }) {
  return [
    `release: begin ${version} development`,
    '',
    `Release-Cut-Line: ${line}`,
    `Release-Cut-Source: ${sourceOid}`,
    `Development-Version: ${version}`,
  ].join('\n');
}

export function parseDevelopmentCommitMessage(message) {
  const trailers = Object.fromEntries(
    message
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );
  const metadata = {
    line: trailers['Release-Cut-Line'],
    sourceOid: trailers['Release-Cut-Source'],
    version: trailers['Development-Version'],
  };

  if (Object.values(metadata).some((value) => value === undefined)) {
    throw new Error('Development commit is missing required release-cut trailers.');
  }
  parseReleaseLine(metadata.line);
  parseDevelopmentVersion(metadata.version);
  if (!/^[0-9a-f]{40}$/.test(metadata.sourceOid)) {
    throw new Error(`Release-cut source is not a full commit OID: ${metadata.sourceOid}`);
  }
  return metadata;
}

export function parseProposalMessage(message) {
  const trailers = Object.fromEntries(
    message
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );
  const metadata = {
    attempt: trailers['Proposal-Attempt'],
    line: trailers['Release-Line'],
    sourceOid: trailers['Release-Source'],
    version: trailers['Release-Version'],
  };

  if (Object.values(metadata).some((value) => value === undefined)) {
    throw new Error('Proposal commit is missing required release trailers.');
  }
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

export function planProposalMaintenance(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }

  const newestLine = [...lines].map(({ line }) => line).sort(compareReleaseLines).at(-1);

  return lines.map((state) => {
    parseReleaseLine(state.line);
    const expectedVersion = nextReleaseVersion(state.line, state.completedVersion);
    const hasUnreleasedWork =
      state.completedOid === null || state.releaseOid !== state.completedOid;
    const active = state.line === newestLine || hasUnreleasedWork;

    if (!active) {
      if (state.staged !== null || state.openPr !== null) {
        return {
          kind: 'dormant',
          line: state.line,
          openPr: state.openPr,
          reason: 'older line has no work after its completed snapshot',
        };
      }
      return { kind: 'none', line: state.line, reason: 'line is dormant' };
    }

    const mergedAuthorizationPending =
      state.latestClosedPr?.merged === true &&
      (state.completedVersion === null ||
        compareStableVersions(state.completedVersion, state.latestClosedPr.version) < 0);
    if (mergedAuthorizationPending) {
      return {
        kind: 'none',
        line: state.line,
        reason: 'merged proposal is awaiting release completion',
      };
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
      if (state.staged.sourceOid === state.releaseOid) {
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
      reason: hasUnreleasedWork ? 'line has unreleased work' : 'newest line stays active',
      version: expectedVersion,
    };
  });
}
