import {
  type PublicationBinding,
  type PublicationPackage,
  validatePublicationPackages,
} from '../package-publication/publication.ts';
import {
  lineChannel,
  type ReleaseAuthority,
} from './core.ts';
import { parseStableVersion } from '../release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../repository.ts';

export type PublicationManifest = ReleaseAuthority &
  Readonly<{
    packages: readonly PublicationPackage[];
    releaseBody: string;
    repository: typeof PILOT_REPOSITORY;
    schema: 3;
  }>;

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
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
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

const manifestKeys = [
  'channel',
  'line',
  'packages',
  'proposalOid',
  'pullRequest',
  'releaseBody',
  'repository',
  'schema',
  'snapshotOid',
  'sourceOid',
  'version',
];

export async function validatePublicationManifest(
  input: unknown,
  artifactRoot: string,
  expected: PublicationBinding,
): Promise<PublicationManifest> {
  parseStableVersion(expected.version);
  oidValue(expected.snapshotOid, 'Expected publication snapshot');
  if (
    expected.repository !== PILOT_REPOSITORY ||
    !isRecord(input) ||
    !hasExactKeys(input, manifestKeys) ||
    input['schema'] !== 3 ||
    input['repository'] !== expected.repository ||
    input['snapshotOid'] !== expected.snapshotOid ||
    input['version'] !== expected.version ||
    !Array.isArray(input['packages']) ||
    input['packages'].length === 0
  ) {
    throw new Error('Publication manifest is outside the expected schema-3 binding.');
  }

  const authority = authorityValue(input, 'Publication manifest');
  const packages = await validatePublicationPackages(input['packages'], artifactRoot);

  return {
    ...authority,
    packages,
    releaseBody: stringValue(input['releaseBody'], 'Publication release body'),
    repository: PILOT_REPOSITORY,
    schema: 3,
  };
}
