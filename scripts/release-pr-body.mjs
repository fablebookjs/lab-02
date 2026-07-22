import { parseReleaseLine, parseStableVersion } from './release-proposal-core.mjs';

const REPOSITORY = 'fablebookjs/lab-02';
const repositoryUrl = `https://github.com/${REPOSITORY}`;
const fullOidPattern = /^[0-9a-f]{40}$/;
const changeKeyPattern = /^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/;
const packageNamePattern = /^@fablebook\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taskPattern =
  /^- \[([ xX])\].*<!-- fablebook:(change|check)=([a-z0-9:.-]+) -->\s*$/gm;
const proposalIdentityPattern =
  /<!-- fablebook:proposal=([0-9a-f]{40}) source=([0-9a-f]{40}) version=([^ ]+) -->/g;
const placeholderPattern = /{{([a-z][a-z0-9_]*)}}/g;

export const RELEASE_PR_TEMPLATE_MARKER = '<!-- fablebook:release-pr=v2 -->';

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

const cleanTitle = (value, fallback) => {
  const title = String(value ?? '')
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (title || fallback).slice(0, 180);
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

export function extractReleasePrIdentity(body) {
  if (!String(body ?? '').includes(RELEASE_PR_TEMPLATE_MARKER)) {
    return null;
  }
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
}

const validateChanges = (changes, states) => {
  if (!Array.isArray(changes)) {
    throw new Error('Release PR changes must be an array.');
  }
  const identities = new Set();
  return changes.map((change) => {
    if (!changeKeyPattern.test(change?.key ?? '')) {
      throw new Error(`Release change has an invalid identity: ${change?.key}`);
    }
    if (identities.has(change.key)) {
      throw new Error(`Release changes repeat identity ${change.key}.`);
    }
    identities.add(change.key);
    fullOid(change.oid, `Release change ${change.key}`);
    if (change.key.startsWith('pr:')) {
      const pullRequest = Number.parseInt(change.key.slice(3), 10);
      positiveInteger(pullRequest, `Release change ${change.key} pull request`);
      if (change.url !== `${repositoryUrl}/pull/${pullRequest}`) {
        throw new Error(`Release change ${change.key} has a noncanonical pull request URL.`);
      }
    } else if (change.url !== `${repositoryUrl}/commit/${change.oid}`) {
      throw new Error(`Release change ${change.key} has a noncanonical commit URL.`);
    }
    return {
      ...change,
      checkmark: states.get(`change:${change.key}`) ? 'x' : ' ',
      title: cleanTitle(change.title, `Commit ${change.oid.slice(0, 12)}`),
    };
  });
};

const canonicalReleasePull = (pull, line, oid) =>
  Number.isSafeInteger(pull?.number) &&
  pull.number > 0 &&
  pull.merged_at !== null &&
  pull.base?.ref === `releases/${line}` &&
  pull.base?.repo?.full_name === REPOSITORY &&
  pull.merge_commit_sha === oid;

export function deriveReleasePrChanges({ commits, line }) {
  parseReleaseLine(line);
  if (!Array.isArray(commits)) {
    throw new Error('Release PR commits must be an array.');
  }
  return commits.map((commit) => {
    const oid = fullOid(commit?.oid, 'Release PR change');
    const associated = (commit.associatedPulls ?? []).filter((pull) =>
      canonicalReleasePull(pull, line, oid)
    );
    const pull = associated.length === 1 ? associated[0] : null;
    return pull
      ? {
          key: `pr:${pull.number}`,
          oid,
          title: pull.title,
          url: `${repositoryUrl}/pull/${pull.number}`,
        }
      : {
          key: `commit:${oid}`,
          oid,
          title: commit.subject,
          url: `${repositoryUrl}/commit/${oid}`,
        };
  });
}

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
          ({ checkmark, key, title, url }) =>
            `- [${checkmark}] [${title}](${url}) <!-- fablebook:change=${key} -->`
        )
        .join('\n');

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

export function renderReleasePrBody({
  changes,
  line,
  packageNames,
  previousBody = '',
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
  const channel = `v-${line.slice(1)}`;
  const npmVersionsUrl = `https://www.npmjs.com/package/${uniquePackages[0]}?activeTab=versions`;
  const view = {
    changelog_url: `${repositoryUrl}/blob/main/CHANGELOG.md`,
    changes: renderChanges(renderedChanges),
    discussions_checkmark: states.get('check:discussions-resolved') ? 'x' : ' ',
    github_release_url: `${repositoryUrl}/releases/tag/v${version}`,
    line,
    main_branch_url: `${repositoryUrl}/tree/main`,
    migration_url: `${repositoryUrl}/blob/main/MIGRATION.md`,
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
