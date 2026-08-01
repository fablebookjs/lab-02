import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  derivePatchbackItems,
  PATCHBACK_BODY_MARKER,
  PATCHBACK_COMMENT_MARKER,
  parsePatchbackCommitMessage,
  patchbackCommitMessage,
  patchbackExamplesComment,
  patchbackIdentity,
  patchbackMigrationRecords,
  patchbackReleaseRecord,
  previousReleaseVersion,
  releaseMergerAssignee,
  renderPatchbackBody,
} from '../../shared/patchback/core.ts';
import { deriveReleaseAuthority } from '../../shared/release-publication/core.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import {
  migrationRecordDirectory,
  releaseRecordPath,
} from '../../shared/release-communication/records.ts';
import {
  parseDevelopmentCommitMessageIfPresent,
  parseStableVersion,
} from '../../shared/release-proposal/core.ts';
import type { DevelopmentCommit } from '../../shared/release-proposal/core.ts';
import { githubRequest } from '../release-repository/transport.ts';
import {
  getGitCommit,
  getPullRequest,
  getRef,
  getReleaseByTag,
  isCanonicalReleasePull,
  resolveRefObject,
  withPullRequestMergeCommit,
  validatedGitCommitResponse,
  validatedPullRequestResponse,
} from '../release-repository/github.ts';
import type {
  GitCommit,
  GitPullRequest,
} from '../release-repository/github.ts';
import type { ReleaseAuthority } from '../../shared/release-publication/core.ts';
import type { PatchbackItem } from '../../shared/patchback/core.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import { run } from '../../shared/process/run.ts';
import { requireControllerGitHubToken } from '../controller-inputs.ts';

type IssueComment = {
  body: string | null;
  id: number;
};

type PatchbackAuthority = ReleaseAuthority & {
  assignee: string | null;
};

type PatchbackRecord = {
  content: string;
  path: string;
};

type PatchbackMigrationRecord = PatchbackRecord & {
  title: string;
};

type PatchbackManifest = {
  authority: PatchbackAuthority;
  baseMainOid: string;
  baseMainTreeOid: string;
  body: string;
  boundaryLabel: string;
  boundaryOid: string;
  branch: string;
  comment: string;
  coordinationMessage: string;
  items: PatchbackItem[];
  migrationRecords: PatchbackMigrationRecord[];
  releaseRecord: PatchbackRecord;
  repository: typeof PILOT_REPOSITORY;
  schema: 3;
  title: string;
};

export type ResolvePatchbackOptions = {
  'github-token': string;
  output: string;
  signal: string;
};

export type PatchbackResolution =
  | { patchback: false }
  | {
      patchback: true;
      snapshot: string;
      version: string;
    };

export type PreparePatchbackOptions = {
  authority: string;
  controller: string;
  'github-token': string;
  output: string;
  snapshot: string;
};

export type ApplyPatchbackOptions = {
  'github-token': string;
  manifest: string;
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

const git = (args: string[], cwd: string) => run('git', args, { cwd });

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const ensureTrustedMain = (): void => {
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== `refs/heads/${PRIMARY_BRANCH}`
  ) {
    throw new Error('Patchback authority is restricted to trusted main in the pilot repository.');
  }
};

const readLiveAuthority = async (
  token: string,
  pullRequest: number,
): Promise<PatchbackAuthority> => {
  const pull = await getPullRequest(token, pullRequest);
  const mergeCommitOid = pull.merge_commit_sha;
  if (mergeCommitOid === null) {
    throw new Error('Merged release pull request has no merge commit OID.');
  }
  const [headCommit, mergeCommit] = await Promise.all([
    getGitCommit(token, pull.head.sha),
    getGitCommit(token, mergeCommitOid),
  ]);
  return {
    ...deriveReleaseAuthority({ headCommit, mergeCommit, pull }),
    assignee: releaseMergerAssignee(pull),
  };
};

