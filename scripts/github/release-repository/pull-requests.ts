import { PRERELEASE_PR_TEMPLATE_MARKER } from '../../shared/prerelease-proposal/body.ts';
import { RELEASE_PR_TEMPLATE_MARKER } from '../../shared/release-proposal/body.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import { isRecord, stringValue } from '../../shared/validation.ts';
import { numberValue, objectValue } from './response-schema.ts';
import { githubGraphqlRequest, githubRequest } from './transport.ts';

/** Validated GitHub PR observation used by release-domain code. */
export type GitPullRequest = {
  base: { ref: string; repo: { full_name: string }; sha: string };
  body: string | null;
  head: { ref: string; repo: { full_name: string }; sha: string };
  labels: Array<{ name: string }>;
  merge_commit_sha: string | null;
  merged_at: string | null;
  number: number;
  state: string;
  title: string;
};

const repositoryValue = (
  value: unknown,
  label: string,
): { full_name: string } => {
  const repository = objectValue(value, label);
  return { full_name: stringValue(repository['full_name'], `${label}.full_name`) };
};

const branchValue = (
  value: unknown,
  label: string,
): { ref: string; repo: { full_name: string }; sha: string } => {
  const branch = objectValue(value, label);
  return {
    ref: stringValue(branch['ref'], `${label}.ref`),
    repo: repositoryValue(branch['repo'], `${label}.repo`),
    sha: stringValue(branch['sha'], `${label}.sha`),
  };
};

const labelsValue = (value: unknown): Array<{ name: string }> => {
  if (!Array.isArray(value)) {
    throw new Error('GitHub pull request labels must be an array.');
  }
  return value.map((entry, index) => {
    const label = objectValue(entry, `GitHub pull request label ${index}`);
    return {
      name: stringValue(label['name'], `GitHub pull request label ${index}.name`),
    };
  });
};

/** Narrows an untrusted REST pull-request response to the controller contract. */
export const validatedPullRequestResponse = (value: unknown): GitPullRequest => {
  const pull = objectValue(value, 'GitHub pull request');
  const body = pull['body'];
  const mergeCommitSha = pull['merge_commit_sha'] ?? null;
  const mergedAt = pull['merged_at'];
  if (body !== null && typeof body !== 'string') {
    throw new Error('GitHub pull request body must be text or null.');
  }
  if (mergeCommitSha !== null && typeof mergeCommitSha !== 'string') {
    throw new Error('GitHub pull request merge_commit_sha must be text or null.');
  }
  if (mergedAt !== null && typeof mergedAt !== 'string') {
    throw new Error('GitHub pull request merged_at must be text or null.');
  }
  return {
    base: branchValue(pull['base'], 'GitHub pull request base'),
    body,
    head: branchValue(pull['head'], 'GitHub pull request head'),
    labels: labelsValue(pull['labels']),
    merge_commit_sha: mergeCommitSha,
    merged_at: mergedAt,
    number: numberValue(pull['number'], 'GitHub pull request number'),
    state: stringValue(pull['state'], 'GitHub pull request state'),
    title: stringValue(pull['title'], 'GitHub pull request title'),
  };
};

export function isCanonicalReleasePull(pull: GitPullRequest): boolean {
  const line = pull.base.ref.replace(/^releases\//, '');
  return (
    line.length > 0 &&
    pull.base.ref === `releases/${line}` &&
    pull.head.ref === `staged/${line}` &&
    pull.base.repo.full_name === PILOT_REPOSITORY &&
    pull.head.repo.full_name === PILOT_REPOSITORY
  );
}

export function isCanonicalPrereleasePull(pull: GitPullRequest): boolean {
  return (
    pull.base.ref === PRIMARY_BRANCH &&
    pull.head.ref === 'prerelease' &&
    pull.base.repo.full_name === PILOT_REPOSITORY &&
    pull.head.repo.full_name === PILOT_REPOSITORY
  );
}

/**
 * Extracts GitHub's authoritative GraphQL merge-commit OID. Release authority
 * does not rely on the weaker REST merge_commit_sha field.
 */
export function extractPullRequestMergeCommitOid(result: unknown, number: number): string {
  const data = isRecord(result) ? result['data'] : undefined;
  const repository = isRecord(data) ? data['repository'] : undefined;
  const pullRequest = isRecord(repository) ? repository['pullRequest'] : undefined;
  const mergeCommit = isRecord(pullRequest) ? pullRequest['mergeCommit'] : undefined;
  const oid = isRecord(mergeCommit) ? mergeCommit['oid'] : undefined;
  if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`Pull request ${number} does not expose one merged commit OID.`);
  }
  return oid;
}

