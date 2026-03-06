/**
 * Derived Signals Module
 *
 * Additional trading signals extracted from YYSFOLD data:
 * - Mempool pressure & whale detection
 * - Fingerprint entropy (coordination detection)
 * - Tag momentum (activity surge detection)
 * - Pattern similarity (historical matching)
 * - Regime classification
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';

// ============================================
// MEMPOOL SIGNALS
// ============================================

export interface MempoolSignals {
  txPressure: number;           // Pending TX count vs average
  gasPressure: number;          // Gas price vs average
  whaleActivity: boolean;       // Large value TXs pending
  mevRisk: number;              // Sandwich/frontrun probability
  volatilityPrecursor: boolean; // Mempool patterns before volatility
}

export function getMempoolSignals(chain: string = 'eth'): MempoolSignals {
  try {
    const mempoolPath = join(DATA_DIR, 'mempool', `${chain}.json`);
    if (!existsSync(mempoolPath)) {
      return defaultMempoolSignals();
    }

    const data = JSON.parse(readFileSync(mempoolPath, 'utf-8'));

    // TX pressure: delta from normal
    const txPressure = Math.min(2, Math.max(-1, (data.deltaTx || 0) / 100));

    // Gas pressure: high gas = congestion = activity
    const gasPressure = Math.min(1, (data.avgGasPriceGwei || 0) / 50);

    // Whale activity: large value in mempool
    const whaleActivity = (data.totalValueEth || 0) > 10;

    // MEV risk: DEX activity + high value = sandwich risk
    const hasDex = (data.tags || []).includes('DEX_ACTIVITY');
    const mevRisk = hasDex && whaleActivity ? 0.7 : hasDex ? 0.3 : 0.1;

    // Volatility precursor: sudden mempool changes
    const volatilityPrecursor = Math.abs(data.deltaTx || 0) > 50 ||
                                 Math.abs(data.deltaValue || 0) > 20;

    return {
      txPressure,
      gasPressure,
      whaleActivity,
      mevRisk,
      volatilityPrecursor,
    };
  } catch (e) {
    return defaultMempoolSignals();
  }
}

function defaultMempoolSignals(): MempoolSignals {
  return {
    txPressure: 0,
    gasPressure: 0,
    whaleActivity: false,
    mevRisk: 0,
    volatilityPrecursor: false,
  };
}

// ============================================
// FINGERPRINT ENTROPY
// ============================================

export interface EntropySignals {
  entropy: number;              // 0-1, low = coordinated activity
  entropyChange: number;        // Rate of entropy change
  coordinationDetected: boolean; // Sudden drop in entropy
  chaosDetected: boolean;       // Sudden spike in entropy
}

/**
 * Compute Shannon entropy of fingerprint
 * Low entropy = coordinated/predictable behavior (potential manipulation)
 * High entropy = chaotic/diverse behavior (organic activity)
 */
