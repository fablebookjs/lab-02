import { applyPhaseEntry } from './controller.ts';
import { setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  core,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await applyPhaseEntry({
    ...(env['BUNDLE'] === undefined ? {} : { bundle: env['BUNDLE'] }),
    'github-token': env['GITHUB_TOKEN'] ?? '',
    output: env['OUTPUT'] ?? '',
    transition: env['TRANSITION'] ?? '',
  });
  setNamedOutputs(core, outputs);
}
