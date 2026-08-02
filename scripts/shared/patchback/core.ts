import { isRecord } from '../validation.ts';
import { parseReleaseLine, parseStableVersion } from '../release-proposal/core.ts';
import {
  composeMigrationRecords,
  extractReleaseRecordChanges,
  migrationRecordDirectory,
  releaseRecordPath,
} from '../release-communication/records.ts';
import type { ReleaseHistoryPull } from '../release-communication/records.ts';

export const PATCHBACK_FULL_OID_PATTERN_SOURCE = '[0-9a-f]{40}';

const fullOidPattern = new RegExp(`^${PATCHBACK_FULL_OID_PATTERN_SOURCE}$`);
const patchbackTrailerNames = [
  'Patchback-Version',
  'Patchback-Line',
  'Patchback-Snapshot',
  'Patchback-Boundary',
  'Patchback-Main-Base',
  'Patchback-Release-Record',
  'Patchback-Migration-Records',
];

export type PatchbackCommitMetadata = {
  baseMainOid: string;
  boundaryOid: string;
  line: string;
  migrationRecordPaths: string[];
  recordPath: string;
  snapshotOid: string;
  version: string;
};

/** One immutable product-history item for maintainer disposition in a patchback. */
export type PatchbackItem = {
  command: string;
  kind: 'direct-commit' | 'direct-merge' | 'pull-request';
  oid: string;
  pullRequest: number | null;
  subject: string;
};

type CanonicalPull = ReleaseHistoryPull;

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !fullOidPattern.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const cleanText = (value: unknown, fallback: string): string => {
  const text = (String(value ?? '').split(/\r?\n/, 1)[0] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || fallback).slice(0, 160);
};

/** Derives the canonical branch, line, and PR title for one stable version. */
export function patchbackIdentity(version: string): {
  branch: string;
  line: string;
  title: string;
} {
  const parsed = parseStableVersion(version);
  return {
    branch: `patchbacks/v${version}`,
    line: `v${parsed.major}.${parsed.minor}`,
    title: `Patch back v${version} to main`,
  };
}

export function previousReleaseVersion(version: string): string | null {
  const parsed = parseStableVersion(version);
  if (parsed.patch === 0) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
}

/** Validates and projects the exact generated release record into patchback content. */
export function patchbackReleaseRecord({
  source,
  version,
}: {
  source: unknown;
  version: string;
}): { content: string; path: string } {
  if (typeof source !== 'string') {
    throw new Error('Patchback release record must contain text.');
  }
  const path = releaseRecordPath(version);
  extractReleaseRecordChanges({ source, version });
  return { content: source, path };
}

/**
 * Validates migration records through the shared composition rules while
 * preserving their exact source text for synchronization.
 */
export function patchbackMigrationRecords({
  line,
  records,
}: {
  line: string;
  records: unknown;
}): Array<{ content: string; path: string; title: string }> {
  const directory = migrationRecordDirectory(line);
  if (!Array.isArray(records)) {
    throw new Error('Patchback migration records must be an array.');
  }
  const sources = new Map<string, string>();
  for (const record of records) {
    if (
      !isRecord(record) ||
      typeof record['filename'] !== 'string' ||
      typeof record['source'] !== 'string'
    ) {
      throw new Error('Patchback migration records must contain filename and source text.');
    }
    sources.set(record['filename'], record['source']);
  }
  return composeMigrationRecords(records, line).map(({ filename, title }) => ({
    content: sources.get(filename) ?? '',
    path: `${directory}/${filename}`,
    title,
  }));
}

/** Returns a syntactically safe merger login for best-effort assignment. */
export function releaseMergerAssignee(pull: unknown): string | null {
  const mergedBy = isRecord(pull) ? pull['merged_by'] : undefined;
  const login = isRecord(mergedBy) ? mergedBy['login'] : undefined;
  return typeof login === 'string' &&
    login.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)
    ? login
    : null;
}

/**
 * Narrows unique migration paths to one release-line directory; paths are
 * serialized into the coordination commit and must remain repository-relative.
 */
export const validatePatchbackMigrationRecordPaths = (
  paths: unknown,
  line: string,
): string[] => {
  const directory = `${migrationRecordDirectory(line)}/`;
  if (!Array.isArray(paths)) {
    throw new Error('Patchback migration record paths must be an array.');
  }
  const unique = new Set();
  for (const path of paths) {
    const filename = typeof path === 'string' ? path.slice(directory.length) : '';
    if (
      path !== `${directory}${filename}` ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(filename) ||
      unique.has(path)
    ) {
      throw new Error(`Invalid patchback migration record path: ${path}`);
    }
    unique.add(path);
  }
  return paths.filter((path): path is string => typeof path === 'string');
};

export type PatchbackMigrationSyncCandidate = {
  mainContent: string | null;
  path: string;
  previousContent: string | null;
  releaseContent: string;
};

