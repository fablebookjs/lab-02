import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  extractPrereleasePrIdentity,
  renderPrereleasePrBody,
  validatePrereleasePrBody,
} from '../../shared/prerelease-proposal/body.ts';
import {
  nextPrereleaseVersion,
  parsePrereleaseProposalMessage,
  planPrereleaseProposal,
  prereleaseProposalCommitMessage,
} from '../../shared/prerelease-proposal/core.ts';
import type {
  PrereleaseProposal,
  PrereleaseProposalPlan,
} from '../../shared/prerelease-proposal/core.ts';
import { ZERO_OID } from '../../shared/release-proposal/core.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import type { ValidatedPullRequest } from '../events.ts';
import {
  readJson,
  requireGithubToken,
  requireOption,
  run,
  writeJson,
} from '../controller-support.ts';
import type { RunOptions } from '../controller-support.ts';
import {
  prereleaseChanges,
  proposalAssertExpectedRef,
  proposalCommitMessageAt,
  proposalCommitParents,
  proposalImportBundle,
  proposalImportedOid,
  proposalMaterializeCommit,
  proposalPrepareOutput,
  proposalRootVersionAt,
  proposalUploadCommitObject,
  proposalValidateVersionTree,
  proposalWriteBundle,
} from '../release-proposal/controller.ts';
import {
  closePullRequest,
  createDraftPrereleasePr,
  createRefUpdate,
  getRef,
  getRepository,
  listPrereleasePulls,
  PILOT_REPOSITORY,
  updatePullRequestBody,
  updateRefs,
} from '../release-proposal/github.ts';

const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';

type ManagedBoundary = {
  oid: string;
  version: string;
};

type ProposalActionBase = {
  boundaryOid: string;
  changes: ReleaseChange[];
  expectedStagedOid: string | null;
  mainOid: string;
  openPr: number | undefined;
  version: string;
};

type ProposalTransitionAction =
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

type ProposalTransition = {
  action: ProposalTransitionAction;
  kind: 'prerelease-proposal';
  repository: typeof PILOT_REPOSITORY;
  schema: 1;
};

export type PreparePrereleaseProposalOptions = {
  'github-token': string;
  output: string;
};

