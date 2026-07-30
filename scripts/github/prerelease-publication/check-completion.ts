import { checkPrereleaseCompletion } from './controller.ts';
import { setNamedOutputs } from '../runtime.ts';
import type { GitHubHandlerRuntime } from '../runtime.ts';

export default async function handler({
  core,
  env,
}: GitHubHandlerRuntime): Promise<void> {
  const outputs = await checkPrereleaseCompletion({
    'expected-snapshot': env['EXPECTED_SNAPSHOT'] ?? '',
    'expected-version': env['EXPECTED_VERSION'] ?? '',
    'github-token': env['GITHUB_TOKEN'] ?? '',
    manifest: env['MANIFEST'] ?? '',
    tarballs: env['TARBALLS'] ?? '',
  });
  setNamedOutputs(core, outputs);
}
