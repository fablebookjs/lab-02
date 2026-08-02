import { isRecord, stringValue } from '../../shared/validation.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

export type ProposalActionBase = {
  boundaryOid: string;
  changes: ReleaseChange[];
  expectedStagedOid: string | null;
  mainOid: string;
  openPr: number | undefined;
  version: string;
};

export type ProposalTransitionAction =
  | {
      expectedStagedOid: string | null;
      kind: 'inactive';
      mainOid: string;
      reason: string;
    }
  | {
      expectedStagedOid: string | null;
      kind: 'none';
      mainOid: string;
      reason: string;
    }
  | (ProposalActionBase & {
      kind: 'clear';
      reason: string;
    })
  | (Omit<ProposalActionBase, 'openPr'> & {
      kind: 'sync';
      openPr: number;
      proposalOid: string;
      reason: string;
    })
  | (ProposalActionBase & {
      bundleRef: string;
      kind: 'create' | 'recreate' | 'refresh';
      proposalOid: string;
      reason: string;
    });

/** Schema-1 inert prerelease-maintenance action crossing the write-job boundary. */
export type PrereleaseProposalTransition = {
  action: ProposalTransitionAction;
  kind: 'prerelease-proposal';
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
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

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
};

const nullableOid = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  return oidValue(value, label);
};

const changesValue = (value: unknown): ReleaseChange[] => {
  if (!Array.isArray(value)) {
    throw new Error('Prerelease proposal action changes must be an array.');
  }
  return value.map((change) => {
    if (!isRecord(change)) {
      throw new Error('Prerelease proposal action change must be an object.');
    }
    return {
      key: stringValue(change['key'], 'Prerelease change key'),
      oid: oidValue(change['oid'], 'Prerelease change OID'),
      qaSkip: change['qaSkip'] === true,
      releaseNoteSkip: change['releaseNoteSkip'] === true,
      title: stringValue(change['title'], 'Prerelease change title'),
      url: stringValue(change['url'], 'Prerelease change URL'),
    };
  });
};

const transitionActionValue = (value: unknown): ProposalTransitionAction => {
  if (!isRecord(value)) {
    throw new Error('Prerelease proposal action must be an object.');
  }
  const kind = value['kind'];
  if (
    kind !== 'inactive' &&
    kind !== 'none' &&
    kind !== 'clear' &&
    kind !== 'sync' &&
    kind !== 'create' &&
    kind !== 'recreate' &&
    kind !== 'refresh'
  ) {
    throw new Error(`Unknown prerelease proposal action: ${String(kind)}`);
  }
  const expectedStagedOid = nullableOid(
    value['expectedStagedOid'],
    'Expected prerelease ref',
  );
  const mainOid = oidValue(value['mainOid'], 'Prerelease action main');
  const reason = stringValue(value['reason'], 'Prerelease action reason');
  if (kind === 'inactive' || kind === 'none') {
    return { expectedStagedOid, kind, mainOid, reason };
  }
  const base = {
    boundaryOid: oidValue(value['boundaryOid'], 'Prerelease action boundary'),
    changes: changesValue(value['changes']),
    expectedStagedOid,
    mainOid,
    openPr: optionalPositiveInteger(
      value['openPr'],
      'Prerelease action pull request',
    ),
    reason,
    version: stringValue(value['version'], 'Prerelease action version'),
  };
  if (kind === 'clear') {
    return { ...base, kind };
  }
  const proposalOid = oidValue(value['proposalOid'], 'Prerelease action proposal');
  if (kind === 'sync') {
    if (base.openPr === undefined) {
      throw new Error('Prerelease body synchronization requires an open PR.');
    }
    return { ...base, kind, openPr: base.openPr, proposalOid };
  }
  return {
    ...base,
    bundleRef: stringValue(value['bundleRef'], 'Prerelease proposal bundle ref'),
    kind,
    proposalOid,
  };
};

/**
 * Narrows the serialized prerelease transition and rejects kind-specific fields
 * that cannot support the requested application operation.
 */
export function parsePrereleaseProposalTransition(
  value: unknown,
): PrereleaseProposalTransition {
  if (
    !isRecord(value) ||
    value['schema'] !== 1 ||
    value['kind'] !== 'prerelease-proposal' ||
    value['repository'] !== PILOT_REPOSITORY
  ) {
    throw new Error(
      'Prerelease proposal transition is outside the accepted schema.',
    );
  }
  return {
    action: transitionActionValue(value['action']),
    kind: 'prerelease-proposal',
    repository: PILOT_REPOSITORY,
    schema: 1,
  };
}
