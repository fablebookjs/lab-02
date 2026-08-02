---
introduced-in: 5.1.0
priority: optional maximum summary adoption
---
# Adopt maximum summaries

## Who is affected

Consumers that manually combine a normalized label with `Math.max` to display
the highest value in a collection can use the new maximum-summary helper.
Existing summary formatting continues to work, so this migration is optional.

## How to migrate

Replace the manually assembled label and maximum:

```ts
import { normalizeLabel } from '@fablebook/lab-02-core';

const value = values.length === 0 ? 'n/a' : Math.max(...values);
const summary = `${normalizeLabel(label)}:${value}`;
```

with `formatMaximumSummary`:

```ts
import { formatMaximumSummary } from '@fablebook/lab-02-addon';

const summary = formatMaximumSummary(label, values);
```

Pass locale options as the third argument when the label needs locale-aware
normalization:

```ts
const summary = formatMaximumSummary(label, values, { locale: 'tr' });
```
