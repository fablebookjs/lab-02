import { isRecord } from '../validation.ts';
import { validateMaterializedVersion } from '../version/materialize.ts';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const SETUP_NODE_AUTH_PLACEHOLDER = 'XXXXX-XXXXX-XXXXX-XXXXX';

/**
 * Fails when ambient npm credentials could bypass trusted OIDC publication.
 * setup-node's inert placeholder is the sole accepted token-shaped value.
 */
export function assertOidcPublishEnvironment({
  nodeAuthToken,
  npmToken,
}: {
  nodeAuthToken: string | undefined;
  npmToken: string | undefined;
}): void {
  if (
    npmToken ||
    (nodeAuthToken && nodeAuthToken !== SETUP_NODE_AUTH_PLACEHOLDER)
  ) {
    throw new Error('Package publication must use npm OIDC, not an ambient npm token.');
  }
}

const packageVersion = (
  document: unknown,
  name: string,
  version: string,
): Record<string, unknown> | null => {
  if (document === null) return null;
  if (
    !isRecord(document) ||
    document['name'] !== name ||
    !isRecord(document['versions'])
  ) {
    throw new Error(`npm returned contradictory metadata for ${name}.`);
  }
  const published = document['versions'][version] ?? null;
  if (
    published !== null &&
    (!isRecord(published) ||
      published['name'] !== name ||
      published['version'] !== version)
  ) {
    throw new Error(`npm returned contradictory metadata for ${name}@${version}.`);
  }
  return published;
};

/**
 * Observes one exact package version's integrity from untrusted npm metadata.
 * Missing versions return null; contradictory documents are unsafe and throw.
 */
export function registryIntegrity({
  document,
  name,
  version,
}: {
  document: unknown;
  name: string;
  version: string;
}): string | null {
  validateMaterializedVersion(version);
  const published = packageVersion(document, name, version);
  if (published === null) return null;
  const dist = published['dist'];
  if (!isRecord(dist) || typeof dist['integrity'] !== 'string') {
    throw new Error(`${name}@${version} has no valid registry integrity.`);
  }
  return dist['integrity'];
}
