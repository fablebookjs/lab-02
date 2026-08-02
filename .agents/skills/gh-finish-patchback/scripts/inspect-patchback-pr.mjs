#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import {
  PATCHBACK_FULL_OID_PATTERN_SOURCE,
  patchbackIdentity,
} from '../../../../scripts/shared/patchback/core.ts';
import {
  PATCHBACK_BODY_MARKER,
  PATCHBACK_BODY_SCHEMA_VERSION,
} from '../../../../scripts/github/patchback/templates.ts';
import { PILOT_REPOSITORY as PATCHBACK_REPOSITORY } from '../../../../scripts/shared/repository.ts';

function fail(message) {
  console.error(`inspect-patchback-pr: ${message}`);
  process.exit(1);
}

function pullNumber(value) {
  if (/^[1-9]\d*$/.test(value ?? '')) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail('pull request number is outside the safe range');
    return number;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail('pass a pull request number or canonical GitHub pull request URL');
  }

  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !match ||
    `${match[1]}/${match[2]}` !== PATCHBACK_REPOSITORY
  ) {
    fail(`the pull request must belong to ${PATCHBACK_REPOSITORY}`);
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) fail('pull request number is outside the safe range');
  return number;
}

function parseTrailers(commit) {
  return Object.fromEntries(
    String(commit?.messageBody ?? '')
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z-]+): (.+)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );
}

function latestChecks(checks) {
  const latest = new Map();
  for (const check of checks ?? []) {
    const name = check.name ?? check.context;
    if (!name) continue;
    const timestamp = Date.parse(check.startedAt ?? check.completedAt ?? '') || 0;
    const previous = latest.get(name);
    if (!previous || timestamp >= previous.timestamp) {
      latest.set(name, {
        conclusion: check.conclusion ?? null,
        detailsUrl: check.detailsUrl ?? check.targetUrl ?? null,
        name,
        status: check.status ?? null,
        timestamp,
        workflowName: check.workflowName ?? null,
      });
    }
  }
  return [...latest.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ timestamp: _timestamp, ...check }) => check);
}

function parseItems(body, diagnostics) {
  const queueStart = body.indexOf('## Ordered work queue');
  const queue = queueStart === -1 ? '' : body.slice(queueStart);
  const heading = /^- \[([ xX])\] \*\*(.+)\*\*$/gm;
  const headings = [...queue.matchAll(heading)];
  const items = [];

  for (const [index, match] of headings.entries()) {
    const end = headings[index + 1]?.index ?? queue.length;
    const block = queue.slice(match.index, end);
    const release = new RegExp(
      `^  - Release commit: \\[\\\`(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`\\]`,
      'm'
    ).exec(block);
    const apply = new RegExp(
      `^  - Apply: \\\`git cherry-pick (?:-(m) 1 )?(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`$`,
      'm'
    ).exec(block);
    const outcome = /^  - Outcome: (.+)$/m.exec(block);

    if (!release || !apply || !outcome) {
      diagnostics.push(`queue item ${index + 1} does not match the generated item shape`);
      continue;
    }
    if (release[1] !== apply[2]) {
      diagnostics.push(`queue item ${index + 1} applies a different commit than it names`);
    }

    const pull = new RegExp(
      `\\[PR #([1-9]\\d*)\\]\\(https://github\\.com/${PATCHBACK_REPOSITORY}/pull/\\1\\)`
    ).exec(match[2]);
    const placeholder =
      '_record `applied`, `already-present`, or `not-applicable` before checking this item_';
    const resolved = /^(?:applied|already-present|not-applicable) — \S.+/.test(outcome[1]);
    if (outcome[1] !== placeholder && !resolved) {
      diagnostics.push(`queue item ${index + 1} has an invalid outcome`);
    }
    const checked = match[1].toLowerCase() === 'x';
    if (checked !== resolved) {
      diagnostics.push(`queue item ${index + 1} checkbox and outcome disagree`);
    }

    items.push({
      checked,
      command: `git cherry-pick ${apply[1] ? '-m 1 ' : ''}${apply[2]}`,
      heading: match[2],
      outcome: outcome[1],
      pullRequest: pull ? Number(pull[1]) : null,
      releaseCommit: release[1],
      resolved,
    });
  }

  return items;
}