export type ApplyPrereleaseProposalOptions = {
  bundle?: string;
  'github-token': string;
  transition: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
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

const git = (args: string[], options: RunOptions = {}) =>
  run('git', args, { ...options, cwd: options.cwd ?? repositoryRoot });

const ensureRepository = async (): Promise<void> => {
  const root = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
  if (resolve(root) !== resolve(repositoryRoot)) {
    throw new Error(
      'Prerelease proposal commands must run from the Lab-02 repository.',
    );
  }
  if ((await git(['status', '--porcelain'])).stdout.trim().length > 0) {
    throw new Error(
      'Prerelease proposal preparation requires a clean working tree.',
    );
  }
};

const currentOid = async (): Promise<string> =>
  oidValue(
    (await git(['rev-parse', 'HEAD'])).stdout.trim(),
    'Current repository commit',
  );

const treeOid = async (oid: string): Promise<string> =>
  oidValue(
    (await git(['show', '-s', '--format=%T', oid])).stdout.trim(),
    `${oid} tree`,
  );

const findManagedBoundary = async (
  mainOid: string,
): Promise<ManagedBoundary | null> => {
  const history = (
    await git(['rev-list', '--first-parent', mainOid])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const oid of history) {
    const parents = await proposalCommitParents(oid);
    const proposalOid = parents[1];
    if (parents.length !== 2 || proposalOid === undefined) {
      continue;
    }
    let proposal: PrereleaseProposal;
    try {
      proposal = parsePrereleaseProposalMessage(
        await proposalCommitMessageAt(proposalOid),
      );
    } catch {
      continue;
    }
    if (
      parents[0] !== proposal.sourceOid ||
      (await treeOid(oid)) !== (await treeOid(proposalOid))
    ) {
      throw new Error(
        `${oid} resembles a prerelease snapshot but does not exactly merge its proposal.`,
      );
    }
    await proposalValidateVersionTree(oid, proposal.version);
    return { oid, version: proposal.version };
  }
  return null;
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
    boundaryOid: oidValue(
      value['boundaryOid'],
      'Prerelease action boundary',
    ),
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
  const proposalOid = oidValue(
    value['proposalOid'],
    'Prerelease action proposal',
  );
  if (kind === 'sync') {
    if (base.openPr === undefined) {
      throw new Error('Prerelease body synchronization requires an open PR.');
    }
    return { ...base, kind, openPr: base.openPr, proposalOid };
  }
  return {
    ...base,
    bundleRef: stringValue(
      value['bundleRef'],
      'Prerelease proposal bundle ref',
    ),
    kind,
    proposalOid,
  };
};

const transitionValue = (value: unknown): ProposalTransition => {
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
};

const validateProposalCommit = async (
  oid: string,
  expected: {
    boundaryOid: string;
    sourceOid: string;
    version: string;
  },
): Promise<void> => {
  assert.deepEqual(await proposalCommitParents(oid), [expected.sourceOid]);
  const proposal = parsePrereleaseProposalMessage(
    await proposalCommitMessageAt(oid),
  );
  assert.equal(proposal.boundaryOid, expected.boundaryOid);
  assert.equal(proposal.sourceOid, expected.sourceOid);
  assert.equal(proposal.version, expected.version);
  await proposalValidateVersionTree(oid, expected.version);
};

const actionBody = (
  action: ProposalActionBase,
  proposalOid: string,
): string =>
  renderPrereleasePrBody({
    boundaryOid: action.boundaryOid,
    changes: action.changes,
    proposalOid,
    sourceOid: action.mainOid,
    version: action.version,
  });

const loadStagedProposal = async (
  token: string,
): Promise<(PrereleaseProposal & { oid: string }) | null> => {
  const ref = await getRef(token, 'heads/prerelease');
  if (ref === null) return null;
  await git([
    'fetch',
    '--no-tags',
    'origin',
    '+refs/heads/prerelease:refs/remotes/origin/prerelease',
  ]);
  return {
    ...parsePrereleaseProposalMessage(await proposalCommitMessageAt(ref.oid)),
    oid: ref.oid,
  };
};

export async function preparePrereleaseProposal(
  options: PreparePrereleaseProposalOptions,
): Promise<void> {
  await ensureRepository();
  const output = await proposalPrepareOutput(
    requireOption(options, 'output'),
  );
  const token = requireGithubToken(options);
  const mainOid = await currentOid();
  const lineVersion = await proposalRootVersionAt(mainOid);
  const boundary = await findManagedBoundary(mainOid);
  if (boundary !== null && boundary.version !== lineVersion) {
    throw new Error(
      `main carries ${lineVersion}, but its latest managed prerelease snapshot carries ${boundary.version}.`,
    );
  }
  const staged = await loadStagedProposal(token);
  const pulls = await listPrereleasePulls(token);
  const openPulls = pulls.filter(({ state }) => state === 'open');
  if (openPulls.length > 1) {
    throw new Error('More than one canonical Prerelease PR is open.');
  }
  const openPull = openPulls[0] ?? null;
  const identity = extractPrereleasePrIdentity(openPull?.body);
  const bodyCurrent =
    staged !== null &&
    identity !== null &&
    identity.boundaryOid === staged.boundaryOid &&
    identity.proposalOid === staged.oid &&
    identity.sourceOid === staged.sourceOid &&
    identity.version === staged.version;
  const plan = planPrereleaseProposal({
    boundaryOid: boundary?.oid ?? null,
    lineVersion,
    mainOid,
    openPr:
      openPull === null
        ? null
        : { bodyCurrent, number: openPull.number },
    staged,
  });
  const changes =
    boundary === null || mainOid === boundary.oid
      ? []
      : await prereleaseChanges(token, {
          boundaryOid: boundary.oid,
          sourceOid: mainOid,
        });

  let action: ProposalTransitionAction;
  let bundle:
    | { name: string; oid: string }
    | undefined;
  if (
    plan.kind === 'create' ||
    plan.kind === 'recreate' ||
    plan.kind === 'refresh'
  ) {
    if (boundary === null) {
      throw new Error('A prepared prerelease proposal requires a managed boundary.');
    }
    const attempt = randomUUID();
    const proposalOid = await proposalMaterializeCommit({
      message: prereleaseProposalCommitMessage({
        attempt,
        boundaryOid: boundary.oid,
        sourceOid: mainOid,
        version: plan.version,
      }),
      sourceOid: mainOid,
      version: plan.version,
    });
    await validateProposalCommit(proposalOid, {
      boundaryOid: boundary.oid,
      sourceOid: mainOid,
      version: plan.version,
    });
    bundle = {
      name: `${ARTIFACT_PREFIX}prerelease-proposal-${attempt}`,
      oid: proposalOid,
    };
    action = {
      boundaryOid: boundary.oid,
      bundleRef: bundle.name,
      changes,
      expectedStagedOid: staged?.oid ?? null,
      kind: plan.kind,
      mainOid,
      openPr: plan.openPr,
      proposalOid,
      reason: plan.reason,
      version: plan.version,
    };
  } else if (plan.kind === 'sync') {
    if (boundary === null || staged === null) {
      throw new Error('Prerelease body synchronization has no current proposal.');
    }
    action = {
      boundaryOid: boundary.oid,
      changes,
      expectedStagedOid: staged.oid,
      kind: 'sync',
      mainOid,
      openPr: plan.openPr,
      proposalOid: staged.oid,
      reason: plan.reason,
      version: plan.version,
    };
  } else if (plan.kind === 'clear') {
    if (boundary === null) {
      throw new Error('Prerelease cleanup has no managed boundary.');
    }
    action = {
      boundaryOid: boundary.oid,
      changes,
      expectedStagedOid: staged?.oid ?? null,
      kind: 'clear',
      mainOid,
      openPr: plan.openPr,
      reason: plan.reason,
      version: nextPrereleaseVersion(lineVersion),
    };
  } else {
    action = {
      expectedStagedOid: staged?.oid ?? null,
      kind: plan.kind,
      mainOid,
      reason: plan.reason,
    };
  }

  if (bundle !== undefined) {
    await proposalWriteBundle(join(output, 'objects.bundle'), [bundle]);
  }
  await writeJson(join(output, 'transition.json'), {
    action,
    kind: 'prerelease-proposal',
    repository: PILOT_REPOSITORY,
    schema: 1,
  });
  console.log(`Prepared prerelease proposal action: ${action.kind}.`);
}

const ensureTrustedMain = (): void => {
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== 'refs/heads/main'
  ) {
    throw new Error(
      'Prerelease proposal application is restricted to trusted main.',
    );
  }
};

