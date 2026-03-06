#!/usr/bin/env npx ts-node
/**
 * Isolation Forest Training Script
 *
 * Trains an anomaly detection model on historical block fingerprints.
 * Uses a JavaScript implementation since we can't rely on Python sklearn.
 *
 * The model learns "normal" blockchain behavior and flags anomalies.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  artifactsDir: resolve('artifacts'),
  modelsDir: resolve('ml', 'models'),
  chains: ['eth', 'sol', 'avax'],
  minSamples: 100,           // Minimum samples needed for training
  nTrees: 100,               // Number of isolation trees
  sampleSize: 256,           // Samples per tree
  contamination: 0.05,       // Expected % of anomalies
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════════

interface TrainingSample {
  chain: string;
  blockNumber: number;
  fingerprint: number[];
  timestamp: number;
}

function loadFingerprints(): TrainingSample[] {
  const samples: TrainingSample[] = [];

  for (const chain of CONFIG.chains) {
    const blocksDir = join(CONFIG.artifactsDir, 'blocks', chain);
    if (!existsSync(blocksDir)) continue;

    const dirs = readdirSync(blocksDir)
      .filter(d => /^\d+$/.test(d))
      .map(d => parseInt(d))
      .sort((a, b) => a - b);

    console.log(`[train] Loading ${dirs.length} blocks from ${chain}...`);

    for (const blockNum of dirs) {
      const summaryPath = join(blocksDir, blockNum.toString(), 'summary.json');
      if (!existsSync(summaryPath)) continue;

      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        const vectors = summary.vectors || summary.foldedBlock?.foldedVectors;

        if (vectors) {
          const fingerprint = vectors.flat();
          if (fingerprint.length >= 16) {
            samples.push({
              chain,
              blockNumber: blockNum,
              fingerprint: fingerprint.slice(0, 96), // Standardize to 96 dims
              timestamp: summary.timestamp || Date.now(),
            });
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  console.log(`[train] Loaded ${samples.length} total samples`);
  return samples;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ISOLATION FOREST IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

interface IsolationTree {
  splitFeature: number;
  splitValue: number;
  left: IsolationTree | null;
  right: IsolationTree | null;
  size: number;
}

/**
 * Build a single isolation tree
 */
function buildTree(
  data: number[][],
  maxDepth: number,
  currentDepth: number = 0
): IsolationTree | null {
  const n = data.length;

  // Terminal conditions
  if (currentDepth >= maxDepth || n <= 1) {
    return { splitFeature: -1, splitValue: 0, left: null, right: null, size: n };
  }

  // Random feature selection
  const nFeatures = data[0].length;
  const splitFeature = Math.floor(Math.random() * nFeatures);

  // Get min/max for this feature
  let min = Infinity, max = -Infinity;
  for (const sample of data) {
    const val = sample[splitFeature];
    if (val < min) min = val;
    if (val > max) max = val;
  }

  // If all values are the same, create leaf
  if (min === max) {
    return { splitFeature: -1, splitValue: 0, left: null, right: null, size: n };
  }

  // Random split point
  const splitValue = min + Math.random() * (max - min);

  // Partition data
  const leftData: number[][] = [];
  const rightData: number[][] = [];

  for (const sample of data) {
    if (sample[splitFeature] < splitValue) {
      leftData.push(sample);
    } else {
      rightData.push(sample);
    }
  }

  return {
    splitFeature,
    splitValue,
    left: buildTree(leftData, maxDepth, currentDepth + 1),
    right: buildTree(rightData, maxDepth, currentDepth + 1),
    size: n,
  };
}

/**
 * Calculate path length for a sample in a tree
 */