const compareAuthority = (
  actual: PatchbackAuthority,
  expected: PatchbackAuthority,
): void => {
  const fields: Array<keyof PatchbackAuthority> = [
    'channel',
    'assignee',
    'line',
    'proposalOid',
    'pullRequest',
    'snapshotOid',
    'sourceOid',
    'version',
  ];
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Patchback release authority changed at ${field}.`);
    }
  }
};

const validateAuthorityDocument = (document: unknown): PatchbackAuthority => {
  if (
    !isRecord(document) ||
    document['schema'] !== 1 ||
    document['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Patchback authority document is outside the pilot schema.');
  }
  const assignee = document['assignee'];
  if (assignee !== null && typeof assignee !== 'string') {
    throw new Error('Patchback authority has an invalid assignee.');
  }
  const authority: PatchbackAuthority = {
    assignee,
    channel: stringValue(document['channel'], 'Patchback channel'),
    line: stringValue(document['line'], 'Patchback line'),
    proposalOid: fullOid(document['proposalOid'], 'Proposal'),
    pullRequest: positiveInteger(document['pullRequest'], 'Patchback pull request'),
    snapshotOid: fullOid(document['snapshotOid'], 'Snapshot'),
    sourceOid: fullOid(document['sourceOid'], 'Release source'),
    version: stringValue(document['version'], 'Patchback version'),
  };
  patchbackIdentity(authority.version);
  if (
    authority.assignee !== null &&
    releaseMergerAssignee({ merged_by: { login: authority.assignee } }) !==
      authority.assignee
  ) {
    throw new Error('Patchback authority has an invalid assignee.');
  }
  return authority;
};

export async function resolvePatchback(
  options: ResolvePatchbackOptions,
): Promise<PatchbackResolution> {
  ensureTrustedMain();
  const signal = await readJsonFile(resolve(requireOption(options, 'signal')));
  const output = resolve(requireOption(options, 'output'));
  if (!isRecord(signal)) {
    throw new Error('Release signal does not contain one positive pull request number.');
  }
  const pullRequest = positiveInteger(signal['pullRequest'], 'Release signal pull request');

  const token = requireControllerGitHubToken(options);
  const pull = await getPullRequest(token, pullRequest);
  if (!isCanonicalReleasePull(pull) || pull.merged_at === null) {
    const outputs: PatchbackResolution = { patchback: false };
    console.log(`Pull request ${pullRequest} does not authorize a patchback.`);
    return outputs;
  }

  const authority = await readLiveAuthority(token, pullRequest);
  await mkdir(output, { recursive: true });
  await writeJsonFile(join(output, 'authority.json'), {
    ...authority,
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  const outputs: PatchbackResolution = {
    patchback: true,
    snapshot: authority.snapshotOid,
    version: authority.version,
  };
  console.log(`Resolved patchback authority for ${authority.version}.`);
  return outputs;
}

const commitParents = async (root: string, oid: string): Promise<string[]> =>
  (await git(['show', '-s', '--format=%P', oid], root)).stdout.trim().split(/\s+/).filter(Boolean);

const commitSubject = async (root: string, oid: string): Promise<string> =>
  (await git(['show', '-s', '--format=%s', oid], root)).stdout.trim();

const findReleaseCut = async (
  root: string,
  line: string,
): Promise<DevelopmentCommit & { commitOid: string }> => {
  const { stdout } = await git(['rev-list', '--first-parent', 'HEAD'], root);
  const matches: Array<DevelopmentCommit & { commitOid: string }> = [];
  for (const oid of stdout.trim().split('\n').filter(Boolean)) {
    const message = (await git(['show', '-s', '--format=%B', oid], root)).stdout.trimEnd();
    const cut = parseDevelopmentCommitMessageIfPresent(message);
    if (cut?.line === line) {
      const parents = await commitParents(root, oid);
      if (parents.length !== 1 || parents[0] !== cut.sourceOid) {
        throw new Error(`Release-cut commit ${oid} is not a child of its recorded source.`);
      }
      matches.push({ ...cut, commitOid: oid });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one ${line} release-cut record on main, found ${matches.length}.`);
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`Expected one ${line} release-cut record.`);
  }
  return match;
};