const assertOpenPulls = async (
  token: string,
  expected: number | undefined,
): Promise<void> => {
  const open = (await listPrereleasePulls(token)).filter(
    ({ state }) => state === 'open',
  );
  if (
    open.length !== (expected === undefined ? 0 : 1) ||
    (expected !== undefined && open[0]?.number !== expected)
  ) {
    throw new Error('The canonical Prerelease PR changed after preparation.');
  }
};

export async function applyPrereleaseProposal(
  options: ApplyPrereleaseProposalOptions,
): Promise<void> {
  await ensureRepository();
  ensureTrustedMain();
  const transition = transitionValue(
    await readJson(resolve(requireOption(options, 'transition'))),
  );
  const token = requireGithubToken(options);
  const action = transition.action;
  await getRepository(token);
  await proposalAssertExpectedRef(token, 'heads/main', action.mainOid);
  await proposalAssertExpectedRef(
    token,
    'heads/prerelease',
    action.expectedStagedOid,
  );

  if (action.kind === 'inactive' || action.kind === 'none') {
    console.log(`Skipped prerelease proposal application: ${action.reason}.`);
    return;
  }

  await assertOpenPulls(token, action.openPr);
  if (action.kind === 'clear') {
    if (action.expectedStagedOid !== null) {
      const repository = await getRepository(token);
      await updateRefs(token, repository.node_id, [
        createRefUpdate({
          afterOid: ZERO_OID,
          beforeOid: action.expectedStagedOid,
          force: true,
          name: 'refs/heads/prerelease',
        }),
      ]);
    }
    if (action.openPr !== undefined) {
      await closePullRequest(token, action.openPr);
    }
    console.log('Cleared the empty prerelease proposal.');
    return;
  }

  if (action.kind === 'sync') {
    await validateProposalCommit(action.proposalOid, {
      boundaryOid: action.boundaryOid,
      sourceOid: action.mainOid,
      version: action.version,
    });
    await updatePullRequestBody(
      token,
      action.openPr,
      actionBody(action, action.proposalOid),
    );
    console.log(`Synchronized Prerelease PR ${action.openPr}.`);
    return;
  }

  const bundle = options.bundle;
  if (bundle === undefined) {
    throw new Error('Prepared prerelease proposal requires its Git object bundle.');
  }
  await proposalImportBundle(resolve(bundle));
  assert.equal(await proposalImportedOid(action.bundleRef), action.proposalOid);
  await validateProposalCommit(action.proposalOid, {
    boundaryOid: action.boundaryOid,
    sourceOid: action.mainOid,
    version: action.version,
  });
  const uploadedProposalOid = await proposalUploadCommitObject(
    token,
    action.proposalOid,
  );
  await proposalAssertExpectedRef(token, 'heads/main', action.mainOid);
  await proposalAssertExpectedRef(
    token,
    'heads/prerelease',
    action.expectedStagedOid,
  );
  await assertOpenPulls(token, action.openPr);

  const repository = await getRepository(token);
  await updateRefs(token, repository.node_id, [
    createRefUpdate({
      afterOid: uploadedProposalOid,
      beforeOid: action.expectedStagedOid ?? ZERO_OID,
      force: action.expectedStagedOid !== null,
      name: 'refs/heads/prerelease',
    }),
  ]);
  const body = actionBody(action, uploadedProposalOid);
  if (action.kind === 'refresh') {
    if (action.openPr === undefined) {
      throw new Error('Prerelease refresh has no open pull request.');
    }
    await updatePullRequestBody(token, action.openPr, body);
  } else {
    await createDraftPrereleasePr(token, {
      body,
      version: action.version,
    });
  }
  console.log(`Applied prerelease proposal action: ${action.kind}.`);
}

