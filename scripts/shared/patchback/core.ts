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

export type PatchbackItem = {
  command: string;
  kind: 'direct-commit' | 'direct-merge' | 'pull-request';
  oid: string;
  pullRequest: number | null;
  subject: string;
};

type CanonicalPull = ReleaseHistoryPull;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
  return composeMigrationRecords(records).map(({ filename, title }) => ({
    content: sources.get(filename) ?? '',
    path: `${directory}/${filename}`,
    title,
  }));
}

export function releaseMergerAssignee(pull: unknown): string | null {
  const mergedBy = isRecord(pull) ? pull['merged_by'] : undefined;
  const login = isRecord(mergedBy) ? mergedBy['login'] : undefined;
  return typeof login === 'string' &&
    login.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)
    ? login
    : null;
}

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

export function parsePatchbackCommitMessage(message: unknown) {
  const trailers = Object.fromEntries(
    String(message ?? '')
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1], match[2]])
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
  const validated = {
    baseMainOid: metadata.baseMainOid,
    boundaryOid: metadata.boundaryOid,
    line: metadata.line,
    migrationRecordPaths: metadata.migrationRecordPaths,
    recordPath: metadata.recordPath,
    snapshotOid: metadata.snapshotOid,
    version: metadata.version,
  };
  if (
    typeof validated.baseMainOid !== 'string' ||
    typeof validated.boundaryOid !== 'string' ||
    typeof validated.line !== 'string' ||
    !Array.isArray(validated.migrationRecordPaths) ||
    typeof validated.recordPath !== 'string' ||
    typeof validated.snapshotOid !== 'string' ||
    typeof validated.version !== 'string'
  ) {
    throw new Error('Commit has malformed patchback coordination trailers.');
  }
  patchbackCommitMessage(validated);
  return validated;
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
