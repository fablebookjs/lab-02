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
    'expected-snapshot': requireEnvironment(env, 'EXPECTED_SNAPSHOT'),
    'expected-version': requireEnvironment(env, 'EXPECTED_VERSION'),
    'github-token': await authenticatedToken(github),
    manifest: requireEnvironment(env, 'MANIFEST'),
    tarballs: requireEnvironment(env, 'TARBALLS'),
  });
}
