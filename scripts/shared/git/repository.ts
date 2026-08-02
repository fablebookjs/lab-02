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
  const commitOid = (
    await run('git', ['rev-parse', '--verify', `${oid}^{commit}`], { cwd: root })
  ).stdout.trim();
  const { stdout: entry } = await run(
    'git',
    ['ls-tree', '-z', '--full-tree', commitOid, '--', path],
    { cwd: root },
  );
  if (entry.length === 0) {
    return null;
  }
  const match = /^(?:100644|100755) blob [0-9a-f]{40}\t([^\0]+)\0$/.exec(entry);
  if (match?.[1] !== path) {
    throw new Error(`Git path is not one regular file at ${commitOid}: ${path}`);
  }
  return (await run('git', ['show', `${commitOid}:${path}`], { cwd: root })).stdout;
}
