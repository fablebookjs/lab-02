import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  commitMessageAt,
  commitParents,
  validateFullOid,
} from '../../shared/prepared-commit/inspection.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { ZERO_OID } from '../../shared/release-proposal/core.ts';
import { materializeVersion } from '../../shared/version/materialize.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import {
  createGitCommit,
  createGitTree,
} from '../release-repository/commits.ts';
import type { ValidatedGitCommit } from '../release-repository/commits.ts';
import { getRef } from '../release-repository/refs.ts';

const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';
const IMPORT_PREFIX = 'refs/release-pilot/imported/';

/** One exact inert artifact ref and the local commit it must advertise. */
export type BundleRef = Readonly<{
  name: string;
  oid: string;
}>;

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

/**
 * Recreates a locally prepared single-parent commit through GitHub's Git API and
 * verifies tree, parent, message, author, and committer preservation before use.
 */
export const uploadCommitObject = async (token: string, oid: string): Promise<string> => {
  const sourceOid = (await commitParents(repositoryRoot, oid))[0];
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

  const tree: Array<{
    content: string;
    mode: string;
    path: string;
    type: string;
  }> = [];
  for (const path of changedPaths) {
    const entry = (await git(['ls-tree', oid, '--', path])).stdout.trim();
    const match = /^(\d{6}) (blob) [0-9a-f]{40}\t(.+)$/.exec(entry);
    const mode = match?.[1];
    const type = match?.[2];
    if (mode === undefined || type === undefined || match?.[3] !== path) {
      throw new Error(`Prepared commit has an unsupported tree entry: ${entry}`);
    }
    tree.push({
      content: (await git(['show', `${oid}:${path}`])).stdout,
      mode,
      path,
      type,
    });
  }

  const sourceTree = (await git(['show', '-s', '--format=%T', sourceOid])).stdout.trim();
  const expectedTree = (await git(['show', '-s', '--format=%T', oid])).stdout.trim();
  const remoteTreeSha = await createGitTree(token, {
    baseTreeOid: sourceTree,
    entries: tree,
  });
  if (remoteTreeSha !== expectedTree) {
    throw new Error(`GitHub created tree ${remoteTreeSha}, expected ${expectedTree}.`);
  }

  const identity = (
    await git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', oid])
  ).stdout.trimEnd().split('\0');
  if (identity.length !== 6 || identity.some((value) => value.length === 0)) {
    throw new Error(`Prepared commit ${oid} has incomplete author or committer metadata.`);
  }
  const authorName = stringValue(identity[0], 'Prepared author name');
  const authorEmail = stringValue(identity[1], 'Prepared author email');
  const authorDate = stringValue(identity[2], 'Prepared author date');
  const committerName = stringValue(identity[3], 'Prepared committer name');
  const committerEmail = stringValue(identity[4], 'Prepared committer email');
  const committerDate = stringValue(identity[5], 'Prepared committer date');
  const message = await commitMessageAt(repositoryRoot, oid);
  const remoteCommit = await createGitCommit(token, {
    author: { date: authorDate, email: authorEmail, name: authorName },
    committer: {
      date: committerDate,
      email: committerEmail,
      name: committerName,
    },
    message,
    parents: [sourceOid],
    treeOid: remoteTreeSha,
  });
  validateFullOid(remoteCommit.sha, 'Uploaded GitHub commit');
  const sameIdentity = (
    remote: ValidatedGitCommit['author'],
    name: string,
    email: string,
    date: string,
  ): boolean =>
    remote.name === name &&
    remote.email === email &&
    Number.isFinite(Date.parse(remote.date)) &&
    Date.parse(remote.date) === Date.parse(date);
  if (
    remoteCommit.message !== message ||
    remoteCommit.tree?.sha !== expectedTree ||
    remoteCommit.parents.length !== 1 ||
    remoteCommit.parents[0]?.sha !== sourceOid ||
    !sameIdentity(remoteCommit.author, authorName, authorEmail, authorDate) ||
    !sameIdentity(remoteCommit.committer, committerName, committerEmail, committerDate)
  ) {
    throw new Error(`GitHub did not preserve the prepared commit ${oid}.`);
  }
  return remoteCommit.sha;
};

