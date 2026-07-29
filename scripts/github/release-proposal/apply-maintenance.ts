import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyMaintenance } from './controller.ts';
import {
  authenticatedToken,
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
  github,
}: GitHubHandlerRuntime): Promise<void> {
  const output = requireEnvironment(env, 'OUTPUT');
  const bundle = join(output, 'objects.bundle');
  await applyMaintenance({
    ...(existsSync(bundle) ? { bundle } : {}),
    'github-token': await authenticatedToken(github),
    transition: join(output, 'transition.json'),
  });
}
