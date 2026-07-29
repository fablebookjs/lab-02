import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  listPublicPackages,
  type PublicPackage,
} from '../../shared/workspace/packages.ts';
import {
  assertOidcPublishEnvironment,
  composeGitHubReleaseBody,
  deriveReleaseAuthority,
  deriveReleaseCommunication,
  exactPublication,
  lineChannel,
  NPM_REGISTRY,
  PILOT_REPOSITORY,
  promotionDisposition,
  publicationDisposition,
  validateReleaseCommunication,
} from '../../shared/release-publication/core.ts';
import type {
  ReleaseAuthority,
  ReleaseCommunication,
} from '../../shared/release-publication/core.ts';
import {
  loadMigrationRecords,
  releaseRecordPath,
} from '../../shared/release-communication/records.ts';
import { parseStableVersion } from '../../shared/release-proposal/core.ts';
import {
  getGitCommit,
  getPullRequest,
  getRef,
  getReleaseByTag,
  githubRequest,
  isCanonicalReleasePull,
  validatedGitCommitResponse,
  validatedReleaseResponse,
} from '../release-proposal/github.ts';
import type { GitHubRelease, GitPullRequest } from '../release-proposal/github.ts';
import {
  readJson,
  requireGithubToken,
  requireOption,
  run,
  writeJson,
} from '../controller-support.ts';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACKAGE_PREFIX = '@fablebook/lab-02-';

type PublicationPackage = {
  filename: string;
  integrity: string;
  location: string;
  name: string;
};

type PublicationManifest = ReleaseAuthority & {
  packages: PublicationPackage[];
  releaseCommunication: ReleaseCommunication;
  repository: typeof PILOT_REPOSITORY;
  schema: 2;
};

type ReleaseAuthorityDocument = ReleaseAuthority & {
  releaseCommunication: ReleaseCommunication;
};

type AnnotatedTag = {
  object: {
    sha: string;
    type: 'commit';
  };
  sha: string;
  tag: string;
};

export type ResolvePublicationOptions = {
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
  'github-token': string;
  manifest: string;
  snapshot: string;
  tarballs: string;
};

export type FinalizeReleaseOptions = {
  'github-token': string;
  manifest: string;
  snapshot: string;
};

export type ResolvePromotionOptions = {
  'github-token': string;
  version: string;
};

export type PromotionResolution = {
  snapshot: string;
};