export function computeEntropy(fingerprint: number[]): number {
  // Normalize to probability distribution
  const sum = fingerprint.reduce((a, b) => a + Math.abs(b), 0);
  if (sum === 0) return 0;

  const probs = fingerprint.map(v => Math.abs(v) / sum);

  // Shannon entropy
  let entropy = 0;
  for (const p of probs) {
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize to 0-1 (max entropy for n elements is log2(n))
  const maxEntropy = Math.log2(fingerprint.length);
  return entropy / maxEntropy;
}

export function getEntropySignals(
  currentFingerprint: number[],
  previousFingerprint?: number[],
): EntropySignals {
  const entropy = computeEntropy(currentFingerprint);
  const prevEntropy = previousFingerprint ? computeEntropy(previousFingerprint) : entropy;
  const entropyChange = entropy - prevEntropy;

  return {
    entropy,
    entropyChange,
    coordinationDetected: entropyChange < -0.1 && entropy < 0.5,
    chaosDetected: entropyChange > 0.1 && entropy > 0.8,
  };
}

// ============================================
// TAG MOMENTUM
// ============================================

export interface TagMomentum {
  tag: string;
  velocity: number;     // Rate of occurrence change
  acceleration: number; // Rate of velocity change
  isEmerging: boolean;
  isDeclining: boolean;
}

export interface TagMomentumSignals {
  tags: TagMomentum[];
  dominantTag: string | null;
  activitySurge: boolean;
  activityCollapse: boolean;
}

// Accept either string[][] or Record<string, number>[] (tag counts per block)
export function getTagMomentum(tagHistory: string[][] | Record<string, number>[]): TagMomentumSignals {
  if (tagHistory.length < 3) {
    return {
      tags: [],
      dominantTag: null,
      activitySurge: false,
      activityCollapse: false,
    };
  }

  // Count tag occurrences in recent windows
  // Handle both formats: string[][] and Record<string, number>[]
  const countTags = (tags: (string[] | Record<string, number>)[]) => {
    const counts: Record<string, number> = {};
    for (const blockTags of tags) {
      if (Array.isArray(blockTags)) {
        // string[] format
        for (const tag of blockTags) {
          counts[tag] = (counts[tag] || 0) + 1;
        }
      } else {
        // Record<string, number> format
        for (const [tag, count] of Object.entries(blockTags)) {
          counts[tag] = (counts[tag] || 0) + count;
        }
      }
    }
    return counts;
  };

  const window = Math.min(10, tagHistory.length);
  const recent = tagHistory.slice(-window);
  const older = tagHistory.slice(-window * 2, -window);
  const oldest = tagHistory.slice(-window * 3, -window * 2);

  const recentCounts = countTags(recent);
  const olderCounts = older.length > 0 ? countTags(older) : {};
  const oldestCounts = oldest.length > 0 ? countTags(oldest) : {};

  // Compute momentum for each tag
  const allTags = new Set([
    ...Object.keys(recentCounts),
    ...Object.keys(olderCounts),
    ...Object.keys(oldestCounts),
  ]);

  const momentums: TagMomentum[] = [];
  for (const tag of allTags) {
    const r = recentCounts[tag] || 0;
    const o = olderCounts[tag] || 0;
    const oo = oldestCounts[tag] || 0;

    const velocity = (r - o) / window;
    const prevVelocity = (o - oo) / window;
    const acceleration = velocity - prevVelocity;

    momentums.push({
      tag,
      velocity,
      acceleration,
      isEmerging: velocity > 0.3 && acceleration > 0,
      isDeclining: velocity < -0.3 && acceleration < 0,
    });
  }

  // Sort by absolute velocity
  momentums.sort((a, b) => Math.abs(b.velocity) - Math.abs(a.velocity));

  const totalVelocity = momentums.reduce((sum, m) => sum + m.velocity, 0);

  return {
    tags: momentums,
    dominantTag: momentums[0]?.tag || null,
    activitySurge: totalVelocity > 1,
    activityCollapse: totalVelocity < -1,
  };
}

// ============================================
// PATTERN MATCHING
// ============================================

export interface PatternMatch {
  similarity: number;           // 0-1 similarity to historical pattern
  patternType: string;          // "pre-pump", "pre-dump", "accumulation", etc.
  historicalOutcome: number;    // What happened after this pattern (% change)
  confidence: number;
}

// Historical pattern templates (simplified - would train from data)
const PATTERN_TEMPLATES = {
  'pre-pump': {
    driftVelocity: [0.3, 0.5, 0.7],  // Accelerating drift
    entropy: [0.6, 0.5, 0.4],         // Decreasing entropy (coordination)
    outcome: 0.05,                     // +5% typical
  },
  'pre-dump': {
    driftVelocity: [0.2, 0.4, 0.8],
    entropy: [0.5, 0.4, 0.3],
    outcome: -0.05,
  },
  'accumulation': {
    driftVelocity: [0.1, 0.1, 0.15],
    entropy: [0.7, 0.7, 0.65],
    outcome: 0.03,
  },
  'distribution': {
    driftVelocity: [0.15, 0.2, 0.25],
    entropy: [0.6, 0.55, 0.5],
    outcome: -0.03,
  },
};

export function matchPattern(
  recentDriftVelocities: number[],
  recentEntropies: number[],
): PatternMatch | null {
  if (recentDriftVelocities.length < 3 || recentEntropies.length < 3) {
    return null;
  }

  const recent3Drift = recentDriftVelocities.slice(-3);
  const recent3Entropy = recentEntropies.slice(-3);

  let bestMatch: PatternMatch | null = null;
  let bestSimilarity = 0;

  for (const [name, template] of Object.entries(PATTERN_TEMPLATES)) {
    // Compute cosine similarity
    const driftSim = cosineSimilarity(recent3Drift, template.driftVelocity);
    const entropySim = cosineSimilarity(recent3Entropy, template.entropy);
    const similarity = (driftSim + entropySim) / 2;

    if (similarity > bestSimilarity && similarity > 0.6) {
      bestSimilarity = similarity;
      bestMatch = {
        similarity,
        patternType: name,
        historicalOutcome: template.outcome,
        confidence: similarity * 0.8, // Discount confidence
      };
    }
  }

  return bestMatch;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

// ============================================
// REGIME CLASSIFICATION
// ============================================

export type MarketRegime = 'risk-on' | 'risk-off' | 'transition' | 'unknown';

export interface RegimeSignals {
  currentRegime: MarketRegime;
  regimeStrength: number;       // 0-1 confidence in regime
  regimeAge: number;            // Blocks since regime started
  transitionProbability: number; // Likelihood of regime change
}

export function classifyRegime(
  driftVelocity: number,
  entropy: number,
  anomalyScore: number,
  fearGreed: number,
): RegimeSignals {
  // Simple rule-based regime classification
  // In production, would use trained classifier

  let regime: MarketRegime = 'unknown';
  let strength = 0;

  if (fearGreed > 60 && entropy > 0.6 && anomalyScore < 0.4) {
    regime = 'risk-on';
    strength = Math.min(1, (fearGreed - 50) / 50 + entropy);
  } else if (fearGreed < 40 && entropy < 0.5) {
    regime = 'risk-off';
    strength = Math.min(1, (50 - fearGreed) / 50 + (1 - entropy));
  } else if (driftVelocity > 0.4 || anomalyScore > 0.6) {
    regime = 'transition';
    strength = Math.min(1, driftVelocity + anomalyScore);
  }

  // Transition probability based on volatility indicators
  const transitionProb = Math.min(1, driftVelocity * 0.5 + anomalyScore * 0.3);

  return {
    currentRegime: regime,
    regimeStrength: strength,
    regimeAge: 0, // Would track historically
    transitionProbability: transitionProb,
  };
}

// ============================================
// AGGREGATE ALL DERIVED SIGNALS
// ============================================

export interface AllDerivedSignals {
  mempool: MempoolSignals;
  entropy: EntropySignals;
  tagMomentum: TagMomentumSignals;
  pattern: PatternMatch | null;
  regime: RegimeSignals;

  // Summary scores
  overallBullish: number;       // -1 to 1
  overallVolatility: number;    // 0 to 1
  actionableSignal: string | null;
}

export function aggregateDerivedSignals(
  fingerprints: number[][],
  tagHistory: string[][] | Record<string, number>[],
  fearGreed: number,
  anomalyScore: number,
): AllDerivedSignals {
  const current = fingerprints[fingerprints.length - 1] || [];
  const previous = fingerprints[fingerprints.length - 2];

  const mempool = getMempoolSignals('eth');
  const entropy = getEntropySignals(current, previous);
  const tagMomentum = getTagMomentum(tagHistory);

  // Compute drift velocities and entropies for pattern matching
  const driftVelocities: number[] = [];
  const entropies: number[] = [];
  for (let i = 1; i < fingerprints.length; i++) {
    const delta = fingerprints[i].map((v, j) => v - (fingerprints[i-1][j] || 0));
    driftVelocities.push(Math.sqrt(delta.reduce((s, d) => s + d*d, 0)));
    entropies.push(computeEntropy(fingerprints[i]));
  }

  const pattern = matchPattern(driftVelocities, entropies);
  const regime = classifyRegime(
    driftVelocities[driftVelocities.length - 1] || 0,
    entropy.entropy,
    anomalyScore,
    fearGreed,
  );

  // Compute summary scores
  let bullish = 0;
  if (pattern?.historicalOutcome) bullish += pattern.historicalOutcome * 10;
  if (regime.currentRegime === 'risk-on') bullish += 0.2;
  if (regime.currentRegime === 'risk-off') bullish -= 0.2;
  if (tagMomentum.activitySurge) bullish += 0.1;
  if (mempool.whaleActivity && !mempool.volatilityPrecursor) bullish += 0.1;
  bullish = Math.max(-1, Math.min(1, bullish));

  let volatility = 0;
  if (mempool.volatilityPrecursor) volatility += 0.3;
  if (entropy.chaosDetected) volatility += 0.2;
  if (regime.transitionProbability > 0.5) volatility += 0.3;
  if (anomalyScore > 0.5) volatility += 0.2;
  volatility = Math.min(1, volatility);

  // Determine actionable signal
  let actionable: string | null = null;
  if (pattern && pattern.confidence > 0.7) {
    actionable = pattern.patternType === 'pre-pump' ? 'BUY - Pattern match' :
                 pattern.patternType === 'pre-dump' ? 'SELL - Pattern match' :
                 pattern.patternType === 'accumulation' ? 'BUY - Accumulation' :
                 pattern.patternType === 'distribution' ? 'SELL - Distribution' : null;
  } else if (entropy.coordinationDetected && mempool.whaleActivity) {
    actionable = 'CAUTION - Coordinated whale activity';
  } else if (regime.currentRegime === 'transition' && regime.regimeStrength > 0.7) {
    actionable = 'REDUCE - Regime transition';
  }

  return {
    mempool,
    entropy,
    tagMomentum,
    pattern,
    regime,
    overallBullish: bullish,
    overallVolatility: volatility,
    actionableSignal: actionable,
  };
}
