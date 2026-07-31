import assert from 'node:assert/strict';
import test from 'node:test';

import { formatChapterNavigation } from '../packages/core/src/index.ts';

test('chapter navigation progress variants remain coherent', () => {
  assert.equal(
    formatChapterNavigation(['Start', ''], {
      storyLayout: 'trail',
      progressVariant: 'compact',
      currentChapter: 1,
    }),
    'Start > Untitled chapter · Reading progress 1/2',
  );
});
