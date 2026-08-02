import {
  composeMigrationRecords,
  type ComposedMigrationRecord,
} from './records.ts';
import {
  nextReleaseVersion,
  parseDevelopmentVersion,
  parseStableVersion,
} from '../release-proposal/core.ts';
import { PRIMARY_BRANCH } from '../repository.ts';

const migrationPathPattern =
  /^migration-notes\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/([a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;

export type MigrationRecordAtPath = ComposedMigrationRecord & {
  line: string;
  path: string;
};

/** Validates one Migration file together with its canonical release-line path. */
export function migrationRecordAtPath(
  path: string,
  source: string,
): MigrationRecordAtPath {
  const match = migrationPathPattern.exec(path);
  const line = match?.[1];
  const filename = match?.[2];
  if (line === undefined || filename === undefined) {
    throw new Error(`Invalid Migration record path: ${path}`);
  }
  const record = composeMigrationRecords([{ filename, source }], line)[0];
  if (record === undefined) {
    throw new Error(`Migration record is empty: ${path}`);
  }
  return { ...record, line, path };
}

/** Derives the stable version a newly authored Migration targets on a PR base. */
export function expectedMigrationVersion(
  baseBranch: string,
  baseVersion: string,
): string | null {
  if (baseBranch === PRIMARY_BRANCH) {
    const development = parseDevelopmentVersion(baseVersion);
    return `${development.major}.${development.minor}.0`;
  }
  if (baseBranch.startsWith('releases/')) {
    return nextReleaseVersion(baseBranch.slice('releases/'.length), baseVersion);
  }
  return null;
}

const compareStableVersions = (left: string, right: string): number => {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
};

/**
 * Enforces exact authorship and the immutable identity of a sealed Migration.
 * Released body text remains editable; deletion, path changes, and version
 * changes remain rejected.
 */
export function validateMigrationEvolution({
  afterSource,
  beforeSource,
  expectedVersion,
  path,
}: {
  afterSource: string | null;
  beforeSource: string | null;
  expectedVersion: string | null;
  path: string;
}): void {
  const before =
    beforeSource === null ? null : migrationRecordAtPath(path, beforeSource);
  const after =
    afterSource === null ? null : migrationRecordAtPath(path, afterSource);
  const expectedComparison =
    before === null || expectedVersion === null
      ? null
      : compareStableVersions(before.introducedIn, expectedVersion);

  if (before !== null && expectedComparison !== null && expectedComparison > 0) {
    throw new Error(
      `Migration ${path} targets future version ${before.introducedIn}.`,
    );
  }

  if (before !== null && expectedComparison !== null && expectedComparison < 0) {
    if (after === null) {
      throw new Error(`Released Migration cannot be deleted or renamed: ${path}`);
    }
    if (after.introducedIn !== before.introducedIn) {
      throw new Error(`Released Migration identity cannot change: ${path}`);
    }
    return;
  }

  if (
    after !== null &&
    expectedVersion !== null &&
    after.introducedIn !== expectedVersion
  ) {
    throw new Error(
      `Migration ${path} must declare introduced-in: ${expectedVersion}.`,
    );
  }
}
