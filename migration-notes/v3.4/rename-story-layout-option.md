---
priority: required API updates
---
# Rename the story layout option

## Who is affected

Consumers that pass the `layout` option to `formatChapterNavigation` must
rename that property. Calls that use the default trail layout are unchanged.

## How to migrate

Rename `layout` to `storyLayout` without changing its value:

```ts
// Before
formatChapterNavigation(chapters, { layout: 'current' });

// After
formatChapterNavigation(chapters, { storyLayout: 'current' });
```
