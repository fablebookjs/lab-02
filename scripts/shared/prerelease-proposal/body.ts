import {
  cleanReleaseTitle,
} from '../release-communication/records.ts';
import { parseDevelopmentVersion } from '../release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../repository.ts';
import { escapeRegExp } from '../text/regexp.ts';

const repositoryUrl = `https://github.com/${PILOT_REPOSITORY}`;
const repositoryUrlPattern = escapeRegExp(repositoryUrl);
const fullOidPattern = /^[0-9a-f]{40}$/;
const identityPattern =
  /<!-- fablebook:prerelease-proposal=([0-9a-f]{40}) source=([0-9a-f]{40}) boundary=([0-9a-f]{40}) version=([^ ]+) -->/g;
export const PRERELEASE_RELEASE_NOTE_SKIP_LABEL = '`release-note:skip`';
const changePattern = new RegExp(
  String.raw`^- \[([^\]\r\n]+)\]\((${repositoryUrlPattern}/(?:pull/[1-9]\d*|commit/[0-9a-f]{40}))\)( — Not included in public release notes \(${PRERELEASE_RELEASE_NOTE_SKIP_LABEL}\)\.)? <!-- fablebook:prerelease-change=(pr:[1-9]\d*|commit:[0-9a-f]{40}) release-note=(include|skip) -->\s*$`,
  'gm',
);
const taskPattern = /^- \[[ xX]\]/m;

export const PRERELEASE_PR_TEMPLATE_MARKER =
  '<!-- fablebook:prerelease-pr=v1 -->';

/** Hidden binding between a generated Prerelease PR and its immutable Git facts. */
export type PrereleasePrIdentity = {
  boundaryOid: string;
  proposalOid: string;
  sourceOid: string;
  version: string;
};

/** One ordered, human-facing prerelease change with publication classification. */
export type PrereleasePrChange = {
  key: string;
  releaseNoteSkip: boolean;
  title: string;
  url: string;
};

const capture = (match: RegExpMatchArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`Generated prerelease metadata omitted capture ${index}.`);
  }
  return value;
};

const canonicalChangeUrl = (key: string): string =>
  key.startsWith('pr:')
    ? `${repositoryUrl}/pull/${key.slice(3)}`
    : `${repositoryUrl}/commit/${key.slice(7)}`;

const validateIdentity = (
  identity: PrereleasePrIdentity,
): PrereleasePrIdentity => {
  const oids: Array<[string, string]> = [
    ['Prerelease proposal', identity.proposalOid],
    ['Prerelease source', identity.sourceOid],
    ['Prerelease boundary', identity.boundaryOid],
  ];
  for (const [label, oid] of oids) {
    if (!fullOidPattern.test(oid)) {
      throw new Error(`${label} is not a full commit OID.`);
    }
  }
  parseDevelopmentVersion(identity.version);
  return identity;
};

/**
 * Reads exactly one identity from a current generated Prerelease PR. Bodies
 * outside the template return null; malformed current metadata fails.
 */
export function extractPrereleasePrIdentity(
  body: unknown,
): PrereleasePrIdentity | null {
  const source = String(body ?? '');
  if (!source.includes(PRERELEASE_PR_TEMPLATE_MARKER)) {
    return null;
  }
  const matches = [...source.matchAll(identityPattern)];
  if (matches.length !== 1) {
    throw new Error(
      'Prerelease PR body must contain one proposal identity marker.',
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new Error('Prerelease PR body has no proposal identity.');
  }
  return validateIdentity({
    boundaryOid: capture(match, 3),
    proposalOid: capture(match, 1),
    sourceOid: capture(match, 2),
    version: capture(match, 4),
  });
}

/** Parses ordered prerelease change links and proves visible and hidden metadata agree. */
export function extractPrereleasePrChanges(
  body: unknown,
): PrereleasePrChange[] {
  const source = String(body ?? '');
  const changes: PrereleasePrChange[] = [];
  const identities = new Set<string>();
  for (const match of source.matchAll(changePattern)) {
    const title = capture(match, 1);
    const url = capture(match, 2);
    const annotation = match[3];
    const key = capture(match, 4);
    const releaseNote = capture(match, 5);
    if (
      identities.has(key) ||
      url !== canonicalChangeUrl(key) ||
      cleanReleaseTitle(title, '') !== title ||
      (releaseNote === 'skip') !== (annotation !== undefined)
    ) {
      throw new Error(
        `Prerelease PR change ${key} has contradictory generated metadata.`,
      );
    }
    identities.add(key);
    changes.push({
      key,
      releaseNoteSkip: releaseNote === 'skip',
      title,
      url,
    });
  }
  const markers = source.split('<!-- fablebook:prerelease-change=').length - 1;
  if (markers !== changes.length) {
    throw new Error('Prerelease PR body contains malformed change metadata.');
  }
  return changes;
}

/**
 * Validates that a generated Prerelease PR is bound to the expected immutable
 * proposal facts and contains no QA task surface.
 */
export function validatePrereleasePrBody(
  body: unknown,
  expected: PrereleasePrIdentity,
): PrereleasePrChange[] {
  const identity = extractPrereleasePrIdentity(body);
  const canonical = validateIdentity(expected);
  if (
    identity === null ||
    identity.boundaryOid !== canonical.boundaryOid ||
    identity.proposalOid !== canonical.proposalOid ||
    identity.sourceOid !== canonical.sourceOid ||
    identity.version !== canonical.version
  ) {
    throw new Error(
      'Prerelease PR body is not bound to the current prerelease proposal.',
    );
  }
  if (taskPattern.test(String(body ?? ''))) {
    throw new Error('Prerelease PR body must not contain QA checkboxes.');
  }
  return extractPrereleasePrChanges(body);
}
