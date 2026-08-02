---
introduced-in: 2.1.0
priority: required API updates
---
# Replace positional locale arguments with options

## Who is affected

Consumers that pass a locale string to `normalizeLabel`, `normalizeLabels`,
`formatSummary`, or `formatAverageSummary`. Calls that rely on the default
`en-US` locale are unchanged.

## How to migrate

Replace each positional locale string with an options object:

```ts
// Before
normalizeLabel(' İSTANBUL ', 'tr');
formatSummary(' TOTAL ', [2, 3], 'tr');

// After
normalizeLabel(' İSTANBUL ', { locale: 'tr' });
formatSummary(' TOTAL ', [2, 3], { locale: 'tr' });
```

Apply the same change to `normalizeLabels` and `formatAverageSummary`. The
normalized labels and formatted summaries are otherwise unchanged.
