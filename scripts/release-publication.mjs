import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { listPublicPackages } from './list-public-packages.mjs';
import {
  deriveReleaseAuthority,
  exactPublication,
  lineChannel,
  NPM_REGISTRY,
  PILOT_REPOSITORY,
  promotionDisposition,
  publicationDisposition,
} from './release-publication-core.mjs';
import { parseStableVersion } from './release-proposal-core.mjs';
import {
  getGitCommit,
  getPullRequest,
  getRef,
  getReleaseByTag,
  githubRequest,
} from './release-proposal-github.mjs';

const execute = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACKAGE_PREFIX = '@fablebook/lab-02-';

const run = async (command, args, options = {}) => {
  try {
    return await execute(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${output ? `\n${output}` : ''}`, {
      cause: error,
    });
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const parseOptions = (values) => {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument list: ${values.join(' ')}`);
    }
    options[name.slice(2)] = value;
  }
  return options;
};

const requireOption = (options, name) => {
  if (!options[name]) {
    throw new Error(`Missing required option --${name}`);
  }
  return options[name];
};

const validateOid = (oid, label) => {
  if (!/^[0-9a-f]{40}$/.test(oid ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
};

const ensureTrustedMain = () => {
  if (
    process.env.GITHUB_REPOSITORY !== PILOT_REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error('Publication authority is restricted to trusted main in the pilot repository.');
  }
};

const gitHead = async (root) =>
  (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

const validateSnapshot = async (root, expectedOid) => {
  validateOid(expectedOid, 'Expected snapshot');
  if ((await gitHead(root)) !== expectedOid) {
    throw new Error('The checked-out snapshot does not match release authority.');
  }
};

const validatePackageSet = async (root, version) => {
  parseStableVersion(version);
  const rootManifest = await readJson(join(root, 'package.json'));
  const packages = await listPublicPackages(root);
  if (rootManifest.version !== version || packages.length === 0) {
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
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, dependencyVersion] of Object.entries(pkg.manifest[field] ?? {})) {
        if (publicNames.has(name) && dependencyVersion !== version) {
          throw new Error(`${pkg.name} has a non-lockstep dependency on ${name}.`);
        }
      }
    }
  }
  return packages;
};

