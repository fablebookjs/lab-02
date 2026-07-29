# PROTOTYPE — credentialless tagged package-set loader

This throwaway prototype asks whether one trusted, credentialless loader can
select the newest supported Tagged Release API from an exact snapshot, use the
legacy npm command only when no native interface exists, and normalize both
paths into the same release package set without falling back from a broken
native interface.

Run it interactively:

```sh
npm run prototype:package-loader
```

The four scenarios are native, legacy, broken native with a valid legacy
command, and unsupported. The native implementation works through a computed
dynamic import. Running `npm run check:zero-install-imports` demonstrates the
design tension: the current static policy rejects that import even though the
path was selected from a fixed supported-version table and checked as a regular
file.
