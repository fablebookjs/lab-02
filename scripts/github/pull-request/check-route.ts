import { pullRequestRouteError } from '../../shared/pull-request/route.ts';
import { validatedPullRequestRoute } from '../events.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  context,
}: Pick<GitHubHandlerRuntime, 'context'>): Promise<void> {
  const pull = validatedPullRequestRoute(context.payload);
  const error = pullRequestRouteError({
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headRepository: pull.head.repo.full_name,
    repository: `${context.repo.owner}/${context.repo.repo}`,
  });
  if (error !== null) throw new Error(error);
  console.log(`Pull request route ${pull.head.ref} -> ${pull.base.ref} is allowed.`);
}
