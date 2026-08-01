import { dedent } from '../../shared/text/dedent.ts';
import {
  cleanReleaseTitle,
  migrationRecordDirectory,
  parseReleaseRecordChanges,
} from '../../shared/release-communication/records.ts';
import { parseStableVersion } from '../../shared/release-proposal/core.ts';
import { validateReleaseCommunication } from '../../shared/release-publication/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';

const renderMigrationSection = (
  records: Array<{ filename: string; title: string }>,
  version: string,
): string => {
  const { major, minor } = parseStableVersion(version);
  if (!Array.isArray(records)) {
    throw new Error('GitHub Release migration records must be an array.');
  }
  const filenames = new Set();
  const directory = migrationRecordDirectory(`v${major}.${minor}`);
  const links = records.map((record) => {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(record?.filename ?? '') ||
      typeof record?.title !== 'string' ||
      cleanReleaseTitle(record.title, record.filename.replace(/\.md$/, '')) !==
        record.title ||
      filenames.has(record.filename)
    ) {
      throw new Error(
        `Invalid GitHub Release migration record: ${record?.filename}`,
      );
    }
    filenames.add(record.filename);
    const url = `https://github.com/${PILOT_REPOSITORY}/blob/v${version}/${directory}/${record.filename}`;
    return `- [${record.title}](${url})`;
  });
  return links.length === 0
    ? ''
    : `\n\n${dedent`
        ## Migrations

        ${links.join('\n')}
      `}`;
};

/**
 * Renders the immutable public GitHub Release body for a stable release.
 *
 * @remarks
 * Use this renderer only for public stable-release presentation. The
 * maintainer-facing Release PR has a separate template and change reason. The
 * generated release record is checked against the authorized public changes
 * before any Markdown is returned.
 *
 * @throws
 * The communication, release record, or migration records contradict the
 * authorized stable release.
 */
export function renderStableGitHubReleaseBody({
  communication,
  migrationRecords = [],
  releaseRecord,
  version,
}: {
  communication: unknown;
  migrationRecords?: Array<{ filename: string; title: string }>;
  releaseRecord: string;
  version: string;
}): string {
  const normalized = validateReleaseCommunication(communication, version);
  const recordChanges = parseReleaseRecordChanges({
    source: releaseRecord,
    version,
  });
  const publicChanges = normalized.changes.filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip,
  );
  if (
    JSON.stringify(publicChanges.map(({ title, url }) => ({ title, url }))) !==
    JSON.stringify(recordChanges)
  ) {
    throw new Error(
      `Generated v${version} release record contradicts its authorized communication.`,
    );
  }

  const renderedChanges = publicChanges
    .map(({ title, url }) => `- [${title}](${url})`)
    .join('\n');
  const migrationSection = renderMigrationSection(migrationRecords, version);
  const title = `# Lab-02 ${version}`;

  if (normalized.kind === 'initial') {
    const noteworthyChanges =
      renderedChanges.length === 0
        ? ''
        : `\n\n${dedent`
            ## Noteworthy changes

            ${renderedChanges}
          `}`;
    return `${dedent`
      ${title}

      ## Release highlights

      ${normalized.releaseHighlights}${noteworthyChanges}${migrationSection}
    `}\n`;
  }

  if (normalized.kind === 'patch') {
    return `${dedent`
      ${title}

      ## What's changed

      ${renderedChanges}${migrationSection}
    `}\n`;
  }

  return `${dedent`
    ${title}

    This maintenance release contains no user-facing changes worth mentioning.${migrationSection}
  `}\n`;
}
