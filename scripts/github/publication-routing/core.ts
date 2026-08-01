import { PRIMARY_BRANCH } from '../../shared/repository.ts';

export type PublicationAuthorityKind =
  | 'ordinary-prerelease-pr'
  | 'phase-entry'
  | 'release-cut-bootstrap'
  | 'stable-pr';

export type PublicationRouteInput = Readonly<{
  branch: string | null;
  conclusion: string;
  event: string;
  path: string;
  runId: number;
}>;

export type PublicationRouteDecision =
  | Readonly<{
      authorityKind: PublicationAuthorityKind;
      kind: 'publish';
      upstreamRunId: number;
    }>
  | Readonly<{
      kind: 'skip';
      reason: string;
    }>;

export type PublicationResolution =
  | { publish: false }
  | {
      publish: true;
      snapshot: string;
      version: string;
    };

const PUBLICATION_SOURCES: readonly Readonly<{
  authorityKind: PublicationAuthorityKind;
  branch?: typeof PRIMARY_BRANCH;
  event: 'pull_request_target' | 'workflow_dispatch';
  path: string;
}>[] = [
  {
    authorityKind: 'stable-pr',
    event: 'pull_request_target',
    path: '.github/workflows/release-proposal-signal.yml',
  },
  {
    authorityKind: 'ordinary-prerelease-pr',
    event: 'pull_request_target',
    path: '.github/workflows/prerelease-proposal-signal.yml',
  },
  {
    authorityKind: 'phase-entry',
    branch: PRIMARY_BRANCH,
    event: 'workflow_dispatch',
    path: '.github/workflows/enter-prerelease-phase.yml',
  },
  {
    authorityKind: 'release-cut-bootstrap',
    branch: PRIMARY_BRANCH,
    event: 'workflow_dispatch',
    path: '.github/workflows/cut-release-line.yml',
  },
];

export function classifyPublicationRoute(
  input: PublicationRouteInput,
): PublicationRouteDecision {
  if (input.conclusion !== 'success') {
    return {
      kind: 'skip',
      reason: `Upstream run ${input.runId} concluded ${input.conclusion}.`,
    };
  }

  const pathSources = PUBLICATION_SOURCES.filter(
    ({ path }) => path === input.path,
  );
  if (pathSources.length === 0) {
    return {
      kind: 'skip',
      reason: `${input.path} is not a publication authority source.`,
    };
  }

  const source = pathSources.find(({ event }) => event === input.event);
  if (source === undefined) {
    return {
      kind: 'skip',
      reason:
        input.path === '.github/workflows/release-proposal-signal.yml'
          ? 'Release proposal maintenance without a merged Release PR does not authorize publication.'
          : `${input.path} event ${input.event} does not authorize publication.`,
    };
  }

  if (source.branch !== undefined && input.branch !== source.branch) {
    return {
      kind: 'skip',
      reason: `${source.authorityKind} must originate from main, not ${input.branch ?? 'a run without a branch'}.`,
    };
  }

  return {
    authorityKind: source.authorityKind,
    kind: 'publish',
    upstreamRunId: input.runId,
  };
}

export const isPrereleaseAuthorityKind = (
  value: unknown,
): value is Exclude<PublicationAuthorityKind, 'stable-pr'> =>
  value === 'ordinary-prerelease-pr' ||
  value === 'phase-entry' ||
  value === 'release-cut-bootstrap';
