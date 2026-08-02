---
introduced-in: 5.1.0
priority: empty last-value summary expectations
---
# Handle empty last-value summaries

## Who is affected

Consumers that compare or display the exact output of `formatLastSummary` for
an empty collection are affected. In 5.1, the empty value is rendered as
`none` instead of `n/a` so it is distinct from an unavailable calculation.

## How to migrate

Update exact comparisons and snapshots from `label:n/a` to `label:none`:

```ts
const summary = formatLastSummary('Scores', []);

expect(summary).toBe('scores:none');
```

If an application needs a custom empty label, handle the empty collection
before calling the formatter rather than treating `none` as missing data.

Populated last-value summaries are unchanged.
