import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  derivePatchbackItems,
  planPatchbackMigrationSync,
  patchbackCommitMessage,
  patchbackIdentity,
  patchbackReleaseRecord,
  previousReleaseVersion,
  releaseMergerAssignee,
} from '../../shared/patchback/core.ts';
import { deriveReleaseAuthority } from '../../shared/release-publication/core.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import {
  loadMigrationRecords,
  migrationRecordsForVersion,
  migrationRecordDirectory,
  releaseRecordPath,
} from '../../shared/release-communication/records.ts';
import { parseStableVersion } from '../../shared/release-proposal/core.ts';
import { run } from '../../shared/process/run.ts';
import { isRecord } from '../../shared/validation.ts';
import {
  compareGitCommits,
  getGitCommit,
  getGitTreeEntries,
  readGitBlobText,
} from '../release-repository/commits.ts';
import {
  createGitRef,
  getRef,
  resolveRefObject,
} from '../release-repository/refs.ts';
import { getReleaseByTag } from '../release-repository/releases.ts';
import {
  assignPullRequest,
  createDraftPatchbackPr,
  ensurePullRequestLabels,
  getPullRequest,
  isCanonicalReleasePull,
  listPullRequests,
  reconcileUniqueMarkedIssueComment,
} from '../release-repository/pull-requests.ts';
import type { GitPullRequest } from '../release-repository/pull-requests.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import { requireControllerGitHubToken } from '../controller-inputs.ts';
import {
  findReleaseCut,
  firstParentCommitFacts,
} from '../release-history/history.ts';
import { parsePatchbackAuthority } from './authority-schema.ts';
import type { PatchbackAuthority } from './authority-schema.ts';
import { parsePatchbackManifest } from './manifest-schema.ts';
import type { PatchbackManifest } from './manifest-schema.ts';
import {
  createPatchbackCoordinationCommit,
  findPatchbackCoordinationCommit,
} from './coordination.ts';
import {
  PATCHBACK_BODY_MARKER,
  PATCHBACK_COMMENT_MARKER,
  PATCHBACK_EXAMPLES_COMMENT,
  renderPatchbackPrBody,
} from './templates.ts';

export type PatchbackResolution =
  | { patchback: false }
  | {
      patchback: true;
      snapshot: string;
      version: string;
    };

const PATCHBACK_RELEASE_LABELS = ['qa:skip', 'release-note:skip'];

/** Applies public-release exclusions only while a Patchback PR is mutable. */
export const reconcilePatchbackLabels = (
  token: string,
  pull: GitPullRequest,
): Promise<GitPullRequest> =>
  pull.state === 'open'
    ? ensurePullRequestLabels(token, pull, PATCHBACK_RELEASE_LABELS)
    : Promise.resolve(pull);

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

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
    throw new Error(
      'Patchback authority is restricted to trusted main in the pilot repository.',
    );
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

/**
 * Re-reads a release signal under trusted main, derives live stable authority,
 * and emits an inert authority artifact or an expected no-op result.
 */
