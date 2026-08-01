# Shared zero-install scripts

`scripts/shared/**` is the reusable zero-install foundation for Lab-02
scripting. It may contain constants, types, parsers, transforms, package
discovery, and Node utilities. It is not GitHub-specific and does not require
multiple current consumers.

## Runtime boundary

Shared modules may runtime-import:

- `node:*` built-ins; and
- explicit relative `.ts` modules whose canonical paths remain inside
  `scripts/shared/**`.

They may not runtime-import repository packages, GitHub handlers, installed
feature tooling, aliases, absolute paths, or unresolved targets. External
package types are permitted only through declaration-level `import type` or
`export type`. Top-level `await` is forbidden so every shared module remains
loadable through the synchronous Actions bridge.

No runtime path reachable from `scripts/shared/**` may reach `node_modules`,
including through a transitive relative import. This is a property of the
complete runtime graph, not only of the imports written in shared files.

The sole computed-import exception is the selected Tagged Release API
entrypoint inside
`scripts/shared/package-publication/package-set.ts#loadReleasePackageSet`.
Static analysis confines it to a newest-first fixed path table and the exact
runtime snapshot. Every other dynamic import remains literal-only.

## How type safety works

1. **Execution:** Node 24 strips erasable TypeScript syntax and executes the
   remaining JavaScript. It does not type-check, apply `tsconfig` aliases, or
   transform unsupported TypeScript constructs.
2. **Type correctness:** after `npm ci`, CI runs TypeScript strict mode with
   `noEmit`, `erasableSyntaxOnly`, and `verbatimModuleSyntax`, plus the
   additional unsafe-access and control-flow checks in `tsconfig.scripts.json`.
   The runtime strips types completely, so only the installed CI check proves
   that the graph is type-correct.
3. **Dependency boundary:** post-install CI statically inspects every strict
   source and its complete reachable runtime graph.

JSON, environment, file, subprocess, and API data enters the graph as
`unknown` and is narrowed to the small domain shape each consumer needs.
Declaration-only package imports provide authoritative platform types without
creating runtime dependencies.

If shared logic needs a runtime package, move it to an installed
`scripts/<feature>/**` directory. If it becomes Actions-specific, move it to
`scripts/github/**`. `any`, assertions, and compiler suppressions require a
nearby `type-escape:` explanation and are mechanically inventoried; broad
`@ts-ignore` and `@ts-nocheck` directives are forbidden.

## Repository-fact boundary

Shared repository modules answer semantic questions that remain useful without
GitHub: which repository is open, which commit is `HEAD`, which packages exist,
or what a local Git history means. Their interfaces expose those facts rather
than command output or provider response shapes.

GitHub transport, authentication, REST response narrowing, and mutations stay
in `scripts/github/**`. A repository fact belongs in shared even with one
current consumer when its meaning is general and its interface is reusable; a
feature-specific step stays beside its controller until a credible reusable
operation emerges.
