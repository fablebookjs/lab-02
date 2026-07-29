import { parseReleaseLine, parseStableVersion } from './core.ts';
import {
  cleanReleaseTitle,
  deriveReleaseChanges,
  migrationRecordDirectory,
  normalizeReleaseChanges,
} from '../release-communication/records.ts';

const REPOSITORY = 'fablebookjs/lab-02';
const repositoryUrl = `https://github.com/${REPOSITORY}`;
const fullOidPattern = /^[0-9a-f]{40}$/;
const packageNamePattern = /^@fablebook\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taskPattern =
  /^- \[([ xX])\].*<!-- fablebook:(change|check)=([a-z0-9:.-]+) -->\s*$/gm;
const proposalIdentityPattern =
  /<!-- fablebook:proposal=([0-9a-f]{40}) source=([0-9a-f]{40}) version=([^ ]+) -->/g;
const placeholderPattern = /{{([a-z][a-z0-9_]*)}}/g;

export const RELEASE_PR_TEMPLATE_MARKER = '<!-- fablebook:release-pr=v6 -->';
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

export function extractReleasePrCheckboxes(body) {
  const states = new Map();
  for (const match of String(body ?? '').matchAll(taskPattern)) {
    const [, mark, kind, key] = match;
    const identity = `${kind}:${key}`;
    if (states.has(identity)) {
      throw new Error(`Release PR body repeats checkbox identity ${identity}.`);
    }
    states.set(identity, mark.toLowerCase() === 'x');
  }
  return states;
}

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
    throw new Error('Release PR body must contain exactly one marked highlights block.');
  }
  const start = source.indexOf(RELEASE_HIGHLIGHTS_START) + RELEASE_HIGHLIGHTS_START.length;
  const end = source.indexOf(RELEASE_HIGHLIGHTS_END, start);
  if (end < start) {
    throw new Error('Release PR highlights markers are out of order.');
  }
  const highlights = source.slice(start, end).trim();
  if (highlights.length === 0) {
    throw new Error('Release PR highlights are empty.');
  }
  return highlights;
}

export function validateReleaseHighlights(highlights) {
  if (typeof highlights !== 'string' || highlights.trim() !== highlights) {
    throw new Error('Release highlights must be trimmed Markdown text.');
  }
  const visibleHighlights = highlights
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (
    highlights.includes(RELEASE_HIGHLIGHTS_EMPTY_MARKER) ||
    visibleHighlights.length === 0
  ) {
    throw new Error('Release highlights must replace the blocking empty placeholder.');
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
    throw new Error('Release highlight predecessors must be an array.');
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

const validateChanges = (changes, states) => {
  return normalizeReleaseChanges(changes).map((change) => ({
    ...change,
    checkmark: states.get(`change:${change.key}`) ? 'x' : ' ',
  }));
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
        .map(
          ({ checkmark, key, url }) =>
            `- [${checkmark}] ${url} <!-- fablebook:change=${key} -->`
        )
        .join('\n');

const renderMigrationRecords = (records, line, releaseOid) => {
  if (!Array.isArray(records)) {
    throw new Error('Release PR migration records must be an array.');
  }
  if (records.length === 0) {
    return '_No migration records target this release line._';
  }
  const directory = migrationRecordDirectory(line);
  const filenames = new Set();
  return records
    .map((record) => {
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
    })
    .join('\n');
};

const renderTemplate = (template, view) => {
  const used = new Set();
  const rendered = template.replace(placeholderPattern, (_, name) => {
    if (!Object.hasOwn(view, name)) {
      throw new Error(`Release PR template uses unknown placeholder {{${name}}}.`);
    }
    used.add(name);
    return String(view[name]);
  });
  const unused = Object.keys(view).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`Release PR template omits placeholders: ${unused.join(', ')}.`);
  }
  return rendered;
};

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
  template: string;
  version: string;
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
  template,
  version,
}: RenderReleasePrBodyOptions) {
  const parsedLine = parseReleaseLine(line);
  const parsedVersion = parseStableVersion(version);
  if (parsedLine.major !== parsedVersion.major || parsedLine.minor !== parsedVersion.minor) {
    throw new Error(`${version} does not belong to release line ${line}.`);
  }
  fullOid(releaseOid, 'Release PR source');
  fullOid(proposalOid, 'Release PR proposal');
  if (typeof template !== 'string' || !template.includes(RELEASE_PR_TEMPLATE_MARKER)) {
    throw new Error('Release PR template is missing its canonical marker.');
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
  const renderedChanges = validateChanges(changes, states);
  const releaseHighlights = [
    RELEASE_HIGHLIGHTS_START,
    recoverReleaseHighlights(previousHighlightsBody),
    RELEASE_HIGHLIGHTS_END,
  ].join('\n');
  const channel = `v-${line.slice(1)}`;
  const npmVersionsUrl = `https://www.npmjs.com/package/${uniquePackages[0]}?activeTab=versions`;
  const view = {
    changes: renderChanges(renderedChanges),
    discussions_checkmark: states.get('check:discussions-resolved') ? 'x' : ' ',
    github_release_url: `${repositoryUrl}/releases/tag/v${version}`,
    line,
    main_branch_url: `${repositoryUrl}/tree/main`,
    migration_records: renderMigrationRecords(migrationRecords, line, releaseOid),
    npm_channel: channel,
    npm_versions_url: npmVersionsUrl,
    package_count: uniquePackages.length,
    patchback_log_url: `${repositoryUrl}/actions/workflows/maintain-patchback.yml`,
    promote_latest_url: `${repositoryUrl}/actions/workflows/promote-latest.yml`,
    proposal_branch_url: `${repositoryUrl}/tree/staged/${line}`,
    proposal_commit_url: `${repositoryUrl}/commit/${proposalOid}`,
    proposal_oid: proposalOid,
    proposal_short_oid: proposalOid.slice(0, 7),
    publish_log_url: `${repositoryUrl}/actions/workflows/publish-stable-release.yml`,
    release_branch_url: `${repositoryUrl}/tree/releases/${line}`,
    release_commit_url: `${repositoryUrl}/commit/${releaseOid}`,
    release_oid: releaseOid,
    release_docs_checkmark: states.get('check:release-docs-reviewed') ? 'x' : ' ',
    release_highlights: releaseHighlights,
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
  return `${renderTemplate(template, view).trim()}\n`;
}
