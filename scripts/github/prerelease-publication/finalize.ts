import { finalizePrerelease } from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await finalizePrerelease({
    'expected-snapshot': env['EXPECTED_SNAPSHOT'] ?? '',
    'expected-version': env['EXPECTED_VERSION'] ?? '',
    'github-token': env['GITHUB_TOKEN'] ?? '',
    manifest: env['MANIFEST'] ?? '',
    tarballs: env['TARBALLS'] ?? '',
  });
}
