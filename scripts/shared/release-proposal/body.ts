import { parseStableVersion } from './core.ts';
import {
  cleanReleaseTitle,
  deriveReleaseChanges,
} from '../release-communication/records.ts';
import { PILOT_REPOSITORY } from '../repository.ts';
import { escapeRegExp } from '../text/regexp.ts';

const repositoryUrl = `https://github.com/${PILOT_REPOSITORY}`;
const repositoryUrlPattern = escapeRegExp(repositoryUrl);
const checkTaskPattern =
  /^- \[([ xX])\].*<!-- fablebook:check=([a-z0-9:.-]+) -->\s*$/gm;
const proposalIdentityPattern =
  /<!-- fablebook:proposal=([0-9a-f]{40}) source=([0-9a-f]{40}) version=([^ ]+) -->/g;
const releaseKindPattern = /<!-- fablebook:release-kind=(initial|patch) -->/g;
const changeTaskPattern = new RegExp(
  String.raw`^- \[([ xX])\] \[([^\]\r\n]+)\]\((${repositoryUrlPattern}/(?:pull/[1-9]\d*|commit/[0-9a-f]{40}))\) — (.+) <!-- fablebook:change=(pr:[1-9]\d*|commit:[0-9a-f]{40}) release-note=(include|skip) qa=(required|skip) -->\s*$`,
  'gm',
);

type ParsedReleasePrChange = {
  checked: boolean;
  key: string;
  qaSkip: boolean;
  releaseNoteSkip: boolean;
  title: string;
  url: string;
};

type ReleasePrIdentity = {
  proposalOid: string;
  releaseOid: string;
  version: string;
};


const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const RELEASE_PR_TEMPLATE_MARKER = '<!-- fablebook:release-pr=v7 -->';
export const RELEASE_HIGHLIGHTS_START = '<!-- fablebook:release-highlights:start -->';
export const RELEASE_HIGHLIGHTS_END = '<!-- fablebook:release-highlights:end -->';
export const RELEASE_HIGHLIGHTS_EMPTY_MARKER =
  '<!-- fablebook:release-highlights=empty -->';
export const EMPTY_RELEASE_HIGHLIGHTS =
  `- [ ] Replace this placeholder with the user-facing release highlights. ${RELEASE_HIGHLIGHTS_EMPTY_MARKER}`;

const canonicalChangeUrl = (key: string): string =>
  key.startsWith('pr:')
    ? `${repositoryUrl}/pull/${key.slice(3)}`
    : `${repositoryUrl}/commit/${key.slice(7)}`;

