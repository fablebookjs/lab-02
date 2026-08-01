import { run } from '../process/run.ts';

export async function resolveHeadOid(root: string): Promise<string> {
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}
