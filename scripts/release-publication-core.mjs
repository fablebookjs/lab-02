import { parseProposalMessage, parseReleaseLine, parseStableVersion } from './release-proposal-core.mjs';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PILOT_REPOSITORY = 'fablebookjs/lab-02';
export const SETUP_NODE_AUTH_PLACEHOLDER = 'XXXXX-XXXXX-XXXXX-XXXXX';

export function assertOidcPublishEnvironment({ nodeAuthToken, npmToken }) {
  if (
    npmToken ||
    (nodeAuthToken && nodeAuthToken !== SETUP_NODE_AUTH_PLACEHOLDER)
  ) {
    throw new Error('Stable publication must use npm OIDC, not an ambient npm token.');
  }
}

const fullOid = (value, label) => {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const stableVersionOnLine = (version, line) => {
  const parsedVersion = parseStableVersion(version);
  const parsedLine = parseReleaseLine(line);
  if (parsedVersion.major !== parsedLine.major || parsedVersion.minor !== parsedLine.minor) {
    throw new Error(`${version} does not belong to release line ${line}.`);
  }
  return parsedVersion;
};

export function lineChannel(line) {
  const { major, minor } = parseReleaseLine(line);
  return `v-${major}.${minor}`;
}

export function deriveReleaseAuthority({ headCommit, mergeCommit, pull }) {
  if (!Number.isSafeInteger(pull?.number) || pull.number <= 0) {
    throw new Error('Release authority requires a positive pull request number.');
  }
  if (
    pull.state !== 'closed' ||
    pull.merged_at === null ||
    pull.base?.repo?.full_name !== PILOT_REPOSITORY ||
    pull.head?.repo?.full_name !== PILOT_REPOSITORY
  ) {
    throw new Error('Release authority must be a merged same-repository pull request.');
  }

  const line = pull.base.ref?.replace(/^releases\//, '');
  if (!line || pull.base.ref !== `releases/${line}` || pull.head.ref !== `staged/${line}`) {
    throw new Error('Release authority is not a canonical staged-to-release pull request.');
  }
  parseReleaseLine(line);

  const sourceOid = fullOid(pull.base.sha, 'Release source');
  const proposalOid = fullOid(pull.head.sha, 'Release proposal');
  const snapshotOid = fullOid(pull.merge_commit_sha, 'Release snapshot');
  if (headCommit?.sha !== proposalOid || mergeCommit?.sha !== snapshotOid) {
    throw new Error('GitHub commit observations do not match the release pull request.');
  }

  const proposal = parseProposalMessage(headCommit.message);
  stableVersionOnLine(proposal.version, line);
  if (proposal.line !== line || proposal.sourceOid !== sourceOid) {
    throw new Error('The merged proposal is not bound to the pull request release source.');
  }

  const parents = mergeCommit.parents?.map(({ sha }) => sha) ?? [];
  if (
    parents.length !== 2 ||
    parents[0] !== sourceOid ||
    parents[1] !== proposalOid ||
    mergeCommit.tree?.sha !== headCommit.tree?.sha
  ) {
    throw new Error('The authorized snapshot is not the exact merge of the reviewed proposal.');
  }

  return {
    channel: lineChannel(line),
    line,
    proposalOid,
    pullRequest: pull.number,
    snapshotOid,
    sourceOid,
    version: proposal.version,
  };
}

const packageVersion = (document, name, version) => {
  if (document === null) {
    return null;
  }
  if (document.name !== name || typeof document.versions !== 'object') {
    throw new Error(`npm returned contradictory metadata for ${name}.`);
  }
  const published = document.versions[version] ?? null;
  if (published !== null && (published.name !== name || published.version !== version)) {
    throw new Error(`npm returned contradictory metadata for ${name}@${version}.`);
  }
  return published;
};

export function publicationDisposition({ channel, document, integrity, name, version }) {
  stableVersionOnLine(version, channel.replace(/^v-/, 'v'));
  const exact = exactPublication({ document, integrity, name, version });
  if (!exact) {
    if (document?.['dist-tags']?.[channel] === version) {
      throw new Error(`${name} has ${channel} at an absent version ${version}.`);
    }
    return 'publish';
  }
  if (document['dist-tags']?.[channel] !== version) {
    throw new Error(`${name}@${version} exists but ${channel} points elsewhere.`);
  }
  return 'skip';
}

export function exactPublication({ document, integrity, name, version }) {
  parseStableVersion(version);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity ?? '')) {
    throw new Error(`Prepared integrity is invalid for ${name}@${version}.`);
  }
  const published = packageVersion(document, name, version);
  if (published === null) {
    return false;
  }
  if (published.dist?.integrity !== integrity) {
    throw new Error(`${name}@${version} exists with different package contents.`);
  }
  return true;
}

export function promotionDisposition({ document, name, version }) {
  parseStableVersion(version);
  const published = packageVersion(document, name, version);
  if (published === null || typeof published.dist?.integrity !== 'string') {
    throw new Error(`${name}@${version} is not a complete published package.`);
  }
  return document['dist-tags']?.latest === version ? 'skip' : 'update';
}
