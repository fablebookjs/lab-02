import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

  const parent = join(root, pattern.slice(0, -2));
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
};

export async function listPublicPackages(root = repositoryRoot) {
  const rootManifest = await readJson(join(root, 'package.json'));
  const directories = (
    await Promise.all(
      workspacePatterns(rootManifest).map((pattern) => expandSingleLevelPattern(root, pattern))
    )
  ).flat();

  const packages: PublicPackage[] = [];
  for (const directory of directories) {
    const manifestPath = join(directory, 'package.json');
    const manifest = await readJson(manifestPath);
    if (manifest.private === true) {
      continue;
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@fablebook/lab-02-')) {
      throw new Error(`Unexpected public workspace name in ${manifestPath}`);
    }
    if (typeof manifest.version !== 'string') {
      throw new Error(`Public workspace has no version: ${manifest.name}`);
    }

    packages.push({
      directory,
      location: relative(root, directory).split(sep).join('/'),
      manifest,
      manifestPath,
      name: manifest.name,
      version: manifest.version,
    });
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}
