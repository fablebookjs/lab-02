const apiUrl = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
const graphqlUrl = process.env['GITHUB_GRAPHQL_URL'] ?? 'https://api.github.com/graphql';

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

async function request(
  url: string,
  {
    body,
    method = 'GET',
    token,
  }: {
    body?: unknown;
    method?: string;
    token: string;
  },
): Promise<Response> {
  if (!token) {
    throw new Error('GitHub API token is required.');
  }
  return fetch(url, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: headers(token),
    method,
  });
}

export async function githubRequest(
  path: string,
  {
    body,
    method = 'GET',
    token,
  }: {
    body?: unknown;
    method?: string;
    token?: string;
  } = {},
): Promise<unknown> {
  if (!token) {
    throw new Error('GitHub API token is required.');
  }
  const response = await request(`${apiUrl}${path}`, { body, method, token });
  if (!response.ok) {
    throw await responseError(response);
  }
  if (response.status === 204) {
    return null;
  }
  const value: unknown = await response.json();
  return value;
}

export async function githubRequestOrNull(
  path: string,
  token: string,
): Promise<unknown | null> {
  const response = await request(`${apiUrl}${path}`, { token });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await responseError(response);
  }
  const value: unknown = await response.json();
  return value;
}

export async function githubGraphqlRequest(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const response = await request(graphqlUrl, {
    body: { query, variables },
    method: 'POST',
    token,
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  const value: unknown = await response.json();
  return value;
}
