import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  assertOidcPublishEnvironment,
  NPM_REGISTRY,
  registryIntegrity,
} from '../../shared/package-publication/core.ts';
import {
  composeGitHubReleaseBody,
  deriveReleaseAuthority,
  deriveReleaseCommunication,
  lineChannel,
  PILOT_REPOSITORY,
  validateReleaseCommunication,
} from '../../shared/release-publication/core.ts';
import type {
  ReleaseAuthority,
  ReleaseCommunication,
} from '../../shared/release-publication/core.ts';
import {
  reconcilePublicationPlan,
} from '../../shared/package-publication/publication.ts';
import {
  type PublicationManifest,
  validatePublicationManifest,
} from '../../shared/release-publication/publication.ts';
import {
  loadMigrationRecords,
  releaseRecordPath,
} from '../../shared/release-communication/records.ts';
import { parseStableVersion } from '../../shared/release-proposal/core.ts';
import { run } from '../../shared/process/run.ts';
import {
  getGitCommit,
  getPullRequest,
  getReleaseByTag,
  githubRequest,
  isCanonicalReleasePull,
} from '../release-repository/github.ts';
import {
  readJson,
  requireGithubToken,
  requireOption,
  writeJson,
} from '../controller-support.ts';
import {
  assertTagTarget,
  ensureAnnotatedTag,
  ensureGitHubRelease,
  packPublicationPackageSet,
  readAnnotatedTag,
  readRegistryDocument,
  validatePublicationSnapshot,
} from '../package-publication/mechanics.ts';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

type ReleaseAuthorityDocument = ReleaseAuthority & {
  releaseCommunication: ReleaseCommunication;
};

export type ResolvePublicationOptions = {
  'authority-kind': string;
  'github-token': string;
  output: string;
  signal: string;
};

export type PublicationResolution =
  | { publish: false }
  | {
      publish: true;
      snapshot: string;
      version: string;
    };

export type PreparePublicationOptions = {
  authority: string;
  output: string;
  snapshot: string;
};

export type PublishPackagesOptions = {
  'expected-snapshot': string;
  'expected-version': string;
  manifest: string;
  tarballs: string;
};

export type FinalizeReleaseOptions = {
  'expected-snapshot': string;
  'expected-version': string;
  'github-token': string;
  manifest: string;
  tarballs: string;
};

export type ResolvePromotionOptions = {
  'github-token': string;
  version: string;
};

export type PromotionResolution = {
  snapshot: string;
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
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const validateOid = (oid: unknown, label: string): string => {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return oid;
};

const ensureTrustedMain = (): void => {
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== 'refs/heads/main'
  ) {
    throw new Error('Publication authority is restricted to trusted main in the pilot repository.');
  }
};

const authorityValue = (
  input: Record<string, unknown>,
  label: string,
): ReleaseAuthority => {
  const line = stringValue(input['line'], `${label} line`);
  const version = stringValue(input['version'], `${label} version`);
  parseStableVersion(version);
  const channel = stringValue(input['channel'], `${label} channel`);
  if (channel !== lineChannel(line)) {
    throw new Error(`${label} channel does not match its release line.`);
  }
  return {
    channel,
    line,
    proposalOid: validateOid(input['proposalOid'], `${label} proposal`),
    pullRequest: positiveInteger(input['pullRequest'], `${label} pull request`),
    snapshotOid: validateOid(input['snapshotOid'], `${label} snapshot`),
    sourceOid: validateOid(input['sourceOid'], `${label} source`),
    version,
  };
};

const authorityDocumentValue = (input: unknown): ReleaseAuthorityDocument => {
  if (
    !isRecord(input) ||
    input['schema'] !== 2 ||
    input['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Release authority document is outside the pilot schema.');
  }
  const authority = authorityValue(input, 'Release authority');
  return {
    ...authority,
    releaseCommunication: validateReleaseCommunication(
      input['releaseCommunication'],
      authority.version,
    ),
  };
};

const readLiveRelease = async (
  token: string,
  pullRequest: number,
): Promise<{
  authority: ReleaseAuthority;
  releaseCommunication: ReleaseCommunication;
}> => {
  const pull = await getPullRequest(token, pullRequest);
  const mergeCommitOid = pull.merge_commit_sha;
  if (mergeCommitOid === null) {
    throw new Error('Merged release pull request has no merge commit OID.');
  }
  const [headCommit, mergeCommit] = await Promise.all([
    getGitCommit(token, pull.head.sha),
    getGitCommit(token, mergeCommitOid),
  ]);
  const authority = deriveReleaseAuthority({ headCommit, mergeCommit, pull });
  return {
    authority,
    releaseCommunication: deriveReleaseCommunication({
      authority,
      body: pull.body,
    }),
  };
};

export async function resolvePublication(
  options: ResolvePublicationOptions,
): Promise<PublicationResolution> {
  ensureTrustedMain();
  const authorityKind = requireOption(options, 'authority-kind');
  if (authorityKind !== 'stable-pr') {
    throw new Error(
      `Stable publication resolver cannot consume ${authorityKind}.`,
    );
  }
  const signal = await readJson(resolve(requireOption(options, 'signal')));
  const output = resolve(requireOption(options, 'output'));
  if (!isRecord(signal)) {
    throw new Error('Release signal does not contain one positive pull request number.');
  }
  const pullRequest = positiveInteger(signal['pullRequest'], 'Release signal pull request');

  const token = requireGithubToken(options);
  const pull = await getPullRequest(token, pullRequest);
  if (!isCanonicalReleasePull(pull) || pull.merged_at === null) {
    const outputs: PublicationResolution = { publish: false };
    console.log(`Pull request ${pullRequest} does not authorize publication.`);
    return outputs;
  }

  const { authority, releaseCommunication } = await readLiveRelease(token, pullRequest);
  await mkdir(output, { recursive: true });
  await writeJson(join(output, 'authority.json'), {
    ...authority,
    releaseCommunication,
    repository: PILOT_REPOSITORY,
    schema: 2,
  });
  const outputs: PublicationResolution = {
    publish: true,
    snapshot: authority.snapshotOid,
    version: authority.version,
  };
  console.log(`Resolved ${authority.version} at ${authority.snapshotOid}.`);
  return outputs;
}

