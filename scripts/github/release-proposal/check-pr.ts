import { checkPullRequest } from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({ context }: GitHubHandlerRuntime): Promise<void> {
  await checkPullRequest(context.payload.pull_request);
}