const args = process.argv.slice(2);
if (args.length !== 1) {
  fail('usage: inspect-patchback-pr.mjs <pr-number-or-url>');
}

const number = pullNumber(args[0]);
const fields = [
  'baseRefName',
  'body',
  'commits',
  'headRefName',
  'headRefOid',
  'isDraft',
  'mergeCommit',
  'mergeable',
  'mergedAt',
  'number',
  'state',
  'statusCheckRollup',
  'title',
  'url',
].join(',');
const result = spawnSync(
  'gh',
  ['pr', 'view', String(number), '--repo', PATCHBACK_REPOSITORY, '--json', fields],
  { encoding: 'utf8' }
);
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(result.stderr.trim() || `gh exited with ${result.status}`);

let pull;
try {
  pull = JSON.parse(result.stdout);
} catch {
  fail('gh returned invalid JSON');
}

const body = String(pull.body ?? '');
const diagnostics = [];
const marker = body.split(/\r?\n/, 1)[0] === PATCHBACK_BODY_MARKER;
const versionMatch = /^# Patchback for v(\d+\.\d+\.\d+)$/m.exec(body);
const snapshot = new RegExp(
  `^Authorized snapshot: \\[\\\`(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`]`,
  'm'
).exec(body);
const boundary = new RegExp(
  `^Scope starts after .+: \\[\\\`(${PATCHBACK_FULL_OID_PATTERN_SOURCE})\\\`]`,
  'm'
).exec(body);

if (!marker) diagnostics.push('missing generated patch-back marker');
if (!versionMatch) diagnostics.push('missing canonical patch-back version heading');

const version = versionMatch?.[1] ?? null;
if (version) {
  const identity = patchbackIdentity(version);
  if (pull.baseRefName !== 'main') diagnostics.push('base branch is not main');
  if (pull.headRefName !== identity.branch) {
    diagnostics.push('head branch does not match the patch-back version');
  }
  if (pull.title !== identity.title) {
    diagnostics.push('title does not match the patch-back version');
  }
}
if (!snapshot) diagnostics.push('missing full authorized snapshot OID');
if (!boundary) diagnostics.push('missing full scope boundary OID');

const items = parseItems(body, diagnostics);
const hasQueueHeading = /^## Ordered work queue$/m.test(body);
const emptyQueue = /_No release-line product changes are in this snapshot scope\./.test(body);
if (hasQueueHeading && items.length === 0) diagnostics.push('ordered queue contains no valid items');
if (!hasQueueHeading && !emptyQueue) diagnostics.push('body has neither an ordered nor empty queue');

const coordination = (pull.commits ?? []).find(
  (commit) => commit.messageHeadline === `patchback: coordinate v${version}`
);
if (!coordination) {
  diagnostics.push('structured coordination commit is absent from the PR');
}
const trailers = parseTrailers(coordination);
if (version && trailers['Patchback-Version'] !== version) {
  diagnostics.push('coordination commit version does not match the body');
}
if (snapshot && trailers['Patchback-Snapshot'] !== snapshot[1]) {
  diagnostics.push('coordination commit snapshot does not match the body');
}
if (boundary && trailers['Patchback-Boundary'] !== boundary[1]) {
  diagnostics.push('coordination commit boundary does not match the body');
}

const report = {
  base: pull.baseRefName,
  checks: latestChecks(pull.statusCheckRollup),
  coordinationCommit: coordination?.oid ?? null,
  diagnostics,
  draft: pull.isDraft,
  head: pull.headRefName,
  headOid: pull.headRefOid,
  items,
  markerVersion: marker ? PATCHBACK_BODY_SCHEMA_VERSION : null,
  mergeCommit: pull.mergeCommit?.oid ?? null,
  mergeable: pull.mergeable,
  mergedAt: pull.mergedAt,
  number: pull.number,
  queueResolved: items.every((item) => item.checked && item.resolved),
  repository: PATCHBACK_REPOSITORY,
  scopeBoundary: boundary?.[1] ?? null,
  snapshot: snapshot?.[1] ?? null,
  state: pull.state,
  title: pull.title,
  url: pull.url,
  valid: diagnostics.length === 0,
  version,
};

console.log(JSON.stringify(report, null, 2));
if (diagnostics.length > 0) process.exitCode = 2;
