import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseReleaseLine, parseStableVersion } from '../release-proposal/core.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../repository.ts';
import { escapeRegExp } from '../text/regexp.ts';

const repositoryUrl = `https://github.com/${PILOT_REPOSITORY}`;
const repositoryUrlPattern = escapeRegExp(repositoryUrl);
const fullOidPattern = /^[0-9a-f]{40}$/;
const changeKeyPattern = /^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/;
const releaseRecordChangePattern = new RegExp(
  String.raw`^- \[([^\]\r\n]+)\]\((${repositoryUrlPattern}/(?:pull/[1-9]\d*|commit/[0-9a-f]{40}))\)$`,
);
const migrationFilenamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const metadataKeyPattern = /^[a-z][a-z0-9-]*$/;
const priorityOrder = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

/** One first-parent release-history entry with its normalized public identity. */
export type ReleaseChange = {
  key: string;
  oid: string;
  qaSkip: boolean;
  releaseNoteSkip: boolean;
  title: string;
  url: string;
};

/** Validated authored migration guidance with ordering metadata kept out of its body. */
export type MigrationRecord = {
  body: string;
  filename: string;
  priority: string;
  title: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !fullOidPattern.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not one positive integer.`);
  }
  return value;
};

/**
 * Normalizes an untrusted subject for one-line Markdown presentation without
 * allowing control characters or link/HTML punctuation to alter its structure.
 */
export const cleanReleaseTitle = (value: unknown, fallback: string): string => {
  const title = (String(value ?? '').split(/\r?\n/, 1)[0] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (title || fallback).slice(0, 180);
};

/** Provider-neutral merged-PR evidence used to classify one history commit. */
export type ReleaseHistoryPull = Readonly<{
  baseBranch: string;
  canonicalRepository: boolean;
  labels: readonly string[];
  mergeCommitOid: string | null;
  merged: boolean;
  number: number;
  title: string;
}>;

/** Normalized first-parent commit observation consumed by communication planners. */
export type ReleaseHistoryCommit = Readonly<{
  associatedPulls: readonly ReleaseHistoryPull[];
  oid: string;
  subject: string;
}>;

const canonicalBranchPull = (
  pull: ReleaseHistoryPull,
  branch: string,
  oid: string,
): boolean =>
  pull.canonicalRepository &&
  pull.baseBranch === branch &&
  pull.merged &&
  pull.mergeCommitOid === oid;

const pullClassification = (
  pull: ReleaseHistoryPull,
): { qaSkip: boolean; releaseNoteSkip: boolean } => {
  if (
    cleanReleaseTitle(pull.title, '').length === 0 ||
    !Array.isArray(pull.labels) ||
    pull.labels.some((label) => typeof label !== 'string' || label.length === 0)
  ) {
    throw new Error(`Pull request ${pull.number} has malformed release metadata.`);
  }
  const labels = new Set(pull.labels);
  return {
    qaSkip: labels.has('qa:skip'),
    releaseNoteSkip: labels.has('release-note:skip'),
  };
};

const deriveBranchChanges = ({
  branch,
  commits,
}: {
  branch: string;
  commits: readonly ReleaseHistoryCommit[];
}): ReleaseChange[] => {
  if (
    branch !== PRIMARY_BRANCH &&
    !/^releases\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(branch)
  ) {
    throw new Error(`Unsupported change-history branch: ${branch}`);
  }
  return commits.map((commit) => {
    const oid = fullOid(commit.oid, 'Release change');
    const associated = commit.associatedPulls.filter((pull) =>
      canonicalBranchPull(pull, branch, oid),
    );
    if (associated.length > 1) {
      throw new Error(`Release change ${oid} has ambiguous pull request metadata.`);
    }
    const pull = associated.length === 1 ? associated[0] : null;
    if (pull) {
      return {
        ...pullClassification(pull),
        key: `pr:${pull.number}`,
        oid,
        title: cleanReleaseTitle(pull.title, `Pull request #${pull.number}`),
        url: `${repositoryUrl}/pull/${pull.number}`,
      };
    }
    return {
      key: `commit:${oid}`,
      oid,
      qaSkip: false,
      releaseNoteSkip: false,
      title: cleanReleaseTitle(commit.subject, `Commit ${oid.slice(0, 12)}`),
      url: `${repositoryUrl}/commit/${oid}`,
    };
  });
};

