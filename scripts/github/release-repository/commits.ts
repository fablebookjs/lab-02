import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { isRecord, stringValue } from '../../shared/validation.ts';
import { objectValue } from './response-schema.ts';
import { githubRequest } from './transport.ts';

/** Narrow commit shape shared by release controllers after response validation. */
export type ValidatedGitCommit = {
  author: { date: string; email: string; name: string };
  committer: { date: string; email: string; name: string };
  message: string;
  parents: Array<{ sha: string }>;
  sha: string;
  tree: { sha: string };
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

/** Narrows an untrusted GitHub Git-commit response to the fields controllers use. */
const validatedGitCommitResponse = (value: unknown): ValidatedGitCommit => {
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

export async function getGitCommit(
  token: string,
  oid: string,
): Promise<ValidatedGitCommit> {
  return validatedGitCommitResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits/${oid}`, { token }),
  );
}

export async function createGitTree(
  token: string,
  {
    baseTreeOid,
    entries,
  }: {
    baseTreeOid: string;
    entries: readonly Readonly<{
      content: string;
      mode: string;
      path: string;
      type: string;
    }>[];
  },
): Promise<string> {
  const response = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/trees`, {
    body: { base_tree: baseTreeOid, tree: entries },
    method: 'POST',
    token,
  });
  return stringValue(objectValue(response, 'GitHub created-tree response')['sha'], 'GitHub created tree SHA');
}

export async function createGitCommit(
  token: string,
  {
    author,
    committer,
    message,
    parents,
    treeOid,
  }: {
    author?: { date: string; email: string; name: string };
    committer?: { date: string; email: string; name: string };
    message: string;
    parents: readonly string[];
    treeOid: string;
  },
): Promise<ValidatedGitCommit> {
  return validatedGitCommitResponse(
    await githubRequest(`/repos/${PILOT_REPOSITORY}/git/commits`, {
      body: {
        ...(author === undefined ? {} : { author }),
        ...(committer === undefined ? {} : { committer }),
        message,
        parents,
        tree: treeOid,
      },
      method: 'POST',
      token,
    }),
  );
}

/**
 * Returns the complete recursive Git tree. Truncated responses are rejected
 * because coordination verification depends on accounting for every path.
 */
export async function getGitTreeEntries(
  token: string,
  oid: string,
): Promise<Array<{ mode: string; path: string; sha: string; type: string }>> {
  const response = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/git/trees/${oid}?recursive=1`,
    { token },
  );
  if (!isRecord(response) || !Array.isArray(response['tree'])) {
    throw new Error('GitHub tree response is malformed.');
  }
  if (response['truncated'] === true) {
    throw new Error('Patchback coordination tree is too large to verify exactly.');
  }
  return response['tree'].map((entry) => {
    const value = objectValue(entry, 'GitHub tree entry');
    return {
      mode: stringValue(value['mode'], 'GitHub tree entry mode'),
      path: stringValue(value['path'], 'GitHub tree entry path'),
      sha: stringValue(value['sha'], 'GitHub tree entry SHA'),
      type: stringValue(value['type'], 'GitHub tree entry type'),
    };
  });
}

/** Reads and decodes a GitHub Git blob only when it uses the expected base64 shape. */
export async function readGitBlobText(token: string, oid: string): Promise<string> {
  const blob = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/blobs/${oid}`, { token });
  if (
    !isRecord(blob) ||
    blob['encoding'] !== 'base64' ||
    typeof blob['content'] !== 'string'
  ) {
    throw new Error('GitHub blob response is malformed.');
  }
  return Buffer.from(blob['content'].replaceAll('\n', ''), 'base64').toString('utf8');
}

/** Reads provider-computed ancestry status and merge base for two commit OIDs. */
export async function compareGitCommits(
  token: string,
  baseOid: string,
  headOid: string,
): Promise<{ mergeBaseOid: string; status: string }> {
  const comparison = await githubRequest(
    `/repos/${PILOT_REPOSITORY}/compare/${baseOid}...${headOid}`,
    { token },
  );
  const value = objectValue(comparison, 'GitHub comparison');
  const mergeBase = objectValue(value['merge_base_commit'], 'GitHub comparison merge base');
  return {
    mergeBaseOid: stringValue(mergeBase['sha'], 'GitHub comparison merge base SHA'),
    status: stringValue(value['status'], 'GitHub comparison status'),
  };
}
