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

Press `d` to load the suggested end-to-end journey, then `v` to cycle through
the generated artifacts. Press `z` to reset and drive each event manually.

This directory is deliberately disposable. It performs no GitHub, npm, or
filesystem mutations.
