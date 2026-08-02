---
introduced-in: 6.0.0
priority: empty first-value summary expectations
---
# Handle empty first-value summaries

## Who is affected

Consumers that compare or display the exact output of `formatFirstSummary` for
an empty collection are affected. In 6.0, the empty value is rendered as
`unavailable` instead of `n/a` so it is clear that the collection has no first
value.

## How to migrate

Update exact comparisons and snapshots from `label:n/a` to
`label:unavailable`:

```ts
const summary = formatFirstSummary('Scores', []);

expect(summary).toBe('scores:unavailable');
```

If an application needs custom empty text, handle the empty collection before
calling the formatter or translate `unavailable` at the final display
boundary. Populated first-value summaries are unchanged.
