import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

test('the privileged promotion job consumes only the sealed package plan', async () => {
  const source = await readFile(
    join(repositoryRoot, '.github', 'workflows', 'promote-latest.yml'),
    'utf8',
  );
  const promoteStart = source.indexOf('\n  promote:');
  assert.notEqual(promoteStart, -1);
  const preparation = source.slice(0, promoteStart);
  const privileged = source.slice(promoteStart);

  assert.ok(
    preparation.indexOf('Resolve the completed release') <
      preparation.indexOf('Check out the exact completed release snapshot'),
  );
  assert.ok(
    preparation.indexOf('Check out the exact completed release snapshot') <
      preparation.indexOf('Prepare the sealed latest-promotion plan'),
  );
  assert.ok(
    preparation.indexOf('Prepare the sealed latest-promotion plan') <
      preparation.indexOf('Transfer the inert latest-promotion manifest'),
  );
  assert.doesNotMatch(preparation, /NPM_PROMOTION_TOKEN|NODE_AUTH_TOKEN/);

  assert.equal(privileged.match(/uses: actions\/checkout@/g)?.length, 1);
  assert.match(privileged, /Check out only the trusted main controller/);
  assert.equal(source.match(/ref: \$\{\{ github\.sha \}\}/g)?.length, 2);
  assert.doesNotMatch(
    privileged,
    /path: snapshot|^\s+SNAPSHOT:|loadReleasePackageSet|list-packages/m,
  );
  assert.doesNotMatch(privileged, /resolve-promotion|github-token:/);
  assert.match(privileged, /actions\/download-artifact@/);
  assert.match(privileged, /EXPECTED_SNAPSHOT: \$\{\{ needs\.prepare\.outputs\.snapshot \}\}/);
  assert.match(privileged, /EXPECTED_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(privileged, /PROMOTION_MANIFEST:/);
});
