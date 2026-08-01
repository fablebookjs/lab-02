import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadReleasePackageSet } from '../../shared/package-publication/package-set.ts';
import {
  createPromotionManifest,
  promoteSealedPackageSet,
  validatePromotionManifest,
} from '../../shared/release-publication/promotion.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { requireOption } from '../../shared/cli/options.ts';
import { NPM_REGISTRY } from '../../shared/package-publication/core.ts';
import { readJsonFile, writeJsonFile } from '../../shared/io/json.ts';
import { parseStableVersion } from '../../shared/release-proposal/core.ts';
import { run } from '../../shared/process/run.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export type PreparePromotionOptions = {
  manifest: string;
  snapshot: string;
  'snapshot-oid': string;
  version: string;
};

export type PromoteLatestOptions = {
  'expected-snapshot': string;
  'expected-version': string;
  manifest: string;
};

const ensureTrustedMain = (): void => {
  if (
    process.env['GITHUB_REPOSITORY'] !== PILOT_REPOSITORY ||
    process.env['GITHUB_REF'] !== 'refs/heads/main'
  ) {
    throw new Error('Promotion authority is restricted to trusted main in the pilot repository.');
  }
};

const gitHead = async (root: string): Promise<string> =>
  (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

const validateSnapshot = async (root: string, expectedOid: string): Promise<void> => {
  if (!/^[0-9a-f]{40}$/.test(expectedOid)) {
    throw new Error('Expected promotion snapshot is not a full commit OID.');
  }
  if ((await gitHead(root)) !== expectedOid) {
    throw new Error('The checked-out snapshot does not match promotion authority.');
  }
};

export async function preparePromotion(
  options: PreparePromotionOptions,
): Promise<void> {
  ensureTrustedMain();
  const version = requireOption(options, 'version');
  parseStableVersion(version);
  const snapshotOid = requireOption(options, 'snapshot-oid');
  const snapshot = resolve(requireOption(options, 'snapshot'));
  await validateSnapshot(snapshot, snapshotOid);
  const packages = await loadReleasePackageSet(snapshot, version);
  const manifest = createPromotionManifest({
    packages: packages.map(({ name }) => name),
    snapshotOid,
    version,
  });
  const manifestPath = resolve(requireOption(options, 'manifest'));
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeJsonFile(manifestPath, manifest);
  console.log(`Prepared ${manifest.packages.length} packages for latest promotion.`);
}

export async function promoteLatest(options: PromoteLatestOptions): Promise<void> {
  ensureTrustedMain();
  if (!process.env['NODE_AUTH_TOKEN']) {
    throw new Error('Promotion requires the package-scoped npm promotion credential.');
  }
  const manifest = validatePromotionManifest(
    await readJsonFile(resolve(requireOption(options, 'manifest'))),
    {
      repository: PILOT_REPOSITORY,
      snapshotOid: requireOption(options, 'expected-snapshot'),
      version: requireOption(options, 'expected-version'),
    },
  );

  await promoteSealedPackageSet(manifest, {
    addLatest: async (name, version) => {
      await run(npm, [
        'dist-tag',
        'add',
        `${name}@${version}`,
        'latest',
        '--registry',
        NPM_REGISTRY,
      ]);
    },
    wait: (milliseconds) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  });
  console.log(`Promoted the complete ${manifest.version} package set to latest.`);
}
