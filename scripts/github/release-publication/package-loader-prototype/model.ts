// PROTOTYPE — portable selection and projection logic for issue "Prototype
// credentialless tagged package-set loading". This branch is a primary source,
// not production code.

export type PackageSource =
  | {
      apiVersion: number;
      kind: 'native';
      path: string;
    }
  | {
      command: 'list-packages';
      kind: 'legacy';
    };

export type PackageSourceProbe = {
  legacyScript: boolean;
  native: ReadonlyArray<{
    path: string;
    present: boolean;
    regular: boolean;
    version: number;
  }>;
};

export type ReleasePackage = Readonly<{
  location: string;
  name: string;
  version: string;
}>;

type WorkspacePackage = ReleasePackage &
  Readonly<{
    private: boolean;
  }>;

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return value as Record<string, unknown>;
};

const nonemptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const normalizedLocation = (value: unknown): string => {
  const location = nonemptyString(value, 'Package location');
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

export function selectPackageSource(probe: PackageSourceProbe): PackageSource {
  for (const candidate of probe.native) {
    if (!candidate.present) continue;
    if (!candidate.regular) {
      throw new Error(`Native API v${candidate.version} is present but is not a regular file.`);
    }
    return {
      apiVersion: candidate.version,
      kind: 'native',
      path: candidate.path,
    };
  }
  if (probe.legacyScript) return { command: 'list-packages', kind: 'legacy' };
  throw new Error('Unsupported snapshot: no native API or legacy list-packages script.');
}

export function projectNativeCatalog(
  value: unknown,
  expectedVersion: string,
): readonly ReleasePackage[] {
  if (!Array.isArray(value)) throw new Error('Native catalog must be an array.');
  const releasePackages: ReleasePackage[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (typeof item['private'] !== 'boolean') {
      throw new Error('Native catalog private must be boolean.');
    }
    if (item['private']) continue;
    releasePackages.push({
      location: normalizedLocation(item['location']),
      name: nonemptyString(item['name'], 'Package name'),
      version: nonemptyString(item['version'], 'Package version'),
    });
  }
  return normalizeReleasePackages(releasePackages, expectedVersion);
}

export function normalizeLegacyPackages(
  value: unknown,
  expectedVersion: string,
): readonly ReleasePackage[] {
  if (!Array.isArray(value)) throw new Error('Legacy package set must be an array.');
  return normalizeReleasePackages(
    value.map((entry) => {
      const item = record(entry);
      return {
        location: normalizedLocation(item['location']),
        name: nonemptyString(item['name'], 'Package name'),
        version: nonemptyString(item['version'], 'Package version'),
      };
    }),
    expectedVersion,
  );
}

function normalizeReleasePackages(
  packages: readonly ReleasePackage[],
  expectedVersion: string,
): readonly ReleasePackage[] {
  if (packages.length === 0) throw new Error('Release package set must not be empty.');
  const names = new Set<string>();
  const locations = new Set<string>();
  for (const item of packages) {
    if (item.version !== expectedVersion) {
      throw new Error(`${item.name} does not use expected version ${expectedVersion}.`);
    }
    if (names.has(item.name) || locations.has(item.location)) {
      throw new Error('Release package names and locations must be unique.');
    }
    names.add(item.name);
    locations.add(item.location);
  }
  return [...packages].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function workspaceCatalogExport(value: unknown): () => Promise<unknown> {
  const module = record(value);
  const exported = module['listWorkspacePackages'];
  if (typeof exported !== 'function') {
    throw new Error('Native API does not export listWorkspacePackages().');
  }
  return exported as () => Promise<unknown>;
}