const previousCompletedSnapshot = async (
  token: string,
  version: string,
): Promise<{ label: string; oid: string } | null> => {
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

const firstParentRange = async (
  root: string,
  boundaryOid: string,
  snapshotOid: string,
): Promise<string[]> => {
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

const associatedPulls = async (token: string, oid: string): Promise<GitPullRequest[]> => {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/commits/${oid}/pulls?${query}`,
      { token }
    );
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub associated pull requests for ${oid} must be an array.`);
    }
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) {
      break;
    }
  }
  return Promise.all(pulls.map((pull) => withPullRequestMergeCommit(token, pull)));
};

const loadPatchbackMigrationRecords = async (
  root: string,
  line: string,
): Promise<PatchbackMigrationRecord[]> => {
  const directory = migrationRecordDirectory(line);
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (
    entries.some(
      (entry) => !entry.isFile() || !entry.name.endsWith('.md')
    )
  ) {
    throw new Error(`${directory} contains an unsupported migration record path.`);
  }
  return patchbackMigrationRecords({
    line,
    records: await Promise.all(
      entries.map(async ({ name: filename }) => ({
        filename,
        source: await readFile(join(root, directory, filename), 'utf8'),
      }))
    ),
  });
};

const patchbackItemValue = (value: unknown): PatchbackItem => {
  if (!isRecord(value)) throw new Error('Patchback item must be an object.');
  const kind = value['kind'];
  if (kind !== 'pull-request' && kind !== 'direct-commit' && kind !== 'direct-merge') {
    throw new Error('Patchback item has an invalid kind.');
  }
  let pullRequest: number | null;
  if (kind === 'pull-request') {
    pullRequest = positiveInteger(value['pullRequest'], 'Patchback item pull request');
  } else {
    if (value['pullRequest'] !== null) {
      throw new Error('Direct patchback items cannot identify a pull request.');
    }
    pullRequest = null;
  }
  return {
    command: stringValue(value['command'], 'Patchback item command'),
    kind,
    oid: fullOid(value['oid'], 'Patchback item'),
    pullRequest,
    subject: stringValue(value['subject'], 'Patchback item subject'),
  };
};

