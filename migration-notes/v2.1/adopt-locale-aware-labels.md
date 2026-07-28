---
priority: optional locale adoption
---
# Adopt locale-aware label normalization

## Who is affected

Consumers that need labels to follow casing rules for a locale other than the
default `en-US` behavior.

## How to migrate

Pass the desired locale as the second argument to `normalizeLabel`:

```ts
normalizeLabel(' İSTANBUL ', 'tr');
```

Consumers that want the existing default do not need to change anything.
