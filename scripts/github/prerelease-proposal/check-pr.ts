import { checkPrereleasePullRequest } from './controller.ts';
import { validatedPullRequest } from '../events.ts';
import {
  authenticatedToken,
} from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';
import { getRef } from '../release-repository/github.ts';

export default async function handler({
  context,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  const main = await getRef(await authenticatedToken(github), 'heads/main');
  if (main === null) {
    throw new Error('The canonical main ref does not exist.');
  }
  await checkPrereleasePullRequest(
    validatedPullRequest(context.payload),
    main.oid,
  );
}
