import { resolvePromotion } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  setNamedOutputs,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  core,
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await resolvePromotion({
    'github-token': await authenticatedToken(github),
    version: requireEnvironment(env, 'RELEASE_VERSION'),
  });
  setNamedOutputs(core, outputs);
}
