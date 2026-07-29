import { applyCut } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await applyCut({
    bundle: requireEnvironment(env, 'BUNDLE'),
    'github-token': await authenticatedToken(github),
    transition: requireEnvironment(env, 'TRANSITION'),
  });
}
