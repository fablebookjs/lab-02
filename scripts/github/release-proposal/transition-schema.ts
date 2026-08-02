import {
  normalizeReleaseChanges,
} from '../../shared/release-communication/records.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { validateFullOid } from '../../shared/prepared-commit/inspection.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

/** Schema-1 inert cut artifact passed from preparation to guarded application. */
export type CutTransition = {
  changes: ReleaseChange[];
  developmentBundleRef: string;
  developmentOid: string;
  developmentVersion: string;
  expectedPrereleaseOid: string | null;
  kind: 'cut';
  line: string;
  openPrereleasePr: number | undefined;
  proposalBundleRef: string;
  proposalOid: string;
  releaseVersion: string;
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
  sourceOid: string;
};

type MaintenanceActionBase = {
  expectedStagedOid: string | null;
  line: string;
  previousHighlightsBody: string | undefined;
  releaseOid: string;
  supersededPr: number | undefined;
};

export type MaintenanceAction =
  | (MaintenanceActionBase & {
      changes: undefined;
      kind: 'dormant';
      openPr: number | undefined;
    })
  | (MaintenanceActionBase & {
      changes: unknown[];
      kind: 'open';
      openPr: undefined;
      proposalOid: string;
      version: string;
    })
  | (MaintenanceActionBase & {
      changes: unknown[];
      kind: 'sync';
      openPr: number;
      proposalOid: string;
      version: string;
    })
  | (MaintenanceActionBase & {
      bundleRef: string;
      changes: unknown[];
      kind: 'create' | 'recreate';
      openPr: number | undefined;
      proposalOid: string;
      version: string;
    })
  | (MaintenanceActionBase & {
      bundleRef: string;
      changes: unknown[];
      kind: 'refresh' | 'replace';
      openPr: number;
      proposalOid: string;
      version: string;
    });

/** Schema-1 ordered stable-maintenance actions prepared without write credentials. */
export type MaintenanceTransition = {
  actions: MaintenanceAction[];
  kind: 'maintenance';
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  return stringValue(value, label);
};

const optionalPositiveInteger = (
  value: unknown,
  label: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const nullableOid = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  validateFullOid(value, label);
  return value;
};

/** Narrows the serialized cut protocol before any GitHub mutation consumes it. */
export function parseCutTransition(value: unknown): CutTransition {
  if (!isRecord(value)) throw new Error('Cut transition must be an object.');
  if (
    value['schema'] !== 1 ||
    value['kind'] !== 'cut' ||
    value['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Cut transition is outside the accepted schema.');
  }
  return {
    changes: normalizeReleaseChanges(value['changes']),
    developmentBundleRef: stringValue(
      value['developmentBundleRef'],
      'Cut development bundle ref',
    ),
    developmentOid: stringValue(value['developmentOid'], 'Cut development OID'),
    developmentVersion: stringValue(
      value['developmentVersion'],
      'Cut development version',
    ),
    expectedPrereleaseOid: nullableOid(
      value['expectedPrereleaseOid'],
      'Cut prerelease ref expectation',
    ),
    kind: 'cut',
    line: stringValue(value['line'], 'Cut release line'),
    openPrereleasePr: optionalPositiveInteger(
      value['openPrereleasePr'],
      'Cut open Prerelease PR',
    ),
    proposalBundleRef: stringValue(
      value['proposalBundleRef'],
      'Cut proposal bundle ref',
    ),
    proposalOid: stringValue(value['proposalOid'], 'Cut proposal OID'),
    releaseVersion: stringValue(value['releaseVersion'], 'Cut release version'),
    repository: PILOT_REPOSITORY,
    schema: 1,
    sourceOid: stringValue(value['sourceOid'], 'Cut source OID'),
  };
}

const maintenanceActionValue = (value: unknown): MaintenanceAction => {
  if (!isRecord(value)) throw new Error('Maintenance action must be an object.');
  const kind = value['kind'];
  if (
    kind !== 'create' &&
    kind !== 'dormant' &&
    kind !== 'open' &&
    kind !== 'recreate' &&
    kind !== 'refresh' &&
    kind !== 'replace' &&
    kind !== 'sync'
  ) {
    throw new Error(`Unknown maintenance action: ${String(kind)}`);
  }
  const base: MaintenanceActionBase = {
    expectedStagedOid: nullableOid(
      value['expectedStagedOid'],
      'Maintenance staged expectation',
    ),
    line: stringValue(value['line'], 'Maintenance release line'),
    previousHighlightsBody: optionalString(
      value['previousHighlightsBody'],
      'Maintenance previous highlights',
    ),
    releaseOid: stringValue(value['releaseOid'], 'Maintenance release OID'),
    supersededPr: optionalPositiveInteger(
      value['supersededPr'],
      'Maintenance superseded PR',
    ),
  };
  const openPr = optionalPositiveInteger(value['openPr'], 'Maintenance open PR');
  if (kind === 'dormant') return { ...base, changes: undefined, kind, openPr };

  const changes = value['changes'];
  if (!Array.isArray(changes)) {
    throw new Error(`${kind} maintenance action requires a changes array.`);
  }
  const proposalOid = stringValue(value['proposalOid'], 'Maintenance proposal OID');
  const version = stringValue(value['version'], 'Maintenance version');
  if (kind === 'open') {
    return { ...base, changes, kind, openPr: undefined, proposalOid, version };
  }
  if (kind === 'sync') {
    if (openPr === undefined) {
      throw new Error('Sync maintenance action requires an open PR.');
    }
    return { ...base, changes, kind, openPr, proposalOid, version };
  }

  const bundleRef = stringValue(value['bundleRef'], 'Maintenance bundle ref');
  if (kind === 'refresh' || kind === 'replace') {
    if (openPr === undefined) {
      throw new Error(`${kind} maintenance action requires an open PR.`);
    }
    return { ...base, bundleRef, changes, kind, openPr, proposalOid, version };
  }
  return { ...base, bundleRef, changes, kind, openPr, proposalOid, version };
};

/** Narrows every serialized maintenance action and its kind-specific requirements. */
export function parseMaintenanceTransition(
  value: unknown,
): MaintenanceTransition {
  if (
    !isRecord(value) ||
    value['schema'] !== 1 ||
    value['kind'] !== 'maintenance' ||
    value['repository'] !== PILOT_REPOSITORY ||
    !Array.isArray(value['actions'])
  ) {
    throw new Error('Maintenance transition is outside the accepted schema.');
  }
  return {
    actions: value['actions'].map(maintenanceActionValue),
    kind: 'maintenance',
    repository: PILOT_REPOSITORY,
    schema: 1,
  };
}
