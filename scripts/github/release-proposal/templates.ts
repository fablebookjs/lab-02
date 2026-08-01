import {
  cleanReleaseTitle,
  migrationRecordDirectory,
  normalizeReleaseChanges,
} from '../../shared/release-communication/records.ts';
import type { ReleaseChange } from '../../shared/release-communication/records.ts';
import {
  extractReleasePrCheckboxes,
  extractReleasePrChanges,
  recoverReleaseHighlights,
  RELEASE_HIGHLIGHTS_END,
  RELEASE_HIGHLIGHTS_START,
  RELEASE_PR_TEMPLATE_MARKER,
} from '../../shared/release-proposal/body.ts';
import { parseReleaseLine, parseStableVersion } from '../../shared/release-proposal/core.ts';
import { PILOT_REPOSITORY } from '../../shared/repository.ts';
import { dedent } from '../../shared/text/dedent.ts';

const repositoryUrl = `https://github.com/${PILOT_REPOSITORY}`;
const packageNamePattern = /^@fablebook\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

type RenderedChange = ReleaseChange & { checkmark: string };

type RenderReleasePrBodyOptions = {
  changes: unknown[];
  line: string;
  migrationRecords?: Array<{ filename: string; title: string }>;
  packageNames: string[];
  previousBody?: string;
  previousHighlightsBody?: string;
  proposalOid: string;
  releaseOid: string;
  supersededPr?: number;
  version: string;
};

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not one positive integer.`);
  }
  return value;
};

const validateChanges = (changes: unknown, previousBody: unknown): RenderedChange[] => {
  const previous = new Map(
    extractReleasePrChanges(previousBody).map((change) => [change.key, change]),
  );
  return normalizeReleaseChanges(changes).map((change) => {
    const prior = previous.get(change.key);
    return {
      ...change,
      checkmark:
        change.qaSkip || (prior?.checked === true && prior.qaSkip === false)
          ? 'x'
          : ' ',
    };
  });
};

const smokeCommands = (packageNames: string[], channel: string): string => {
  const installs = packageNames.map((name) => `${name}@${channel}`).join(' ');
  const packages = packageNames.join(' ');
  return [
    'pilot_dir="$(mktemp -d)"',
    'cd "$pilot_dir"',
    'npm init -y',
    `npm install ${installs}`,
    `npm ls --depth=0 ${packages}`,
    `node --input-type=module -e "await Promise.all(process.argv.slice(1).map((name) => import(name)))" ${packages}`,
  ].join('\n');
};

const renderChanges = (changes: RenderedChange[]): string =>
  changes.length === 0
    ? '_No release-line changes have been added since this release boundary._'
    : changes
        .map((change) => {
          const descriptions = [
            change.qaSkip
              ? 'No manual QA required (`qa:skip`).'
              : 'Perform the relevant manual QA.',
          ];
          if (change.releaseNoteSkip) {
            descriptions.push(
              'Not included in public release notes (`release-note:skip`).',
            );
          }
          const releaseNote = change.releaseNoteSkip ? 'skip' : 'include';
          const qa = change.qaSkip ? 'skip' : 'required';
          return `- [${change.checkmark}] [${change.title}](${change.url}) — ${descriptions.join(' ')} <!-- fablebook:change=${change.key} release-note=${releaseNote} qa=${qa} -->`;
        })
        .join('\n');

const renderMigrationSection = (
  records: Array<{ filename: string; title: string }>,
  line: string,
  releaseOid: string,
): string => {
  if (!Array.isArray(records)) {
    throw new Error('Release PR migration records must be an array.');
  }
  if (records.length === 0) return '';
  const directory = migrationRecordDirectory(line);
  const filenames = new Set();
  const links = records.map((record) => {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(record?.filename ?? '') ||
      filenames.has(record.filename) ||
      cleanReleaseTitle(record?.title, '') !== record.title
    ) {
      throw new Error(`Release PR migration record is invalid: ${record?.filename}`);
    }
    filenames.add(record.filename);
    const path = `${directory}/${record.filename}`;
    return `- [${record.title}](${repositoryUrl}/blob/${releaseOid}/${path}) (\`${path}\`)`;
  });
  return `## Migrations\n\n${links.join('\n')}`;
};

