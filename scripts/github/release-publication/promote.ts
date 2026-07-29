import { promoteLatest } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await promoteLatest({
    'github-token': await authenticatedToken(github),
    snapshot: requireEnvironment(env, 'SNAPSHOT'),
    version: requireEnvironment(env, 'RELEASE_VERSION'),
  });
}
