import {
  lineChannel,
  validateReleaseCommunication,
} from '../../shared/release-publication/core.ts';
import type {
  ReleaseAuthority,
  ReleaseCommunication,
} from '../../shared/release-publication/core.ts';
import { parseStableVersion } from '../../shared/release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

/** Schema-2 stable authority document downloaded from an unprivileged upstream job. */
export type ReleaseAuthorityDocument = ReleaseAuthority & {
  releaseCommunication: ReleaseCommunication;
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
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const authorityValue = (
  input: Record<string, unknown>,
  label: string,
): ReleaseAuthority => {
  const line = stringValue(input['line'], `${label} line`);
  const version = stringValue(input['version'], `${label} version`);
  parseStableVersion(version);
  const channel = stringValue(input['channel'], `${label} channel`);
  if (channel !== lineChannel(line)) {
    throw new Error(`${label} channel does not match its release line.`);
  }
  return {
    channel,
    line,
    proposalOid: oidValue(input['proposalOid'], `${label} proposal`),
    pullRequest: positiveInteger(input['pullRequest'], `${label} pull request`),
    snapshotOid: oidValue(input['snapshotOid'], `${label} snapshot`),
    sourceOid: oidValue(input['sourceOid'], `${label} source`),
    version,
  };
};

/** Narrows stable authority and its version-bound communication before preparation. */
export function parseReleaseAuthorityDocument(
  input: unknown,
): ReleaseAuthorityDocument {
  if (
    !isRecord(input) ||
    input['schema'] !== 2 ||
    input['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Release authority document is outside the pilot schema.');
  }
  const authority = authorityValue(input, 'Release authority');
  return {
    ...authority,
    releaseCommunication: validateReleaseCommunication(
      input['releaseCommunication'],
      authority.version,
    ),
  };
}
