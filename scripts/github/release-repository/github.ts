import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import {
  booleanValue,
  objectValue,
  stringValue,
} from './response-schema.ts';
import {
  githubRequest,
  githubRequestOrNull,
} from './transport.ts';

export type GitHubRelease = {
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
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
  if (
    value['full_name'] !== PILOT_REPOSITORY ||
    value['default_branch'] !== PRIMARY_BRANCH
  ) {
    throw new Error('The controller is not operating on the allowlisted pilot repository.');
  }
  return {
    default_branch: PRIMARY_BRANCH,
    full_name: PILOT_REPOSITORY,
    node_id: stringValue(value['node_id'], 'GitHub repository node_id'),
  };
}

export async function getReleaseByTag(
  token: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const value = await githubRequestOrNull(
    `/repos/${PILOT_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  );
  if (value === null) {
    return null;
  }
  return validatedReleaseResponse(value);
}
