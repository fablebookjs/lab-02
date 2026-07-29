import { randomUUID } from 'node:crypto';

import { ZERO_OID } from '../../shared/release-proposal/core.ts';
import { RELEASE_PR_TEMPLATE_MARKER } from '../../shared/release-proposal/body.ts';

export const PILOT_REPOSITORY = 'fablebookjs/lab-02';

const apiUrl = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
const graphqlUrl = process.env['GITHUB_GRAPHQL_URL'] ?? 'https://api.github.com/graphql';

export type GitObject = {
  sha: string;
  type: string;
};

export type GitReference = {
  object: GitObject;
  ref: string;
};

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

export type GitCommit = {
  author: { date: string; email: string; name: string };
  committer: { date: string; email: string; name: string };
  message: string;
  parents: Array<{ sha: string }>;
  sha: string;
  tree: { sha: string };
};

export type GitHubRelease = {
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
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

const headers = (token: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2026-03-10',
});

const responseError = async (response: Response): Promise<Error> => {
  const detail = await response.text();
  return new Error(`GitHub API ${response.status} ${response.url}: ${detail}`);
};

type GitHubRequestOptions = {
  body?: unknown;
  method?: string;
  token?: string;
};

export async function githubRequest(
  path: string,
  { body, method = 'GET', token }: GitHubRequestOptions = {},
): Promise<unknown> {
  if (!token) {
    throw new Error('GitHub API token is required.');
  }
  const response = await fetch(`${apiUrl}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: headers(token),
    method,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  if (response.status === 204) {
    return null;
  }
  const value: unknown = await response.json();
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
};

const booleanValue = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
};

const numberValue = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
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

const identityValue = (
  value: unknown,
  label: string,
): { date: string; email: string; name: string } => {
  const identity = objectValue(value, label);
  return {
    date: stringValue(identity['date'], `${label}.date`),
    email: stringValue(identity['email'], `${label}.email`),
    name: stringValue(identity['name'], `${label}.name`),
  };
};

export const validatedGitCommitResponse = (value: unknown): GitCommit => {
  const commit = objectValue(value, 'GitHub commit');
  const parents = commit['parents'];
  if (!Array.isArray(parents)) throw new Error('GitHub commit parents must be an array.');
  return {
    author: identityValue(commit['author'], 'GitHub commit author'),
    committer: identityValue(commit['committer'], 'GitHub commit committer'),
    message: stringValue(commit['message'], 'GitHub commit message'),
    parents: parents.map((parent) => ({
      sha: stringValue(objectValue(parent, 'GitHub commit parent')['sha'], 'GitHub parent SHA'),
    })),
    sha: stringValue(commit['sha'], 'GitHub commit SHA'),
    tree: {
      sha: stringValue(
        objectValue(commit['tree'], 'GitHub commit tree')['sha'],
        'GitHub commit tree SHA',
      ),
    },
  };
};

export const validatedReleaseResponse = (value: unknown): GitHubRelease => {
  const release = objectValue(value, 'GitHub Release');
  const body = release['body'];
  if (body !== null && typeof body !== 'string') {
    throw new Error('GitHub Release body must be text or null.');
  }
  return {
    body,
    draft: booleanValue(release['draft'], 'GitHub Release draft'),
    prerelease: booleanValue(release['prerelease'], 'GitHub Release prerelease'),
    tag_name: stringValue(release['tag_name'], 'GitHub Release tag_name'),
  };
};

export async function getRepository(token: string): Promise<{
  default_branch: string;
  full_name: string;
  node_id: string;
}> {
  const repository = await githubRequest(`/repos/${PILOT_REPOSITORY}`, { token });
  const value = objectValue(repository, 'GitHub repository');
  if (value['full_name'] !== PILOT_REPOSITORY || value['default_branch'] !== 'main') {
    throw new Error('The controller is not operating on the allowlisted pilot repository.');
  }
  return {
    default_branch: 'main',
    full_name: PILOT_REPOSITORY,
    node_id: stringValue(value['node_id'], 'GitHub repository node_id'),
  };
}

export async function getRef(
  token: string,
  ref: string,
): Promise<{ oid: string; type: string } | null> {
  const response = await fetch(
    `${apiUrl}/repos/${PILOT_REPOSITORY}/git/ref/${encodeURIComponent(ref)}`,
    { headers: headers(token) }
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await responseError(response);
  }
  const value: unknown = await response.json();
  const object = objectValue(objectValue(value, 'Git ref')['object'], 'Git ref object');
  return {
    oid: stringValue(object['sha'], 'Git ref object SHA'),
    type: stringValue(object['type'], 'Git ref object type'),
  };
}

export async function listMatchingRefs(
  token: string,
  prefix: string,
): Promise<GitReference[]> {
  const refs: GitReference[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/git/matching-refs/${prefix}?${query}`,
      { token }
    );
    if (!Array.isArray(batch)) throw new Error('GitHub matching refs must be an array.');
    refs.push(
      ...batch.map((candidate) => {
        const ref = objectValue(candidate, 'GitHub matching ref');
        const object = objectValue(ref['object'], 'GitHub matching ref object');
        return {
          object: {
            sha: stringValue(object['sha'], 'GitHub matching ref SHA'),
            type: stringValue(object['type'], 'GitHub matching ref type'),
          },
          ref: stringValue(ref['ref'], 'GitHub matching ref name'),
        };
      }),
    );
    if (batch.length < 100) {
      return refs;
    }
  }
}