const compareAuthority = (actual, expected) => {
  for (const field of [
    'channel',
    'line',
    'proposalOid',
    'pullRequest',
    'snapshotOid',
    'sourceOid',
    'version',
  ]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Release authority changed at ${field}.`);
    }
  }
};

const readLiveAuthority = async (token, pullRequest) => {
  const pull = await getPullRequest(token, pullRequest);
  const [headCommit, mergeCommit] = await Promise.all([
    getGitCommit(token, pull.head.sha),
    getGitCommit(token, pull.merge_commit_sha),
  ]);
  return deriveReleaseAuthority({ headCommit, mergeCommit, pull });
};

const canonicalReleasePull = (pull) => {
  const line = pull?.base?.ref?.replace(/^releases\//, '');
  return (
    line &&
    pull.base.ref === `releases/${line}` &&
    pull.head?.ref === `staged/${line}` &&
    pull.base.repo?.full_name === PILOT_REPOSITORY &&
    pull.head.repo?.full_name === PILOT_REPOSITORY
  );
};

async function resolvePublication(options) {
  ensureTrustedMain();
  const signal = await readJson(resolve(requireOption(options, 'signal')));
  const output = resolve(requireOption(options, 'output'));
  const githubOutput = resolve(requireOption(options, 'github-output'));
  if (!Number.isSafeInteger(signal.pullRequest) || signal.pullRequest <= 0) {
    throw new Error('Release signal does not contain one positive pull request number.');
  }

  const token = process.env.GH_TOKEN;
  const pull = await getPullRequest(token, signal.pullRequest);
  if (!canonicalReleasePull(pull) || pull.merged_at === null) {
    await appendFile(githubOutput, 'publish=false\n', 'utf8');
    console.log(`Pull request ${signal.pullRequest} does not authorize publication.`);
    return;
  }

  const authority = await readLiveAuthority(token, signal.pullRequest);
  await mkdir(output, { recursive: true });
  await writeJson(join(output, 'authority.json'), {
    ...authority,
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  await appendFile(
    githubOutput,
    `publish=true\nsnapshot=${authority.snapshotOid}\nversion=${authority.version}\n`,
    'utf8'
  );
  console.log(`Resolved ${authority.version} at ${authority.snapshotOid}.`);
}

const integrityFor = async (path) => {
  const hash = createHash('sha512');
  hash.update(await readFile(path));
  return `sha512-${hash.digest('base64')}`;
};

const validateManifest = (manifest) => {
  if (
    manifest.schema !== 1 ||
    manifest.repository !== PILOT_REPOSITORY ||
    manifest.channel !== lineChannel(manifest.line) ||
    !Number.isSafeInteger(manifest.pullRequest) ||
    manifest.pullRequest <= 0 ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length === 0
  ) {
    throw new Error('Publication manifest is outside the accepted pilot schema.');
  }
  parseStableVersion(manifest.version);
  for (const field of ['proposalOid', 'snapshotOid', 'sourceOid']) {
    validateOid(manifest[field], `Manifest ${field}`);
  }
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

const comparePackageSet = (manifest, packages) => {
  assert.deepEqual(
    manifest.packages.map(({ location, name }) => ({ location, name })),
    packages.map(({ location, name }) => ({ location, name }))
  );
};

async function preparePublication(options) {
  const authorityDocument = await readJson(resolve(requireOption(options, 'authority')));
  const snapshot = resolve(requireOption(options, 'snapshot'));
  const output = resolve(requireOption(options, 'output'));
  if (authorityDocument.schema !== 1 || authorityDocument.repository !== PILOT_REPOSITORY) {
    throw new Error('Release authority document is outside the pilot schema.');
  }
  const authority = { ...authorityDocument };
  delete authority.repository;
  delete authority.schema;
  await validateSnapshot(snapshot, authority.snapshotOid);
  const packages = await validatePackageSet(snapshot, authority.version);
  const tarballs = join(output, 'tarballs');
  await mkdir(tarballs, { recursive: true });

  const packedPackages = [];
  for (const pkg of packages) {
    const { stdout } = await run(
      npm,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs, pkg.directory],
      { cwd: snapshot }
    );
    const packResult = JSON.parse(stdout);
    const packed = Array.isArray(packResult) ? packResult[0] : packResult[pkg.name];
    const files = new Set(packed?.files?.map(({ path }) => path));
    if (
      packed?.name !== pkg.name ||
      packed.version !== authority.version ||
      basename(packed.filename ?? '') !== packed.filename ||
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
    schema: 1,
  });
  await writeJson(join(output, 'publication.json'), manifest);
  console.log(`Prepared ${manifest.packages.length} packages for ${manifest.version}.`);
}

const registryDocument = async (name) => {
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
  return response.json();
};

const waitFor = async (observe, attempts = 6) => {
  let error;
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
  throw error;
};

const loadPublication = async (options) => {
  const manifest = validateManifest(
    await readJson(resolve(requireOption(options, 'manifest')))
  );
  const snapshot = resolve(requireOption(options, 'snapshot'));
  await validateSnapshot(snapshot, manifest.snapshotOid);
  const packages = await validatePackageSet(snapshot, manifest.version);
  comparePackageSet(manifest, packages);
  return { manifest, packages, snapshot };
};

const verifyTarballs = async (manifest, tarballs) => {
  for (const pkg of manifest.packages) {
    if ((await integrityFor(join(tarballs, pkg.filename))) !== pkg.integrity) {
      throw new Error(`Transferred tarball integrity failed for ${pkg.name}.`);
    }
  }
};

const observePublication = async (manifest, pkg) => {
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

const observeExactPublication = async (manifest, pkg) =>
  exactPublication({
    document: await registryDocument(pkg.name),
    integrity: pkg.integrity,
    name: pkg.name,
    version: manifest.version,
  });

async function publishPackages(options) {
  ensureTrustedMain();
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
    throw new Error('Stable publication must use npm OIDC, not an ambient npm token.');
  }
  const { manifest } = await loadPublication(options);
  const tarballs = resolve(requireOption(options, 'tarballs'));
  await verifyTarballs(manifest, tarballs);
  const githubToken = process.env.GH_TOKEN;
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

const readAnnotatedTag = async (token, tag) => {
  const ref = await getRef(token, `tags/${tag}`);
  if (ref === null) {
    return null;
  }
  if (ref.type !== 'tag') {
    throw new Error(`${tag} exists but is not an annotated tag.`);
  }
  return githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags/${ref.oid}`, { token });
};

