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

## Terminology

| Term | Meaning | Distinguish from |
|---|---|---|
| Release proposal | Replaceable, version-materialized package state derived from one release-line revision for an intended stable version. | A Release snapshot has already been authorized and is immutable. |
| Release snapshot | The immutable Release proposal authorized by a merged Release PR and named by its version tag. | A Release proposal may still be refreshed or replaced. |
| Prerelease snapshot | The immutable development-line revision authorized by a merged Prerelease PR, phase advancement, or Release cut. | An ordinary Prerelease proposal remains replaceable until authorized. |
| Publication authority | Validated evidence permitting publication of one exact snapshot and version through one accepted workflow path. | Authority permits publication; it does not prove that publication completed. |
| Query-first publication | Reconciliation that observes an exact package version before writing, accepts matching integrity, publishes absence, and rejects conflicts. | It is a recovery rule, not permission to publish a different package set. |

## Local check

```sh
npm ci
npm run check
```

The check compiles both packages, verifies the lockstep and internal-dependency
invariants, packs the actual npm artifacts, installs them into a temporary
offline consumer, and exercises the addon-to-core path.

The **CI: Validate changes** workflow runs the same check on pull requests
and protected branch updates. It is one of the small required checks used by
the pilot rulesets.

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

Five workflow surfaces implement the first release vertical slice:

- **MANUAL - Release: Start new release line** runs from current `main` and asks
  only whether later development moves to the next minor or major line.
- **Release: Trigger proposal maintenance** carries no permissions or
  credentials; a release branch push or release-PR closure merely wakes the
  trusted controller.
- **Release: Keep release PRs current** runs controller code from `main`,
  refreshing an existing proposal, replacing a closed proposal with a new
  draft, activating an older line when work appears, or leaving a completed
  older line dormant.
- **MANUAL - Release: Repair release PRs** invokes that same main-bound
  controller as an explicit recovery action. It is not a normal release step.
- **Release: Protect approval** prevents a proposal based on stale
  release-line source from becoming the authorized release snapshot.

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
remain in place. Its body is rendered from the plain Markdown files in
[`.github/release-templates`](.github/release-templates), which use
dependency-free named placeholders and keep the maintainer procedure
reviewable without embedding prose in controller code. Initial `X.Y.0`
proposals include required **Release highlights**; patch proposals omit them.

The generated change checklist links each release-line merge or direct commit.
For a canonical merged PR, `release-note:skip` excludes the change from public
release notes and `qa:skip` generates its manual-QA item pre-checked with an
explicit “No manual QA required” explanation. Both labels are independent,
absence means public notes and manual QA are required, and direct commits use
those conservative defaults. Every generation rereads current titles and
labels. A required maintainer checkbox confirms that they have not changed
after generation; if they have, the maintainer closes the proposal so the
controller creates a clean replacement.

An in-place refresh preserves a checked manual-QA item by its hidden PR or
commit identity. Title and release-note changes do not reset it. Adding
`qa:skip` satisfies it automatically, while removing `qa:skip` resets it for
manual review. The source-metadata confirmation itself always resets. The
current legacy proposal format is intentionally replaced cleanly once rather
than migrated.

The release PR is the only required QA workspace. Maintainers discuss findings
there and open a normal issue only when a finding needs independent long-term
tracking. The release App needs only repository contents and pull request
permissions. If a ref update succeeds but its body write does not, the next
maintenance run detects the stale generated identity and repairs the same PR.

The credentialless **Release: Protect approval** workflow verifies that
the proposal has one parent and that both its parent and `Release-Source`
trailer equal the PR's current base SHA. Live repository rules must require
this check, require the branch to be up to date before merge, dismiss stale
approvals, and allow release PRs to merge only with a merge commit.

## Prerelease proposals and publication

The prerelease lifecycle remains inactive until a managed release cut creates
the next development line's `alpha.0` boundary. That cut transfers a sealed
publication authority after its guarded GitHub mutation succeeds, so the new
line's direct `alpha.0` publication proceeds independently from maintenance of
the stable Release PR. The pre-system `3.1.0-alpha.0` has no such authority and
is never imported or backfilled.