export async function preparePublication(
  options: PreparePublicationOptions,
): Promise<void> {
  const authority = authorityDocumentValue(
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

  const releaseRecord = await readFile(
    join(snapshot, releaseRecordPath(authority.version)),
    'utf8'
  );
  const migrationRecords = await loadMigrationRecords(snapshot, authority.line);
  const { releaseCommunication, ...releaseAuthority } = authority;
  const releaseBody = composeGitHubReleaseBody({
    communication: releaseCommunication,
    migrationRecords,
    releaseRecord,
    version: authority.version,
  });
  const manifest = await validatePublicationManifest(
    {
      ...releaseAuthority,
      packages: packed.packages,
      releaseBody,
      repository: PILOT_REPOSITORY,
      schema: 3,
    },
    packed.tarballs,
    {
      repository: PILOT_REPOSITORY,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    },
  );
  await writeJson(join(output, 'publication.json'), manifest);
  console.log(`Prepared ${manifest.packages.length} packages for ${manifest.version}.`);
}

const loadPublication = async (
  options: {
    'expected-snapshot': string;
    'expected-version': string;
    manifest: string;
    tarballs: string;
  },
): Promise<PublicationManifest> =>
  validatePublicationManifest(
    await readJson(resolve(requireOption(options, 'manifest'))),
    resolve(requireOption(options, 'tarballs')),
    {
      repository: PILOT_REPOSITORY,
      snapshotOid: requireOption(options, 'expected-snapshot'),
      version: requireOption(options, 'expected-version'),
    },
  );

export async function publishPackages(options: PublishPackagesOptions): Promise<void> {
  ensureTrustedMain();
  assertOidcPublishEnvironment({
    nodeAuthToken: process.env['NODE_AUTH_TOKEN'],
    npmToken: process.env['NPM_TOKEN'],
  });
  const manifest = await loadPublication(options);
  const tarballs = resolve(requireOption(options, 'tarballs'));
  await reconcilePublicationPlan(manifest, {
    observeIntegrity: async (pkg, version) =>
      registryIntegrity({
        document: await readRegistryDocument(pkg.name),
        name: pkg.name,
        version,
      }),
    publish: async (pkg, channel) => {
      await run(
        npm,
        [
          'publish',
          join(tarballs, pkg.filename),
          '--access',
          'public',
          '--ignore-scripts',
          '--registry',
          NPM_REGISTRY,
          '--tag',
          channel,
        ],
        { cwd: tarballs },
      );
    },
    wait: (milliseconds) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  });
  console.log(`Published the complete ${manifest.version} package set on ${manifest.channel}.`);
}

const releaseCompletionState = async (
  token: string,
  manifest: PublicationManifest,
): Promise<boolean> => {
  const tag = `v${manifest.version}`;
  const tagObject = await readAnnotatedTag(token, tag);
  const release = await getReleaseByTag(token, tag);
  if (tagObject === null) {
    if (release !== null) {
      throw new Error(`GitHub Release ${tag} exists without its annotated tag.`);
    }
    return false;
  }
  assertTagTarget(tagObject, tag, manifest.snapshotOid);
  if (release === null) {
    return false;
  }
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    throw new Error(`GitHub Release ${tag} contradicts the completed stable release.`);
  }
  return true;
};

export async function finalizeRelease(options: FinalizeReleaseOptions): Promise<void> {
  ensureTrustedMain();
  const manifest = await loadPublication(options);
  const token = requireGithubToken(options);
  if (await releaseCompletionState(token, manifest)) {
    await ensureGitHubRelease(
      token,
      manifest,
      `v${manifest.version}`,
      manifest.releaseBody,
    );
    console.log(`Verified already completed v${manifest.version}.`);
    return;
  }
  const tag = await ensureAnnotatedTag(token, manifest);
  await ensureGitHubRelease(token, manifest, tag, manifest.releaseBody);
  console.log(`Completed ${tag}.`);
}

const validateCompletedRelease = async (
  token: string,
  version: string,
): Promise<string> => {
  const tag = `v${version}`;
  const tagObject = await readAnnotatedTag(token, tag);
  if (tagObject === null) {
    throw new Error(`Completed release tag ${tag} does not exist.`);
  }
  validateOid(tagObject.object.sha, `Completed release ${tag} target`);
  assertTagTarget(tagObject, tag, tagObject.object.sha);
  const release = await getReleaseByTag(token, tag);
  if (
    release === null ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    throw new Error(`Completed GitHub Release ${tag} does not exist.`);
  }
  return tagObject.object.sha;
};

export async function resolvePromotion(
  options: ResolvePromotionOptions,
): Promise<PromotionResolution> {
  ensureTrustedMain();
  const version = requireOption(options, 'version');
  parseStableVersion(version);
  const snapshotOid = await validateCompletedRelease(requireGithubToken(options), version);
  const outputs: PromotionResolution = { snapshot: snapshotOid };
  console.log(`Resolved completed v${version} at ${snapshotOid}.`);
  return outputs;
}
