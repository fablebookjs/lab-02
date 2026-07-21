import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  derivePatchbackItems,
  PATCHBACK_BODY_MARKER,
  PATCHBACK_COMMENT_MARKER,
  parsePatchbackCommitMessage,
  patchbackCommitMessage,
  patchbackExamplesComment,
  patchbackIdentity,
  previousReleaseVersion,
  renderPatchbackBody,
} from './patchback-core.mjs';
import { deriveReleaseAuthority, PILOT_REPOSITORY } from './release-publication-core.mjs';
import {
  parseDevelopmentCommitMessage,
  parseStableVersion,
} from './release-proposal-core.mjs';
import {
  getGitCommit,
  getPullRequest,
  getRef,
  getReleaseByTag,
  githubRequest,
  resolveRefObject,
  withPullRequestMergeCommit,
} from './release-proposal-github.mjs';

const execute = promisify(execFile);

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

const git = (args, cwd) => run('git', args, { cwd });
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

const fullOid = (value, label) => {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const ensureTrustedMain = () => {
  if (
    process.env.GITHUB_REPOSITORY !== PILOT_REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error('Patchback authority is restricted to trusted main in the pilot repository.');
  }
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

const readLiveAuthority = async (token, pullRequest) => {
  const pull = await getPullRequest(token, pullRequest);
  const [headCommit, mergeCommit] = await Promise.all([
    getGitCommit(token, pull.head.sha),
    getGitCommit(token, pull.merge_commit_sha),
  ]);
  return deriveReleaseAuthority({ headCommit, mergeCommit, pull });
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
      throw new Error(`Patchback release authority changed at ${field}.`);
    }
  }
};

const validateAuthorityDocument = (document) => {
  if (document?.schema !== 1 || document.repository !== PILOT_REPOSITORY) {
    throw new Error('Patchback authority document is outside the pilot schema.');
  }
  const authority = { ...document };
  delete authority.repository;
  delete authority.schema;
  patchbackIdentity(authority.version);
  fullOid(authority.proposalOid, 'Proposal');
  fullOid(authority.snapshotOid, 'Snapshot');
  fullOid(authority.sourceOid, 'Release source');
  if (!Number.isSafeInteger(authority.pullRequest) || authority.pullRequest <= 0) {
    throw new Error('Patchback authority has an invalid pull request.');
  }
  return authority;
};

async function resolvePatchback(options) {
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
    await appendFile(githubOutput, 'patchback=false\n', 'utf8');
    console.log(`Pull request ${signal.pullRequest} does not authorize a patchback.`);
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
    `patchback=true\nsnapshot=${authority.snapshotOid}\nversion=${authority.version}\n`,
    'utf8'
  );
  console.log(`Resolved patchback authority for ${authority.version}.`);
}

const gitHead = async (root) =>
  (await git(['rev-parse', 'HEAD'], root)).stdout.trim();

const commitParents = async (root, oid) =>
  (await git(['show', '-s', '--format=%P', oid], root)).stdout.trim().split(/\s+/).filter(Boolean);

const commitSubject = async (root, oid) =>
  (await git(['show', '-s', '--format=%s', oid], root)).stdout.trim();

