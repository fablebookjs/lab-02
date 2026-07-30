import { reconcilePrereleaseNext } from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await reconcilePrereleaseNext({
    'expected-snapshot': env['EXPECTED_SNAPSHOT'] ?? '',
    'expected-version': env['EXPECTED_VERSION'] ?? '',
    manifest: env['MANIFEST'] ?? '',
    tarballs: env['TARBALLS'] ?? '',
  });
}
