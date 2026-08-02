import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../validation.ts';

const execute = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const supportedWorkspacePackageApiPaths: readonly string[] = [
  'scripts/api/v1/workspace-packages.ts',
];

/** Provider-neutral public package identity projected from a release snapshot. */
export type ReleasePackage = Readonly<{
  location: string;
  name: string;
  version: string;
}>;

type WorkspaceCatalogEntry = ReleasePackage &
  Readonly<{
    private: boolean;
  }>;

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const asNonemptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const asLocation = (value: unknown): string => {
  const location = asNonemptyString(value, 'Package location');
  if (
    location.startsWith('/') ||
    location.startsWith('./') ||
    location.endsWith('/') ||
    location.includes('\\') ||
    location.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid package location: ${location}`);
  }
  return location;
};

const compareLocation = (left: ReleasePackage, right: ReleasePackage): number =>
  left.location < right.location ? -1 : left.location > right.location ? 1 : 0;

const validateReleasePackageSet = (
  packages: readonly ReleasePackage[],
  expectedVersion: string,
): readonly ReleasePackage[] => {
  if (packages.length === 0) {
    throw new Error('Release package set must not be empty.');
  }

  const locations = new Set<string>();
  const names = new Set<string>();
  for (const pkg of packages) {
    if (pkg.version !== expectedVersion) {
      throw new Error(`${pkg.name} does not use expected version ${expectedVersion}.`);
    }
    if (locations.has(pkg.location)) {
      throw new Error(`Duplicate release package location: ${pkg.location}`);
    }
    if (names.has(pkg.name)) {
      throw new Error(`Duplicate release package name: ${pkg.name}`);
    }
    locations.add(pkg.location);
    names.add(pkg.name);
  }

  return [...packages].sort(compareLocation);
};

const projectWorkspaceCatalog = (
  value: unknown,
  expectedVersion: string,
): readonly ReleasePackage[] => {
  if (!Array.isArray(value)) {
    throw new Error('Workspace package catalog must be an array.');
  }

  const catalog: WorkspaceCatalogEntry[] = value.map((entry) => {
    const pkg = asRecord(entry, 'Workspace package');
    if (typeof pkg['private'] !== 'boolean') {
      throw new Error('Workspace package private must be a boolean.');
    }
    return {
      location: asLocation(pkg['location']),
      name: asNonemptyString(pkg['name'], 'Workspace package name'),
      version: asNonemptyString(pkg['version'], 'Workspace package version'),
      private: pkg['private'],
    };
  });

  const locations = new Set<string>();
  const names = new Set<string>();
  for (const pkg of catalog) {
    if (locations.has(pkg.location)) {
      throw new Error(`Duplicate workspace package location: ${pkg.location}`);
    }
    if (names.has(pkg.name)) {
      throw new Error(`Duplicate workspace package name: ${pkg.name}`);
    }
    locations.add(pkg.location);
    names.add(pkg.name);
  }

  return validateReleasePackageSet(
    catalog
      .filter((pkg) => !pkg.private)
      .map(({ location, name, version }) => ({ location, name, version })),
    expectedVersion,
  );
};

const normalizeLegacyPackageSet = (
  value: unknown,
  expectedVersion: string,
): readonly ReleasePackage[] => {
  if (!Array.isArray(value)) {
    throw new Error('Legacy package set must be an array.');
  }
  return validateReleasePackageSet(
    value.map((entry) => {
      const pkg = asRecord(entry, 'Legacy package');
      return {
        location: asLocation(pkg['location']),
        name: asNonemptyString(pkg['name'], 'Legacy package name'),
        version: asNonemptyString(pkg['version'], 'Legacy package version'),
      };
    }),
    expectedVersion,
  );
};

const existsAsRegularFile = async (
  path: string,
): Promise<{ present: boolean; regular: boolean }> => {
  try {
    const status = await lstat(path);
    return { present: true, regular: status.isFile() };
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { present: false, regular: false };
    }
    throw error;
  }
};

const hasLegacyListPackagesScript = async (snapshotRoot: string): Promise<boolean> => {
  let source: string;
  try {
    source = await readFile(join(snapshotRoot, 'package.json'), 'utf8');
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }

  const manifest = asRecord(JSON.parse(source), 'Root package.json');
  const scripts = manifest['scripts'];
  if (scripts === undefined) {
    return false;
  }
  return typeof asRecord(scripts, 'Root package.json scripts')['list-packages'] === 'string';
};

const credentiallessEnvironment = (): NodeJS.ProcessEnv => {
  const allowedNames = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'ComSpec',
    'PATHEXT',
  ];
  return Object.fromEntries(
    allowedNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
};

const loadLegacyPackageSet = async (
  snapshotRoot: string,
  expectedVersion: string,
): Promise<readonly ReleasePackage[]> => {
  const { stdout } = await execute(
    npmExecutable,
    ['run', '--silent', '--ignore-scripts', 'list-packages'],
    {
      cwd: snapshotRoot,
      env: credentiallessEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );
  return normalizeLegacyPackageSet(JSON.parse(stdout), expectedVersion);
};

/**
 * Loads the public package set from an immutable snapshot, preferring the
 * newest supported tagged API and falling back only when that API is absent.
 * A present but invalid native API fails closed rather than invoking legacy
 * code. Legacy execution receives a credentialless environment.
 */
export async function loadReleasePackageSet(
  snapshotRoot: string,
  expectedVersion: string,
): Promise<readonly ReleasePackage[]> {
  snapshotRoot = resolve(snapshotRoot);
  expectedVersion = asNonemptyString(expectedVersion, 'Expected release version');

  for (const relativeEntrypoint of supportedWorkspacePackageApiPaths) {
    const selectedEntrypoint = join(snapshotRoot, relativeEntrypoint);
    const state = await existsAsRegularFile(selectedEntrypoint);
    if (!state.present) {
      continue;
    }
    if (!state.regular) {
      throw new Error(`Native workspace-packages API is not a regular file: ${selectedEntrypoint}`);
    }

    const imported: unknown = await import(pathToFileURL(selectedEntrypoint).href);
    const module = asRecord(imported, 'Native workspace-packages API module');
    const listWorkspacePackages = module['listWorkspacePackages'];
    if (typeof listWorkspacePackages !== 'function') {
      throw new Error('Native workspace-packages API must export listWorkspacePackages().');
    }
    return projectWorkspaceCatalog(await listWorkspacePackages(), expectedVersion);
  }

  if (await hasLegacyListPackagesScript(snapshotRoot)) {
    return loadLegacyPackageSet(snapshotRoot, expectedVersion);
  }

  throw new Error(
    `Unsupported release ${expectedVersion} at ${snapshotRoot}: no supported workspace-packages API or legacy list-packages script.`,
  );
}
