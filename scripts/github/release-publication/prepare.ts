import { preparePublication } from './controller.ts';
import {
  requireEnvironment,
  type GitHubHandlerRuntime,
} from '../runtime.ts';

export default async function handler({ env }: GitHubHandlerRuntime): Promise<void> {
  await preparePublication({
    authority: requireEnvironment(env, 'AUTHORITY'),
    output: requireEnvironment(env, 'OUTPUT'),
    snapshot: requireEnvironment(env, 'SNAPSHOT'),
  });
}