const capture = (match: RegExpMatchArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Generated release metadata omitted capture ${index}.`);
  }
  return value;
};

const extractProposalIdentity = (body: unknown): ReleasePrIdentity | null => {
  const matches = [...String(body ?? '').matchAll(proposalIdentityPattern)];
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    throw new Error('Release PR body repeats its proposal identity marker.');
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error('Release PR body has no proposal identity.');
  }
  const version = capture(match, 3);
  parseStableVersion(version);
  return {
    proposalOid: capture(match, 1),
    releaseOid: capture(match, 2),
    version,
  };
};

const extractReleaseKind = (body: unknown): 'initial' | 'patch' => {
  const matches = [...String(body ?? '').matchAll(releaseKindPattern)];
  if (matches.length !== 1) {
    throw new Error('Release PR body must contain one release-kind marker.');
  }
  const kind = matches[0]?.[1];
  if (kind !== 'initial' && kind !== 'patch') {
    throw new Error('Release PR body has an invalid release-kind marker.');
  }
  return kind;
};

export function extractReleasePrIdentity(body: unknown): ReleasePrIdentity | null {
  if (!String(body ?? '').includes(RELEASE_PR_TEMPLATE_MARKER)) {
    return null;
  }
  return extractProposalIdentity(body);
}

export function extractReleaseHighlights(body: unknown): string {
  const source = String(body ?? '');
  const starts = source.split(RELEASE_HIGHLIGHTS_START).length - 1;
  const ends = source.split(RELEASE_HIGHLIGHTS_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error('Release PR body must contain exactly one marked release-highlights block.');
  }
  const start = source.indexOf(RELEASE_HIGHLIGHTS_START) + RELEASE_HIGHLIGHTS_START.length;
  const end = source.indexOf(RELEASE_HIGHLIGHTS_END, start);
  if (end < start) {
    throw new Error('Release PR highlights markers are out of order.');
  }
  const highlights = source.slice(start, end).trim();
  if (highlights.length === 0) {
    throw new Error('Release PR highlights are empty.');
  }
  return highlights;
}

function validateReleaseHighlights(highlights: unknown): string {
  if (typeof highlights !== 'string' || highlights.trim() !== highlights) {
    throw new Error('Release highlights must be trimmed Markdown text.');
  }
  const visibleHighlights = highlights
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (
    highlights.includes(RELEASE_HIGHLIGHTS_EMPTY_MARKER) ||
    visibleHighlights.length === 0
  ) {
    throw new Error('Release highlights must replace the blocking empty placeholder.');
  }
  return highlights;
}

export function requireReleaseHighlights(body: unknown): string {
  return validateReleaseHighlights(extractReleaseHighlights(body));
}

export function recoverReleaseHighlights(body: unknown): string {
  try {
    return requireReleaseHighlights(body);
  } catch {
    return EMPTY_RELEASE_HIGHLIGHTS;
  }
}

export function selectLatestMatchingReleasePrBody({
  pulls,
  version,
}: {
  pulls: unknown;
  version: string;
}): string {
  parseStableVersion(version);
  if (!Array.isArray(pulls)) {
    throw new Error('Release highlight predecessors must be an array.');
  }
  return String(
    [...pulls]
      .filter(
        (pull): pull is { body: unknown; number: number; state: string } => {
        if (!isRecord(pull)) return false;
        return (
          typeof pull['number'] === 'number' &&
          Number.isSafeInteger(pull['number']) &&
          pull['number'] > 0 &&
          pull['state'] === 'closed'
        );
        },
      )
      .sort((left, right) => right.number - left.number)
      .find((pull) => {
        try {
          return extractProposalIdentity(pull.body)?.version === version;
        } catch {
          return false;
        }
      })?.body ?? '',
  );
}

export function extractReleasePrChanges(body: unknown): ParsedReleasePrChange[] {
  const source = String(body ?? '');
  const changes: ParsedReleasePrChange[] = [];
  const identities = new Set<string>();
  for (const match of source.matchAll(changeTaskPattern)) {
    const mark = capture(match, 1);
    const title = capture(match, 2);
    const url = capture(match, 3);
    const description = capture(match, 4);
    const key = capture(match, 5);
    const releaseNote = capture(match, 6);
    const qa = capture(match, 7);
    if (
      identities.has(key) ||
      url !== canonicalChangeUrl(key) ||
      cleanReleaseTitle(title, '') !== title ||
      (key.startsWith('commit:') && (releaseNote !== 'include' || qa !== 'required')) ||
      (qa === 'skip' &&
        (mark.toLowerCase() !== 'x' ||
          !description.includes('No manual QA required (`qa:skip`)'))) ||
      (releaseNote === 'skip' &&
        !description.includes('Not included in public release notes (`release-note:skip`)'))
    ) {
      throw new Error(`Release PR change ${key} has contradictory generated metadata.`);
    }
    identities.add(key);
    changes.push({
      checked: mark.toLowerCase() === 'x',
      key,
      qaSkip: qa === 'skip',
      releaseNoteSkip: releaseNote === 'skip',
      title,
      url,
    });
  }

  const markers = source.split('<!-- fablebook:change=').length - 1;
  if (markers !== changes.length) {
    throw new Error('Release PR body contains malformed change metadata.');
  }
  return changes;
}

export function extractReleasePrCheckboxes(body: unknown): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const match of String(body ?? '').matchAll(checkTaskPattern)) {
    const mark = capture(match, 1);
    const key = capture(match, 2);
    const identity = `check:${key}`;
    if (states.has(identity)) {
      throw new Error(`Release PR body repeats checkbox identity ${identity}.`);
    }
    states.set(identity, mark.toLowerCase() === 'x');
  }
  for (const change of extractReleasePrChanges(body)) {
    const identity = `change:${change.key}`;
    if (states.has(identity)) {
      throw new Error(`Release PR body repeats checkbox identity ${identity}.`);
    }
    states.set(identity, change.checked);
  }
  return states;
}

export const deriveReleasePrChanges = deriveReleaseChanges;

export function validateReleasePrBody({
  body,
  requireAttestations = false,
  version,
}: {
  body: unknown;
  requireAttestations?: boolean;
  version: string;
}): {
  changes: ParsedReleasePrChange[];
  kind: 'initial' | 'patch';
  releaseHighlights: string | null;
} {
  const parsed = parseStableVersion(version);
  const expectedKind = parsed.patch === 0 ? 'initial' : 'patch';
  const identity = extractReleasePrIdentity(body);
  if (identity === null || identity.version !== version) {
    throw new Error('Release PR body is not the generated template for this version.');
  }
  const kind = extractReleaseKind(body);
  if (kind !== expectedKind) {
    throw new Error(`Release PR body uses ${kind} communication for ${version}.`);
  }
  const releaseHighlights =
    kind === 'initial'
      ? requireReleaseHighlights(body)
      : null;
  if (
    kind === 'patch' &&
    (String(body).includes(RELEASE_HIGHLIGHTS_START) ||
      String(body).includes(RELEASE_HIGHLIGHTS_END))
  ) {
    throw new Error('Patch release PR must not contain a Release highlights block.');
  }
  const checks = extractReleasePrCheckboxes(body);
  for (const key of ['source-metadata-current', 'release-docs-reviewed']) {
    if (!checks.has(`check:${key}`)) {
      throw new Error(`Release PR body is missing required check ${key}.`);
    }
    if (requireAttestations && checks.get(`check:${key}`) !== true) {
      throw new Error(`Release PR body has not satisfied required check ${key}.`);
    }
  }
  return {
    changes: extractReleasePrChanges(body),
    kind,
    releaseHighlights,
  };
}
