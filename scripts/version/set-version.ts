import { spawn } from 'node:child_process';

import { repositoryRoot } from '../shared/workspace/packages.ts';
import {
  materializeVersion,
  validateMaterializedVersion,
} from '../shared/version/materialize.ts';

const run = (command: string, args: string[]): Promise<void> =>
  new Promise<void>((resolve, reject) => {
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
if (process.argv.length !== 3) {
  throw new Error(
    'Usage: node scripts/version/set-version.ts <X.Y.Z[-alpha.N|-beta.N|-rc.N]>'
  );
}
const version = validateMaterializedVersion(requestedVersion);
const { packageCount } = await materializeVersion(repositoryRoot, version);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
await run(npm, ['run', 'compile']);

console.log(`Materialized ${version} across ${packageCount} public packages.`);
