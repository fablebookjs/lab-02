export type Phase = 'alpha' | 'beta' | 'rc';

export type Migration = {
  filename: string;
  title: string;
};

export type Change = {
  id: string;
  migration: Migration | null;
  releaseNoteSkip: boolean;
  title: string;
  url: string;
};

export type PrereleaseProposal = {
  changeIds: string[];
  draft: boolean;
  version: string;
};

export type PublishedPrerelease = {
  body: string;
  changeIds: string[];
  version: string;
};

export type PublishedStableRelease = {
  fileBody: string;
  filePath: string;
  githubBody: string;
  version: string;
};

export type ReleaseLine = {
  developmentChanges: Change[];
  fixes: Change[];
  highlights: string;
  line: string;
  published: PublishedStableRelease | null;
  releasePrOpen: boolean;
  version: string;
};

export type PrototypeState = {
  authorizedChangeCount: number;
  currentChanges: Change[];
  currentPhase: Phase;
  currentPrereleaseNumber: number;
  currentSeries: {
    major: number;
    minor: number;
  };
  lastEvent: string;
  mainRevision: number;
  nextChangeNumber: number;
  npmNext: string;
  prereleaseProposal: PrereleaseProposal | null;
  prereleases: PublishedPrerelease[];
  releaseLine: ReleaseLine | null;
};

export type PrototypeAction =
  | { type: 'edit-latest-prerelease-release' }
  | { type: 'enter-phase'; phase: 'beta' | 'rc' }
  | { type: 'land-main-change'; kind: 'migration' | 'skip' | 'visible' }
  | { type: 'land-release-fix'; releaseNoteSkip: boolean }
  | { type: 'mark-prerelease-ready' }
  | { type: 'merge-prerelease-proposal' }
  | { type: 'publish-stable' }
  | { type: 'release-cut' }
  | { type: 'reset' }
  | { type: 'run-demo' };

const phaseOrder: Record<Phase, number> = {
  alpha: 0,
  beta: 1,
  rc: 2,
};

const currentVersion = (state: PrototypeState): string =>
  `${state.currentSeries.major}.${state.currentSeries.minor}.0-${state.currentPhase}.${state.currentPrereleaseNumber}`;

const nextOrdinaryVersion = (state: PrototypeState): string =>
  `${state.currentSeries.major}.${state.currentSeries.minor}.0-${state.currentPhase}.${state.currentPrereleaseNumber + 1}`;

const publicChanges = (changes: readonly Change[]): Change[] =>
  changes.filter(({ releaseNoteSkip }) => !releaseNoteSkip);

const markdownChanges = (changes: readonly Change[]): string =>
  changes.length === 0
    ? 'This release contains no user-facing changes worth mentioning.'
    : changes.map(({ title, url }) => `- [${title}](${url})`).join('\n');

export const renderPrereleaseRelease = (
  version: string,
  changes: readonly Change[],
): string =>
  [
    `# Lab-02 ${version}`,
    '',
    `## What's changed`,
    '',
    markdownChanges(publicChanges(changes)),
  ].join('\n');

const migrationRecords = (changes: readonly Change[]): Migration[] =>
  changes.flatMap(({ migration }) => (migration === null ? [] : [migration]));

const allReleaseLineChanges = (line: ReleaseLine): Change[] => [
  ...line.developmentChanges,
  ...line.fixes,
];

const accountingChange = (change: Change): string => {
  const annotations = [
    change.releaseNoteSkip ? '`release-note:skip`' : null,
    change.migration === null ? null : `migration: \`${change.migration.filename}\``,
  ].filter((annotation): annotation is string => annotation !== null);
  const suffix = annotations.length === 0 ? '' : ` — ${annotations.join(', ')}`;
  return `- [${change.title}](${change.url})${suffix}`;
};

export const renderPrereleasePr = (state: PrototypeState): string | null => {
  const proposal = state.prereleaseProposal;
  if (proposal === null) return null;
  const byId = new Map(state.currentChanges.map((change) => [change.id, change]));
  const changes = proposal.changeIds.map((id) => {
    const change = byId.get(id);
    if (change === undefined) throw new Error(`Missing prototype change ${id}.`);
    return change;
  });
  return [
    `# Prerelease ${proposal.version}`,
    '',
    proposal.draft ? '**Draft**' : '**Ready to merge**',
    '',
    '## All changes in this prerelease scope',
    '',
    ...changes.map(accountingChange),
    '',
    '_No QA checklist. Merging authorizes this exact snapshot._',
  ].join('\n');
};

