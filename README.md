# Fablebook Lab 02

This is the public `fablebookjs/lab-02` release pilot. It resembles the
release-relevant part of the Storybook monorepo without copying Storybook's
package count or build system. It was initially provisioned from an exact seed
in the private `fablebookjs/plan` repository; subsequent pilot operations live
in this repository's own history.

The workspace contains 2 public packages at one lockstep version:

- `@fablebook/lab-02-core`
- `@fablebook/lab-02-addon`, which depends on that exact version of core

Both packages compile TypeScript into the `dist/` files that npm packs. Package
operations discover the public workspace set from the current Git tree rather
than from an operator-maintained list.

## Local check

```sh
npm ci
npm run check
```

The check compiles both packages, verifies the lockstep and internal-dependency
invariants, packs the actual npm artifacts, installs them into a temporary
offline consumer, and exercises the addon-to-core path.

The **CI** workflow runs the same check on pull requests and protected branch
updates. It is one of the small required checks used by the pilot rulesets.

## Materialize an exact version

```sh
npm run set-version -- 1.1.0-alpha.0
```

The procedure accepts a stable version or an `alpha`, `beta`, or `rc`
prerelease. It updates the private root and all discovered public packages,
rewrites internal package dependencies to that exact version, refreshes the
lockfile, and compiles the result. Release lifecycle policy chooses the exact
version; this repository command only materializes it.

## Release proposals

Four workflows implement the first release vertical slice:

- **Cut release line** runs manually from current `main` and asks only whether
  later development moves to the next minor or major line.
- **Release proposal signal** carries no permissions or credentials; a release
  branch push or release-PR closure merely wakes the trusted controller.
- **Maintain release proposal** runs controller code from `main`, refreshing an
  existing proposal, replacing a closed proposal with a new draft, activating
  an older line when work appears, or leaving a completed older line dormant.
- **Release proposal check** prevents a proposal based on stale release-line
  source from becoming the authorized release snapshot.

Preparation and mutation are separate jobs. The uncredentialed job checks the
trusted controller, installs and compiles each materialized version, and
creates inert Git objects. A fresh `release-github` job imports those objects,
uploads their verified trees and commit metadata, rechecks expected-old state,
then uses the repository-scoped GitHub App for only the guarded ref and
pull-request writes.

The cut creates two children of the exact current `main` head and applies three
ref changes in one atomic GitHub operation:

```text
source S ── proposal P (stable X.Y.0) ──▶ staged/vX.Y
    │
    ├───────────────────────────────────▶ releases/vX.Y (still S)
    └── development D (next -alpha.0) ──▶ main
```

Every newly created or recreated release PR starts as a draft. Refreshing an
open proposal updates its existing staged branch, so the PR and its discussion
remain in place. Its body is rendered from
[`.github/release-pr-template.md`](.github/release-pr-template.md), which uses
dependency-free named placeholders and keeps the maintainer procedure
reviewable without embedding prose in controller code. The generated
included-change checklist links each release-line merge or direct commit. A
refresh preserves checked items by their hidden PR or commit identity and adds
new changes unchecked; a clean replacement starts fresh.

The release PR is the only required QA workspace. Maintainers discuss findings
there and open a normal issue only when a finding needs independent long-term
tracking. The release App needs only repository contents and pull request
permissions. If a ref update succeeds but its body write does not, the next
maintenance run detects the stale generated identity and repairs the same PR.

The credentialless **Release proposal check** verifies that the proposal has
one parent and that both its parent and `Release-Source` trailer equal the PR's
current base SHA. Live repository rules must require this check, require the
branch to be up to date before merge, dismiss stale approvals, and allow release
PRs to merge only with a merge commit.

## Stable publication and promotion

Merging a canonical release PR wakes **Publish stable release**. Its first job
re-reads the PR and proves that its two-parent merge commit contains the exact
reviewed proposal. That uncredentialed job checks out the immutable snapshot,
installs, compiles, tests, and packs the dynamically discovered package set.

A fresh OIDC-only job queries npm before each package write. It publishes a
missing package directly under the line channel such as `v-1.0`, skips only an
existing version with the same tarball integrity and channel, and stops on a
contradiction. No product code runs in that job. After the complete set reads
back successfully, a separate `release-github` job uses the repository-scoped
App to create or verify annotated `vX.Y.Z` and its non-draft GitHub Release.

**Promote latest** is a separate manual workflow. Its only input is a completed
stable version such as `1.0.0`. It resolves that version's annotated tag,
derives the historical package set from the tagged snapshot without npm write
authority, and then waits for approval on the `npm-promotion` environment. The
approved job receives the package-scoped token and moves those packages to
`latest` sequentially. All promotion runs share one queue; a rerun skips tags
already at the requested version. Selecting an older completed version is the
rollback mechanism.

## Patchback coordination

The same merged release-PR signal independently wakes **Maintain patchback**, so
patchback preparation starts in parallel with publication and does not wait for
npm or GitHub Release completion. The workflow derives its ordered scope from
the authorized snapshot's first-parent release history:

- `X.Y.0` starts after the durable release-cut source recorded on `main`;
- later patches start after the preceding completed release tag;
- the current release snapshot merge itself is the one recognized mechanical
  commit excluded from that range.

Every remaining first-parent entry becomes work. An unambiguous merged PR adds
its PR identity, while direct commits, direct merges, missing metadata, and
ambiguous metadata still produce commit-linked items. A merge entry is one item
with the complete first-parent delta and a `git cherry-pick -m 1` example.

The write job query-first creates `patchbacks/vX.Y.Z` from the then-current
`main`, adds one empty commit containing the snapshot and boundary identities,
and opens a draft PR to `main`. Its body is the immutable unchecked work queue;
automation never cherry-picks, edits outcomes, or rewrites the queue on retry.
One marked comment is created or updated with copy-paste examples for
`applied`, `already-present`, and `not-applicable` outcomes.

A merged or closed patchback PR is terminal. The empty-scope path intentionally
creates the same draft PR and leaves it for a maintainer to close.

**Pull request description check** applies to every repository PR and fails
while its description contains an unchecked Markdown task. Live branch rules
must require the `PR description has no unchecked tasks` check for `main` and
the release branches. It adds no semantic patchback verification.

Live setup configures both packages to trust
`publish-stable-release.yml`, provide the App variables and secret through the
existing `release-github` environment, and store the package-scoped granular
promotion credential as `NPM_PROMOTION_TOKEN` only in a `main`-restricted,
maintainer-approved `npm-promotion` environment. The live-setup ticket owns
those external changes and the required current npm capability recheck.
