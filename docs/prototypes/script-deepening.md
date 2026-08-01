# Throwaway prototype: script deepening

> This branch is a disposable design probe. It is not a production proposal or
> a new source of release-policy authority.

## Question

Does one behavior-preserving release-publication slice become easier to
understand after applying the agreed placement, utility, controller-seam,
template, and documentation rules?

The prototype is pinned to Lab-02 commit
`67205a7c10f6ecf4420cfb7c83e537d4b269266c` and uses stable and prerelease
GitHub Release completion and rendering as the representative slice.

## Scope

- Move public GitHub Release rendering from zero-install domain cores to
  feature-local `templates.ts` modules.
- Embed an attributed zero-install `dedent` utility for readable multiline
  templates.
- Replace duplicated exact-tag and GitHub-Release observation with one neutral
  mechanic used by both controllers.
- Keep stable and prerelease policy, controller flow, and error wording local.
- Inline the single-use stable renderer options type.
- Add contextual JSDoc and a small root terminology table.

The prototype does not change release policy, GitHub or npm effects, workflow
entry points, or the intentionally different prerelease body check. It adds no
new hardening and no new tests.

## Run

```sh
npm run check
```

## Measurements

The production-TypeScript counts cover the five changed existing modules and
the three new modules. “Executable” is a simple proxy: raw lines minus blank
lines and comment-only lines.

| Measure | Before | Prototype | Change |
|---|---:|---:|---:|
| Raw production TypeScript lines | 1,932 | 2,164 | +232 |
| Blank lines | 115 | 142 | +27 |
| Comment-only lines | 0 | 113 | +113 |
| Executable-line proxy | 1,817 | 1,909 | +92 |
| Shared stable/prerelease core lines | 625 | 520 | -105 |
| Duplicate controller completion blocks | 53 | 37 | -16 |
| Export declarations in the affected module set | 30 | 32 | +2 |

The raw increase is real. The embedded utility contributes 93 lines, including
its 31-line MIT notice, while new contextual documentation contributes most of
the remaining comment-only increase. The affected pre-existing production files
shrink from 1,932 to 1,899 lines; the three explicit new owners add 265 lines.

## Observations

- **Locality improves.** A reader looking for human-facing GitHub presentation
  now finds it beside each GitHub publication controller. The zero-install
  domain cores lose 105 lines of GitHub-specific presentation assembly.
- **The controller seam becomes more intentional.** Both controllers delegate
  the same tag-and-Release state matrix to a two-call-site mechanic, while their
  policy-specific completion decisions and exact errors remain visible.
- **Test intent becomes more explicit.** Existing assertions and cases remain
  unchanged, but rendering tests now import from a GitHub template owner instead
  of a general release domain core.
- **Interface depth improves locally, not globally.** The mechanic hides a
  meaningful coordination rule and `dedent` hides nontrivial indentation logic.
  However, the affected export surface grows by two declarations; this is not an
  entity-count reduction.
- **LOC does not improve overall.** The slice trades more total code for clearer
  ownership, reusable mechanics, attributed template ergonomics, and guidance.
  It should not be presented as a line-count reduction.
- **Behavior stayed stable under the available proof.** The focused stable and
  prerelease publication suite passes 23/23 tests. The full `npm run check`
  passes 181/181 tests, the zero-install dependency-graph check, script
  type-checking, release-communication validation, and packed-consumer
  verification.

## Prototype conclusion

This slice improves ownership, workflow locality, and the meaning of controller
seams without hiding stable/prerelease policy. It also shows the cost of applying
all documentation and template decisions at once: the result is clearer but
larger. The design is representative only if that trade is acceptable; it is
not evidence that the wider refactor will reduce LOC or exported entities.
