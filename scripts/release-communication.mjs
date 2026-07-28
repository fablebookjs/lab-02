import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseReleaseLine, parseStableVersion } from './release-proposal-core.mjs';

const REPOSITORY = 'fablebookjs/lab-02';
const repositoryUrl = `https://github.com/${REPOSITORY}`;
const fullOidPattern = /^[0-9a-f]{40}$/;
const changeKeyPattern = /^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/;
const migrationFilenamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const metadataKeyPattern = /^[a-z][a-z0-9-]*$/;
const priorityOrder = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

const LEGACY_RELEASE_RECORD_MARKER = '<!-- fablebook:release-record=v1 -->';
export const RELEASE_RECORD_MARKER = '<!-- fablebook:release-record=v2 -->';

const fullOid = (value, label) => {
  if (!fullOidPattern.test(value ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not one positive integer.`);
  }
  return value;
};

export const cleanReleaseTitle = (value, fallback) => {
  const title = String(value ?? '')
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (title || fallback).slice(0, 180);
};

const canonicalReleasePull = (pull, line, oid) =>
  Number.isSafeInteger(pull?.number) &&
  pull.number > 0 &&
  pull.merged_at !== null &&
  pull.base?.ref === `releases/${line}` &&
  pull.base?.repo?.full_name === REPOSITORY &&
  pull.merge_commit_sha === oid;

export function deriveReleaseChanges({ commits, line }) {
  parseReleaseLine(line);
  if (!Array.isArray(commits)) {
    throw new Error('Release commits must be an array.');
  }
  return commits.map((commit) => {
    const oid = fullOid(commit?.oid, 'Release change');
    const associated = (commit.associatedPulls ?? []).filter((pull) =>
      canonicalReleasePull(pull, line, oid)
    );
    const pull = associated.length === 1 ? associated[0] : null;
    return pull
      ? {
          key: `pr:${pull.number}`,
          oid,
          title: pull.title,
          url: `${repositoryUrl}/pull/${pull.number}`,
        }
      : {
          key: `commit:${oid}`,
          oid,
          title: commit.subject,
          url: `${repositoryUrl}/commit/${oid}`,
        };
  });
}

export function normalizeReleaseChanges(changes) {
  if (!Array.isArray(changes)) {
    throw new Error('Release changes must be an array.');
  }
  const identities = new Set();
  return changes.map((change) => {
    if (!changeKeyPattern.test(change?.key ?? '')) {
      throw new Error(`Release change has an invalid identity: ${change?.key}`);
    }
    if (identities.has(change.key)) {
      throw new Error(`Release changes repeat identity ${change.key}.`);
    }
    identities.add(change.key);
    const oid = fullOid(change.oid, `Release change ${change.key}`);
    if (change.key.startsWith('pr:')) {
      const pullRequest = Number.parseInt(change.key.slice(3), 10);
      positiveInteger(pullRequest, `Release change ${change.key} pull request`);
      if (change.url !== `${repositoryUrl}/pull/${pullRequest}`) {
        throw new Error(`Release change ${change.key} has a noncanonical pull request URL.`);
      }
    } else if (change.url !== `${repositoryUrl}/commit/${oid}`) {
      throw new Error(`Release change ${change.key} has a noncanonical commit URL.`);
    }
    return {
      key: change.key,
      oid,
      title: cleanReleaseTitle(change.title, `Commit ${oid.slice(0, 12)}`),
      url: change.url,
    };
  });
}

export function releaseRecordPath(version) {
  parseStableVersion(version);
  return `releases/v${version}.md`;
}

export function renderReleaseRecord({ changes, version }) {
  parseStableVersion(version);
  const normalized = normalizeReleaseChanges(changes);
  const renderedChanges =
    normalized.length === 0
      ? 'No changes were recorded for this release.'
      : normalized.map(({ title, url }) => `- [${title}](${url})`).join('\n');
  return [
    RELEASE_RECORD_MARKER,
    `# v${version} changes`,
    '',
    renderedChanges,
    '',
  ].join('\n');
}

export function extractReleaseRecordChanges({ source, version }) {
  parseStableVersion(version);
  const currentPrefix = `${RELEASE_RECORD_MARKER}
# v${version} changes

`;
  const legacyPrefix = `${LEGACY_RELEASE_RECORD_MARKER}
# v${version}

> Generated from the exact release-line history. Do not edit manually.

## Changes

`;
  const prefix =
    typeof source === 'string'
      ? [currentPrefix, legacyPrefix].find((candidate) =>
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

export function migrationRecordDirectory(line) {
  parseReleaseLine(line);
  return `migration-notes/${line}`;
}

const unquote = (value) => {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const parseFrontmatter = (source, filename) => {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') {
    throw new Error(`${filename} must start with frontmatter.`);
  }
  const closing = lines.indexOf('---', 1);
  if (closing === -1) {
    throw new Error(`${filename} has unterminated frontmatter.`);
  }
  const metadata = {};
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

const nonemptySection = (lines, headingIndex) => {
  const nextHeading = lines.findIndex(
    (line, index) => index > headingIndex && /^#{1,6}\s+\S/.test(line)
  );
  const end = nextHeading === -1 ? lines.length : nextHeading;
  return lines
    .slice(headingIndex + 1, end)
    .some((line) => line.trim().length > 0 && !line.trim().startsWith('<!--'));
};

export function parseMigrationRecord({ filename, source }) {
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
    if (headings.length !== 1 || !nonemptySection(lines, headings[0]?.index)) {
      throw new Error(`${filename} must contain one nonempty "${section}" section.`);
    }
  }

  const automatic = lines
    .map((line, index) => ({ index, matches: /^##\s+Automatic migration\s*$/.test(line) }))
    .filter(({ matches }) => matches);
  if (automatic.length > 1) {
    throw new Error(`${filename} repeats its optional "Automatic migration" section.`);
  }
  if (automatic.length === 1 && !nonemptySection(lines, automatic[0].index)) {
    throw new Error(`${filename} has an empty optional "Automatic migration" section.`);
  }

  return {
    body: `${body}\n`,
    filename,
    priority: metadata.priority,
    title: cleanReleaseTitle(titles[0].match[1], name.replace(/\.md$/, '')),
  };
}

export function orderMigrationRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('Migration records must be an array.');
  }
  const filenames = new Set();
  const validated = records.map((record) => {
    const parsed =
      typeof record?.source === 'string'
        ? parseMigrationRecord(record)
        : {
            body: record?.body,
            filename: record?.filename,
            priority: record?.priority,
            title: record?.title,
          };
    if (
      !migrationFilenamePattern.test(parsed.filename ?? '') ||
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
    return parsed;
  });
  return validated.sort(
    (left, right) =>
      priorityOrder.compare(left.priority, right.priority) ||
      left.filename.localeCompare(right.filename, 'en')
  );
}

export function composeMigrationRecords(records) {
  return orderMigrationRecords(records).map(({ body, filename, title }) => ({
    body,
    filename,
    title,
  }));
}

export async function loadMigrationRecords(root, line) {
  const directory = join(root, migrationRecordDirectory(line));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
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
