import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readFileAtCommit } from '../scripts/shared/git/repository.ts';

const execute = promisify(execFile);
const git = (args: string[], cwd: string) =>
  execute('git', args, { cwd, env: process.env });

test('exact Git file reads distinguish absence from repository failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fablebook-git-file-test-'));
  try {
    await git(['init', '-b', 'main'], root);
    await git(['config', 'user.name', 'Lab 02 test'], root);
    await git(['config', 'user.email', 'lab-02-test@example.com'], root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'record.md'), 'exact content\n', 'utf8');
    await git(['add', 'nested/record.md'], root);
    await git(['commit', '-m', 'Add one record'], root);

    assert.equal(
      await readFileAtCommit(root, 'HEAD', 'nested/record.md'),
      'exact content\n',
    );
    assert.equal(await readFileAtCommit(root, 'HEAD', 'missing.md'), null);
    await assert.rejects(
      readFileAtCommit(root, 'not-a-commit', 'nested/record.md'),
      /rev-parse.*failed/,
    );
    await assert.rejects(
      readFileAtCommit(root, 'HEAD', 'nested'),
      /not one regular file/,
    );
  } finally {
    await rm(root, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});
