import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  derivePrereleaseAuthority,
  derivePrereleaseCommunication,
  PRERELEASE_CHANNEL,
  registryNextVersion,
} from '../../shared/prerelease-publication/core.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import {
  reconcileNextPackageSet,
  validatePrereleasePublicationManifest,
} from '../../shared/prerelease-publication/manifest-schema.ts';
import type {
  PrereleasePublicationManifest,
} from '../../shared/prerelease-publication/manifest-schema.ts';
import {
  assertOidcPublishEnvironment,
  NPM_REGISTRY,
  registryIntegrity,
} from '../../shared/package-publication/core.ts';
import {
  reconcilePublicationPlan,
} from '../../shared/package-publication/publication.ts';
import type {
  PublicationPackage,
} from '../../shared/package-publication/publication.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import {
  isPrereleaseAuthorityKind,
} from '../publication-routing/core.ts';
import type {
  PublicationAuthorityKind,
  PublicationResolution,
} from '../publication-routing/core.ts';
import { run } from '../../shared/process/run.ts';
import { requireControllerGitHubToken } from '../controller-inputs.ts';
import {
  packPublicationPackageSet,
  observeGitHubReleaseCompletion,
  readRegistryDocument,
  validatePublicationSnapshot,
} from '../package-publication/mechanics.ts';
import type {
  AuthenticatedPublicationArtifactOptions,
  PublicationArtifactOptions,
} from '../package-publication/mechanics.ts';
import {
  ensureAnnotatedTag,
  ensureGitHubRelease,
} from '../release-repository/releases.ts';
import { getGitCommit } from '../release-repository/commits.ts';
import {
  getPullRequest,
  isCanonicalPrereleasePull,
} from '../release-repository/pull-requests.ts';
import { parsePrereleaseAuthorityDocument } from './authority-schema.ts';
import type { PrereleaseAuthorityDocument } from './authority-schema.ts';
import { renderPrereleaseGitHubReleaseBody } from './templates.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be one positive integer.`);
  }
  return value;
};

const prereleaseAuthorityKind = (value: unknown): Exclude<
  PublicationAuthorityKind,
  'stable-pr'
> => {
  if (!isPrereleaseAuthorityKind(value)) {
    throw new Error(`Unsupported prerelease authority kind: ${String(value)}`);
  }
  return value;
};

const authorityDocumentKind = (
  authority: PrereleaseAuthorityDocument,
): Exclude<PublicationAuthorityKind, 'stable-pr'> => {
  if ('cutLine' in authority) return 'release-cut-bootstrap';
  if ('phase' in authority) return 'phase-entry';
  return 'ordinary-prerelease-pr';
};

const validateAuthorityKind = (
  authority: PrereleaseAuthorityDocument,
  expected: Exclude<PublicationAuthorityKind, 'stable-pr'>,
): void => {
  const actual = authorityDocumentKind(authority);
  if (actual !== expected) {
    throw new Error(
      `Prerelease authority document is ${actual}, not routed ${expected}.`,
    );
  }
};

const readLivePrerelease = async (
  token: string,
  pullRequest: number,
): Promise<PrereleaseAuthorityDocument> => {
  const pull = await getPullRequest(token, pullRequest);
  const mergeCommitOid = pull.merge_commit_sha;
  if (mergeCommitOid === null) {
    throw new Error('Merged Prerelease PR has no merge commit OID.');
  }
  const [headCommit, mergeCommit] = await Promise.all([
    getGitCommit(token, pull.head.sha),
    getGitCommit(token, mergeCommitOid),
  ]);
  const authority = derivePrereleaseAuthority({
    headCommit,
    mergeCommit,
    pull: { ...pull, body: pull.body },
  });
  return {
    ...authority,
    changes: derivePrereleaseCommunication({
      authority,
      body: pull.body,
    }),
  };
};

const ensureTrustedMain = (): void => {
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== `refs/heads/${PRIMARY_BRANCH}`
  ) {
    throw new Error(
      'Prerelease publication authority is restricted to trusted main.',
    );
  }
};

/**
 * Converts a merged canonical Prerelease PR signal into sealed ordinary
 * authority. Non-authorizing PRs return the visible publish-false result.
 */