export async function checkPrereleasePullRequest(
  pull: Pick<ValidatedPullRequest, 'base' | 'body' | 'head'>,
  currentMainOid: string,
): Promise<void> {
  await ensureRepository();
  oidValue(currentMainOid, 'Current main');
  if (
    pull.base.repo.full_name !== PILOT_REPOSITORY ||
    pull.head.repo.full_name !== PILOT_REPOSITORY ||
    pull.base.ref !== 'main' ||
    pull.head.ref !== 'prerelease'
  ) {
    throw new Error('This is not the canonical same-repository Prerelease PR.');
  }
  const sourceOid = oidValue(pull.base.sha, 'Prerelease PR source');
  const proposalOid = oidValue(pull.head.sha, 'Prerelease PR proposal');
  if (sourceOid !== currentMainOid) {
    throw new Error('Prerelease proposal is not based on exact current main.');
  }
  const proposal = parsePrereleaseProposalMessage(
    await proposalCommitMessageAt(proposalOid),
  );
  if (
    proposal.sourceOid !== sourceOid ||
    proposal.version !== nextPrereleaseVersion(
      await proposalRootVersionAt(sourceOid),
    )
  ) {
    throw new Error('Prerelease proposal does not advance exact current main.');
  }
  await validateProposalCommit(proposalOid, {
    boundaryOid: proposal.boundaryOid,
    sourceOid,
    version: proposal.version,
  });
  validatePrereleasePrBody(pull.body, {
    boundaryOid: proposal.boundaryOid,
    proposalOid,
    sourceOid,
    version: proposal.version,
  });
  console.log(
    `Prerelease proposal ${proposalOid} is current for ${sourceOid}.`,
  );
}
