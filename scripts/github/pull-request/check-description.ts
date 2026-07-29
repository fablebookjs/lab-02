import { descriptionErrors } from '../../shared/pull-request/description.ts';
import { validatedPullRequestDescription } from '../events.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  context,
}: Pick<GitHubHandlerRuntime, 'context'>): Promise<void> {
  const pull = validatedPullRequestDescription(context.payload);
  const errors = descriptionErrors({
    baseRef: pull.base.ref,
    body: typeof pull.body === 'string' ? pull.body : '',
    headRef: pull.head.ref,
    headRepository: pull.head.repo.full_name,
    repository: `${context.repo.owner}/${context.repo.repo}`,
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  console.log('The pull request description has no unchecked Markdown tasks.');
}