export type PromoteLatestOptions = {
  'github-token': string;
  snapshot: string;
  version: string;
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

const gitHead = async (root: string): Promise<string> =>
  (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

const validateSnapshot = async (root: string, expectedOid: string): Promise<void> => {
  validateOid(expectedOid, 'Expected snapshot');
  if ((await gitHead(root)) !== expectedOid) {
    throw new Error('The checked-out snapshot does not match release authority.');
  }
};

const validatePackageSet = async (
  root: string,
  version: string,
): Promise<PublicPackage[]> => {
  parseStableVersion(version);
  const rootManifest = await readJson(join(root, 'package.json'));
  const packages = await listPublicPackages(root);
  if (!isRecord(rootManifest) || rootManifest['version'] !== version || packages.length === 0) {
    throw new Error(`The snapshot is not a complete ${version} package set.`);
  }
  const publicNames = new Set(packages.map(({ name }) => name));
  for (const pkg of packages) {
    if (pkg.version !== version) {
      throw new Error(`${pkg.name} does not use release version ${version}.`);
    }
    if (
      pkg.manifest.repository?.url !== 'git+https://github.com/fablebookjs/lab-02.git' ||
      pkg.manifest.repository?.directory !== pkg.location
    ) {
      throw new Error(`${pkg.name} does not identify the pilot repository and workspace path.`);
    }
    const dependencyFields: Array<
      'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
    > = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ];
    for (const field of dependencyFields) {
      const dependencies = pkg.manifest[field];
      if (dependencies !== undefined && !isRecord(dependencies)) {
        throw new Error(`${pkg.name} has malformed ${field}.`);
      }
      for (const [name, dependencyVersion] of Object.entries(dependencies ?? {})) {
        if (publicNames.has(name) && dependencyVersion !== version) {
          throw new Error(`${pkg.name} has a non-lockstep dependency on ${name}.`);
        }
      }
    }
  }
  return packages;
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

const compareAuthority = (
  actual: ReleaseAuthority,
  expected: ReleaseAuthority,
): void => {
  const fields: Array<keyof ReleaseAuthority> = [
    'channel',
    'line',
    'proposalOid',
    'pullRequest',
    'snapshotOid',
    'sourceOid',
    'version',
  ];
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Release authority changed at ${field}.`);
    }
  }
};

const readLiveAuthority = async (
  token: string,
  pullRequest: number,
): Promise<ReleaseAuthority> => {
  const pull = await getPullRequest(token, pullRequest);
  const mergeCommitOid = pull.merge_commit_sha;
  if (mergeCommitOid === null) {
    throw new Error('Merged release pull request has no merge commit OID.');
  }
  const [headCommit, mergeCommit] = await Promise.all([
    getGitCommit(token, pull.head.sha),
    getGitCommit(token, mergeCommitOid),
  ]);
  return deriveReleaseAuthority({ headCommit, mergeCommit, pull });
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

const integrityFor = async (path: string): Promise<string> => {
  const hash = createHash('sha512');
  hash.update(await readFile(path));
  return `sha512-${hash.digest('base64')}`;
};

const publicationPackageValue = (value: unknown): PublicationPackage => {
  if (!isRecord(value)) {
    throw new Error('Publication package entry must be an object.');
  }
  return {
    filename: stringValue(value['filename'], 'Publication package filename'),
    integrity: stringValue(value['integrity'], 'Publication package integrity'),
    location: stringValue(value['location'], 'Publication package location'),
    name: stringValue(value['name'], 'Publication package name'),
  };
};

const validateManifest = (input: unknown): PublicationManifest => {
  if (
    !isRecord(input) ||
    input['schema'] !== 2 ||
    input['repository'] !== PILOT_REPOSITORY ||
    !Array.isArray(input['packages']) ||
    input['packages'].length === 0
  ) {
    throw new Error('Publication manifest is outside the accepted pilot schema.');
  }
  const authority = authorityValue(input, 'Publication manifest');
  const manifest: PublicationManifest = {
    ...authority,
    packages: input['packages'].map(publicationPackageValue),
    releaseCommunication: validateReleaseCommunication(
      input['releaseCommunication'],
      authority.version,
    ),
    repository: PILOT_REPOSITORY,
    schema: 2,
  };
  const names = new Set();
  const filenames = new Set();
  const locations = new Set();
  for (const pkg of manifest.packages) {
    if (
      typeof pkg.name !== 'string' ||
      !pkg.name.startsWith(PACKAGE_PREFIX) ||
      !/^packages\/[a-z0-9-]+$/.test(pkg.location ?? '') ||
      basename(pkg.filename ?? '') !== pkg.filename ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pkg.integrity ?? '') ||
      names.has(pkg.name) ||
      filenames.has(pkg.filename) ||
      locations.has(pkg.location)
    ) {
      throw new Error('Publication manifest contains an invalid package entry.');
    }
    names.add(pkg.name);
    filenames.add(pkg.filename);
    locations.add(pkg.location);
  }
  return manifest;
};

const comparePackageSet = (
  manifest: PublicationManifest,
  packages: PublicPackage[],
): void => {
  assert.deepEqual(
    manifest.packages.map(({ location, name }) => ({ location, name })),
    packages.map(({ location, name }) => ({ location, name }))
  );
};

export async function preparePublication(
  options: PreparePublicationOptions,
): Promise<void> {
  const authority = authorityDocumentValue(
    await readJson(resolve(requireOption(options, 'authority'))),
  );
  const snapshot = resolve(requireOption(options, 'snapshot'));
  const output = resolve(requireOption(options, 'output'));
  await validateSnapshot(snapshot, authority.snapshotOid);
  const packages = await validatePackageSet(snapshot, authority.version);
  const tarballs = join(output, 'tarballs');
  await mkdir(tarballs, { recursive: true });

  const packedPackages: Array<{
    filename: string;
    integrity: string;
    location: string;
    name: string;
  }> = [];
  for (const pkg of packages) {
    const { stdout } = await run(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs, pkg.directory],
      { cwd: snapshot }
    );
    const packResult: unknown = JSON.parse(stdout);
    const packedValue =
      Array.isArray(packResult)
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
      packed.version !== authority.version ||
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
      location: pkg.location,
      name: pkg.name,
    });
  }

  const manifest = validateManifest({
    ...authority,
    packages: packedPackages,
    repository: PILOT_REPOSITORY,
    schema: 2,
  });
  await writeJson(join(output, 'publication.json'), manifest);
  console.log(`Prepared ${manifest.packages.length} packages for ${manifest.version}.`);
}

const registryDocument = async (name: string): Promise<unknown> => {
  const url = new URL(encodeURIComponent(name), NPM_REGISTRY);
  url.searchParams.set('fablebook_read', `${Date.now()}-${Math.random()}`);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (response.status === 404) {
    return null;
  }
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

const loadPublication = async (
  options: { manifest: string; snapshot: string },
): Promise<{
  manifest: PublicationManifest;
  packages: PublicPackage[];
  snapshot: string;
}> => {
  const manifest = validateManifest(
    await readJson(resolve(requireOption(options, 'manifest')))
  );
  const snapshot = resolve(requireOption(options, 'snapshot'));
  await validateSnapshot(snapshot, manifest.snapshotOid);
  const packages = await validatePackageSet(snapshot, manifest.version);
  comparePackageSet(manifest, packages);
  return { manifest, packages, snapshot };
};

const verifyTarballs = async (
  manifest: PublicationManifest,
  tarballs: string,
): Promise<void> => {
  for (const pkg of manifest.packages) {
    if ((await integrityFor(join(tarballs, pkg.filename))) !== pkg.integrity) {
      throw new Error(`Transferred tarball integrity failed for ${pkg.name}.`);
    }
  }
};

const observePublication = async (
  manifest: PublicationManifest,
  pkg: PublicationPackage,
): Promise<{ disposition: 'publish' | 'skip'; document: unknown }> => {
  const document = await registryDocument(pkg.name);
  const disposition = publicationDisposition({
    channel: manifest.channel,
    document,
    integrity: pkg.integrity,
    name: pkg.name,
    version: manifest.version,
  });
  return { disposition, document };
};

const observeExactPublication = async (
  manifest: PublicationManifest,
  pkg: PublicationPackage,
): Promise<boolean> =>
  exactPublication({
    document: await registryDocument(pkg.name),
    integrity: pkg.integrity,
    name: pkg.name,
    version: manifest.version,
  });

export async function publishPackages(options: PublishPackagesOptions): Promise<void> {
  ensureTrustedMain();
  assertOidcPublishEnvironment({
    nodeAuthToken: process.env['NODE_AUTH_TOKEN'],
    npmToken: process.env['NPM_TOKEN'],
  });
  const { manifest } = await loadPublication(options);
  const tarballs = resolve(requireOption(options, 'tarballs'));
  await verifyTarballs(manifest, tarballs);
  const githubToken = requireGithubToken(options);
  compareAuthority(await readLiveAuthority(githubToken, manifest.pullRequest), manifest);
  if (await releaseCompletionState(githubToken, manifest)) {
    for (const pkg of manifest.packages) {
      if (!(await observeExactPublication(manifest, pkg))) {
        throw new Error(`Completed release is missing ${pkg.name}@${manifest.version}.`);
      }
    }
    console.log(`Verified already completed v${manifest.version}.`);
    return;
  }

  for (const pkg of manifest.packages) {
    const observed = await observePublication(manifest, pkg);
    if (observed.disposition === 'skip') {
      console.log(`Verified existing ${pkg.name}@${manifest.version}.`);
      continue;
    }
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
        manifest.channel,
      ],
      { cwd: tarballs }
    );
    await waitFor(async () => {
      const next = await observePublication(manifest, pkg);
      if (next.disposition !== 'skip') {
        throw new Error(`${pkg.name}@${manifest.version} is not visible yet.`);
      }
      return next;
    });
    console.log(`Published ${pkg.name}@${manifest.version} on ${manifest.channel}.`);
  }

  for (const pkg of manifest.packages) {
    const observed = await observePublication(manifest, pkg);
    if (observed.disposition !== 'skip') {
      throw new Error(`${pkg.name}@${manifest.version} did not complete publication.`);
    }
  }
  console.log(`Verified the complete ${manifest.version} package set on ${manifest.channel}.`);
}

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

const readAnnotatedTag = async (
  token: string,
  tag: string,
): Promise<AnnotatedTag | null> => {
  const ref = await getRef(token, `tags/${tag}`);
  if (ref === null) {
    return null;
  }
  if (ref.type !== 'tag') {
    throw new Error(`${tag} exists but is not an annotated tag.`);
  }
  return annotatedTagValue(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags/${ref.oid}`, { token }),
  );
};

