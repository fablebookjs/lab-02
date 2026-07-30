import { lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  lineChannel,
  PILOT_REPOSITORY,
  type ReleaseAuthority,
} from './core.ts';
import { parseStableVersion } from '../release-proposal/core.ts';

export type PublicationPackage = Readonly<{
  filename: string;
  integrity: string;
  name: string;
}>;

export type PublicationManifest = ReleaseAuthority &
  Readonly<{
    packages: readonly PublicationPackage[];
    releaseBody: string;
    repository: typeof PILOT_REPOSITORY;
    schema: 3;
  }>;

export type PublicationBinding = Readonly<{
  repository: string;
  snapshotOid: string;
  version: string;
}>;

export type PublicationAdapter = Readonly<{
  observeIntegrity: (
    pkg: PublicationPackage,
    version: string,
  ) => Promise<string | null>;
  publish: (
    pkg: PublicationPackage,
    channel: string,
    version: string,
  ) => Promise<void>;
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

const npmNameValue = (value: unknown): string => {
  const name = stringValue(value, 'Publication package name');
  if (
    name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
  ) {
    throw new Error(`Unsafe npm package name: ${name}`);
  }
  return name;
};

const filenameValue = (value: unknown): string => {
  const filename = stringValue(value, 'Publication package filename');
  if (
    filename.length > 255 ||
    basename(filename) !== filename ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(filename)
  ) {
    throw new Error(`Unsafe publication tarball filename: ${filename}`);
  }
  return filename;
};

const integrityValue = (value: unknown): string => {
  const integrity = stringValue(value, 'Publication package integrity');
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  const encoded = match?.[1];
  if (
    encoded === undefined ||
    Buffer.from(encoded, 'base64').length !== 64 ||
    Buffer.from(encoded, 'base64').toString('base64') !== encoded
  ) {
    throw new Error(`Invalid npm SHA-512 integrity: ${integrity}`);
  }
  return integrity;
};

const packageValue = (value: unknown): PublicationPackage => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['filename', 'integrity', 'name'])
  ) {
    throw new Error('Publication package entry is outside schema 3.');
  }
  return {
    filename: filenameValue(value['filename']),
    integrity: integrityValue(value['integrity']),
    name: npmNameValue(value['name']),
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
  const packages = input['packages'].map(packageValue);
  const names = new Set<string>();
  const filenames = new Set<string>();
  const root = resolve(artifactRoot);
  for (const pkg of packages) {
    if (names.has(pkg.name) || filenames.has(pkg.filename)) {
      throw new Error('Publication manifest package names and filenames must be unique.');
    }
    names.add(pkg.name);
    filenames.add(pkg.filename);

    const path = join(root, pkg.filename);
    let regular = false;
    try {
      regular = (await lstat(path)).isFile();
    } catch {
      regular = false;
    }
    if (!regular) {
      throw new Error(`Publication tarball is missing or not a regular file: ${pkg.filename}`);
    }
  }

  return {
    ...authority,
    packages,
    releaseBody: stringValue(input['releaseBody'], 'Publication release body'),
    repository: PILOT_REPOSITORY,
    schema: 3,
  };
}

const errorValue = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export async function reconcilePublicationPlan(
  manifest: PublicationManifest,
  adapter: PublicationAdapter,
): Promise<void> {
  const failures: Error[] = [];
  for (const pkg of manifest.packages) {
    let completed = false;
    let permanentFailure = false;
    let lastError = new Error('Publication did not start.');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const observed = await adapter.observeIntegrity(pkg, manifest.version);
        if (observed === pkg.integrity) {
          completed = true;
          break;
        }
        if (observed !== null) {
          failures.push(
            new Error(
              `Integrity conflict for ${pkg.name}@${manifest.version}: expected ${pkg.integrity}, observed ${observed}.`,
            ),
          );
          permanentFailure = true;
          break;
        }

        await adapter.publish(pkg, manifest.channel, manifest.version);
        completed = true;
        break;
      } catch (error) {
        lastError = errorValue(error);
      }

      if (attempt < 3) {
        await adapter.wait(attempt * 1_000);
      }
    }

    if (!completed && !permanentFailure) {
      failures.push(
        new Error(
          `${pkg.name}@${manifest.version} failed after three attempts: ${lastError.message}`,
          { cause: lastError },
        ),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Stable publication failed for ${failures.length} package(s):\n${failures
        .map((failure) => `- ${failure.message}`)
        .join('\n')}`,
    );
  }
}
