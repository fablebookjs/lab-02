import { resolvePrereleasePublication } from './controller.ts';
import { setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  core,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await resolvePrereleasePublication({
    'github-token': env['GITHUB_TOKEN'] ?? '',
    output: env['OUTPUT'] ?? '',
    signal: env['SIGNAL'] ?? '',
  });
  setNamedOutputs(core, outputs);
}
