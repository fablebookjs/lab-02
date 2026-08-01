import { run } from '../process/run.ts';

/** Resolves the repository's current Git fact without exposing command output. */
export async function resolveHeadOid(root: string): Promise<string> {
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}
