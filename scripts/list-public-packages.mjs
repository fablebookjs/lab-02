import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const workspacePatterns = (rootManifest) => {
  const value = rootManifest.workspaces;
  const patterns = Array.isArray(value) ? value : value?.packages;

  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('The root package.json must define at least one workspace pattern.');
  }

  return patterns;
};

const expandSingleLevelPattern = async (root, pattern) => {
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

  const packages = [];
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

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const packages = await listPublicPackages();
  console.log(
    JSON.stringify(
      packages.map(({ location, name, version }) => ({ location, name, version })),
      null,
      2
    )
  );
}
