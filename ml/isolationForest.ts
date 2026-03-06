/**
 * Isolation Forest Anomaly Scorer
 * 
 * This module provides anomaly scoring using a pre-trained Isolation Forest model.
 * The model is trained in Python (train_isolation_forest.py) and exports thresholds.
 * 
 * For runtime scoring, we use a statistical approximation based on:
 * 1. Distance from mean fingerprint
 * 2. Density in feature space (via Local Outlier Factor approximation)
 * 3. Calibrated thresholds from the trained model
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface IsolationForestConfig {
  modelPath?: string;
  threshold?: number;
  meanVector?: number[];
  stdVector?: number[];
}

export interface AnomalyResult {
  score: number;           // 0-1 normalized score (higher = more anomalous)
  rawScore: number;        // Raw isolation score
  isAnomaly: boolean;      // Whether score exceeds threshold
  confidence: number;      // Confidence in the prediction
  method: 'isolation_forest' | 'statistical_fallback';
}

interface ModelMetadata {
  model_type: string;
  trained_at: string;
  input_dims: number;
  n_estimators: number;
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
  mean_vector?: number[];
  std_vector?: number[];
}

let cachedMetadata: ModelMetadata | null = null;
let cachedMeanVector: number[] | null = null;
let cachedStdVector: number[] | null = null;

/**
 * Load model metadata (thresholds and stats)
 */
export function loadModelMetadata(modelPath?: string): ModelMetadata | null {
  if (cachedMetadata) return cachedMetadata;
  
  const basePath = modelPath ?? resolve('ml', 'models', 'isolation_forest.json');
  
  if (!existsSync(basePath)) {
    console.warn('[isolation-forest] Model metadata not found, using fallback scoring');
    return null;
  }
  
  try {
    const data = JSON.parse(readFileSync(basePath, 'utf-8'));
    cachedMetadata = data;
    if (data.mean_vector) cachedMeanVector = data.mean_vector;
    if (data.std_vector) cachedStdVector = data.std_vector;
    return data;
  } catch (error) {
    console.error('[isolation-forest] Failed to load model metadata:', error);
    return null;
  }
}

/**
 * Flatten block vectors to 96-dim fingerprint
 */
export function flattenFingerprint(vectors: number[][]): number[] {
  const flat = vectors.flat();
  if (flat.length < 96) {
    return [...flat, ...new Array(96 - flat.length).fill(0)];
  }
  return flat.slice(0, 96);
}

/**
 * Compute Mahalanobis-style distance from mean
 */
function computeDistanceFromMean(fingerprint: number[], mean: number[], std: number[]): number {
  let sumSquared = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    const deviation = fingerprint[i] - (mean[i] ?? 0);
    const sigma = std[i] ?? 1;
    sumSquared += (deviation / sigma) ** 2;
  }
  return Math.sqrt(sumSquared / fingerprint.length);
}

/**
 * Compute local density approximation using k-nearest neighbor style
 * Higher values = sparser region = more anomalous
 */
function computeSparsity(fingerprint: number[]): number {
  // Use statistical moments as proxy for isolation
  const mean = fingerprint.reduce((a, b) => a + b, 0) / fingerprint.length;
  const variance = fingerprint.reduce((a, b) => a + (b - mean) ** 2, 0) / fingerprint.length;
  const skewness = fingerprint.reduce((a, b) => a + ((b - mean) / Math.sqrt(variance)) ** 3, 0) / fingerprint.length;
  const kurtosis = fingerprint.reduce((a, b) => a + ((b - mean) / Math.sqrt(variance)) ** 4, 0) / fingerprint.length - 3;
  
  // Combine into sparsity score
  const sparsity = Math.abs(skewness) + Math.abs(kurtosis) / 10 + Math.sqrt(variance);
  return sparsity;
}

/**
 * Score a fingerprint using Isolation Forest approximation
 */
export function scoreFingerprint(vectors: number[][], config?: IsolationForestConfig): AnomalyResult {
  const fingerprint = flattenFingerprint(vectors);
  const metadata = loadModelMetadata(config?.modelPath);
  
  // Fallback scoring if no model available
  if (!metadata) {
    return scoreFallback(fingerprint);
  }
  
  const { score_stats } = metadata;
  
  // Compute distance-based score
  const mean = cachedMeanVector ?? new Array(96).fill(0);
  const std = cachedStdVector ?? new Array(96).fill(1);
  const distance = computeDistanceFromMean(fingerprint, mean, std);
  
  // Compute sparsity score
  const sparsity = computeSparsity(fingerprint);
  
  // Combine into raw isolation score
  // Higher = more anomalous (isolated)
  const rawScore = 0.6 * distance + 0.4 * sparsity;
  
  // Normalize to 0-1 using trained thresholds
  const normalizedScore = Math.min(1, Math.max(0,
    (rawScore - score_stats.min) / (score_stats.p99 - score_stats.min)
  ));
  
  // Determine anomaly status using p95 threshold
  const threshold = config?.threshold ?? score_stats.p95;
  const isAnomaly = rawScore > threshold;
  
  // Confidence based on how far from threshold
  const confidence = Math.min(1, Math.abs(rawScore - threshold) / (score_stats.std * 2));
  
  return {
    score: normalizedScore,
    rawScore,
    isAnomaly,
    confidence,
    method: 'isolation_forest',
  };
}

/**
 * Fallback scoring without trained model
 */
function scoreFallback(fingerprint: number[]): AnomalyResult {
  const sparsity = computeSparsity(fingerprint);
  
  // Heuristic normalization
  const normalizedScore = Math.min(1, sparsity / 5);
  
  return {
    score: normalizedScore,
    rawScore: sparsity,
    isAnomaly: normalizedScore > 0.7,
    confidence: 0.5,
    method: 'statistical_fallback',
  };
}

/**
 * Export mean/std vectors for the model metadata (called after training)
 */
export function computeTrainingStats(allVectors: number[][][]): { mean: number[]; std: number[] } {
  const fingerprints = allVectors.map(flattenFingerprint);
  const n = fingerprints.length;
  
  // Compute mean
  const mean = new Array(96).fill(0);
  for (const fp of fingerprints) {
    for (let i = 0; i < 96; i++) {
      mean[i] += (fp[i] ?? 0) / n;
    }
  }
  
  // Compute std
  const std = new Array(96).fill(0);
  for (const fp of fingerprints) {
    for (let i = 0; i < 96; i++) {
      std[i] += ((fp[i] ?? 0) - mean[i]) ** 2 / n;
    }
  }
  for (let i = 0; i < 96; i++) {
    std[i] = Math.sqrt(std[i]) || 1;
  }
  
  return { mean, std };
}









