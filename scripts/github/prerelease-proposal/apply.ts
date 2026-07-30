import { applyPrereleaseProposal } from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await applyPrereleaseProposal({
    ...(env['BUNDLE'] === undefined ? {} : { bundle: env['BUNDLE'] }),
    'github-token': env['GITHUB_TOKEN'] ?? '',
    transition: env['TRANSITION'] ?? '',
  });
}
