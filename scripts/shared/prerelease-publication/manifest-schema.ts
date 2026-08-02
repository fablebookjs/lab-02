import { isRecord, stringValue } from '../validation.ts';
import {
  type PublicationBinding,
  type PublicationPackage,
  validatePublicationPackages,
} from '../package-publication/publication.ts';
import {
  parseDevelopmentVersion,
  parseReleaseLine,
} from '../release-proposal/core.ts';
import {
  PRERELEASE_CHANNEL,
  type PrereleaseAuthority,
  type PrereleaseAuthorityBase,
} from './core.ts';
import { parseManualPrereleasePhase } from '../prerelease-phase-entry/core.ts';
import { PILOT_REPOSITORY } from '../repository.ts';

type PrereleasePublicationBase = PrereleaseAuthorityBase &
  Readonly<{
    packages: readonly PublicationPackage[];
    releaseBody: string;
    repository: typeof PILOT_REPOSITORY;
    schema: 1;
  }>;

/**
 * Schema-1 sealed prerelease artifact. Its discriminated authority records
 * whether an ordinary proposal, release cut, or phase entry authorized it.
 */
export type PrereleasePublicationManifest = PrereleaseAuthority &
  PrereleasePublicationBase;

/** Injectable npm dist-tag effects for retryable `next` reconciliation. */
export type NextOperations = Readonly<{
  addNext: (name: string, version: string) => Promise<void>;
  observeNext: (name: string) => Promise<string | null>;
  wait: (milliseconds: number) => Promise<void>;
}>;

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

const commonManifestKeys: readonly string[] = [
  'boundaryOid',
  'channel',
  'packages',
  'releaseBody',
  'repository',
  'schema',
  'snapshotOid',
  'sourceOid',
  'version',
];
const ordinaryManifestKeys: readonly string[] = [
  ...commonManifestKeys,
  'proposalOid',
  'pullRequest',
];
const phaseEntryManifestKeys: readonly string[] = [
  ...commonManifestKeys,
  'phase',
];
const bootstrapManifestKeys: readonly string[] = [
  ...commonManifestKeys,
  'cutLine',
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

/**
 * Narrows an untrusted prerelease artifact and binds it to trusted invocation
 * facts. Unknown fields and authority-shape contradictions fail closed.
 */
export async function validatePrereleasePublicationManifest(
  input: unknown,
  artifactRoot: string,
  expected: PublicationBinding,
): Promise<PrereleasePublicationManifest> {
  parseDevelopmentVersion(expected.version);
  oidValue(expected.snapshotOid, 'Expected prerelease snapshot');
  if (
    expected.repository !== PILOT_REPOSITORY ||
    !isRecord(input) ||
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
  const bootstrap = input['cutLine'] !== undefined;
  const phaseEntry = input['phase'] !== undefined;
  if (
    !hasExactKeys(
      input,
      bootstrap
        ? bootstrapManifestKeys
        : phaseEntry
          ? phaseEntryManifestKeys
          : ordinaryManifestKeys,
    )
  ) {
    throw new Error(
      'Prerelease publication manifest is outside the expected schema-1 binding.',
    );
  }
  const version = stringValue(input['version'], 'Prerelease manifest version');
  const parsedVersion = parseDevelopmentVersion(version);
  const common: PrereleasePublicationBase = {
    boundaryOid: oidValue(
      input['boundaryOid'],
      'Prerelease manifest boundary',
    ),
    channel: PRERELEASE_CHANNEL,
    packages: await validatePublicationPackages(
      input['packages'],
      artifactRoot,
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
  if (bootstrap) {
    const cutLine = stringValue(
      input['cutLine'],
      'Prerelease bootstrap cut line',
    );
    parseReleaseLine(cutLine);
    if (
      common.boundaryOid !== common.snapshotOid ||
      parsedVersion.prerelease !== 'alpha' ||
      parsedVersion.prereleaseNumber !== 0
    ) {
      throw new Error(
        'Prerelease bootstrap manifest does not identify its alpha.0 boundary.',
      );
    }
    return { ...common, cutLine };
  }
  if (phaseEntry) {
    const phase = parseManualPrereleasePhase(
      stringValue(input['phase'], 'Prerelease manifest phase'),
    );
    if (
      parsedVersion.prerelease !== phase ||
      parsedVersion.prereleaseNumber !== 0
    ) {
      throw new Error(
        'Prerelease phase-entry manifest does not identify its target .0 version.',
      );
    }
    return { ...common, phase };
  }
  return {
    ...common,
    proposalOid: oidValue(
      input['proposalOid'],
      'Prerelease manifest proposal',
    ),
    pullRequest: positiveInteger(
      input['pullRequest'],
      'Prerelease manifest pull request',
    ),
  };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Query-first reconciles every package to the sealed `next` version, retries
 * transient failures three times, then reads the complete set back before
 * succeeding. Per-package write failures are reported together.
 */
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