/**
 * Classifies stable first-parent history in its existing order. Ambiguous PR
 * associations fail rather than dropping or guessing at a change.
 */
export function deriveReleaseChanges({
  commits,
  line,
}: {
  commits: readonly ReleaseHistoryCommit[];
  line: string;
}): ReleaseChange[] {
  parseReleaseLine(line);
  return deriveBranchChanges({ branch: `releases/${line}`, commits });
}

/** Classifies `main` first-parent history using the same conservative change rules. */
export function derivePrereleaseChanges({
  commits,
}: {
  commits: readonly ReleaseHistoryCommit[];
}): ReleaseChange[] {
  return deriveBranchChanges({ branch: PRIMARY_BRANCH, commits });
}

/**
 * Narrows serialized release changes, enforcing unique canonical identities,
 * URLs, and the rule that direct commits cannot inherit PR-only exemptions.
 */
export function normalizeReleaseChanges(changes: unknown): ReleaseChange[] {
  if (!Array.isArray(changes)) {
    throw new Error('Release changes must be an array.');
  }
  const identities = new Set();
  return changes.map((change) => {
    if (!isRecord(change) || typeof change['key'] !== 'string') {
      throw new Error('Release change has an invalid identity.');
    }
    const key = change['key'];
    if (!changeKeyPattern.test(key)) {
      throw new Error(`Release change has an invalid identity: ${key}`);
    }
    if (identities.has(key)) {
      throw new Error(`Release changes repeat identity ${key}.`);
    }
    identities.add(key);
    const oid = fullOid(change['oid'], `Release change ${key}`);
    if (
      typeof change['qaSkip'] !== 'boolean' ||
      typeof change['releaseNoteSkip'] !== 'boolean'
    ) {
      throw new Error(`Release change ${key} has invalid classification.`);
    }
    if (key.startsWith('pr:')) {
      const pullRequest = Number.parseInt(key.slice(3), 10);
      positiveInteger(pullRequest, `Release change ${key} pull request`);
      if (change['url'] !== `${repositoryUrl}/pull/${pullRequest}`) {
        throw new Error(`Release change ${key} has a noncanonical pull request URL.`);
      }
    } else {
      if (change['url'] !== `${repositoryUrl}/commit/${oid}`) {
        throw new Error(`Release change ${key} has a noncanonical commit URL.`);
      }
      if (change['qaSkip'] || change['releaseNoteSkip']) {
        throw new Error(`Direct release change ${key} cannot claim PR exemptions.`);
      }
    }
    return {
      key,
      oid,
      qaSkip: change['qaSkip'],
      releaseNoteSkip: change['releaseNoteSkip'],
      title: cleanReleaseTitle(change['title'], `Commit ${oid.slice(0, 12)}`),
      url: String(change['url']),
    };
  });
}

export function releaseRecordPath(version: string): string {
  parseStableVersion(version);
  return `releases/v${version}.md`;
}

/**
 * Renders the deterministic per-version record of public changes. The record is
 * generated history, not the curated Release highlights surface.
 */
export function renderReleaseRecord({
  changes,
  version,
}: {
  changes: unknown;
  version: string;
}): string {
  parseStableVersion(version);
  const publicChanges = normalizeReleaseChanges(changes).filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip
  );
  const renderedChanges =
    publicChanges.length === 0
      ? 'No changes were recorded for this release.'
      : publicChanges.map(({ title, url }) => `- [${title}](${url})`).join('\n');
  return [
    `# v${version} changes`,
    '',
    renderedChanges,
    '',
  ].join('\n');
}

