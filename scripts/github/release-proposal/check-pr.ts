import { checkPullRequest } from './controller.ts';
import { validatedPullRequest } from '../events.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({ context }: GitHubHandlerRuntime): Promise<void> {
  await checkPullRequest(validatedPullRequest(context.payload));
}
