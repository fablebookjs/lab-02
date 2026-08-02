import assert from 'node:assert/strict';
import test from 'node:test';

import { dedent } from '../scripts/shared/text/dedent.ts';

test('dedent exposes only the template-tag interface', () => {
  const detail = `first line\nsecond line`;

  assert.equal(
    dedent`
      heading
        ${detail}
      ending
    `,
    `heading
  first line
  second line
ending`,
  );
});
