import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
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

export async function readJson(path: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return value;
}

export const writeJson = async (
  path: string,
  value: unknown,
): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

export function requireOption<Name extends string>(
  options: Record<Name, string | undefined>,
  name: Name,
): string {
  const value = options[name];
  if (!value) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

export function requireGithubToken(options: {
  'github-token': string;
}): string {
  const token = options['github-token'];
  if (!token) {
    throw new Error('An authenticated GitHub capability is required.');
  }
  return token;
}
