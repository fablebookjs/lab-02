import { resolvePublication } from './controller.ts';
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
  const outputs = await resolvePublication({
    'authority-kind': requireEnvironment(env, 'AUTHORITY_KIND'),
    'github-token': await authenticatedToken(github),
    output: requireEnvironment(env, 'OUTPUT'),
    signal: requireEnvironment(env, 'SIGNAL'),
  });
  setNamedOutputs(core, outputs);
}
