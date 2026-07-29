import { parseReleaseLine, parseStableVersion } from './release-proposal-core.mjs';
import {
  cleanReleaseTitle,
  deriveReleaseChanges,
  migrationRecordDirectory,
  normalizeReleaseChanges,
} from './release-communication.mjs';
import { renderMarkdownTemplate } from './release-template.mjs';

const REPOSITORY = 'fablebookjs/lab-02';
const repositoryUrl = `https://github.com/${REPOSITORY}`;
const fullOidPattern = /^[0-9a-f]{40}$/;
const packageNamePattern = /^@fablebook\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const checkTaskPattern =
  /^- \[([ xX])\].*<!-- fablebook:check=([a-z0-9:.-]+) -->\s*$/gm;
const proposalIdentityPattern =
  /<!-- fablebook:proposal=([0-9a-f]{40}) source=([0-9a-f]{40}) version=([^ ]+) -->/g;
const releaseKindPattern = /<!-- fablebook:release-kind=(initial|patch) -->/g;
const changeTaskPattern =
  /^- \[([ xX])\] \[([^\]\r\n]+)\]\((https:\/\/github\.com\/fablebookjs\/lab-02\/(?:pull\/[1-9]\d*|commit\/[0-9a-f]{40}))\) — (.+) <!-- fablebook:change=(pr:[1-9]\d*|commit:[0-9a-f]{40}) release-note=(include|skip) qa=(required|skip) -->\s*$/gm;

export const RELEASE_PR_TEMPLATE_MARKER = '<!-- fablebook:release-pr=v7 -->';
export const RELEASE_HIGHLIGHTS_START = '<!-- fablebook:release-highlights:start -->';
export const RELEASE_HIGHLIGHTS_END = '<!-- fablebook:release-highlights:end -->';
export const RELEASE_HIGHLIGHTS_EMPTY_MARKER =
  '<!-- fablebook:release-highlights=empty -->';
export const EMPTY_RELEASE_HIGHLIGHTS =
  `- [ ] Replace this placeholder with the main reasons to upgrade. ${RELEASE_HIGHLIGHTS_EMPTY_MARKER}`;