const assertTagTarget = (
  tagObject: AnnotatedTag,
  tag: string,
  snapshotOid: string,
): void => {
  if (
    tagObject.tag !== tag ||
    tagObject.object?.type !== 'commit' ||
    tagObject.object.sha !== snapshotOid
  ) {
    throw new Error(`${tag} does not identify the authorized release snapshot.`);
  }
};

const ensureAnnotatedTag = async (
  token: string,
  manifest: PublicationManifest,
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
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/refs`, {
      body: { ref: `refs/tags/${tag}`, sha: tagObject.sha },
      method: 'POST',
      token,
    });
    tagObject = await waitFor(async () => {
      const observed = await readAnnotatedTag(token, tag);
      if (observed === null) {
        throw new Error(`${tag} is not visible yet.`);
      }
      return observed;
    });
  }
  assertTagTarget(tagObject, tag, manifest.snapshotOid);
  return tag;
};

const ensureGitHubRelease = async (
  token: string,
  manifest: PublicationManifest,
  tag: string,
  body: string,
): Promise<void> => {
  let release = await getReleaseByTag(token, tag);
  if (release === null) {
    release = validatedReleaseResponse(
      await githubRequest(`/repos/${PILOT_REPOSITORY}/releases`, {
        body: {
          body,
          draft: false,
          name: tag,
          prerelease: false,
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
    release.prerelease !== false
  ) {
    throw new Error(`GitHub Release ${tag} contradicts the completed stable release.`);
  }
};

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
  const { manifest, snapshot } = await loadPublication(options);
  const token = requireGithubToken(options);
  compareAuthority(await readLiveAuthority(token, manifest.pullRequest), manifest);
  const releaseRecord = await readFile(
    join(snapshot, releaseRecordPath(manifest.version)),
    'utf8'
  );
  const migrationRecords = await loadMigrationRecords(snapshot, manifest.line);
  const releaseBody = composeGitHubReleaseBody({
    communication: manifest.releaseCommunication,
    migrationRecords,
    releaseRecord,
    version: manifest.version,
  });
  if (await releaseCompletionState(token, manifest)) {
    for (const pkg of manifest.packages) {
      if (!(await observeExactPublication(manifest, pkg))) {
        throw new Error(`Completed release is missing ${pkg.name}@${manifest.version}.`);
      }
    }
    await githubRequest(`/repos/${PILOT_REPOSITORY}/dispatches`, {
      body: { event_type: 'release-completed' },
      method: 'POST',
      token,
    });
    console.log(`Verified already completed v${manifest.version}.`);
    return;
  }
  for (const pkg of manifest.packages) {
    const observed = await observePublication(manifest, pkg);
    if (observed.disposition !== 'skip') {
      throw new Error(`Cannot finalize incomplete package ${pkg.name}@${manifest.version}.`);
    }
  }
  const tag = await ensureAnnotatedTag(token, manifest);
  await ensureGitHubRelease(token, manifest, tag, releaseBody);
  await githubRequest(`/repos/${PILOT_REPOSITORY}/dispatches`, {
    body: { event_type: 'release-completed' },
    method: 'POST',
    token,
  });
  console.log(`Completed ${tag} and notified release-proposal maintenance.`);
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

const observePromotion = async (
  version: string,
  pkg: PublicPackage,
): Promise<'skip' | 'update'> => {
  const document = await registryDocument(pkg.name);
  return promotionDisposition({ document, name: pkg.name, version });
};

export async function promoteLatest(options: PromoteLatestOptions): Promise<void> {
  ensureTrustedMain();
  const version = requireOption(options, 'version');
  parseStableVersion(version);
  if (!process.env['NODE_AUTH_TOKEN']) {
    throw new Error('Promotion requires the package-scoped npm promotion credential.');
  }
  const token = requireGithubToken(options);
  const snapshotOid = await validateCompletedRelease(token, version);
  const snapshot = resolve(requireOption(options, 'snapshot'));
  await validateSnapshot(snapshot, snapshotOid);
  const packages = await validatePackageSet(snapshot, version);

  const plan: Array<{
    disposition: 'skip' | 'update';
    pkg: PublicPackage;
  }> = [];
  for (const pkg of packages) {
    plan.push({ disposition: await observePromotion(version, pkg), pkg });
  }

  for (const { disposition, pkg } of plan) {
    if (disposition === 'skip') {
      console.log(`Verified existing ${pkg.name}@${version} latest tag.`);
      continue;
    }
    await run(
      npm,
      ['dist-tag', 'add', `${pkg.name}@${version}`, 'latest', '--registry', NPM_REGISTRY],
      { cwd: snapshot }
    );
    await waitFor(async () => {
      if ((await observePromotion(version, pkg)) !== 'skip') {
        throw new Error(`${pkg.name} latest is not visible at ${version} yet.`);
      }
    });
    console.log(`Moved ${pkg.name} latest to ${version}.`);
  }

  for (const pkg of packages) {
    if ((await observePromotion(version, pkg)) !== 'skip') {
      throw new Error(`${pkg.name} latest did not converge to ${version}.`);
    }
  }
  console.log(`Promoted the complete ${version} package set to latest.`);
}
