import { writeFile } from 'node:fs/promises';

import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  context,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const pullRequest = context.payload.pull_request?.number;
  if (
    typeof pullRequest !== 'number' ||
    !Number.isSafeInteger(pullRequest) ||
    pullRequest <= 0
  ) {
    throw new Error('Closed release signal has no positive pull request number.');
  }
  await writeFile(
    requireEnvironment(env, 'SIGNAL'),
    `${JSON.stringify({ pullRequest })}\n`,
    'utf8',
  );
}