function pathLength(sample: number[], tree: IsolationTree | null, currentLength: number = 0): number {
  if (!tree || tree.splitFeature === -1) {
    // Leaf node - add adjustment for unbuilt tree
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
 * Build isolation forest
 */
function buildForest(data: number[][], nTrees: number, sampleSize: number): IsolationTree[] {
  const maxDepth = Math.ceil(Math.log2(sampleSize));
  const trees: IsolationTree[] = [];

  for (let i = 0; i < nTrees; i++) {
    // Random sampling with replacement
    const sample: number[][] = [];
    for (let j = 0; j < Math.min(sampleSize, data.length); j++) {
      const idx = Math.floor(Math.random() * data.length);
      sample.push(data[idx]);
    }

    const tree = buildTree(sample, maxDepth);
    if (tree) trees.push(tree);

    if ((i + 1) % 20 === 0) {
      console.log(`[train] Built ${i + 1}/${nTrees} trees...`);
    }
  }

  return trees;
}

/**
 * Calculate anomaly score for a sample
 * Score closer to 1 = more anomalous
 */
function anomalyScore(sample: number[], forest: IsolationTree[], sampleSize: number): number {
  const avgPathLength = forest.reduce((sum, tree) => sum + pathLength(sample, tree), 0) / forest.length;

  // Normalization factor
  const c = sampleSize > 1
    ? 2 * (Math.log(sampleSize - 1) + 0.5772156649) - (2 * (sampleSize - 1) / sampleSize)
    : 1;

  // Score: 2^(-avgPathLength/c)
  return Math.pow(2, -avgPathLength / c);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRAINING
// ═══════════════════════════════════════════════════════════════════════════════

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

function computeStats(values: number[]): { mean: number; std: number; min: number; max: number; percentiles: number[] } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);

  return {
    mean,
    std,
    min: sorted[0],
    max: sorted[n - 1],
    percentiles: [
      sorted[Math.floor(n * 0.5)],
      sorted[Math.floor(n * 0.9)],
      sorted[Math.floor(n * 0.95)],
      sorted[Math.floor(n * 0.99)],
    ],
  };
}

function computeVectorStats(fingerprints: number[][]): { mean: number[]; std: number[] } {
  const nDims = fingerprints[0].length;
  const n = fingerprints.length;

  const mean = new Array(nDims).fill(0);
  for (const fp of fingerprints) {
    for (let i = 0; i < nDims; i++) {
      mean[i] += (fp[i] || 0) / n;
    }
  }

  const std = new Array(nDims).fill(0);
  for (const fp of fingerprints) {
    for (let i = 0; i < nDims; i++) {
      std[i] += ((fp[i] || 0) - mean[i]) ** 2 / n;
    }
  }
  for (let i = 0; i < nDims; i++) {
    std[i] = Math.sqrt(std[i]) || 1;
  }

  return { mean, std };
}

async function train() {
  console.log('═'.repeat(60));
  console.log('Isolation Forest Training');
  console.log('═'.repeat(60));

  // Load data
  const samples = loadFingerprints();

  if (samples.length < CONFIG.minSamples) {
    console.error(`[train] Not enough samples: ${samples.length} < ${CONFIG.minSamples}`);
    console.log('[train] Run block ingestion first to collect more data.');
    process.exit(1);
  }

  // Extract fingerprints
  const fingerprints = samples.map(s => s.fingerprint);
  const nDims = fingerprints[0].length;

  console.log(`[train] Training on ${fingerprints.length} samples, ${nDims} dimensions`);

  // Compute normalization stats
  console.log('[train] Computing normalization stats...');
  const { mean, std } = computeVectorStats(fingerprints);

  // Normalize fingerprints
  const normalizedFp = fingerprints.map(fp =>
    fp.map((v, i) => (v - mean[i]) / (std[i] || 1))
  );

  // Build forest
  console.log(`[train] Building ${CONFIG.nTrees} isolation trees...`);
  const forest = buildForest(normalizedFp, CONFIG.nTrees, CONFIG.sampleSize);

  // Score all samples
  console.log('[train] Scoring training samples...');
  const scores = normalizedFp.map(fp => anomalyScore(fp, forest, CONFIG.sampleSize));
  const scoreStats = computeStats(scores);

  // Determine threshold based on contamination
  const thresholdIndex = Math.floor(scores.length * (1 - CONFIG.contamination));
  const sortedScores = [...scores].sort((a, b) => a - b);
  const threshold = sortedScores[thresholdIndex];

  // Count anomalies
  const anomalyCount = scores.filter(s => s >= threshold).length;
  console.log(`[train] Detected ${anomalyCount} anomalies (${(anomalyCount / scores.length * 100).toFixed(1)}%)`);

  // Save model metadata
  const metadata: ModelMetadata = {
    model_type: 'isolation_forest',
    trained_at: new Date().toISOString(),
    input_dims: nDims,
    n_estimators: CONFIG.nTrees,
    sample_size: CONFIG.sampleSize,
    contamination: CONFIG.contamination,
    training_samples: fingerprints.length,
    score_stats: {
      mean: scoreStats.mean,
      std: scoreStats.std,
      min: scoreStats.min,
      max: scoreStats.max,
      p50: scoreStats.percentiles[0],
      p90: scoreStats.percentiles[1],
      p95: scoreStats.percentiles[2],
      p99: scoreStats.percentiles[3],
    },
    threshold_suggestion: threshold,
    mean_vector: mean,
    std_vector: std,
  };

  // Save
  if (!existsSync(CONFIG.modelsDir)) {
    mkdirSync(CONFIG.modelsDir, { recursive: true });
  }

  const modelPath = join(CONFIG.modelsDir, 'isolation_forest.json');
  writeFileSync(modelPath, JSON.stringify(metadata, null, 2));
  console.log(`[train] Saved model metadata to ${modelPath}`);

  // Save forest (serialized trees)
  const forestPath = join(CONFIG.modelsDir, 'isolation_forest_trees.json');
  writeFileSync(forestPath, JSON.stringify(forest));
  console.log(`[train] Saved forest to ${forestPath}`);

  console.log('═'.repeat(60));
  console.log('Training Complete!');
  console.log('═'.repeat(60));
  console.log(`Samples:    ${fingerprints.length}`);
  console.log(`Dimensions: ${nDims}`);
  console.log(`Trees:      ${forest.length}`);
  console.log(`Threshold:  ${threshold.toFixed(4)}`);
  console.log(`Score Range: ${scoreStats.min.toFixed(4)} - ${scoreStats.max.toFixed(4)}`);
  console.log(`Score Mean:  ${scoreStats.mean.toFixed(4)} ± ${scoreStats.std.toFixed(4)}`);
  console.log('═'.repeat(60));
}

train().catch(console.error);
