import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  derivePrereleaseAuthority,
  derivePrereleaseCommunication,
  PRERELEASE_CHANNEL,
  registryNextVersion,
  validatePrereleaseCommunication,
} from '../../shared/prerelease-publication/core.ts';
import {
  PILOT_REPOSITORY,
  PRIMARY_BRANCH,
} from '../../shared/repository.ts';
import type {
  PrereleaseAuthority,
  PrereleaseAuthorityBase,
} from '../../shared/prerelease-publication/core.ts';
import {
  parseManualPrereleasePhase,
} from '../../shared/prerelease-phase-entry/core.ts';
import {
  reconcileNextPackageSet,
  validatePrereleasePublicationManifest,
} from '../../shared/prerelease-publication/publication.ts';
import type {
  PrereleasePublicationManifest,
} from '../../shared/prerelease-publication/publication.ts';
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
import {
  parseDevelopmentVersion,
  parseReleaseLine,
} from '../../shared/release-proposal/core.ts';
import {
  isPrereleaseAuthorityKind,
} from '../../shared/publication-routing/core.ts';
import type {
  PublicationAuthorityKind,
} from '../../shared/publication-routing/core.ts';
import { run } from '../../shared/process/run.ts';
import {
  readJson,
  requireGithubToken,
  requireOption,
  writeJson,
} from '../controller-support.ts';
import {
  ensureAnnotatedTag,
  ensureGitHubRelease,
  observeGitHubReleaseCompletion,
  packPublicationPackageSet,
  readRegistryDocument,
  validatePublicationSnapshot,
} from '../package-publication/mechanics.ts';
import {
  getGitCommit,
  getPullRequest,
  isCanonicalPrereleasePull,
} from '../release-repository/github.ts';
import { renderPrereleaseGitHubReleaseBody } from './templates.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

type PrereleaseAuthorityDocument = PrereleaseAuthority & {
  changes: ReturnType<typeof derivePrereleaseCommunication>;
};

export type ResolvePrereleasePublicationOptions = {
  'authority-kind': string;
  'github-token': string;
  output: string;
  signal: string;
};

export type PrereleasePublicationResolution =
  | { publish: false }
  | {
      publish: true;
      snapshot: string;
      version: string;
    };

export type PreparePrereleasePublicationOptions = {
  authority: string;
  output: string;
  snapshot: string;
};

export type InspectPrereleaseAuthorityOptions = {
  'authority-kind': string;
  authority: string;
};

export type PublishPrereleasePackagesOptions = {
  'expected-snapshot': string;
  'expected-version': string;
  manifest: string;
  tarballs: string;
};

export type ReconcilePrereleaseNextOptions =
  PublishPrereleasePackagesOptions;

export type FinalizePrereleaseOptions = PublishPrereleasePackagesOptions & {
  'github-token': string;
};

