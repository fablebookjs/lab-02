import { publishPackages } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await publishPackages({
    'github-token': await authenticatedToken(github),
    manifest: requireEnvironment(env, 'MANIFEST'),
    snapshot: requireEnvironment(env, 'SNAPSHOT'),
    tarballs: requireEnvironment(env, 'TARBALLS'),
  });
}
