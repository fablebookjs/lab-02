import { writeFile } from 'node:fs/promises';

import { validatedPullRequestNumber } from '../events.ts';
import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  context,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const pullRequest = validatedPullRequestNumber(context.payload);
  await writeFile(
    requireEnvironment(env, 'SIGNAL'),
    `${JSON.stringify({ pullRequest })}\n`,
    'utf8',
  );
}
