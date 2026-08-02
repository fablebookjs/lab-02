import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from '../validation.ts';

const execute = promisify(execFile);

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const commandDiagnostic = (error: unknown): string =>
  isRecord(error)
    ? [error['stdout'], error['stderr']]
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0,
        )
        .join('\n')
    : '';

/**
 * Runs a subprocess without a shell and turns process failures into one
 * caller-facing diagnostic containing captured output. Use this for generic
 * commands; domain-specific interpretation of stdout stays with the caller.
 */
export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
) {
  try {
    return await execute(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const output = commandDiagnostic(error);
    throw new Error(
      `${command} ${args.join(' ')} failed${output ? `\n${output}` : ''}`,
      { cause: error },
    );
  }
}
