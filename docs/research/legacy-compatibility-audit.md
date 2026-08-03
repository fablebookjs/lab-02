# Lab-02 legacy-compatibility audit

Research date: 2026-08-02 (Europe/Amsterdam)

Repository authority inspected: `f6260f66bea17ee981335c1653debfc1c4b73235`,
which was both local `HEAD` and local `origin/main` when this audit began. Live
GitHub observations were read through the first-party GitHub API. The pre-existing
working-tree changes to `package-lock.json` and
`scripts/shared/workspace/packages.ts` were not used as historical evidence and
were not modified.

## Short answer

Three pieces were removable and have now been removed from current operational
code. Four are current architecture, and two are intentional readers of
immutable history:

| Case | Verdict | Plain-language reason |
| --- | --- | --- |
| Current `list-packages` command | **Remove** | New snapshots have the tagged v1 API; the current command is only a redundant copy of the old adapter. |
| v6 Release-PR replacement path | **Remove** | It existed to replace one body format. Every PR with that format is terminal, and none is open. |
| Historical package-set fallback | **Keep** | Ten immutable releases have no tagged API. Removing the fallback breaks recovery and `latest` promotion for them. |
| Historical v1 release-record reader | **Keep** | Three immutable release snapshots contain that exact format and current recovery/patchback code may read those snapshots. |
| Tagged workspace-packages v1 API and contract | **Keep** | This is the permanent replacement, not the legacy adapter. Releases from `v3.4.0` onward contain it. |
| Thin GitHub handler files | **Keep** | All 31 are direct, typed workflow entrypoints; none is orphaned. |
| Patchback inspector `.mjs` | **Migrate** | Its behavior is active, but the large skill-local JavaScript implementation can become a typed adapter over shared Patchback inspection. |
| Release and Migration Markdown | **Keep** | They are durable release facts and authored migration guidance consumed by current generation, publication, patchback, and validation paths. |
| Unmanaged prerelease `inactive` state | **Remove** | Protected `main` now permanently contains a managed boundary. Missing it is corruption and should fail, not be treated as an expected no-op. |

The applied cleanup is:

1. delete `scripts/workspace/list-packages.ts` and the root `list-packages`
   package command;
2. delete `replaceRequired`, the stable-maintenance `replace` action, its v6
   marker probe/tests, and the completed one-time README sentence;
3. delete the prerelease `inactive` action from the planner, transition schema,
   controller, and test, making a missing managed boundary an explicit error and
   updating the README from bootstrap-era wording to current-state wording; and
4. preserve Patchback inspection while moving deterministic policy into typed
   shared modules and leaving `gh` execution in a thin skill-local TypeScript
   adapter.

Do **not** delete either historical reader while the repository promises
recovery, patchback, or promotion for already published versions.

## 1. Current `scripts/workspace/list-packages.ts`

**Verdict: remove the current wrapper and its package command.**