const validateManifest = (input: unknown): PatchbackManifest => {
  if (
    !isRecord(input) ||
    input['schema'] !== 3 ||
    input['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Patchback manifest is outside the pilot schema.');
  }
  const authorityInput = input['authority'];
  if (!isRecord(authorityInput)) {
    throw new Error('Patchback manifest has no authority object.');
  }
  const authority = validateAuthorityDocument({
    ...authorityInput,
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  const releaseRecordInput = input['releaseRecord'];
  if (!isRecord(releaseRecordInput)) {
    throw new Error('Patchback manifest has no release record.');
  }
  const releaseRecord = patchbackReleaseRecord({
    source: releaseRecordInput['content'],
    version: authority.version,
  });
  if (releaseRecordInput['path'] !== releaseRecord.path) {
    throw new Error('Patchback manifest release record path is invalid.');
  }
  const rawMigrationRecords = input['migrationRecords'];
  const migrationDirectory = `${migrationRecordDirectory(authority.line)}/`;
  const migrationRecords = patchbackMigrationRecords({
    line: authority.line,
    records: Array.isArray(rawMigrationRecords)
      ? rawMigrationRecords.map((record) => {
          if (!isRecord(record)) {
            throw new Error('Patchback migration record must be an object.');
          }
          const path = record['path'];
          return {
            filename:
              typeof path === 'string' && path.startsWith(migrationDirectory)
                ? path.slice(migrationDirectory.length)
                : path,
            source: record['content'],
          };
        })
      : rawMigrationRecords,
  });
  if (
    JSON.stringify(rawMigrationRecords) !==
    JSON.stringify(migrationRecords)
  ) {
    throw new Error('Patchback manifest migration records are invalid.');
  }
  const rawItems = input['items'];
  if (!Array.isArray(rawItems)) {
    throw new Error('Patchback manifest has no ordered item list.');
  }
  const items = rawItems.map(patchbackItemValue);
  const manifest: PatchbackManifest = {
    authority,
    baseMainOid: fullOid(input['baseMainOid'], 'Patchback main base'),
    baseMainTreeOid: fullOid(input['baseMainTreeOid'], 'Patchback main tree'),
    body: stringValue(input['body'], 'Patchback body'),
    boundaryLabel: stringValue(input['boundaryLabel'], 'Patchback boundary label'),
    boundaryOid: fullOid(input['boundaryOid'], 'Patchback boundary'),
    branch: stringValue(input['branch'], 'Patchback branch'),
    comment: stringValue(input['comment'], 'Patchback comment'),
    coordinationMessage: stringValue(
      input['coordinationMessage'],
      'Patchback coordination message',
    ),
    items,
    migrationRecords,
    releaseRecord,
    repository: PILOT_REPOSITORY,
    schema: 3,
    title: stringValue(input['title'], 'Patchback title'),
  };

  const identity = patchbackIdentity(manifest.authority.version);
  if (
    manifest.branch !== identity.branch ||
    manifest.title !== identity.title ||
    manifest.authority.line !== identity.line ||
    manifest.comment !== patchbackExamplesComment()
  ) {
    throw new Error('Patchback manifest identity is invalid.');
  }
  const previousVersion = previousReleaseVersion(authority.version);
  const expectedBoundaryLabel =
    previousVersion === null
      ? `release cut for ${authority.line}`
      : `completed v${previousVersion} snapshot`;
  if (manifest.boundaryLabel !== expectedBoundaryLabel) {
    throw new Error('Patchback scope boundary label is invalid.');
  }
  for (const item of manifest.items) {
    if (
      item.subject.length > 160 ||
      !new RegExp(`^git cherry-pick (?:-m 1 )?${item.oid}$`).test(item.command) ||
      (item.kind === 'pull-request' &&
        (item.pullRequest === null ||
          !Number.isSafeInteger(item.pullRequest) ||
          item.pullRequest <= 0)) ||
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
    migrationRecords,
    recordPath: releaseRecord.path,
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
    migrationRecordPaths: migrationRecords.map(({ path }) => path),
    recordPath: releaseRecord.path,
    snapshotOid: authority.snapshotOid,
    version: authority.version,
  });
  if (manifest.coordinationMessage !== expectedMessage) {
    throw new Error('Patchback coordination commit message is invalid.');
  }
  return manifest;
};

export async function preparePatchback(
  options: PreparePatchbackOptions,
): Promise<void> {
  ensureTrustedMain();
  const controller = resolve(requireOption(options, 'controller'));
  const snapshot = resolve(requireOption(options, 'snapshot'));
  const output = resolve(requireOption(options, 'output'));
  const authority = validateAuthorityDocument(
    await readJsonFile(resolve(requireOption(options, 'authority')))
  );
  if ((await resolveHeadOid(snapshot)) !== authority.snapshotOid) {
    throw new Error('The checked-out snapshot does not match patchback authority.');
  }

  const token = requireControllerGitHubToken(options);
  const parsed = parseStableVersion(authority.version);
  let boundary: { label: string; oid: string } | null;
  if (parsed.patch === 0) {
    const cut = await findReleaseCut(controller, authority.line);
    boundary = { label: `release cut for ${authority.line}`, oid: cut.sourceOid };
  } else {
    boundary = await previousCompletedSnapshot(token, authority.version);
  }
  if (boundary === null) {
    throw new Error(`Patchback ${authority.version} has no previous completed snapshot.`);
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
  const recordPath = releaseRecordPath(authority.version);
  const releaseRecord = patchbackReleaseRecord({
    source: await readFile(join(snapshot, recordPath), 'utf8'),
    version: authority.version,
  });
  const migrationRecords = await loadPatchbackMigrationRecords(
    snapshot,
    authority.line
  );

  const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
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
      migrationRecords,
      recordPath: releaseRecord.path,
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
      migrationRecordPaths: migrationRecords.map(({ path }) => path),
      recordPath: releaseRecord.path,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    }),
    items,
    migrationRecords,
    releaseRecord,
    repository: PILOT_REPOSITORY,
    schema: 3,
    title: identity.title,
  });
  await mkdir(output, { recursive: true });
  await writeJsonFile(join(output, 'patchback.json'), manifest);
  console.log(`Prepared ${items.length} patchback item(s) for ${authority.version}.`);
}