/**
 * Extracts the change section from current and accepted historical generated
 * record formats without silently accepting arbitrary Markdown.
 */
export function extractReleaseRecordChanges({
  source,
  version,
}: {
  source: unknown;
  version: string;
}): string {
  parseStableVersion(version);
  const currentPrefix = `# v${version} changes

`;
  const historicalPrefix = `<!-- fablebook:release-record=v1 -->
# v${version}

> Generated from the exact release-line history. Do not edit manually.

## Changes

`;
  const prefix =
    typeof source === 'string'
      ? [currentPrefix, historicalPrefix].find((candidate) =>
          source.startsWith(candidate)
        )
      : undefined;
  if (
    typeof source !== 'string' ||
    prefix === undefined ||
    !source.endsWith('\n')
  ) {
    throw new Error(`Expected the generated v${version} release record.`);
  }
  const changes = source.slice(prefix.length, -1);
  if (changes.length === 0) {
    throw new Error(`Generated v${version} release record has no change content.`);
  }
  return changes;
}

/** Parses a generated record into ordered, unique canonical release links. */
export function parseReleaseRecordChanges({
  source,
  version,
}: {
  source: unknown;
  version: string;
}): Array<{ title: string; url: string }> {
  const changes = extractReleaseRecordChanges({ source, version });
  if (changes === 'No changes were recorded for this release.') {
    return [];
  }
  const urls = new Set();
  return changes.split('\n').map((line) => {
    const match = releaseRecordChangePattern.exec(line);
    const title = match?.[1];
    const url = match?.[2];
    if (
      title === undefined ||
      url === undefined ||
      cleanReleaseTitle(title, '') !== title ||
      urls.has(url)
    ) {
      throw new Error(`Generated v${version} release record has invalid change content.`);
    }
    urls.add(url);
    return { title, url };
  });
}

export function migrationRecordDirectory(line: string): string {
  parseReleaseLine(line);
  return `migration-notes/${line}`;
}

const unquote = (value: string): string => {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const parseFrontmatter = (
  source: string,
  filename: string,
): { body: string; metadata: Record<string, string> } => {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') {
    throw new Error(`${filename} must start with frontmatter.`);
  }
  const closing = lines.indexOf('---', 1);
  if (closing === -1) {
    throw new Error(`${filename} has unterminated frontmatter.`);
  }
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(':');
    const key = line.slice(0, separator).trim();
    const value = separator === -1 ? '' : unquote(line.slice(separator + 1).trim());
    if (!metadataKeyPattern.test(key) || value.length === 0) {
      throw new Error(`${filename} has invalid frontmatter: ${line}`);
    }
    if (Object.hasOwn(metadata, key)) {
      throw new Error(`${filename} repeats frontmatter field ${key}.`);
    }
    metadata[key] = value;
  }
  if (!Object.hasOwn(metadata, 'priority')) {
    throw new Error(`${filename} is missing required priority frontmatter.`);
  }
  return {
    body: lines.slice(closing + 1).join('\n').trim(),
    metadata,
  };
};

const nonemptySection = (lines: string[], headingIndex: number): boolean => {
  const nextHeading = lines.findIndex(
    (line, index) => index > headingIndex && /^#{1,6}\s+\S/.test(line)
  );
  const end = nextHeading === -1 ? lines.length : nextHeading;
  return lines
    .slice(headingIndex + 1, end)
    .some((line) => line.trim().length > 0 && !line.trim().startsWith('<!--'));
};

/**
 * Validates one authored migration file. Ordering priority remains metadata;
 * the returned body contains only the Markdown shown to maintainers.
 */
