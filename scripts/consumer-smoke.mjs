import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { listPublicPackages, repositoryRoot } from './list-public-packages.mjs';

const execute = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

const run = (command, args, cwd) =>
  execute(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

const packages = await listPublicPackages();
const temporaryRoot = await mkdtemp(join(tmpdir(), 'fablebook-lab-02-consumer-'));

try {
  const packsDirectory = join(temporaryRoot, 'packs');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  await Promise.all([
    mkdir(packsDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
  ]);

  const tarballs = new Map();
  for (const pkg of packages) {
    const { stdout } = await run(
      npm,
      ['pack', '--json', '--pack-destination', packsDirectory, pkg.directory],
      repositoryRoot
    );
    const packResult = JSON.parse(stdout);
    const packed = Array.isArray(packResult) ? packResult[0] : packResult[pkg.name];
    assert.ok(packed, `npm pack returned no artifact for ${pkg.name}`);

    const packedPaths = new Set(packed.files.map(({ path }) => path));
    assert.ok(packedPaths.has('dist/index.js'), `${pkg.name} has no compiled JavaScript`);
    assert.ok(packedPaths.has('dist/index.d.ts'), `${pkg.name} has no declarations`);
    assert.ok(
      [...packedPaths].every((path) => !path.startsWith('src/')),
      `${pkg.name} unexpectedly publishes source files`
    );

    tarballs.set(pkg.name, join(packsDirectory, packed.filename));
  }

  const dependencies = Object.fromEntries(
    [...tarballs].map(([name, path]) => [name, `file:${path}`])
  );
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fablebook-lab-02-packed-consumer',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  await run(
    npm,
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    consumerDirectory
  );

  for (const pkg of packages) {
    const installedManifest = JSON.parse(
      await readFile(join(consumerDirectory, 'node_modules', ...pkg.name.split('/'), 'package.json'))
    );
    assert.equal(installedManifest.version, pkg.version, `${pkg.name} installed at the wrong version`);
  }

  await writeFile(
    join(consumerDirectory, 'verify.mjs'),
    `import assert from 'node:assert/strict';
import { add } from '@fablebook/lab-02-core';
import { formatSummary, total } from '@fablebook/lab-02-addon';

assert.equal(add(2, 3), 5);
assert.equal(total([1, 2, 3]), 6);
assert.equal(formatSummary(' Demo ', [2, 3]), 'demo:5');
`,
    'utf8'
  );
  await run(node, ['verify.mjs'], consumerDirectory);

  console.log(`Packed consumer verified ${packages.length} packages at ${packages[0].version}.`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
