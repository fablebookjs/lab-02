import { parseProposalMessage, parseReleaseLine, parseStableVersion } from './release-proposal-core.mjs';
import {
  cleanReleaseTitle,
  migrationRecordDirectory,
  parseReleaseRecordChanges,
} from './release-communication.mjs';
import {
  extractReleasePrIdentity,
  requireReleaseHighlights,
  RELEASE_HIGHLIGHTS_END,
  RELEASE_HIGHLIGHTS_START,
  validateReleasePrBody,
} from './release-pr-body.mjs';
import { renderMarkdownTemplate } from './release-template.mjs';

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

export function deriveReleaseHighlights({ authority, body }) {
  const identity = extractReleasePrIdentity(body);
  if (
    identity === null ||
    identity.proposalOid !== authority.proposalOid ||
    identity.releaseOid !== authority.sourceOid ||
    identity.version !== authority.version
  ) {
    throw new Error('Release highlights are not bound to the authorized proposal.');
  }
  return requireReleaseHighlights(body);
}

const normalizeCommunicationChanges = (changes) => {
  if (!Array.isArray(changes)) {
    throw new Error('Release communication changes must be an array.');
  }
  const identities = new Set();
  return changes.map((change) => {
    if (
      !/^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/.test(change?.key ?? '') ||
      identities.has(change.key) ||
      typeof change.qaSkip !== 'boolean' ||
      typeof change.releaseNoteSkip !== 'boolean' ||
      cleanReleaseTitle(change.title, '') !== change.title
    ) {
      throw new Error(`Invalid release communication change: ${change?.key}`);
    }
    const url = change.key.startsWith('pr:')
      ? `https://github.com/${PILOT_REPOSITORY}/pull/${change.key.slice(3)}`
      : `https://github.com/${PILOT_REPOSITORY}/commit/${change.key.slice(7)}`;
    if (
      change.url !== url ||
      (change.key.startsWith('commit:') &&
        (change.qaSkip || change.releaseNoteSkip))
    ) {
      throw new Error(`Contradictory release communication change: ${change.key}`);
    }
    identities.add(change.key);
    return {
      key: change.key,
      qaSkip: change.qaSkip,
      releaseNoteSkip: change.releaseNoteSkip,
      title: change.title,
      url,
    };
  });
};

export function validateReleaseCommunication(communication, version) {
  const { patch } = parseStableVersion(version);
  if (
    communication === null ||
    typeof communication !== 'object' ||
    Array.isArray(communication) ||
    !['initial', 'maintenance', 'patch'].includes(communication.kind)
  ) {
    throw new Error('Release communication is outside the accepted schema.');
  }
  const changes = normalizeCommunicationChanges(communication.changes);
  const publicChanges = changes.filter(({ releaseNoteSkip }) => !releaseNoteSkip);
  const expectedKind =
    patch === 0 ? 'initial' : publicChanges.length === 0 ? 'maintenance' : 'patch';
  if (communication.kind !== expectedKind) {
    throw new Error(`${version} has contradictory ${communication.kind} communication.`);
  }
  if (expectedKind === 'initial' && typeof communication.whyUpgrade !== 'string') {
    throw new Error(`${version} initial communication requires Why upgrade content.`);
  }
  const whyUpgrade =
    expectedKind === 'initial'
      ? requireReleaseHighlights(
          `${RELEASE_HIGHLIGHTS_START}\n${communication.whyUpgrade}\n${RELEASE_HIGHLIGHTS_END}`
        )
      : null;
  if (expectedKind !== 'initial' && communication.whyUpgrade !== null) {
    throw new Error(`${version} patch communication cannot contain Why upgrade content.`);
  }
  return { changes, kind: expectedKind, whyUpgrade };
}

export function deriveReleaseCommunication({ authority, body }) {
  const identity = extractReleasePrIdentity(body);
  if (
    identity === null ||
    identity.proposalOid !== authority.proposalOid ||
    identity.releaseOid !== authority.sourceOid ||
    identity.version !== authority.version
  ) {
    throw new Error('Release communication is not bound to the authorized proposal.');
  }
  const rendered = validateReleasePrBody({
    body,
    requireAttestations: true,
    version: authority.version,
  });
  const publicChanges = rendered.changes.filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip
  );
  return validateReleaseCommunication(
    {
      changes: rendered.changes.map(
        ({ key, qaSkip, releaseNoteSkip, title, url }) => ({
          key,
          qaSkip,
          releaseNoteSkip,
          title,
          url,
        })
      ),
      kind:
        rendered.kind === 'initial'
          ? 'initial'
          : publicChanges.length === 0
            ? 'maintenance'
            : 'patch',
      whyUpgrade: rendered.whyUpgrade,
    },
    authority.version
  );
}

const renderMigrationSection = (records, version) => {
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
      cleanReleaseTitle(record.title, record.filename.replace(/\.md$/, '')) !== record.title ||
      filenames.has(record.filename)
    ) {
      throw new Error(`Invalid GitHub Release migration record: ${record?.filename}`);
    }
    filenames.add(record.filename);
    const url = `https://github.com/${PILOT_REPOSITORY}/blob/v${version}/${directory}/${record.filename}`;
    return `- [${record.title}](${url})`;
  });
  return links.length === 0
    ? ''
    : `\n\n## Migrations\n\n${links.join('\n')}`;
};

export function composeGitHubReleaseBody({
  communication,
  migrationRecords = [],
  releaseRecord,
  templates,
  version,
}) {
  const normalized = validateReleaseCommunication(communication, version);
  const recordChanges = parseReleaseRecordChanges({
    source: releaseRecord,
    version,
  });
  if (
    JSON.stringify(
      normalized.changes.map(({ title, url }) => ({ title, url }))
    ) !== JSON.stringify(recordChanges)
  ) {
    throw new Error(
      `Generated v${version} release record contradicts its authorized communication.`
    );
  }
  if (
    templates === null ||
    typeof templates !== 'object' ||
    Array.isArray(templates)
  ) {
    throw new Error('GitHub Release templates are missing.');
  }

  const publicChanges = normalized.changes.filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip
  );
  const renderedChanges = publicChanges
    .map(({ title, url }) => `- [${title}](${url})`)
    .join('\n');
  const migrationSection = renderMigrationSection(migrationRecords, version);
  let view;
  if (normalized.kind === 'initial') {
    view = {
      migration_section: migrationSection,
      noteworthy_changes_section:
        renderedChanges.length === 0
          ? ''
          : `\n\n## Noteworthy changes\n\n${renderedChanges}`,
      version,
      why_upgrade: normalized.whyUpgrade,
    };
  } else if (normalized.kind === 'patch') {
    view = {
      migration_section: migrationSection,
      public_changes: renderedChanges,
      version,
    };
  } else {
    view = {
      migration_section: migrationSection,
      version,
    };
  }
  return renderMarkdownTemplate({
    label: `GitHub Release ${normalized.kind} template`,
    template: templates[normalized.kind],
    view,
  });
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
