import {
  PATCHBACK_FULL_OID_PATTERN_SOURCE,
  patchbackIdentity,
  validatePatchbackMigrationRecordPaths,
} from '../../shared/patchback/core.ts';
import type { PatchbackItem } from '../../shared/patchback/core.ts';
import { releaseRecordPath } from '../../shared/release-communication/records.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { dedent } from '../../shared/text/dedent.ts';

export const PATCHBACK_BODY_SCHEMA_VERSION = 3;
export const PATCHBACK_COMMENT_MARKER =
  '<!-- fablebook-patchback-outcome-examples -->';
export const PATCHBACK_BODY_MARKER =
  `<!-- fablebook-patchback-coordination:v${PATCHBACK_BODY_SCHEMA_VERSION} -->`;

/** Reusable marked comment that teaches maintainers the accepted outcome vocabulary. */
export const PATCHBACK_EXAMPLES_COMMENT = dedent`
  ${PATCHBACK_COMMENT_MARKER}
  ## Copy-paste outcome examples

  Replace an item’s \`Outcome\` line with one of these, add the useful commit, PR, or reason, and only then check its box:

  - \`Outcome: applied — cherry-picked as <main commit> in #<PR>\`
  - \`Outcome: applied — manually reimplemented in <main commit> because <reason>\`
  - \`Outcome: already-present — covered by <main commit or PR>\`
  - \`Outcome: not-applicable — <concise reason>\`

  A conflict is unresolved work: leave the item unchecked until one of the outcomes is true.
`;

type PatchbackMigrationRecord = {
  path: string;
  title: string;
};

type RenderPatchbackPrBodyOptions = {
  boundaryLabel: string;
  boundaryOid: string;
  items: PatchbackItem[];
  line: string;
  migrationRecords: PatchbackMigrationRecord[];
  recordPath: string;
  snapshotOid: string;
  version: string;
};

const fullOidPattern = new RegExp(`^${PATCHBACK_FULL_OID_PATTERN_SOURCE}$`);

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !fullOidPattern.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const itemHeading = (item: PatchbackItem): string => {
  if (item.kind === 'pull-request') {
    return `[PR #${item.pullRequest}](https://github.com/${PILOT_REPOSITORY}/pull/${item.pullRequest}) — ${item.subject}`;
  }
  const label = item.kind === 'direct-merge' ? 'Direct merge' : 'Direct commit';
  return `${label} — ${item.subject}`;
};

/**
 * Renders mechanically synchronized communication separately from the fixed
 * product-change queue. The renderer never infers or records item outcomes.
 */
export function renderPatchbackPrBody({
  boundaryLabel,
  boundaryOid,
  items,
  line,
  migrationRecords,
  recordPath,
  snapshotOid,
  version,
}: RenderPatchbackPrBodyOptions): string {
  const identity = patchbackIdentity(version);
  if (identity.line !== line) {
    throw new Error(`${version} does not belong to patchback line ${line}.`);
  }
  if (recordPath !== releaseRecordPath(version)) {
    throw new Error(`Patchback release record must be ${releaseRecordPath(version)}.`);
  }
  fullOid(boundaryOid, 'Patchback boundary');
  fullOid(snapshotOid, 'Patchback snapshot');
  if (!Array.isArray(items)) {
    throw new Error('Patchback items must be an array.');
  }
  if (!Array.isArray(migrationRecords)) {
    throw new Error('Patchback migration records must be an array.');
  }
  validatePatchbackMigrationRecordPaths(
    migrationRecords.map(({ path }) => path),
    line,
  );
  for (const record of migrationRecords) {
    if (typeof record.title !== 'string' || record.title.length === 0) {
      throw new Error(`Patchback migration record has no title: ${record.path}`);
    }
  }

  const migrationItems =
    migrationRecords.length === 0
      ? '- Migration records: _None target this release line._'
      : [
          '- Migration records:',
          ...migrationRecords.map(
            ({ path, title }) =>
              `  - [${title}](https://github.com/${PILOT_REPOSITORY}/blob/${snapshotOid}/${path}) (\`${path}\`)`,
          ),
        ].join('\n');
  const header = dedent`
    ${PATCHBACK_BODY_MARKER}
    # Patchback for v${version}

    Authorized snapshot: [\`${snapshotOid}\`](https://github.com/${PILOT_REPOSITORY}/commit/${snapshotOid})
    Scope starts after ${boundaryLabel}: [\`${boundaryOid}\`](https://github.com/${PILOT_REPOSITORY}/commit/${boundaryOid})

    ## Mechanically synchronized release communication

    - Generated release record: [\`${recordPath}\`](https://github.com/${PILOT_REPOSITORY}/blob/${snapshotOid}/${recordPath})
    ${migrationItems}

    This ordered product-change queue is fixed to the authorized snapshot. Automation never cherry-picks or removes its items. Mechanically synchronized communication may make an item already present; for every item, apply it, record that it is already present, or explain why it is not applicable, then check its box.
  `;

  if (items.length === 0) {
    return `${header}\n\n_No release-line product changes are in this snapshot scope. The synchronized release communication above is the complete patchback._`;
  }

  const queue = items
    .map(
      (item) => dedent`
        - [ ] **${itemHeading(item)}**
          - Release commit: [\`${item.oid}\`](https://github.com/${PILOT_REPOSITORY}/commit/${item.oid})
          - Apply: \`${item.command}\`
          - Outcome: _record \`applied\`, \`already-present\`, or \`not-applicable\` before checking this item_
      `,
    )
    .join('\n\n');
  return `${header}\n\n## Ordered work queue\n\n${queue}`;
}
