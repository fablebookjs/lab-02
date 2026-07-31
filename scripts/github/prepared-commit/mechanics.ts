import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { ZERO_OID } from '../../shared/release-proposal/core.ts';
import { materializeVersion } from '../../shared/version/materialize.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import {
  getRef,
  githubRequest,
  PILOT_REPOSITORY,
  validatedGitCommitResponse,
} from '../release-repository/github.ts';
import type { GitCommit } from '../release-repository/github.ts';

const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';
const IMPORT_PREFIX = 'refs/release-pilot/imported/';

type RootManifest = {
  version?: string;
  workspaces?: string[];
};

type PublicPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
};

export type PreparedFile = Readonly<{
  content: string;
  path: string;
}>;

export type BundleRef = Readonly<{
  name: string;
  oid: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const stringRecord = (
  value: unknown,
  label: string,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must map names to versions.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, version]) => [
      name,
      stringValue(version, `${label}.${name}`),
    ]),
  );
};

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

export const ensureCleanReleaseRepository = async (): Promise<void> => {
  const { stdout } = await git(['rev-parse', '--show-toplevel']);
  if (resolve(stdout.trim()) !== resolve(repositoryRoot)) {
    throw new Error(
      'Release commands must run after the Lab-02 seed becomes the root of its own Git repository.',
    );
  }
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim()) {
    throw new Error('Release preparation requires a clean working tree.');
  }
};

export const commitParents = async (oid: string): Promise<string[]> => {
  const { stdout } = await git(['show', '-s', '--format=%P', oid]);
  return stdout.trim().split(/\s+/).filter(Boolean);
};

export const commitMessageAt = async (oid: string): Promise<string> => {
  const { stdout } = await git(['show', '-s', '--format=%B', oid]);
  return stdout.trimEnd();
};

export const manifestAt = async (oid: string, path: string): Promise<unknown> => {
  const { stdout } = await git(['show', `${oid}:${path}`]);
  const value: unknown = JSON.parse(stdout);
  return value;
};

const rootManifestValue = (value: unknown): RootManifest => {
  if (!isRecord(value)) throw new Error('Root package.json must contain one object.');
  const workspaces = value['workspaces'];
  if (
    workspaces !== undefined &&
    (!Array.isArray(workspaces) || workspaces.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error('Root package.json workspaces must be strings.');
  }
  return {
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
    ...(Array.isArray(workspaces)
      ? { workspaces: workspaces.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
};

const packageManifestValue = (value: unknown, path: string): PublicPackageManifest => {
  if (!isRecord(value)) throw new Error(`${path} must contain one object.`);
  const dependencies = stringRecord(value['dependencies'], `${path}.dependencies`);
  const devDependencies = stringRecord(
    value['devDependencies'],
    `${path}.devDependencies`,
  );
  const optionalDependencies = stringRecord(
    value['optionalDependencies'],
    `${path}.optionalDependencies`,
  );
  const peerDependencies = stringRecord(
    value['peerDependencies'],
    `${path}.peerDependencies`,
  );
  return {
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(typeof value['private'] === 'boolean' ? { private: value['private'] } : {}),
    ...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
  };
};

export const publicPackagesAt = async (
  oid: string,
): Promise<{
  packages: Array<{ manifest: PublicPackageManifest; name: string }>;
  root: RootManifest;
}> => {
  const root = rootManifestValue(await manifestAt(oid, 'package.json'));
  if (JSON.stringify(root.workspaces) !== JSON.stringify(['packages/*'])) {
    throw new Error('The release controller supports only the accepted packages/* seed workspace.');
  }
  const { stdout } = await git(['ls-tree', '-d', '--name-only', `${oid}:packages`]);
  const packages: Array<{ manifest: PublicPackageManifest; name: string }> = [];
  for (const directory of stdout.trim().split('\n').filter(Boolean)) {
    const manifestPath = `packages/${directory}/package.json`;
    const manifest = packageManifestValue(
      await manifestAt(oid, manifestPath),
      manifestPath,
    );
    if (manifest.private !== true) {
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`packages/${directory}/package.json has no package name.`);
      }
      packages.push({ manifest, name: manifest.name });
    }
  }
  return { packages, root };
};

export async function rootVersionAt(oid: string): Promise<string> {
  const manifest = rootManifestValue(await manifestAt(oid, 'package.json'));
  if (typeof manifest.version !== 'string') {
    throw new Error(`${oid} root package.json has no version.`);
  }
  return manifest.version;
}

export const validateVersionTree = async (
  oid: string,
  version: string,
): Promise<void> => {
  const { packages, root } = await publicPackagesAt(oid);
  if (root.version !== version || packages.length === 0) {
    throw new Error(`${oid} does not materialize root version ${version}.`);
  }
  const publicNames = new Set(packages.map(({ name }) => name));
  for (const pkg of packages) {
    if (pkg.manifest.version !== version) {
      throw new Error(`${pkg.name} does not materialize ${version}.`);
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
      for (const [name, dependencyVersion] of Object.entries(pkg.manifest[field] ?? {})) {
        if (publicNames.has(name) && dependencyVersion !== version) {
          throw new Error(`${pkg.name} has a non-lockstep dependency on ${name}.`);
        }
      }
    }
  }
};

export function validateFullOid(oid: unknown, label: string): asserts oid is string {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
}

export const uploadCommitObject = async (token: string, oid: string): Promise<string> => {
  const sourceOid = (await commitParents(oid))[0];
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
  const remoteTreeResponse = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/trees`, {
    body: { base_tree: sourceTree, tree },
    method: 'POST',
    token,
  });
  if (!isRecord(remoteTreeResponse)) {
    throw new Error('GitHub created-tree response must be an object.');
  }
  const remoteTreeSha = stringValue(remoteTreeResponse['sha'], 'GitHub created tree SHA');
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
  const message = await commitMessageAt(oid);
  const remoteCommit = validatedGitCommitResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits`, {
      body: {
        author: { date: authorDate, email: authorEmail, name: authorName },
        committer: {
          date: committerDate,
          email: committerEmail,
          name: committerName,
        },
        message,
        parents: [sourceOid],
        tree: remoteTreeSha,
      },
      method: 'POST',
      token,
    }),
  );
  validateFullOid(remoteCommit.sha, 'Uploaded GitHub commit');
  const sameIdentity = (
    remote: GitCommit['author'],
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

export const materializeCommit = async ({
  files = [],
  message,
  sourceOid,
  version,
}: {
  files?: readonly PreparedFile[];
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
    return (await git(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

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

export const importBundle = async (path: string): Promise<void> => {
  await git([
    'fetch',
    '--no-tags',
    path,
    `+${ARTIFACT_PREFIX}*:${IMPORT_PREFIX}*`,
  ]);
};

export const importedOid = async (bundleRef: string): Promise<string> => {
  if (!bundleRef.startsWith(ARTIFACT_PREFIX)) {
    throw new Error(`Unexpected bundle ref: ${bundleRef}`);
  }
  const imported = `${IMPORT_PREFIX}${bundleRef.slice(ARTIFACT_PREFIX.length)}`;
  return (await git(['rev-parse', imported])).stdout.trim();
};

export const prepareOutput = async (output: string): Promise<string> => {
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  return directory;
};

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
