import type { PrereleasePrChange } from '../../shared/prerelease-proposal/body.ts';
import {
  validatePrereleaseCommunication,
} from '../../shared/prerelease-publication/core.ts';
import { parseDevelopmentVersion } from '../../shared/release-proposal/core.ts';
import { dedent } from '../../shared/text/dedent.ts';

/**
 * Renders the incremental public GitHub Release body for a prerelease.
 *
 * @remarks
 * This presentation excludes changes marked `release-note:skip`. It is not
 * cumulative stable communication and intentionally contains neither release
 * highlights nor migration guidance.
 *
 * @throws
 * The version or prerelease communication is outside its accepted schema.
 */
export function renderPrereleaseGitHubReleaseBody({
  changes,
  version,
}: {
  changes: readonly PrereleasePrChange[];
  version: string;
}): string {
  parseDevelopmentVersion(version);
  const publicChanges = validatePrereleaseCommunication(changes).filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip,
  );
  const rendered =
    publicChanges.length === 0
      ? 'This prerelease contains no user-facing changes worth mentioning.'
      : publicChanges
          .map(({ title, url }) => `- [${title}](${url})`)
          .join('\n');

  return `${dedent`
    # Lab-02 ${version}

    ## What's changed

    ${rendered}
  `}\n`;
}
