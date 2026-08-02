import { parsePatchbackCommitMessage } from '../../shared/patchback/core.ts';
import type { PatchbackCommitMetadata } from '../../shared/patchback/core.ts';
import {
  createGitCommit,
  createGitTree,
  getGitCommit,
  getGitTreeEntries,
  readGitBlobText,
} from '../release-repository/commits.ts';
import type { ValidatedGitCommit } from '../release-repository/commits.ts';
import type { PatchbackManifest } from './manifest-schema.ts';

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const coordinationMatches = (
  metadata: PatchbackCommitMetadata,
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
  const entries = await getGitTreeEntries(token, oid);
  return new Map(
    entries
      .filter((entry) => entry.type === 'blob')
      .map((entry) => [
        entry.path,
        { mode: entry.mode, oid: entry.sha, type: entry.type },
      ]),
  );
};

const verifyCoordinationTree = async (
  token: string,
  commit: ValidatedGitCommit,
  parent: ValidatedGitCommit,
  manifest: PatchbackManifest,
): Promise<void> => {
  const [actual, base] = await Promise.all([
    treeEntries(token, commit.tree.sha),
    treeEntries(token, parent.tree.sha),
  ]);
  const changed = [...new Set([...actual.keys(), ...base.keys()])].filter((path) => {
    const left = actual.get(path);
    const right = base.get(path);
    return (
      left?.mode !== right?.mode || left?.oid !== right?.oid || left?.type !== right?.type
    );
  });
  const records = [manifest.releaseRecord, ...manifest.migrationRecords];
  const allowed = new Set(records.map(({ path }) => path));
  if (
    !changed.includes(manifest.releaseRecord.path) ||
    changed.some((path) => !allowed.has(path))
  ) {
    throw new Error(
      'Patchback coordination commit must change only its release communication records.',
    );
  }
  for (const expected of records) {
    const record = actual.get(expected.path);
    if (record?.mode !== '100644' || record.type !== 'blob') {
      throw new Error(
        `Patchback coordination record is not one regular file: ${expected.path}`,
      );
    }
    const content = await readGitBlobText(token, record.oid).catch(() => null);
    if (content !== expected.content) {
      throw new Error(
        `Patchback coordination record changed after preparation: ${expected.path}`,
      );
    }
  }
};

/**
 * Searches bounded first-parent history for the manifest-bound coordination
 * commit and verifies its parent and complete communication-only tree delta.
 */
export async function findPatchbackCoordinationCommit(
  token: string,
  headOid: string,
  manifest: PatchbackManifest,
): Promise<{ baseMainOid: string; oid: string }> {
  let oid = fullOid(headOid, 'Patchback branch head');
  for (let depth = 0; depth < 500; depth += 1) {
    const commit = await getGitCommit(token, oid);
    const metadata = parsePatchbackCommitMessage(commit.message);
    if (metadata !== null && coordinationMatches(metadata, manifest)) {
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
    const firstParent = commit.parents[0];
    if (firstParent === undefined) break;
    oid = firstParent.sha;
  }
  throw new Error('Patchback branch does not contain its structured coordination commit.');
}

/** Creates the single communication-only commit directly from the sealed manifest. */
export async function createPatchbackCoordinationCommit(
  token: string,
  manifest: PatchbackManifest,
): Promise<string> {
  const records = [manifest.releaseRecord, ...manifest.migrationRecords];
  const treeOid = fullOid(
    await createGitTree(token, {
      baseTreeOid: manifest.baseMainTreeOid,
      entries: records.map(({ content, path }) => ({
        content,
        mode: '100644',
        path,
        type: 'blob',
      })),
    }),
    'Patchback coordination tree',
  );
  if (treeOid === manifest.baseMainTreeOid) {
    throw new Error('Patchback release communication is already identical on main.');
  }
  const coordination = await createGitCommit(token, {
    message: manifest.coordinationMessage,
    parents: [manifest.baseMainOid],
    treeOid,
  });
  return coordination.sha;
}
