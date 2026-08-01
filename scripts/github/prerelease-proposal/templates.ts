import { normalizeReleaseChanges } from '../../shared/release-communication/records.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import {
  PRERELEASE_PR_TEMPLATE_MARKER,
  PRERELEASE_RELEASE_NOTE_SKIP_LABEL,
  validatePrereleasePrBody,
} from '../../shared/prerelease-proposal/body.ts';
import type { PrereleasePrIdentity } from '../../shared/prerelease-proposal/body.ts';
import { dedent } from '../../shared/text/dedent.ts';

const renderChange = (change: ReleaseChange): string => {
  const annotation = change.releaseNoteSkip
    ? ` — Not included in public release notes (${PRERELEASE_RELEASE_NOTE_SKIP_LABEL}).`
    : '';
  const releaseNote = change.releaseNoteSkip ? 'skip' : 'include';
  return `- [${change.title}](${change.url})${annotation} <!-- fablebook:prerelease-change=${change.key} release-note=${releaseNote} -->`;
};

export function renderPrereleasePrBody({
  boundaryOid,
  changes,
  proposalOid,
  sourceOid,
  version,
}: PrereleasePrIdentity & { changes: unknown }): string {
  const normalized = normalizeReleaseChanges(changes);
  const renderedChanges =
    normalized.length === 0
      ? '_No product changes are included in this prerelease scope._'
      : normalized.map(renderChange).join('\n');
  const body = `${dedent`
    ${PRERELEASE_PR_TEMPLATE_MARKER}
    <!-- fablebook:prerelease-proposal=${proposalOid} source=${sourceOid} boundary=${boundaryOid} version=${version} -->

    # Prerelease ${version}

    ## All changes in this prerelease scope

    ${renderedChanges}

    _No QA checklist. Merging authorizes this exact snapshot._
  `}\n`;
  validatePrereleasePrBody(body, {
    boundaryOid,
    proposalOid,
    sourceOid,
    version,
  });
  return body;
}
