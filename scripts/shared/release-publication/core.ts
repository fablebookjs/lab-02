import {
  parseProposalMessage,
  parseReleaseLine,
  parseStableVersion,
} from '../release-proposal/core.ts';
import {
  cleanReleaseTitle,
  migrationRecordDirectory,
  parseReleaseRecordChanges,
} from '../release-communication/records.ts';
import {
  extractReleasePrIdentity,
  requireReleaseHighlights,
  RELEASE_HIGHLIGHTS_END,
  RELEASE_HIGHLIGHTS_START,
  validateReleasePrBody,
} from '../release-proposal/body.ts';
export const PILOT_REPOSITORY = 'fablebookjs/lab-02';

export type ReleaseAuthority = {
  channel: string;
  line: string;
  proposalOid: string;
  pullRequest: number;
  snapshotOid: string;
  sourceOid: string;
  version: string;
};

export type CommunicationChange = {
  key: string;
  qaSkip: boolean;
  releaseNoteSkip: boolean;
  title: string;
  url: string;
};

export type ReleaseCommunication = {
  changes: CommunicationChange[];
  kind: 'initial' | 'maintenance' | 'patch';
  releaseHighlights: string | null;
};

type GitCommit = {
  message?: string;
  parents?: Array<{ sha: string }>;
  sha: string;
  tree?: { sha: string };
};

type ReleasePull = {
  base: { ref: string; repo: { full_name: string }; sha: string };
  head: { ref: string; repo: { full_name: string }; sha: string };
  merge_commit_sha: string | null;
  merged_at: unknown;
  number: number;
  state: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const fullOid = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} is not a full commit OID.`);
  }
  return value;
};

const stableVersionOnLine = (version: string, line: string) => {
  const parsedVersion = parseStableVersion(version);
  const parsedLine = parseReleaseLine(line);
  if (parsedVersion.major !== parsedLine.major || parsedVersion.minor !== parsedLine.minor) {
    throw new Error(`${version} does not belong to release line ${line}.`);
  }
  return parsedVersion;
};

export function lineChannel(line: string): string {
  const { major, minor } = parseReleaseLine(line);
  return `v-${major}.${minor}`;
}

export function deriveReleaseAuthority({
  headCommit,
  mergeCommit,
  pull,
}: {
  headCommit: GitCommit;
  mergeCommit: GitCommit;
  pull: ReleasePull;
}): ReleaseAuthority {
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

  if (typeof headCommit.message !== 'string') {
    throw new Error('Release proposal commit has no commit message.');
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

export function deriveReleaseHighlights({
  authority,
  body,
}: {
  authority: ReleaseAuthority;
  body: unknown;
}): string {
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

const normalizeCommunicationChanges = (changes: unknown): CommunicationChange[] => {
  if (!Array.isArray(changes)) {
    throw new Error('Release communication changes must be an array.');
  }
  const identities = new Set();
  return changes.map((change) => {
    if (!isRecord(change)) {
      throw new Error('Release communication changes must contain objects.');
    }
    const key = change['key'];
    if (
      typeof key !== 'string' ||
      !/^(?:pr:[1-9]\d*|commit:[0-9a-f]{40})$/.test(key) ||
      identities.has(key) ||
      typeof change['qaSkip'] !== 'boolean' ||
      typeof change['releaseNoteSkip'] !== 'boolean' ||
      typeof change['title'] !== 'string' ||
      cleanReleaseTitle(change['title'], '') !== change['title']
    ) {
      throw new Error(`Invalid release communication change: ${String(key)}`);
    }
    const url = key.startsWith('pr:')
      ? `https://github.com/${PILOT_REPOSITORY}/pull/${key.slice(3)}`
      : `https://github.com/${PILOT_REPOSITORY}/commit/${key.slice(7)}`;
    if (
      change['url'] !== url ||
      (key.startsWith('commit:') &&
        (change['qaSkip'] || change['releaseNoteSkip']))
    ) {
      throw new Error(`Contradictory release communication change: ${key}`);
    }
    identities.add(key);
    return {
      key,
      qaSkip: change['qaSkip'],
      releaseNoteSkip: change['releaseNoteSkip'],
      title: change['title'],
      url,
    };
  });
};

export function validateReleaseCommunication(
  communication: unknown,
  version: string,
): ReleaseCommunication {
  const { patch } = parseStableVersion(version);
  if (
    communication === null ||
    typeof communication !== 'object' ||
    Array.isArray(communication) ||
    !isRecord(communication) ||
    !['initial', 'maintenance', 'patch'].includes(String(communication['kind']))
  ) {
    throw new Error('Release communication is outside the accepted schema.');
  }
  const changes = normalizeCommunicationChanges(communication['changes']);
  const publicChanges = changes.filter(({ releaseNoteSkip }) => !releaseNoteSkip);
  const expectedKind =
    patch === 0 ? 'initial' : publicChanges.length === 0 ? 'maintenance' : 'patch';
  if (communication['kind'] !== expectedKind) {
    throw new Error(`${version} has contradictory ${String(communication['kind'])} communication.`);
  }
  if (
    expectedKind === 'initial' &&
    typeof communication['releaseHighlights'] !== 'string'
  ) {
    throw new Error(`${version} initial communication requires release highlights.`);
  }
  const releaseHighlights =
    expectedKind === 'initial'
      ? requireReleaseHighlights(
          `${RELEASE_HIGHLIGHTS_START}\n${communication['releaseHighlights']}\n${RELEASE_HIGHLIGHTS_END}`
        )
      : null;
  if (
    expectedKind !== 'initial' &&
    communication['releaseHighlights'] !== null
  ) {
    throw new Error(`${version} patch communication cannot contain release highlights.`);
  }
  return { changes, kind: expectedKind, releaseHighlights };
}

export function deriveReleaseCommunication({
  authority,
  body,
}: {
  authority: ReleaseAuthority;
  body: unknown;
}): ReleaseCommunication {
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
      releaseHighlights: rendered.releaseHighlights,
    },
    authority.version
  );
}

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

type ComposeGitHubReleaseBodyOptions = {
  communication: unknown;
  migrationRecords?: Array<{ filename: string; title: string }>;
  releaseRecord: string;
  version: string;
};

export function composeGitHubReleaseBody({
  communication,
  migrationRecords = [],
  releaseRecord,
  version,
}: ComposeGitHubReleaseBodyOptions) {
  const normalized = validateReleaseCommunication(communication, version);
  const recordChanges = parseReleaseRecordChanges({
    source: releaseRecord,
    version,
  });
  const publicChanges = normalized.changes.filter(
    ({ releaseNoteSkip }) => !releaseNoteSkip
  );
  if (
    JSON.stringify(
      publicChanges.map(({ title, url }) => ({ title, url }))
    ) !== JSON.stringify(recordChanges)
  ) {
    throw new Error(
      `Generated v${version} release record contradicts its authorized communication.`
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
        : `\n\n## Noteworthy changes\n\n${renderedChanges}`;
    return `${title}\n\n## Release highlights\n\n${normalized.releaseHighlights}${noteworthyChanges}${migrationSection}\n`;
  }
  if (normalized.kind === 'patch') {
    return `${title}\n\n## What's changed\n\n${renderedChanges}${migrationSection}\n`;
  }
  return `${title}\n\nThis maintenance release contains no user-facing changes worth mentioning.${migrationSection}\n`;
}
