import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  createInitialState,
  renderPrereleasePr,
  renderStableReleasePr,
  transition,
} from './model.ts';
import type {
  PrototypeAction,
  PrototypeState,
} from './model.ts';

const bold = (value: string): string => `\u001b[1m${value}\u001b[0m`;
const dim = (value: string): string => `\u001b[2m${value}\u001b[0m`;

type Artifact = {
  body: string;
  name: string;
};

type JourneyStep = {
  action: string;
  artifacts: Artifact[];
  result: string[];
  shortTitle: string;
  state: PrototypeState;
  title: string;
  why: string;
};

const applyActions = (
  state: PrototypeState,
  actions: readonly PrototypeAction[],
): PrototypeState => actions.reduce(transition, state);

const realArtifacts = (state: PrototypeState): Artifact[] => {
  const artifacts: Artifact[] = [];
  const prereleasePr = renderPrereleasePr(state);
  if (prereleasePr !== null && state.prereleaseProposal !== null) {
    artifacts.push({
      body: prereleasePr,
      name: `Prerelease PR ${state.prereleaseProposal.version}`,
    });
  }
  for (const release of [...state.prereleases].reverse()) {
    artifacts.push({
      body: release.body,
      name: `GitHub prerelease ${release.version}`,
    });
  }
  const line = state.releaseLine;
  if (line !== null) {
    artifacts.push({
      body: renderStableReleasePr(line),
      name: `${line.version} Release PR (${line.releasePrOpen ? 'open' : 'merged'})`,
    });
    if (line.published !== null) {
      artifacts.push({
        body: line.published.githubBody,
        name: `GitHub stable Release ${line.version}`,
      });
      artifacts.push({
        body: line.published.fileBody,
        name: line.published.filePath,
      });
    }
  }
  return artifacts;
};

const orderedArtifacts = (
  state: PrototypeState,
  preferredName: string,
  custom?: Artifact,
): Artifact[] => {
  const artifacts = custom === undefined
    ? realArtifacts(state)
    : [custom, ...realArtifacts(state)];
  const preferredIndex = artifacts.findIndex(({ name }) => name === preferredName);
  if (preferredIndex <= 0) return artifacts;
  const preferred = artifacts[preferredIndex];
  if (preferred === undefined) return artifacts;
  return [
    preferred,
    ...artifacts.filter((_, index) => index !== preferredIndex),
  ];
};

const start = createInitialState();

const workLands = applyActions(start, [
  { type: 'land-main-change', kind: 'visible' },
  { type: 'land-main-change', kind: 'skip' },
  { type: 'land-main-change', kind: 'migration' },
]);

const alphaOne = applyActions(workLands, [
  { type: 'mark-prerelease-ready' },
  { type: 'merge-prerelease-proposal' },
]);

const betaZero = applyActions(alphaOne, [
  { type: 'land-main-change', kind: 'visible' },
  { type: 'enter-phase', phase: 'beta' },
]);

const betaOne = applyActions(betaZero, [
  { type: 'land-main-change', kind: 'visible' },
  { type: 'mark-prerelease-ready' },
  { type: 'merge-prerelease-proposal' },
]);

const afterCut = transition(betaOne, { type: 'release-cut' });

const parallelWork = applyActions(afterCut, [
  { type: 'land-main-change', kind: 'visible' },
  { type: 'land-release-fix', releaseNoteSkip: false },
  { type: 'land-release-fix', releaseNoteSkip: true },
]);

const stablePublished = transition(parallelWork, { type: 'publish-stable' });

const cutOverview: Artifact = {
  name: 'The release cut creates two independent lanes',
  body: [
    '                                      time →',
    '',
    'main             ── release cut ──▶ 3.2.0-alpha.0 committed and published',
    '                                      npm next + GitHub prerelease',
    '',
    'releases/v3.1    ── release cut ──▶ 3.1.0 Release PR opened',
    '                                      stable publication still pending',
    '',
    'The old ordinary Prerelease PR, if any, is discarded at the cut.',
  ].join('\n'),
};

const parallelOverview: Artifact = {
  name: 'Work continues independently after the cut',
  body: [
    '                                      time →',
    '',
    'main             3.2.0-alpha.0 ── new work ──▶ draft 3.2.0-alpha.1 PR',
    '',
    'releases/v3.1    3.1.0 Release PR ── two fixes ──▶ refreshed Release PR',
    '',
    'Neither lane waits for or changes the other lane.',
  ].join('\n'),
};