export function renderReleasePrBody({
  changes,
  line,
  migrationRecords = [],
  packageNames,
  previousBody = '',
  previousHighlightsBody = previousBody,
  proposalOid,
  releaseOid,
  supersededPr,
  version,
}: RenderReleasePrBodyOptions): string {
  const parsedLine = parseReleaseLine(line);
  const parsedVersion = parseStableVersion(version);
  if (parsedLine.major !== parsedVersion.major || parsedLine.minor !== parsedVersion.minor) {
    throw new Error(`${version} does not belong to release line ${line}.`);
  }
  fullOid(releaseOid, 'Release PR source');
  fullOid(proposalOid, 'Release PR proposal');
  const kind = parsedVersion.patch === 0 ? 'initial' : 'patch';
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    throw new Error('Release PR requires at least one public package.');
  }
  const uniquePackages = [...new Set(packageNames)];
  if (
    uniquePackages.length !== packageNames.length ||
    uniquePackages.some((name) => !packageNamePattern.test(name))
  ) {
    throw new Error('Release PR package names are invalid or duplicated.');
  }
  if (supersededPr !== undefined) {
    positiveInteger(supersededPr, 'Superseded pull request');
  }

  const states = extractReleasePrCheckboxes(previousBody);
  const channel = `v-${line.slice(1)}`;
  const npmVersionsUrl =
    `https://www.npmjs.com/package/${uniquePackages[0]}?activeTab=versions`;
  const highlightsSection =
    kind === 'initial'
      ? dedent`
          ## Release highlights

          <!--
          Write the short, user-facing release highlights. This marked block is preserved
          when the same initial-line release proposal is refreshed or replaced.
          -->

          ${[
            RELEASE_HIGHLIGHTS_START,
            recoverReleaseHighlights(previousHighlightsBody),
            RELEASE_HIGHLIGHTS_END,
          ].join('\n')}
        `
      : '';
  const migrationSection = renderMigrationSection(
    migrationRecords,
    line,
    releaseOid,
  );
  const supersededNotice =
    supersededPr === undefined
      ? ''
      : dedent`
          ---

          This clean proposal supersedes [#${supersededPr}](${repositoryUrl}/pull/${supersededPr}).
        `;
  const preservationSentence =
    kind === 'initial'
      ? dedent`
          preserves same-version release highlights and compatible per-change QA state.
          The metadata-freshness and communication-review checks always reset.
        `
      : dedent`
          preserves compatible per-change QA state. The metadata-freshness and
          communication-review checks always reset.
        `;

  return `${dedent`
    ${RELEASE_PR_TEMPLATE_MARKER}
    <!-- fablebook:release-kind=${kind} -->
    <!-- fablebook:proposal=${proposalOid} source=${releaseOid} version=${version} -->
    # Release ${version}

    > [!WARNING]
    > **This release does not promote \`latest\`.**
    > Merging publishes ${version} to the [\`${channel}\` npm channel](${npmVersionsUrl}). After publication and channel testing, a maintainer may run [**MANUAL - Publish: Promote to latest**](${repositoryUrl}/actions/workflows/promote-latest.yml) separately.

    | | | | |
    | --- | --- | --- | --- |
    | Release line | [\`releases/${line}\`](${repositoryUrl}/tree/releases/${line}) | Proposal branch | [\`staged/${line}\`](${repositoryUrl}/tree/staged/${line}) |
    | Version | **${version}** | npm channel | [\`${channel}\`](${npmVersionsUrl}) |
    | Release source | [\`${releaseOid.slice(0, 7)}\`](${repositoryUrl}/commit/${releaseOid}) | Proposal commit | [\`${proposalOid.slice(0, 7)}\`](${repositoryUrl}/commit/${proposalOid}) |
    | QA | Required checklist below | Packages | ${uniquePackages.length} published together |

    ${highlightsSection}

    ## Included changes and manual QA

    Perform the relevant manual QA for every unchecked item against this exact proposal. A checked generated item explicitly says why no manual QA is required.

    ${renderChanges(validateChanges(changes, previousBody))}

    <details>
    <summary>How to QA a change and record findings</summary>

    1. Open the linked PR or commit and decide which behavior needs manual verification.
    2. Exercise that behavior against this exact proposal.
    3. Discuss findings in this release PR. Open a normal issue only for independent long-term tracking.
    4. Resolve or explicitly dispose every applicable finding, then check the included change.

    </details>

    ${migrationSection}

    ## Confirm release readiness

    - [${states.get('check:discussions-resolved') ? 'x' : ' '}] Resolve all release discussions. <!-- fablebook:check=discussions-resolved -->
    - [ ] Confirm that included change titles and \`release-note:skip\` / \`qa:skip\` labels still match their source PRs; if not, close this release PR and let automation regenerate it. <!-- fablebook:check=source-metadata-current -->
    - [ ] Review the release communication and any migration records. <!-- fablebook:check=release-docs-reviewed -->

    ## Authorize and test

    1. Mark this PR ready, obtain the normal approval, and merge it.
    2. Wait for the [Publish: Publish approved release action](${repositoryUrl}/actions/workflows/publish-stable-release.yml) to publish the complete package set and create [\`v${version}\`](${repositoryUrl}/releases/tag/v${version}).
    3. Confirm progress or failure of the checklist-only patchback in the [Release: Prepare patchback PR action log](${repositoryUrl}/actions/workflows/maintain-patchback.yml).
    4. Run the clean-install smoke test below and confirm every package resolves to **${version}**.
    5. If channel testing is acceptable and ${version} should become the npm default, run [**MANUAL - Publish: Promote to latest**](${repositoryUrl}/actions/workflows/promote-latest.yml) with version **${version}**. Otherwise, do nothing.

    <details>
    <summary>Clean-install smoke-test commands</summary>

    \`\`\`sh
    ${smokeCommands(uniquePackages, channel)}
    \`\`\`

    </details>

    ${supersededNotice}

    <!--
    Automation re-renders this template whenever it generates the proposal. It
    ${preservationSentence}
    -->
  `.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
