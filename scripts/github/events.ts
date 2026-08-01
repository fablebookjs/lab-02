import type { components } from '@octokit/openapi-webhooks-types';

type AuthoritativePullRequest = components['schemas']['pull-request-webhook'];
type AuthoritativeWorkflowRun =
  components['schemas']['webhook-workflow-run-completed']['workflow_run'];

export type ValidatedPullRequest = {
  base: {
    ref: AuthoritativePullRequest['base']['ref'];
    repo: {
      full_name: string;
    };
    sha: AuthoritativePullRequest['base']['sha'];
  };
  body: AuthoritativePullRequest['body'];
  head: {
    ref: AuthoritativePullRequest['head']['ref'];
    repo: {
      full_name: string;
    };
    sha: AuthoritativePullRequest['head']['sha'];
  };
  number: AuthoritativePullRequest['number'];
};

export type ValidatedPullRequestDescription = {
  base: {
    ref: AuthoritativePullRequest['base']['ref'];
  };
  body: AuthoritativePullRequest['body'];
  head: {
    ref: AuthoritativePullRequest['head']['ref'];
    repo: {
      full_name: string;
    };
  };
};

export type ValidatedWorkflowRunCompletion = {
  branch: AuthoritativeWorkflowRun['head_branch'];
  conclusion: NonNullable<AuthoritativeWorkflowRun['conclusion']>;
  event: AuthoritativeWorkflowRun['event'];
  path: AuthoritativeWorkflowRun['path'];
  runId: AuthoritativeWorkflowRun['id'];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Pull request ${label} is missing.`);
  }
  return value;
};

const requiredWorkflowString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Completed workflow run ${label} is missing.`);
  }
  return value;
};

const workflowBranch = (
  value: unknown,
): AuthoritativeWorkflowRun['head_branch'] => {
  if (value === null) return null;
  return requiredWorkflowString(value, 'branch');
};

const workflowConclusion = (
  value: unknown,
): NonNullable<AuthoritativeWorkflowRun['conclusion']> => {
  switch (value) {
    case 'action_required':
    case 'cancelled':
    case 'failure':
    case 'neutral':
    case 'skipped':
    case 'stale':
    case 'startup_failure':
    case 'success':
    case 'timed_out':
      return value;
    default:
      throw new Error('Completed workflow run conclusion is missing or unknown.');
  }
};

const pullRequestPayload = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload) || !isRecord(payload['pull_request'])) {
    throw new Error('Pull request event data is missing.');
  }
  return payload['pull_request'];
};

const bodyValue = (pull: Record<string, unknown>): string | null => {
  const body = pull['body'];
  if (body !== null && typeof body !== 'string') {
    throw new Error('Pull request body must be text or null.');
  }
  return body;
};

/** Narrows only the pull-request fields needed by the description readiness check. */
export function validatedPullRequestDescription(
  payload: unknown,
): ValidatedPullRequestDescription {
  const pull = pullRequestPayload(payload);
  const base = pull['base'];
  const head = pull['head'];
  if (!isRecord(base) || !isRecord(head) || !isRecord(head['repo'])) {
    throw new Error('Pull request branch data is missing.');
  }
  return {
    base: { ref: requiredString(base['ref'], 'base ref') },
    body: bodyValue(pull),
    head: {
      ref: requiredString(head['ref'], 'head ref'),
      repo: {
        full_name: requiredString(head['repo']['full_name'], 'head repository'),
      },
    },
  };
}

/** Extracts a positive PR number from an untrusted pull-request webhook payload. */
export function validatedPullRequestNumber(payload: unknown): number {
  const number = pullRequestPayload(payload)['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error('Pull request number must be a positive integer.');
  }
  return number;
}

/** Narrows the canonical branch, repository, body, and SHA evidence from a PR event. */
export function validatedPullRequest(payload: unknown): ValidatedPullRequest {
  const pull = pullRequestPayload(payload);
  const base = pull['base'];
  const head = pull['head'];
  if (!isRecord(base) || !isRecord(base['repo']) || !isRecord(head) || !isRecord(head['repo'])) {
    throw new Error('Pull request branch data is missing.');
  }
  const number = pull['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error('Pull request number must be a positive integer.');
  }
  return {
    base: {
      ref: requiredString(base['ref'], 'base ref'),
      repo: {
        full_name: requiredString(base['repo']['full_name'], 'base repository'),
      },
      sha: requiredString(base['sha'], 'base SHA'),
    },
    body: bodyValue(pull),
    head: {
      ref: requiredString(head['ref'], 'head ref'),
      repo: {
        full_name: requiredString(head['repo']['full_name'], 'head repository'),
      },
      sha: requiredString(head['sha'], 'head SHA'),
    },
    number,
  };
}

/**
 * Accepts only a completed workflow_run event and projects the finite facts used
 * by publication routing. Unknown conclusion values fail before classification.
 */
export function validatedWorkflowRunCompletion(
  eventName: string,
  payload: unknown,
): ValidatedWorkflowRunCompletion {
  if (
    eventName !== 'workflow_run' ||
    !isRecord(payload) ||
    payload['action'] !== 'completed' ||
    !isRecord(payload['workflow_run'])
  ) {
    throw new Error('Completed workflow_run event data is missing.');
  }
  const workflowRun = payload['workflow_run'];
  const runId = workflowRun['id'];
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('Completed workflow run ID must be a positive integer.');
  }
  return {
    branch: workflowBranch(workflowRun['head_branch']),
    conclusion: workflowConclusion(workflowRun['conclusion']),
    event: requiredWorkflowString(workflowRun['event'], 'event'),
    path: requiredWorkflowString(workflowRun['path'], 'path'),
    runId,
  };
}
