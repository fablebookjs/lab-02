import { publishPackages } from './controller.ts';
import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({ env }: GitHubHandlerRuntime): Promise<void> {
  await publishPackages({
    'expected-snapshot': requireEnvironment(env, 'EXPECTED_SNAPSHOT'),
    'expected-version': requireEnvironment(env, 'EXPECTED_VERSION'),
    manifest: requireEnvironment(env, 'MANIFEST'),
    tarballs: requireEnvironment(env, 'TARBALLS'),
  });
}