export type PatchbackMigrationConflict = {
  content: string;
  path: string;
  title: string;
};

/**
 * Plans three-way Migration convergence. Missing, already-current, and
 * unchanged-since-boundary main files are safe; divergent main guidance is
 * preserved for explicit maintainer resolution.
 */
export function planPatchbackMigrationSync({
  candidates,
  exactPaths,
  line,
  version,
}: {
  candidates: readonly PatchbackMigrationSyncCandidate[];
  exactPaths: readonly string[];
  line: string;
  version: string;
}): {
  conflicts: PatchbackMigrationConflict[];
  records: Array<{ content: string; path: string; title: string }>;
} {
  const identity = patchbackIdentity(version);
  if (identity.line !== line) {
    throw new Error(`${version} does not belong to patchback line ${line}.`);
  }
  const paths = candidates.map(({ path }) => path);
  validatePatchbackMigrationRecordPaths(paths, line);
  const exact = new Set(validatePatchbackMigrationRecordPaths(exactPaths, line));
  if ([...exact].some((path) => !paths.includes(path))) {
    throw new Error('Patchback Migration candidates omit an exact release member.');
  }

  const directory = `${migrationRecordDirectory(line)}/`;
  const records: Array<{ content: string; path: string; title: string }> = [];
  const conflicts: PatchbackMigrationConflict[] = [];
  for (const candidate of candidates) {
    const filename = candidate.path.slice(directory.length);
    const [release] = composeMigrationRecords(
      [{ filename, source: candidate.releaseContent }],
      line,
    );
    if (release === undefined) {
      throw new Error(`Patchback Migration has no release content: ${candidate.path}`);
    }
    if (exact.has(candidate.path) !== (release.introducedIn === version)) {
      throw new Error(
        `Patchback Migration membership contradicts ${candidate.path}.`,
      );
    }
    if (candidate.previousContent !== null) {
      const [previous] = composeMigrationRecords(
        [{ filename, source: candidate.previousContent }],
        line,
      );
      if (
        previous === undefined ||
        previous.introducedIn !== release.introducedIn
      ) {
        throw new Error(
          `Released Migration identity changed at ${candidate.path}.`,
        );
      }
    }
    const safe =
      candidate.mainContent === null ||
      candidate.mainContent === candidate.releaseContent ||
      (candidate.previousContent !== null &&
        candidate.mainContent === candidate.previousContent);
    if (safe) {
      records.push({
        content: candidate.releaseContent,
        path: candidate.path,
        title: release.title,
      });
    } else {
      conflicts.push({
        content: candidate.releaseContent,
        path: candidate.path,
        title: release.title,
      });
    }
  }
  const sorted = (
    values: Array<{ content: string; path: string; title: string }>,
  ) =>
    patchbackMigrationRecords({
      line,
      records: values.map(({ content, path }) => ({
        filename: path.slice(directory.length),
        source: content,
      })),
    });
  return { conflicts: sorted(conflicts), records: sorted(records) };
}

/**
 * Encodes the immutable patchback coordination boundary and synchronized file
 * set as commit trailers. Product-change outcomes intentionally live elsewhere.
 */
export function patchbackCommitMessage({
  baseMainOid,
  boundaryOid,
  line,
  migrationRecordPaths: paths,
  recordPath,
  snapshotOid,
  version,
}: {
  baseMainOid: string;
  boundaryOid: string;
  line: string;
  migrationRecordPaths: string[];
  recordPath: string;
  snapshotOid: string;
  version: string;
}): string {
  fullOid(baseMainOid, 'Patchback main base');
  fullOid(boundaryOid, 'Patchback scope boundary');
  fullOid(snapshotOid, 'Patchback snapshot');
  parseReleaseLine(line);
  const identity = patchbackIdentity(version);
  if (identity.line !== line) {
    throw new Error(`${version} does not belong to patchback line ${line}.`);
  }
  if (recordPath !== releaseRecordPath(version)) {
    throw new Error(`Patchback release record must be ${releaseRecordPath(version)}.`);
  }
  validatePatchbackMigrationRecordPaths(paths, line);
  return [
    `patchback: coordinate v${version}`,
    '',
    `Patchback-Version: ${version}`,
    `Patchback-Line: ${line}`,
    `Patchback-Snapshot: ${snapshotOid}`,
    `Patchback-Boundary: ${boundaryOid}`,
    `Patchback-Main-Base: ${baseMainOid}`,
    `Patchback-Release-Record: ${recordPath}`,
    `Patchback-Migration-Records: ${paths.length === 0 ? 'none' : paths.join(',')}`,
  ].join('\n');
}

const patchbackTrailersFrom = (message: unknown): Record<string, string> =>
  Object.fromEntries(
    String(message ?? '')
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );

