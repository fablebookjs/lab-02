export function add(left: number, right: number): number {
  return left + right;
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
