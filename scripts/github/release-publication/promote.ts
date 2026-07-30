import { promoteLatest } from './promotion-controller.ts';
import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await promoteLatest({
    'expected-snapshot': requireEnvironment(env, 'EXPECTED_SNAPSHOT'),
    'expected-version': requireEnvironment(env, 'EXPECTED_VERSION'),
    manifest: requireEnvironment(env, 'PROMOTION_MANIFEST'),
  });
}
