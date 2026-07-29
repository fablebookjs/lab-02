import {
  RELEASE_HIGHLIGHTS_EMPTY_MARKER,
  RELEASE_HIGHLIGHTS_END,
  RELEASE_HIGHLIGHTS_START,
} from '../release-proposal/body.ts';

export type PullRequestDescription = {
  baseRef: string;
  body: string;
  headRef: string;
  headRepository: string;
  repository: string;
};

export function descriptionErrors(input: PullRequestDescription): string[] {
  const errors: string[] = [];
  if (/^\s*[-*+]\s+\[ \](?:\s|$)/m.test(input.body)) {
    errors.push('Resolve every unchecked Markdown task in the pull request description.');
  }

  const line = /^releases\/(v[0-9]+\.[0-9]+)$/.exec(input.baseRef);
  const canonicalReleasePr =
    input.headRepository === input.repository &&
    line !== null &&
    input.headRef === `staged/${line[1]}`;
  if (!canonicalReleasePr) return errors;

  const identities = [
    ...input.body.matchAll(
      /<!-- fablebook:proposal=[0-9a-f]{40} source=[0-9a-f]{40} version=([^ ]+) -->/g,
    ),
  ];
  const version =
    identities.length === 1
      ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(identities[0][1])
      : null;
  if (version === null) {
    errors.push('Use one generated release proposal identity.');
    return errors;
  }
  if (Number.parseInt(version[3], 10) !== 0) return errors;

  const starts = input.body.split(RELEASE_HIGHLIGHTS_START).length - 1;
  const ends = input.body.split(RELEASE_HIGHLIGHTS_END).length - 1;
  const start = input.body.indexOf(RELEASE_HIGHLIGHTS_START) + RELEASE_HIGHLIGHTS_START.length;
  const end = input.body.indexOf(RELEASE_HIGHLIGHTS_END, start);
  const highlights =
    starts === 1 && ends === 1 && end >= start ? input.body.slice(start, end).trim() : '';
  const visibleHighlights = highlights.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (
    starts !== 1 ||
    ends !== 1 ||
    highlights.includes(RELEASE_HIGHLIGHTS_EMPTY_MARKER) ||
    visibleHighlights.length === 0
  ) {
    errors.push(
      'Replace the marked Release highlights placeholder with user-facing highlights.',
    );
  }
  return errors;
}
