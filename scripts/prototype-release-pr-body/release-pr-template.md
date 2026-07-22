# Release {{version}}

> [!WARNING]
> **This release does not promote `latest`.**  
> Merging publishes {{version}} to the [`{{npm_channel}}` npm channel]({{npm_versions_url}}). After publication and channel testing, a maintainer may run [**Promote latest**]({{promote_latest_url}}) separately.

| | |
| --- | --- |
| Release line | [`releases/{{line}}`]({{release_branch_url}}) |
| Proposal branch | [`staged/{{line}}`]({{proposal_branch_url}}) |
| Version | **{{version}}** |
| npm channel | [`{{npm_channel}}`]({{npm_versions_url}}) |
| QA workspace | [Release QA {{version}} companion issue]({{qa_issue_url}}) |

## Maintainer procedure

### 1. Review the exact proposal

Open the live **Release QA** check. Confirm that the linked release-line commit, proposal commit, and included changes are the version you intend to test.

### 2. QA every included change

For every item below, perform the relevant manual QA against this exact proposal. Check the item only when the observed behavior is acceptable and every related finding is resolved or explicitly judged not applicable.

{{#changes}}
- [{{checkmark}}] [{{title}}]({{url}}) <!-- fablebook:change={{key}} -->
{{/changes}}

A change introduced without a PR uses the same checklist format with its merge or commit URL. The required unchecked-task check prevents merge until every included change and release-level item is checked.

<details>
<summary>How to QA a change and record findings</summary>

1. Open the linked PR or commit and decide which behavior needs manual verification.
2. Exercise that behavior against this exact proposal.
3. If you find a problem, create it as a sub-issue of the [Release QA {{version}} companion issue]({{qa_issue_url}}) and link the affected PR or commit.
4. Resolve or explicitly dispose every applicable finding, then check the included change above.

</details>

### 3. Confirm release readiness

- [{{discussions_checkmark}}] Ensure all discussions on the release have been resolved <!-- fablebook:check=discussions-resolved -->
- [{{release_docs_checkmark}}] [Breaking changes]({{changelog_url}}) and [migration notes]({{migration_url}}) have been reviewed <!-- fablebook:check=release-docs-reviewed -->

### 4. Authorize publication

Mark this PR ready for review, obtain the normal approval, then merge it. Merging authorizes the following operations for the exact proposal commit:

1. Publish the complete package set as **{{version}}** under the linked [`{{npm_channel}}` channel]({{npm_versions_url}}).
2. Create the linked Git tag and GitHub Release [`v{{version}}`]({{github_release_url}}) for the exact merge commit.
3. Create one checklist-only patchback PR targeting [`main`]({{main_branch_url}}); progress and any failure are visible in the [Maintain patchback action log]({{patchback_log_url}}).

### 5. Test the published channel

1. Wait for the [Publish stable release action]({{publish_log_url}}) to succeed.
2. Run the clean-install smoke test below and confirm every package resolves to version **{{version}}**.

<details>
<summary>Clean-install smoke-test commands</summary>

```sh
{{{smoke_test_commands}}}
```

</details>

### 6. Decide whether to promote `latest`

If channel testing is acceptable and {{version}} should become the npm default, run [**Promote latest**]({{promote_latest_url}}) with version **{{version}}**. Otherwise, do nothing; the existing `latest` tags remain unchanged.

---

When this proposal is regenerated, automation re-renders this template. Checkbox state is restored by the stable keys in the hidden comments; newly included changes start unchecked.