const listPatchbackPulls = async (
  token: string,
  branch: string,
): Promise<GitPullRequest[]> => {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      head: `fablebookjs:${branch}`,
      page: String(page),
      per_page: '100',
      state: 'all',
    });
    const batch = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls?${query}`, { token });
    if (!Array.isArray(batch)) {
      throw new Error('GitHub patchback pull request list must be an array.');
    }
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) {
      break;
    }
  }
  return pulls.filter(
    (pull) =>
      pull.base.ref === PRIMARY_BRANCH &&
      pull.base.repo.full_name === PILOT_REPOSITORY &&
      pull.head.ref === branch &&
      pull.head.repo.full_name === PILOT_REPOSITORY
  );
};

const coordinationMatches = (
  metadata: ReturnType<typeof parsePatchbackCommitMessage>,
  manifest: PatchbackManifest,
): boolean =>
  metadata.boundaryOid === manifest.boundaryOid &&
  metadata.line === manifest.authority.line &&
  JSON.stringify(metadata.migrationRecordPaths) ===
    JSON.stringify(manifest.migrationRecords.map(({ path }) => path)) &&
  metadata.recordPath === manifest.releaseRecord.path &&
  metadata.snapshotOid === manifest.authority.snapshotOid &&
  metadata.version === manifest.authority.version;

const treeEntries = async (
  token: string,
  oid: string,
): Promise<Map<string, { mode: string; oid: string; type: string }>> => {
  const response = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/git/trees/${oid}?recursive=1`,
    { token }
  );
  if (!isRecord(response) || !Array.isArray(response['tree'])) {
    throw new Error('GitHub tree response is malformed.');
  }
  if (response['truncated'] === true) {
    throw new Error('Patchback coordination tree is too large to verify exactly.');
  }
  const entries = response['tree'].map((entry) => {
    if (!isRecord(entry)) throw new Error('GitHub tree entry must be an object.');
    return {
      mode: stringValue(entry['mode'], 'GitHub tree entry mode'),
      path: stringValue(entry['path'], 'GitHub tree entry path'),
      sha: stringValue(entry['sha'], 'GitHub tree entry SHA'),
      type: stringValue(entry['type'], 'GitHub tree entry type'),
    };
  });
  return new Map<string, { mode: string; oid: string; type: string }>(
    entries
      .filter((entry) => entry.type === 'blob')
      .map((entry) => [
        entry.path,
        {
          mode: entry.mode,
          oid: entry.sha,
          type: entry.type,
        },
      ])
  );
};

