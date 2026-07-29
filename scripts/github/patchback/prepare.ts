import { preparePatchback } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await preparePatchback({
    authority: requireEnvironment(env, 'AUTHORITY'),
    controller: requireEnvironment(env, 'CONTROLLER'),
    'github-token': await authenticatedToken(github),
    output: requireEnvironment(env, 'OUTPUT'),
    snapshot: requireEnvironment(env, 'SNAPSHOT'),
  });
}
