export interface ResidualStats {
  count: number;
  average: number;
  max: number;
  p95: number;
}

export function summarizeResiduals(values: number[]): ResidualStats {
  if (!values || values.length === 0) {
    return {
      count: 0,
      average: 0,
      max: 0,
      p95: 0,
    };
  }
  const count = values.length;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  const max = values.reduce((acc, value) => Math.max(acc, Number(value || 0)), 0);
  const sorted = [...values].map((value) => Number(value || 0)).sort((a, b) => a - b);
  return {
    count,
    average: sum / count,
    max,
    p95: percentile(sorted, 0.95),
  };
}

export function percentile(sortedValues: number[], quantile: number): number {
  if (!sortedValues.length) return 0;
  if (quantile <= 0) return sortedValues[0];
  if (quantile >= 1) return sortedValues[sortedValues.length - 1];
  const index = (sortedValues.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

