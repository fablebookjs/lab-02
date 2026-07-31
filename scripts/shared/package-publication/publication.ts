import { lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export type PublicationPackage = Readonly<{
  filename: string;
  integrity: string;
  name: string;
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

export type PublicationPlan = Readonly<{
  channel: string;
  packages: readonly PublicationPackage[];
  version: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
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

export async function validatePublicationPackages(
  input: unknown,
  artifactRoot: string,
): Promise<readonly PublicationPackage[]> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Publication packages must be one nonempty array.');
  }
  const packages = input.map(packageValue);
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
  return packages;
}

const errorValue = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export async function reconcilePublicationPlan(
  manifest: PublicationPlan,
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
      `Package publication failed for ${failures.length} package(s):\n${failures
        .map((failure) => `- ${failure.message}`)
        .join('\n')}`,
    );
  }
}
