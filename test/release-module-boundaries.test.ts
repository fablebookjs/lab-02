import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const typescriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return typescriptFiles(path);
        return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
      }),
    )
  ).flat();
};

test('release features do not import sibling controller internals', async () => {
  const githubRoot = join(repositoryRoot, 'scripts/github');
  const violations: string[] = [];
  for (const file of await typescriptFiles(githubRoot)) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"]\.\.\/[^'"]+\/controller\.ts['"]/.test(source)) {
      violations.push(relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(violations, []);
});

test('neutral GitHub release mechanics depend only on shared code and the repository adapter', async () => {
  const githubRoot = join(repositoryRoot, 'scripts/github');
  const mechanicsRoots = [
    'package-publication',
    'prepared-commit',
    'release-history',
    'release-repository',
  ];
  const violations: string[] = [];
  for (const directory of mechanicsRoots) {
    for (const file of await typescriptFiles(join(githubRoot, directory))) {
      const source = await readFile(file, 'utf8');
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1] ?? '',
      );
      for (const specifier of imports) {
        if (
          specifier.startsWith('node:') ||
          specifier.startsWith('./') ||
          specifier.startsWith('../../shared/') ||
          specifier.startsWith('../release-repository/')
        ) {
          continue;
        }
        violations.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
