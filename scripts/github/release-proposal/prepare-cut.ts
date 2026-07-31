import { prepareCut } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await prepareCut({
    'github-token': await authenticatedToken(github),
    'next-development': requireEnvironment(env, 'NEXT_DEVELOPMENT'),
    output: requireEnvironment(env, 'OUTPUT'),
  });
}