export const renderStableReleasePr = (line: ReleaseLine): string => {
  const changes = allReleaseLineChanges(line);
  const migrations = migrationRecords(changes);
  const checkmark = line.releasePrOpen ? ' ' : 'x';
  return [
    `# Release ${line.version}`,
    '',
    '## Release highlights',
    '',
    line.highlights,
    '',
    '## Complete accounting',
    '',
    ...changes.map(
      (change) => `- [${checkmark}] ${accountingChange(change).slice(2)}`,
    ),
    '',
    '## Migration records',
    '',
    ...(migrations.length === 0
      ? ['No migration records belong to this line.']
      : migrations.map(
          ({ filename, title }) => `- [${title}](migrations/${line.line}/${filename})`,
        )),
  ].join('\n');
};

export const renderStableReleaseFile = (line: ReleaseLine): string => {
  const changes = publicChanges(allReleaseLineChanges(line));
  return [
    `# v${line.version} changes`,
    '',
    markdownChanges(changes),
    '',
  ].join('\n');
};

export const renderStableGitHubRelease = (line: ReleaseLine): string => {
  const changes = allReleaseLineChanges(line);
  const migrations = migrationRecords(changes);
  return [
    `# Lab-02 ${line.version}`,
    '',
    '## Release highlights',
    '',
    line.highlights,
    '',
    `## What's changed`,
    '',
    markdownChanges(publicChanges(changes)),
    '',
    '## Migrations',
    '',
    ...(migrations.length === 0
      ? ['No migrations are required for this release.']
      : migrations.map(({ title }) => `- ${title}`)),
  ].join('\n');
};

export const createInitialState = (): PrototypeState => {
  const version = '3.1.0-alpha.0';
  return {
    authorizedChangeCount: 0,
    currentChanges: [],
    currentPhase: 'alpha',
    currentPrereleaseNumber: 0,
    currentSeries: { major: 3, minor: 1 },
    lastEvent: `${version} is already published as this development line's bootstrap prerelease.`,
    mainRevision: 1,
    nextChangeNumber: 201,
    npmNext: version,
    prereleaseProposal: null,
    prereleases: [
      {
        body: renderPrereleaseRelease(version, []),
        changeIds: [],
        version,
      },
    ],
    releaseLine: null,
  };
};

const copyState = (state: PrototypeState): PrototypeState =>
  structuredClone(state);

const createChange = (
  state: PrototypeState,
  {
    migration,
    releaseNoteSkip,
    title,
  }: {
    migration: boolean;
    releaseNoteSkip: boolean;
    title: string;
  },
): Change => {
  const number = state.nextChangeNumber;
  state.nextChangeNumber += 1;
  return {
    id: `pr:${number}`,
    migration: migration
      ? {
          filename: `rename-story-layout-option-${number}.md`,
          title: 'Rename the story layout option',
        }
      : null,
    releaseNoteSkip,
    title,
    url: `https://github.com/fablebookjs/lab-02/pull/${number}`,
  };
};

const reconcilePrereleaseProposal = (state: PrototypeState): void => {
  const scope = state.currentChanges.slice(state.authorizedChangeCount);
  if (scope.length === 0) {
    state.prereleaseProposal = null;
    return;
  }
  const previousDraft = state.prereleaseProposal?.draft;
  state.prereleaseProposal = {
    changeIds: scope.map(({ id }) => id),
    draft: previousDraft ?? true,
    version: nextOrdinaryVersion(state),
  };
};

const publishPrerelease = (
  state: PrototypeState,
  version: string,
  changes: readonly Change[],
): void => {
  state.prereleases.push({
    body: renderPrereleaseRelease(version, changes),
    changeIds: changes.map(({ id }) => id),
    version,
  });
  state.npmNext = version;
};

