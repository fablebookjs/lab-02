export function add(left: number, right: number): number {
  return left + right;
}

export function normalizeLabel(value: string, locale = 'en-US'): string {
  return value.trim().toLocaleLowerCase(locale);
}

export function normalizeLabels(
  values: string[],
  locale = 'en-US'
): string[] {
  return values.map((value) => normalizeLabel(value, locale));
}
