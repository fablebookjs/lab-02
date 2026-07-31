import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const commandDiagnostic = (error: unknown): string =>
  isRecord(error)
    ? [error['stdout'], error['stderr']]
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0,
        )
        .join('\n')
    : '';

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