const verifyCoordinationTree = async (
  token: string,
  commit: GitCommit,
  parent: GitCommit,
  manifest: PatchbackManifest,
): Promise<void> => {
  const [actual, base] = await Promise.all([
    treeEntries(token, commit.tree.sha),
    treeEntries(token, parent.tree.sha),
  ]);
  const paths = new Set([...actual.keys(), ...base.keys()]);
  const changed = [...paths].filter((path) => {
    const left = actual.get(path);
    const right = base.get(path);
    return (
      left?.mode !== right?.mode ||
      left?.oid !== right?.oid ||
      left?.type !== right?.type
    );
  });
  const records = [manifest.releaseRecord, ...manifest.migrationRecords];
  const allowed = new Set(records.map(({ path }) => path));
  if (
    !changed.includes(manifest.releaseRecord.path) ||
    changed.some((path) => !allowed.has(path))
  ) {
    throw new Error(
      'Patchback coordination commit must change only its release communication records.'
    );
  }
  for (const expected of records) {
    const record = actual.get(expected.path);
    if (record?.mode !== '100644' || record.type !== 'blob') {
      throw new Error(
        `Patchback coordination record is not one regular file: ${expected.path}`
      );
    }
    const blob = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/git/blobs/${record.oid}`,
      { token }
    );
    if (
      !isRecord(blob) ||
      blob['encoding'] !== 'base64' ||
      typeof blob['content'] !== 'string' ||
      Buffer.from(blob['content'].replaceAll('\n', ''), 'base64').toString(
        'utf8'
      ) !== expected.content
    ) {
      throw new Error(
        `Patchback coordination record changed after preparation: ${expected.path}`
      );
    }
  }
};

const findCoordinationCommit = async (
  token: string,
  headOid: string,
  manifest: PatchbackManifest,
): Promise<{ baseMainOid: string; oid: string }> => {
  let oid = fullOid(headOid, 'Patchback branch head');
  for (let depth = 0; depth < 500; depth += 1) {
    const commit = await getGitCommit(token, oid);
    try {
      const metadata = parsePatchbackCommitMessage(commit.message);
      if (coordinationMatches(metadata, manifest)) {
        if (commit.parents.length !== 1) {
          throw new Error('Patchback coordination commit must have exactly one parent.');
        }
        const firstParent = commit.parents[0];
        if (firstParent === undefined) {
          throw new Error('Patchback coordination commit has no parent.');
        }
        const parent = await getGitCommit(token, firstParent.sha);
        if (firstParent.sha !== metadata.baseMainOid) {
          throw new Error('Patchback coordination commit is not based on its recorded main.');
        }
        await verifyCoordinationTree(token, commit, parent, manifest);
        return { baseMainOid: metadata.baseMainOid, oid: commit.sha };
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('not a structured patchback coordination commit')
      ) {
        throw error;
      }
    }
    if (commit.parents.length === 0) {
      break;
    }
    const firstParent = commit.parents[0];
    if (firstParent === undefined) break;
    oid = firstParent.sha;
  }
  throw new Error('Patchback branch does not contain its structured coordination commit.');
};

const verifyMainAncestry = async (token: string, baseMainOid: string): Promise<void> => {
  const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
  if (main === null || main.type !== 'commit') {
    throw new Error('main does not identify a commit.');
  }
  const comparison = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/compare/${baseMainOid}...${main.oid}`,
    { token }
  );
  const mergeBase = isRecord(comparison) ? comparison['merge_base_commit'] : undefined;
  if (
    !isRecord(comparison) ||
    !['ahead', 'identical'].includes(String(comparison['status'])) ||
    !isRecord(mergeBase) ||
    mergeBase['sha'] !== baseMainOid
  ) {
    throw new Error('Patchback coordination is not based on an ancestor of current main.');
  }
};

const ensureExamplesComment = async (
  token: string,
  pullRequest: number,
  body: string,
): Promise<void> => {
  const comments: IssueComment[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/issues/${pullRequest}/comments?${query}`,
      { token }
    );
    if (!Array.isArray(batch)) {
      throw new Error('GitHub issue comments must be an array.');
    }
    comments.push(
      ...batch.map((comment) => {
        if (!isRecord(comment)) throw new Error('GitHub issue comment must be an object.');
        const commentBody = comment['body'];
        if (commentBody !== null && typeof commentBody !== 'string') {
          throw new Error('GitHub issue comment body must be text or null.');
        }
        return {
          body: commentBody,
          id: positiveInteger(comment['id'], 'GitHub issue comment ID'),
        };
      }),
    );
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
  const existing = matches[0];
  if (existing !== undefined && existing.body !== body) {
    await githubRequest(`/repos/${PILOT_REPOSITORY}/issues/comments/${existing.id}`, {
      body: { body },
      method: 'PATCH',
      token,
    });
  }
};

const assignNewPatchback = async (
  token: string,
  pullRequest: number,
  assignee: string | null,
): Promise<void> => {
  if (assignee === null) {
    console.log('The release PR has no assignable merger; patchback assignment was skipped.');
    return;
  }
  try {
    const issue = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/issues/${pullRequest}/assignees`,
      {
        body: { assignees: [assignee] },
        method: 'POST',
        token,
      }
    );
    const assignees = isRecord(issue) ? issue['assignees'] : undefined;
    if (
      !Array.isArray(assignees) ||
      !assignees.some(
        (candidate) => isRecord(candidate) && candidate['login'] === assignee,
      )
    ) {
      throw new Error(`GitHub did not assign ${assignee}.`);
    }
    console.log(`Assigned patchback #${pullRequest} to ${assignee}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `Patchback #${pullRequest} remains unassigned after best-effort assignment to ${assignee}: ${detail}`
    );
  }
};

