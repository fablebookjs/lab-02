export function add(left: number, right: number): number {
  return left + right;
}

export function normalizeLabel(value: string, locale = 'en-US'): string {
  return value.trim().toLocaleLowerCase(locale);
}
