import {
  type PublicationPackage,
  validatePublicationPackages,
} from '../release-publication/publication.ts';
import { parseDevelopmentVersion } from '../release-proposal/core.ts';
import {
  PILOT_REPOSITORY,
  PRERELEASE_CHANNEL,
  type PrereleaseAuthority,
} from './core.ts';

export type PrereleasePublicationManifest = PrereleaseAuthority &
  Readonly<{
    packages: readonly PublicationPackage[];
    releaseBody: string;
    repository: typeof PILOT_REPOSITORY;
    schema: 1;
  }>;

export type PrereleasePublicationBinding = Readonly<{
  repository: string;
  snapshotOid: string;
  version: string;
}>;

export type NextOperations = Readonly<{
  addNext: (name: string, version: string) => Promise<void>;
  observeNext: (name: string) => Promise<string | null>;
  wait: (milliseconds: number) => Promise<void>;
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

const manifestKeys: readonly string[] = [
  'boundaryOid',
  'channel',
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

export async function validatePrereleasePublicationManifest(
  input: unknown,
  artifactRoot: string,
  expected: PrereleasePublicationBinding,
): Promise<PrereleasePublicationManifest> {
  parseDevelopmentVersion(expected.version);
  oidValue(expected.snapshotOid, 'Expected prerelease snapshot');
  if (
    expected.repository !== PILOT_REPOSITORY ||
    !isRecord(input) ||
    !hasExactKeys(input, manifestKeys) ||
    input['schema'] !== 1 ||
    input['repository'] !== expected.repository ||
    input['snapshotOid'] !== expected.snapshotOid ||
    input['version'] !== expected.version ||
    input['channel'] !== PRERELEASE_CHANNEL
  ) {
    throw new Error(
      'Prerelease publication manifest is outside the expected schema-1 binding.',
    );
  }
  const version = stringValue(input['version'], 'Prerelease manifest version');
  parseDevelopmentVersion(version);
  return {
    boundaryOid: oidValue(
      input['boundaryOid'],
      'Prerelease manifest boundary',
    ),
    channel: PRERELEASE_CHANNEL,
    packages: await validatePublicationPackages(
      input['packages'],
      artifactRoot,
    ),
    proposalOid: oidValue(
      input['proposalOid'],
      'Prerelease manifest proposal',
    ),
    pullRequest: positiveInteger(
      input['pullRequest'],
      'Prerelease manifest pull request',
    ),
    releaseBody: stringValue(
      input['releaseBody'],
      'Prerelease manifest release body',
    ),
    repository: PILOT_REPOSITORY,
    schema: 1,
    snapshotOid: oidValue(
      input['snapshotOid'],
      'Prerelease manifest snapshot',
    ),
    sourceOid: oidValue(input['sourceOid'], 'Prerelease manifest source'),
    version,
  };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function reconcileNextPackageSet(
  manifest: PrereleasePublicationManifest,
  operations: NextOperations,
): Promise<void> {
  const failures: string[] = [];
  for (const { name } of manifest.packages) {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if ((await operations.observeNext(name)) !== manifest.version) {
          await operations.addNext(name, manifest.version);
        }
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (attempt < 2) {
          await operations.wait((attempt + 1) * 1_000);
        }
      }
    }
    if (failure !== undefined) {
      failures.push(`${name}@${manifest.version}: ${errorMessage(failure)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Prerelease next reconciliation exhausted retries for ${failures.length} package(s):\n` +
        failures.map((failure) => `- ${failure}`).join('\n'),
    );
  }

  const mismatches: string[] = [];
  for (const { name } of manifest.packages) {
    const observed = await operations.observeNext(name);
    if (observed !== manifest.version) {
      mismatches.push(
        `${name}: expected ${manifest.version}, observed ${observed ?? 'no next tag'}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Prerelease next read-back disagrees for ${mismatches.length} package(s):\n` +
        mismatches.map((mismatch) => `- ${mismatch}`).join('\n'),
    );
  }
}