const findReleaseCut = async (root, line) => {
  const { stdout } = await git(['rev-list', '--first-parent', 'HEAD'], root);
  const matches = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const message = (await git(['show', '-s', '--format=%B', oid], root)).stdout.trimEnd();
    try {
      const cut = parseDevelopmentCommitMessage(message);
      if (cut.line === line) {
        const parents = await commitParents(root, oid);
        if (parents.length !== 1 || parents[0] !== cut.sourceOid) {
          throw new Error(`Release-cut commit ${oid} is not a child of its recorded source.`);
        }
        matches.push({ ...cut, commitOid: oid });
      }
    } catch (error) {
      if (!error.message.includes('missing required release-cut trailers')) {
        throw error;
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one ${line} release-cut record on main, found ${matches.length}.`);
  }
  return matches[0];
};

const previousCompletedSnapshot = async (token, version) => {
  const previousVersion = previousReleaseVersion(version);
  if (previousVersion === null) {
    return null;
  }
  const tag = `v${previousVersion}`;
  const [ref, release] = await Promise.all([
    getRef(token, `tags/${tag}`),
    getReleaseByTag(token, tag),
  ]);
  if (
    ref === null ||
    ref.type !== 'tag' ||
    release === null ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.tag_name !== tag
  ) {
    throw new Error(`${tag} is not a completed annotated release.`);
  }
  return {
    label: `completed ${tag} snapshot`,
    oid: await resolveRefObject(token, { sha: ref.oid, type: ref.type }),
  };
};

const firstParentRange = async (root, boundaryOid, snapshotOid) => {
  const { stdout: ancestry } = await git(['rev-list', '--first-parent', snapshotOid], root);
  if (!ancestry.trim().split('\n').includes(boundaryOid)) {
    throw new Error('The patchback boundary is not on the snapshot first-parent history.');
  }
  const { stdout } = await git(
    ['rev-list', '--first-parent', '--reverse', `${boundaryOid}..${snapshotOid}`],
    root
  );
  const oids = stdout.trim().split('\n').filter(Boolean);
  if (oids.at(-1) !== snapshotOid) {
    throw new Error('The authorized snapshot does not close its patchback scope.');
  }
  return oids;
};

const associatedPulls = async (token, oid) => {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/commits/${oid}/pulls?${query}`,
      { token }
    );
    pulls.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return Promise.all(pulls.map((pull) => withPullRequestMergeCommit(token, pull)));
};

const validateManifest = (manifest) => {
  if (manifest?.schema !== 1 || manifest.repository !== PILOT_REPOSITORY) {
    throw new Error('Patchback manifest is outside the pilot schema.');
  }
  const identity = patchbackIdentity(manifest.authority?.version);
  if (
    manifest.branch !== identity.branch ||
    manifest.title !== identity.title ||
    manifest.authority.line !== identity.line ||
    manifest.comment !== patchbackExamplesComment()
  ) {
    throw new Error('Patchback manifest identity is invalid.');
  }
  const authority = validateAuthorityDocument({
    ...manifest.authority,
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  fullOid(manifest.baseMainOid, 'Patchback main base');
  fullOid(manifest.baseMainTreeOid, 'Patchback main tree');
  fullOid(manifest.boundaryOid, 'Patchback boundary');
  const previousVersion = previousReleaseVersion(authority.version);
  const expectedBoundaryLabel =
    previousVersion === null
      ? `release cut for ${authority.line}`
      : `completed v${previousVersion} snapshot`;
  if (manifest.boundaryLabel !== expectedBoundaryLabel) {
    throw new Error('Patchback scope boundary label is invalid.');
  }
  if (!Array.isArray(manifest.items)) {
    throw new Error('Patchback manifest has no ordered item list.');
  }
  for (const item of manifest.items) {
    fullOid(item.oid, 'Patchback item');
    if (
      !['pull-request', 'direct-commit', 'direct-merge'].includes(item.kind) ||
      typeof item.subject !== 'string' ||
      item.subject.length === 0 ||
      item.subject.length > 160 ||
      !new RegExp(`^git cherry-pick (?:-m 1 )?${item.oid}$`).test(item.command) ||
      (item.kind === 'pull-request' &&
        (!Number.isSafeInteger(item.pullRequest) || item.pullRequest <= 0)) ||
      (item.kind !== 'pull-request' && item.pullRequest !== null)
    ) {
      throw new Error('Patchback manifest contains an invalid item.');
    }
  }
  const expectedBody = renderPatchbackBody({
    boundaryLabel: manifest.boundaryLabel,
    boundaryOid: manifest.boundaryOid,
    items: manifest.items,
    line: authority.line,
    snapshotOid: authority.snapshotOid,
    version: authority.version,
  });
  if (manifest.body !== expectedBody) {
    throw new Error('Patchback body does not match its immutable item list.');
  }
  const expectedMessage = patchbackCommitMessage({
    baseMainOid: manifest.baseMainOid,
    boundaryOid: manifest.boundaryOid,
    line: authority.line,
    snapshotOid: authority.snapshotOid,
    version: authority.version,
  });
  if (manifest.coordinationMessage !== expectedMessage) {
    throw new Error('Patchback coordination commit message is invalid.');
  }
  return manifest;
};

async function preparePatchback(options) {
  ensureTrustedMain();
  const controller = resolve(requireOption(options, 'controller'));
  const snapshot = resolve(requireOption(options, 'snapshot'));
  const output = resolve(requireOption(options, 'output'));
  const authority = validateAuthorityDocument(
    await readJson(resolve(requireOption(options, 'authority')))
  );
  if ((await gitHead(snapshot)) !== authority.snapshotOid) {
    throw new Error('The checked-out snapshot does not match patchback authority.');
  }

  const token = process.env.GH_TOKEN;
  const parsed = parseStableVersion(authority.version);
  let boundary;
  if (parsed.patch === 0) {
    const cut = await findReleaseCut(controller, authority.line);
    boundary = { label: `release cut for ${authority.line}`, oid: cut.sourceOid };
  } else {
    boundary = await previousCompletedSnapshot(token, authority.version);
  }
  fullOid(boundary.oid, 'Patchback boundary');

  const scopeOids = await firstParentRange(snapshot, boundary.oid, authority.snapshotOid);
  const productOids = scopeOids.slice(0, -1);
  const productCommits = await Promise.all(
    productOids.map(async (oid) => ({
      associatedPulls: await associatedPulls(token, oid),
      oid,
      parents: await commitParents(snapshot, oid),
      subject: await commitSubject(snapshot, oid),
    }))
  );
  const items = derivePatchbackItems({
    commits: [...productCommits, { oid: authority.snapshotOid, parents: [], subject: '' }],
    line: authority.line,
    snapshotOid: authority.snapshotOid,
  });

  const main = await getRef(token, 'heads/main');
  if (main === null || main.type !== 'commit') {
    throw new Error('main does not identify a commit.');
  }
  const mainCommit = await getGitCommit(token, main.oid);
  const identity = patchbackIdentity(authority.version);
  const manifest = validateManifest({
    authority,
    baseMainOid: main.oid,
    baseMainTreeOid: mainCommit.tree.sha,
    body: renderPatchbackBody({
      boundaryLabel: boundary.label,
      boundaryOid: boundary.oid,
      items,
      line: authority.line,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    }),
    boundaryLabel: boundary.label,
    boundaryOid: boundary.oid,
    branch: identity.branch,
    comment: patchbackExamplesComment(),
    coordinationMessage: patchbackCommitMessage({
      baseMainOid: main.oid,
      boundaryOid: boundary.oid,
      line: authority.line,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    }),
    items,
    repository: PILOT_REPOSITORY,
    schema: 1,
    title: identity.title,
  });
  await mkdir(output, { recursive: true });
  await writeJson(join(output, 'patchback.json'), manifest);
  console.log(`Prepared ${items.length} patchback item(s) for ${authority.version}.`);
}

const listPatchbackPulls = async (token, branch) => {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      head: `fablebookjs:${branch}`,
      page: String(page),
      per_page: '100',
      state: 'all',
    });
    const batch = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls?${query}`, { token });
    pulls.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return pulls.filter(
    (pull) =>
      pull.base.ref === 'main' &&
      pull.base.repo?.full_name === PILOT_REPOSITORY &&
      pull.head.ref === branch &&
      pull.head.repo?.full_name === PILOT_REPOSITORY
  );
};

const coordinationMatches = (metadata, manifest) =>
  metadata.boundaryOid === manifest.boundaryOid &&
  metadata.line === manifest.authority.line &&
  metadata.snapshotOid === manifest.authority.snapshotOid &&
  metadata.version === manifest.authority.version;

const findCoordinationCommit = async (token, headOid, manifest) => {
  let oid = fullOid(headOid, 'Patchback branch head');
  for (let depth = 0; depth < 500; depth += 1) {
    const commit = await getGitCommit(token, oid);
    try {
      const metadata = parsePatchbackCommitMessage(commit.message);
      if (coordinationMatches(metadata, manifest)) {
        if (commit.parents.length !== 1) {
          throw new Error('Patchback coordination commit must have exactly one parent.');
        }
        const parent = await getGitCommit(token, commit.parents[0].sha);
        if (
          commit.parents[0].sha !== metadata.baseMainOid ||
          commit.tree.sha !== parent.tree.sha
        ) {
          throw new Error('Patchback coordination commit is not empty on its recorded main base.');
        }
        return { baseMainOid: metadata.baseMainOid, oid: commit.sha };
      }
    } catch (error) {
      if (!error.message.includes('not a structured patchback coordination commit')) {
        throw error;
      }
    }
    if (commit.parents.length === 0) {
      break;
    }
    oid = commit.parents[0].sha;
  }
  throw new Error('Patchback branch does not contain its structured coordination commit.');
};

const verifyMainAncestry = async (token, baseMainOid) => {
  const main = await getRef(token, 'heads/main');
  if (main === null || main.type !== 'commit') {
    throw new Error('main does not identify a commit.');
  }
  const comparison = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/compare/${baseMainOid}...${main.oid}`,
    { token }
  );
  if (
    !['ahead', 'identical'].includes(comparison.status) ||
    comparison.merge_base_commit?.sha !== baseMainOid
  ) {
    throw new Error('Patchback coordination is not based on an ancestor of current main.');
  }
};

