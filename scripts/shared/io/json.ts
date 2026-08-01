import { readFile, writeFile } from 'node:fs/promises';

export async function readJsonFile(path: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return value;
}

export const writeJsonFile = async (
  path: string,
  value: unknown,
): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