const patchbackCommitFrom = (
  availableTrailers: Record<string, string>,
): PatchbackCommitMetadata => {
  const trailers = Object.fromEntries(
    patchbackTrailerNames.map((name) => [name, availableTrailers[name]]),
  );
  const migrationPaths = trailers['Patchback-Migration-Records'];
  const metadata = {
    baseMainOid: trailers['Patchback-Main-Base'],
    boundaryOid: trailers['Patchback-Boundary'],
    line: trailers['Patchback-Line'],
    migrationRecordPaths:
      migrationPaths === undefined
        ? undefined
        : migrationPaths === 'none'
          ? []
          : migrationPaths.split(','),
    recordPath: trailers['Patchback-Release-Record'],
    snapshotOid: trailers['Patchback-Snapshot'],
    version: trailers['Patchback-Version'],
  };
  if (Object.values(metadata).some((value) => value === undefined)) {
    throw new Error('Commit is not a structured patchback coordination commit.');
  }
  if (
    typeof metadata.baseMainOid !== 'string' ||
    typeof metadata.boundaryOid !== 'string' ||
    typeof metadata.line !== 'string' ||
    !Array.isArray(metadata.migrationRecordPaths) ||
    typeof metadata.recordPath !== 'string' ||
    typeof metadata.snapshotOid !== 'string' ||
    typeof metadata.version !== 'string'
  ) {
    throw new Error('Commit has malformed patchback coordination trailers.');
  }
  const validated: PatchbackCommitMetadata = {
    baseMainOid: metadata.baseMainOid,
    boundaryOid: metadata.boundaryOid,
    line: metadata.line,
    migrationRecordPaths: metadata.migrationRecordPaths,
    recordPath: metadata.recordPath,
    snapshotOid: metadata.snapshotOid,
    version: metadata.version,
  };
  patchbackCommitMessage(validated);
  return validated;
};

/**
 * Returns `null` when a commit does not contain the complete Patchback
 * protocol; complete but malformed coordination metadata remains an error.
 */
export function parsePatchbackCommitMessage(
  message: unknown,
): PatchbackCommitMetadata | null {
  const trailers = patchbackTrailersFrom(message);
  if (patchbackTrailerNames.some((name) => !Object.hasOwn(trailers, name))) {
    return null;
  }
  return patchbackCommitFrom(trailers);
}

const canonicalPull = (
  pull: unknown,
  line: string,
  oid: string,
): pull is CanonicalPull => {
  if (!isRecord(pull) || typeof pull['number'] !== 'number') return false;
  return (
    Number.isSafeInteger(pull['number']) &&
    pull['number'] > 0 &&
    pull['merged'] === true &&
    pull['baseBranch'] === `releases/${line}` &&
    pull['canonicalRepository'] === true &&
    pull['mergeCommitOid'] === oid
  );
};

/**
 * Accounts for every first-parent entry before the authorized snapshot in
 * source order. Ambiguous PR metadata degrades to commit identity instead of
 * dropping work; merge commits receive an explicit mainline cherry-pick form.
 */
export function derivePatchbackItems({
  commits,
  line,
  snapshotOid,
}: {
  commits: unknown;
  line: string;
  snapshotOid: string;
}): PatchbackItem[] {
  parseReleaseLine(line);
  fullOid(snapshotOid, 'Patchback snapshot');
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error('Patchback scope must include the authorized snapshot boundary commit.');
  }
  if (commits.at(-1)?.oid !== snapshotOid) {
    throw new Error('Patchback scope does not end at the authorized snapshot.');
  }

  return commits.slice(0, -1).map((commit) => {
    if (!isRecord(commit)) {
      throw new Error('Every patchback commit must be an object.');
    }
    const oid = fullOid(commit['oid'], 'Patchback item');
    const rawParents = commit['parents'];
    if (rawParents !== undefined && !Array.isArray(rawParents)) {
      throw new Error(`Patchback item ${oid} has invalid parents.`);
    }
    const parents = (rawParents ?? []).map((parent) => fullOid(parent, 'Commit parent'));
    if (parents.length === 0) {
      throw new Error(`Patchback item ${oid} has no first parent.`);
    }
    const rawPulls = commit['associatedPulls'];
    if (rawPulls !== undefined && !Array.isArray(rawPulls)) {
      throw new Error(`Patchback item ${oid} has invalid pull request metadata.`);
    }
    const associated = (rawPulls ?? []).filter((pull): pull is CanonicalPull =>
      canonicalPull(pull, line, oid)
    );
    const pull = associated.length === 1 ? associated[0] : null;
    const merge = parents.length > 1;
    const command = `git cherry-pick ${merge ? '-m 1 ' : ''}${oid}`;
    const subject = cleanText(
      pull?.title ?? commit['subject'],
      pull ? `Pull request #${pull.number}` : `Commit ${oid.slice(0, 12)}`
    );

    return {
      command,
      kind: pull ? 'pull-request' : merge ? 'direct-merge' : 'direct-commit',
      oid,
      pullRequest: pull?.number ?? null,
      subject,
    };
  });
}
