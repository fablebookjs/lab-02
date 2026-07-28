import { add, normalizeLabel } from '@fablebook/lab-02-core';

export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}

export function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : total(values) / values.length;
}

export function count(values: number[]): number {
  return values.length;
}

export function formatSummary(
  label: string,
  values: number[],
  locale = 'en-US'
): string {
  return `${normalizeLabel(label, locale)}:${total(values)}`;
}

export function formatAverageSummary(
  label: string,
  values: number[],
  locale = 'en-US'
): string {
  return `${normalizeLabel(label, locale)}:${average(values) ?? 'n/a'}`;
}

export function formatCountSummary(
  label: string,
  values: number[],
  locale = 'en-US'
): string {
  return `${normalizeLabel(label, locale)}:${count(values)}`;
}
