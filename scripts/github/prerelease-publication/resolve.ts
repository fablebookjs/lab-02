import { resolvePrereleasePublication } from './controller.ts';
import { requireEnvironment, setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  core,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await resolvePrereleasePublication({
    'authority-kind': requireEnvironment(env, 'AUTHORITY_KIND'),
    'github-token': requireEnvironment(env, 'GITHUB_TOKEN'),
    output: requireEnvironment(env, 'OUTPUT'),
    signal: requireEnvironment(env, 'SIGNAL'),
  });
  setNamedOutputs(core, outputs);
}
