import { inspectPrereleaseAuthority } from './controller.ts';
import { setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  core,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await inspectPrereleaseAuthority({
    authority: env['AUTHORITY'] ?? '',
  });
  setNamedOutputs(core, outputs);
}