async function getPullRequestMergeCommitOid(
  token: string,
  number: number,
): Promise<string> {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('Pull request number must be one positive integer.');
  }
  const query = `query PullRequestMergeCommit($number: Int!) {
    repository(owner: "fablebookjs", name: "lab-02") {
      pullRequest(number: $number) { mergeCommit { oid } }
    }
  }`;
  const result = await githubGraphqlRequest(query, { number }, token);
  const errors = isRecord(result) ? result['errors'] : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub could not resolve the merged PR commit: ${JSON.stringify(errors)}`);
  }
  return extractPullRequestMergeCommitOid(result, number);
}

async function withPullRequestMergeCommit(
  token: string,
  pull: GitPullRequest,
): Promise<GitPullRequest> {
  if (pull.merged_at === null) return pull;
  if (!Number.isSafeInteger(pull.number) || pull.number <= 0) {
    throw new Error('Merged pull request response has no positive number.');
  }
  return {
    ...pull,
    merge_commit_sha: await getPullRequestMergeCommitOid(token, pull.number),
  };
}

/** Lists and validates all PR pages for the supplied GitHub filters. */
export async function listPullRequests(
  token: string,
  {
    base,
    head,
    state = 'all',
  }: {
    base?: string;
    head?: string;
    state?: string;
  },
): Promise<GitPullRequest[]> {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      ...(base === undefined ? {} : { base }),
      direction: 'desc',
      ...(head === undefined ? {} : { head }),
      page: String(page),
      per_page: '100',
      sort: 'updated',
      state,
    });
    const batch = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls?${query}`, { token });
    if (!Array.isArray(batch)) throw new Error('GitHub pull request list must be an array.');
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) return pulls;
  }
}

export async function listReleasePulls(
  token: string,
  line: string,
): Promise<GitPullRequest[]> {
  return (await listPullRequests(token, {
    base: `releases/${line}`,
    head: `fablebookjs:staged/${line}`,
  })).filter(
    (pull) =>
      pull.base.ref === `releases/${line}` &&
      pull.head.ref === `staged/${line}` &&
      pull.head.repo.full_name === PILOT_REPOSITORY,
  );
}

export async function listPrereleasePulls(token: string): Promise<GitPullRequest[]> {
  return (await listPullRequests(token, {
    base: PRIMARY_BRANCH,
    head: 'fablebookjs:prerelease',
  })).filter(isCanonicalPrereleasePull);
}

/**
 * Reads one PR and replaces merged REST commit metadata with the authoritative
 * GraphQL merge-commit OID.
 */
export async function getPullRequest(
  token: string,
  number: number,
): Promise<GitPullRequest> {
  const pull = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, { token });
  return withPullRequestMergeCommit(token, validatedPullRequestResponse(pull));
}

/**
 * Adds any missing required labels to one PR without disturbing labels applied
 * by maintainers. The returned observation is verified against GitHub's reply.
 */
export async function ensurePullRequestLabels(
  token: string,
  pull: GitPullRequest,
  requiredLabels: readonly string[],
): Promise<GitPullRequest> {
  const required = [
    ...new Set(
      requiredLabels.map((label, index) =>
        stringValue(label, `Required pull request label ${index}`),
      ),
    ),
  ];
  const observed = new Set(pull.labels.map(({ name }) => name));
  const missing = required.filter((label) => !observed.has(label));
  if (missing.length === 0) {
    return pull;
  }

  const labels = labelsValue(
    await githubRequest(
      `/repos/${PILOT_REPOSITORY}/issues/${pull.number}/labels`,
      {
        body: { labels: missing },
        method: 'POST',
        token,
      },
    ),
  );
  const reconciled = new Set(labels.map(({ name }) => name));
  const absent = required.filter((label) => !reconciled.has(label));
  if (absent.length > 0) {
    throw new Error(
      `GitHub did not apply required pull request label(s): ${absent.join(', ')}.`,
    );
  }
  return { ...pull, labels };
}

/**
 * Lists PRs associated with a commit and resolves authoritative merge OIDs for
 * every merged result before release-history classification.
 */
export async function listAssociatedPullRequests(
  token: string,
  oid: string,
): Promise<GitPullRequest[]> {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/commits/${oid}/pulls?${query}`,
      { token },
    );
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub associated pull requests for ${oid} must be an array.`);
    }
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) {
      return Promise.all(pulls.map((pull) => withPullRequestMergeCommit(token, pull)));
    }
  }
}