const ensureExamplesComment = async (token, pullRequest, body) => {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/issues/${pullRequest}/comments?${query}`,
      { token }
    );
    comments.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  const matches = comments.filter((comment) => comment.body?.includes(PATCHBACK_COMMENT_MARKER));
  if (matches.length > 1) {
    throw new Error(`Patchback #${pullRequest} has duplicate outcome-example comments.`);
  }
  if (matches.length === 0) {
    await githubRequest(`/repos/${PILOT_REPOSITORY}/issues/${pullRequest}/comments`, {
      body: { body },
      method: 'POST',
      token,
    });
    return;
  }
  if (matches[0].body !== body) {
    await githubRequest(`/repos/${PILOT_REPOSITORY}/issues/comments/${matches[0].id}`, {
      body: { body },
      method: 'PATCH',
      token,
    });
  }
};

const validateExistingPull = (pull, manifest) => {
  if (
    pull.base.ref !== 'main' ||
    pull.base.repo?.full_name !== PILOT_REPOSITORY ||
    pull.head.ref !== manifest.branch ||
    pull.head.repo?.full_name !== PILOT_REPOSITORY ||
    !pull.body?.includes(PATCHBACK_BODY_MARKER) ||
    !pull.body.includes(manifest.authority.snapshotOid) ||
    !pull.body.includes(`# Patchback for v${manifest.authority.version}`)
  ) {
    throw new Error('Existing patchback pull request does not match the authorized snapshot.');
  }
};

