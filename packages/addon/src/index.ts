import { add, normalizeLabel } from '@fablebook/lab-02-core';

export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}

export function formatSummary(label: string, values: number[]): string {
  return `${normalizeLabel(label)}:${total(values)}`;
}
