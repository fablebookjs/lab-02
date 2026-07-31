import { readFile, writeFile } from 'node:fs/promises';

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
