import {
  inspectPatchbackPrBody,
  type PatchbackInspectionItem,
} from './body.ts';
import {
  parsePatchbackCommitMessage,
  patchbackIdentity,
} from './core.ts';
import { PILOT_REPOSITORY } from '../repository.ts';
import { isRecord } from '../validation.ts';

export type PatchbackCheckInspection = {
  conclusion: string | null;
  detailsUrl: string | null;
  name: string;
  status: string | null;
  workflowName: string | null;
};

export type PatchbackInspectionReport = {
  base: string | null;
  checks: PatchbackCheckInspection[];
  coordinationCommit: string | null;
  diagnostics: string[];
  draft: boolean | null;
  head: string | null;
  headOid: string | null;
  items: PatchbackInspectionItem[];
  markerVersion: number | null;
  mergeCommit: string | null;
  mergeable: string | null;
  mergedAt: string | null;
  number: number | null;
  queueResolved: boolean;
  repository: typeof PILOT_REPOSITORY;
  scopeBoundary: string | null;
  snapshot: string | null;
  state: string | null;
  title: string | null;
  url: string | null;
  valid: boolean;
  version: string | null;
};

const nullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const latestChecks = (value: unknown): PatchbackCheckInspection[] => {
  if (!Array.isArray(value)) return [];
  const latest = new Map<
    string,
    PatchbackCheckInspection & { timestamp: number }
  >();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const name =
      nullableString(candidate['name']) ?? nullableString(candidate['context']);
    if (name === null) continue;
    const startedAt = nullableString(candidate['startedAt']);
    const completedAt = nullableString(candidate['completedAt']);
    const timestamp = Date.parse(startedAt ?? completedAt ?? '') || 0;
    const previous = latest.get(name);
    if (previous === undefined || timestamp >= previous.timestamp) {
      latest.set(name, {
        conclusion: nullableString(candidate['conclusion']),
        detailsUrl:
          nullableString(candidate['detailsUrl']) ??
          nullableString(candidate['targetUrl']),
        name,
        status: nullableString(candidate['status']),
        timestamp,
        workflowName: nullableString(candidate['workflowName']),
      });
    }
  }
  return [...latest.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ timestamp: _timestamp, ...check }) => check);
};

const commitRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * Validates one untrusted `gh pr view --json` observation and returns the
 * complete machine-readable report consumed by the local Patchback skill.
 */
export function inspectPatchbackPullRequest(
  value: unknown,
): PatchbackInspectionReport {
  const pull = isRecord(value) ? value : {};
  const body = inspectPatchbackPrBody(pull['body']);
  const diagnostics = [...body.diagnostics];
  if (!isRecord(value)) {
    diagnostics.push('GitHub pull request observation is not an object');
  }

  const base = nullableString(pull['baseRefName']);
  const head = nullableString(pull['headRefName']);
  const title = nullableString(pull['title']);
  if (body.version !== null) {
    const identity = patchbackIdentity(body.version);
    if (base !== 'main') diagnostics.push('base branch is not main');
    if (head !== identity.branch) {
      diagnostics.push('head branch does not match the patch-back version');
    }
    if (title !== identity.title) {
      diagnostics.push('title does not match the patch-back version');
    }
  }

  const coordination = commitRecords(pull['commits']).find(
    (commit) =>
      commit['messageHeadline'] ===
      `patchback: coordinate v${body.version ?? ''}`,
  );
  let coordinationMetadata: ReturnType<typeof parsePatchbackCommitMessage> = null;
  let coordinationMalformed = false;
  if (coordination === undefined) {
    diagnostics.push('structured coordination commit is absent from the PR');
  } else {
    try {
      coordinationMetadata = parsePatchbackCommitMessage(
        coordination['messageBody'],
      );
    } catch {
      coordinationMalformed = true;
      diagnostics.push('structured coordination commit has malformed metadata');
    }
    if (coordinationMetadata === null && !coordinationMalformed) {
      diagnostics.push('structured coordination commit has incomplete metadata');
    }
  }

  if (
    body.version !== null &&
    coordinationMetadata !== null &&
    coordinationMetadata.version !== body.version
  ) {
    diagnostics.push('coordination commit version does not match the body');
  }
  if (
    body.snapshot !== null &&
    coordinationMetadata !== null &&
    coordinationMetadata.snapshotOid !== body.snapshot
  ) {
    diagnostics.push('coordination commit snapshot does not match the body');
  }
  if (
    body.scopeBoundary !== null &&
    coordinationMetadata !== null &&
    coordinationMetadata.boundaryOid !== body.scopeBoundary
  ) {
    diagnostics.push('coordination commit boundary does not match the body');
  }
  if (
    body.version !== null &&
    coordinationMetadata !== null &&
    coordinationMetadata.line !== patchbackIdentity(body.version).line
  ) {
    diagnostics.push('coordination commit line does not match the body');
  }

  const mergeCommit = isRecord(pull['mergeCommit'])
    ? nullableString(pull['mergeCommit']['oid'])
    : null;
  const items = body.items;
  return {
    base,
    checks: latestChecks(pull['statusCheckRollup']),
    coordinationCommit:
      coordination === undefined ? null : nullableString(coordination['oid']),
    diagnostics,
    draft: typeof pull['isDraft'] === 'boolean' ? pull['isDraft'] : null,
    head,
    headOid: nullableString(pull['headRefOid']),
    items,
    markerVersion: body.markerVersion,
    mergeCommit,
    mergeable: nullableString(pull['mergeable']),
    mergedAt: nullableString(pull['mergedAt']),
    number:
      typeof pull['number'] === 'number' && Number.isSafeInteger(pull['number'])
        ? pull['number']
        : null,
    queueResolved: items.every((item) => item.checked && item.resolved),
    repository: PILOT_REPOSITORY,
    scopeBoundary: body.scopeBoundary,
    snapshot: body.snapshot,
    state: nullableString(pull['state']),
    title,
    url: nullableString(pull['url']),
    valid: diagnostics.length === 0,
    version: body.version,
  };
}