async function createDraftPullRequest(
  token: string,
  {
    base,
    body,
    head,
    title,
  }: {
    base: string;
    body: string;
    head: string;
    title: string;
  },
): Promise<GitPullRequest> {
  return validatedPullRequestResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls`, {
      body: {
        base,
        body,
        draft: true,
        head,
        maintainer_can_modify: false,
        title,
      },
      method: 'POST',
      token,
    }),
  );
}

export async function createDraftReleasePr(
  token: string,
  action: { body: unknown; line: string; version: string },
): Promise<GitPullRequest> {
  const body = String(action.body ?? '');
  if (!body.includes(RELEASE_PR_TEMPLATE_MARKER)) {
    throw new Error('Release PR creation requires one rendered canonical body.');
  }
  return createDraftPullRequest(token, {
    base: `releases/${action.line}`,
    body,
    head: `staged/${action.line}`,
    title: `Release ${action.version}`,
  });
}

export async function createDraftPrereleasePr(
  token: string,
  { body, version }: { body: string; version: string },
): Promise<GitPullRequest> {
  if (!body.includes(PRERELEASE_PR_TEMPLATE_MARKER)) {
    throw new Error('Prerelease PR creation requires one rendered canonical body.');
  }
  return createDraftPullRequest(token, {
    base: PRIMARY_BRANCH,
    body,
    head: 'prerelease',
    title: `Prerelease ${version}`,
  });
}

export async function createDraftPatchbackPr(
  token: string,
  {
    body,
    branch,
    title,
  }: {
    body: string;
    branch: string;
    title: string;
  },
): Promise<GitPullRequest> {
  return createDraftPullRequest(token, {
    base: PRIMARY_BRANCH,
    body,
    head: branch,
    title,
  });
}

export async function closePullRequest(
  token: string,
  number: number,
): Promise<GitPullRequest> {
  return validatedPullRequestResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, {
      body: { state: 'closed' },
      method: 'PATCH',
      token,
    }),
  );
}

export async function updatePullRequestBody(
  token: string,
  number: number,
  body: string,
): Promise<GitPullRequest> {
  return validatedPullRequestResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, {
      body: { body },
      method: 'PATCH',
      token,
    }),
  );
}

/**
 * Creates or updates the sole issue comment carrying a marker. Duplicate marked
 * comments are contradictory state and fail instead of being silently merged.
 */
export async function reconcileUniqueMarkedIssueComment(
  token: string,
  issue: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments: Array<{ body: string | null; id: number }> = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/issues/${issue}/comments?${query}`,
      { token },
    );
    if (!Array.isArray(batch)) throw new Error('GitHub issue comments must be an array.');
    comments.push(
      ...batch.map((comment) => {
        const value = objectValue(comment, 'GitHub issue comment');
        const commentBody = value['body'];
        if (commentBody !== null && typeof commentBody !== 'string') {
          throw new Error('GitHub issue comment body must be text or null.');
        }
        return {
          body: commentBody,
          id: numberValue(value['id'], 'GitHub issue comment ID'),
        };
      }),
    );
    if (batch.length < 100) break;
  }
  const matches = comments.filter((comment) => comment.body?.includes(marker));
  if (matches.length > 1) {
    throw new Error(`Issue #${issue} has duplicate comments containing ${marker}.`);
  }
  const existing = matches[0];
  if (existing === undefined) {
    await githubRequest(`/repos/${PILOT_REPOSITORY}/issues/${issue}/comments`, {
      body: { body },
      method: 'POST',
      token,
    });
  } else if (existing.body !== body) {
    await githubRequest(`/repos/${PILOT_REPOSITORY}/issues/comments/${existing.id}`, {
      body: { body },
      method: 'PATCH',
      token,
    });
  }
}

/** Assigns a PR and verifies GitHub returned the requested assignee. */
export async function assignPullRequest(
  token: string,
  pullRequest: number,
  assignee: string,
): Promise<void> {
  const issue = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/issues/${pullRequest}/assignees`,
    {
      body: { assignees: [assignee] },
      method: 'POST',
      token,
    },
  );
  const assignees = isRecord(issue) ? issue['assignees'] : undefined;
  if (
    !Array.isArray(assignees) ||
    !assignees.some(
      (candidate) => isRecord(candidate) && candidate['login'] === assignee,
    )
  ) {
    throw new Error(`GitHub did not assign ${assignee}.`);
  }
}