After the managed boundary exists, every push to `main` runs **Prerelease: Keep
prerelease PR current** in the shared release-proposal writer queue. It creates
or wholly refreshes one canonical draft `prerelease` PR when product work
exists, and removes stale proposal state when no work remains. The PR lists all
scoped changes without QA tasks. `release-note:skip` entries remain part of the
authority but are omitted from the eventual GitHub prerelease body.

Marking the PR ready and merging it requires both the normal
**build, test, and pack** check and **prerelease proposal uses current main**.
The latter proves that the versioned proposal, generated body, source commit,
and exact current `main` still agree. The merge produces one inert PR signal;
the trusted controller then re-reads GitHub to derive publication authority
without running pull-request code in a privileged context.

**MANUAL - Prerelease: Enter phase** is the second authority path. Any
maintainer who can dispatch Actions may select `beta` or `rc`. The guarded
release App transition rejects backward movement, writes the target `.0`
snapshot directly to `main`, closes a superseded ordinary Prerelease PR, and
transfers that snapshot's publication authority. Dispatch itself is the
authorization; there is no separate QA or environment approval.

All three authority paths feed **Publish: Publish approved release**. Its one
trusted TypeScript router classifies the completed workflow path, event,
conclusion, branch, and run ID, then calls the prerelease publisher with only
the explicit authority kind and upstream run ID. Unknown, unsuccessful,
maintenance-only, and wrong-branch completions visibly stop with a skip reason.
The serialized prerelease publisher independently obtains and validates its
single `authority.json`, checks out the exact snapshot, runs the normal
repository gate, packs the complete workspace set, and queries npm before each
publication to `next`. A narrowly held package token reconciles `next`, then
the release App creates or verifies the exact annotated tag and non-draft
GitHub prerelease Release. Reruns visibly skip a prerelease whose packages,
`next` tags, Git tag, and GitHub Release are already complete. Prereleases
remain output-only: they never generate stable release files or migrations.

## Release and migration records

Each staged stable proposal contains one generated release record at
`releases/vX.Y.Z.md`. The controller derives its list from the exact
first-parent release history it already uses for the release PR: one canonical
merged PR becomes its linked PR title, while a direct merge or direct commit
remains visible as one linked commit subject. Ambiguous or malformed PR
metadata stops generation rather than guessing. The record is generated data
and contains no curated highlights.

Curated **Release highlights** live only in an initial release PR's marked
block. Maintainers replace the unchecked placeholder with concise user-facing
highlights. An in-place refresh preserves that content, and a clean replacement
selects the highest-numbered closed predecessor for the same version and
preserves it. Missing, malformed, or still-placeholder content falls back to
the blocking empty placeholder. The trusted required PR-description check
enforces this block for `X.Y.0` releases; patches do not carry it.

Migration guidance is authored only when a change needs it. Copy
[`migration-notes/TEMPLATE.md`](migration-notes/TEMPLATE.md) into the target
release-line directory, for example
`migration-notes/v2.1/adopt-portable-stories.md`. Each small record has:

- a required free-text `priority` frontmatter value, used only for sorting;
- one title;
- nonempty `Who is affected` and `How to migrate` sections;
- an optional `Automatic migration` section.

`npm run validate:release-communication` validates every target directory.
Composition uses natural, case-insensitive priority order and then the unique
filename as its tie-breaker. It removes priority metadata from the visible
records. The release PR lists every migration record for its release line at the
exact release source so maintainers can review the relevant files before
publication. The published GitHub Release repeats only the ordered linked
titles, targeting the canonical Markdown files in that release's exact tag; it
does not copy the migration instructions into the release body.

## Stable publication and promotion

