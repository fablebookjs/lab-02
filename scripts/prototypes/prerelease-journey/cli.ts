import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  createInitialState,
  renderPrereleasePr,
  renderStableReleasePr,
  transition,
} from './model.ts';
import type {
  Change,
  PrototypeAction,
  PrototypeState,
} from './model.ts';

const bold = (value: string): string => `\u001b[1m${value}\u001b[0m`;
const dim = (value: string): string => `\u001b[2m${value}\u001b[0m`;

type Artifact = {
  body: string;
  name: string;
};

const changeSummary = (change: Change): string => {
  const flags = [
    change.releaseNoteSkip ? 'release-note:skip' : null,
    change.migration === null ? null : `migration:${change.migration.filename}`,
  ].filter((flag): flag is string => flag !== null);
  return `${change.id} ${change.title}${flags.length === 0 ? '' : ` (${flags.join(', ')})`}`;
};

const list = (values: readonly string[]): string =>
  values.length === 0 ? dim('none') : values.map((value) => `  - ${value}`).join('\n');

const artifacts = (state: PrototypeState): Artifact[] => {
  const result: Artifact[] = [];
  const prereleasePr = renderPrereleasePr(state);
  if (prereleasePr !== null && state.prereleaseProposal !== null) {
    result.push({
      body: prereleasePr,
      name: `Prerelease PR ${state.prereleaseProposal.version}`,
    });
  }
  const latestPrerelease = state.prereleases.at(-1);
  if (latestPrerelease !== undefined) {
    result.push({
      body: latestPrerelease.body,
      name: `GitHub prerelease ${latestPrerelease.version}`,
    });
  }
  const line = state.releaseLine;
  if (line !== null) {
    result.push({
      body: renderStableReleasePr(line),
      name: `${line.version} Release PR (${line.releasePrOpen ? 'open' : 'merged'})`,
    });
    if (line.published !== null) {
      result.push({
        body: line.published.fileBody,
        name: line.published.filePath,
      });
      result.push({
        body: line.published.githubBody,
        name: `GitHub stable Release ${line.version}`,
      });
    }
  }
  return result;
};

const render = (state: PrototypeState, artifactIndex: number): void => {
  console.clear();
  const proposal = state.prereleaseProposal;
  const line = state.releaseLine;
  const availableArtifacts = artifacts(state);
  const selected =
    availableArtifacts.length === 0
      ? null
      : availableArtifacts[artifactIndex % availableArtifacts.length] ?? null;

  console.log(bold('PROTOTYPE — connected prerelease journey'));
  console.log(dim(state.lastEvent));
  console.log();
  console.log(bold('Development line (main)'));
  console.log(`  root package.json: ${state.currentSeries.major}.${state.currentSeries.minor}.0-${state.currentPhase}.${state.currentPrereleaseNumber}`);
  console.log(`  synthetic main revision: m${state.mainRevision}`);
  console.log(`  npm next: ${state.npmNext}`);
  console.log(`  authorized change boundary: ${state.authorizedChangeCount}/${state.currentChanges.length}`);
  console.log('  product history:');
  console.log(list(state.currentChanges.map(changeSummary)));
  console.log(
    `  ordinary Prerelease PR: ${
      proposal === null
        ? dim('none')
        : `${proposal.version} (${proposal.draft ? 'draft' : 'ready'}, ${proposal.changeIds.length} changes)`
    }`,
  );
  console.log(
    `  GitHub prereleases: ${state.prereleases.map(({ version }) => version).join(' → ')}`,
  );
  console.log();
  console.log(bold('Stable release line'));
  if (line === null) {
    console.log(`  ${dim('not cut yet')}`);
  } else {
    const changes = [...line.developmentChanges, ...line.fixes];
    console.log(`  ${line.line}: ${line.version}`);
    console.log(
      `  Release PR: ${line.releasePrOpen ? 'open' : 'merged'} (${changes.length} accounted changes)`,
    );
    console.log(`  development changes captured at cut: ${line.developmentChanges.length}`);
    console.log(`  post-cut release-line fixes: ${line.fixes.length}`);
    console.log(
      `  public changes: ${changes.filter(({ releaseNoteSkip }) => !releaseNoteSkip).length}`,
    );
    console.log(
      `  migration records: ${changes.filter(({ migration }) => migration !== null).length}`,
    );
    console.log(
      `  stable outputs: ${
        line.published === null
          ? dim('not published')
          : `${line.published.filePath} + GitHub Release ${line.published.version}`
      }`,
    );
  }
  console.log();
  console.log(bold(`Artifact preview${selected === null ? '' : ` — ${selected.name}`}`));
  console.log(selected?.body ?? dim('No artifact is available.'));
  console.log();
  console.log(bold('Actions'));
  console.log(
    [
      `${bold('w')} ${dim('main work')}`,
      `${bold('s')} ${dim('main skipped note')}`,
      `${bold('m')} ${dim('main migration change')}`,
      `${bold('r')} ${dim('ready prerelease PR')}`,
      `${bold('p')} ${dim('merge prerelease PR')}`,
      `${bold('b')} ${dim('direct beta.0')}`,
      `${bold('c')} ${dim('direct rc.0')}`,
      `${bold('x')} ${dim('cut release line')}`,
      `${bold('f')} ${dim('release-line fix')}`,
      `${bold('g')} ${dim('skipped release-line fix')}`,
      `${bold('u')} ${dim('publish stable')}`,
      `${bold('e')} ${dim('hand-edit latest prerelease note')}`,
      `${bold('v')} ${dim('next artifact')}`,
      `${bold('d')} ${dim('load suggested journey')}`,
      `${bold('z')} ${dim('reset')}`,
      `${bold('q')} ${dim('quit')}`,
    ].join('  '),
  );
};

const actions: Record<string, PrototypeAction> = {
  b: { type: 'enter-phase', phase: 'beta' },
  c: { type: 'enter-phase', phase: 'rc' },
  d: { type: 'run-demo' },
  e: { type: 'edit-latest-prerelease-release' },
  f: { type: 'land-release-fix', releaseNoteSkip: false },
  g: { type: 'land-release-fix', releaseNoteSkip: true },
  m: { type: 'land-main-change', kind: 'migration' },
  p: { type: 'merge-prerelease-proposal' },
  r: { type: 'mark-prerelease-ready' },
  s: { type: 'land-main-change', kind: 'skip' },
  u: { type: 'publish-stable' },
  w: { type: 'land-main-change', kind: 'visible' },
  x: { type: 'release-cut' },
  z: { type: 'reset' },
};

const readline = createInterface({ input: stdin, output: stdout });
let state = createInitialState();
let artifactIndex = 0;

while (true) {
  render(state, artifactIndex);
  const key = (await readline.question('\n> ')).trim().toLowerCase();
  if (key === 'q') break;
  if (key === 'v') {
    artifactIndex += 1;
    continue;
  }
  const action = actions[key];
  if (action === undefined) {
    state = {
      ...state,
      lastEvent: `Unknown action "${key}".`,
    };
    continue;
  }
  state = transition(state, action);
  artifactIndex = 0;
}

readline.close();
