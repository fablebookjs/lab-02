import {
  parseManualPrereleasePhase,
  planPhaseEntry,
} from '../../shared/prerelease-phase-entry/core.ts';
import type { ManualPrereleasePhase } from '../../shared/prerelease-phase-entry/core.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { parseDevelopmentVersion } from '../../shared/release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

export const PHASE_ENTRY_BUNDLE_REF =
  'refs/release-pilot/artifact/prerelease-phase-entry';

export type CanonicalPrereleaseState = {
  expectedStagedOid: string | null;
  openPr: number | undefined;
};

export type PhaseEntryActionBase = CanonicalPrereleaseState & {
  boundaryOid: string;
  changes: ReleaseChange[];
  currentMainOid: string;
  phase: ManualPrereleasePhase;
  snapshotOid: string;
  sourceOid: string;
  version: string;
};

export type PhaseEntryAction =
  | (PhaseEntryActionBase & {
      bundleRef: typeof PHASE_ENTRY_BUNDLE_REF;
      kind: 'establish';
    })
  | (PhaseEntryActionBase & {
      kind: 'reconcile';
    });

/** Schema-1 phase-entry artifact prepared before GitHub write authority is granted. */
export type PhaseEntryTransition = {
  action: PhaseEntryAction;
  kind: 'prerelease-phase-entry';
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

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
};

const optionalPositiveInteger = (
  value: unknown,
  label: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be one positive integer.`);
  }
  return value;
};

const changesValue = (value: unknown): ReleaseChange[] => {
  if (!Array.isArray(value)) {
    throw new Error('Phase-entry changes must be an array.');
  }
  return value.map((change) => {
    if (!isRecord(change)) {
      throw new Error('Phase-entry change must be an object.');
    }
    return {
      key: stringValue(change['key'], 'Phase-entry change key'),
      oid: oidValue(change['oid'], 'Phase-entry change OID'),
      qaSkip: change['qaSkip'] === true,
      releaseNoteSkip: change['releaseNoteSkip'] === true,
      title: stringValue(change['title'], 'Phase-entry change title'),
      url: stringValue(change['url'], 'Phase-entry change URL'),
    };
  });
};

const actionValue = (value: unknown): PhaseEntryAction => {
  if (!isRecord(value)) {
    throw new Error('Phase-entry action must be an object.');
  }
  const kind = value['kind'];
  if (kind !== 'establish' && kind !== 'reconcile') {
    throw new Error(`Unknown phase-entry action: ${String(kind)}`);
  }
  const phase = parseManualPrereleasePhase(
    stringValue(value['phase'], 'Phase-entry target'),
  );
  const base: PhaseEntryActionBase = {
    boundaryOid: oidValue(value['boundaryOid'], 'Phase-entry boundary'),
    changes: changesValue(value['changes']),
    currentMainOid: oidValue(value['currentMainOid'], 'Phase-entry main'),
    expectedStagedOid:
      value['expectedStagedOid'] === null
        ? null
        : oidValue(value['expectedStagedOid'], 'Expected prerelease ref'),
    openPr: optionalPositiveInteger(value['openPr'], 'Expected Prerelease PR'),
    phase,
    snapshotOid: oidValue(value['snapshotOid'], 'Phase-entry snapshot'),
    sourceOid: oidValue(value['sourceOid'], 'Phase-entry source'),
    version: stringValue(value['version'], 'Phase-entry version'),
  };
  if (kind === 'reconcile') {
    planPhaseEntry({
      currentVersion: base.version,
      entry: {
        boundaryOid: base.boundaryOid,
        phase,
        snapshotOid: base.snapshotOid,
        sourceOid: base.sourceOid,
        version: base.version,
      },
      target: phase,
    });
    return { ...base, kind };
  }
  const version = parseDevelopmentVersion(base.version);
  if (version.prerelease !== phase || version.prereleaseNumber !== 0) {
    throw new Error('Phase-entry action version contradicts its target.');
  }
  if (base.currentMainOid !== base.sourceOid) {
    throw new Error('A new phase entry must directly advance prepared main.');
  }
  if (value['bundleRef'] !== PHASE_ENTRY_BUNDLE_REF) {
    throw new Error('Phase-entry action has an unexpected bundle ref.');
  }
  return {
    ...base,
    bundleRef: PHASE_ENTRY_BUNDLE_REF,
    kind,
  };
};

/**
 * Narrows a phase-entry artifact and re-proves establish/reconcile invariants
 * before its guarded ref transition can run.
 */
export function parsePhaseEntryTransition(value: unknown): PhaseEntryTransition {
  if (
    !isRecord(value) ||
    value['schema'] !== 1 ||
    value['kind'] !== 'prerelease-phase-entry' ||
    value['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error('Phase-entry transition is outside the accepted schema.');
  }
  return {
    action: actionValue(value['action']),
    kind: 'prerelease-phase-entry',
    repository: PILOT_REPOSITORY,
    schema: 1,
  };
}