async function applyPatchback(options) {
  ensureTrustedMain();
  const manifest = validateManifest(
    await readJson(resolve(requireOption(options, 'manifest')))
  );
  const token = process.env.GH_TOKEN;
  compareAuthority(
    await readLiveAuthority(token, manifest.authority.pullRequest),
    manifest.authority
  );

  const pulls = await listPatchbackPulls(token, manifest.branch);
  if (pulls.length > 1) {
    throw new Error(`${manifest.branch} has more than one canonical pull request.`);
  }
  let pull = pulls[0] ?? null;
  if (pull !== null) {
    validateExistingPull(pull, manifest);
    console.log(`Patchback #${pull.number} already exists; no action is required.`);
    return;
  }

  const branchRefName = `heads/${manifest.branch}`;
  let branch = await getRef(token, branchRefName);
  if (branch === null) {
    const main = await getRef(token, 'heads/main');
    if (main?.oid !== manifest.baseMainOid || main.type !== 'commit') {
      throw new Error('main advanced after patchback preparation; no branch was created.');
    }
    const mainCommit = await getGitCommit(token, main.oid);
    if (mainCommit.tree.sha !== manifest.baseMainTreeOid) {
      throw new Error('The prepared main tree changed before patchback creation.');
    }
    const coordination = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits`, {
      body: {
        message: manifest.coordinationMessage,
        parents: [manifest.baseMainOid],
        tree: manifest.baseMainTreeOid,
      },
      method: 'POST',
      token,
    });
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/refs`, {
      body: { ref: `refs/${branchRefName}`, sha: coordination.sha },
      method: 'POST',
      token,
    });
    branch = { oid: coordination.sha, type: 'commit' };
  }
  if (branch.type !== 'commit') {
    throw new Error(`${manifest.branch} does not identify a commit.`);
  }
  const coordination = await findCoordinationCommit(token, branch.oid, manifest);
  await verifyMainAncestry(token, coordination.baseMainOid);

  pull = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls`, {
    body: {
      base: 'main',
      body: manifest.body,
      draft: true,
      head: manifest.branch,
      maintainer_can_modify: false,
      title: manifest.title,
    },
    method: 'POST',
    token,
  });
  validateExistingPull(pull, manifest);

  await ensureExamplesComment(token, pull.number, manifest.comment);
  console.log(`Patchback #${pull.number} is open for ${manifest.authority.version}.`);
}

const commands = {
  apply: applyPatchback,
  prepare: preparePatchback,
  resolve: resolvePatchback,
};

const [commandName, ...values] = process.argv.slice(2);
const command = commands[commandName];
if (!command) {
  throw new Error(`Unknown patchback command: ${commandName ?? '(missing)'}`);
}
await command(parseOptions(values));
