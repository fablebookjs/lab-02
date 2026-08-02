import { isRecord, stringValue } from '../../shared/validation.ts';
import { migrationRecordDirectory } from '../../shared/release-communication/records.ts';
import {
  patchbackCommitMessage,
  patchbackIdentity,
  patchbackMigrationRecords,
  patchbackReleaseRecord,
  previousReleaseVersion,
} from '../../shared/patchback/core.ts';
import type { PatchbackItem } from '../../shared/patchback/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { parsePatchbackAuthority } from './authority-schema.ts';
import type { PatchbackAuthority } from './authority-schema.ts';
import {
  PATCHBACK_EXAMPLES_COMMENT,
  renderPatchbackPrBody,
} from './templates.ts';

export type PatchbackRecord = {
  content: string;
  path: string;
};

export type PatchbackMigrationRecord = PatchbackRecord & {
  title: string;
};

/**
 * Schema-3 complete patchback plan: authority, coordination commit inputs,
 * synchronized communication, and immutable maintainer work queue.
 */
export type PatchbackManifest = {
  authority: PatchbackAuthority;
  baseMainOid: string;
  baseMainTreeOid: string;
  body: string;
  boundaryLabel: string;
  boundaryOid: string;
  branch: string;
  comment: string;
  coordinationMessage: string;
  items: PatchbackItem[];
  migrationRecords: PatchbackMigrationRecord[];
  releaseRecord: PatchbackRecord;
  repository: typeof PILOT_REPOSITORY;
  schema: 3;
  title: string;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const patchbackItemValue = (value: unknown): PatchbackItem => {
  if (!isRecord(value)) throw new Error('Patchback item must be an object.');
  const kind = value['kind'];
  if (
    kind !== 'pull-request' &&
    kind !== 'direct-commit' &&
    kind !== 'direct-merge'
  ) {
    throw new Error('Patchback item has an invalid kind.');
  }
  let pullRequest: number | null;
  if (kind === 'pull-request') {
    pullRequest = positiveInteger(
      value['pullRequest'],
      'Patchback item pull request',
    );
  } else {
    if (value['pullRequest'] !== null) {
      throw new Error('Direct patchback items cannot identify a pull request.');
    }
    pullRequest = null;
  }
  return {
    command: stringValue(value['command'], 'Patchback item command'),
    kind,
    oid: fullOid(value['oid'], 'Patchback item'),
    pullRequest,
    subject: stringValue(value['subject'], 'Patchback item subject'),
  };
};

/**
 * Reconstructs and validates every derived patchback surface from an untrusted
 * artifact so a privileged job never trusts pre-rendered paths or text alone.
 */
export function parsePatchbackManifest(input: unknown): PatchbackManifest {
  if (
    !isRecord(input) ||
    input['schema'] !== 3 ||
    input['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Patchback manifest is outside the pilot schema.');
  }
  const authorityInput = input['authority'];
  if (!isRecord(authorityInput)) {
    throw new Error('Patchback manifest has no authority object.');
  }
  const authority = parsePatchbackAuthority({
    ...authorityInput,
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  const releaseRecordInput = input['releaseRecord'];
  if (!isRecord(releaseRecordInput)) {
    throw new Error('Patchback manifest has no release record.');
  }
  const releaseRecord = patchbackReleaseRecord({
    source: releaseRecordInput['content'],
    version: authority.version,
  });
  if (releaseRecordInput['path'] !== releaseRecord.path) {
    throw new Error('Patchback manifest release record path is invalid.');
  }
  const rawMigrationRecords = input['migrationRecords'];
  const migrationDirectory = `${migrationRecordDirectory(authority.line)}/`;
  const migrationRecords = patchbackMigrationRecords({
    line: authority.line,
    records: Array.isArray(rawMigrationRecords)
      ? rawMigrationRecords.map((record) => {
          if (!isRecord(record)) {
            throw new Error('Patchback migration record must be an object.');
          }
          const path = record['path'];
          return {
            filename:
              typeof path === 'string' && path.startsWith(migrationDirectory)
                ? path.slice(migrationDirectory.length)
                : path,
            source: record['content'],
          };
        })
      : rawMigrationRecords,
  });
  if (
    JSON.stringify(rawMigrationRecords) !== JSON.stringify(migrationRecords)
  ) {
    throw new Error('Patchback manifest migration records are invalid.');
  }
  const rawItems = input['items'];
  if (!Array.isArray(rawItems)) {
    throw new Error('Patchback manifest has no ordered item list.');
  }
  const items = rawItems.map(patchbackItemValue);
  const manifest: PatchbackManifest = {
    authority,
    baseMainOid: fullOid(input['baseMainOid'], 'Patchback main base'),
    baseMainTreeOid: fullOid(input['baseMainTreeOid'], 'Patchback main tree'),
    body: stringValue(input['body'], 'Patchback body'),
    boundaryLabel: stringValue(
      input['boundaryLabel'],
      'Patchback boundary label',
    ),
    boundaryOid: fullOid(input['boundaryOid'], 'Patchback boundary'),
    branch: stringValue(input['branch'], 'Patchback branch'),
    comment: stringValue(input['comment'], 'Patchback comment'),
    coordinationMessage: stringValue(
      input['coordinationMessage'],
      'Patchback coordination message',
    ),
    items,
    migrationRecords,
    releaseRecord,
    repository: PILOT_REPOSITORY,
    schema: 3,
    title: stringValue(input['title'], 'Patchback title'),
  };

  const identity = patchbackIdentity(manifest.authority.version);
  if (
    manifest.branch !== identity.branch ||
    manifest.title !== identity.title ||
    manifest.authority.line !== identity.line ||
    manifest.comment !== PATCHBACK_EXAMPLES_COMMENT
  ) {
    throw new Error('Patchback manifest identity is invalid.');
  }
  const previousVersion = previousReleaseVersion(authority.version);
  const expectedBoundaryLabel =
    previousVersion === null
      ? `release cut for ${authority.line}`
      : `completed v${previousVersion} snapshot`;
  if (manifest.boundaryLabel !== expectedBoundaryLabel) {
    throw new Error('Patchback scope boundary label is invalid.');
  }
  for (const item of manifest.items) {
    if (
      item.subject.length > 160 ||
      !new RegExp(`^git cherry-pick (?:-m 1 )?${item.oid}$`).test(
        item.command,
      ) ||
      (item.kind === 'pull-request' &&
        (item.pullRequest === null ||
          !Number.isSafeInteger(item.pullRequest) ||
          item.pullRequest <= 0)) ||
      (item.kind !== 'pull-request' && item.pullRequest !== null)
    ) {
      throw new Error('Patchback manifest contains an invalid item.');
    }
  }
  const expectedBody = renderPatchbackPrBody({
    boundaryLabel: manifest.boundaryLabel,
    boundaryOid: manifest.boundaryOid,
    items: manifest.items,
    line: authority.line,
    migrationRecords,
    recordPath: releaseRecord.path,
    snapshotOid: authority.snapshotOid,
    version: authority.version,
  });
  if (manifest.body !== expectedBody) {
    throw new Error('Patchback body does not match its immutable item list.');
  }
  const expectedMessage = patchbackCommitMessage({
    baseMainOid: manifest.baseMainOid,
    boundaryOid: manifest.boundaryOid,
    line: authority.line,
    migrationRecordPaths: migrationRecords.map(({ path }) => path),
    recordPath: releaseRecord.path,
    snapshotOid: authority.snapshotOid,
    version: authority.version,
  });
  if (manifest.coordinationMessage !== expectedMessage) {
    throw new Error('Patchback coordination commit message is invalid.');
  }
  return manifest;
}
