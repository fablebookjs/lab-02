// PROTOTYPE fixture for the agreed native v1 interface.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WorkspacePackage = Readonly<{
  location: string;
  name: string;
  version: string;
  private: boolean;
}>;

export async function listWorkspacePackages(): Promise<readonly WorkspacePackage[]> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const packagesRoot = join(root, 'packages');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages: WorkspacePackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(packagesRoot, entry.name);
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('Package manifest must be an object.');
    }
    const item = manifest as Record<string, unknown>;
    if (typeof item['name'] !== 'string' || typeof item['version'] !== 'string') {
      throw new Error('Package name and version are required.');
    }
    packages.push({
      location: relative(root, directory).split(sep).join('/'),
      name: item['name'],
      private: item['private'] === true,
      version: item['version'],
    });
  }
  return packages.sort((left, right) =>
    left.location < right.location ? -1 : left.location > right.location ? 1 : 0,
  );
}
