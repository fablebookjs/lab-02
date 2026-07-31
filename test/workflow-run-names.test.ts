import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { repositoryRoot } from '../scripts/shared/workspace/packages.ts';

const workflows = join(repositoryRoot, '.github', 'workflows');

const expectedRunNames = new Map([
  [
    'ci.yml',
    `run-name: "CI validation · \${{ github.event_name == 'pull_request' && format('PR #{0} · {1}', github.event.pull_request.number, github.event.pull_request.title) || format('push {0} · {1}', github.ref_name, github.event.head_commit.message) }}"`,
  ],
  [
    'cut-release-line.yml',
    "run-name: 'MANUAL - Release: New release line · next development: ${{ inputs.next-development }}'",
  ],
  [
    'enter-prerelease-phase.yml',
    "run-name: 'MANUAL - Prerelease: Enter phase · ${{ inputs.phase }}'",
  ],
  [
    'maintain-patchback.yml',
    "run-name: 'Patchback prep · after ${{ github.event.workflow_run.display_title }}'",
  ],
  [
    'maintain-prerelease-proposal.yml',
    "run-name: 'Prerelease PR refresh · push ${{ github.ref_name }} · ${{ github.event.head_commit.message }}'",
  ],
  [
    'maintain-release-proposal.yml',
    `run-name: "Release PR refresh · \${{ github.event_name == 'repository_dispatch' && github.event.action || github.event_name == 'workflow_run' && format('after {0}', github.event.workflow_run.display_title) || github.event_name }}"`,
  ],
  [
    'prerelease-proposal-check.yml',
    "run-name: 'Prerelease approval · PR #${{ github.event.pull_request.number }} · ${{ github.event.pull_request.title }}'",
  ],
  [
    'prerelease-proposal-signal.yml',
    "run-name: 'Prerelease publish signal · PR #${{ github.event.pull_request.number }} · ${{ github.event.pull_request.title }}'",
  ],
  [
    'promote-latest.yml',
    "run-name: 'MANUAL - Publish: Promote to latest · ${{ inputs.version }}'",
  ],
  [
    'publish-stable-release.yml',
    "run-name: 'Publication follow-up · after ${{ github.event.workflow_run.display_title }}'",
  ],
  [
    'pull-request-description-check.yml',
    "run-name: 'PR readiness · PR #${{ github.event.pull_request.number }} · ${{ github.event.pull_request.title }}'",
  ],
  [
    'release-proposal-check.yml',
    "run-name: 'Release approval · PR #${{ github.event.pull_request.number }} · ${{ github.event.pull_request.title }}'",
  ],
  [
    'release-proposal-signal.yml',
    `run-name: "Release maintenance · \${{ github.event_name == 'pull_request_target' && format('PR #{0} · {1}', github.event.pull_request.number, github.event.pull_request.title) || format('push {0} · {1}', github.ref_name, github.event.head_commit.message) }}"`,
  ],
]);

test('independently visible workflows use purpose-first run names', async () => {
  for (const [name, expected] of expectedRunNames) {
    const source = await readFile(join(workflows, name), 'utf8');
    assert.ok(source.split('\n').includes(expected), `${name} has an unexpected run-name`);
  }
});

test('workflows without distinct run metadata retain their static names', async () => {
  for (const name of ['publish-prerelease.yml', 'repair-release-proposals.yml']) {
    const source = await readFile(join(workflows, name), 'utf8');
    assert.doesNotMatch(source, /^run-name:/m, `${name} should not override its run name`);
  }
});
