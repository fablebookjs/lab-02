import {
  add,
  normalizeLabel,
  subtract,
  type LabelNormalizationOptions,
} from '@fablebook/lab-02-core';

export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}

export function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : total(values) / values.length;
}

export function count(values: number[]): number {
  return values.length;
}

export function range(values: number[]): number | undefined {
  return values.length === 0
    ? undefined
    : subtract(Math.max(...values), Math.min(...values));
}

export function formatSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${total(values)}`;
}

export function formatAverageSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${average(values) ?? 'n/a'}`;
}

export function formatCountSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${count(values)}`;
}

export function formatRangeSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${range(values) ?? 'n/a'}`;
}
