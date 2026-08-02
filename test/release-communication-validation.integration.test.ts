import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';
import { materializeVersion } from '../scripts/shared/version/materialize.ts';

const execute = promisify(execFile);
const git = (args: string[], cwd: string) =>
  execute('git', args, { cwd, env: process.env });

const migration = (introducedIn: string): string => `---
introduced-in: ${introducedIn}
priority: test validation
---
# Exercise exact validation

## Who is affected

Projects using the test API.

## How to migrate

Use the replacement test API.
`;

const withWorktree = async (
  prefix: string,
  run: (worktree: string) => Promise<void>,
): Promise<void> => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), prefix));
  const worktree = join(temporaryRoot, `worktree-${basename(temporaryRoot)}`);
  let added = false;
  try {
    await git(['worktree', 'add', '--detach', worktree, 'HEAD'], repositoryRoot);
    added = true;
    await git(['config', 'user.name', 'Lab 02 test'], worktree);
    await git(['config', 'user.email', 'lab-02-test@example.com'], worktree);
    await materializeVersion(worktree, '5.1.0-alpha.0');
    await git(
      [
        'add',
        'package.json',
        'package-lock.json',
        'packages/addon/package.json',
        'packages/core/package.json',
      ],
      worktree,
    );
    await git(['commit', '-m', 'Create main development fixture'], worktree);
    await run(worktree);
  } finally {
    if (added) {
      await git(['worktree', 'remove', '--force', worktree], repositoryRoot).catch(
        () => undefined,
      );
    }
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
};

const validate = async (
  worktree: string,
  overrides: NodeJS.ProcessEnv,
) => {
  const relativePath = 'scripts/release-communication/validate.ts';
  await copyFile(
    join(repositoryRoot, relativePath),
    join(worktree, relativePath),
  );
  return execute('node', [relativePath], {
    cwd: worktree,
    env: {
      ...process.env,
      GITHUB_BASE_REF: 'main',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_HEAD_REF: 'feature/example',
      GITHUB_HEAD_REPOSITORY: 'fablebookjs/lab-02',
      GITHUB_PR_AUTHOR_LOGIN: 'maintainer',
      GITHUB_PR_AUTHOR_TYPE: 'User',
      GITHUB_REPOSITORY: 'fablebookjs/lab-02',
      ...overrides,
    },
  });
};

test('CI passes immutable Patchback PR identity to Migration validation', async () => {
  const workflow = await readFile(
    join(repositoryRoot, '.github/workflows/ci.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /GITHUB_HEAD_REPOSITORY: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(
    workflow,
    /GITHUB_PR_AUTHOR_LOGIN: \$\{\{ github\.event\.pull_request\.user\.login \}\}/,
  );
  assert.match(
    workflow,
    /GITHUB_PR_AUTHOR_TYPE: \$\{\{ github\.event\.pull_request\.user\.type \}\}/,
  );
});

test('only the release bot canonical Patchback PR receives the version exception', async () => {
  await withWorktree('fablebook-migration-pr-identity-', async (worktree) => {
    const directory = join(worktree, 'migration-notes', 'v5.0');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'test-exact-validation.md'), migration('5.0.1'));
    await git(['add', 'migration-notes/v5.0/test-exact-validation.md'], worktree);
    await git(['commit', '-m', 'Add a historical-line Migration'], worktree);

    const patchback = {
      GITHUB_HEAD_REF: 'patchbacks/v5.0.1',
      GITHUB_PR_AUTHOR_LOGIN: 'fablebook-lab-02-release[bot]',
      GITHUB_PR_AUTHOR_TYPE: 'Bot',
    };
    await validate(worktree, patchback);
    await assert.rejects(
      validate(worktree, { ...patchback, GITHUB_PR_AUTHOR_LOGIN: 'maintainer' }),
      /must declare introduced-in: 5\.1\.0/,
    );
    await assert.rejects(
      validate(worktree, {
        ...patchback,
        GITHUB_HEAD_REPOSITORY: 'someone/lab-02',
      }),
      /must declare introduced-in: 5\.1\.0/,
    );
    await assert.rejects(
      validate(worktree, { ...patchback, GITHUB_HEAD_REF: 'staged/v5.0' }),
      /must declare introduced-in: 5\.1\.0/,
    );
  });
});

test('normalized main rejects the removed legacy frontmatter transition', async () => {
  await withWorktree('fablebook-migration-legacy-', async (worktree) => {
    const path = join(
      worktree,
      'migration-notes/v2.0/adopt-count-summaries.md',
    );
    const normalized = await readFile(path, 'utf8');
    const legacy = normalized.replace(/^introduced-in: .+\n/m, '');
    await writeFile(path, legacy, 'utf8');
    await git(['commit', '-am', 'Create a legacy base fixture'], worktree);
    await writeFile(path, normalized, 'utf8');
    await git(['commit', '-am', 'Restore introduced-in'], worktree);

    await assert.rejects(validate(worktree, {}), /introduced-in/);
  });
});
