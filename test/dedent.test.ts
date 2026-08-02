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

test('dedent preserves indentation across consecutive multiline values', () => {
  const first = `one\ntwo`;
  const second = `three\nfour`;

  assert.equal(
    dedent`
      list
        ${first}
        ${second}
    `,
    `list
  one
  two
  three
  four`,
  );
});
