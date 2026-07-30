import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseReleaseLine, parseStableVersion } from '../release-proposal/core.ts';

const REPOSITORY = 'fablebookjs/lab-02';
const repositoryUrl = `https://github.com/${REPOSITORY}`;
const fullOidPattern = /^[0-9a-f]{40}$/;
const changeKeyPattern = /^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/;
const releaseRecordChangePattern =
  /^- \[([^\]\r\n]+)\]\((https:\/\/github\.com\/fablebookjs\/lab-02\/(?:pull\/[1-9]\d*|commit\/[0-9a-f]{40}))\)$/;
const migrationFilenamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const metadataKeyPattern = /^[a-z][a-z0-9-]*$/;
const priorityOrder = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

export type ReleaseChange = {
  key: string;
  oid: string;
  qaSkip: boolean;
  releaseNoteSkip: boolean;
  title: string;
  url: string;
};

export type MigrationRecord = {
  body: string;
  filename: string;
  priority: string;
  title: string;
};

type MigrationRecordSource = {
  filename: string;
  source: unknown;
};

type ParsedReleaseRecordChange = {
  title: string;
  url: string;
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

export const cleanReleaseTitle = (value: unknown, fallback: string): string => {
  const title = (String(value ?? '').split(/\r?\n/, 1)[0] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (title || fallback).slice(0, 180);
};

type CanonicalReleasePull = {
  labels: unknown;
  merged_at: unknown;
  number: number;
  title: unknown;
};

const canonicalReleasePull = (
  pull: unknown,
  line: string,
  oid: string,
): pull is CanonicalReleasePull => {
  if (!isRecord(pull) || !Number.isSafeInteger(pull['number'])) return false;
  const number = pull['number'];
  const base = pull['base'];
  return (
    typeof number === 'number' &&
    number > 0 &&
    pull['merged_at'] !== null &&
    isRecord(base) &&
    base['ref'] === `releases/${line}` &&
    isRecord(base['repo']) &&
    base['repo']['full_name'] === REPOSITORY &&
    pull['merge_commit_sha'] === oid
  );
};

const pullClassification = (
  pull: CanonicalReleasePull,
): { qaSkip: boolean; releaseNoteSkip: boolean } => {
  if (
    typeof pull.title !== 'string' ||
    cleanReleaseTitle(pull.title, '').length === 0 ||
    !Array.isArray(pull.labels) ||
    pull.labels.some(
      (label) =>
        !isRecord(label) ||
        typeof label['name'] !== 'string' ||
        label['name'].length === 0
    )
  ) {
    throw new Error(`Pull request ${pull.number} has malformed release metadata.`);
  }
  const labels = new Set(
    pull.labels.map((label) => {
      if (!isRecord(label) || typeof label['name'] !== 'string') {
        throw new Error(`Pull request ${pull.number} has malformed release labels.`);
      }
      return label['name'];
    }),
  );
  return {
    qaSkip: labels.has('qa:skip'),
    releaseNoteSkip: labels.has('release-note:skip'),
  };
};

export function deriveReleaseChanges({
  commits,
  line,
}: {
  commits: unknown;
  line: string;
}): ReleaseChange[] {
  parseReleaseLine(line);
  if (!Array.isArray(commits)) {
    throw new Error('Release commits must be an array.');
  }
  return commits.map((commit) => {
    if (!isRecord(commit)) {
      throw new Error('Every release commit must be an object.');
    }
    const oid = fullOid(commit['oid'], 'Release change');
    const associatedPulls = commit['associatedPulls'];
    if (associatedPulls !== undefined && !Array.isArray(associatedPulls)) {
      throw new Error(`Release change ${oid} has malformed pull request metadata.`);
    }
    const associated = (associatedPulls ?? []).filter((pull): pull is CanonicalReleasePull =>
      canonicalReleasePull(pull, line, oid)
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
      title: cleanReleaseTitle(commit['subject'], `Commit ${oid.slice(0, 12)}`),
      url: `${repositoryUrl}/commit/${oid}`,
    };
  });
}

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

export function parseReleaseRecordChanges({
  source,
  version,
}: {
  source: unknown;
  version: string;
}): ParsedReleaseRecordChange[] {
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

export function parseMigrationRecord({
  filename,
  source,
}: MigrationRecordSource): MigrationRecord {
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

export function orderMigrationRecords(records: unknown): MigrationRecord[] {
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

export function composeMigrationRecords(
  records: unknown,
): Array<{ body: string; filename: string; title: string }> {
  return orderMigrationRecords(records).map(({ body, filename, title }) => ({
    body,
    filename,
    title,
  }));
}

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
