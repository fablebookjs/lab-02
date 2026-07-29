import assert from 'node:assert/strict';
import { test } from 'node:test';

import checkDescription from '../scripts/github/pull-request/check-description.ts';

const runtime = (pullRequest: unknown) =>
  ({
    context: {
      payload: { pull_request: pullRequest },
      repo: { owner: 'fablebookjs', repo: 'lab-02' },
    },
  }) as any;

test('a regular pull request with no tasks is an expected no-op', async () => {
  await checkDescription(
    runtime({
      base: { ref: 'main' },
      body: 'A useful description.',
      head: { ref: 'feature', repo: { full_name: 'someone/lab-02' } },
    }),
  );
});

test('a canonical release proposal with visible highlights succeeds', async () => {
  await checkDescription(
    runtime({
      base: { ref: 'releases/v2.1' },
      body: [
        '<!-- fablebook:release-highlights:start -->',
        'A clear reason to upgrade.',
        '<!-- fablebook:release-highlights:end -->',
      ].join('\n'),
      head: { ref: 'staged/v2.1', repo: { full_name: 'fablebookjs/lab-02' } },
    }),
  );
});

test('unsafe pull request descriptions fail closed', async () => {
  await assert.rejects(
    checkDescription(
      runtime({
        base: { ref: 'main' },
        body: '- [ ] finish this later',
        head: { ref: 'feature', repo: { full_name: 'someone/lab-02' } },
      }),
    ),
    /Resolve every unchecked Markdown task/,
  );
});