const assertTagTarget = (tagObject, tag, snapshotOid) => {
  if (
    tagObject.tag !== tag ||
    tagObject.object?.type !== 'commit' ||
    tagObject.object.sha !== snapshotOid
  ) {
    throw new Error(`${tag} does not identify the authorized release snapshot.`);
  }
};

const ensureAnnotatedTag = async (token, manifest) => {
  const tag = `v${manifest.version}`;
  let tagObject = await readAnnotatedTag(token, tag);
  if (tagObject === null) {
    tagObject = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags`, {
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
    });
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/refs`, {
      body: { ref: `refs/tags/${tag}`, sha: tagObject.sha },
      method: 'POST',
      token,
    });
    tagObject = await readAnnotatedTag(token, tag);
  }
  assertTagTarget(tagObject, tag, manifest.snapshotOid);
  return tag;
};

const ensureGitHubRelease = async (token, manifest, tag) => {
  let release = await getReleaseByTag(token, tag);
  if (release === null) {
    release = await githubRequest(`/repos/${PILOT_REPOSITORY}/releases`, {
      body: {
        body: `Published the complete ${manifest.version} package set on ${manifest.channel}.`,
        draft: false,
        name: tag,
        prerelease: false,
        tag_name: tag,
        target_commitish: manifest.snapshotOid,
      },
      method: 'POST',
      token,
    });
  }
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error(`GitHub Release ${tag} contradicts the completed stable release.`);
  }
};

const releaseCompletionState = async (token, manifest) => {
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
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error(`GitHub Release ${tag} contradicts the completed stable release.`);
  }
  return true;
};

async function finalizeRelease(options) {
  ensureTrustedMain();
  const { manifest } = await loadPublication(options);
  const token = process.env.GH_TOKEN;
  compareAuthority(await readLiveAuthority(token, manifest.pullRequest), manifest);
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
  await ensureGitHubRelease(token, manifest, tag);
  await githubRequest(`/repos/${PILOT_REPOSITORY}/dispatches`, {
    body: { event_type: 'release-completed' },
    method: 'POST',
    token,
  });
  console.log(`Completed ${tag} and notified release-proposal maintenance.`);
}

const validateCompletedRelease = async (token, version) => {
  const tag = `v${version}`;
  const tagObject = await readAnnotatedTag(token, tag);
  if (tagObject === null) {
    throw new Error(`Completed release tag ${tag} does not exist.`);
  }
  validateOid(tagObject.object?.sha, `Completed release ${tag} target`);
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

async function resolvePromotion(options) {
  ensureTrustedMain();
  const version = requireOption(options, 'version');
  parseStableVersion(version);
  const snapshotOid = await validateCompletedRelease(process.env.GH_TOKEN, version);
  await appendFile(
    resolve(requireOption(options, 'github-output')),
    `snapshot=${snapshotOid}\n`,
    'utf8'
  );
  console.log(`Resolved completed v${version} at ${snapshotOid}.`);
}

const observePromotion = async (version, pkg) => {
  const document = await registryDocument(pkg.name);
  return promotionDisposition({ document, name: pkg.name, version });
};

async function promoteLatest(options) {
  ensureTrustedMain();
  const version = requireOption(options, 'version');
  parseStableVersion(version);
  if (!process.env.NODE_AUTH_TOKEN) {
    throw new Error('Promotion requires the package-scoped npm promotion credential.');
  }
  const token = process.env.GH_TOKEN;
  const snapshotOid = await validateCompletedRelease(token, version);
  const snapshot = resolve(requireOption(options, 'snapshot'));
  await validateSnapshot(snapshot, snapshotOid);
  const packages = await validatePackageSet(snapshot, version);

  const plan = [];
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

const [command, ...argumentValues] = process.argv.slice(2);
const options = parseOptions(argumentValues);

switch (command) {
  case 'resolve':
    await resolvePublication(options);
    break;
  case 'prepare':
    await preparePublication(options);
    break;
  case 'publish':
    await publishPackages(options);
    break;
  case 'finalize':
    await finalizeRelease(options);
    break;
  case 'resolve-promotion':
    await resolvePromotion(options);
    break;
  case 'promote':
    await promoteLatest(options);
    break;
  default:
    throw new Error(
      'Usage: release-publication.mjs <resolve|prepare|publish|finalize|resolve-promotion|promote> [options]'
    );
}
