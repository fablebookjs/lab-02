import { inspectPrereleaseAuthority } from './controller.ts';
import { requireEnvironment, setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  core,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await inspectPrereleaseAuthority({
    'authority-kind': requireEnvironment(env, 'AUTHORITY_KIND'),
    authority: requireEnvironment(env, 'AUTHORITY'),
  });
  setNamedOutputs(core, outputs);
}