const steps: JourneyStep[] = [
  {
    action: 'Nothing happens yet. The previous release cut already started this line.',
    artifacts: orderedArtifacts(
      start,
      'GitHub prerelease 3.1.0-alpha.0',
    ),
    result: [
      '`main` carries 3.1.0-alpha.0.',
      'alpha.0 is already on npm `next` and in GitHub Releases.',
      'There is no ordinary Prerelease PR because no product work is waiting.',
    ],
    shortTitle: 'start',
    state: start,
    title: 'The 3.1 development line begins',
    why: 'alpha.0 is the empty starting boundary used to discover all later 3.1 work.',
  },
  {
    action: 'Three product PRs merge into `main`: one visible, one `release-note:skip`, and one with a migration record.',
    artifacts: orderedArtifacts(
      workLands,
      'Prerelease PR 3.1.0-alpha.1',
    ),
    result: [
      'One rolling draft Prerelease PR proposes 3.1.0-alpha.1.',
      'It lists all three changes for accounting.',
      'It has no QA checkboxes and nothing new has been published yet.',
    ],
    shortTitle: 'alpha PR',
    state: workLands,
    title: 'Work creates one rolling Prerelease PR',
    why: 'Every main advancement refreshes the same proposal instead of opening competing PRs.',
  },
  {
    action: 'A maintainer marks the Prerelease PR ready and merges it.',
    artifacts: orderedArtifacts(
      alphaOne,
      'GitHub prerelease 3.1.0-alpha.1',
    ),
    result: [
      '`main` now carries 3.1.0-alpha.1.',
      'That exact merged snapshot is published to npm `next` and GitHub Releases.',
      'The public note omits the skipped change and never shows migration guidance.',
    ],
    shortTitle: 'alpha.1',
    state: alphaOne,
    title: 'Merging the proposal publishes alpha.1',
    why: 'The merge is the authorization boundary; the GitHub body is only a public projection of that snapshot.',
  },
  {
    action: 'More work lands, creating an alpha.2 PR. Before it merges, a maintainer runs the manual `beta` action.',
    artifacts: orderedArtifacts(
      betaZero,
      'GitHub prerelease 3.1.0-beta.0',
    ),
    result: [
      'The unmerged alpha.2 Prerelease PR is discarded.',
      'The action directly commits 3.1.0-beta.0 to `main` and immediately publishes it.',
      'The work that had been waiting in alpha.2 is included in beta.0.',
    ],
    shortTitle: 'beta.0',
    state: betaZero,
    title: 'Direct phase entry replaces the ordinary proposal',
    why: 'alpha, beta, and rc communicate intent; phase entry is an immediate release, not another approval PR.',
  },
  {
    action: 'Another product PR lands. The resulting beta.1 Prerelease PR is marked ready and merged.',
    artifacts: orderedArtifacts(
      betaOne,
      'GitHub prerelease 3.1.0-beta.1',
    ),
    result: [
      '`main` now carries 3.1.0-beta.1.',
      'beta.1 is published through the same ordinary Prerelease PR path as alpha.1.',
      'The prerelease note contains only the change since beta.0.',
    ],
    shortTitle: 'beta.1',
    state: betaOne,
    title: 'Ordinary prereleases continue in the new phase',
    why: 'Phase entry changes the label and resets the counter; it does not create a second lifecycle.',
  },
  {
    action: 'A maintainer cuts the 3.1 release line from the current `main` snapshot.',
    artifacts: orderedArtifacts(
      afterCut,
      cutOverview.name,
      cutOverview,
    ),
    result: [
      '`main` immediately advances to and publishes 3.2.0-alpha.0.',
      '`releases/v3.1` independently opens the stable 3.1.0 Release PR.',
      'The Release PR accounts for all five product changes made during 3.1 development.',
    ],
    shortTitle: 'cut',
    state: afterCut,
    title: 'The release cut creates two parallel outcomes',
    why: 'The next development line can move immediately while the cut line stabilizes at its own pace.',
  },
  {
    action: 'New 3.2 work lands on `main` while two post-cut fixes land on `releases/v3.1`.',
    artifacts: orderedArtifacts(
      parallelWork,
      parallelOverview.name,
      parallelOverview,
    ),
    result: [
      '`main` has one draft 3.2.0-alpha.1 Prerelease PR.',
      'The 3.1.0 Release PR refreshes to include both release-line fixes.',
      'Its accounting now contains five development changes plus two post-cut fixes.',
    ],
    shortTitle: 'parallel',
    state: parallelWork,
    title: 'Development and stabilization proceed independently',
    why: 'Next-line work must not leak into 3.1, and post-cut 3.1 fixes must not disappear from its stable release.',
  },
  {
    action: 'A maintainer completes the stable Release PR and merges it.',
    artifacts: orderedArtifacts(
      stablePublished,
      'GitHub stable Release 3.1.0',
    ),
    result: [
      '3.1.0 publishes a checked-in release file and a GitHub stable Release.',
      'Both public change lists exclude the two `release-note:skip` changes.',
      'The GitHub stable Release includes the 3.1 migration; the 3.2 alpha.1 PR remains untouched.',
    ],
    shortTitle: '3.1.0',
    state: stablePublished,
    title: 'The stable release independently tells the complete story',
    why: 'Stable communication comes from Git history boundaries, not by concatenating mutable prerelease notes.',
  },
];