export async function resolveRefObject(token: string, object: GitObject): Promise<string> {
  if (object.type === 'commit') {
    return object.sha;
  }
  if (object.type !== 'tag') {
    throw new Error(`Unsupported Git ref object type: ${object.type}`);
  }
  const tag = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/git/tags/${object.sha}`,
    { token }
  );
  const tagObject = objectValue(objectValue(tag, 'Git tag')['object'], 'Git tag object');
  return resolveRefObject(token, {
    sha: stringValue(tagObject['sha'], 'Git tag object SHA'),
    type: stringValue(tagObject['type'], 'Git tag object type'),
  });
}

export async function listReleasePulls(
  token: string,
  line: string,
): Promise<GitPullRequest[]> {
  const pulls: GitPullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      base: `releases/${line}`,
      direction: 'desc',
      head: `fablebookjs:staged/${line}`,
      page: String(page),
      per_page: '100',
      sort: 'updated',
      state: 'all',
    });
    const batch = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls?${query}`, { token });
    if (!Array.isArray(batch)) throw new Error('GitHub pull request list must be an array.');
    pulls.push(...batch.map(validatedPullRequestResponse));
    if (batch.length < 100) {
      break;
    }
  }
  return pulls.filter(
    (pull) =>
      pull.base.ref === `releases/${line}` &&
      pull.head.ref === `staged/${line}` &&
      pull.head.repo?.full_name === PILOT_REPOSITORY
  );
}

export async function getPullRequest(token: string, number: number): Promise<GitPullRequest> {
  const pull = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, { token });
  return withPullRequestMergeCommit(token, validatedPullRequestResponse(pull));
}

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

export async function getPullRequestMergeCommitOid(
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
  const response = await fetch(graphqlUrl, {
    body: JSON.stringify({ query, variables: { number } }),
    headers: headers(token),
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  const result: unknown = await response.json();
  const errors = isRecord(result) ? result['errors'] : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub could not resolve the merged PR commit: ${JSON.stringify(errors)}`);
  }
  return extractPullRequestMergeCommitOid(result, number);
}

export async function withPullRequestMergeCommit(
  token: string,
  pull: GitPullRequest,
): Promise<GitPullRequest> {
  if (pull.merged_at === null) {
    return pull;
  }
  if (!Number.isSafeInteger(pull?.number) || pull.number <= 0) {
    throw new Error('Merged pull request response has no positive number.');
  }
  return {
    ...pull,
    merge_commit_sha: await getPullRequestMergeCommitOid(token, pull.number),
  };
}

export async function getGitCommit(token: string, oid: string): Promise<GitCommit> {
  return validatedGitCommitResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits/${oid}`, { token }),
  );
}

export async function getReleaseByTag(
  token: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const response = await fetch(
    `${apiUrl}/repos/${PILOT_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: headers(token) }
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await responseError(response);
  }
  const value: unknown = await response.json();
  return validatedReleaseResponse(value);
}

export async function updateRefs(
  token: string,
  repositoryId: string,
  refUpdates: ReturnType<typeof createRefUpdate>[],
): Promise<Record<string, unknown>> {
  const query = `mutation UpdateRefs($input: UpdateRefsInput!) {
    updateRefs(input: $input) { clientMutationId }
  }`;
  const response = await fetch(graphqlUrl, {
    body: JSON.stringify({
      query,
      variables: {
        input: {
          clientMutationId: `fablebook-release-${randomUUID()}`,
          refUpdates,
          repositoryId,
        },
      },
    }),
    headers: headers(token),
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  const result: unknown = await response.json();
  const errors = isRecord(result) ? result['errors'] : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub updateRefs rejected the transition: ${JSON.stringify(errors)}`);
  }
  const data = objectValue(objectValue(result, 'GitHub updateRefs result')['data'], 'GitHub updateRefs data');
  return objectValue(data['updateRefs'], 'GitHub updateRefs payload');
}

export async function createDraftReleasePr(
  token: string,
  action: { body: unknown; line: string; version: string },
): Promise<GitPullRequest> {
  if (!String(action.body ?? '').includes(RELEASE_PR_TEMPLATE_MARKER)) {
    throw new Error('Release PR creation requires one rendered canonical body.');
  }
  return validatedPullRequestResponse(await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls`, {
    body: {
      base: `releases/${action.line}`,
      body: action.body,
      draft: true,
      head: `staged/${action.line}`,
      maintainer_can_modify: false,
      title: `Release ${action.version}`,
    },
    method: 'POST',
    token,
  }));
}

export async function closePullRequest(token: string, number: number): Promise<GitPullRequest> {
  return validatedPullRequestResponse(await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, {
    body: { state: 'closed' },
    method: 'PATCH',
    token,
  }));
}

export async function updatePullRequestBody(
  token: string,
  number: number,
  body: string,
): Promise<GitPullRequest> {
  return validatedPullRequestResponse(await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, {
    body: { body },
    method: 'PATCH',
    token,
  }));
}

export function createRefUpdate({
  afterOid,
  beforeOid,
  force = false,
  name,
}: {
  afterOid: string;
  beforeOid?: string;
  force?: boolean;
  name: string;
}) {
  if (
    name !== 'refs/heads/main' &&
    !/^refs\/heads\/(?:releases|staged)\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(name)
  ) {
    throw new Error(`Ref is outside the release controller allowlist: ${name}`);
  }
  return { afterOid, beforeOid: beforeOid ?? ZERO_OID, force, name };
}
