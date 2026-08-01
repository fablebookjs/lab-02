import { PILOT_REPOSITORY, PRIMARY_BRANCH } from '../../shared/repository.ts';
import { objectValue, stringValue } from './response-schema.ts';
import { githubRequest } from './transport.ts';

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
