# PROTOTYPE — connected prerelease journey

This throwaway prototype asks whether one small event model produces the
accepted maintainer journey and visible artifacts: work on `main`, ordinary
Prerelease PRs, direct phase-entry prereleases, a release cut with two
independent outcomes, and an initial stable release that accounts for the full
development line plus post-cut fixes without reading prerelease release notes.

Run it with:

```sh
npm run prototype:prerelease-journey
```

The command opens a narrated eight-step journey. Press `n` to move forward,
`p` to move back, and `a` to cycle through the concrete artifacts available at
the current point in time.

This directory is deliberately disposable. It performs no GitHub, npm, or
filesystem mutations.
