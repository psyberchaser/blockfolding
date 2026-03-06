const BASELINE_DENSITY = 1.1e6;

export interface AnomalyInputs {
  hotzones?: Array<{ density?: number }>;
  pqResidualStats?: { average?: number; p95?: number; max?: number };
  tagVector?: string[];
  fingerprint?: number[][];  // Block fingerprint vectors for Isolation Forest
}

const TAG_PRIORS = new Map<string, number>([
  ['AML_ALERT', 0.8],
  ['AML_RULE', 0.7],
  ['HIGH_FEE', 0.6],
  ['VOL_CRUSH', 0.5],
  ['DEX_ACTIVITY', 0.3],
  ['NFT_ACTIVITY', 0.35],
  ['BRIDGE_ACTIVITY', 0.45],
  ['LENDING_ACTIVITY', 0.4],
]);

// Model metadata cache
let modelMetadata: IsolationForestMetadata | null = null;

interface IsolationForestMetadata {
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
  mean_vector?: number[];
  std_vector?: number[];
  threshold_suggestion: number;
}

/**
 * Load Isolation Forest metadata (lazy loaded)
 */
function loadIsolationForestMetadata(): IsolationForestMetadata | null {
  if (modelMetadata !== null) return modelMetadata;
  
  try {
    // Try to load from file (works on server)
    const fs = require('node:fs');
    const path = require('node:path');
    const modelPath = path.resolve(process.cwd(), 'ml', 'models', 'isolation_forest.json');
    if (fs.existsSync(modelPath)) {
      modelMetadata = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
      return modelMetadata;
    }
  } catch {
    // Not available (client-side or missing file)
  }
  return null;
}

/**
 * Compute Isolation Forest anomaly score from fingerprint
 */
function computeIsolationForestScore(fingerprint: number[][]): { score: number; method: string } | null {
  const metadata = loadIsolationForestMetadata();
  if (!metadata || !fingerprint || fingerprint.length === 0) {
    return null;
  }
  
  // Flatten fingerprint to 96-dim
  const flat = fingerprint.flat();
  const paddedFlat = flat.length < 96 
    ? [...flat, ...new Array(96 - flat.length).fill(0)]
    : flat.slice(0, 96);
  
  // Compute Mahalanobis-style distance from mean
  const meanVec = metadata.mean_vector ?? new Array(96).fill(0);
  const stdVec = metadata.std_vector ?? new Array(96).fill(1);
  
  let sumSquared = 0;
  for (let i = 0; i < 96; i++) {
    const deviation = paddedFlat[i] - (meanVec[i] ?? 0);
    const sigma = stdVec[i] || 1;
    sumSquared += (deviation / sigma) ** 2;
  }
  const distance = Math.sqrt(sumSquared / 96);
  
  // Compute statistical moments for sparsity
  const mean = paddedFlat.reduce((a, b) => a + b, 0) / 96;
  const variance = paddedFlat.reduce((a, b) => a + (b - mean) ** 2, 0) / 96;
  const sparsity = Math.sqrt(variance);
  
  // Combine into raw score
  const rawScore = 0.6 * distance + 0.4 * sparsity;
  
  // Normalize using model thresholds
  const { score_stats } = metadata;
  const normalizedScore = Math.min(1, Math.max(0,
    (rawScore - score_stats.min) / (score_stats.p99 - score_stats.min)
  ));
  
  return { score: normalizedScore, method: 'isolation_forest' };
}

export function computeAnomalyScore({
  hotzones = [],
  pqResidualStats,
  tagVector = [],
  fingerprint,
}: AnomalyInputs = {}) {
  const densityComponent = computeDensityComponent(hotzones);
  const residualComponent = computeResidualComponent(pqResidualStats);
  const tagComponent = computeTagComponent(tagVector);
  
  // Try Isolation Forest scoring if fingerprint available
  const isolationResult = fingerprint ? computeIsolationForestScore(fingerprint) : null;

  // Combine heuristic and ML scores
  let scoreRaw: number;
  let method: string;
  
  if (isolationResult) {
    // Blend: 50% Isolation Forest, 30% density, 15% residual, 5% tags
    scoreRaw =
      0.50 * isolationResult.score +
      0.30 * densityComponent.component +
      0.15 * residualComponent.component +
      0.05 * tagComponent.component;
    method = 'hybrid_isolation_forest';
  } else {
    // Fallback to pure heuristic
    scoreRaw =
      0.5 * densityComponent.component +
      0.35 * residualComponent.component +
      0.15 * tagComponent.component;
    method = 'heuristic';
  }

  const score = Number(Math.min(1, Math.max(0, scoreRaw)).toFixed(2));
  const label = labelFromScore(score);
  const similarity = Math.max(0, Math.min(100, Math.round((1 - score) * 100)));

  return {
    score,
    label,
    similarity,
    method,
    breakdown: {
      density: densityComponent,
      pqResidual: residualComponent,
      tags: tagComponent,
      isolationForest: isolationResult ?? undefined,
    },
  };
}

function computeDensityComponent(hotzones: Array<{ density?: number }> = []) {
  if (!hotzones.length) {
    return { component: 0.85, detail: 'No zones' };
  }
  const peak = hotzones.reduce((max, zone) => Math.max(max, Number(zone?.density ?? 0)), 0);
  if (!Number.isFinite(peak) || peak <= 0) {
    return { component: 0.8, detail: 'Zero density' };
  }
  const normalized = Math.min(1, peak / BASELINE_DENSITY);
  return {
    component: 1 - normalized,
    detail: peak.toFixed(2),
  };
}

function computeResidualComponent(stats?: { average?: number; p95?: number; max?: number }) {
  if (!stats || !Number.isFinite(stats.p95 ?? NaN)) {
    return { component: 0.2, detail: 'n/a' };
  }
  const p95 = Number(stats.p95 ?? 0);
  const normalized = Math.min(1, Math.max(0, p95 / 0.5));
  return {
    component: normalized,
    detail: p95.toFixed(3),
  };
}

function computeTagComponent(tags: string[] = []) {
  if (!tags.length) return { component: 0, detail: 'No tags' };
  const weight = tags.reduce((acc, tag) => acc + (TAG_PRIORS.get(tag.toUpperCase()) ?? 0), 0);
  const normalized = Math.min(1, weight / 3);
  return { component: normalized, detail: `${(normalized * 100).toFixed(0)}%` };
}

function labelFromScore(score: number) {
  if (score >= 0.75) return 'Rare';
  if (score >= 0.45) return 'Unusual';
  return 'Typical';
}

