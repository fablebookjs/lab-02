import { prepareMaintenance } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await prepareMaintenance({
    'github-token': await authenticatedToken(github),
    output: requireEnvironment(env, 'OUTPUT'),
  });
}
