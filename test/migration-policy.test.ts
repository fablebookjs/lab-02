import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedMigrationVersion,
  migrationRecordAtPath,
  validateMigrationEvolution,
} from '../scripts/shared/release-communication/migration-policy.ts';

const migration = (
  introducedIn: string,
  instruction = 'Use the new API.',
): string => `---
introduced-in: ${introducedIn}
priority: required API updates
---
# Adopt the new API

## Who is affected

Users of the old API.

## How to migrate

${instruction}
`;

const path = 'migration-notes/v5.0/adopt-new-api.md';

test('PR bases derive the one stable version a new Migration may target', () => {
  for (const version of ['5.0.0-alpha.4', '5.0.0-beta.2', '5.0.0-rc.1']) {
    assert.equal(expectedMigrationVersion('main', version), '5.0.0');
  }
  assert.equal(expectedMigrationVersion('releases/v5.0', '5.0.0-alpha.0'), '5.0.0');
  assert.equal(expectedMigrationVersion('releases/v5.0', '5.0.3'), '5.0.4');
  assert.equal(expectedMigrationVersion('feature/example', '5.0.0-alpha.0'), null);
});

test('Migration paths and introduced-in must identify the same release line', () => {
  assert.equal(migrationRecordAtPath(path, migration('5.0.0')).introducedIn, '5.0.0');
  assert.throws(
    () => migrationRecordAtPath(path, migration('5.1.0')),
    /belongs to 5\.1\.0, not v5\.0/,
  );
});

test('unreleased Migrations may be edited, removed, or renamed within their target version', () => {
  validateMigrationEvolution({
    afterSource: migration('5.0.0', 'Use the better API.'),
    beforeSource: migration('5.0.0'),
    expectedVersion: '5.0.0',
    path,
  });
  validateMigrationEvolution({
    afterSource: null,
    beforeSource: migration('5.0.0'),
    expectedVersion: '5.0.0',
    path,
  });
  assert.throws(
    () =>
      validateMigrationEvolution({
        afterSource: migration('5.0.1'),
        beforeSource: null,
        expectedVersion: '5.0.0',
        path,
      }),
    /must declare introduced-in: 5\.0\.0/,
  );
});

test('released Migration identity is permanent while guidance remains correctable', () => {
  validateMigrationEvolution({
    afterSource: migration('5.0.0', 'Use the corrected API.'),
    beforeSource: migration('5.0.0'),
    expectedVersion: '5.0.1',
    path,
  });
  assert.throws(
    () =>
      validateMigrationEvolution({
        afterSource: null,
        beforeSource: migration('5.0.0'),
        expectedVersion: '5.0.1',
        path,
      }),
    /cannot be deleted or renamed/,
  );
  assert.throws(
    () =>
      validateMigrationEvolution({
        afterSource: migration('5.0.1'),
        beforeSource: migration('5.0.0'),
        expectedVersion: '5.0.1',
        path,
      }),
    /identity cannot change/,
  );
  assert.throws(
    () =>
      validateMigrationEvolution({
        afterSource: migration('5.0.2'),
        beforeSource: migration('5.0.2'),
        expectedVersion: '5.0.1',
        path,
      }),
    /targets future version 5\.0\.2/,
  );
});
