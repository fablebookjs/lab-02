import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { repositoryRoot } from './list-public-packages.mjs';
import {
  composeMigrationRecords,
  loadMigrationRecords,
  migrationRecordDirectory,
} from './release-communication.mjs';
import { parseReleaseLine } from './release-proposal-core.mjs';

const root = join(repositoryRoot, 'migration-notes');
let entries;
try {
  entries = await readdir(root, { withFileTypes: true });
} catch (error) {
  if (error.code === 'ENOENT') {
    entries = [];
  } else {
    throw error;
  }
}

const lines = [];
for (const entry of entries) {
  if (entry.isFile() && entry.name === 'TEMPLATE.md') {
    composeMigrationRecords([
      {
        filename: 'template.md',
        source: await readFile(join(root, entry.name), 'utf8'),
      },
    ]);
    continue;
  }
  if (!entry.isDirectory()) {
    throw new Error(`Unexpected migration-notes entry: ${entry.name}`);
  }
  parseReleaseLine(entry.name);
  lines.push(entry.name);
}

for (const line of lines) {
  const records = await loadMigrationRecords(repositoryRoot, line);
  console.log(
    `${migrationRecordDirectory(line)}: ${records.length} validated migration record(s)`
  );
}

console.log(`Validated ${lines.length} migration target line(s).`);