The file does one thing: call current shared discovery, retain public packages,
and print `{ location, name, version }` as JSON. The only current direct entry is
the root `list-packages` package script
([wrapper](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/workspace/list-packages.ts#L1-L10),
[package command](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/package.json#L9-L21)).

The release loader always tries the tagged v1 API first and invokes
`npm run --silent --ignore-scripts list-packages` only when that API path is
absent
([selection logic](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/package-publication/package-set.ts#L227-L265)).
The current repository exercises the v1 path, and the test explicitly proves
that the v1 path wins even if the old script also exists
([current/native tests](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/test/package-set.test.ts#L93-L140)).

Deleting the **current** copy does not remove the command from old tags. Each
historical checkout contains and executes its own `package.json` and script.
Future tags will contain the v1 API instead. The operational consequence is only
that `npm run list-packages` is no longer a manual convenience on current main;
release behavior remains covered by the API.

History confirms that this wrapper was created during the TypeScript transition,
not as the stable tagged interface
([commit `bb262be`](https://github.com/fablebookjs/lab-02/commit/bb262be6bbe5b711c31528fd5b3804ca17b516b9)).

## 2. One-time v6 Release-PR replacement

**Verdict: remove the replacement path and stale README sentence.**

The current stable template marker is v7
([marker](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-proposal/body.ts#L38-L44)).
The controller separately looks for exactly the v6 marker and turns it into
`replaceRequired`
([probe](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-proposal/controller.ts#L788-L807)).
That flag produces the special `replace` plan
([planner](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-proposal/core.ts#L390-L408)),
crosses the transition schema
([schema](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-proposal/transition-schema.ts#L55-L70)),
then closes the old PR and creates a clean one
([mutation](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-proposal/controller.ts#L1066-L1118)).
The README still describes this as a one-time replacement
([README](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/README.md#L107-L112)).

A live first-party API scan of all repository PR bodies found exactly six with
`<!-- fablebook:release-pr=v6 -->`. All are terminal:

- [#49](https://github.com/fablebookjs/lab-02/pull/49) — closed, not merged;
- [#51](https://github.com/fablebookjs/lab-02/pull/51) — merged;
- [#62](https://github.com/fablebookjs/lab-02/pull/62) — merged;
- [#64](https://github.com/fablebookjs/lab-02/pull/64) — merged;
- [#66](https://github.com/fablebookjs/lab-02/pull/66) — closed, not merged; and
- [#68](https://github.com/fablebookjs/lab-02/pull/68) — closed, not merged.

The same live scan found no open PR targeting a `releases/*` branch, v6 or
otherwise (API source:
[`GET /repos/fablebookjs/lab-02/pulls`](https://api.github.com/repos/fablebookjs/lab-02/pulls?state=open&per_page=100)).
Closed PRs cannot become open through the maintenance controller, and any newly
generated PR uses v7. The one-time state has therefore completed.

Removing it simplifies the planner input, action union, serializer, mutation
branch, special supersession test, and documentation. Normal `refresh`, `sync`,
and closed-PR `recreate` behavior remains separate and current. The special test
that exists only for this route is visible at
[`test/release-proposal-core.test.ts`](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/test/release-proposal-core.test.ts#L265-L293).

## 3. Historical package-set fallback

**Verdict: keep. This is necessary compatibility at the history boundary.**

`loadReleasePackageSet` reads an exact snapshot. It prefers a fixed, newest-first
tagged API table, fails closed when a present API is invalid, and only then runs
the old package command with an allowlisted credentialless environment and a
ten-second timeout
([implementation](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/package-publication/package-set.ts#L12-L14),
[credentialless fallback](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/package-publication/package-set.ts#L167-L225),
[selection](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/package-publication/package-set.ts#L227-L265)).

The repository's own immutable-tag integration test names the ten stable tags
that require this fallback: `v1.0.0`, `v2.0.0`, `v2.0.1`, `v2.0.2`, `v2.0.3`,
`v2.0.4`, `v2.0.5`, `v2.0.6`, `v2.1.0`, and `v3.0.0`
([tag matrix and real checkout test](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/test/package-set.test.ts#L394-L425)).
Direct tree inspection agrees: [`v3.0.0`](https://github.com/fablebookjs/lab-02/tree/v3.0.0/scripts)
has the package script but no `scripts/api/v1`, while
[`v3.4.0`](https://github.com/fablebookjs/lab-02/blob/v3.4.0/scripts/api/v1/workspace-packages.ts)
contains the native interface.

This is operational, not theoretical. Stable package preparation calls the
loader before packing the complete public set
([packing](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/package-publication/mechanics.ts#L63-L92)),
and manual `latest` promotion checks out the exact completed release snapshot
before calling the same loader
([workflow](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/promote-latest.yml#L38-L64),
[promotion controller](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-publication/promotion-controller.ts#L38-L62)).

Removing the fallback would make those ten published releases unsupported for
recovery or promotion. It can be removed only together with an explicit policy
that withdraws those capabilities for `v1.0.0` through `v3.0.0`.

## 4. Historical v1 release-record reader

**Verdict: keep. It reads immutable released data and is deliberately narrow.**

The reader accepts exactly two prefixes: today's concise
`# vX.Y.Z changes` form and the old marker/header form. It still validates the
requested version, trailing newline, nonempty content, canonical links, titles,
and uniqueness
([reader](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-communication/records.ts#L267-L338)).
It does not accept arbitrary old Markdown.

Exact tag inspection finds the historical form in only three immutable release
records:

- [`v2.0.1`](https://github.com/fablebookjs/lab-02/blob/v2.0.1/releases/v2.0.1.md),
- [`v2.0.2`](https://github.com/fablebookjs/lab-02/blob/v2.0.2/releases/v2.0.2.md), and
- [`v2.0.3`](https://github.com/fablebookjs/lab-02/blob/v2.0.3/releases/v2.0.3.md).

`v2.0.4` and later records use the current form
([example](https://github.com/fablebookjs/lab-02/blob/v2.0.4/releases/v2.0.4.md)).
The compatibility was once deleted, then restored specifically to recover
stable finalization
([removal `7e84a42`](https://github.com/fablebookjs/lab-02/commit/7e84a42ee39a89fd5cce8f5b66ee4563f4341a1c),
[recovery `924e1ec`](https://github.com/fablebookjs/lab-02/commit/924e1ecf2460b28a2c2f0ef36d2ee1480fbce43c)).

Current stable publication reads the record from the authorized snapshot and
validates it against the authorized communication
([publication read](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-publication/controller.ts#L171-L200),
[body validation](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-publication/templates.ts#L46-L77)).
Patchback preparation also validates and copies the exact snapshot record
([patchback use](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/patchback/controller.ts#L334-L405)).

Removing this reader repeats a known failure mode and breaks those recovery
paths for `v2.0.1` through `v2.0.3`.

## 5. Tagged `workspace-packages` v1 API and contract test

**Verdict: keep both. They are the current permanent interface.**

The API intentionally includes private workspaces in its stable catalog so the
trusted consumer, rather than the snapshot, derives the public package set. It
computes the repository root relative to its own tagged location and promises
stable location ordering without installed dependencies
([API](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/api/v1/workspace-packages.ts#L1-L31)).
The API policy says its path, exports, inputs, result shape, ordering, and
failure contract are permanent for the lifetime of v1
([API policy](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/api/README.md#L1-L23)).

The consumer contract fixes the zero-argument signature, readonly asynchronous
return, and four required fields at compile time
([contract](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/test/contracts/workspace-packages-v1.ts#L1-L32)).
It is included in strict script typechecking through `test/**/*.ts`
([TypeScript project](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/tsconfig.scripts.json#L1-L26)).
The zero-install checker separately confines the computed loader to the fixed
version table and exact snapshot path
([static rule](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/zero-install/check-imports.ts#L80-L118),
[sole exception](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/zero-install/check-imports.ts#L468-L485)).

Git history shows it was introduced as the native successor in
[`e625ddc`](https://github.com/fablebookjs/lab-02/commit/e625ddc94a2ecd554de0c0101ae6799e6d57ea6c).
Tag containment starts at `v3.4.0`; the older ten stable tags are exactly why the
fallback remains. Deleting this interface would force every future snapshot
back onto the command adapter and reverse the intended migration.

## 6. Thin GitHub workflow handlers

**Verdict: keep. Thinness is their interface, not evidence of obsolescence.**

The repository explicitly defines one default-exported handler per workflow
operation. The handler receives injected `{ github, context, core, env }`,
validates/narrows the boundary, and invokes narrower controller logic
([handler architecture](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/README.md#L1-L21),
[typed runtime](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/runtime.ts#L1-L57)).
This lets YAML remain declarative while TypeScript owns input mapping.

An exact current-tree comparison found 31 files with
`export default async function handler` and 31 unique
`scripts/github/*.ts` paths loaded by checked-in workflows. The sets are
identical: there is no unreferenced handler and no workflow reference without a
handler. The direct callers are the current workflow files under
[`.github/workflows`](https://github.com/fablebookjs/lab-02/tree/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows),
including stable maintenance
([prepare/apply](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/maintain-release-proposal.yml#L38-L94)),
stable publication
([four handlers](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/complete-stable-publication.yml#L46-L180)),
prerelease publication
([seven handlers](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/publish-prerelease.yml#L58-L288)),
patchback
([three handlers](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/maintain-patchback.yml#L51-L131)),
and PR checks
([route/description](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/pull-request-description-check.yml#L26-L52)).

For example, the small promotion prepare handler only converts named
environment inputs to the controller's explicit options
([handler](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-publication/prepare-promotion.ts#L1-L16)),
and its workflow directly loads that exact file
([caller](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/promote-latest.yml#L54-L64)).
Folding these back into controllers or YAML would erase the named trust-boundary
entrypoints without removing behavior.

## 7. `.agents/.../inspect-patchback-pr.mjs`

**Verdict: keep its behavior, but migrate the implementation to TypeScript and
shared Patchback modules.**

The file is the mandatory inspection command in the checked-in
`gh-finish-patchback` skill
([skill call](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.agents/skills/gh-finish-patchback/SKILL.md#L12-L32)).
It imports the current patchback identity, schema marker, and repository
constants rather than embedding an old protocol
([imports](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.agents/skills/gh-finish-patchback/scripts/inspect-patchback-pr.mjs#L1-L14)).
It validates the live PR shape, immutable queue commands, full OIDs,
coordination trailers, newest check runs, and Migration conflict tasks before
returning a machine-readable report
([queue validation](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.agents/skills/gh-finish-patchback/scripts/inspect-patchback-pr.mjs#L86-L190),
[PR/report validation](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.agents/skills/gh-finish-patchback/scripts/inspect-patchback-pr.mjs#L192-L311)).

The current test invokes the real command and proves it accepts generated
schema-4 Migration tasks
([test](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/test/patchback-inspector.test.ts#L11-L113)).
As a live cross-check during this research, the command successfully inspected
merged schema-4 patchback [#194](https://github.com/fablebookjs/lab-02/pull/194):
it reported `valid: true`, `queueResolved: true`, the correct snapshot and
boundary, and the current Migration-conflict item.

The `.mjs` extension predates the main script tree's TypeScript conversion. The
skill lives outside the original three statically checked zero-install zones,
which is why the active implementation was missed by that conversion. It is
also the repository's only programmatic `gh` CLI caller: normal
`scripts/github` modules use explicit GitHub clients and tokens instead.

The applied migration keeps subprocess and ambient `gh` authentication inside
the local skill adapter. Deterministic body parsing and PR inspection moved to
`scripts/shared/patchback`, while the skill now contains only a small `.ts`
adapter that obtains untrusted JSON and prints the shared report. `.agents`
TypeScript is included in strict type, escape, and zero-install import checks;
agent tools may import `shared` but cannot import `scripts/github`.

## 8. Release and Migration Markdown files

**Verdict: keep. These are durable domain records, not executable compatibility
shims.**

Stable proposal generation creates one deterministic changes-only record at
`releases/vX.Y.Z.md`
([renderer](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-communication/records.ts#L235-L265),
[proposal materialization](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-proposal/controller.ts#L399-L412)).
Stable publication reads that exact snapshot file and cross-checks it against
the authorized PR communication before rendering a GitHub Release
([publication](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-publication/controller.ts#L171-L200),
[cross-check](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-publication/templates.ts#L51-L77)).
Patchback then carries that exact record onto main
([patchback manifest](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/patchback/controller.ts#L401-L457)).

Migration Markdown is independently authored guidance. Current parsing requires
exact `introduced-in` and `priority` metadata, a single title, and nonempty
“Who is affected” and “How to migrate” sections
([parser](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-communication/records.ts#L356-L468)).
Current selection includes only records belonging to the exact release version
([selection](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-communication/records.ts#L534-L602)).
CI rejects deletion, rename, or `introduced-in` changes after release while
still permitting corrections to the guidance body
([evolution policy](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/release-communication/migration-policy.ts#L59-L108),
[repository validation](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/release-communication/validate.ts#L39-L67)).

That persistence is the feature: users can follow tag-pinned Migration links,
and maintainers can prove each patchback converged the release facts and
guidance onto main. Deleting the checked-in records would discard release
accounting, violate the stated evolution policy, and make current validation,
publication, or patchback paths incomplete. Their being historical does not
make them “legacy code.”

## 9. Unmanaged prerelease `inactive` state

**Verdict: remove the expected `inactive` path; make a missing boundary fail
closed. Also rename or replace the legacy-specific test and update the README.**

The planner currently treats a missing managed boundary with no staged state as
a successful `inactive` no-op, while rejecting the same missing boundary if a
PR or staged ref exists
([planner](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/shared/prerelease-proposal/core.ts#L157-L175)).
That action crosses the inert transition schema
([schema](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/prerelease-proposal/transition-schema.ts#L14-L27),
[parser](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/prerelease-proposal/transition-schema.ts#L94-L118))
and is silently skipped by the writer
([controller](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/prerelease-proposal/controller.ts#L320-L340)).
Its only focused test literally calls the fixture “the legacy development line”
and uses the pre-system `3.1.0-alpha.0`
([test](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/test/prerelease-proposal-core.test.ts#L72-L97)).

That bootstrap condition no longer exists on trusted main. Commit
[`e7cf3a0`](https://github.com/fablebookjs/lab-02/commit/e7cf3a066034ccfefe4b85c1c8daa5cc71f0a709)
is the structurally valid `7.0.0-alpha.0` managed bootstrap and is on the current
first-parent history. The current boundary finder returns the newest proven
bootstrap, phase-entry, or ordinary prerelease snapshot
([finder](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/scripts/github/release-history/history.ts#L304-L362)).
During this audit it resolved `e7cf3a0` and `7.0.0-alpha.0` from exact current
HEAD.

Main's active GitHub ruleset prohibits branch deletion and non-fast-forward
updates, requires merge commits and current checks, and is active on the default
branch
([first-party ruleset API](https://api.github.com/repos/fablebookjs/lab-02/rulesets/19392585)).
The maintenance workflow also checks out current `main`, not the old event
snapshot
([workflow](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/.github/workflows/maintain-prerelease-proposal.yml#L17-L40)).
Every future fast-forward descendant therefore retains at least one managed
boundary.

If current trusted main ever has no structurally valid boundary, that means its
history or release invariants are broken. Returning success would hide the
problem. The cleaner current contract is:

- `findManagedPrereleaseBoundary(...) === null` throws during preparation;
- `inactive` disappears from the plan and serialized action unions;
- apply handles only the normal `none` no-op; and
- the test asserts the missing-boundary error without calling the fixture
  “legacy,” or is deleted if the controller-level error fully covers it.

The README's bootstrap-era statement about the pre-system 3.1 line
([current wording](https://github.com/fablebookjs/lab-02/blob/f6260f66bea17ee981335c1653debfc1c4b73235/README.md#L126-L140))
can be replaced with the current fact that prerelease maintenance requires and
derives authority from the latest managed snapshot. The immutable Git history
already preserves what happened; current operational documentation need not
carry the retired transition.

## Resolution applied

The obsolete and inconsistent cases were resolved together:

- the current `list-packages` wrapper and package command were deleted;
- the completed v6 Release-PR replacement action and marker probe were deleted;
  and
- prerelease maintenance now requires a managed boundary and fails explicitly
  when one is missing, instead of serializing an `inactive` success; and
- the Patchback inspector is now a skill-local TypeScript `gh` adapter over a
  shared, typed Patchback body and inspection interface.

Their coupled types, transition schemas, controller branches, tests, and README
wording were updated. A new integration test proves that a repository without
managed prerelease history fails before any GitHub observation. The historical
package fallback and historical release-record reader were deliberately kept.

The migrated adapter also successfully inspected merged schema-4 Patchback
[#194](https://github.com/fablebookjs/lab-02/pull/194) through the authenticated
`gh` session. It returned `valid: true`, all four resolved queue items, the
latest required checks, and the exact snapshot, boundary, and coordination
commit.

After the cleanup, `npm run check` passed in full: release communication
validation, TypeScript compilation and type checking, the zero-install import
and type-escape checks, all 217 tests, and the packed two-package consumer
smoke test.
