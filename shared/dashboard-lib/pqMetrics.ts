import { getMetricsDatabase } from './db.js';

// Inlined from analytics/residuals.ts to avoid dependency on excluded folder
export interface ResidualStats {
  count: number;
  average: number;
  max: number;
  p95: number;
}

function summarizeResiduals(values: number[]): ResidualStats {
  if (!values || values.length === 0) {
    return { count: 0, average: 0, max: 0, p95: 0 };
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

function percentile(sortedValues: number[], quantile: number): number {
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

export interface HistogramBin {
  start: number;
  end: number;
  count: number;
}

export interface PQHistogramResult {
  bins: HistogramBin[];
  stats: ResidualStats;
  totalCount: number;
  bucketSize: number;
  threshold: number;
  range: {
    from: number;
    to: number;
  };
}

export interface PQHistogramOptions {
  chain?: string;
  from?: number;
  to?: number;
  bucketCount?: number;
  threshold?: number;
}

export function queryPQResidualHistogram(options: PQHistogramOptions = {}): PQHistogramResult {
  const db = getMetricsDatabase();
  const now = Math.floor(Date.now() / 1000);
  const from = options.from ?? now - 24 * 60 * 60;
  const to = options.to ?? now;
  const bucketCount = Math.max(5, Math.min(60, options.bucketCount ?? 24));
  const threshold = options.threshold ?? 0.25;
  const values = fetchResiduals(db, { from, to, chain: options.chain });
  const stats = summarizeResiduals(values);
  const totalCount = values.length;
  const maxValue = Math.max(stats.max, threshold, 0.05);
  const bucketSize = Math.max(maxValue / bucketCount, 0.01);
  const bins = Array.from({ length: bucketCount }, (_, index) => ({
    start: index * bucketSize,
    end: (index + 1) * bucketSize,
    count: 0,
  }));
  values.forEach((value) => {
    const idx = Math.min(Math.floor(value / bucketSize), bucketCount - 1);
    bins[idx].count += 1;
  });
  return {
    bins,
    stats,
    totalCount,
    bucketSize,
    threshold,
    range: { from, to },
  };
}

function fetchResiduals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  filters: { from: number; to: number; chain?: string },
): number[] {
  const baseSql = `
    SELECT residual
    FROM pq_residual_samples
    WHERE timestamp >= ? AND timestamp <= ?
    ${filters.chain ? 'AND chain = ?' : ''}
  `;
  const stmt = db.prepare(baseSql);
  const rows = (filters.chain
    ? stmt.all(filters.from, filters.to, filters.chain)
    : stmt.all(filters.from, filters.to)) as { residual: number }[];
  return rows
    .map((row) => Number(row.residual ?? 0))
    .filter((value) => Number.isFinite(value) && value >= 0);
}