const preparedPath = (path: string): string => {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Prepared file path is unsafe: ${path}`);
  }
  if (
    path === 'package.json' ||
    path === 'package-lock.json' ||
    /^packages\/[^/]+\/package\.json$/.test(path)
  ) {
    throw new Error(`Prepared file path overlaps version materialization: ${path}`);
  }
  return path;
};

/**
 * Creates an inert versioned commit in a disposable worktree. Only lockstep
 * version files and explicitly supplied safe paths may differ from the source.
 */
export const materializeCommit = async ({
  files = [],
  message,
  sourceOid,
  version,
}: {
  files?: readonly Readonly<{ content: string; path: string }>[];
  message: string;
  sourceOid: string;
  version: string;
}): Promise<string> => {
  const additionalFiles = files.map(({ content, path }) => ({
    content,
    path: preparedPath(path),
  }));
  const additionalPaths = new Set(additionalFiles.map(({ path }) => path));
  if (additionalPaths.size !== additionalFiles.length) {
    throw new Error('Prepared file paths must be unique.');
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-prepared-commit-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, sourceOid]);
    added = true;
    await materializeVersion(worktree, version);
    await git(['add', 'package.json', 'package-lock.json', 'packages'], { cwd: worktree });
    for (const file of additionalFiles) {
      const target = join(worktree, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
      await git(['add', file.path], { cwd: worktree });
    }

    const changed = (await git(['diff', '--cached', '--name-only'], { cwd: worktree })).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (
      changed.length === 0 ||
      changed.some(
        (path) =>
          !additionalPaths.has(path) &&
          path !== 'package.json' &&
          path !== 'package-lock.json' &&
          !/^packages\/[^/]+\/package\.json$/.test(path),
      ) ||
      [...additionalPaths].some((path) => !changed.includes(path))
    ) {
      throw new Error(`Release materialization changed unexpected files: ${changed.join(', ')}`);
    }

    const identity = {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'release-app@users.noreply.github.com',
      GIT_AUTHOR_NAME: 'fablebook-release-app[bot]',
      GIT_COMMITTER_EMAIL: 'release-app@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'fablebook-release-app[bot]',
    };
    await git(['commit', '--no-gpg-sign', '-m', message], { cwd: worktree, env: identity });
    return resolveHeadOid(worktree);
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

/** Writes an object bundle with only temporary, explicitly named artifact refs. */
export async function writeBundle(path: string, refs: readonly BundleRef[]): Promise<void> {
  for (const { name, oid } of refs) {
    await git(['update-ref', name, oid, ZERO_OID]);
  }
  try {
    await git(['bundle', 'create', path, ...refs.map(({ name }) => name)]);
  } finally {
    await Promise.all(refs.map(({ name, oid }) => git(['update-ref', '-d', name, oid])));
  }
}

/**
 * Imports a prepared bundle only when its advertised ref/OID set exactly matches
 * the transition. Extra heads and unexpected namespaces are rejected.
 */
export const importBundle = async (
  path: string,
  expectedRefs: readonly BundleRef[],
): Promise<void> => {
  const { stdout } = await git(['bundle', 'list-heads', path]);
  const advertisedRefs = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(' ');
      if (separator === -1) {
        throw new Error(`Malformed bundle head: ${line}`);
      }
      const oid = line.slice(0, separator);
      const name = line.slice(separator + 1);
      validateFullOid(oid, `Bundle ref ${name}`);
      return { name, oid };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const expected = [...expectedRefs]
    .map(({ name, oid }) => {
      if (!name.startsWith(ARTIFACT_PREFIX)) {
        throw new Error(`Unexpected bundle ref: ${name}`);
      }
      validateFullOid(oid, `Expected bundle ref ${name}`);
      return { name, oid };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(advertisedRefs) !== JSON.stringify(expected)) {
    throw new Error('Bundle refs do not exactly match the prepared transition.');
  }
  await git([
    'fetch',
    '--no-tags',
    path,
    `+${ARTIFACT_PREFIX}*:${IMPORT_PREFIX}*`,
  ]);
  for (const { name, oid } of expected) {
    const imported = `${IMPORT_PREFIX}${name.slice(ARTIFACT_PREFIX.length)}`;
    const importedOid = (await git(['rev-parse', imported])).stdout.trim();
    if (importedOid !== oid) {
      throw new Error(`Imported bundle ref ${name} does not match its prepared OID.`);
    }
  }
};

export const prepareOutput = async (output: string): Promise<string> => {
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  return directory;
};

/** Fails a guarded application when a live ref changed after preparation. */
export const assertExpectedRef = async (
  token: string,
  ref: string,
  expectedOid: string | null,
): Promise<void> => {
  const live = await getRef(token, ref);
  if ((live?.oid ?? null) !== expectedOid) {
    throw new Error(`${ref} changed after preparation.`);
  }
};
