import { preparePhaseEntry } from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await preparePhaseEntry({
    'github-token': env['GITHUB_TOKEN'] ?? '',
    output: env['OUTPUT'] ?? '',
    target: env['TARGET'] ?? '',
  });
}
