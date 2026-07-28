import { parseReleaseLine, parseStableVersion } from './release-proposal-core.mjs';
import {
  composeMigrationRecords,
  extractReleaseRecordChanges,
  migrationRecordDirectory,
  releaseRecordPath,
} from './release-communication.mjs';

export const PATCHBACK_COMMENT_MARKER = '<!-- fablebook-patchback-outcome-examples -->';
export const PATCHBACK_BODY_MARKER = '<!-- fablebook-patchback-coordination:v3 -->';

const fullOid = (value, label) => {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const cleanText = (value, fallback) => {
  const text = String(value ?? '')
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || fallback).slice(0, 160);
};

export function patchbackIdentity(version) {
  const parsed = parseStableVersion(version);
  return {
    branch: `patchbacks/v${version}`,
    line: `v${parsed.major}.${parsed.minor}`,
    title: `Patch back v${version} to main`,
  };
}

export function previousReleaseVersion(version) {
  const parsed = parseStableVersion(version);
  if (parsed.patch === 0) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
}

export function patchbackReleaseRecord({ source, version }) {
  const path = releaseRecordPath(version);
  extractReleaseRecordChanges({ source, version });
  return { content: source, path };
}

export function patchbackMigrationRecords({ line, records }) {
  const directory = migrationRecordDirectory(line);
  if (!Array.isArray(records)) {
    throw new Error('Patchback migration records must be an array.');
  }
  const sources = new Map(records.map(({ filename, source }) => [filename, source]));
  return composeMigrationRecords(records).map(({ filename, title }) => ({
    content: sources.get(filename),
    path: `${directory}/${filename}`,
    title,
  }));
}

export function releaseMergerAssignee(pull) {
  const login = pull?.merged_by?.login;
  return typeof login === 'string' &&
    login.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)
    ? login
    : null;
}

const migrationRecordPaths = (paths, line) => {
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
  return paths;
};

export function patchbackCommitMessage({
  baseMainOid,
  boundaryOid,
  line,
  migrationRecordPaths: paths,
  recordPath,
  snapshotOid,
  version,
}) {
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
  migrationRecordPaths(paths, line);
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

export function parsePatchbackCommitMessage(message) {
  const trailers = Object.fromEntries(
    String(message ?? '')
      .split('\n')
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter(Boolean)
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
  patchbackCommitMessage(metadata);
  return metadata;
}

const canonicalPull = (pull, line, oid) =>
  Number.isSafeInteger(pull?.number) &&
  pull.number > 0 &&
  pull.merged_at !== null &&
  pull.base?.ref === `releases/${line}` &&
  pull.base?.repo?.full_name === 'fablebookjs/lab-02' &&
  pull.merge_commit_sha === oid;

export function derivePatchbackItems({ commits, line, snapshotOid }) {
  parseReleaseLine(line);
  fullOid(snapshotOid, 'Patchback snapshot');
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error('Patchback scope must include the authorized snapshot boundary commit.');
  }
  if (commits.at(-1)?.oid !== snapshotOid) {
    throw new Error('Patchback scope does not end at the authorized snapshot.');
  }

  return commits.slice(0, -1).map((commit) => {
    const oid = fullOid(commit.oid, 'Patchback item');
    const parents = (commit.parents ?? []).map((parent) => fullOid(parent, 'Commit parent'));
    if (parents.length === 0) {
      throw new Error(`Patchback item ${oid} has no first parent.`);
    }
    const associated = (commit.associatedPulls ?? []).filter((pull) =>
      canonicalPull(pull, line, oid)
    );
    const pull = associated.length === 1 ? associated[0] : null;
    const merge = parents.length > 1;
    const command = `git cherry-pick ${merge ? '-m 1 ' : ''}${oid}`;
    const subject = cleanText(
      pull?.title ?? commit.subject,
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

const itemHeading = (item) => {
  if (item.kind === 'pull-request') {
    return `[PR #${item.pullRequest}](https://github.com/fablebookjs/lab-02/pull/${item.pullRequest}) — ${item.subject}`;
  }
  const label = item.kind === 'direct-merge' ? 'Direct merge' : 'Direct commit';
  return `${label} — ${item.subject}`;
};

export function renderPatchbackBody({
  boundaryLabel,
  boundaryOid,
  items,
  line,
  migrationRecords,
  recordPath,
  snapshotOid,
  version,
}) {
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
  migrationRecordPaths(
    migrationRecords.map(({ path }) => path),
    line
  );
  for (const record of migrationRecords) {
    if (typeof record.title !== 'string' || record.title.length === 0) {
      throw new Error(`Patchback migration record has no title: ${record.path}`);
    }
  }

  const header = [
    PATCHBACK_BODY_MARKER,
    `# Patchback for v${version}`,
    '',
    `Authorized snapshot: [\`${snapshotOid}\`](https://github.com/fablebookjs/lab-02/commit/${snapshotOid})`,
    `Scope starts after ${boundaryLabel}: [\`${boundaryOid}\`](https://github.com/fablebookjs/lab-02/commit/${boundaryOid})`,
    '',
    '## Mechanically synchronized release communication',
    '',
    `- Generated release record: [\`${recordPath}\`](https://github.com/fablebookjs/lab-02/blob/${snapshotOid}/${recordPath})`,
    ...(migrationRecords.length === 0
      ? ['- Migration records: _None target this release line._']
      : [
          '- Migration records:',
          ...migrationRecords.map(
            ({ path, title }) =>
              `  - [${title}](https://github.com/fablebookjs/lab-02/blob/${snapshotOid}/${path}) (\`${path}\`)`
          ),
        ]),
    '',
    'This ordered product-change queue is fixed to the authorized snapshot. Automation never cherry-picks or removes its items. Mechanically synchronized communication may make an item already present; for every item, apply it, record that it is already present, or explain why it is not applicable, then check its box.',
  ];

  if (items.length === 0) {
    return [
      ...header,
      '',
      '_No release-line product changes are in this snapshot scope. The synchronized release communication above is the complete patchback._',
    ].join('\n');
  }

  const queue = items.flatMap((item) => [
    '',
    `- [ ] **${itemHeading(item)}**`,
    `  - Release commit: [\`${item.oid}\`](https://github.com/fablebookjs/lab-02/commit/${item.oid})`,
    `  - Apply: \`${item.command}\``,
    '  - Outcome: _record `applied`, `already-present`, or `not-applicable` before checking this item_',
  ]);
  return [...header, '', '## Ordered work queue', ...queue].join('\n');
}

export function patchbackExamplesComment() {
  return [
    PATCHBACK_COMMENT_MARKER,
    '## Copy-paste outcome examples',
    '',
    'Replace an item’s `Outcome` line with one of these, add the useful commit, PR, or reason, and only then check its box:',
    '',
    '- `Outcome: applied — cherry-picked as <main commit> in #<PR>`',
    '- `Outcome: applied — manually reimplemented in <main commit> because <reason>`',
    '- `Outcome: already-present — covered by <main commit or PR>`',
    '- `Outcome: not-applicable — <concise reason>`',
    '',
    'A conflict is unresolved work: leave the item unchecked until one of the outcomes is true.',
  ].join('\n');
}
