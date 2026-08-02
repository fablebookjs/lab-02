---
introduced-in: 2.0.3
priority: adopt count summaries
---
# Adopt count-based summaries

## Who is affected

Consumers that manually combine a normalized label with `values.length` to
display the size of a collection can use the new count-summary helper instead.
Existing summary formatting continues to work, so this migration is optional.

## How to migrate

Replace the manually assembled label and count:

```ts
import { normalizeLabel } from '@fablebook/lab-02-core';

const summary = `${normalizeLabel(label)}:${values.length}`;
```

with `formatCountSummary`:

```ts
import { formatCountSummary } from '@fablebook/lab-02-addon';

const summary = formatCountSummary(label, values);
```

Pass a locale as the third argument when the label needs locale-aware
normalization:

```ts
const summary = formatCountSummary(label, values, 'tr');
```
