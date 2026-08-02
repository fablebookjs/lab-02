import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readJsonFile } from '../shared/io/json.ts';
import { listPublicPackages, repositoryRoot } from '../shared/workspace/packages.ts';

const execute = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

type PackedArtifact = { filename: string; files: Array<{ path: string }> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const packedArtifact = (value: unknown, name: string): PackedArtifact => {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('filename' in value) ||
    typeof value.filename !== 'string' ||
    !('files' in value) ||
    !Array.isArray(value.files) ||
    value.files.some(
      (file) =>
        file === null ||
        typeof file !== 'object' ||
        !('path' in file) ||
        typeof file.path !== 'string',
    )
  ) {
    throw new Error(`npm pack returned an invalid artifact for ${name}.`);
  }
  return { filename: value.filename, files: value.files };
};

const run = (command: string, args: string[], cwd: string) =>
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

  const tarballs = new Map<string, string>();
  for (const pkg of packages) {
    const { stdout } = await run(
      npm,
      ['pack', '--json', '--pack-destination', packsDirectory, pkg.directory],
      repositoryRoot
    );
    const packResult: unknown = JSON.parse(stdout);
    const packedValue =
      Array.isArray(packResult)
        ? packResult[0]
        : isRecord(packResult)
          ? packResult[pkg.name]
          : undefined;
    const packed = packedArtifact(packedValue, pkg.name);

    const packedPaths = new Set<string>(packed.files.map(({ path }) => path));
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
    const installedManifest = await readJsonFile(
      join(consumerDirectory, 'node_modules', ...pkg.name.split('/'), 'package.json'),
    );
    assert.ok(
      installedManifest !== null &&
        typeof installedManifest === 'object' &&
        'version' in installedManifest,
      `${pkg.name} installed with an invalid manifest`,
    );
    assert.equal(
      installedManifest.version,
      pkg.version,
      `${pkg.name} installed at the wrong version`,
    );
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

  const firstPackage = packages[0];
  assert.ok(firstPackage, 'At least one public package is required.');
  console.log(`Packed consumer verified ${packages.length} packages at ${firstPackage.version}.`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
