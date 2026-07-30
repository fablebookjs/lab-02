import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listWorkspacePackages as discoverWorkspacePackages } from '../../shared/workspace/packages.ts';

export type WorkspacePackage = Readonly<{
  location: string;
  name: string;
  version: string;
  private: boolean;
}>;

export async function listWorkspacePackages(): Promise<readonly WorkspacePackage[]> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const packages = await discoverWorkspacePackages(repositoryRoot);
  return packages.map(({ location, name, private: isPrivate, version }) => ({
    location,
    name,
    version,
    private: isPrivate,
  }));
}
