export function add(left: number, right: number): number {
  return left + right;
}

export function multiply(left: number, right: number): number {
  return left * right;
}

export function subtract(left: number, right: number): number {
  return left - right;
}

export interface LabelNormalizationOptions {
  locale?: string;
}

export function normalizeLabel(
  value: string,
  { locale = 'en-US' }: LabelNormalizationOptions = {}
): string {
  return value.trim().toLocaleLowerCase(locale);
}

export function normalizeLabels(
  values: string[],
  options: LabelNormalizationOptions = {}
): string[] {
  return values.map((value) => normalizeLabel(value, options));
}

export type ChapterProgressVariant = 'compact';

export interface ChapterNavigationOptions {
  storyLayout?: 'current' | 'trail';
  progressVariant?: ChapterProgressVariant;
  currentChapter?: number;
}

const progressLabels: Record<ChapterProgressVariant, string> = {
  'compact': 'Reading progress',
};

const trailSeparators: Partial<Record<ChapterProgressVariant, string>> = {
  'compact': ' > ',
};

const untitledVariants = new Set<ChapterProgressVariant>(['compact']);

export function formatChapterNavigation(
  chapters: string[],
  options: ChapterNavigationOptions = {}
): string {
  const layout = options.storyLayout ?? 'trail';
  const variant = options.progressVariant;
  const normalizedChapters =
    variant && untitledVariants.has(variant)
      ? chapters.map((chapter) => chapter.trim() || 'Untitled chapter')
      : chapters;
  const visibleChapters = normalizedChapters;
  const separator = variant ? trailSeparators[variant] ?? ' > ' : ' > ';
  const current = Math.min(
    Math.max(options.currentChapter ?? visibleChapters.length, 0),
    visibleChapters.length,
  );
  const navigation =
    layout === 'current'
      ? current === 0
        ? ''
        : visibleChapters[current - 1] ?? ''
      : visibleChapters.join(separator);

  if (!variant) return navigation;
  return `${navigation} · ${progressLabels[variant]} ${current}/${visibleChapters.length}`;
}
