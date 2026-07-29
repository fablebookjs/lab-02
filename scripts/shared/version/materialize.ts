import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { listPublicPackages } from '../workspace/packages.ts';

type JsonObject = Record<string, unknown>;

type PackageManifest = JsonObject & {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version?: string;
};

type PackageLock = JsonObject & {
  packages?: Record<string, PackageManifest>;
};

const supportedVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] satisfies Array<keyof Pick<
  PackageManifest,
  'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringMap = (value: unknown, label: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must map package names to versions.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, version]) => {
      if (typeof version !== 'string') throw new Error(`${label}.${name} must be a string.`);
      return [name, version];
    }),
  );
};

const packageManifest = (value: unknown, label: string): PackageManifest => {
  if (!isRecord(value)) throw new Error(`${label} must contain one JSON object.`);
  const dependencies = stringMap(value['dependencies'], `${label}.dependencies`);
  const devDependencies = stringMap(value['devDependencies'], `${label}.devDependencies`);
  const optionalDependencies = stringMap(
    value['optionalDependencies'],
    `${label}.optionalDependencies`,
  );
  const peerDependencies = stringMap(
    value['peerDependencies'],
    `${label}.peerDependencies`,
  );
  return {
    ...value,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
  };
};

const packageLock = (value: unknown, label: string): PackageLock => {
  if (!isRecord(value)) throw new Error(`${label} must contain one JSON object.`);
  const packages = value['packages'];
  if (packages !== undefined && !isRecord(packages)) {
    throw new Error(`${label}.packages must contain one object.`);
  }
  return {
    ...value,
    ...(packages === undefined
      ? {}
      : {
          packages: Object.fromEntries(
            Object.entries(packages).map(([location, manifest]) => [
              location,
              packageManifest(manifest, `${label}.packages.${location}`),
            ]),
          ),
        }),
  };
};

const readJson = async (path: string): Promise<unknown> => {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return value;
};

const writeJson = async (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

function updateInternalDependencies(
  manifest: PackageManifest,
  publicNames: ReadonlySet<string>,
  version: string,
): void {
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    for (const name of Object.keys(dependencies)) {
      if (publicNames.has(name)) dependencies[name] = version;
    }
  }
}

export function validateMaterializedVersion(version: unknown): string {
  if (typeof version !== 'string' || !supportedVersion.test(version)) {
    throw new Error('Version must be X.Y.Z or X.Y.Z-alpha.N, -beta.N, or -rc.N.');
  }
  return version;
}

export async function materializeVersion(
  root: string,
  requestedVersion: unknown,
): Promise<{ packageCount: number; version: string }> {
  const version = validateMaterializedVersion(requestedVersion);
  const packages = await listPublicPackages(root);
  if (packages.length === 0) {
    throw new Error('No public workspace packages were discovered.');
  }

  const publicNames = new Set(packages.map(({ name }) => name));
  const rootManifestPath = join(root, 'package.json');
  const lockfilePath = join(root, 'package-lock.json');
  const rootManifest = packageManifest(await readJson(rootManifestPath), rootManifestPath);
  const lockfile = packageLock(await readJson(lockfilePath), lockfilePath);
  if (lockfile.packages === undefined || lockfile.packages[''] === undefined) {
    throw new Error('package-lock.json has no root package entry.');
  }

  rootManifest.version = version;
  lockfile.packages[''].version = version;

  const manifests = new Map<string, PackageManifest>();
  for (const pkg of packages) {
    const manifest = packageManifest(pkg.manifest, pkg.manifestPath);
    manifest.version = version;
    updateInternalDependencies(manifest, publicNames, version);
    manifests.set(pkg.manifestPath, manifest);

    const locked = lockfile.packages[pkg.location];
    if (locked === undefined || locked.name !== pkg.name) {
      throw new Error(`package-lock.json has no matching entry for ${pkg.name}.`);
    }
    locked.version = version;
    updateInternalDependencies(locked, publicNames, version);
  }

  await Promise.all([
    writeJson(rootManifestPath, rootManifest),
    writeJson(lockfilePath, lockfile),
    ...[...manifests].map(([manifestPath, manifest]) =>
      writeJson(manifestPath, manifest),
    ),
  ]);

  return { packageCount: packages.length, version };
}
