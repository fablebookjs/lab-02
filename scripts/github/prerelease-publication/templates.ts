import type { PrereleasePrChange } from '../../shared/prerelease-proposal/body.ts';
import { validatePrereleaseCommunication } from '../../shared/prerelease-publication/core.ts';
import { parseDevelopmentVersion } from '../../shared/release-proposal/core.ts';
import { dedent } from '../../shared/text/dedent.ts';

/** Renders public prerelease changes, omitting entries classified release-note:skip. */
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
      : publicChanges.map(({ title, url }) => `- [${title}](${url})`).join('\n');

  return `${dedent`
    # Lab-02 ${version}

    ## What's changed

    ${rendered}
  `}\n`;
}
