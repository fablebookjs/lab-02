import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { NPM_REGISTRY } from '../../shared/package-publication/core.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { loadReleasePackageSet } from '../../shared/package-publication/package-set.ts';
import type { PublicationPackage } from '../../shared/package-publication/publication.ts';
import { run } from '../../shared/process/run.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { githubRequest } from '../release-repository/transport.ts';
import { createGitRef, getRef } from '../release-repository/refs.ts';
import {
  getReleaseByTag,
  validatedReleaseResponse,
} from '../release-repository/github.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export type AnnotatedTag = Readonly<{
  object: {
    sha: string;
    type: 'commit';
  };
  sha: string;
  tag: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const validateOid = (oid: unknown, label: string): string => {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return oid;
};

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

const waitFor = async <Value>(
  observe: () => Promise<Value>,
  attempts = 6,
): Promise<Value> => {
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await observe();
    } catch (nextError) {
      error = nextError;
      if (attempt + 1 < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
    }
  }
  throw error instanceof Error ? error : new Error('Observation did not converge.');
};

const annotatedTagValue = (value: unknown): AnnotatedTag => {
  if (!isRecord(value) || !isRecord(value['object'])) {
    throw new Error('GitHub annotated tag response must be an object.');
  }
  const type = value['object']['type'];
  if (type !== 'commit') {
    throw new Error('GitHub annotated tag must target a commit.');
  }
  return {
    object: {
      sha: validateOid(value['object']['sha'], 'Annotated tag target'),
      type,
    },
    sha: validateOid(value['sha'], 'Annotated tag object'),
    tag: stringValue(value['tag'], 'Annotated tag name'),
  };
};

export const readAnnotatedTag = async (
  token: string,
  tag: string,
): Promise<AnnotatedTag | null> => {
  const ref = await getRef(token, `tags/${tag}`);
  if (ref === null) return null;
  if (ref.type !== 'tag') {
    throw new Error(`${tag} exists but is not an annotated tag.`);
  }
  return annotatedTagValue(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags/${ref.oid}`, { token }),
  );
};

export const assertTagTarget = (
  tagObject: AnnotatedTag,
  tag: string,
  snapshotOid: string,
): void => {
  if (
    tagObject.tag !== tag ||
    tagObject.object.type !== 'commit' ||
    tagObject.object.sha !== snapshotOid
  ) {
    throw new Error(`${tag} does not identify the authorized release snapshot.`);
  }
};

export const ensureAnnotatedTag = async (
  token: string,
  manifest: Readonly<{ snapshotOid: string; version: string }>,
): Promise<string> => {
  const tag = `v${manifest.version}`;
  let tagObject = await readAnnotatedTag(token, tag);
  if (tagObject === null) {
    tagObject = annotatedTagValue(
      await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags`, {
        body: {
          message: `Release ${tag}`,
          object: manifest.snapshotOid,
          tag,
          tagger: {
            date: new Date().toISOString(),
            email: 'release-app@users.noreply.github.com',
            name: 'fablebook-release-app[bot]',
          },
          type: 'commit',
        },
        method: 'POST',
        token,
      }),
    );
    await createGitRef(token, `refs/tags/${tag}`, tagObject.sha);
    tagObject = await waitFor(async () => {
      const observed = await readAnnotatedTag(token, tag);
      if (observed === null) throw new Error(`${tag} is not visible yet.`);
      return observed;
    });
  }
  assertTagTarget(tagObject, tag, manifest.snapshotOid);
  return tag;
};

export const ensureGitHubRelease = async (
  token: string,
  manifest: Readonly<{ snapshotOid: string }>,
  tag: string,
  body: string,
  prerelease = false,
): Promise<void> => {
  let release = await getReleaseByTag(token, tag);
  if (release === null) {
    release = validatedReleaseResponse(
      await githubRequest(`/repos/${PILOT_REPOSITORY}/releases`, {
        body: {
          body,
          draft: false,
          name: tag,
          prerelease,
          tag_name: tag,
          target_commitish: manifest.snapshotOid,
        },
        method: 'POST',
        token,
      }),
    );
    if (release.body !== body) {
      throw new Error(`GitHub did not preserve the composed ${tag} release body.`);
    }
  }
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== prerelease ||
    release.body !== body
  ) {
    throw new Error(`GitHub Release ${tag} contradicts the completed release.`);
  }
};
