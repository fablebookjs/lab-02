import { randomUUID } from 'node:crypto';

import { ZERO_OID } from '../../shared/release-proposal/core.ts';
import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import { isRecord, stringValue } from '../../shared/validation.ts';
import { objectValue } from './response-schema.ts';
import {
  githubGraphqlRequest,
  githubRequest,
  githubRequestOrNull,
} from './transport.ts';

export type GitReference = {
  object: {
    sha: string;
    type: string;
  };
  ref: string;
};

export async function getRef(
  token: string,
  ref: string,
): Promise<{ oid: string; type: string } | null> {
  const value = await githubRequestOrNull(
    `/repos/${PILOT_REPOSITORY}/git/ref/${encodeURIComponent(ref)}`,
    token,
  );
  if (value === null) return null;
  const object = objectValue(objectValue(value, 'Git ref')['object'], 'Git ref object');
  return {
    oid: stringValue(object['sha'], 'Git ref object SHA'),
    type: stringValue(object['type'], 'Git ref object type'),
  };
}

/** Lists every ref under a prefix, preserving GitHub's paginated order. */
export async function listMatchingRefs(
  token: string,
  prefix: string,
): Promise<GitReference[]> {
  const refs: GitReference[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '100' });
    const batch = await githubRequest(
      `/repos/${PILOT_REPOSITORY}/git/matching-refs/${prefix}?${query}`,
      { token },
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
    if (batch.length < 100) return refs;
  }
}

/** Recursively peels annotated tag objects until they identify a commit. */
export async function resolveRefObject(
  token: string,
  object: GitReference['object'],
): Promise<string> {
  if (object.type === 'commit') return object.sha;
  if (object.type !== 'tag') {
    throw new Error(`Unsupported Git ref object type: ${object.type}`);
  }
  const tag = await githubRequest(`/repos/${PILOT_REPOSITORY}/git/tags/${object.sha}`, { token });
  const tagObject = objectValue(objectValue(tag, 'Git tag')['object'], 'Git tag object');
  return resolveRefObject(token, {
    sha: stringValue(tagObject['sha'], 'Git tag object SHA'),
    type: stringValue(tagObject['type'], 'Git tag object type'),
  });
}

/**
 * Constructs an atomic update only for the release controller's branch
 * allowlist. Omitted old state means creation from Git's zero OID.
 */
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
    name !== `refs/heads/${PRIMARY_BRANCH}` &&
    name !== 'refs/heads/prerelease' &&
    !/^refs\/heads\/(?:releases|staged)\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(name)
  ) {
    throw new Error(`Ref is outside the release controller allowlist: ${name}`);
  }
  return { afterOid, beforeOid: beforeOid ?? ZERO_OID, force, name };
}

/** Applies one guarded ref transition through GitHub's atomic updateRefs mutation. */
export async function updateRefs(
  token: string,
  repositoryId: string,
  refUpdates: ReturnType<typeof createRefUpdate>[],
): Promise<Record<string, unknown>> {
  const query = `mutation UpdateRefs($input: UpdateRefsInput!) {
    updateRefs(input: $input) { clientMutationId }
  }`;
  const result = await githubGraphqlRequest(
    query,
    {
      input: {
        clientMutationId: `fablebook-release-${randomUUID()}`,
        refUpdates,
        repositoryId,
      },
    },
    token,
  );
  const errors = isRecord(result) ? result['errors'] : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub updateRefs rejected the transition: ${JSON.stringify(errors)}`);
  }
  const data = objectValue(objectValue(result, 'GitHub updateRefs result')['data'], 'GitHub updateRefs data');
  return objectValue(data['updateRefs'], 'GitHub updateRefs payload');
}

export async function createGitRef(token: string, ref: string, oid: string): Promise<void> {
  await githubRequest(`/repos/${PILOT_REPOSITORY}/git/refs`, {
    body: { ref, sha: oid },
    method: 'POST',
    token,
  });
}
