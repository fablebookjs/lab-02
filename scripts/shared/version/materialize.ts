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
] as const;

const readJson = async <Value>(path: string): Promise<Value> =>
  JSON.parse(await readFile(path, 'utf8')) as Value;

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
  const rootManifest = await readJson<PackageManifest>(rootManifestPath);
  const lockfile = await readJson<PackageLock>(lockfilePath);
  if (lockfile.packages === undefined || lockfile.packages[''] === undefined) {
    throw new Error('package-lock.json has no root package entry.');
  }

  rootManifest.version = version;
  lockfile.packages[''].version = version;

  for (const pkg of packages) {
    const manifest = pkg.manifest as PackageManifest;
    manifest.version = version;
    updateInternalDependencies(manifest, publicNames, version);

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
    ...packages.map(({ manifest, manifestPath }) => writeJson(manifestPath, manifest)),
  ]);

  return { packageCount: packages.length, version };
}
