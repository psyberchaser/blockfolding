/**
 * Pattern Discovery via Clustering
 *
 * Automatically discovers trading patterns from historical data:
 * - K-means clustering on fingerprints
 * - Labels clusters by subsequent price outcome
 * - Dynamically updates as new data arrives
 * - Provides pattern-based predictions
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';
const DISCOVERED_PATTERNS_FILE = join(DATA_DIR, 'ml', 'discovered-patterns.json');
const CLUSTER_CENTERS_FILE = join(DATA_DIR, 'ml', 'cluster-centers.json');

export interface DiscoveredPattern {
  id: string;
  centroid: number[];
  size: number; // Number of samples in cluster
  avgOutcome: number; // Average price change after pattern
  stdOutcome: number;
  minOutcome: number;
  maxOutcome: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  avgEntropy: number;
  avgDriftVelocity: number;
  dominantTags: string[];
  sampleCount: number;
  lastUpdated: number;
}

export interface ClusteringConfig {
  k: number; // Number of clusters
  maxIterations: number;
  convergenceThreshold: number;
  minSamplesPerCluster: number;
}

export interface PatternMatchResult {
  patternId: string;
  distance: number;
  similarity: number;
  expectedOutcome: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
}

// State
let discoveredPatterns: DiscoveredPattern[] = [];
let clusterCenters: number[][] = [];

/**
 * K-means clustering implementation
 */
function kMeans(
  data: number[][],
  k: number,
  maxIterations: number = 100,
  convergenceThreshold: number = 0.001
): { centers: number[][]; assignments: number[] } {
  if (data.length < k) {
    throw new Error(`Not enough data points (${data.length}) for ${k} clusters`);
  }

  const dim = data[0].length;

  // Initialize centers randomly from data points
  const shuffled = [...data].sort(() => Math.random() - 0.5);
  let centers = shuffled.slice(0, k).map(p => [...p]);

  let assignments = new Array(data.length).fill(0);
  let prevCenters: number[][] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign points to nearest center
    for (let i = 0; i < data.length; i++) {
      let minDist = Infinity;
      let nearest = 0;

      for (let j = 0; j < k; j++) {
        const dist = euclideanDistance(data[i], centers[j]);
        if (dist < minDist) {
          minDist = dist;
          nearest = j;
        }
      }

      assignments[i] = nearest;
    }

    // Update centers
    prevCenters = centers.map(c => [...c]);
    const newCenters: number[][] = [];
    const counts: number[] = [];

    for (let j = 0; j < k; j++) {
      newCenters.push(new Array(dim).fill(0));
      counts.push(0);
    }

    for (let i = 0; i < data.length; i++) {
      const cluster = assignments[i];
      counts[cluster]++;
      for (let d = 0; d < dim; d++) {
        newCenters[cluster][d] += data[i][d];
      }
    }

    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        for (let d = 0; d < dim; d++) {
          newCenters[j][d] /= counts[j];
        }
        centers[j] = newCenters[j];
      }
    }

    // Check convergence
    let maxMove = 0;
    for (let j = 0; j < k; j++) {
      maxMove = Math.max(maxMove, euclideanDistance(centers[j], prevCenters[j]));
    }

    if (maxMove < convergenceThreshold) {
      console.log(`[clustering] Converged after ${iter + 1} iterations`);
      break;
    }
  }

  return { centers, assignments };
}

/**
 * Euclidean distance between two vectors
 */
function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

/**
 * Compute entropy of fingerprint
 */
function computeEntropy(fingerprint: number[]): number {
  if (!fingerprint.length) return 0.5;
  const sum = fingerprint.reduce((a, b) => a + Math.abs(b), 0);
  if (sum === 0) return 0;

  const probs = fingerprint.map(v => Math.abs(v) / sum);
  let entropy = 0;
  for (const p of probs) {
    if (p > 0) entropy -= p * Math.log2(p);
  }

  return entropy / Math.log2(fingerprint.length);
}

/**
 * Compute drift velocity between fingerprints
 */
