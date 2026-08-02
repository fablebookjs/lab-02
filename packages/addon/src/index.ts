import {
  add,
  normalizeLabel,
  subtract,
  type LabelNormalizationOptions,
} from '@fablebook/lab-02-core';

export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}

export function product(values: number[]): number {
  return values.reduce((result, value) => result * value, 1);
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

export function minimum(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

export function maximum(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;

  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered.at(middle);
  if (upper === undefined || ordered.length % 2 === 1) return upper;

  const lower = ordered.at(middle - 1);
  return lower === undefined ? upper : average([lower, upper]);
}

export function last(values: number[]): number | undefined {
  return values.at(-1);
}

export function first(values: number[]): number | undefined {
  return values.at(0);
}

export function formatSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${total(values)}`;
}

/** Compatibility name for integrations written against the 5.x summary API. */
export const formatClassicSummary = formatSummary;

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

export function formatMinimumSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${minimum(values) ?? 'n/a'}`;
}

export function formatMaximumSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${maximum(values) ?? 'n/a'}`;
}

export function formatMedianSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${median(values) ?? 'n/a'}`;
}

export function formatLastSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${last(values) ?? 'none'}`;
}

export function formatFirstSummary(
  label: string,
  values: number[],
  options: LabelNormalizationOptions = {}
): string {
  return `${normalizeLabel(label, options)}:${first(values) ?? 'n/a'}`;
}
