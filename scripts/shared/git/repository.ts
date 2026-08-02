import { run } from '../process/run.ts';

/** Resolves the repository's current Git fact without exposing command output. */
export async function resolveHeadOid(root: string): Promise<string> {
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}

/** Reads one repository file at an exact commit, or reports its absence. */
export async function readFileAtCommit(
  root: string,
  oid: string,
  path: string,
): Promise<string | null> {
  try {
    return (await run('git', ['show', `${oid}:${path}`], { cwd: root })).stdout;
  } catch {
    return null;
  }
}
