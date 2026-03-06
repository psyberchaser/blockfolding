import { NormalizationStats } from './types.js';

export function computeNormalizationStats(
  vectors: number[][],
  dimension: number,
): NormalizationStats {
  const mean = new Array(dimension).fill(0);
  const variance = new Array(dimension).fill(0);
  const total = Math.max(1, vectors.length);

  vectors.forEach((vec) => {
    for (let i = 0; i < dimension; i += 1) {
      mean[i] += (vec[i] ?? 0);
    }
  });

  for (let i = 0; i < dimension; i += 1) {
    mean[i] /= total;
  }

  vectors.forEach((vec) => {
    for (let i = 0; i < dimension; i += 1) {
      const diff = (vec[i] ?? 0) - mean[i];
      variance[i] += diff * diff;
    }
  });

  const denom = Math.max(1, total - 1);
  const stdDev = variance.map((value) => {
    const std = Math.sqrt(value / denom);
    return Number.isFinite(std) && std > 1e-9 ? std : 1;
  });

  return { mean, stdDev };
}

export function normalizeVector(vector: number[], stats: NormalizationStats): number[] {
  return vector.map((value, index) => {
    const std = stats.stdDev[index] ?? 1;
    const safeStd = Math.abs(std) > 1e-9 ? std : 1;
    return ((value ?? 0) - (stats.mean[index] ?? 0)) / safeStd;
  });
}

export function normalizeVectors(
  vectors: number[][],
  stats?: NormalizationStats,
): number[][] {
  if (!stats) return vectors.map((vector) => [...vector]);
  return vectors.map((vector) => normalizeVector(vector, stats));
}

