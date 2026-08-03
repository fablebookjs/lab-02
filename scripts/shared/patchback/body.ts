import {
  PATCHBACK_FULL_OID_PATTERN_SOURCE,
  patchbackIdentity,
} from './core.ts';
import { PILOT_REPOSITORY } from '../repository.ts';

export const PATCHBACK_BODY_SCHEMA_VERSION = 4;
export const PATCHBACK_BODY_MARKER =
  `<!-- fablebook-patchback-coordination:v${PATCHBACK_BODY_SCHEMA_VERSION} -->`;

export type PatchbackInspectionItem =
  | {
      checked: boolean;
      heading: string;
      kind: 'migration-conflict';
      outcome: string;
      path: string;
      resolved: boolean;
    }
  | {
      checked: boolean;
      command: string;
      heading: string;
      kind: 'product-change';
      outcome: string;
      pullRequest: number | null;
      releaseCommit: string;
      resolved: boolean;
    };

export type PatchbackBodyInspection = {
  diagnostics: string[];
  items: PatchbackInspectionItem[];
  markerVersion: number | null;
  scopeBoundary: string | null;
  snapshot: string | null;
  version: string | null;
};

const parseItems = (
  body: string,
  diagnostics: string[],
  context: { line: string | null; snapshotOid: string | null },
): PatchbackInspectionItem[] => {
  const queueStart = body.indexOf('## Ordered work queue');
  const queue = queueStart === -1 ? '' : body.slice(queueStart);
  const headingPattern = /^- \[([ xX])\] \*\*(.+)\*\*$/gm;
  const headings = [...queue.matchAll(headingPattern)];
  const items: PatchbackInspectionItem[] = [];

  for (const [index, headingMatch] of headings.entries()) {
    const start = headingMatch.index;
    const end = headings[index + 1]?.index ?? queue.length;
    const block = queue.slice(start, end);
    const mark = headingMatch[1] ?? '';
    const heading = headingMatch[2] ?? '';
    const outcomeMatch = /^  - Outcome: (.+)$/m.exec(block);
    const outcome = outcomeMatch?.[1] ?? '';
    const checked = mark.toLowerCase() === 'x';
    const resolved = /^(?:applied|already-present|not-applicable) — \S.+/.test(
      outcome,
    );
    const migrationPrefix = 'Resolve divergent Migration guidance — ';

    if (heading.startsWith(migrationPrefix)) {
      const title = heading.slice(migrationPrefix.length);
      const fileMatch = /^  - File: `([^`\r\n]+)`$/m.exec(block);
      const stableMatch = new RegExp(
        `^  - Stable source: \\[authorized snapshot\\]\\(https://github\\.com/${PILOT_REPOSITORY}/blob/(${PATCHBACK_FULL_OID_PATTERN_SOURCE})/([^\\s)]+)\\)$`,
        'm',
      ).exec(block);
      const file = fileMatch?.[1];
      const stableOid = stableMatch?.[1];
      const stablePath = stableMatch?.[2];
      const placeholder =
        '_preserve or manually reconcile the newer `main` guidance, then record the resolution_';
      const pathPattern =
        context.line === null
          ? null
          : new RegExp(
              `^migration-notes/${context.line}/[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`,
            );

      if (
        title.length === 0 ||
        file === undefined ||
        stableOid === undefined ||
        stablePath === undefined ||
        outcomeMatch === null ||
        stableOid !== context.snapshotOid ||
        stablePath !== file ||
        pathPattern?.test(file) !== true
      ) {
        diagnostics.push(
          `queue item ${index + 1} does not match the generated Migration task shape`,
        );
        continue;
      }
      if (outcome !== placeholder && !resolved) {
        diagnostics.push(`queue item ${index + 1} has an invalid outcome`);
      }
      if (checked !== resolved) {
        diagnostics.push(`queue item ${index + 1} checkbox and outcome disagree`);
      }

      items.push({
        checked,
        heading,
        kind: 'migration-conflict',
        outcome,
        path: file,
        resolved,
      });
      continue;
    }

    const releaseMatch = new RegExp(
      `^  - Release commit: \\[\\\`(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`\\]`,
      'm',
    ).exec(block);
    const applyMatch = new RegExp(
      `^  - Apply: \\\`git cherry-pick (?:-(m) 1 )?(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`$`,
      'm',
    ).exec(block);
    const releaseCommit = releaseMatch?.[1];
    const mergeFlag = applyMatch?.[1];
    const appliedCommit = applyMatch?.[2];

    if (
      releaseCommit === undefined ||
      appliedCommit === undefined ||
      outcomeMatch === null
    ) {
      diagnostics.push(
        `queue item ${index + 1} does not match the generated item shape`,
      );
      continue;
    }
    if (releaseCommit !== appliedCommit) {
      diagnostics.push(
        `queue item ${index + 1} applies a different commit than it names`,
      );
    }

    const pullMatch = new RegExp(
      `\\[PR #([1-9]\\d*)\\]\\(https://github\\.com/${PILOT_REPOSITORY}/pull/\\1\\)`,
    ).exec(heading);
    const placeholder =
      '_record `applied`, `already-present`, or `not-applicable` before checking this item_';
    if (outcome !== placeholder && !resolved) {
      diagnostics.push(`queue item ${index + 1} has an invalid outcome`);
    }
    if (checked !== resolved) {
      diagnostics.push(`queue item ${index + 1} checkbox and outcome disagree`);
    }

    items.push({
      checked,
      command: `git cherry-pick ${mergeFlag === undefined ? '' : '-m 1 '}${appliedCommit}`,
      heading,
      kind: 'product-change',
      outcome,
      pullRequest: pullMatch?.[1] === undefined ? null : Number(pullMatch[1]),
      releaseCommit,
      resolved,
    });
  }

  return items;
};

