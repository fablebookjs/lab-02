# GitHub zero-install handlers

`scripts/github/**` contains Actions-specific TypeScript handlers. Each
workflow operation has one default-exported handler that receives
`{ github, context, core, env }` from the pinned `actions/github-script` host.
Handlers validate event and environment data before invoking narrower logic.

## Runtime boundary

GitHub modules may runtime-import:

- `node:*` built-ins;
- explicit relative `.ts` modules inside `scripts/github/**`; and
- explicit relative `.ts` modules inside `scripts/shared/**`.

They may not runtime-import repository packages, installed feature tooling,
aliases, absolute paths, or unresolved targets. GitHub, context, and core are
injected capabilities rather than runtime imports. External package types are
permitted only through declaration-level `import type` or `export type`.
Top-level `await` is forbidden because `github-script` loads the graph through
its synchronous `require(...).default` bridge.

## How type safety works

1. **Execution:** the action's Node 24 runtime strips erasable TypeScript
   syntax. The concise `require(...).default` loader requires the complete
   imported ESM graph to avoid top-level `await`.
2. **Type correctness:** after `npm ci`, CI checks the handlers and shared
   modules with TypeScript. Runtime execution itself does not type-check.
3. **Dependency boundary:** post-install CI statically checks every runtime
   edge. A separate pre-install smoke loads the real graph without repository
   packages, including a representative handler through the pinned action.

Handlers publish independently consumed values with `core.setOutput`. Expected
no-op decisions succeed with explicit outputs; malformed or unsafe state throws
a sanitized error.
