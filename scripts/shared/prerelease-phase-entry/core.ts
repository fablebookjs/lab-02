import { parseDevelopmentVersion } from '../release-proposal/core.ts';

const fullOidPattern = /^[0-9a-f]{40}$/;

export type PrereleasePhase = 'alpha' | 'beta' | 'rc';
export type ManualPrereleasePhase = Exclude<PrereleasePhase, 'alpha'>;

/** Durable authority recorded when a maintainer manually enters beta or rc. */
export type PhaseEntryCommit = {
  boundaryOid: string;
  phase: ManualPrereleasePhase;
  sourceOid: string;
  version: string;
};

/** Phase-entry trailers paired with the applied commit that carries them. */
export type PhaseEntrySnapshot = PhaseEntryCommit & {
  snapshotOid: string;
};

/** Establish-or-reconcile intent for the requested manual phase boundary. */
export type PhaseEntryPlan =
  | {
      kind: 'establish';
      version: string;
    }
  | {
      entry: PhaseEntrySnapshot;
      kind: 'reconcile';
      version: string;
    };

const phaseOrder: Record<PrereleasePhase, number> = {
  alpha: 0,
  beta: 1,
  rc: 2,
};

const capture = (match: RegExpExecArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Phase-entry metadata omitted capture ${index}.`);
  }
  return value;
};

const fullOid = (value: string, label: string): string => {
  if (!fullOidPattern.test(value)) {
    throw new Error(`${label} is not a full commit OID: ${value}`);
  }
  return value;
};

const trailersFrom = (message: string): Record<string, string> =>
  Object.fromEntries(
    message
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [capture(match, 1), capture(match, 2)]),
  );

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

/** Restricts manual phase entry to forward phases; alpha begins at release cut. */
export function parseManualPrereleasePhase(
  value: string,
): ManualPrereleasePhase {
  if (value !== 'beta' && value !== 'rc') {
    throw new Error(`Manual prerelease phase must be beta or rc: ${value}`);
  }
  return value;
}

const validateEntry = (entry: PhaseEntryCommit): PhaseEntryCommit => {
  const version = parseDevelopmentVersion(entry.version);
  const phase = parseManualPrereleasePhase(entry.phase);
  fullOid(entry.boundaryOid, 'Phase-entry boundary');
  fullOid(entry.sourceOid, 'Phase-entry source');
  if (version.prerelease !== phase || version.prereleaseNumber !== 0) {
    throw new Error(
      `Phase-entry version must begin ${phase} at counter zero: ${entry.version}`,
    );
  }
  return { ...entry, phase };
};

/** Encodes a validated phase-entry boundary as durable commit trailers. */
export function phaseEntryCommitMessage(entry: PhaseEntryCommit): string {
  const valid = validateEntry(entry);
  return [
    `release: enter ${valid.version}`,
    '',
    `Prerelease-Phase-Entry: ${valid.phase}`,
    `Prerelease-Phase-Version: ${valid.version}`,
    `Prerelease-Phase-Source: ${valid.sourceOid}`,
    `Prerelease-Phase-Boundary: ${valid.boundaryOid}`,
  ].join('\n');
}

/** Parses the complete manual phase-entry trailer protocol. */
export function parsePhaseEntryCommitMessage(
  message: string,
): PhaseEntryCommit {
  const trailers = trailersFrom(message);
  return validateEntry({
    boundaryOid: requiredTrailer(trailers, 'Prerelease-Phase-Boundary'),
    phase: parseManualPrereleasePhase(
      requiredTrailer(trailers, 'Prerelease-Phase-Entry'),
    ),
    sourceOid: requiredTrailer(trailers, 'Prerelease-Phase-Source'),
    version: requiredTrailer(trailers, 'Prerelease-Phase-Version'),
  });
}

/**
 * Returns `null` only when no phase-entry marker exists; a partial marked
 * commit is malformed history and therefore throws.
 */
export function parsePhaseEntryCommitMessageIfPresent(
  message: string,
): PhaseEntryCommit | null {
  if (!message.includes('Prerelease-Phase-')) {
    return null;
  }
  return parsePhaseEntryCommitMessage(message);
}

/**
 * Plans a forward phase transition or validates an idempotent same-phase retry.
 * Backward movement and an unproven same-phase boundary are rejected.
 */
export function planPhaseEntry({
  currentVersion,
  entry,
  target,
}: {
  currentVersion: string;
  entry: PhaseEntrySnapshot | null;
  target: string;
}): PhaseEntryPlan {
  const current = parseDevelopmentVersion(currentVersion);
  const phase = parseManualPrereleasePhase(target);
  const movement = phaseOrder[phase] - phaseOrder[current.prerelease];
  if (movement < 0) {
    throw new Error(
      `Prerelease phase cannot move backward from ${current.prerelease} to ${phase}.`,
    );
  }

  const version = `${current.major}.${current.minor}.0-${phase}.0`;
  if (movement > 0) {
    if (entry !== null) {
      throw new Error(
        `${version} already exists while main carries the earlier ${current.prerelease} phase.`,
      );
    }
    return { kind: 'establish', version };
  }

  if (entry === null) {
    throw new Error(
      `${phase}.0 was not established by the managed phase-entry lifecycle.`,
    );
  }
  const valid = validateEntry(entry);
  fullOid(entry.snapshotOid, 'Phase-entry snapshot');
  if (valid.version !== version) {
    throw new Error(
      `The managed ${phase}.0 snapshot carries ${valid.version}, expected ${version}.`,
    );
  }
  return {
    entry: { ...valid, snapshotOid: entry.snapshotOid },
    kind: 'reconcile',
    version,
  };
}