const rootVersion = (state: PrototypeState): string =>
  `${state.currentSeries.major}.${state.currentSeries.minor}.0-${state.currentPhase}.${state.currentPrereleaseNumber}`;

const render = (
  stepIndex: number,
  artifactIndex: number,
  notice: string | null,
): void => {
  console.clear();
  const step = steps[stepIndex];
  if (step === undefined) throw new Error(`Missing journey step ${stepIndex}.`);
  const artifact = step.artifacts[artifactIndex % step.artifacts.length];
  if (artifact === undefined) throw new Error(`Step ${stepIndex} has no artifact.`);
  const line = step.state.releaseLine;
  const timeline = steps
    .map(({ shortTitle }, index) =>
      index === stepIndex
        ? bold(`[${index + 1} ${shortTitle}]`)
        : dim(`${index + 1} ${shortTitle}`),
    )
    .join(' ─ ');

  console.log(bold('PROTOTYPE — narrated prerelease journey'));
  console.log('One 3.1 development line becomes prereleases, then a stable release, while 3.2 begins.');
  console.log();
  console.log(`time → ${timeline}`);
  console.log();
  console.log(bold(`Step ${stepIndex + 1} of ${steps.length}: ${step.title}`));
  console.log();
  console.log(bold('What happens'));
  console.log(step.action);
  console.log();
  console.log(bold('Result'));
  for (const result of step.result) console.log(`- ${result}`);
  console.log();
  console.log(bold('Why this matters'));
  console.log(step.why);
  console.log();
  console.log(bold('Lanes now'));
  console.log(
    `- main: ${rootVersion(step.state)}; ordinary Prerelease PR: ${
      step.state.prereleaseProposal?.version ?? 'none'
    }`,
  );
  console.log(
    `- stable: ${
      line === null
        ? 'not cut yet'
        : `${line.line} / ${line.version} Release PR ${line.releasePrOpen ? 'open' : 'merged'}`
    }`,
  );
  console.log(
    `- published prereleases: ${step.state.prereleases
      .map(({ version }) => version)
      .join(' → ')}`,
  );
  console.log();
  console.log(
    bold(
      `Artifact ${artifactIndex % step.artifacts.length + 1}/${step.artifacts.length} — ${artifact.name}`,
    ),
  );
  console.log(artifact.body);
  console.log();
  if (notice !== null) console.log(dim(notice));
  console.log(
    `${bold('n')} ${dim('next step')}  ${bold('p')} ${dim('previous step')}  ` +
      `${bold('a')} ${dim('next artifact')}  ${bold('q')} ${dim('quit')}`,
  );
};

const readline = createInterface({ input: stdin, output: stdout });
let stepIndex = 0;
let artifactIndex = 0;
let notice: string | null = null;

while (true) {
  render(stepIndex, artifactIndex, notice);
  const key = (await readline.question('\n> ')).trim().toLowerCase();
  notice = null;
  if (key === 'q') break;
  if (key === 'n') {
    if (stepIndex === steps.length - 1) {
      notice = 'This is the final step. Use p to revisit the journey.';
    } else {
      stepIndex += 1;
      artifactIndex = 0;
    }
    continue;
  }
  if (key === 'p') {
    if (stepIndex === 0) {
      notice = 'This is the starting point.';
    } else {
      stepIndex -= 1;
      artifactIndex = 0;
    }
    continue;
  }
  if (key === 'a') {
    artifactIndex += 1;
    continue;
  }
  notice = 'Use n for next, p for previous, a for another artifact, or q to quit.';
}

readline.close();
