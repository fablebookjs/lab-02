<!-- fablebook:release-pr=v7 -->
<!-- fablebook:release-kind=initial -->
<!-- fablebook:proposal={{proposal_oid}} source={{release_oid}} version={{version}} -->
# Release {{version}}

> [!WARNING]
> **This release does not promote `latest`.**
> Merging publishes {{version}} to the [`{{npm_channel}}` npm channel]({{npm_versions_url}}). After publication and channel testing, a maintainer may run [**MANUAL - Publish: Promote to latest**]({{promote_latest_url}}) separately.

| | | | |
| --- | --- | --- | --- |
| Release line | [`releases/{{line}}`]({{release_branch_url}}) | Proposal branch | [`staged/{{line}}`]({{proposal_branch_url}}) |
| Version | **{{version}}** | npm channel | [`{{npm_channel}}`]({{npm_versions_url}}) |
| Release source | [`{{release_short_oid}}`]({{release_commit_url}}) | Proposal commit | [`{{proposal_short_oid}}`]({{proposal_commit_url}}) |
| QA | Required checklist below | Packages | {{package_count}} published together |

## Why upgrade

<!--
Write the short, user-facing reasons to upgrade. This marked block is preserved
when the same initial-line release proposal is refreshed or replaced.
-->

{{why_upgrade}}

## Included changes and manual QA

Perform the relevant manual QA for every unchecked item against this exact proposal. A checked generated item explicitly says why no manual QA is required.

{{changes}}

<details>
<summary>How to QA a change and record findings</summary>

1. Open the linked PR or commit and decide which behavior needs manual verification.
2. Exercise that behavior against this exact proposal.
3. Discuss findings in this release PR. Open a normal issue only for independent long-term tracking.
4. Resolve or explicitly dispose every applicable finding, then check the included change.

</details>

{{migration_section}}

## Confirm release readiness

- [{{discussions_checkmark}}] Resolve all release discussions. <!-- fablebook:check=discussions-resolved -->
- [ ] Confirm that included change titles and `release-note:skip` / `qa:skip` labels still match their source PRs; if not, close this release PR and let automation regenerate it. <!-- fablebook:check=source-metadata-current -->
- [ ] Review the release communication and any migration records. <!-- fablebook:check=release-docs-reviewed -->

## Authorize and test

1. Mark this PR ready, obtain the normal approval, and merge it.
2. Wait for the [Publish: Publish approved release action]({{publish_log_url}}) to publish the complete package set and create [`v{{version}}`]({{github_release_url}}).
3. Confirm progress or failure of the checklist-only patchback in the [Release: Prepare patchback PR action log]({{patchback_log_url}}).
4. Run the clean-install smoke test below and confirm every package resolves to **{{version}}**.
5. If channel testing is acceptable and {{version}} should become the npm default, run [**MANUAL - Publish: Promote to latest**]({{promote_latest_url}}) with version **{{version}}**. Otherwise, do nothing.

<details>
<summary>Clean-install smoke-test commands</summary>

```sh
{{smoke_test_commands}}
```

</details>

{{superseded_notice}}

<!--
Automation re-renders this template whenever it generates the proposal. It
preserves same-version Why upgrade text and compatible per-change QA state.
The metadata-freshness and communication-review checks always reset.
-->
