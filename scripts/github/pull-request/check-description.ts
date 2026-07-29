import { descriptionErrors } from '../../shared/pull-request/description.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

type PullRequestPayload = {
  base?: { ref?: unknown };
  body?: unknown;
  head?: { ref?: unknown; repo?: { full_name?: unknown } };
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Pull request ${label} is missing.`);
  return value;
};

export default async function handler({
  context,
}: GitHubHandlerRuntime): Promise<void> {
  const pull = context.payload.pull_request as PullRequestPayload | undefined;
  if (pull === undefined) throw new Error('Pull request event data is missing.');
  const errors = descriptionErrors({
    baseRef: stringValue(pull.base?.ref, 'base ref'),
    body: typeof pull.body === 'string' ? pull.body : '',
    headRef: stringValue(pull.head?.ref, 'head ref'),
    headRepository: stringValue(pull.head?.repo?.full_name, 'head repository'),
    repository: `${context.repo.owner}/${context.repo.repo}`,
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  console.log('The pull request description has no unchecked Markdown tasks.');
}
