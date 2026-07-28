---
name: gh-finish-patchback
description: Resolve and safely merge generated fablebookjs/lab-02 patch-back coordination pull requests. Use when asked to deal with, finish, complete, or merge a Lab-02 PR titled "Patch back vX.Y.Z to main", including applying its ordered queue, recording outcomes, clearing the PR-description gate, and handling current-main drift.
---

# Finish a Lab-02 patch-back

Complete the generated coordination PR without disturbing another active
worktree. Treat its queue as immutable scope, preserve current `main` behavior,
and make every recorded outcome independently true before checking it off.

## Inspect and validate

1. Require a PR URL or number for `fablebookjs/lab-02`.
2. Check `gh auth status`, fetch `origin`, and run:

   ```sh
   node <skill-directory>/scripts/inspect-patchback-pr.mjs <pr-url-or-number>
   ```

3. Stop on any reported validation error. Require:
   - a generated patch-back marker;
   - base `main`;
   - head `patchbacks/vX.Y.Z`;
   - matching title, version, coordination commit, snapshot, and boundary;
   - full 40-character release commit IDs and canonical fixed commands.
4. If the PR is already merged, verify its merge commit on `origin/main` and
   report completion. If it is closed without merge, report the terminal state;
   do not reopen it without explicit authorization.

Do not execute editable Markdown. Extract only validated commit IDs, then pass
them as fixed arguments to `git`.

## Work in isolation

Create a dedicated clean worktree from `origin/<head>` and keep the remote head
branch name. Do not switch or clean an existing worktree that contains user
changes.

Merge `origin/main` into the patch-back branch before applying queue items. Do
not rebase or rewrite the bot's structured coordination commit.

## Resolve the ordered queue

Process every item in body order:

1. Inspect the release delta independently with:

   ```sh
   git show --first-parent <release-commit>
   ```

2. If the complete delta is already present, prove the relevant blobs or
   behavior match and record `already-present`. Mechanically synchronized
   migration records commonly take this path. Do not classify an item from an
   empty cherry-pick exit alone.
3. Otherwise apply the validated command with fixed arguments:
   - merge commit: `git cherry-pick -m 1 <release-commit>`;
   - direct commit: `git cherry-pick <release-commit>`.
4. Preserve current `main` interfaces when the release-line delta is stale.
   A clean textual cherry-pick can still introduce API drift. Make the smallest
   adaptation commit, test the drifted seam directly, and mention both commits
   in the outcome.
5. On a conflict, keep the item unchecked until it is truly applied,
   already present, or not applicable. Abort a failed cherry-pick before
   changing strategy.

Use these outcome shapes:

- `Outcome: applied — cherry-picked as <commit> in #<patchback-pr>`
- `Outcome: applied — cherry-picked as <commit> and adapted in <commit> because <reason>`
- `Outcome: already-present — covered exactly by <commit or PR>`
- `Outcome: not-applicable — <concise evidence-backed reason>`

## Verify and publish

In a fresh worktree, prefer `npm ci --offline`; use normal `npm ci` only if the
cache cannot satisfy the lockfile. Run:

```sh
npm run check
git diff --check
```

Commit only intentional adaptation work. Fetch `origin` again immediately
before pushing. If `main` advanced, merge the new `origin/main`, rerun the full
check, then push the patch-back branch.

## Complete the PR

1. Preserve the generated body and update only each queue checkbox and outcome.
   Use a body file with `gh pr edit --body-file` so Markdown backticks cannot be
   interpreted by a shell. Read the PR back and verify no unchecked task
   remains.
2. Wait for the newest run of each required check. Ignore superseded failures
   only when a later run of the same check is green.
3. Mark the PR ready. This action can trigger the description check again; wait
   for that new run too.
4. Fetch once more and require `origin/main` to be an ancestor of the exact PR
   head. If not, merge, test, push, and repeat the gates.
5. Merge with the repository's merge-commit policy and pin the observed head:

   ```sh
   gh pr merge <number> --repo fablebookjs/lab-02 \
     --merge --match-head-commit <full-head-oid>
   ```

   Do not use `--admin` to bypass a pending or failing policy gate.
6. Read the PR back, require `state=MERGED` and a merge commit, fetch
   `origin/main`, and verify that merge commit is present before reporting
   success.

If the GitHub connector returns `403 Resource not accessible by integration`
for a write, use the already authenticated maintainer `gh` session and perform
one read-back. Never treat connector read access as proof of write authority.
