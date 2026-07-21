import { randomUUID } from 'node:crypto';

import { ZERO_OID } from './release-proposal-core.mjs';

export const PILOT_REPOSITORY = 'fablebookjs/lab-02';

const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql';

const headers = (token) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2026-03-10',
});

const responseError = async (response) => {
  const detail = await response.text();
  return new Error(`GitHub API ${response.status} ${response.url}: ${detail}`);
};

export async function githubRequest(path, { body, method = 'GET', token } = {}) {
  if (!token) {
    throw new Error('GitHub API token is required.');
  }
  const response = await fetch(`${apiUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: headers(token),
    method,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

export async function getRepository(token) {
  const repository = await githubRequest(`/repos/${PILOT_REPOSITORY}`, { token });
  if (repository.full_name !== PILOT_REPOSITORY || repository.default_branch !== 'main') {
    throw new Error('The controller is not operating on the allowlisted pilot repository.');
  }
  return repository;
}

export async function getRef(token, ref) {
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
  const value = await response.json();
  return { oid: value.object.sha, type: value.object.type };
}

export async function listMatchingRefs(token, prefix) {
  const refs = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/git/matching-refs/${prefix}?${query}`,
      { token }
    );
    refs.push(...batch);
    if (batch.length < 100) {
      return refs;
    }
  }
}

export async function resolveRefObject(token, object) {
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
  return resolveRefObject(token, tag.object);
}

export async function listReleasePulls(token, line) {
  const pulls = [];
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
    pulls.push(...batch);
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

export async function getPullRequest(token, number) {
  const pull = await githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, { token });
  return withPullRequestMergeCommit(token, pull);
}

export function extractPullRequestMergeCommitOid(result, number) {
  const oid = result?.data?.repository?.pullRequest?.mergeCommit?.oid;
  if (!/^[0-9a-f]{40}$/.test(oid ?? '')) {
    throw new Error(`Pull request ${number} does not expose one merged commit OID.`);
  }
  return oid;
}

export async function getPullRequestMergeCommitOid(token, number) {
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
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub could not resolve the merged PR commit: ${JSON.stringify(result.errors)}`);
  }
  return extractPullRequestMergeCommitOid(result, number);
}

export async function withPullRequestMergeCommit(token, pull) {
  if (pull?.merged_at === null) {
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

export async function getGitCommit(token, oid) {
  return githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits/${oid}`, { token });
}

export async function getReleaseByTag(token, tag) {
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
  return response.json();
}

export async function updateRefs(token, repositoryId, refUpdates) {
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
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub updateRefs rejected the transition: ${JSON.stringify(result.errors)}`);
  }
  return result.data.updateRefs;
}

export async function createDraftReleasePr(token, action) {
  const superseded =
    action.supersededPr === undefined
      ? ''
      : `\n\nThis clean proposal supersedes #${action.supersededPr}.`;
  return githubRequest(`/repos/${PILOT_REPOSITORY}/pulls`, {
    body: {
      base: `releases/${action.line}`,
      body: [
        `Release proposal for **${action.version}**.`,
        '',
        `Source: \`${action.releaseOid}\``,
        '',
        'Merging this PR authorizes publication of its exact merge commit.',
      ].join('\n') + superseded,
      draft: true,
      head: `staged/${action.line}`,
      maintainer_can_modify: false,
      title: `Release ${action.version}`,
    },
    method: 'POST',
    token,
  });
}

export async function closePullRequest(token, number) {
  return githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, {
    body: { state: 'closed' },
    method: 'PATCH',
    token,
  });
}

export async function updatePullRequestBody(token, number, body) {
  return githubRequest(`/repos/${PILOT_REPOSITORY}/pulls/${number}`, {
    body: { body },
    method: 'PATCH',
    token,
  });
}

export function createRefUpdate({ afterOid, beforeOid, force = false, name }) {
  if (
    name !== 'refs/heads/main' &&
    !/^refs\/heads\/(?:releases|staged)\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(name)
  ) {
    throw new Error(`Ref is outside the release controller allowlist: ${name}`);
  }
  return { afterOid, beforeOid: beforeOid ?? ZERO_OID, force, name };
}
