import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type PackageManifest = {
  name?: string;
  private?: boolean;
  repository?: {
    directory?: string;
    url?: string;
  };
  version?: string;
  workspaces?: string[] | { packages?: string[] };
} & Record<string, unknown>;

export type PublicPackage = {
  directory: string;
  location: string;
  manifest: PackageManifest;
  manifestPath: string;
  name: string;
  version: string;
};

export type WorkspacePackage = PublicPackage & {
  private: boolean;
};

const readJson = async (path: string): Promise<PackageManifest> => {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain one JSON object.`);
  }
  return { ...value };
};

const workspacePatterns = (rootManifest: PackageManifest): string[] => {
  const value = rootManifest.workspaces;
  const patterns = Array.isArray(value) ? value : value?.packages;

  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('The root package.json must define at least one workspace pattern.');
  }

  if (patterns.some((pattern) => typeof pattern !== 'string')) {
    throw new Error('Every workspace pattern must be a string.');
  }
  return patterns;
};

const expandSingleLevelPattern = async (root: string, pattern: string): Promise<string[]> => {
  if (typeof pattern !== 'string' || !pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    throw new Error(`Unsupported workspace pattern: ${String(pattern)}`);
  }

  const parentPattern = pattern.slice(0, -2);
  if (parentPattern.length === 0 || isAbsolute(parentPattern) || parentPattern.includes('\\')) {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }

  const parent = resolve(root, parentPattern);
  const parentFromRoot = relative(root, parent);
  if (
    parentFromRoot === '' ||
    parentFromRoot === '..' ||
    parentFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(parentFromRoot)
  ) {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
};

const compareLocation = (left: WorkspacePackage, right: WorkspacePackage): number =>
  left.location < right.location ? -1 : left.location > right.location ? 1 : 0;

export async function listWorkspacePackages(root = repositoryRoot): Promise<WorkspacePackage[]> {
  const rootManifest = await readJson(join(root, 'package.json'));
  const directories = (
    await Promise.all(
      workspacePatterns(rootManifest).map((pattern) => expandSingleLevelPattern(root, pattern))
    )
  ).flat();

  const packages: WorkspacePackage[] = [];
  const locations = new Set<string>();
  const names = new Set<string>();
  for (const directory of directories) {
    const manifestPath = join(directory, 'package.json');
    const manifest = await readJson(manifestPath);
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`Workspace has no name: ${manifestPath}`);
    }
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error(`Workspace has no version: ${manifest.name}`);
    }
    if (manifest.private !== undefined && typeof manifest.private !== 'boolean') {
      throw new Error(`Workspace has invalid private metadata: ${manifest.name}`);
    }

    const location = relative(root, directory).split(sep).join('/');
    if (
      location.length === 0 ||
      location.startsWith('/') ||
      location.startsWith('./') ||
      location.endsWith('/') ||
      location.includes('\\') ||
      location.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(`Invalid workspace location: ${location}`);
    }
    if (locations.has(location) || names.has(manifest.name)) {
      throw new Error('Workspace package names and locations must be unique.');
    }
    locations.add(location);
    names.add(manifest.name);

    packages.push({
      directory,
      location,
      manifest,
      manifestPath,
      name: manifest.name,
      private: manifest.private === true,
      version: manifest.version,
    });
  }

  return packages.sort(compareLocation);
}

export async function listPublicPackages(root = repositoryRoot): Promise<PublicPackage[]> {
  const packages = (await listWorkspacePackages(root)).filter((pkg) => !pkg.private);
  for (const pkg of packages) {
    if (!pkg.name.startsWith('@fablebook/lab-02-')) {
      throw new Error(`Unexpected public workspace name in ${pkg.manifestPath}`);
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}
