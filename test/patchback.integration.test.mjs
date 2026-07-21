import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { derivePatchbackItems } from '../scripts/patchback-core.mjs';

const execute = promisify(execFile);
const git = (args, cwd) => execute('git', args, { cwd, env: process.env });
const oid = async (name, cwd) => (await git(['rev-parse', name], cwd)).stdout.trim();
const parents = async (name, cwd) =>
  (await git(['show', '-s', '--format=%P', name], cwd)).stdout.trim().split(/\s+/).filter(Boolean);

test('a snapshot range treats a direct merge as one first-parent patchback item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fablebook-patchback-test-'));
  try {
    await git(['init', '-b', 'main'], root);
    await git(['config', 'user.name', 'Lab 02 test'], root);
    await git(['config', 'user.email', 'lab-02-test@example.com'], root);
    await git(['config', 'maintenance.auto', 'false'], root);
    await writeFile(join(root, 'history.txt'), 'release cut\n', 'utf8');
    await git(['add', 'history.txt'], root);
    await git(['commit', '-m', 'release cut'], root);
    const boundaryOid = await oid('HEAD', root);

    await writeFile(join(root, 'history.txt'), 'release cut\ndirect fix\n', 'utf8');
    await git(['commit', '-am', 'fix: direct release correction'], root);
    const directOid = await oid('HEAD', root);

    await git(['switch', '-c', 'maintenance'], root);
    await writeFile(join(root, 'merged.txt'), 'merged correction\n', 'utf8');
    await git(['add', 'merged.txt'], root);
    await git(['commit', '-m', 'fix: maintenance branch correction'], root);
    await git(['switch', 'main'], root);
    await git(['merge', '--no-ff', 'maintenance', '-m', 'Merge maintenance directly'], root);
    const mergeOid = await oid('HEAD', root);

    await git(['switch', '-c', 'proposal'], root);
    await git(['commit', '--allow-empty', '-m', 'release: propose v1.0.0'], root);
    await git(['switch', 'main'], root);
    await git(['merge', '--no-ff', 'proposal', '-m', 'Merge release proposal'], root);
    const snapshotOid = await oid('HEAD', root);

    const { stdout } = await git(
      ['rev-list', '--first-parent', '--reverse', `${boundaryOid}..${snapshotOid}`],
      root
    );
    const commits = await Promise.all(
      stdout.trim().split('\n').map(async (commitOid) => ({
        associatedPulls: [],
        oid: commitOid,
        parents: await parents(commitOid, root),
        subject: (await git(['show', '-s', '--format=%s', commitOid], root)).stdout.trim(),
      }))
    );
    const items = derivePatchbackItems({ commits, line: 'v1.0', snapshotOid });

    assert.deepEqual(
      items.map(({ kind, oid: itemOid }) => ({ kind, oid: itemOid })),
      [
        { kind: 'direct-commit', oid: directOid },
        { kind: 'direct-merge', oid: mergeOid },
      ]
    );
    assert.equal(items[1].command, `git cherry-pick -m 1 ${mergeOid}`);
  } finally {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
