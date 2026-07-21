import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  compareReleaseLines,
  deriveCutVersions,
  developmentCommitMessage,
  parseProposalMessage,
  parseReleaseLine,
  parseStableVersion,
  planProposalMaintenance,
  proposalCommitMessage,
  refreshReleasePrBody,
  ZERO_OID,
} from './release-proposal-core.mjs';
import {
  closePullRequest,
  createDraftReleasePr,
  createRefUpdate,
  getGitCommit,
  getRef,
  getPullRequest,
  getReleaseByTag,
  getRepository,
  githubRequest,
  listMatchingRefs,
  listReleasePulls,
  PILOT_REPOSITORY,
  resolveRefObject,
  updatePullRequestBody,
  updateRefs,
} from './release-proposal-github.mjs';
import { repositoryRoot } from './list-public-packages.mjs';

const execute = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';
const IMPORT_PREFIX = 'refs/release-pilot/imported/';

const run = async (command, args, options = {}) => {
  try {
    return await execute(command, args, {
      cwd: options.cwd ?? repositoryRoot,
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

const git = (args, options) => run('git', args, options);
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

const ensureSeedRepository = async () => {
  const { stdout } = await git(['rev-parse', '--show-toplevel']);
  if (resolve(stdout.trim()) !== resolve(repositoryRoot)) {
    throw new Error(
      'Release proposal commands must run after the Lab-02 seed becomes the root of its own Git repository.'
    );
  }
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim()) {
    throw new Error('Release proposal preparation requires a clean working tree.');
  }
};

const commitParents = async (oid) => {
  const { stdout } = await git(['show', '-s', '--format=%P', oid]);
  return stdout.trim().split(/\s+/).filter(Boolean);
};

const commitMessage = async (oid) => {
  const { stdout } = await git(['show', '-s', '--format=%B', oid]);
  return stdout.trimEnd();
};

const manifestAt = async (oid, path) => {
  const { stdout } = await git(['show', `${oid}:${path}`]);
  return JSON.parse(stdout);
};

const publicPackagesAt = async (oid) => {
  const root = await manifestAt(oid, 'package.json');
  if (JSON.stringify(root.workspaces) !== JSON.stringify(['packages/*'])) {
    throw new Error('The release controller supports only the accepted packages/* seed workspace.');
  }
  const { stdout } = await git(['ls-tree', '-d', '--name-only', `${oid}:packages`]);
  const packages = [];
  for (const directory of stdout.trim().split('\n').filter(Boolean)) {
    const manifest = await manifestAt(oid, `packages/${directory}/package.json`);
    if (manifest.private !== true) {
      packages.push({ manifest, name: manifest.name });
    }
  }
  return { packages, root };
};

const validateVersionTree = async (oid, version) => {
  const { packages, root } = await publicPackagesAt(oid);
  if (root.version !== version || packages.length === 0) {
    throw new Error(`${oid} does not materialize root version ${version}.`);
  }
  const publicNames = new Set(packages.map(({ name }) => name));
  for (const pkg of packages) {
    if (pkg.manifest.version !== version) {
      throw new Error(`${pkg.name} does not materialize ${version}.`);
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
};

const validateProposalCommit = async (oid, expected) => {
  assert.deepEqual(await commitParents(oid), [expected.sourceOid]);
  const metadata = parseProposalMessage(await commitMessage(oid));
  assert.equal(metadata.line, expected.line);
  assert.equal(metadata.sourceOid, expected.sourceOid);
  assert.equal(metadata.version, expected.version);
  await validateVersionTree(oid, expected.version);
};

const validateDevelopmentCommit = async (oid, expected) => {
  assert.deepEqual(await commitParents(oid), [expected.sourceOid]);
  const message = await commitMessage(oid);
  assert.match(message, new RegExp(`^release: begin ${expected.version.replaceAll('.', '\\.')} development`));
  assert.match(message, new RegExp(`Release-Cut-Line: ${expected.line.replace('.', '\\.')}`));
  assert.match(message, new RegExp(`Release-Cut-Source: ${expected.sourceOid}`));
  assert.match(message, new RegExp(`Development-Version: ${expected.version.replaceAll('.', '\\.')}`));
  await validateVersionTree(oid, expected.version);
};

const validateFullOid = (oid, label) => {
  if (!/^[0-9a-f]{40}$/.test(oid ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
};

const uploadCommitObject = async (token, oid) => {
  const [sourceOid] = await commitParents(oid);
  validateFullOid(sourceOid, 'Uploaded commit parent');
  const changedPaths = (
    await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sourceOid, oid])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  if (changedPaths.length === 0) {
    throw new Error(`Prepared commit ${oid} has no tree changes.`);
  }

  const tree = [];
  for (const path of changedPaths) {
    const entry = (await git(['ls-tree', oid, '--', path])).stdout.trim();
    const match = /^(\d{6}) (blob) [0-9a-f]{40}\t(.+)$/.exec(entry);
    if (!match || match[3] !== path) {
      throw new Error(`Prepared commit has an unsupported tree entry: ${entry}`);
    }
    tree.push({
      content: (await git(['show', `${oid}:${path}`])).stdout,
      mode: match[1],
      path,
      type: match[2],
    });
  }

  const sourceTree = (await git(['show', '-s', '--format=%T', sourceOid])).stdout.trim();
  const expectedTree = (await git(['show', '-s', '--format=%T', oid])).stdout.trim();
  const remoteTree = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/trees`, {
    body: { base_tree: sourceTree, tree },
    method: 'POST',
    token,
  });
  if (remoteTree.sha !== expectedTree) {
    throw new Error(`GitHub created tree ${remoteTree.sha}, expected ${expectedTree}.`);
  }

  const identity = (
    await git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', oid])
  ).stdout.trimEnd().split('\0');
  if (identity.length !== 6 || identity.some((value) => value.length === 0)) {
    throw new Error(`Prepared commit ${oid} has incomplete author or committer metadata.`);
  }
  const message = await commitMessage(oid);
  const remoteCommit = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits`, {
    body: {
      author: { date: identity[2], email: identity[1], name: identity[0] },
      committer: { date: identity[5], email: identity[4], name: identity[3] },
      message,
      parents: [sourceOid],
      tree: remoteTree.sha,
    },
    method: 'POST',
    token,
  });
  validateFullOid(remoteCommit.sha, 'Uploaded GitHub commit');
  const sameIdentity = (remote, name, email, date) =>
    remote?.name === name &&
    remote.email === email &&
    Number.isFinite(Date.parse(remote.date)) &&
    Date.parse(remote.date) === Date.parse(date);
  if (
    remoteCommit.message !== message ||
    remoteCommit.tree?.sha !== expectedTree ||
    remoteCommit.parents?.length !== 1 ||
    remoteCommit.parents[0].sha !== sourceOid ||
    !sameIdentity(remoteCommit.author, identity[0], identity[1], identity[2]) ||
    !sameIdentity(remoteCommit.committer, identity[3], identity[4], identity[5])
  ) {
    throw new Error(`GitHub did not preserve the prepared commit ${oid}.`);
  }
  return remoteCommit.sha;
};

const validateCutTransition = async (transition) => {
  parseReleaseLine(transition.line);
  parseStableVersion(transition.releaseVersion);
  validateFullOid(transition.sourceOid, 'Cut source');
  validateFullOid(transition.proposalOid, 'Proposal');
  validateFullOid(transition.developmentOid, 'Development commit');
  const sourceManifest = await manifestAt(transition.sourceOid, 'package.json');
  const minor = deriveCutVersions(sourceManifest.version, 'minor');
  const major = deriveCutVersions(sourceManifest.version, 'major');
  const matches = [minor, major].some(
    (candidate) =>
      candidate.line === transition.line &&
      candidate.releaseVersion === transition.releaseVersion &&
      candidate.developmentVersion === transition.developmentVersion
  );
  if (!matches) {
    throw new Error('Cut versions are not a minor or major transition from their source.');
  }
};

const materializeCommit = async ({ message, sourceOid, version }) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-release-proposal-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, sourceOid]);
    added = true;
    await run(process.execPath, ['scripts/set-version.mjs', version], { cwd: worktree });
    await git(['add', 'package.json', 'package-lock.json', 'packages'], { cwd: worktree });

    const changed = (await git(['diff', '--cached', '--name-only'], { cwd: worktree })).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (
      changed.length === 0 ||
      changed.some(
        (path) => path !== 'package.json' && path !== 'package-lock.json' && !path.endsWith('/package.json')
      )
    ) {
      throw new Error(`Version materialization changed unexpected files: ${changed.join(', ')}`);
    }

    const identity = {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'release-app@users.noreply.github.com',
      GIT_AUTHOR_NAME: 'fablebook-release-app[bot]',
      GIT_COMMITTER_EMAIL: 'release-app@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'fablebook-release-app[bot]',
    };
    await git(['commit', '--no-gpg-sign', '-m', message], { cwd: worktree, env: identity });
    return (await git(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const writeBundle = async (path, refs) => {
  for (const { name, oid } of refs) {
    await git(['update-ref', name, oid, ZERO_OID]);
  }
  try {
    await git(['bundle', 'create', path, ...refs.map(({ name }) => name)]);
  } finally {
    await Promise.all(refs.map(({ name, oid }) => git(['update-ref', '-d', name, oid])));
  }
};

const importBundle = async (path) => {
  await git([
    'fetch',
    '--no-tags',
    path,
    `+${ARTIFACT_PREFIX}*:${IMPORT_PREFIX}*`,
  ]);
};

const importedOid = async (bundleRef) => {
  if (!bundleRef.startsWith(ARTIFACT_PREFIX)) {
    throw new Error(`Unexpected bundle ref: ${bundleRef}`);
  }
  const imported = `${IMPORT_PREFIX}${bundleRef.slice(ARTIFACT_PREFIX.length)}`;
  return (await git(['rev-parse', imported])).stdout.trim();
};

const prepareOutput = async (output) => {
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  return directory;
};

async function prepareCut(options) {
  await ensureSeedRepository();
  const nextDevelopment = requireOption(options, 'next-development');
  const output = await prepareOutput(requireOption(options, 'output'));
  const sourceOid = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const sourceManifest = await manifestAt(sourceOid, 'package.json');
  const versions = deriveCutVersions(sourceManifest.version, nextDevelopment);
  const attempt = randomUUID();

  const proposalOid = await materializeCommit({
    message: proposalCommitMessage({
      attempt,
      line: versions.line,
      sourceOid,
      version: versions.releaseVersion,
    }),
    sourceOid,
    version: versions.releaseVersion,
  });
  const developmentOid = await materializeCommit({
    message: developmentCommitMessage({
      line: versions.line,
      sourceOid,
      version: versions.developmentVersion,
    }),
    sourceOid,
    version: versions.developmentVersion,
  });

  await validateProposalCommit(proposalOid, {
    line: versions.line,
    sourceOid,
    version: versions.releaseVersion,
  });
  await validateDevelopmentCommit(developmentOid, {
    line: versions.line,
    sourceOid,
    version: versions.developmentVersion,
  });

  const proposalBundleRef = `${ARTIFACT_PREFIX}cut-proposal`;
  const developmentBundleRef = `${ARTIFACT_PREFIX}cut-development`;
  await writeBundle(join(output, 'objects.bundle'), [
    { name: proposalBundleRef, oid: proposalOid },
    { name: developmentBundleRef, oid: developmentOid },
  ]);

  await writeJson(join(output, 'transition.json'), {
    developmentBundleRef,
    developmentOid,
    developmentVersion: versions.developmentVersion,
    kind: 'cut',
    line: versions.line,
    proposalBundleRef,
    proposalOid,
    releaseVersion: versions.releaseVersion,
    repository: PILOT_REPOSITORY,
    schema: 1,
    sourceOid,
  });
  console.log(`Prepared ${versions.line} from ${sourceOid}.`);
}

async function applyCut(options) {
  await ensureSeedRepository();
  const transitionPath = resolve(requireOption(options, 'transition'));
  const bundlePath = resolve(requireOption(options, 'bundle'));
  const transition = await readJson(transitionPath);
  const token = process.env.GH_TOKEN;
  if (
    transition.schema !== 1 ||
    transition.kind !== 'cut' ||
    transition.repository !== PILOT_REPOSITORY ||
    process.env.GITHUB_REPOSITORY !== PILOT_REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error('Cut transition is outside the trusted pilot context.');
  }

  const repository = await getRepository(token);
  await importBundle(bundlePath);
  await validateCutTransition(transition);
  assert.equal(await importedOid(transition.proposalBundleRef), transition.proposalOid);
  assert.equal(await importedOid(transition.developmentBundleRef), transition.developmentOid);
  await validateProposalCommit(transition.proposalOid, {
    line: transition.line,
    sourceOid: transition.sourceOid,
    version: transition.releaseVersion,
  });
  await validateDevelopmentCommit(transition.developmentOid, {
    line: transition.line,
    sourceOid: transition.sourceOid,
    version: transition.developmentVersion,
  });
  const uploadedProposalOid = await uploadCommitObject(token, transition.proposalOid);
  const uploadedDevelopmentOid = await uploadCommitObject(token, transition.developmentOid);

  const main = await getRef(token, 'heads/main');
  if (main?.oid !== transition.sourceOid) {
    throw new Error('main advanced after cut preparation; no refs were changed.');
  }
  if (
    (await getRef(token, `heads/releases/${transition.line}`)) !== null ||
    (await getRef(token, `heads/staged/${transition.line}`)) !== null
  ) {
    throw new Error(`${transition.line} already exists; no refs were changed.`);
  }

  await updateRefs(token, repository.node_id, [
    createRefUpdate({
      afterOid: transition.sourceOid,
      name: `refs/heads/releases/${transition.line}`,
    }),
    createRefUpdate({
      afterOid: uploadedProposalOid,
      name: `refs/heads/staged/${transition.line}`,
    }),
    createRefUpdate({
      afterOid: uploadedDevelopmentOid,
      beforeOid: transition.sourceOid,
      name: 'refs/heads/main',
    }),
  ]);

  const openPulls = (await listReleasePulls(token, transition.line)).filter(
    ({ state }) => state === 'open'
  );
  if (openPulls.length === 0) {
    await createDraftReleasePr(token, {
      line: transition.line,
      releaseOid: transition.sourceOid,
      version: transition.releaseVersion,
    });
  } else if (openPulls.length !== 1) {
    throw new Error(`${transition.line} has more than one open canonical release PR.`);
  }
  console.log(`Cut ${transition.line} and opened its draft ${transition.releaseVersion} proposal.`);
}

const refOid = (ref) => ref.object.sha;

const latestCompletedTag = async (token, line, tagRefs) => {
  const lineVersion = parseReleaseLine(line);
  const candidates = tagRefs
    .map((ref) => ({
      ref,
      version: ref.ref.replace('refs/tags/v', ''),
    }))
    .filter(({ version }) => {
      try {
        const parsed = parseStableVersion(version);
        return parsed.major === lineVersion.major && parsed.minor === lineVersion.minor;
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const a = parseStableVersion(left.version);
      const b = parseStableVersion(right.version);
      return a.patch - b.patch;
    });
  for (const latest of candidates.reverse()) {
    const release = await getReleaseByTag(token, `v${latest.version}`);
    if (release !== null && release.draft === false) {
      return {
        oid: await resolveRefObject(token, latest.ref.object),
        version: latest.version,
      };
    }
  }
  return { oid: null, version: null };
};

const loadMaintenanceStates = async (token) => {
  await getRepository(token);
  const [releaseRefs, tagRefs] = await Promise.all([
    listMatchingRefs(token, 'heads/releases/'),
    listMatchingRefs(token, 'tags/v'),
  ]);
  const lines = releaseRefs
    .map((ref) => ref.ref.replace('refs/heads/releases/', ''))
    .sort(compareReleaseLines);

  const states = [];
  for (const line of lines) {
    const releaseRef = releaseRefs.find((ref) => ref.ref === `refs/heads/releases/${line}`);
    const releaseOid = refOid(releaseRef);
    const stagedRef = await getRef(token, `heads/staged/${line}`);
    const pulls = await listReleasePulls(token, line);
    const openPulls = pulls.filter(({ state }) => state === 'open');
    if (openPulls.length > 1) {
      throw new Error(`${line} has more than one open canonical release PR.`);
    }
    const latestClosedSummary = pulls
      .filter(({ state }) => state === 'closed')
      .sort((left, right) => right.number - left.number)[0];
    const latestClosed = latestClosedSummary
      ? await getPullRequest(token, latestClosedSummary.number)
      : null;
    const completed = await latestCompletedTag(token, line, tagRefs);

    let staged = null;
    if (stagedRef !== null) {
      await git(['fetch', '--no-tags', 'origin', `+refs/heads/staged/${line}:refs/remotes/origin/staged/${line}`]);
      const metadata = parseProposalMessage(await commitMessage(stagedRef.oid));
      if (metadata.line !== line) {
        throw new Error(`staged/${line} contains proposal metadata for ${metadata.line}.`);
      }
      staged = { ...metadata, oid: stagedRef.oid };
    }

    const closedProposal =
      latestClosed === null
        ? null
        : parseProposalMessage((await getGitCommit(token, latestClosed.head.sha)).message);

    states.push({
      completedOid: completed.oid,
      completedVersion: completed.version,
      latestClosedPr:
        latestClosed === null
          ? null
          : {
              headOid: latestClosed.head.sha,
              mergeCommitOid: latestClosed.merge_commit_sha,
              merged: latestClosed.merged_at !== null,
              number: latestClosed.number,
              version: closedProposal.version,
            },
      line,
      openPr: openPulls[0] ? { number: openPulls[0].number } : null,
      releaseOid,
      staged,
    });
  }
  return states;
};

async function prepareMaintenance(options) {
  await ensureSeedRepository();
  const output = await prepareOutput(requireOption(options, 'output'));
  const token = process.env.GH_TOKEN;
  const states = await loadMaintenanceStates(token);
  const planned = planProposalMaintenance(states);
  const actions = [];
  const bundleRefs = [];

  for (const plan of planned) {
    if (plan.kind === 'none') {
      continue;
    }
    const state = states.find(({ line }) => line === plan.line);
    const base = {
      expectedStagedOid: state.staged?.oid ?? null,
      kind: plan.kind,
      line: plan.line,
      openPr: plan.openPr?.number,
      releaseOid: state.releaseOid,
    };

    if (plan.kind === 'dormant' || plan.kind === 'open') {
      actions.push({ ...base, version: plan.version });
      continue;
    }

    await git([
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/releases/${plan.line}:refs/remotes/origin/releases/${plan.line}`,
    ]);
    const attempt = randomUUID();
    const proposalOid = await materializeCommit({
      message: proposalCommitMessage({
        attempt,
        line: plan.line,
        sourceOid: state.releaseOid,
        version: plan.version,
      }),
      sourceOid: state.releaseOid,
      version: plan.version,
    });
    await validateProposalCommit(proposalOid, {
      line: plan.line,
      sourceOid: state.releaseOid,
      version: plan.version,
    });
    const bundleRef = `${ARTIFACT_PREFIX}proposal-${plan.line}-${attempt}`;
    bundleRefs.push({ name: bundleRef, oid: proposalOid });
    actions.push({
      ...base,
      bundleRef,
      proposalOid,
      supersededPr: plan.supersededPr,
      version: plan.version,
    });
  }

  if (bundleRefs.length > 0) {
    await writeBundle(join(output, 'objects.bundle'), bundleRefs);
  }
  await writeJson(join(output, 'transition.json'), {
    actions,
    kind: 'maintenance',
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  console.log(`Prepared ${actions.length} release proposal maintenance actions.`);
}

const assertExpectedRef = async (token, ref, expectedOid) => {
  const live = await getRef(token, ref);
  if ((live?.oid ?? null) !== expectedOid) {
    throw new Error(`${ref} changed after maintenance preparation.`);
  }
};

async function applyMaintenance(options) {
  await ensureSeedRepository();
  const transitionPath = resolve(requireOption(options, 'transition'));
  const transition = await readJson(transitionPath);
  const bundle = options.bundle ? resolve(options.bundle) : null;
  const token = process.env.GH_TOKEN;
  if (
    transition.schema !== 1 ||
    transition.kind !== 'maintenance' ||
    transition.repository !== PILOT_REPOSITORY ||
    process.env.GITHUB_REPOSITORY !== PILOT_REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error('Maintenance transition is outside the trusted pilot context.');
  }

  const repository = await getRepository(token);
  if (transition.actions.some(({ bundleRef }) => bundleRef) && bundle === null) {
    throw new Error('Maintenance transition requires its Git object bundle.');
  }
  if (bundle !== null) {
    await importBundle(bundle);
  }

  for (const action of transition.actions) {
    parseReleaseLine(action.line);
    if (!['create', 'dormant', 'open', 'recreate', 'refresh'].includes(action.kind)) {
      throw new Error(`Unknown maintenance action: ${action.kind}`);
    }
    validateFullOid(action.releaseOid, `${action.line} release source`);
    if (action.expectedStagedOid !== null) {
      validateFullOid(action.expectedStagedOid, `${action.line} staged expectation`);
    }
    await assertExpectedRef(token, `heads/releases/${action.line}`, action.releaseOid);
    await assertExpectedRef(token, `heads/staged/${action.line}`, action.expectedStagedOid);
    const openPulls = (await listReleasePulls(token, action.line)).filter(
      ({ state }) => state === 'open'
    );

    if (action.kind === 'dormant') {
      if (action.expectedStagedOid !== null) {
        await updateRefs(token, repository.node_id, [
          createRefUpdate({
            afterOid: action.releaseOid,
            beforeOid: action.releaseOid,
            name: `refs/heads/releases/${action.line}`,
          }),
          createRefUpdate({
            afterOid: ZERO_OID,
            beforeOid: action.expectedStagedOid,
            force: true,
            name: `refs/heads/staged/${action.line}`,
          }),
        ]);
      }
      await assertExpectedRef(token, `heads/releases/${action.line}`, action.releaseOid);
      await assertExpectedRef(token, `heads/staged/${action.line}`, null);
      for (const pull of openPulls) {
        await closePullRequest(token, pull.number);
      }
      continue;
    }

    if (action.kind === 'open') {
      parseStableVersion(action.version);
      if (openPulls.length !== 0 || action.expectedStagedOid === null) {
        throw new Error(`${action.line} can no longer open its prepared staged proposal.`);
      }
      await git([
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/staged/${action.line}:refs/remotes/origin/staged/${action.line}`,
      ]);
      const metadata = parseProposalMessage(await commitMessage(action.expectedStagedOid));
      if (
        metadata.line !== action.line ||
        metadata.sourceOid !== action.releaseOid ||
        metadata.version !== action.version
      ) {
        throw new Error(`${action.line} staged proposal changed before PR creation.`);
      }
      await assertExpectedRef(token, `heads/releases/${action.line}`, action.releaseOid);
      await assertExpectedRef(token, `heads/staged/${action.line}`, action.expectedStagedOid);
      await createDraftReleasePr(token, action);
      continue;
    }

    if (action.kind === 'refresh') {
      if (openPulls.length !== 1 || openPulls[0].number !== action.openPr) {
        throw new Error(`${action.line} no longer has the expected open release PR.`);
      }
    } else if (openPulls.length !== 0) {
      throw new Error(`${action.line} gained an open release PR after preparation.`);
    }

    assert.equal(await importedOid(action.bundleRef), action.proposalOid);
    validateFullOid(action.proposalOid, `${action.line} proposal`);
    parseStableVersion(action.version);
    await validateProposalCommit(action.proposalOid, {
      line: action.line,
      sourceOid: action.releaseOid,
      version: action.version,
    });
    const uploadedProposalOid = await uploadCommitObject(token, action.proposalOid);
    await updateRefs(token, repository.node_id, [
      createRefUpdate({
        afterOid: action.releaseOid,
        beforeOid: action.releaseOid,
        name: `refs/heads/releases/${action.line}`,
      }),
      createRefUpdate({
        afterOid: uploadedProposalOid,
        beforeOid: action.expectedStagedOid ?? ZERO_OID,
        force: action.expectedStagedOid !== null,
        name: `refs/heads/staged/${action.line}`,
      }),
    ]);

    if (action.kind === 'refresh') {
      await updatePullRequestBody(
        token,
        action.openPr,
        refreshReleasePrBody(openPulls[0].body, {
          sourceOid: action.releaseOid,
          version: action.version,
        })
      );
    }

    if (action.kind === 'create' || action.kind === 'recreate') {
      await createDraftReleasePr(token, action);
    }
  }
  console.log(`Applied ${transition.actions.length} release proposal maintenance actions.`);
}

async function checkPullRequest() {
  await ensureSeedRepository();
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required for the release proposal check.');
  }
  const event = await readJson(eventPath);
  const pull = event.pull_request;
  if (
    pull?.base?.repo?.full_name !== PILOT_REPOSITORY ||
    pull?.head?.repo?.full_name !== PILOT_REPOSITORY ||
    pull.base.ref !== `releases/${pull.head.ref?.replace('staged/', '')}` ||
    !pull.head.ref?.startsWith('staged/')
  ) {
    throw new Error('This is not a canonical same-repository release proposal PR.');
  }
  const line = pull.head.ref.slice('staged/'.length);
  parseReleaseLine(line);
  validateFullOid(pull.base.sha, 'Release PR base');
  validateFullOid(pull.head.sha, 'Release PR head');
  const metadata = parseProposalMessage(await commitMessage(pull.head.sha));
  await validateProposalCommit(pull.head.sha, {
    line,
    sourceOid: pull.base.sha,
    version: metadata.version,
  });
  console.log(`Release proposal ${pull.head.sha} is current for ${pull.base.sha}.`);
}

const [command, ...argumentValues] = process.argv.slice(2);
const options = parseOptions(argumentValues);

switch (command) {
  case 'prepare-cut':
    await prepareCut(options);
    break;
  case 'apply-cut':
    await applyCut(options);
    break;
  case 'prepare-maintenance':
    await prepareMaintenance(options);
    break;
  case 'apply-maintenance':
    await applyMaintenance(options);
    break;
  case 'check-pr':
    await checkPullRequest();
    break;
  default:
    throw new Error(
      `Usage: ${basename(process.argv[1])} <prepare-cut|apply-cut|prepare-maintenance|apply-maintenance|check-pr> [options]`
    );
}