/** Parses and validates the generated, maintainer-editable Patchback PR body. */
export function inspectPatchbackPrBody(body: unknown): PatchbackBodyInspection {
  const source = String(body ?? '');
  const diagnostics: string[] = [];
  const marker = source.split(/\r?\n/, 1)[0] === PATCHBACK_BODY_MARKER;
  const versionMatch = /^# Patchback for v(\d+\.\d+\.\d+)$/m.exec(source);
  const snapshotMatch = new RegExp(
    `^Authorized snapshot: \\[\\\`(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`]`,
    'm',
  ).exec(source);
  const boundaryMatch = new RegExp(
    `^Scope starts after .+: \\[\\\`(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`]`,
    'm',
  ).exec(source);

  if (!marker) diagnostics.push('missing generated patch-back marker');
  if (versionMatch === null) {
    diagnostics.push('missing canonical patch-back version heading');
  }
  if (snapshotMatch === null) {
    diagnostics.push('missing full authorized snapshot OID');
  }
  if (boundaryMatch === null) {
    diagnostics.push('missing full scope boundary OID');
  }

  const version = versionMatch?.[1] ?? null;
  const snapshot = snapshotMatch?.[1] ?? null;
  const scopeBoundary = boundaryMatch?.[1] ?? null;
  const items = parseItems(source, diagnostics, {
    line: version === null ? null : patchbackIdentity(version).line,
    snapshotOid: snapshot,
  });
  const hasQueueHeading = /^## Ordered work queue$/m.test(source);
  const emptyQueue =
    /_No release-line product changes are in this snapshot scope\./.test(source);
  if (hasQueueHeading && items.length === 0) {
    diagnostics.push('ordered queue contains no valid items');
  }
  if (!hasQueueHeading && !emptyQueue) {
    diagnostics.push('body has neither an ordered nor empty queue');
  }

  return {
    diagnostics,
    items,
    markerVersion: marker ? PATCHBACK_BODY_SCHEMA_VERSION : null,
    scopeBoundary,
    snapshot,
    version,
  };
}
