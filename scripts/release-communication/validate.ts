import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { readFileAtCommit } from '../shared/git/repository.ts';
import { run } from '../shared/process/run.ts';
import { repositoryRoot } from '../shared/workspace/packages.ts';
import {
  composeMigrationRecords,
  loadMigrationRecords,
  migrationRecordDirectory,
} from '../shared/release-communication/records.ts';
import {
  expectedMigrationVersion,
  validateMigrationEvolution,
} from '../shared/release-communication/migration-policy.ts';
import { parseReleaseLine } from '../shared/release-proposal/core.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../shared/repository.ts';
import { isRecord } from '../shared/validation.ts';

const root = join(repositoryRoot, 'migration-notes');
const RELEASE_APP_BOT_LOGIN = 'fablebook-lab-02-release[bot]';
let entries: Dirent[];
try {
  entries = await readdir(root, { withFileTypes: true });
} catch (error) {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    entries = [];
  } else {
    throw error;
  }
}

const lines: string[] = [];
for (const entry of entries) {
  if (entry.isFile() && entry.name === 'TEMPLATE.md') {
    composeMigrationRecords(
      [
        {
          filename: 'template.md',
          source: await readFile(join(root, entry.name), 'utf8'),
        },
      ],
      'v1.2',
    );
    continue;
  }
  if (!entry.isDirectory()) {
    throw new Error(`Unexpected migration-notes entry: ${entry.name}`);
  }
  parseReleaseLine(entry.name);
  lines.push(entry.name);
}

for (const line of lines) {
  const records = await loadMigrationRecords(repositoryRoot, line);
  console.log(
    `${migrationRecordDirectory(line)}: ${records.length} validated migration record(s)`
  );
}

console.log(`Validated ${lines.length} migration target line(s).`);

const eventName = process.env['GITHUB_EVENT_NAME'];
const baseBranch =
  eventName === 'pull_request'
    ? process.env['GITHUB_BASE_REF'] ?? ''
    : '';
if (baseBranch === 'main' || baseBranch.startsWith('releases/')) {
  const git = (args: string[]) => run('git', args, { cwd: repositoryRoot });
  const baseOid = (
    await git(['rev-parse', 'HEAD^1'])
  ).stdout.trim();
  const basePackage = JSON.parse(
    (await git(['show', `${baseOid}:package.json`])).stdout,
  );
  if (!isRecord(basePackage) || typeof basePackage['version'] !== 'string') {
    throw new Error('PR base package.json has no version.');
  }
  const expectedVersion = expectedMigrationVersion(
    baseBranch,
    basePackage['version'],
  );
  const generatedPatchback =
    baseBranch === PRIMARY_BRANCH &&
    process.env['GITHUB_REPOSITORY'] === PILOT_REPOSITORY &&
    process.env['GITHUB_HEAD_REPOSITORY'] === PILOT_REPOSITORY &&
    /^patchbacks\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      process.env['GITHUB_HEAD_REF'] ?? '',
    ) &&
    process.env['GITHUB_PR_AUTHOR_TYPE'] === 'Bot' &&
    process.env['GITHUB_PR_AUTHOR_LOGIN'] === RELEASE_APP_BOT_LOGIN;
  const { stdout: changed } = await git([
    'diff',
    '--name-status',
    '--find-renames',
    baseOid,
    'HEAD',
    '--',
    'migration-notes',
  ]);
  const changedPaths = new Set<string>();
  for (const line of changed.trim().split('\n').filter(Boolean)) {
    const fields = line.split('\t');
    for (const path of fields.slice(1)) {
      if (/^migration-notes\/v[^/]+\/[^/]+\.md$/.test(path)) {
        changedPaths.add(path);
      }
    }
  }

  for (const path of changedPaths) {
    const beforeSource = await readFileAtCommit(repositoryRoot, baseOid, path);
    const afterSource = await readFileAtCommit(repositoryRoot, 'HEAD', path);
    validateMigrationEvolution({
      afterSource,
      beforeSource,
      expectedVersion:
        generatedPatchback && beforeSource === null ? null : expectedVersion,
      path,
    });
  }
  console.log(
    `Validated Migration evolution against ${baseBranch} at ${baseOid}.`,
  );
}