const fullOid = (value, label) => {
  if (!fullOidPattern.test(value ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not one positive integer.`);
  }
  return value;
};

const canonicalChangeUrl = (key) =>
  key.startsWith('pr:')
    ? `${repositoryUrl}/pull/${key.slice(3)}`
    : `${repositoryUrl}/commit/${key.slice(7)}`;

const extractProposalIdentity = (body) => {
  const matches = [...String(body ?? '').matchAll(proposalIdentityPattern)];
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    throw new Error('Release PR body repeats its proposal identity marker.');
  }
  parseStableVersion(matches[0][3]);
  return {
    proposalOid: matches[0][1],
    releaseOid: matches[0][2],
    version: matches[0][3],
  };
};

const extractReleaseKind = (body) => {
  const matches = [...String(body ?? '').matchAll(releaseKindPattern)];
  if (matches.length !== 1) {
    throw new Error('Release PR body must contain one release-kind marker.');
  }
  return matches[0][1];
};

export function extractReleasePrIdentity(body) {
  if (!String(body ?? '').includes(RELEASE_PR_TEMPLATE_MARKER)) {
    return null;
  }
  return extractProposalIdentity(body);
}

export function extractReleaseHighlights(body) {
  const source = String(body ?? '');
  const starts = source.split(RELEASE_HIGHLIGHTS_START).length - 1;
  const ends = source.split(RELEASE_HIGHLIGHTS_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error('Release PR body must contain exactly one marked Why upgrade block.');
  }
  const start = source.indexOf(RELEASE_HIGHLIGHTS_START) + RELEASE_HIGHLIGHTS_START.length;
  const end = source.indexOf(RELEASE_HIGHLIGHTS_END, start);
  if (end < start) {
    throw new Error('Release PR Why upgrade markers are out of order.');
  }
  const highlights = source.slice(start, end).trim();
  if (highlights.length === 0) {
    throw new Error('Release PR Why upgrade content is empty.');
  }
  return highlights;
}

export function validateReleaseHighlights(highlights) {
  if (typeof highlights !== 'string' || highlights.trim() !== highlights) {
    throw new Error('Why upgrade content must be trimmed Markdown text.');
  }
  const visibleHighlights = highlights
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (
    highlights.includes(RELEASE_HIGHLIGHTS_EMPTY_MARKER) ||
    visibleHighlights.length === 0
  ) {
    throw new Error('Why upgrade content must replace the blocking empty placeholder.');
  }
  return highlights;
}

export function requireReleaseHighlights(body) {
  return validateReleaseHighlights(extractReleaseHighlights(body));
}

export function recoverReleaseHighlights(body) {
  try {
    return requireReleaseHighlights(body);
  } catch {
    return EMPTY_RELEASE_HIGHLIGHTS;
  }
}

export function selectLatestMatchingReleasePrBody({ pulls, version }) {
  parseStableVersion(version);
  if (!Array.isArray(pulls)) {
    throw new Error('Why upgrade predecessors must be an array.');
  }
  return (
    [...pulls]
      .filter(
        (pull) =>
          Number.isSafeInteger(pull?.number) &&
          pull.number > 0 &&
          pull.state === 'closed'
      )
      .sort((left, right) => right.number - left.number)
      .find((pull) => {
        try {
          return extractProposalIdentity(pull.body)?.version === version;
        } catch {
          return false;
        }
      })?.body ?? ''
  );
}

export function extractReleasePrChanges(body) {
  const source = String(body ?? '');
  const changes = [];
  const identities = new Set();
  for (const match of source.matchAll(changeTaskPattern)) {
    const [, mark, title, url, description, key, releaseNote, qa] = match;
    if (
      identities.has(key) ||
      url !== canonicalChangeUrl(key) ||
      cleanReleaseTitle(title, '') !== title ||
      (key.startsWith('commit:') && (releaseNote !== 'include' || qa !== 'required')) ||
      (qa === 'skip' &&
        (mark.toLowerCase() !== 'x' ||
          !description.includes('No manual QA required (`qa:skip`)'))) ||
      (releaseNote === 'skip' &&
        !description.includes('Not included in public release notes (`release-note:skip`)'))
    ) {
      throw new Error(`Release PR change ${key} has contradictory generated metadata.`);
    }
    identities.add(key);
    changes.push({
      checked: mark.toLowerCase() === 'x',
      key,
      qaSkip: qa === 'skip',
      releaseNoteSkip: releaseNote === 'skip',
      title,
      url,
    });
  }

  const markers = source.split('<!-- fablebook:change=').length - 1;
  if (markers !== changes.length) {
    throw new Error('Release PR body contains malformed change metadata.');
  }
  return changes;
}

export function extractReleasePrCheckboxes(body) {
  const states = new Map();
  for (const match of String(body ?? '').matchAll(checkTaskPattern)) {
    const [, mark, key] = match;
    const identity = `check:${key}`;
    if (states.has(identity)) {
      throw new Error(`Release PR body repeats checkbox identity ${identity}.`);
    }
    states.set(identity, mark.toLowerCase() === 'x');
  }
  for (const change of extractReleasePrChanges(body)) {
    const identity = `change:${change.key}`;
    if (states.has(identity)) {
      throw new Error(`Release PR body repeats checkbox identity ${identity}.`);
    }
    states.set(identity, change.checked);
  }
  return states;
}

const validateChanges = (changes, previousBody) => {
  const previous = new Map(
    extractReleasePrChanges(previousBody).map((change) => [change.key, change])
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

export const deriveReleasePrChanges = deriveReleaseChanges;

const smokeCommands = (packageNames, channel) => {
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

const renderChanges = (changes) =>
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
              'Not included in public release notes (`release-note:skip`).'
            );
          }
          const releaseNote = change.releaseNoteSkip ? 'skip' : 'include';
          const qa = change.qaSkip ? 'skip' : 'required';
          return `- [${change.checkmark}] [${change.title}](${change.url}) — ${descriptions.join(' ')} <!-- fablebook:change=${change.key} release-note=${releaseNote} qa=${qa} -->`;
        })
        .join('\n');

const renderMigrationSection = (records, line, releaseOid) => {
  if (!Array.isArray(records)) {
    throw new Error('Release PR migration records must be an array.');
  }
  if (records.length === 0) {
    return '';
  }
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

export function validateReleasePrBody({
  body,
  requireAttestations = false,
  version,
}) {
  const parsed = parseStableVersion(version);
  const expectedKind = parsed.patch === 0 ? 'initial' : 'patch';
  const identity = extractReleasePrIdentity(body);
  if (identity === null || identity.version !== version) {
    throw new Error('Release PR body is not the generated template for this version.');
  }
  const kind = extractReleaseKind(body);
  if (kind !== expectedKind) {
    throw new Error(`Release PR body uses ${kind} communication for ${version}.`);
  }
  const whyUpgrade =
    kind === 'initial'
      ? requireReleaseHighlights(body)
      : null;
  if (
    kind === 'patch' &&
    (String(body).includes(RELEASE_HIGHLIGHTS_START) ||
      String(body).includes(RELEASE_HIGHLIGHTS_END))
  ) {
    throw new Error('Patch release PR must not contain a Why upgrade block.');
  }
  const checks = extractReleasePrCheckboxes(body);
  for (const key of ['source-metadata-current', 'release-docs-reviewed']) {
    if (!checks.has(`check:${key}`)) {
      throw new Error(`Release PR body is missing required check ${key}.`);
    }
    if (requireAttestations && checks.get(`check:${key}`) !== true) {
      throw new Error(`Release PR body has not satisfied required check ${key}.`);
    }
  }
  return {
    changes: extractReleasePrChanges(body),
    kind,
    whyUpgrade,
  };
}

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
  template,
  version,
}) {
  const parsedLine = parseReleaseLine(line);
  const parsedVersion = parseStableVersion(version);
  if (parsedLine.major !== parsedVersion.major || parsedLine.minor !== parsedVersion.minor) {
    throw new Error(`${version} does not belong to release line ${line}.`);
  }
  fullOid(releaseOid, 'Release PR source');
  fullOid(proposalOid, 'Release PR proposal');
  const kind = parsedVersion.patch === 0 ? 'initial' : 'patch';
  if (
    typeof template !== 'string' ||
    !template.includes(RELEASE_PR_TEMPLATE_MARKER) ||
    !template.includes(`<!-- fablebook:release-kind=${kind} -->`)
  ) {
    throw new Error(`Release PR ${kind} template is missing its canonical markers.`);
  }
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
  const view = {
    changes: renderChanges(validateChanges(changes, previousBody)),
    discussions_checkmark: states.get('check:discussions-resolved') ? 'x' : ' ',
    github_release_url: `${repositoryUrl}/releases/tag/v${version}`,
    line,
    migration_section: renderMigrationSection(migrationRecords, line, releaseOid),
    npm_channel: channel,
    npm_versions_url: npmVersionsUrl,
    package_count: uniquePackages.length,
    patchback_log_url:
      `${repositoryUrl}/actions/workflows/maintain-patchback.yml`,
    promote_latest_url:
      `${repositoryUrl}/actions/workflows/promote-latest.yml`,
    proposal_branch_url: `${repositoryUrl}/tree/staged/${line}`,
    proposal_commit_url: `${repositoryUrl}/commit/${proposalOid}`,
    proposal_oid: proposalOid,
    proposal_short_oid: proposalOid.slice(0, 7),
    publish_log_url:
      `${repositoryUrl}/actions/workflows/publish-stable-release.yml`,
    release_branch_url: `${repositoryUrl}/tree/releases/${line}`,
    release_commit_url: `${repositoryUrl}/commit/${releaseOid}`,
    release_oid: releaseOid,
    release_short_oid: releaseOid.slice(0, 7),
    smoke_test_commands: smokeCommands(uniquePackages, channel),
    superseded_notice:
      supersededPr === undefined
        ? ''
        : [
            '---',
            '',
            `This clean proposal supersedes [#${supersededPr}](${repositoryUrl}/pull/${supersededPr}).`,
          ].join('\n'),
    version,
  };
  if (kind === 'initial') {
    view.why_upgrade = [
      RELEASE_HIGHLIGHTS_START,
      recoverReleaseHighlights(previousHighlightsBody),
      RELEASE_HIGHLIGHTS_END,
    ].join('\n');
  }
  return renderMarkdownTemplate({
    label: `Release PR ${kind} template`,
    template,
    view,
  });
}