export async function resolvePrereleasePublication(
  options: {
    'authority-kind': string;
    'github-token': string;
    output: string;
    signal: string;
  },
): Promise<PublicationResolution> {
  ensureTrustedMain();
  const authorityKind = prereleaseAuthorityKind(
    requireOption(options, 'authority-kind'),
  );
  if (authorityKind !== 'ordinary-prerelease-pr') {
    throw new Error(
      `Ordinary prerelease resolver cannot consume ${authorityKind}.`,
    );
  }
  const signal = await readJsonFile(resolve(requireOption(options, 'signal')));
  if (!isRecord(signal)) {
    throw new Error(
      'Prerelease signal does not contain one pull request number.',
    );
  }
  const pullRequest = positiveInteger(
    signal['pullRequest'],
    'Prerelease signal pull request',
  );
  const token = requireControllerGitHubToken(options);
  const pull = await getPullRequest(token, pullRequest);
  if (!isCanonicalPrereleasePull(pull) || pull.merged_at === null) {
    console.log(
      `Pull request ${pullRequest} does not authorize prerelease publication.`,
    );
    return { publish: false };
  }

  const authority = await readLivePrerelease(token, pullRequest);
  validateAuthorityKind(authority, authorityKind);
  const output = resolve(requireOption(options, 'output'));
  await mkdir(output, { recursive: true });
  await writeJsonFile(join(output, 'authority.json'), {
    ...authority,
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  console.log(
    `Resolved prerelease ${authority.version} at ${authority.snapshotOid}.`,
  );
  return {
    publish: true,
    snapshot: authority.snapshotOid,
    version: authority.version,
  };
}

/** Validates cut or phase-entry authority already emitted by its trusted writer job. */
export async function inspectPrereleaseAuthority(
  options: { 'authority-kind': string; authority: string },
): Promise<{
  publish: true;
  snapshot: string;
  version: string;
}> {
  ensureTrustedMain();
  const authorityKind = prereleaseAuthorityKind(
    requireOption(options, 'authority-kind'),
  );
  const authority = parsePrereleaseAuthorityDocument(
    await readJsonFile(resolve(requireOption(options, 'authority'))),
  );
  validateAuthorityKind(authority, authorityKind);
  console.log(
    `Accepted prerelease ${authority.version} authority at ${authority.snapshotOid}.`,
  );
  return {
    publish: true,
    snapshot: authority.snapshotOid,
    version: authority.version,
  };
}

/** Packs and seals the authorized prerelease snapshot for later privileged jobs. */
export async function preparePrereleasePublication(
  options: { authority: string; output: string; snapshot: string },
): Promise<void> {
  const authority = parsePrereleaseAuthorityDocument(
    await readJsonFile(resolve(requireOption(options, 'authority'))),
  );
  const snapshot = resolve(requireOption(options, 'snapshot'));
  const output = resolve(requireOption(options, 'output'));
  await validatePublicationSnapshot(snapshot, authority.snapshotOid);
  const packed = await packPublicationPackageSet(
    snapshot,
    output,
    authority.version,
  );
  const { changes, ...releaseAuthority } = authority;
  const releaseBody = renderPrereleaseGitHubReleaseBody({
    changes,
    version: authority.version,
  });
  const manifest = await validatePrereleasePublicationManifest(
    {
      ...releaseAuthority,
      packages: packed.packages,
      releaseBody,
      repository: PILOT_REPOSITORY,
      schema: 1,
    },
    packed.tarballs,
    {
      repository: PILOT_REPOSITORY,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    },
  );
  await writeJsonFile(join(output, 'publication.json'), manifest);
  console.log(
    `Prepared ${manifest.packages.length} packages for ${manifest.version}.`,
  );
}

const loadManifest = async (
  options: PublicationArtifactOptions,
): Promise<PrereleasePublicationManifest> =>
  validatePrereleasePublicationManifest(
    await readJsonFile(resolve(requireOption(options, 'manifest'))),
    resolve(requireOption(options, 'tarballs')),
    {
      repository: PILOT_REPOSITORY,
      snapshotOid: requireOption(options, 'expected-snapshot'),
      version: requireOption(options, 'expected-version'),
    },
  );

/** Publishes or verifies every sealed package through OIDC-only reconciliation. */
export async function publishPrereleasePackages(
  options: PublicationArtifactOptions,
): Promise<void> {
  ensureTrustedMain();
  assertOidcPublishEnvironment({
    nodeAuthToken: process.env['NODE_AUTH_TOKEN'],
    npmToken: process.env['NPM_TOKEN'],
  });
  const manifest = await loadManifest(options);
  const tarballs = resolve(requireOption(options, 'tarballs'));
  await reconcilePublicationPlan(manifest, {
    observeIntegrity: async (pkg: PublicationPackage, version: string) =>
      registryIntegrity({
        document: await readRegistryDocument(pkg.name),
        name: pkg.name,
        version,
      }),
    publish: async (pkg: PublicationPackage, channel: string) => {
      await run(npm, [
        'publish',
        join(tarballs, pkg.filename),
        '--access',
        'public',
        '--ignore-scripts',
        '--registry',
        NPM_REGISTRY,
        '--tag',
        channel,
      ]);
    },
    wait: (milliseconds: number) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  });
  console.log(
    `Published the complete ${manifest.version} package set on next.`,
  );
}

/** Uses the package-scoped credential to reconcile and read back the sealed `next` set. */
export async function reconcilePrereleaseNext(
  options: PublicationArtifactOptions,
): Promise<void> {
  ensureTrustedMain();
  if (!process.env['NODE_AUTH_TOKEN']) {
    throw new Error(
      'Prerelease next reconciliation requires its package-scoped npm credential.',
    );
  }
  const manifest = await loadManifest(options);
  await reconcileNextPackageSet(manifest, {
    addNext: async (name, version) => {
      await run(npm, [
        'dist-tag',
        'add',
        `${name}@${version}`,
        PRERELEASE_CHANNEL,
        '--registry',
        NPM_REGISTRY,
      ]);
    },
    observeNext: async (name) =>
      registryNextVersion({
        document: await readRegistryDocument(name),
        name,
      }),
    wait: (milliseconds) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  });
  console.log(
    `Verified the complete ${manifest.version} package set on next.`,
  );
}

const prereleaseCompletionState = async (
  token: string,
  manifest: PrereleasePublicationManifest,
): Promise<boolean> => {
  const tag = `v${manifest.version}`;
  const observation = await observeGitHubReleaseCompletion(token, {
    body: manifest.releaseBody,
    prerelease: true,
    snapshotOid: manifest.snapshotOid,
    tag,
  });
  if (observation.kind === 'contradiction') {
    if (observation.reason === 'release-without-tag') {
      throw new Error(`GitHub prerelease ${tag} exists without its tag.`);
    }
    throw new Error(`GitHub prerelease ${tag} contradicts its snapshot.`);
  }
  return observation.kind === 'complete';
};

/**
 * Observes package integrity, `next`, annotated tag, and GitHub Release state.
 * Incomplete state is a visible result; contradictory state throws.
 */
export async function checkPrereleaseCompletion(
  options: AuthenticatedPublicationArtifactOptions,
): Promise<{ complete: boolean }> {
  ensureTrustedMain();
  const manifest = await loadManifest(options);
  const token = requireControllerGitHubToken(options);
  for (const pkg of manifest.packages) {
    const document = await readRegistryDocument(pkg.name);
    const publishedIntegrity = registryIntegrity({
      document,
      name: pkg.name,
      version: manifest.version,
    });
    if (publishedIntegrity === null) {
      console.log(
        `Prerelease ${manifest.version} is incomplete: ${pkg.name} is unpublished.`,
      );
      return { complete: false };
    }
    if (publishedIntegrity !== pkg.integrity) {
      throw new Error(
        `${pkg.name}@${manifest.version} exists with unexpected integrity.`,
      );
    }
    if (
      registryNextVersion({
        document,
        name: pkg.name,
      }) !== manifest.version
    ) {
      console.log(
        `Prerelease ${manifest.version} is incomplete: npm next is not reconciled.`,
      );
      return { complete: false };
    }
  }
  const complete = await prereleaseCompletionState(token, manifest);
  console.log(
    complete
      ? `Skipped prerelease publication: ${manifest.version} is already complete.`
      : `Prerelease ${manifest.version} still requires GitHub finalization.`,
  );
  return { complete };
}

/** Query-first creates or verifies the exact annotated tag and GitHub prerelease. */
export async function finalizePrerelease(
  options: AuthenticatedPublicationArtifactOptions,
): Promise<void> {
  ensureTrustedMain();
  const manifest = await loadManifest(options);
  const token = requireControllerGitHubToken(options);
  const tag = `v${manifest.version}`;
  if (!(await prereleaseCompletionState(token, manifest))) {
    await ensureAnnotatedTag(token, manifest);
  }
  await ensureGitHubRelease(
    token,
    manifest,
    tag,
    manifest.releaseBody,
    true,
  );
  console.log(`Completed GitHub prerelease ${tag}.`);
}
