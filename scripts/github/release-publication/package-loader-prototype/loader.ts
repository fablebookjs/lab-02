// PROTOTYPE — executes tagged code only in a credentialless process. The open
// question is whether this computed import is the right production seam.

import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  normalizeLegacyPackages,
  type PackageSourceProbe,
  projectNativeCatalog,
  type ReleasePackage,
  selectPackageSource,
  workspaceCatalogExport,
} from './model.ts';

const execute = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const supportedApiVersions = [1] as const;

export type LoaderResult = {
  packages: readonly ReleasePackage[];
  probe: PackageSourceProbe;
  source: ReturnType<typeof selectPackageSource>;
};

const existsAsFile = async (
  path: string,
): Promise<{ present: boolean; regular: boolean }> => {
  try {
    const status = await lstat(path);
    return { present: true, regular: status.isFile() };
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { present: false, regular: false };
    }
    throw error;
  }
};

const hasLegacyScript = async (snapshot: string): Promise<boolean> => {
  const parsed: unknown = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const scripts = (parsed as Record<string, unknown>)['scripts'];
  return (
    scripts !== null &&
    typeof scripts === 'object' &&
    !Array.isArray(scripts) &&
    typeof (scripts as Record<string, unknown>)['list-packages'] === 'string'
  );
};

const probeSnapshot = async (snapshot: string): Promise<PackageSourceProbe> => {
  const native: PackageSourceProbe['native'][number][] = [];
  for (const version of supportedApiVersions) {
    const path = join(snapshot, 'scripts', 'api', `v${version}`, 'workspace-packages.ts');
    const state = await existsAsFile(path);
    native.push({ path, version, ...state });
  }
  return {
    legacyScript: await hasLegacyScript(snapshot),
    native,
  };
};

const credentiallessEnvironment = (): NodeJS.ProcessEnv => {
  const names = ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT'];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
};

export async function loadReleasePackages(
  snapshotInput: string,
  expectedVersion: string,
): Promise<LoaderResult> {
  const snapshot = resolve(snapshotInput);
  const probe = await probeSnapshot(snapshot);
  const source = selectPackageSource(probe);
  if (source.kind === 'native') {
    // This works at runtime, but the current zero-install checker correctly
    // reports it as a computed dynamic import.
    const imported: unknown = await import(pathToFileURL(source.path).href);
    const listWorkspacePackages = workspaceCatalogExport(imported);
    return {
      packages: projectNativeCatalog(await listWorkspacePackages(), expectedVersion),
      probe,
      source,
    };
  }

  const { stdout } = await execute(
    npm,
    ['run', '--silent', '--ignore-scripts', 'list-packages'],
    {
      cwd: snapshot,
      env: credentiallessEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );
  return {
    packages: normalizeLegacyPackages(JSON.parse(stdout), expectedVersion),
    probe,
    source,
  };
}