export async function resolvePatchback(options: {
  'github-token': string;
  output: string;
  signal: string;
}): Promise<PatchbackResolution> {
  ensureTrustedMain();
  const signal = await readJsonFile(resolve(requireOption(options, 'signal')));
  const output = resolve(requireOption(options, 'output'));
  if (!isRecord(signal)) {
    throw new Error(
      'Release signal does not contain one positive pull request number.',
    );
  }
  const pullRequest = positiveInteger(
    signal['pullRequest'],
    'Release signal pull request',
  );

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

const migrationChangesBetween = async (
  root: string,
  line: string,
  boundaryOid: string,
  snapshotOid: string,
): Promise<string[]> => {
  const directory = migrationRecordDirectory(line);
  const { stdout } = await run(
    'git',
    [
      'diff',
      '--name-status',
      '--find-renames',
      boundaryOid,
      snapshotOid,
      '--',
      directory,
    ],
    { cwd: root },
  );
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((entry) => {
      const fields = entry.split('\t');
      const status = fields[0] ?? '';
      const path = fields.at(-1) ?? '';
      if (status.startsWith('D') || status.startsWith('R')) {
        throw new Error(
          `Released Migration paths cannot be deleted or renamed: ${entry}`,
        );
      }
      if (!status.startsWith('A') && !status.startsWith('M')) {
        throw new Error(`Unsupported Migration history change: ${entry}`);
      }
      if (!path.startsWith(`${directory}/`) || !path.endsWith('.md')) {
        throw new Error(`Invalid Migration history path: ${path}`);
      }
      return path;
    });
};

const fileAt = async (
  root: string,
  oid: string,
  path: string,
): Promise<string | null> => {
  try {
    return (await run('git', ['show', `${oid}:${path}`], { cwd: root })).stdout;
  } catch {
    return null;
  }
};

const loadPatchbackMigrationPlan = async ({
  boundaryOid,
  line,
  mainTreeOid,
  root,
  snapshotOid,
  token,
  version,
}: {
  boundaryOid: string;
  line: string;
  mainTreeOid: string;
  root: string;
  snapshotOid: string;
  token: string;
  version: string;
}) => {
  const exactPaths = migrationRecordsForVersion(
    await loadMigrationRecords(root, line),
    version,
  ).map(({ filename }) => `${migrationRecordDirectory(line)}/${filename}`);
  const changedPaths = await migrationChangesBetween(
    root,
    line,
    boundaryOid,
    snapshotOid,
  );
  const paths = [...new Set([...exactPaths, ...changedPaths])];
  const mainEntries = new Map(
    (await getGitTreeEntries(token, mainTreeOid)).map((entry) => [entry.path, entry]),
  );
  const candidates = await Promise.all(
    paths.map(async (path) => {
      const mainEntry = mainEntries.get(path);
      if (
        mainEntry !== undefined &&
        (mainEntry.mode !== '100644' || mainEntry.type !== 'blob')
      ) {
        throw new Error(`main Migration path is not one regular file: ${path}`);
      }
      return {
        mainContent:
          mainEntry === undefined
            ? null
            : await readGitBlobText(token, mainEntry.sha),
        path,
        previousContent: await fileAt(root, boundaryOid, path),
        releaseContent: await readFile(join(root, path), 'utf8'),
      };
    }),
  );
  return planPatchbackMigrationSync({
    candidates,
    exactPaths,
    line,
    version,
  });
};

/**
 * Builds the complete immutable patchback manifest from the authorized snapshot,
 * current main, and first-parent release history without mutating GitHub.
 */
export async function preparePatchback(options: {
  authority: string;
  controller: string;
  'github-token': string;
  output: string;
  snapshot: string;
}): Promise<void> {
  ensureTrustedMain();
  const controller = resolve(requireOption(options, 'controller'));
  const snapshot = resolve(requireOption(options, 'snapshot'));
  const output = resolve(requireOption(options, 'output'));
  const authority = parsePatchbackAuthority(
    await readJsonFile(resolve(requireOption(options, 'authority'))),
  );
  if ((await resolveHeadOid(snapshot)) !== authority.snapshotOid) {
    throw new Error(
      'The checked-out snapshot does not match patchback authority.',
    );
  }

  const token = requireControllerGitHubToken(options);
  const parsed = parseStableVersion(authority.version);
  let boundary: { label: string; oid: string } | null;
  if (parsed.patch === 0) {
    const cut = await findReleaseCut(controller, authority.line);
    boundary = {
      label: `release cut for ${authority.line}`,
      oid: cut.sourceOid,
    };
  } else {
    boundary = await previousCompletedSnapshot(token, authority.version);
  }
  if (boundary === null) {
    throw new Error(
      `Patchback ${authority.version} has no previous completed snapshot.`,
    );
  }
  fullOid(boundary.oid, 'Patchback boundary');

  const scopeCommits = await firstParentCommitFacts(snapshot, token, {
    boundaryOid: boundary.oid,
    headOid: authority.snapshotOid,
    label: 'patchback snapshot',
  });
  if (scopeCommits.at(-1)?.oid !== authority.snapshotOid) {
    throw new Error(
      'The authorized snapshot does not close its patchback scope.',
    );
  }
  const productCommits = scopeCommits.slice(0, -1);
  const items = derivePatchbackItems({
    commits: [
      ...productCommits,
      {
        associatedPulls: [],
        oid: authority.snapshotOid,
        parents: [],
        subject: '',
      },
    ],
    line: authority.line,
    snapshotOid: authority.snapshotOid,
  });
  const recordPath = releaseRecordPath(authority.version);
  const releaseRecord = patchbackReleaseRecord({
    source: await readFile(join(snapshot, recordPath), 'utf8'),
    version: authority.version,
  });

  const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
  if (main === null || main.type !== 'commit') {
    throw new Error('main does not identify a commit.');
  }
  const mainCommit = await getGitCommit(token, main.oid);
  const migrationPlan = await loadPatchbackMigrationPlan({
    boundaryOid: boundary.oid,
    line: authority.line,
    mainTreeOid: mainCommit.tree.sha,
    root: snapshot,
    snapshotOid: authority.snapshotOid,
    token,
    version: authority.version,
  });
  const identity = patchbackIdentity(authority.version);
  const manifest = parsePatchbackManifest({
    authority,
    baseMainOid: main.oid,
    baseMainTreeOid: mainCommit.tree.sha,
    body: renderPatchbackPrBody({
      boundaryLabel: boundary.label,
      boundaryOid: boundary.oid,
      items,
      line: authority.line,
      migrationConflicts: migrationPlan.conflicts,
      migrationRecords: migrationPlan.records,
      recordPath: releaseRecord.path,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    }),
    boundaryLabel: boundary.label,
    boundaryOid: boundary.oid,
    branch: identity.branch,
    comment: PATCHBACK_EXAMPLES_COMMENT,
    coordinationMessage: patchbackCommitMessage({
      baseMainOid: main.oid,
      boundaryOid: boundary.oid,
      line: authority.line,
      migrationRecordPaths: migrationPlan.records.map(({ path }) => path),
      recordPath: releaseRecord.path,
      snapshotOid: authority.snapshotOid,
      version: authority.version,
    }),
    items,
    migrationConflicts: migrationPlan.conflicts,
    migrationRecords: migrationPlan.records,
    releaseRecord,
    repository: PILOT_REPOSITORY,
    schema: 4,
    title: identity.title,
  });
  await mkdir(output, { recursive: true });
  await writeJsonFile(join(output, 'patchback.json'), manifest);
  console.log(
    `Prepared ${items.length} patchback item(s) for ${authority.version}.`,
  );
}

const listPatchbackPulls = async (
  token: string,
  branch: string,
): Promise<GitPullRequest[]> => {
  const pulls = await listPullRequests(token, {
    head: `fablebookjs:${branch}`,
  });
  return pulls.filter(
    (pull) =>
      pull.base.ref === PRIMARY_BRANCH &&
      pull.base.repo.full_name === PILOT_REPOSITORY &&
      pull.head.ref === branch &&
      pull.head.repo.full_name === PILOT_REPOSITORY,
  );
};

const verifyMainAncestry = async (
  token: string,
  baseMainOid: string,
): Promise<void> => {
  const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
  if (main === null || main.type !== 'commit') {
    throw new Error('main does not identify a commit.');
  }
  const comparison = await compareGitCommits(token, baseMainOid, main.oid);
  if (
    !['ahead', 'identical'].includes(comparison.status) ||
    comparison.mergeBaseOid !== baseMainOid
  ) {
    throw new Error(
      'Patchback coordination is not based on an ancestor of current main.',
    );
  }
};

const assignNewPatchback = async (
  token: string,
  pullRequest: number,
  assignee: string | null,
): Promise<void> => {
  if (assignee === null) {
    console.log(
      'The release PR has no assignable merger; patchback assignment was skipped.',
    );
    return;
  }
  try {
    await assignPullRequest(token, pullRequest, assignee);
    console.log(`Assigned patchback #${pullRequest} to ${assignee}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `Patchback #${pullRequest} remains unassigned after best-effort assignment to ${assignee}: ${detail}`,
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
    !manifest.migrationConflicts.every(({ path }) => body.includes(path)) ||
    !body.includes(`# Patchback for v${manifest.authority.version}`)
  ) {
    throw new Error(
      'Existing patchback pull request does not match the authorized snapshot.',
    );
  }
};

/**
 * Revalidates live authority, then query-first creates or verifies the
 * coordination commit, branch, draft PR, assignment, and marked help comment.
 * Existing terminal PRs and contradictory branch state are never rewritten.
 */
export async function applyPatchback(options: {
  'github-token': string;
  manifest: string;
}): Promise<void> {
  ensureTrustedMain();
  const manifest = parsePatchbackManifest(
    await readJsonFile(resolve(requireOption(options, 'manifest'))),
  );
  const token = requireControllerGitHubToken(options);
  compareAuthority(
    await readLiveAuthority(token, manifest.authority.pullRequest),
    manifest.authority,
  );

  const pulls = await listPatchbackPulls(token, manifest.branch);
  if (pulls.length > 1) {
    throw new Error(
      `${manifest.branch} has more than one canonical pull request.`,
    );
  }
  let pull = pulls[0] ?? null;
  const existingPull = pull !== null;
  if (pull !== null) {
    validateExistingPull(pull, manifest);
    const coordination = await findPatchbackCoordinationCommit(
      token,
      pull.head.sha,
      manifest,
    );
    await verifyMainAncestry(token, coordination.baseMainOid);
  } else {
    const branchRefName = `heads/${manifest.branch}`;
    let branch = await getRef(token, branchRefName);
    if (branch === null) {
      const main = await getRef(token, `heads/${PRIMARY_BRANCH}`);
      if (
        main === null ||
        main.type !== 'commit' ||
        main.oid !== manifest.baseMainOid
      ) {
        throw new Error(
          'main advanced after patchback preparation; no branch was created.',
        );
      }
      const mainCommit = await getGitCommit(token, main.oid);
      if (mainCommit.tree.sha !== manifest.baseMainTreeOid) {
        throw new Error(
          'The prepared main tree changed before patchback creation.',
        );
      }
      const coordinationOid = await createPatchbackCoordinationCommit(
        token,
        manifest,
      );
      await createGitRef(token, `refs/${branchRefName}`, coordinationOid);
      branch = { oid: coordinationOid, type: 'commit' };
    }
    if (branch.type !== 'commit') {
      throw new Error(`${manifest.branch} does not identify a commit.`);
    }
    const coordination = await findPatchbackCoordinationCommit(
      token,
      branch.oid,
      manifest,
    );
    await verifyMainAncestry(token, coordination.baseMainOid);

    pull = await createDraftPatchbackPr(token, {
      body: manifest.body,
      branch: manifest.branch,
      title: manifest.title,
    });
    validateExistingPull(pull, manifest);
  }

  pull = await reconcilePatchbackLabels(token, pull);

  await reconcileUniqueMarkedIssueComment(
    token,
    pull.number,
    PATCHBACK_COMMENT_MARKER,
    manifest.comment,
  );
  if (existingPull) {
    console.log(
      `Patchback #${pull.number} already exists; no action is required.`,
    );
    return;
  }
  await assignNewPatchback(token, pull.number, manifest.authority.assignee);
  console.log(
    `Patchback #${pull.number} is open for ${manifest.authority.version}.`,
  );
}
