import { preparePrereleasePublication } from './controller.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  env,
}: GitHubHandlerRuntime): Promise<void> {
  await preparePrereleasePublication({
    authority: env['AUTHORITY'] ?? '',
    output: env['OUTPUT'] ?? '',
    snapshot: env['SNAPSHOT'] ?? '',
  });
}