const validateExistingPull = (
  pull: GitPullRequest,
  manifest: PatchbackManifest,
): void => {
  const body = pull.body;
  if (
    pull.base.ref !== PRIMARY_BRANCH ||
    pull.base.repo.full_name !== PILOT_REPOSITORY ||
    pull.head.ref !== manifest.branch ||
    pull.head.repo.full_name !== PILOT_REPOSITORY ||
    body === null ||
    !body.includes(PATCHBACK_BODY_MARKER) ||
    !body.includes(manifest.authority.snapshotOid) ||
    !body.includes(manifest.releaseRecord.path) ||
    !manifest.migrationRecords.every(({ path }) => body.includes(path)) ||
    !body.includes(`# Patchback for v${manifest.authority.version}`)
  ) {
    throw new Error('Existing patchback pull request does not match the authorized snapshot.');
  }
};

export async function applyPatchback(options: ApplyPatchbackOptions): Promise<void> {
  ensureTrustedMain();
  const manifest = validateManifest(
    await readJsonFile(resolve(requireOption(options, 'manifest')))
  );
  const token = requireControllerGitHubToken(options);
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
    const coordination = await findCoordinationCommit(token, pull.head.sha, manifest);
    await verifyMainAncestry(token, coordination.baseMainOid);
    await ensureExamplesComment(token, pull.number, manifest.comment);
    console.log(`Patchback #${pull.number} already exists; no action is required.`);
    return;
  }

  const branchRefName = `heads/${manifest.branch}`;
  let branch = await getRef(token, branchRefName);
  if (branch === null) {
    const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
    if (
      main === null ||
      main.type !== 'commit' ||
      main.oid !== manifest.baseMainOid
    ) {
      throw new Error('main advanced after patchback preparation; no branch was created.');
    }
    const mainCommit = await getGitCommit(token, main.oid);
    if (mainCommit.tree.sha !== manifest.baseMainTreeOid) {
      throw new Error('The prepared main tree changed before patchback creation.');
    }
    const communicationRecords = [
      manifest.releaseRecord,
      ...manifest.migrationRecords,
    ];
    const recordTree = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/trees`, {
      body: {
        base_tree: manifest.baseMainTreeOid,
        tree: communicationRecords.map(({ content, path }) => ({
          content,
          mode: '100644',
          path,
          type: 'blob',
        })),
      },
      method: 'POST',
      token,
    });
    if (!isRecord(recordTree)) {
      throw new Error('GitHub coordination tree response must be an object.');
    }
    const recordTreeSha = fullOid(recordTree['sha'], 'Patchback coordination tree');
    if (recordTreeSha === manifest.baseMainTreeOid) {
      throw new Error('Patchback release communication is already identical on main.');
    }
    const coordination = validatedGitCommitResponse(
      await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits`, {
        body: {
          message: manifest.coordinationMessage,
          parents: [manifest.baseMainOid],
          tree: recordTreeSha,
        },
        method: 'POST',
        token,
      }),
    );
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

  pull = validatedPullRequestResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls`, {
      body: {
        base: PRIMARY_BRANCH,
        body: manifest.body,
        draft: true,
        head: manifest.branch,
        maintainer_can_modify: false,
        title: manifest.title,
      },
      method: 'POST',
      token,
    }),
  );
  validateExistingPull(pull, manifest);

  await ensureExamplesComment(token, pull.number, manifest.comment);
  await assignNewPatchback(token, pull.number, manifest.authority.assignee);
  console.log(`Patchback #${pull.number} is open for ${manifest.authority.version}.`);
}
