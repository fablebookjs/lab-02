import { applyPatchback } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  await applyPatchback({
    'github-token': await authenticatedToken(github),
    manifest: requireEnvironment(env, 'MANIFEST'),
  });
}
