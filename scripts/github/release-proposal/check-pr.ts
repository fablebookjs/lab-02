import {
  checkPullRequest,
  type ReleaseProposalPullRequest,
} from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({ context }: GitHubHandlerRuntime): Promise<void> {
  const pull = context.payload.pull_request as ReleaseProposalPullRequest | undefined;
  if (pull === undefined) throw new Error('Release proposal event data is missing.');
  await checkPullRequest(pull);
}
