import { resolve } from 'node:path';

import { run } from '../process/run.ts';
import type { RunOptions } from '../process/run.ts';
import { repositoryRoot } from '../workspace/packages.ts';

type RootManifest = {
  version?: string;
  workspaces?: string[];
};

type PublicPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const stringRecord = (
  value: unknown,
  label: string,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must map names to versions.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, version]) => [
      name,
      stringValue(version, `${label}.${name}`),
    ]),
  );
};

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

export const ensureCleanReleaseRepository = async (): Promise<void> => {
  const { stdout } = await git(['rev-parse', '--show-toplevel']);
  if (resolve(stdout.trim()) !== resolve(repositoryRoot)) {
    throw new Error(
      'Release commands must run after the Lab-02 seed becomes the root of its own Git repository.',
    );
  }
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim()) {
    throw new Error('Release preparation requires a clean working tree.');
  }
};

export const commitParents = async (oid: string): Promise<string[]> => {
  const { stdout } = await git(['show', '-s', '--format=%P', oid]);
  return stdout.trim().split(/\s+/).filter(Boolean);
};

export const commitMessageAt = async (oid: string): Promise<string> => {
  const { stdout } = await git(['show', '-s', '--format=%B', oid]);
  return stdout.trimEnd();
};

export const manifestAt = async (oid: string, path: string): Promise<unknown> => {
  const { stdout } = await git(['show', `${oid}:${path}`]);
  const value: unknown = JSON.parse(stdout);
  return value;
};

const rootManifestValue = (value: unknown): RootManifest => {
  if (!isRecord(value)) throw new Error('Root package.json must contain one object.');
  const workspaces = value['workspaces'];
  if (
    workspaces !== undefined &&
    (!Array.isArray(workspaces) || workspaces.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error('Root package.json workspaces must be strings.');
  }
  return {
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
    ...(Array.isArray(workspaces)
      ? { workspaces: workspaces.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
};

const packageManifestValue = (value: unknown, path: string): PublicPackageManifest => {
  if (!isRecord(value)) throw new Error(`${path} must contain one object.`);
  const dependencies = stringRecord(value['dependencies'], `${path}.dependencies`);
  const devDependencies = stringRecord(
    value['devDependencies'],
    `${path}.devDependencies`,
  );
  const optionalDependencies = stringRecord(
    value['optionalDependencies'],
    `${path}.optionalDependencies`,
  );
  const peerDependencies = stringRecord(
    value['peerDependencies'],
    `${path}.peerDependencies`,
  );
  return {
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(typeof value['private'] === 'boolean' ? { private: value['private'] } : {}),
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
  };
};

export const publicPackagesAt = async (
  oid: string,
): Promise<{
  packages: Array<{ manifest: PublicPackageManifest; name: string }>;
  root: RootManifest;
}> => {
  const root = rootManifestValue(await manifestAt(oid, 'package.json'));
  if (JSON.stringify(root.workspaces) !== JSON.stringify(['packages/*'])) {
    throw new Error('The release controller supports only the accepted packages/* seed workspace.');
  }
  const { stdout } = await git(['ls-tree', '-d', '--name-only', `${oid}:packages`]);
  const packages: Array<{ manifest: PublicPackageManifest; name: string }> = [];
  for (const directory of stdout.trim().split('\n').filter(Boolean)) {
    const manifestPath = `packages/${directory}/package.json`;
    const manifest = packageManifestValue(
      await manifestAt(oid, manifestPath),
      manifestPath,
    );
    if (manifest.private !== true) {
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`packages/${directory}/package.json has no package name.`);
      }
      packages.push({ manifest, name: manifest.name });
    }
  }
  return { packages, root };
};

export async function rootVersionAt(oid: string): Promise<string> {
  const manifest = rootManifestValue(await manifestAt(oid, 'package.json'));
  if (typeof manifest.version !== 'string') {
    throw new Error(`${oid} root package.json has no version.`);
  }
  return manifest.version;
}

export const validateVersionTree = async (
  oid: string,
  version: string,
): Promise<void> => {
  const { packages, root } = await publicPackagesAt(oid);
  if (root.version !== version || packages.length === 0) {
    throw new Error(`${oid} does not materialize root version ${version}.`);
  }
  const publicNames = new Set(packages.map(({ name }) => name));
  for (const pkg of packages) {
    if (pkg.manifest.version !== version) {
      throw new Error(`${pkg.name} does not materialize ${version}.`);
    }
    const dependencyFields: Array<
      'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
    > = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ];
    for (const field of dependencyFields) {
      for (const [name, dependencyVersion] of Object.entries(pkg.manifest[field] ?? {})) {
        if (publicNames.has(name) && dependencyVersion !== version) {
          throw new Error(`${pkg.name} has a non-lockstep dependency on ${name}.`);
        }
      }
    }
  }
};

export function validateFullOid(oid: unknown, label: string): asserts oid is string {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
}
