import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { NPM_REGISTRY } from '../../shared/package-publication/core.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { loadReleasePackageSet } from '../../shared/package-publication/package-set.ts';
import type { PublicationPackage } from '../../shared/package-publication/publication.ts';
import { run } from '../../shared/process/run.ts';
import { isRecord, stringValue } from '../../shared/validation.ts';
import {
  assertTagTarget,
  getReleaseByTag,
  readAnnotatedTag,
} from '../release-repository/releases.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export type PublicationArtifactOptions = {
  'expected-snapshot': string;
  'expected-version': string;
  manifest: string;
  tarballs: string;
};

export type AuthenticatedPublicationArtifactOptions =
  PublicationArtifactOptions & {
    'github-token': string;
  };

type GitHubReleaseObservation =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'incomplete' }>
  | Readonly<{
      kind: 'contradiction';
      reason: 'release-mismatch' | 'release-without-tag';
    }>;

const validateOid = (oid: unknown, label: string): string => {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return oid;
};

/** Proves the credentialless checkout is the exact authority-bound snapshot. */
export const validatePublicationSnapshot = async (
  root: string,
  expectedOid: string,
): Promise<void> => {
  validateOid(expectedOid, 'Expected snapshot');
  if ((await resolveHeadOid(root)) !== expectedOid) {
    throw new Error('The checked-out snapshot does not match release authority.');
  }
};

const integrityFor = async (path: string): Promise<string> => {
  const hash = createHash('sha512');
  hash.update(await readFile(path));
  return `sha512-${hash.digest('base64')}`;
};

/**
 * Packs the complete snapshot-derived public package set without lifecycle
 * scripts, verifies expected dist contents and npm-reported integrity, and
 * returns stable artifact identities for sealing.
 */
export async function packPublicationPackageSet(
  snapshot: string,
  output: string,
  version: string,
): Promise<{
  packages: PublicationPackage[];
  tarballs: string;
}> {
  const packages = await loadReleasePackageSet(snapshot, version);
  const tarballs = join(output, 'tarballs');
  await mkdir(tarballs, { recursive: true });

  const packedPackages: PublicationPackage[] = [];
  for (const pkg of packages) {
    const { stdout } = await run(
      npm,
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        tarballs,
        join(snapshot, pkg.location),
      ],
      { cwd: snapshot },
    );
    const packResult: unknown = JSON.parse(stdout);
    const packedValue = Array.isArray(packResult)
      ? packResult[0]
      : isRecord(packResult)
        ? packResult[pkg.name]
        : undefined;
    if (!isRecord(packedValue) || !Array.isArray(packedValue['files'])) {
      throw new Error(`npm pack produced no artifact for ${pkg.name}.`);
    }
    const files = new Set<string>(
      packedValue['files'].map((file) => {
        if (!isRecord(file)) throw new Error('npm pack file entry must be an object.');
        return stringValue(file['path'], 'npm pack file path');
      }),
    );
    const packed = {
      filename: stringValue(packedValue['filename'], 'npm pack filename'),
      integrity: stringValue(packedValue['integrity'], 'npm pack integrity'),
      name: stringValue(packedValue['name'], 'npm pack name'),
      version: stringValue(packedValue['version'], 'npm pack version'),
    };
    if (
      packed.name !== pkg.name ||
      packed.version !== version ||
      basename(packed.filename) !== packed.filename ||
      !files.has('dist/index.js') ||
      !files.has('dist/index.d.ts') ||
      [...files].some((path) => path.startsWith('src/'))
    ) {
      throw new Error(`npm pack produced an invalid artifact for ${pkg.name}.`);
    }
    const tarball = join(tarballs, packed.filename);
    const integrity = await integrityFor(tarball);
    if (integrity !== packed.integrity) {
      throw new Error(`npm pack integrity did not match ${pkg.name}.`);
    }
    packedPackages.push({
      filename: packed.filename,
      integrity,
      name: pkg.name,
    });
  }
  return { packages: packedPackages, tarballs };
}

/** Reads uncached, untrusted npm metadata; an unpublished package returns null. */
export const readRegistryDocument = async (name: string): Promise<unknown> => {
  const url = new URL(encodeURIComponent(name), NPM_REGISTRY);
  url.searchParams.set('fablebook_read', `${Date.now()}-${Math.random()}`);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry read failed for ${name}: HTTP ${response.status}.`);
  }
  const value: unknown = await response.json();
  return value;
};

/**
 * Observes the shared stable/prerelease completion invariant. Missing tag and
 * Release is incomplete; a Release without its annotated tag or mismatched
 * visible state is contradictory.
 */
export async function observeGitHubReleaseCompletion(
  token: string,
  expected: Readonly<{
    body?: string;
    prerelease: boolean;
    snapshotOid: string;
    tag: string;
  }>,
): Promise<GitHubReleaseObservation> {
  const tagObject = await readAnnotatedTag(token, expected.tag);
  const release = await getReleaseByTag(token, expected.tag);

  if (tagObject === null) {
    return release === null
      ? { kind: 'incomplete' }
      : { kind: 'contradiction', reason: 'release-without-tag' };
  }

  assertTagTarget(tagObject, expected.tag, expected.snapshotOid);
  if (release === null) return { kind: 'incomplete' };

  if (
    release.tag_name !== expected.tag ||
    release.draft !== false ||
    release.prerelease !== expected.prerelease ||
    (expected.body !== undefined && release.body !== expected.body)
  ) {
    return { kind: 'contradiction', reason: 'release-mismatch' };
  }

  return { kind: 'complete' };
}