export function parseMigrationRecord({
  filename,
  source,
}: {
  filename: string;
  source: unknown;
}): MigrationRecord {
  const name = basename(filename);
  if (name !== filename || !migrationFilenamePattern.test(name)) {
    throw new Error(
      `Migration record filename must be a lowercase hyphenated Markdown name: ${filename}`
    );
  }
  if (typeof source !== 'string') {
    throw new Error(`${filename} must contain Markdown text.`);
  }

  const { body, metadata } = parseFrontmatter(source, filename);
  const lines = body.split('\n');
  const titles = lines
    .map((line, index) => ({ index, match: /^#\s+(.+?)\s*$/.exec(line) }))
    .filter(({ match }) => match !== null);
  if (titles.length !== 1) {
    throw new Error(`${filename} must contain exactly one level-one title.`);
  }

  for (const section of ['Who is affected', 'How to migrate']) {
    const headings = lines
      .map((line, index) => ({ index, match: /^##\s+(.+?)\s*$/.exec(line) }))
      .filter(({ match }) => match?.[1] === section);
    const heading = headings[0];
    if (headings.length !== 1 || heading === undefined || !nonemptySection(lines, heading.index)) {
      throw new Error(`${filename} must contain one nonempty "${section}" section.`);
    }
  }

  const automatic = lines
    .map((line, index) => ({ index, matches: /^##\s+Automatic migration\s*$/.test(line) }))
    .filter(({ matches }) => matches);
  if (automatic.length > 1) {
    throw new Error(`${filename} repeats its optional "Automatic migration" section.`);
  }
  const automaticSection = automatic[0];
  if (
    automatic.length === 1 &&
    automaticSection !== undefined &&
    !nonemptySection(lines, automaticSection.index)
  ) {
    throw new Error(`${filename} has an empty optional "Automatic migration" section.`);
  }

  return {
    body: `${body}\n`,
    filename,
    priority: metadata['priority'] ?? '',
    title: cleanReleaseTitle(
      titles[0]?.match?.[1],
      name.replace(/\.md$/, ''),
    ),
  };
}

function orderMigrationRecords(records: unknown): MigrationRecord[] {
  if (!Array.isArray(records)) {
    throw new Error('Migration records must be an array.');
  }
  const filenames = new Set();
  const validated = records.map((record) => {
    if (!isRecord(record)) {
      throw new Error('Migration records must contain objects.');
    }
    const parsed =
      typeof record['source'] === 'string' && typeof record['filename'] === 'string'
        ? parseMigrationRecord({
            filename: record['filename'],
            source: record['source'],
          })
        : {
            body: record['body'],
            filename: record['filename'],
            priority: record['priority'],
            title: record['title'],
          };
    if (
      typeof parsed.filename !== 'string' ||
      !migrationFilenamePattern.test(parsed.filename) ||
      typeof parsed.body !== 'string' ||
      typeof parsed.priority !== 'string' ||
      parsed.priority.length === 0 ||
      typeof parsed.title !== 'string' ||
      parsed.title.length === 0
    ) {
      throw new Error(`Invalid parsed migration record: ${parsed.filename}`);
    }
    if (filenames.has(parsed.filename)) {
      throw new Error(`Migration records repeat filename ${parsed.filename}.`);
    }
    filenames.add(parsed.filename);
    return {
      body: parsed.body,
      filename: parsed.filename,
      priority: parsed.priority,
      title: parsed.title,
    };
  });
  return validated.sort(
    (left, right) =>
      priorityOrder.compare(left.priority, right.priority) ||
      left.filename.localeCompare(right.filename, 'en')
  );
}

/**
 * Validates and deterministically orders migration records by natural,
 * case-insensitive priority and then filename, omitting priority from output.
 */
export function composeMigrationRecords(
  records: unknown,
): Array<{ body: string; filename: string; title: string }> {
  return orderMigrationRecords(records).map(({ body, filename, title }) => ({
    body,
    filename,
    title,
  }));
}

/**
 * Loads a release line's migration records in composition order. A missing
 * line directory is the supported empty result; malformed records still fail.
 */
export async function loadMigrationRecords(
  root: string,
  line: string,
): Promise<Array<{ body: string; filename: string; title: string }>> {
  const directory = join(root, migrationRecordDirectory(line));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const records = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      source: await readFile(join(directory, filename), 'utf8'),
    }))
  );
  return composeMigrationRecords(records);
}