const landMainChange = (
  state: PrototypeState,
  kind: 'migration' | 'skip' | 'visible',
): PrototypeState => {
  const next = copyState(state);
  const definitions = {
    migration: {
      migration: true,
      releaseNoteSkip: false,
      title: 'Rename the story layout option',
    },
    skip: {
      migration: false,
      releaseNoteSkip: true,
      title: 'Refactor internal release diagnostics',
    },
    visible: {
      migration: false,
      releaseNoteSkip: false,
      title:
        next.currentSeries.minor === 1
          ? 'Add chapter navigation'
          : 'Prepare the next development feature',
    },
  } as const;
  const change = createChange(next, definitions[kind]);
  next.currentChanges.push(change);
  next.mainRevision += 1;
  reconcilePrereleaseProposal(next);
  next.lastEvent =
    `Merged ${change.id} to main. The existing Prerelease PR was ` +
    `${next.prereleaseProposal?.draft === true ? 'created/refreshed as a draft' : 'refreshed without losing ready state'}.`;
  return next;
};

const enterPhase = (
  state: PrototypeState,
  target: 'beta' | 'rc',
): PrototypeState => {
  const next = copyState(state);
  if (phaseOrder[target] < phaseOrder[next.currentPhase]) {
    next.lastEvent = `Rejected ${target}.0 because phase advancement never moves backward.`;
    return next;
  }
  if (phaseOrder[target] === phaseOrder[next.currentPhase]) {
    next.lastEvent = `${target}.0 was already established; this phase-entry job is visibly skipped.`;
    return next;
  }
  const scopedChanges = next.currentChanges.slice(next.authorizedChangeCount);
  const discarded = next.prereleaseProposal?.version ?? null;
  next.currentPhase = target;
  next.currentPrereleaseNumber = 0;
  next.authorizedChangeCount = next.currentChanges.length;
  next.prereleaseProposal = null;
  next.mainRevision += 1;
  const version = currentVersion(next);
  publishPrerelease(next, version, scopedChanges);
  next.lastEvent =
    `A maintainer directly committed and published ${version}` +
    `${discarded === null ? '' : `, discarding the ${discarded} Prerelease PR`}.`;
  return next;
};

const releaseCut = (state: PrototypeState): PrototypeState => {
  const next = copyState(state);
  if (next.releaseLine !== null) {
    next.lastEvent = 'This focused prototype models one release cut at a time.';
    return next;
  }
  const oldSeries = next.currentSeries;
  const stableVersion = `${oldSeries.major}.${oldSeries.minor}.0`;
  const line = `v${oldSeries.major}.${oldSeries.minor}`;
  const discarded = next.prereleaseProposal?.version ?? null;
  next.releaseLine = {
    developmentChanges: structuredClone(next.currentChanges),
    fixes: [],
    highlights: 'A coherent navigation release with a clearer story-layout API.',
    line,
    published: null,
    releasePrOpen: true,
    version: stableVersion,
  };

  next.currentSeries = {
    major: oldSeries.major,
    minor: oldSeries.minor + 1,
  };
  next.currentPhase = 'alpha';
  next.currentPrereleaseNumber = 0;
  next.currentChanges = [];
  next.authorizedChangeCount = 0;
  next.prereleaseProposal = null;
  next.mainRevision += 1;
  const bootstrapVersion = currentVersion(next);
  publishPrerelease(next, bootstrapVersion, []);
  next.lastEvent =
    `Cut ${line}: independently opened the ${stableVersion} Release PR and directly committed/published ` +
    `${bootstrapVersion} on main${discarded === null ? '' : `, discarding ${discarded}`}.`;
  return next;
};

const landReleaseFix = (
  state: PrototypeState,
  releaseNoteSkip: boolean,
): PrototypeState => {
  const next = copyState(state);
  const line = next.releaseLine;
  if (line === null) {
    next.lastEvent = 'No release line exists yet; cut one before landing a release-line fix.';
    return next;
  }
  if (!line.releasePrOpen) {
    next.lastEvent = 'The initial stable snapshot is already authorized in this prototype.';
    return next;
  }
  const change = createChange(next, {
    migration: false,
    releaseNoteSkip,
    title: releaseNoteSkip
      ? 'Adjust release-line diagnostics'
      : 'Fix the release-line rendering regression',
  });
  line.fixes.push(change);
  next.lastEvent =
    `Merged ${change.id} to releases/${line.line}; the stable Release PR now includes this post-cut fix.`;
  return next;
};

