import { parseStableVersion } from '../release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../repository.ts';
import type { PublicationBinding } from '../package-publication/publication.ts';

/** Schema-1 package set sealed for a stable `latest` promotion. */
export type PromotionManifest = Readonly<{
  packages: readonly string[];
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
  snapshotOid: string;
  version: string;
}>;

/** Injectable dist-tag effects used by the serialized promotion procedure. */
export type PromotionOperations = Readonly<{
  addLatest: (name: string, version: string) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}>;

const promotionManifestKeys: readonly string[] = [
  'packages',
  'repository',
  'schema',
  'snapshotOid',
  'version',
];
const retryDelays: readonly number[] = [1_000, 2_000];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const stableVersion = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a stable version.`);
  }
  parseStableVersion(value);
  return value;
};

const safeNpmNamePart = (value: string): boolean =>
  /^[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$/.test(value);

const safeNpmPackageName = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 214) {
    throw new Error('Promotion package name is not a syntactically safe npm name.');
  }
  const parts = value.startsWith('@')
    ? value.slice(1).split('/')
    : [value];
  if (
    parts.length !== (value.startsWith('@') ? 2 : 1) ||
    parts.some((part) => !safeNpmNamePart(part))
  ) {
    throw new Error(`Promotion package name is not a syntactically safe npm name: ${value}`);
  }
  return value;
};

const requireExactKeys = (value: Record<string, unknown>): void => {
  const actual = Object.keys(value).sort();
  const expected = [...promotionManifestKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('Promotion manifest must contain exactly the schema-1 fields.');
  }
};

/**
 * Narrows an untrusted promotion artifact and binds it to invocation-owned
 * repository, snapshot, and stable-version facts.
 */
export function validatePromotionManifest(
  value: unknown,
  expected: PublicationBinding,
): PromotionManifest {
  if (!isRecord(value)) {
    throw new Error('Promotion manifest must be an object.');
  }
  requireExactKeys(value);
  if (value['schema'] !== 1) {
    throw new Error('Promotion manifest must use schema 1.');
  }

  const expectedSnapshotOid = fullOid(expected.snapshotOid, 'Expected promotion snapshot');
  const expectedVersion = stableVersion(expected.version, 'Expected promotion version');
  if (
    expected.repository !== PILOT_REPOSITORY ||
    value['repository'] !== expected.repository
  ) {
    throw new Error('Promotion manifest repository does not match the expected repository.');
  }

  const snapshotOid = fullOid(value['snapshotOid'], 'Promotion manifest snapshot');
  const version = stableVersion(value['version'], 'Promotion manifest version');
  if (snapshotOid !== expectedSnapshotOid || version !== expectedVersion) {
    throw new Error('Promotion manifest does not match the expected release binding.');
  }
  if (!Array.isArray(value['packages']) || value['packages'].length === 0) {
    throw new Error('Promotion manifest packages must be a nonempty array.');
  }

  const packages = value['packages'].map(safeNpmPackageName);
  if (new Set(packages).size !== packages.length) {
    throw new Error('Promotion manifest package names must be unique.');
  }

  return {
    packages,
    repository: PILOT_REPOSITORY,
    schema: 1,
    snapshotOid,
    version,
  };
}

/** Creates a sealed promotion artifact through the same validator used by consumers. */
export function createPromotionManifest({
  packages,
  snapshotOid,
  version,
}: {
  packages: readonly string[];
  snapshotOid: string;
  version: string;
}): PromotionManifest {
  const value = {
    packages,
    repository: PILOT_REPOSITORY,
    schema: 1,
    snapshotOid,
    version,
  };
  return validatePromotionManifest(value, {
    repository: PILOT_REPOSITORY,
    snapshotOid,
    version,
  });
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Applies `latest` to every sealed package with bounded retries. Packages are
 * attempted independently so one failure does not hide later outcomes.
 */
export async function promoteSealedPackageSet(
  manifest: PromotionManifest,
  operations: PromotionOperations,
): Promise<void> {
  const failures: string[] = [];

  for (const name of manifest.packages) {
    let failure: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        await operations.addLatest(name, manifest.version);
        failure = undefined;
        console.log(`Moved ${name} latest to ${manifest.version}.`);
        break;
      } catch (error) {
        failure = error;
        const delay = retryDelays[attempt];
        if (delay !== undefined) {
          await operations.wait(delay);
        }
      }
    }
    if (failure !== undefined) {
      failures.push(`${name}@${manifest.version}: ${errorMessage(failure)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Latest promotion exhausted retries for ${failures.length} package(s):\n` +
        failures.map((failure) => `- ${failure}`).join('\n'),
    );
  }
}
