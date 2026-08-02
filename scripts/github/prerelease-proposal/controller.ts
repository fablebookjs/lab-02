import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  extractPrereleasePrIdentity,
  validatePrereleasePrBody,
} from '../../shared/prerelease-proposal/body.ts';
import {
  nextPrereleaseVersion,
  parsePrereleaseProposalMessage,
  planPrereleaseProposal,
  prereleaseProposalCommitMessage,
} from '../../shared/prerelease-proposal/core.ts';
import type { PrereleaseProposalPlan } from '../../shared/prerelease-proposal/core.ts';
import {
  ZERO_OID,
} from '../../shared/release-proposal/core.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import { derivePrereleaseChanges } from '../../shared/release-communication/records.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { resolveHeadOid } from '../../shared/git/repository.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import { repositoryRoot } from '../../shared/workspace/packages.ts';
import { run } from '../../shared/process/run.ts';
import type { RunOptions } from '../../shared/process/run.ts';
import {
  PILOT_REPOSITORY,
  PRIMARY_BRANCH,
} from '../../shared/repository.ts';
import type { ValidatedPullRequest } from '../events.ts';
import { requireControllerGitHubToken } from '../controller-inputs.ts';
import {
  commitMessageAt,
  commitParents,
  rootVersionAt,
  validateVersionTree,
} from '../../shared/prepared-commit/inspection.ts';
import {
  assertExpectedRef,
  importBundle,
  materializeCommit,
  prepareOutput,
  uploadCommitObject,
  writeBundle,
} from '../prepared-commit/mechanics.ts';
import {
  findManagedPrereleaseBoundary,
  firstParentCommitFacts,
} from '../release-history/history.ts';
import {
  getRepository,
} from '../release-repository/repository.ts';
import {
  closePullRequest,
  createDraftPrereleasePr,
  listPrereleasePulls,
  updatePullRequestBody,
} from '../release-repository/pull-requests.ts';
import { createRefUpdate, updateRefs } from '../release-repository/refs.ts';
import {
  observeStagedPrereleaseProposal,
  parseStagedPrereleaseProposal,
} from '../staged-prerelease-proposal/observation.ts';
import { parsePrereleaseProposalTransition } from './transition-schema.ts';
import type {
  ProposalActionBase,
  ProposalTransitionAction,
} from './transition-schema.ts';
import { renderPrereleasePrBody } from './templates.ts';

const ARTIFACT_PREFIX = 'refs/release-pilot/artifact/';

const oidValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full commit OID.`);
  }
  return value;
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
    await resolveHeadOid(repositoryRoot),
    'Current repository commit',
  );

const prereleaseChanges = async (
  token: string,
  range: { boundaryOid: string; sourceOid: string },
): Promise<ReleaseChange[]> =>
  derivePrereleaseChanges({
    commits: await firstParentCommitFacts(repositoryRoot, token, {
      boundaryOid: range.boundaryOid,
      headOid: range.sourceOid,
      label: 'main prerelease',
    }),
  });

const validateProposalCommit = async (
  oid: string,
  expected: {
    boundaryOid: string;
    sourceOid: string;
    version: string;
  },
): Promise<void> => {
  assert.deepEqual(await commitParents(repositoryRoot, oid), [expected.sourceOid]);
  const proposal = parsePrereleaseProposalMessage(
    await commitMessageAt(repositoryRoot, oid),
  );
  assert.equal(proposal.boundaryOid, expected.boundaryOid);
  assert.equal(proposal.sourceOid, expected.sourceOid);
  assert.equal(proposal.version, expected.version);
  await validateVersionTree(repositoryRoot, oid, expected.version);
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

/**
 * Observes managed main, staged proposal, and canonical PR state, then emits one
 * deterministic maintenance action plus an inert object bundle when required.
 */
export async function preparePrereleaseProposal(
  options: { 'github-token': string; output: string },
): Promise<void> {
  await ensureRepository();
  const output = await prepareOutput(
    requireOption(options, 'output'),
  );
  const token = requireControllerGitHubToken(options);
  const mainOid = await currentOid();
  const lineVersion = await rootVersionAt(repositoryRoot, mainOid);
  const boundary = await findManagedPrereleaseBoundary(repositoryRoot, mainOid);
  if (boundary !== null && boundary.version !== lineVersion) {
    throw new Error(
      `main carries ${lineVersion}, but its latest managed prerelease snapshot carries ${boundary.version}.`,
    );
  }
  const observation = await observeStagedPrereleaseProposal(token);
  const staged = await parseStagedPrereleaseProposal(observation.stagedOid);
  const openPull = observation.openPull;
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
    const proposalOid = await materializeCommit({
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
    await writeBundle(join(output, 'objects.bundle'), [bundle]);
  }
  await writeJsonFile(join(output, 'transition.json'), {
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
    process.env['GITHUB_REF'] !== `refs/heads/${PRIMARY_BRANCH}`
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

/**
 * Rechecks every prepared ref and PR expectation before creating, refreshing,
 * synchronizing, or clearing the canonical prerelease proposal surface.
 */
export async function applyPrereleaseProposal(
  options: { bundle?: string; 'github-token': string; transition: string },
): Promise<void> {
  await ensureRepository();
  ensureTrustedMain();
  const transition = parsePrereleaseProposalTransition(
    await readJsonFile(resolve(requireOption(options, 'transition'))),
  );
  const token = requireControllerGitHubToken(options);
  const action = transition.action;
  await getRepository(token);
  await assertExpectedRef(token, `heads/${PRIMARY_BRANCH}`, action.mainOid);
  await assertExpectedRef(
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
  await importBundle(resolve(bundle), [
    { name: action.bundleRef, oid: action.proposalOid },
  ]);
  await validateProposalCommit(action.proposalOid, {
    boundaryOid: action.boundaryOid,
    sourceOid: action.mainOid,
    version: action.version,
  });
  const uploadedProposalOid = await uploadCommitObject(
    token,
    action.proposalOid,
  );
  await assertExpectedRef(token, `heads/${PRIMARY_BRANCH}`, action.mainOid);
  await assertExpectedRef(
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

/**
 * Required-check proof that the canonical Prerelease PR advances exact current
 * main with a correctly materialized and body-bound proposal.
 */
export async function checkPrereleasePullRequest(
  pull: Pick<ValidatedPullRequest, 'base' | 'body' | 'head'>,
  currentMainOid: string,
): Promise<void> {
  await ensureRepository();
  oidValue(currentMainOid, 'Current main');
  if (
    pull.base.repo.full_name !== PILOT_REPOSITORY ||
    pull.head.repo.full_name !== PILOT_REPOSITORY ||
    pull.base.ref !== PRIMARY_BRANCH ||
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
    await commitMessageAt(repositoryRoot, proposalOid),
  );
  if (
    proposal.sourceOid !== sourceOid ||
    proposal.version !== nextPrereleaseVersion(
      await rootVersionAt(repositoryRoot, sourceOid),
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