const publishStable = (state: PrototypeState): PrototypeState => {
  const next = copyState(state);
  const line = next.releaseLine;
  if (line === null) {
    next.lastEvent = 'No stable Release PR exists yet.';
    return next;
  }
  if (line.published !== null) {
    next.lastEvent = `${line.version} is already published; the stable publication job is skipped.`;
    return next;
  }
  line.published = {
    fileBody: renderStableReleaseFile(line),
    filePath: `releases/v${line.version}.md`,
    githubBody: renderStableGitHubRelease(line),
    version: line.version,
  };
  line.releasePrOpen = false;
  next.lastEvent =
    `Merged the ${line.version} Release PR and published its independently derived file and GitHub Release.`;
  return next;
};

const demoActions: PrototypeAction[] = [
  { type: 'land-main-change', kind: 'visible' },
  { type: 'land-main-change', kind: 'skip' },
  { type: 'land-main-change', kind: 'migration' },
  { type: 'mark-prerelease-ready' },
  { type: 'merge-prerelease-proposal' },
  { type: 'land-main-change', kind: 'visible' },
  { type: 'enter-phase', phase: 'beta' },
  { type: 'land-main-change', kind: 'visible' },
  { type: 'mark-prerelease-ready' },
  { type: 'merge-prerelease-proposal' },
  { type: 'release-cut' },
  { type: 'land-main-change', kind: 'visible' },
  { type: 'land-release-fix', releaseNoteSkip: false },
  { type: 'land-release-fix', releaseNoteSkip: true },
  { type: 'publish-stable' },
];

export const transition = (
  state: PrototypeState,
  action: PrototypeAction,
): PrototypeState => {
  if (action.type === 'reset') return createInitialState();
  if (action.type === 'run-demo') {
    const result = demoActions.reduce(transition, createInitialState());
    result.lastEvent =
      'Loaded the suggested journey. Main development and the stable release line are now visibly independent.';
    return result;
  }
  if (action.type === 'land-main-change') {
    return landMainChange(state, action.kind);
  }
  if (action.type === 'enter-phase') {
    return enterPhase(state, action.phase);
  }
  if (action.type === 'release-cut') {
    return releaseCut(state);
  }
  if (action.type === 'land-release-fix') {
    return landReleaseFix(state, action.releaseNoteSkip);
  }
  if (action.type === 'publish-stable') {
    return publishStable(state);
  }

  const next = copyState(state);
  if (action.type === 'mark-prerelease-ready') {
    if (next.prereleaseProposal === null) {
      next.lastEvent = 'There is no ordinary Prerelease PR to mark ready.';
    } else {
      next.prereleaseProposal.draft = false;
      next.lastEvent = `${next.prereleaseProposal.version} is now ready; later refreshes preserve that state.`;
    }
    return next;
  }
  if (action.type === 'merge-prerelease-proposal') {
    const proposal = next.prereleaseProposal;
    if (proposal === null) {
      next.lastEvent = 'There is no ordinary Prerelease PR to merge.';
      return next;
    }
    if (proposal.draft) {
      next.lastEvent = `${proposal.version} is still a draft; mark it ready before merging.`;
      return next;
    }
    const scopedChanges = next.currentChanges.slice(next.authorizedChangeCount);
    next.currentPrereleaseNumber += 1;
    next.authorizedChangeCount = next.currentChanges.length;
    next.prereleaseProposal = null;
    next.mainRevision += 1;
    publishPrerelease(next, proposal.version, scopedChanges);
    next.lastEvent =
      `Merged ${proposal.version}; that exact main snapshot was published to npm next and GitHub Releases.`;
    return next;
  }
  if (action.type === 'edit-latest-prerelease-release') {
    const latest = next.prereleases.at(-1);
    if (latest === undefined) {
      next.lastEvent = 'No prerelease GitHub Release exists to edit.';
      return next;
    }
    latest.body = `# Hand-edited ${latest.version}\n\nThis mutable text is deliberately not release authority.`;
    next.lastEvent =
      `Hand-edited the ${latest.version} GitHub Release body. Future scope and stable communication remain unchanged.`;
    return next;
  }
  return next;
};
