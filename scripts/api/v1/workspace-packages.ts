import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listWorkspacePackages as discoverWorkspacePackages } from '../../shared/workspace/packages.ts';

/**
 * Stable catalog entry exposed to release tooling that loads an exact tag.
 * Locations are repository-relative POSIX paths and include private workspaces
 * so callers can derive the public set without rediscovering the workspace.
 */
export type WorkspacePackage = Readonly<{
  location: string;
  name: string;
  version: string;
  private: boolean;
}>;

/**
 * Projects the tagged repository's validated workspace catalog in stable
 * location order. This v1 contract must remain loadable without installing the
 * tagged snapshot's dependencies.
 */
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
