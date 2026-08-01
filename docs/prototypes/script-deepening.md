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
- Give pilot repository identity and its primary branch one shared semantic
  owner, while keeping derived refs visible at their call sites.
- Reuse one generic regular-expression escaping invariant where exact generated
  URLs must be recognized.
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

The publication-slice counts cover the five changed existing modules and the
three new publication/template modules. “Executable” is a simple proxy: raw
lines minus blank lines and comment-only lines.

| Measure | Before | Prototype | Change |
|---|---:|---:|---:|
| Raw production TypeScript lines | 1,932 | 2,166 | +234 |
| Blank lines | 115 | 142 | +27 |
| Comment-only lines | 0 | 113 | +113 |
| Executable-line proxy | 1,817 | 1,911 | +94 |
| Shared stable/prerelease core lines | 625 | 518 | -107 |
| Duplicate controller completion blocks | 53 | 37 | -16 |
| Named export declarations | 57 | 57 | 0 |

The raw increase is real. The embedded utility contributes 93 lines, including
its 31-line MIT notice, while new contextual documentation contributes most of
the remaining comment-only increase. The five pre-existing publication files
shrink from 1,932 to 1,903 lines; the three explicit new owners add 263 lines.

The separate constant consolidation is deliberately measured across its wider
mechanical reach:

| Measure | Before | Prototype | Change |
|---|---:|---:|---:|
| Repository-identity definitions | 7 | 1 | -6 |
| Direct primary-branch literals in the changed production set | 33 | 0 | -33 |
| Raw production TypeScript lines in that set | 9,535 | 9,576 | +41 |
| Named export declarations in that set | 212 | 211 | -1 |

Across every changed production TypeScript file, raw LOC rises from 9,440 to
9,713 (+273), the executable-line proxy rises from 8,877 to 9,010 (+133), and
named exports rise from 212 to 213 (+1). Constant ownership improves without
creating a total-LOC or total-surface win.

### Measurement limits

- Locality has a concrete proxy: GitHub-specific rendering leaves the shared
  stable/prerelease cores, which shrink by 107 lines, and is owned by two
  feature-local template modules.
- Interface depth has only partial proxies. The named export count stays flat
  for the publication slice, while 53 controller-visible completion lines
  become 37 controller lines plus one 44-line, two-call-site mechanic. That
  supports a qualitative depth improvement but is not a scalar depth measure.
- Test readability has no defensible numeric measure here. Two tests gain
  feature-specific renderer imports and names while their cases and assertions
  remain unchanged. The clearer intent is a qualitative review judgement.

## Observations

- **Locality improves.** A reader looking for human-facing GitHub presentation
  now finds it beside each GitHub publication controller. The zero-install
  domain cores lose 107 lines of GitHub-specific presentation assembly.
- **The controller seam becomes more intentional.** Both controllers delegate
  the same tag-and-Release state matrix to a two-call-site mechanic, while their
  policy-specific completion decisions and exact errors remain visible.
- **Test intent becomes more explicit.** Existing assertions and cases remain
  unchanged, but rendering tests now import from a GitHub template owner instead
  of a general release domain core. This is not evidence of a measurable
  readability gain.
- **Interface depth improves locally, not globally.** The mechanic hides a
  meaningful coordination rule and `dedent` hides nontrivial indentation logic.
  The publication-slice export count stays flat, but the complete prototype
  still adds one named export; this is not an entity-count reduction.
- **LOC does not improve overall.** The slice trades more total code for clearer
  ownership, reusable mechanics, attributed template ergonomics, and guidance.
  It should not be presented as a line-count reduction.
- **Behavior stayed stable under the available proof.** The focused stable and
  prerelease publication suite passes 23/23 tests. The full `npm run check`
  passes 181/181 tests, the zero-install dependency-graph check, script
  type-checking, release-communication validation, and packed-consumer
  verification.

## Prototype conclusion

This slice measurably improves locality and removes repeated repository facts,
while total LOC and total named exports regress. Interface depth and test intent
look better under review, but the available proxies do not establish a numeric
improvement. The design is representative only if that trade is acceptable; it
is not evidence that the wider refactor will reduce LOC or exported entities.