function computeDriftVelocity(current: number[], previous: number[]): number {
  if (!current.length || !previous.length) return 0;
  const delta = current.map((v, i) => v - (previous[i] || 0));
  return Math.sqrt(delta.reduce((sum, d) => sum + d * d, 0));
}

/**
 * Load historical data for clustering
 */
function loadHistoricalData(chain: string, limit: number = 500): {
  fingerprint: number[];
  outcome: number;
  tags: string[];
  timestamp: number;
}[] {
  const blocksDir = join(DATA_DIR, 'blocks', chain);
  if (!existsSync(blocksDir)) return [];

  const dirs = readdirSync(blocksDir)
    .filter(d => /^\d+$/.test(d))
    .map(d => parseInt(d))
    .sort((a, b) => a - b); // Ascending order

  const data: {
    fingerprint: number[];
    outcome: number;
    tags: string[];
    timestamp: number;
  }[] = [];

  // We need to calculate outcomes, so skip the last few blocks
  for (let i = 0; i < dirs.length - 10; i++) {
    const blockNum = dirs[i];
    const summaryPath = join(blocksDir, blockNum.toString(), 'summary.json');

    if (!existsSync(summaryPath)) continue;

    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

      // Get fingerprint from foldedBlock.foldedVectors (first vector is the block fingerprint)
      const foldedVectors = summary.foldedBlock?.foldedVectors || [];
      const fingerprint = foldedVectors[0];
      if (!fingerprint || fingerprint.length === 0) continue;

      // Compute anomaly score from hotzones if not stored
      const hotzones = summary.hotzones || [];
      const densities = hotzones.map((hz: any) => hz.density || 0);
      const avgDensity = densities.length > 0 ? densities.reduce((a: number, b: number) => a + b, 0) / densities.length : 0;
      const currentAnomaly = summary.anomalyScore ?? (avgDensity > 100 ? Math.min(1, avgDensity / 1000) : 0.1);

      // For outcome, compare density changes across future blocks
      const futureBlocks = dirs.slice(i + 1, i + 11);
      let futureDensitySum = 0;
      let futureCount = 0;

      for (const fb of futureBlocks) {
        const futureSummaryPath = join(blocksDir, fb.toString(), 'summary.json');
        if (existsSync(futureSummaryPath)) {
          try {
            const futureSummary = JSON.parse(readFileSync(futureSummaryPath, 'utf-8'));
            const futureHotzones = futureSummary.hotzones || [];
            const futureDensities = futureHotzones.map((hz: any) => hz.density || 0);
            const futureAvg = futureDensities.length > 0 ? futureDensities.reduce((a: number, b: number) => a + b, 0) / futureDensities.length : 0;
            futureDensitySum += futureAvg;
            futureCount++;
          } catch (e) {}
        }
      }

      const futureAvgDensity = futureCount > 0 ? futureDensitySum / futureCount : avgDensity;

      // Outcome proxy: positive if density increases (more activity = bullish), negative if decreases
      const densityChange = (futureAvgDensity - avgDensity) / (avgDensity + 1);
      const outcome = Math.max(-0.1, Math.min(0.1, densityChange * 0.05));

      data.push({
        fingerprint,
        outcome,
        tags: summary.semanticTags || summary.rawTags || [],
        timestamp: summary.timestamp || Date.now(),
      });
    } catch (e) {
      // Skip blocks with errors
    }
  }

  return data.slice(-limit);
}

/**
 * Discover patterns from historical data
 */