Merging a canonical release PR wakes **Publish: Publish approved release**. The
same trusted router calls the stable publisher with only `stable-pr` and the
upstream run ID. The stable authority resolver re-reads the PR and proves that
its two-parent merge commit contains the exact reviewed proposal. That
uncredentialed job checks out the immutable snapshot, installs, compiles,
tests, and packs the dynamically discovered package set.

A fresh OIDC-only job queries npm before each package write. It publishes a
missing package directly under the line channel such as `v-1.0`, skips only an
existing version with the same tarball integrity and channel, and stops on a
contradiction. No product code runs in that job. After the complete set reads
back successfully, a separate `release-github` job uses the repository-scoped
App to create or verify annotated `vX.Y.Z` and its non-draft GitHub Release.
The publication controller renders three intentionally small shapes directly:
initial releases combine **Release highlights** with noteworthy public changes,
ordinary patches show only their public changes, and a patch whose complete
source metadata marks every change `release-note:skip` uses a short maintenance
message. Ordered, tag-pinned migration-record links form an independent
optional section in all three shapes and the heading is omitted when empty.
The generated `releases/vX.Y.Z.md` record still contains every change and is
used to verify that the authorized communication matches the released snapshot.

**MANUAL - Publish: Promote to latest** is a separate workflow. Its only input
is a completed stable version such as `1.0.0`. It resolves that version's
annotated tag and derives the historical package set from the tagged snapshot
without npm write authority. The dispatched write job receives the
package-scoped token and moves those packages to `latest` sequentially. All
promotion runs share one queue; a rerun skips tags already at the requested
version. Selecting an older completed version is the rollback mechanism.

## Patchback coordination

The same merged release-PR signal independently wakes **Release: Prepare
patchback PR**, so patchback preparation starts in parallel with publication
and does not wait for npm or GitHub Release completion. The workflow derives
its ordered scope from the authorized snapshot's first-parent release history:

- `X.Y.0` starts after the durable release-cut source recorded on `main`;
- later patches start after the preceding completed release tag;
- the current release snapshot merge itself is the one recognized mechanical
  commit excluded from that range.

Every remaining first-parent entry becomes work. An unambiguous merged PR adds
its PR identity, while direct commits, direct merges, missing metadata, and
ambiguous metadata still produce commit-linked items. A merge entry is one item
with the complete first-parent delta and a `git cherry-pick -m 1` example.

The write job query-first creates `patchbacks/vX.Y.Z` from the then-current
`main`, adds one commit containing the exact generated `releases/vX.Y.Z.md`
record and every validated migration record for that release line from the
authorized snapshot, then opens a draft PR to `main`. The controller verifies
that this commit differs from its recorded `main` parent only through those
release-communication paths and that every synchronized file still exactly
matches the snapshot. Migration records already identical on `main` remain
unchanged.

The PR body lists the mechanically synchronized communication separately from
the immutable unchecked product-change queue; automation never cherry-picks
product changes, edits outcomes, or rewrites the queue on retry. When the PR is
first created, automation best-effort assigns it to the maintainer who merged
the release PR. Assignment failure never blocks creation, and maintainers may
freely reassign it. One marked comment is created or updated with copy-paste
examples for `applied`, `already-present`, and `not-applicable` outcomes.

A merged or closed patchback PR is terminal. When the product-change scope is
empty, the draft still contains the generated release record and can be reviewed
and merged with any migration records as the complete patchback.

**PR: Enforce readiness** applies to every repository PR and
fails while its description contains an unchecked Markdown task. Live branch
rules must require the `PR description has no unchecked tasks` check for `main`
and the release branches. It adds no semantic patchback verification.

Live setup configures both packages to trust `publish-stable-release.yml`,
which remains the sole workflow-run and OIDC entrypoint while routing to the
stable or prerelease reusable publisher. It provides the App variables and
secret through the existing `release-github` environment, and stores the
package-scoped granular dist-tag credential as `NPM_PROMOTION_TOKEN` only in a
`main`-restricted `npm-promotion` environment.
The upstream merge, cut, or manual dispatch is the operator authorization; the
environment adds branch and secret scope without another reviewer gate.
