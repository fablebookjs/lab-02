import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const inspector = fileURLToPath(
  new URL(
    '../.agents/skills/gh-finish-patchback/scripts/inspect-patchback-pr.mjs',
    import.meta.url
  )
);

test('the Patchback inspector loads the current release modules', () => {
  const result = spawnSync(process.execPath, [inspector], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'inspect-patchback-pr: usage: inspect-patchback-pr.mjs <pr-number-or-url>\n'
  );
});