export function discoverPatterns(
  chain: string = 'eth',
  config: ClusteringConfig = {
    k: 8,
    maxIterations: 100,
    convergenceThreshold: 0.001,
    minSamplesPerCluster: 5,
  }
): DiscoveredPattern[] {
  console.log(`[clustering] Starting pattern discovery for ${chain}`);

  const data = loadHistoricalData(chain, 500);
  console.log(`[clustering] Loaded ${data.length} historical samples`);

  if (data.length < config.k * config.minSamplesPerCluster) {
    console.warn(`[clustering] Insufficient data for ${config.k} clusters`);
    return [];
  }

  // Extract fingerprints for clustering
  const fingerprints = data.map(d => d.fingerprint);

  // Run k-means
  const { centers, assignments } = kMeans(
    fingerprints,
    config.k,
    config.maxIterations,
    config.convergenceThreshold
  );

  clusterCenters = centers;

  // Analyze each cluster
  const patterns: DiscoveredPattern[] = [];

  for (let i = 0; i < config.k; i++) {
    const clusterIndices = assignments
      .map((a, idx) => ({ a, idx }))
      .filter(x => x.a === i)
      .map(x => x.idx);

    if (clusterIndices.length < config.minSamplesPerCluster) {
      continue;
    }

    const clusterData = clusterIndices.map(idx => data[idx]);

    // Calculate cluster statistics
    const outcomes = clusterData.map(d => d.outcome);
    const avgOutcome = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
    const stdOutcome = Math.sqrt(
      outcomes.reduce((sum, o) => sum + (o - avgOutcome) ** 2, 0) / outcomes.length
    );
    const minOutcome = Math.min(...outcomes);
    const maxOutcome = Math.max(...outcomes);

    // Determine direction
    const direction: 'bullish' | 'bearish' | 'neutral' =
      avgOutcome > 0.01 ? 'bullish' : avgOutcome < -0.01 ? 'bearish' : 'neutral';

    // Confidence based on consistency
    const confidence = Math.min(1, 0.3 + 0.4 * (1 - stdOutcome / (Math.abs(avgOutcome) + 0.01)));

    // Average entropy and drift
    const avgEntropy = clusterData.reduce((sum, d) => sum + computeEntropy(d.fingerprint), 0) / clusterData.length;

    let totalDrift = 0;
    for (let j = 1; j < clusterData.length; j++) {
      totalDrift += computeDriftVelocity(clusterData[j].fingerprint, clusterData[j - 1].fingerprint);
    }
    const avgDriftVelocity = clusterData.length > 1 ? totalDrift / (clusterData.length - 1) : 0;

    // Dominant tags
    const tagCounts: Record<string, number> = {};
    for (const d of clusterData) {
      for (const tag of d.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    const dominantTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);

    // Generate pattern name
    const directionLabel = direction.charAt(0).toUpperCase() + direction.slice(1);
    const entropyLabel = avgEntropy < 0.4 ? 'Coordinated' : avgEntropy > 0.7 ? 'Chaotic' : 'Mixed';
    const activityLabel = dominantTags[0] || 'General';

    patterns.push({
      id: `discovered-${i}-${Date.now().toString(36)}`,
      centroid: centers[i],
      size: clusterIndices.length,
      avgOutcome,
      stdOutcome,
      minOutcome,
      maxOutcome,
      direction,
      confidence,
      avgEntropy,
      avgDriftVelocity,
      dominantTags,
      sampleCount: clusterData.length,
      lastUpdated: Date.now(),
    });
  }

  // Sort by absolute outcome (most predictive first)
  patterns.sort((a, b) => Math.abs(b.avgOutcome) - Math.abs(a.avgOutcome));

  discoveredPatterns = patterns;
  saveDiscoveredPatterns();

  console.log(`[clustering] Discovered ${patterns.length} patterns`);

  return patterns;
}

/**
 * Match a fingerprint against discovered patterns
 */
export function matchFingerprint(fingerprint: number[]): PatternMatchResult[] {
  if (!fingerprint.length || discoveredPatterns.length === 0) {
    return [];
  }

  const matches: PatternMatchResult[] = [];

  for (const pattern of discoveredPatterns) {
    const distance = euclideanDistance(fingerprint, pattern.centroid);

    // Convert distance to similarity (0-1)
    // Using exponential decay: similarity = exp(-distance / scale)
    const scale = 1.0; // Adjust based on typical distances
    const similarity = Math.exp(-distance / scale);

    matches.push({
      patternId: pattern.id,
      distance,
      similarity,
      expectedOutcome: pattern.avgOutcome,
      direction: pattern.direction,
      confidence: similarity * pattern.confidence,
    });
  }

  // Sort by similarity
  matches.sort((a, b) => b.similarity - a.similarity);

  return matches;
}

/**
 * Get prediction from pattern matching
 */
export function getPatternPrediction(fingerprint: number[]): {
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  expectedOutcome: number;
  matchedPatterns: PatternMatchResult[];
} {
  const matches = matchFingerprint(fingerprint);

  if (matches.length === 0) {
    return {
      direction: 'neutral',
      confidence: 0,
      expectedOutcome: 0,
      matchedPatterns: [],
    };
  }

  // Use top 3 matches weighted by similarity
  const topMatches = matches.slice(0, 3);
  const totalWeight = topMatches.reduce((sum, m) => sum + m.similarity, 0);

  if (totalWeight === 0) {
    return {
      direction: 'neutral',
      confidence: 0,
      expectedOutcome: 0,
      matchedPatterns: [],
    };
  }

  let weightedOutcome = 0;
  let bullishWeight = 0;
  let bearishWeight = 0;

  for (const match of topMatches) {
    const weight = match.similarity / totalWeight;
    weightedOutcome += match.expectedOutcome * weight;

    if (match.direction === 'bullish') bullishWeight += weight;
    else if (match.direction === 'bearish') bearishWeight += weight;
  }

  const direction: 'bullish' | 'bearish' | 'neutral' =
    bullishWeight > bearishWeight + 0.2 ? 'bullish' :
    bearishWeight > bullishWeight + 0.2 ? 'bearish' : 'neutral';

  const confidence = topMatches[0].confidence;

  return {
    direction,
    confidence,
    expectedOutcome: weightedOutcome,
    matchedPatterns: topMatches,
  };
}

/**
 * Update patterns with new data
 */
export function updatePatternsWithOutcome(
  fingerprint: number[],
  actualOutcome: number
): void {
  // Find nearest pattern
  const matches = matchFingerprint(fingerprint);
  if (matches.length === 0) return;

  const nearest = matches[0];
  if (nearest.similarity < 0.5) return; // Too far from any cluster

  // Find and update pattern
  const pattern = discoveredPatterns.find(p => p.id === nearest.patternId);
  if (!pattern) return;

  // Update running average
  const oldWeight = pattern.sampleCount / (pattern.sampleCount + 1);
  const newWeight = 1 / (pattern.sampleCount + 1);

  pattern.avgOutcome = pattern.avgOutcome * oldWeight + actualOutcome * newWeight;
  pattern.sampleCount++;
  pattern.lastUpdated = Date.now();

  // Update direction if significantly changed
  pattern.direction =
    pattern.avgOutcome > 0.01 ? 'bullish' :
    pattern.avgOutcome < -0.01 ? 'bearish' : 'neutral';

  saveDiscoveredPatterns();
}

/**
 * Persistence
 */
function saveDiscoveredPatterns(): void {
  try {
    writeFileSync(DISCOVERED_PATTERNS_FILE, JSON.stringify(discoveredPatterns, null, 2));
    writeFileSync(CLUSTER_CENTERS_FILE, JSON.stringify(clusterCenters, null, 2));
  } catch (e) {
    console.warn('[clustering] Failed to save patterns:', e);
  }
}

function loadDiscoveredPatterns(): void {
  try {
    if (existsSync(DISCOVERED_PATTERNS_FILE)) {
      discoveredPatterns = JSON.parse(readFileSync(DISCOVERED_PATTERNS_FILE, 'utf-8'));
      console.log(`[clustering] Loaded ${discoveredPatterns.length} discovered patterns`);
    }
    if (existsSync(CLUSTER_CENTERS_FILE)) {
      clusterCenters = JSON.parse(readFileSync(CLUSTER_CENTERS_FILE, 'utf-8'));
    }
  } catch (e) {
    // Ignore
  }
}

// Load on module init
loadDiscoveredPatterns();

export { discoveredPatterns, clusterCenters };
