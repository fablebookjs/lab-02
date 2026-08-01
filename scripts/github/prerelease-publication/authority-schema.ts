import { parseManualPrereleasePhase } from '../../shared/prerelease-phase-entry/core.ts';
import {
  PRERELEASE_CHANNEL,
  validatePrereleaseCommunication,
} from '../../shared/prerelease-publication/core.ts';
import type {
  PrereleaseAuthority,
  PrereleaseAuthorityBase,
} from '../../shared/prerelease-publication/core.ts';
import {
  parseDevelopmentVersion,
  parseReleaseLine,
} from '../../shared/release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

export type PrereleaseAuthorityDocument = PrereleaseAuthority & {
  changes: ReturnType<typeof validatePrereleaseCommunication>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be one positive integer.`);
  }
  return value;
};

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
};

export function parsePrereleaseAuthorityDocument(
  input: unknown,
): PrereleaseAuthorityDocument {
  if (
    !isRecord(input) ||
    input['schema'] !== 1 ||
    input['repository'] !== PILOT_REPOSITORY ||
    input['channel'] !== PRERELEASE_CHANNEL ||
    !Array.isArray(input['changes'])
  ) {
    throw new Error(
      'Prerelease authority document is outside the accepted schema.',
    );
  }
  const version = stringValue(input['version'], 'Prerelease authority version');
  const parsedVersion = parseDevelopmentVersion(version);
  const common: PrereleaseAuthorityBase = {
    boundaryOid: oidValue(input['boundaryOid'], 'Prerelease authority boundary'),
    channel: PRERELEASE_CHANNEL,
    snapshotOid: oidValue(input['snapshotOid'], 'Prerelease authority snapshot'),
    sourceOid: oidValue(input['sourceOid'], 'Prerelease authority source'),
    version,
  };
  let authority: PrereleaseAuthority;
  if (input['cutLine'] !== undefined) {
    const cutLine = stringValue(input['cutLine'], 'Prerelease bootstrap cut line');
    parseReleaseLine(cutLine);
    if (
      common.boundaryOid !== common.snapshotOid ||
      parsedVersion.prerelease !== 'alpha' ||
      parsedVersion.prereleaseNumber !== 0
    ) {
      throw new Error(
        'Prerelease bootstrap authority does not identify its alpha.0 boundary.',
      );
    }
    authority = { ...common, cutLine };
  } else if (input['phase'] !== undefined) {
    const phase = parseManualPrereleasePhase(
      stringValue(input['phase'], 'Prerelease authority phase'),
    );
    if (
      parsedVersion.prerelease !== phase ||
      parsedVersion.prereleaseNumber !== 0
    ) {
      throw new Error(
        'Phase-entry authority does not identify its target .0 version.',
      );
    }
    authority = { ...common, phase };
  } else {
    authority = {
      ...common,
      proposalOid: oidValue(input['proposalOid'], 'Prerelease authority proposal'),
      pullRequest: positiveInteger(
        input['pullRequest'],
        'Prerelease authority pull request',
      ),
    };
  }
  const changes = validatePrereleaseCommunication(input['changes']);
  if ('cutLine' in authority && changes.length !== 0) {
    throw new Error(
      'Prerelease bootstrap authority cannot carry prior-line changes.',
    );
  }
  return { ...authority, changes };
}