export type CheckPrereleaseCompletionOptions =
  PublishPrereleasePackagesOptions & {
    'github-token': string;
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be one positive integer.`);
  }
  return value;
};

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
};

const authorityValue = (input: unknown): PrereleaseAuthorityDocument => {
  if (
    !isRecord(input) ||
    input['schema'] !== 1 ||
    input['repository'] !== PILOT_REPOSITORY ||
    input['channel'] !== PRERELEASE_CHANNEL ||
    !Array.isArray(input['changes'])
  ) {
    throw new Error(
      'Prerelease authority document is outside the accepted schema.',
    );
  }
  const version = stringValue(input['version'], 'Prerelease authority version');
  const parsedVersion = parseDevelopmentVersion(version);
  const common: PrereleaseAuthorityBase = {
    boundaryOid: oidValue(
      input['boundaryOid'],
      'Prerelease authority boundary',
    ),
    channel: PRERELEASE_CHANNEL,
    snapshotOid: oidValue(
      input['snapshotOid'],
      'Prerelease authority snapshot',
    ),
    sourceOid: oidValue(
      input['sourceOid'],
      'Prerelease authority source',
    ),
    version,
  };
  let authority: PrereleaseAuthority;
  if (input['cutLine'] !== undefined) {
    const cutLine = stringValue(
      input['cutLine'],
      'Prerelease bootstrap cut line',
    );
    parseReleaseLine(cutLine);
    if (
      common.boundaryOid !== common.snapshotOid ||
      parsedVersion.prerelease !== 'alpha' ||
      parsedVersion.prereleaseNumber !== 0
    ) {
      throw new Error(
        'Prerelease bootstrap authority does not identify its alpha.0 boundary.',
      );
    }
    authority = { ...common, cutLine };
  } else if (input['phase'] !== undefined) {
    const phase = parseManualPrereleasePhase(
      stringValue(input['phase'], 'Prerelease authority phase'),
    );
    if (
      parsedVersion.prerelease !== phase ||
      parsedVersion.prereleaseNumber !== 0
    ) {
      throw new Error(
        'Phase-entry authority does not identify its target .0 version.',
      );
    }
    authority = { ...common, phase };
  } else {
    authority = {
      ...common,
      proposalOid: oidValue(
        input['proposalOid'],
        'Prerelease authority proposal',
      ),
      pullRequest: positiveInteger(
        input['pullRequest'],
        'Prerelease authority pull request',
      ),
    };
  }
  const changes = validatePrereleaseCommunication(input['changes']);
  if ('cutLine' in authority && changes.length !== 0) {
    throw new Error(
      'Prerelease bootstrap authority cannot carry prior-line changes.',
    );
  }
  return {
    ...authority,
    changes,
  };
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

export async function resolvePrereleasePublication(
  options: ResolvePrereleasePublicationOptions,
): Promise<PrereleasePublicationResolution> {
  ensureTrustedMain();
  const authorityKind = prereleaseAuthorityKind(
    requireOption(options, 'authority-kind'),
  );
  if (authorityKind !== 'ordinary-prerelease-pr') {
    throw new Error(
      `Ordinary prerelease resolver cannot consume ${authorityKind}.`,
    );
  }
  const signal = await readJson(resolve(requireOption(options, 'signal')));
  if (!isRecord(signal)) {
    throw new Error(
      'Prerelease signal does not contain one pull request number.',
    );
  }
  const pullRequest = positiveInteger(
    signal['pullRequest'],
    'Prerelease signal pull request',
  );
  const token = requireGithubToken(options);
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
  await writeJson(join(output, 'authority.json'), {
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

export async function inspectPrereleaseAuthority(
  options: InspectPrereleaseAuthorityOptions,
): Promise<{
  publish: true;
  snapshot: string;
  version: string;
}> {
  ensureTrustedMain();
  const authorityKind = prereleaseAuthorityKind(
    requireOption(options, 'authority-kind'),
  );
  const authority = authorityValue(
    await readJson(resolve(requireOption(options, 'authority'))),
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

export async function preparePrereleasePublication(
  options: PreparePrereleasePublicationOptions,
): Promise<void> {
  const authority = authorityValue(
    await readJson(resolve(requireOption(options, 'authority'))),
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
  await writeJson(join(output, 'publication.json'), manifest);
  console.log(
    `Prepared ${manifest.packages.length} packages for ${manifest.version}.`,
  );
}

const loadManifest = async (
  options: PublishPrereleasePackagesOptions,
): Promise<PrereleasePublicationManifest> =>
  validatePrereleasePublicationManifest(
    await readJson(resolve(requireOption(options, 'manifest'))),
    resolve(requireOption(options, 'tarballs')),
    {
      repository: PILOT_REPOSITORY,
      snapshotOid: requireOption(options, 'expected-snapshot'),
      version: requireOption(options, 'expected-version'),
    },
  );

export async function publishPrereleasePackages(
  options: PublishPrereleasePackagesOptions,
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

export async function reconcilePrereleaseNext(
  options: ReconcilePrereleaseNextOptions,
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
 * Observes whether an authorized prerelease is already complete across npm,
 * `next`, its annotated tag, and its GitHub prerelease.
 *
 * @remarks
 * Incomplete state is a normal `{ complete: false }` result. The preflight does
 * not mutate state, allowing a complete phase-entry retry to skip every
 * privileged job.
 *
 * @throws
 * Published integrity or GitHub state contradicts the sealed manifest.
 */
export async function checkPrereleaseCompletion(
  options: CheckPrereleaseCompletionOptions,
): Promise<{ complete: boolean }> {
  ensureTrustedMain();
  const manifest = await loadManifest(options);
  const token = requireGithubToken(options);
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

/**
 * Reconciles the exact annotated tag and GitHub prerelease for a sealed
 * prerelease publication manifest.
 *
 * @remarks
 * The operation is safe to retry and does not reconcile npm packages or the
 * mutable `next` channel; those are separate publication phases.
 */
export async function finalizePrerelease(
  options: FinalizePrereleaseOptions,
): Promise<void> {
  ensureTrustedMain();
  const manifest = await loadManifest(options);
  const token = requireGithubToken(options);
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
