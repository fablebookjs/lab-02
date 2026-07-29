import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`The zero-install smoke requires Node 24; received ${process.version}.`);
}
if (process.env['NODE_PATH']) {
  throw new Error('NODE_PATH must be unset for the zero-install smoke.');
}
if (existsSync(join(repositoryRoot, 'node_modules'))) {
  throw new Error('The zero-install smoke must run before repository dependencies exist.');
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)));
    else if (extname(entry.name) === '.ts') files.push(path);
  }
  return files;
}

const strictFiles = (
  await Promise.all(
    ['shared', 'github'].map((zone) => typescriptFiles(join(repositoryRoot, 'scripts', zone))),
  )
).flat();

for (const file of strictFiles.sort()) await import(pathToFileURL(file).href);

console.log(
  `Loaded ${strictFiles.length} zero-install TypeScript modules with Node ${process.versions.node}.`,
);
