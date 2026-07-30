# Tagged Release APIs

`scripts/api/**` contains permanent, versioned interfaces that trusted release
tooling may load from an exact tagged repository snapshot. An interface path,
its exports, inputs, result shape, ordering, and failure contract remain stable
for the lifetime of that version. Incompatible changes require a new version.

## Runtime boundary

API modules may runtime-import:

- `node:*` built-ins;
- explicit relative `.ts` modules inside `scripts/api/**`; and
- explicit relative `.ts` modules inside `scripts/shared/**`.

They may not runtime-import GitHub handlers, repository packages, installed
feature tooling, aliases, absolute paths, or unresolved targets. External
package types are permitted only through declaration-level `import type` or
`export type`. Computed dynamic imports and top-level `await` are forbidden.

Post-install CI statically checks every runtime edge and TypeScript checks the
permanent consumer contracts. Tagged API code executes only in credentialless
preparation; privileged jobs consume validated inert artifacts.
