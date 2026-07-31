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
2. **Type correctness:** after `npm ci`, CI checks the handlers, shared
   modules, and repository tests with the full strict project. Runtime
   execution itself strips types and does not type-check.
3. **Dependency boundary:** post-install CI statically checks every runtime
   edge and the complete reachable zero-install graph.

Webhook payloads are `unknown` at the injected runtime boundary. Narrow
validated event views derive their field types from the exact pinned
`@octokit/openapi-webhooks-types` declaration package; only fields used by a
handler are accepted into its view.

Handlers publish independently consumed values with `core.setOutput`. Expected
no-op decisions succeed with explicit outputs; malformed or unsafe state throws
a sanitized error. `any`, assertions, and compiler suppressions require a
nearby `type-escape:` explanation and are mechanically inventoried; broad
`@ts-ignore` and `@ts-nocheck` directives are forbidden.

## Release module boundary

Stable and prerelease feature controllers are siblings. They do not import
one another's `controller.ts`; shared GitHub mechanics live in the neutral
`prepared-commit`, `release-history`, `package-publication`, and
`release-repository` directories instead. Feature controllers retain release
policy, communication, channel selection, and completion decisions. Neutral
GitHub mechanics depend only on pure `scripts/shared` modules and the release
repository adapter; pure Git commit inspection lives in
`scripts/shared/prepared-commit/inspection.ts` so mechanics never depend on a
sibling mechanics module. Prepared-commit mechanics also own exact bundle ref
verification before importing a prepared transition.
