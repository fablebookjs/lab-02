---
introduced-in: 5.1.1
priority: optional rounded-average summary adoption
---
# Use rounded-average summaries

## Who is affected

Consumers that combine `average`, `Math.round`, and manual empty-value handling
can use the new rounded-average helpers. Existing average summaries are
unchanged, so this migration is optional.

## How to migrate

Replace manually rounded averages:

```ts
const value = average(values);
const summary = `${normalizeLabel(label)}:${value === undefined ? 'n/a' : Math.round(value)}`;
```

with `formatRoundedAverageSummary`:

```ts
import { formatRoundedAverageSummary } from '@fablebook/lab-02-addon';

const summary = formatRoundedAverageSummary(label, values);
```

Use `roundedAverage(values)` when only the numeric value is needed. Pass locale
options as the third formatter argument when label normalization is
locale-sensitive.
