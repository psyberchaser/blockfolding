/**
 * ML Inference Module
 *
 * Loads trained models and provides real-time anomaly scoring.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface IsolationTree {
  splitFeature: number;
  splitValue: number;
  left: IsolationTree | null;
  right: IsolationTree | null;
  size: number;
}

interface ModelMetadata {
  model_type: string;
  trained_at: string;
  input_dims: number;
  n_estimators: number;
  sample_size: number;
  contamination: number;
  training_samples: number;
  score_stats: {
    mean: number;
    std: number;
    min: number;
    max: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  threshold_suggestion: number;
  mean_vector: number[];
  std_vector: number[];
}

export interface AnomalyResult {
  score: number;           // Raw anomaly score (0-1, higher = more anomalous)
  isAnomaly: boolean;      // Above threshold?
  percentile: number;      // Approximate percentile (0-100)
  severity: 'low' | 'medium' | 'high' | 'extreme';
  zScore: number;          // How many standard deviations from mean
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL LOADING
// ═══════════════════════════════════════════════════════════════════════════════

let loadedModel: {
  metadata: ModelMetadata;
  forest: IsolationTree[];
} | null = null;

const MODELS_DIR = resolve('ml', 'models');

export function loadIsolationForest(): boolean {
  const metadataPath = join(MODELS_DIR, 'isolation_forest.json');
  const forestPath = join(MODELS_DIR, 'isolation_forest_trees.json');

  if (!existsSync(metadataPath) || !existsSync(forestPath)) {
    console.warn('[inference] Isolation forest model not found. Run training first.');
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as ModelMetadata;
    const forest = JSON.parse(readFileSync(forestPath, 'utf-8')) as IsolationTree[];

    loadedModel = { metadata, forest };
    console.log(`[inference] Loaded isolation forest: ${metadata.training_samples} samples, ${forest.length} trees`);
    return true;
  } catch (e) {
    console.error('[inference] Failed to load model:', e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANOMALY SCORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate path length for a sample in a tree
 */
function pathLength(sample: number[], tree: IsolationTree | null, currentLength: number = 0): number {
  if (!tree || tree.splitFeature === -1) {
    const c = tree?.size || 1;
    const adjustment = c > 1 ? 2 * (Math.log(c - 1) + 0.5772156649) - (2 * (c - 1) / c) : 0;
    return currentLength + adjustment;
  }

  if (sample[tree.splitFeature] < tree.splitValue) {
    return pathLength(sample, tree.left, currentLength + 1);
  } else {
    return pathLength(sample, tree.right, currentLength + 1);
  }
}

/**
 * Score a fingerprint using the trained isolation forest
 */
export function scoreAnomaly(fingerprint: number[]): AnomalyResult {
  // Default result if model not loaded
  if (!loadedModel) {
    if (!loadIsolationForest()) {
      return {
        score: 0.5,
        isAnomaly: false,
        percentile: 50,
        severity: 'low',
        zScore: 0,
      };
    }
  }

  const { metadata, forest } = loadedModel!;

  // Pad or truncate to expected dimensions
  const dims = metadata.input_dims;
  let fp = fingerprint.slice(0, dims);
  while (fp.length < dims) fp.push(0);

  // Normalize using training stats
  const normalized = fp.map((v, i) => {
    const mean = metadata.mean_vector[i] || 0;
    const std = metadata.std_vector[i] || 1;
    return (v - mean) / (std || 1);
  });

  // Calculate average path length
  const avgPathLength = forest.reduce((sum, tree) => sum + pathLength(normalized, tree), 0) / forest.length;

  // Normalization factor
  const sampleSize = metadata.sample_size;
  const c = sampleSize > 1
    ? 2 * (Math.log(sampleSize - 1) + 0.5772156649) - (2 * (sampleSize - 1) / sampleSize)
    : 1;

  // Anomaly score: 2^(-avgPathLength/c)
  const score = Math.pow(2, -avgPathLength / c);

  // Determine anomaly status
  const isAnomaly = score >= metadata.threshold_suggestion;

  // Calculate z-score
  const zScore = (score - metadata.score_stats.mean) / (metadata.score_stats.std || 1);

  // Estimate percentile
  let percentile: number;
  if (score <= metadata.score_stats.p50) percentile = 50 * (score / metadata.score_stats.p50);
  else if (score <= metadata.score_stats.p90) percentile = 50 + 40 * ((score - metadata.score_stats.p50) / (metadata.score_stats.p90 - metadata.score_stats.p50));
  else if (score <= metadata.score_stats.p95) percentile = 90 + 5 * ((score - metadata.score_stats.p90) / (metadata.score_stats.p95 - metadata.score_stats.p90));
  else if (score <= metadata.score_stats.p99) percentile = 95 + 4 * ((score - metadata.score_stats.p95) / (metadata.score_stats.p99 - metadata.score_stats.p95));
  else percentile = 99 + ((score - metadata.score_stats.p99) / (metadata.score_stats.max - metadata.score_stats.p99));
  percentile = Math.min(100, Math.max(0, percentile));

  // Determine severity
  let severity: AnomalyResult['severity'];
  if (percentile < 90) severity = 'low';
  else if (percentile < 95) severity = 'medium';
  else if (percentile < 99) severity = 'high';
  else severity = 'extreme';

  return {
    score,
    isAnomaly,
    percentile,
    severity,
    zScore,
  };
}

/**
 * Get model info for debugging/display
 */
export function getModelInfo(): { loaded: boolean; trainedAt?: string; samples?: number; threshold?: number } {
  if (!loadedModel) {
    return { loaded: false };
  }
  return {
    loaded: true,
    trainedAt: loadedModel.metadata.trained_at,
    samples: loadedModel.metadata.training_samples,
    threshold: loadedModel.metadata.threshold_suggestion,
  };
}

// Auto-load on import
loadIsolationForest();
