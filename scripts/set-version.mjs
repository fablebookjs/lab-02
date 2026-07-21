import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { listPublicPackages, repositoryRoot } from './list-public-packages.mjs';

const supportedVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
      }
    });
  });

const requestedVersion = process.argv[2];
if (process.argv.length !== 3 || !supportedVersion.test(requestedVersion ?? '')) {
  throw new Error(
    'Usage: node scripts/set-version.mjs <X.Y.Z[-alpha.N|-beta.N|-rc.N]>'
  );
}

const packages = await listPublicPackages();
if (packages.length === 0) {
  throw new Error('No public workspace packages were discovered.');
}

const publicNames = new Set(packages.map(({ name }) => name));
const rootManifestPath = join(repositoryRoot, 'package.json');
const rootManifest = await readJson(rootManifestPath);
rootManifest.version = requestedVersion;

for (const pkg of packages) {
  pkg.manifest.version = requestedVersion;
  for (const field of dependencyFields) {
    const dependencies = pkg.manifest[field];
    if (dependencies === undefined) {
      continue;
    }
    for (const name of Object.keys(dependencies)) {
      if (publicNames.has(name)) {
        dependencies[name] = requestedVersion;
      }
    }
  }
}

await Promise.all([
  writeJson(rootManifestPath, rootManifest),
  ...packages.map(({ manifest, manifestPath }) => writeJson(manifestPath, manifest)),
]);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
await run(npm, ['run', 'compile']);

console.log(`Materialized ${requestedVersion} across ${packages.length} public packages.`);
