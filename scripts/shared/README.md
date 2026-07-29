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

## How type safety works

1. **Execution:** Node 24 strips erasable TypeScript syntax and executes the
   remaining JavaScript. It does not type-check, apply `tsconfig` aliases, or
   transform unsupported TypeScript constructs.
2. **Type correctness:** after `npm ci`, CI runs TypeScript strict mode with
   `noEmit`, `erasableSyntaxOnly`, and `verbatimModuleSyntax`. Implicit-any
   cleanup remains a visible migration exception; new shared boundaries should
   still declare their types.
3. **Dependency boundary:** post-install CI inspects every strict source and
   its runtime edges. A separate pre-install smoke imports the graph while
   repository packages are absent.

If shared logic needs a runtime package, move it to an installed
`scripts/<feature>/**` directory. If it becomes Actions-specific, move it to
`scripts/github/**`. Keep any type suppression narrow and explain it where it
appears.
