import { prepareCut } from './controller.ts';
import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({ env }: GitHubHandlerRuntime): Promise<void> {
  await prepareCut({
    'next-development': requireEnvironment(env, 'NEXT_DEVELOPMENT'),
    output: requireEnvironment(env, 'OUTPUT'),
  });
}
