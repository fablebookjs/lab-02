import {
  patchbackIdentity,
  releaseMergerAssignee,
} from '../../shared/patchback/core.ts';
import type { ReleaseAuthority } from '../../shared/release-publication/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

export type PatchbackAuthority = ReleaseAuthority & {
  assignee: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
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

export function parsePatchbackAuthority(document: unknown): PatchbackAuthority {
  if (
    !isRecord(document) ||
    document['schema'] !== 1 ||
    document['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error(
      'Patchback authority document is outside the pilot schema.',
    );
  }
  const assignee = document['assignee'];
  if (assignee !== null && typeof assignee !== 'string') {
    throw new Error('Patchback authority has an invalid assignee.');
  }
  const authority: PatchbackAuthority = {
    assignee,
    channel: stringValue(document['channel'], 'Patchback channel'),
    line: stringValue(document['line'], 'Patchback line'),
    proposalOid: fullOid(document['proposalOid'], 'Proposal'),
    pullRequest: positiveInteger(
      document['pullRequest'],
      'Patchback pull request',
    ),
    snapshotOid: fullOid(document['snapshotOid'], 'Snapshot'),
    sourceOid: fullOid(document['sourceOid'], 'Release source'),
    version: stringValue(document['version'], 'Patchback version'),
  };
  patchbackIdentity(authority.version);
  if (
    authority.assignee !== null &&
    releaseMergerAssignee({ merged_by: { login: authority.assignee } }) !==
      authority.assignee
  ) {
    throw new Error('Patchback authority has an invalid assignee.');
  }
  return authority;
}
