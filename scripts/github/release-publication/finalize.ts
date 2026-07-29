import { finalizeRelease } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await finalizeRelease({
    'github-token': await authenticatedToken(github),
    manifest: requireEnvironment(env, 'MANIFEST'),
    snapshot: requireEnvironment(env, 'SNAPSHOT'),
  });
}
