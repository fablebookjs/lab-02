#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import { inspectPatchbackPullRequest } from '../../../../scripts/shared/patchback/inspection.ts';
import { PILOT_REPOSITORY } from '../../../../scripts/shared/repository.ts';

const fail = (message: string): never => {
  console.error(`inspect-patchback-pr: ${message}`);
  process.exit(1);
};

const pullNumber = (value: string | undefined): number => {
  if (value === undefined) {
    return fail('pass a pull request number or canonical GitHub pull request URL');
  }
  if (/^[1-9]\d*$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      fail('pull request number is outside the safe range');
    }
    return number;
  }

  const url = (() => {
    try {
      return new URL(value);
    } catch {
      return fail('pass a pull request number or canonical GitHub pull request URL');
    }
  })();

  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (match === null) {
    return fail(`the pull request must belong to ${PILOT_REPOSITORY}`);
  }
  const owner = match[1];
  const repository = match[2];
  const numberText = match[3];
  if (
    owner === undefined ||
    repository === undefined ||
    numberText === undefined ||
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    `${owner}/${repository}` !== PILOT_REPOSITORY
  ) {
    return fail(`the pull request must belong to ${PILOT_REPOSITORY}`);
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) {
    fail('pull request number is outside the safe range');
  }
  return number;
};

const args = process.argv.slice(2);
if (args.length !== 1) {
  fail('usage: inspect-patchback-pr.ts <pr-number-or-url>');
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
  ['pr', 'view', String(number), '--repo', PILOT_REPOSITORY, '--json', fields],
  { encoding: 'utf8' },
);
if (result.error !== undefined) fail(result.error.message);
if (result.status !== 0) {
  fail(result.stderr.trim() || `gh exited with ${result.status}`);
}

let pull: unknown;
try {
  pull = JSON.parse(result.stdout);
} catch {
  fail('gh returned invalid JSON');
}

const report = inspectPatchbackPullRequest(pull);
console.log(JSON.stringify(report, null, 2));
if (!report.valid) process.exitCode = 2;
