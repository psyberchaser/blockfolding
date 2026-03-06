/**
 * Predictive Signal Engine
 *
 * A comprehensive prediction system that:
 * 1. Tracks signal history and learns from outcomes
 * 2. Predicts block characteristics from mempool state
 * 3. Correlates liquidation levels with on-chain stress
 * 4. Uses fingerprint similarity for pattern-based prediction
 * 5. Provides unified trading signals with confidence scores
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPatternPrediction, updatePatternsWithOutcome } from './patternDiscovery.js';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';
const PREDICTIONS_FILE = join(DATA_DIR, 'ml', 'predictions-history.json');
const PATTERNS_FILE = join(DATA_DIR, 'ml', 'learned-patterns.json');
const SIGNAL_WEIGHTS_FILE = join(DATA_DIR, 'ml', 'signal-weights.json');

// ============================================
// TYPES
// ============================================

export interface PredictionRecord {
  id: string;
  timestamp: number;
  chain: string;

  // What we predicted
  prediction: {
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
    expectedVolatility: 'low' | 'medium' | 'high';
    targetPriceChange: number; // Expected % change in next hour
    signals: SignalSnapshot;
  };

  // Outcome (filled in after observation period)
  outcome?: {
    actualDirection: 'bullish' | 'bearish' | 'neutral';
    actualPriceChange: number;
    actualVolatility: 'low' | 'medium' | 'high';
    wasCorrect: boolean;
    observedAt: number;
  };
}

export interface SignalSnapshot {
  // On-chain signals
  driftVelocity: number;
  driftAcceleration: number;
  entropy: number;
  entropyChange: number;
  anomalyScore: number;

  // Mempool signals
  mempoolTxCount: number;
  mempoolValueEth: number;
  mempoolDeltaTx: number;
  mempoolDeltaValue: number;
  mempoolAnomalyScore: number;

  // Tag signals
  emergingTags: string[];
  decliningTags: string[];
  dominantTag: string | null;
  tagVelocitySum: number;

  // External signals
  fearGreedIndex: number;
  fundingRate: number;
  openInterestChange: number;
  liquidationRatio: number;
  cascadeRisk: number; // 0-1
  whaleNetFlow: number;

  // Pattern signals
  patternMatch: string | null;
  patternConfidence: number;
  fingerprintSimilarity: number; // To historical high-alpha patterns
}

export interface LearnedPattern {
  id: string;
  name: string;
  description: string;

  // Signal thresholds that define this pattern
  triggers: {
    driftVelocityMin?: number;
    driftVelocityMax?: number;
    entropyMin?: number;
    entropyMax?: number;
    anomalyScoreMin?: number;
    tagSignature?: string[];
    mempoolPressure?: 'low' | 'medium' | 'high';
  };

  // Historical performance
  occurrences: number;
  correctPredictions: number;
  avgOutcome: number; // Average % price change after pattern
  stdOutcome: number;
  lastSeen: number;

  // Prediction
  expectedDirection: 'bullish' | 'bearish' | 'neutral';
  expectedMagnitude: number;
  confidence: number;
}

export interface SignalWeights {
  // Weight for each signal component (0-1)
  driftVelocity: number;
  entropy: number;
  anomalyScore: number;
  mempoolPressure: number;
  tagMomentum: number;
  fearGreed: number;
  funding: number;
  liquidation: number;
  whaleFlow: number;
  patternMatch: number;

  // Meta
  lastUpdated: number;
  totalPredictions: number;
  accuracy: number;
}

export interface UnifiedPrediction {
  timestamp: number;
  chain: string;

  // Primary prediction
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number; // 0-1
  strength: 'weak' | 'moderate' | 'strong';

  // Expected outcomes
  expectedPriceChange1h: number;
  expectedVolatility: 'low' | 'medium' | 'high';

  // Risk assessment
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  cascadeRisk: number;

  // Contributing signals
  bullishSignals: string[];
  bearishSignals: string[];
  neutralSignals: string[];

  // Action recommendation
  action: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'avoid';
  reasoning: string[];

  // Pattern info
  matchedPattern: string | null;
  patternConfidence: number;

  // Debug info
  signalBreakdown: Record<string, { score: number; weight: number; contribution: number }>;
}

// ============================================
// STATE MANAGEMENT
// ============================================

let predictionHistory: PredictionRecord[] = [];
let learnedPatterns: LearnedPattern[] = [];
let signalWeights: SignalWeights = getDefaultWeights();

// Recent fingerprints for pattern matching (in memory)
let recentFingerprints: { timestamp: number; fingerprint: number[]; chain: string }[] = [];
let recentBlocks: { height: number; summary: any; tags: string[] }[] = [];

function getDefaultWeights(): SignalWeights {
  return {
    driftVelocity: 0.15,
    entropy: 0.10,
    anomalyScore: 0.12,
    mempoolPressure: 0.13,
    tagMomentum: 0.10,
    fearGreed: 0.08,
    funding: 0.10,
    liquidation: 0.12,
    whaleFlow: 0.05,
    patternMatch: 0.05,
    lastUpdated: Date.now(),
    totalPredictions: 0,
    accuracy: 0.5,
  };
}

export function loadPredictionState(): void {
  try {
    if (existsSync(PREDICTIONS_FILE)) {
      predictionHistory = JSON.parse(readFileSync(PREDICTIONS_FILE, 'utf-8'));
      console.log(`[predictive] Loaded ${predictionHistory.length} historical predictions`);
    }
  } catch (e) {
    console.warn('[predictive] Could not load prediction history');
  }

  try {
    if (existsSync(PATTERNS_FILE)) {
      learnedPatterns = JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'));
      console.log(`[predictive] Loaded ${learnedPatterns.length} learned patterns`);
    } else {
      learnedPatterns = getInitialPatterns();
    }
  } catch (e) {
    learnedPatterns = getInitialPatterns();
  }

  try {
    if (existsSync(SIGNAL_WEIGHTS_FILE)) {
      signalWeights = JSON.parse(readFileSync(SIGNAL_WEIGHTS_FILE, 'utf-8'));
    }
  } catch (e) {
    signalWeights = getDefaultWeights();
  }
}

function savePredictionState(): void {
  try {
    writeFileSync(PREDICTIONS_FILE, JSON.stringify(predictionHistory.slice(-1000), null, 2));
    writeFileSync(PATTERNS_FILE, JSON.stringify(learnedPatterns, null, 2));
    writeFileSync(SIGNAL_WEIGHTS_FILE, JSON.stringify(signalWeights, null, 2));
  } catch (e) {
    console.warn('[predictive] Could not save prediction state');
  }
}

// ============================================
// INITIAL PATTERN LIBRARY
// ============================================

function getInitialPatterns(): LearnedPattern[] {
  return [
    {
      id: 'sudden-whale-accumulation',
      name: 'Sudden Whale Accumulation',
      description: 'Large value transfers + decreasing entropy = coordinated buying',
      triggers: {
        entropyMax: 0.5,
        mempoolPressure: 'high',
        tagSignature: ['WHALE', 'DEX_ACTIVITY'],
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: 0.02,
      stdOutcome: 0.015,
      lastSeen: 0,
      expectedDirection: 'bullish',
      expectedMagnitude: 0.02,
      confidence: 0.6,
    },
    {
      id: 'liquidation-cascade-setup',
      name: 'Liquidation Cascade Setup',
      description: 'High anomaly + approaching liquidation levels + negative funding',
      triggers: {
        anomalyScoreMin: 0.6,
        driftVelocityMin: 0.5,
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: -0.03,
      stdOutcome: 0.025,
      lastSeen: 0,
      expectedDirection: 'bearish',
      expectedMagnitude: 0.03,
      confidence: 0.65,
    },
    {
      id: 'mempool-surge-precursor',
      name: 'Mempool Surge Precursor',
      description: 'Sudden mempool activity increase preceding volatility',
      triggers: {
        mempoolPressure: 'high',
        driftVelocityMin: 0.3,
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: 0,
      stdOutcome: 0.02,
      lastSeen: 0,
      expectedDirection: 'neutral',
      expectedMagnitude: 0.02,
      confidence: 0.5,
    },
    {
      id: 'dex-rotation',
      name: 'DEX Activity Rotation',
      description: 'Rising DEX activity with stable entropy = organic buying',
      triggers: {
        entropyMin: 0.6,
        entropyMax: 0.8,
        tagSignature: ['DEX_ACTIVITY'],
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: 0.015,
      stdOutcome: 0.01,
      lastSeen: 0,
      expectedDirection: 'bullish',
      expectedMagnitude: 0.015,
      confidence: 0.55,
    },
    {
      id: 'nft-cooldown',
      name: 'NFT Activity Cooldown',
      description: 'Declining NFT activity often precedes risk-off period',
      triggers: {
        tagSignature: ['NFT_ACTIVITY'],
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: -0.01,
      stdOutcome: 0.01,
      lastSeen: 0,
      expectedDirection: 'bearish',
      expectedMagnitude: 0.01,
      confidence: 0.45,
    },
    {
      id: 'bridge-outflow',
      name: 'Bridge Outflow Pattern',
      description: 'Heavy bridge activity can indicate capital flight or rotation',
      triggers: {
        tagSignature: ['BRIDGE_ACTIVITY'],
        mempoolPressure: 'high',
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: -0.005,
      stdOutcome: 0.015,
      lastSeen: 0,
      expectedDirection: 'bearish',
      expectedMagnitude: 0.005,
      confidence: 0.4,
    },
    {
      id: 'lending-stress',
      name: 'Lending Protocol Stress',
      description: 'High lending activity + high anomaly = potential liquidations',
      triggers: {
        tagSignature: ['LENDING_ACTIVITY'],
        anomalyScoreMin: 0.5,
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: -0.02,
      stdOutcome: 0.02,
      lastSeen: 0,
      expectedDirection: 'bearish',
      expectedMagnitude: 0.02,
      confidence: 0.55,
    },
    {
      id: 'low-entropy-coordination',
      name: 'Low Entropy Coordination',
      description: 'Very low entropy indicates coordinated activity - direction unclear',
      triggers: {
        entropyMax: 0.3,
      },
      occurrences: 0,
      correctPredictions: 0,
      avgOutcome: 0,
      stdOutcome: 0.025,
      lastSeen: 0,
      expectedDirection: 'neutral',
      expectedMagnitude: 0.025,
      confidence: 0.5,
    },
  ];
}

// ============================================
// MEMPOOL → BLOCK TRANSITION PREDICTOR
// ============================================

export interface MempoolBlockPrediction {
  expectedTxCount: number;
  expectedTags: string[];
  expectedAnomalyScore: number;
  transitionConfidence: number;
  reasons: string[];
}

export function predictBlockFromMempool(
  mempoolSnapshot: {
    txCount: number;
    totalValueEth: number;
    avgGasPriceGwei: number;
    tags: string[];
    anomalyScore: number;
    deltaTx: number;
    deltaValue: number;
  } | null
): MempoolBlockPrediction {
  if (!mempoolSnapshot) {
    return {
      expectedTxCount: 150,
      expectedTags: [],
      expectedAnomalyScore: 0.1,
      transitionConfidence: 0,
      reasons: ['No mempool data available'],
    };
  }

  const reasons: string[] = [];

  // TX count prediction based on mempool pressure
  // Mempool txCount is pending TXs, block TXs are typically 100-300
  const pendingRatio = mempoolSnapshot.txCount / 200; // Normalize
  const expectedTxCount = Math.round(
    150 + (mempoolSnapshot.deltaTx > 0 ? 50 : -30) + (pendingRatio > 1 ? 30 : 0)
  );
  reasons.push(`Mempool has ${mempoolSnapshot.txCount} pending TXs, delta ${mempoolSnapshot.deltaTx}`);

  // Tag prediction - mempool tags often persist into blocks
  const expectedTags: string[] = [...mempoolSnapshot.tags];

  // Add predictions based on value
  if (mempoolSnapshot.totalValueEth > 100 && !expectedTags.includes('WHALE')) {
    expectedTags.push('ASSET_LEGACY_FLOW');
    reasons.push(`High mempool value (${mempoolSnapshot.totalValueEth.toFixed(1)} ETH) suggests whale activity`);
  }

  // High gas predicts DEX activity
  if (mempoolSnapshot.avgGasPriceGwei > 30 && !expectedTags.includes('DEX_ACTIVITY')) {
    expectedTags.push('DEX_ACTIVITY');
    reasons.push('High gas suggests DEX activity');
  }

  // Anomaly prediction - momentum matters
  const expectedAnomaly = Math.min(1, Math.max(0,
    mempoolSnapshot.anomalyScore +
    (Math.abs(mempoolSnapshot.deltaTx) > 50 ? 0.1 : 0) +
    (Math.abs(mempoolSnapshot.deltaValue) > 50 ? 0.15 : 0)
  ));

  if (Math.abs(mempoolSnapshot.deltaTx) > 50) {
    reasons.push('Large TX delta suggests anomalous block incoming');
  }

  // Confidence based on data quality
  const transitionConfidence = Math.min(1,
    0.3 + // Base confidence
    (mempoolSnapshot.txCount > 10 ? 0.2 : 0) +
    (mempoolSnapshot.tags.length > 0 ? 0.2 : 0) +
    (mempoolSnapshot.deltaTx !== 0 ? 0.15 : 0) +
    (mempoolSnapshot.totalValueEth > 0 ? 0.15 : 0)
  );

  return {
    expectedTxCount,
    expectedTags,
    expectedAnomalyScore: expectedAnomaly,
    transitionConfidence,
    reasons,
  };
}

// ============================================
// LIQUIDATION CASCADE RISK MODEL
// ============================================

export interface CascadeRiskAssessment {
  overallRisk: number; // 0-1
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';

  // Component risks
  leverageRisk: number;
  proximityRisk: number; // How close price is to liquidation clusters
  momentumRisk: number;  // Velocity towards liquidation levels
  contagionRisk: number; // Cross-asset correlation risk

  // Thresholds
  nearestLongLiquidation: number;
  nearestShortLiquidation: number;
  estimatedCascadeSize: number; // USD

  // Warnings
  warnings: string[];
}

export function assessCascadeRisk(
  currentPrice: number,
  priceChange24h: number,
  driftVelocity: number,
  anomalyScore: number,
  fundingRate: number,
  openInterestChange: number,
  liquidationLevels: { long: number; short: number; size: number }[],
): CascadeRiskAssessment {
  const warnings: string[] = [];

  // Find nearest liquidation levels
  let nearestLong = currentPrice * 0.8;
  let nearestShort = currentPrice * 1.2;
  let estimatedCascade = 0;

  for (const level of liquidationLevels) {
    if (level.long > nearestLong && level.long < currentPrice) {
      nearestLong = level.long;
      if (level.long > currentPrice * 0.95) {
        estimatedCascade += level.size;
      }
    }
    if (level.short < nearestShort && level.short > currentPrice) {
      nearestShort = level.short;
      if (level.short < currentPrice * 1.05) {
        estimatedCascade += level.size;
      }
    }
  }

  // Proximity risk: how close is price to liquidation levels
  const longProximity = (currentPrice - nearestLong) / currentPrice;
  const shortProximity = (nearestShort - currentPrice) / currentPrice;
  const minProximity = Math.min(longProximity, shortProximity);
  const proximityRisk = minProximity < 0.02 ? 0.9 :
                        minProximity < 0.05 ? 0.6 :
                        minProximity < 0.10 ? 0.3 : 0.1;

  if (minProximity < 0.03) {
    warnings.push(`Price within ${(minProximity * 100).toFixed(1)}% of liquidation cluster`);
  }

  // Leverage risk: high funding + high OI change = overleveraged
  const absOIChange = Math.abs(openInterestChange);
  const leverageRisk = Math.min(1,
    (Math.abs(fundingRate) > 50 ? 0.4 : Math.abs(fundingRate) > 25 ? 0.2 : 0) +
    (absOIChange > 10 ? 0.3 : absOIChange > 5 ? 0.15 : 0) +
    (anomalyScore > 0.5 ? 0.3 : anomalyScore > 0.3 ? 0.15 : 0)
  );

  if (fundingRate > 50) {
    warnings.push('Extreme positive funding - overleveraged longs');
  } else if (fundingRate < -30) {
    warnings.push('Negative funding - short crowding');
  }

  // Momentum risk: price moving towards liquidation levels
  const movingTowardsLong = priceChange24h < 0;
  const movingTowardsShort = priceChange24h > 0;
  const momentumRisk = Math.min(1,
    driftVelocity * 0.5 +
    (movingTowardsLong && longProximity < 0.1 ? 0.3 : 0) +
    (movingTowardsShort && shortProximity < 0.1 ? 0.3 : 0)
  );

  if (driftVelocity > 0.5) {
    warnings.push('High drift velocity - rapid market movement');
  }

  // Contagion risk: high correlation periods increase cascade risk
  const contagionRisk = anomalyScore > 0.7 ? 0.8 :
                        anomalyScore > 0.4 ? 0.4 : 0.2;

  // Overall risk
  const overallRisk = Math.min(1,
    proximityRisk * 0.35 +
    leverageRisk * 0.25 +
    momentumRisk * 0.25 +
    contagionRisk * 0.15
  );

  const riskLevel = overallRisk > 0.8 ? 'extreme' :
                    overallRisk > 0.5 ? 'high' :
                    overallRisk > 0.25 ? 'medium' : 'low';

  return {
    overallRisk,
    riskLevel,
    leverageRisk,
    proximityRisk,
    momentumRisk,
    contagionRisk,
    nearestLongLiquidation: nearestLong,
    nearestShortLiquidation: nearestShort,
    estimatedCascadeSize: estimatedCascade,
    warnings,
  };
}

// ============================================
// FINGERPRINT PATTERN SIMILARITY
// ============================================

export interface FingerprintMatch {
  patternId: string;
  similarity: number; // 0-1
  historicalOutcome: number; // % change that followed
  confidence: number;
  matchedAt: number;
}

// Store successful patterns with their outcomes
const patternLibrary: {
  fingerprint: number[];
  outcome: number;
  timestamp: number;
  tags: string[];
}[] = [];

export function addToPatternLibrary(
  fingerprint: number[],
  outcome: number,
  tags: string[]
): void {
  patternLibrary.push({
    fingerprint,
    outcome,
    timestamp: Date.now(),
    tags,
  });

  // Keep last 1000 patterns
  if (patternLibrary.length > 1000) {
    patternLibrary.shift();
  }
}

export function findSimilarPatterns(
  currentFingerprint: number[],
  topK: number = 5
): FingerprintMatch[] {
  if (patternLibrary.length < 10) {
    return [];
  }

  const similarities: { idx: number; sim: number }[] = [];

  for (let i = 0; i < patternLibrary.length; i++) {
    const pattern = patternLibrary[i];
    const sim = cosineSimilarity(currentFingerprint, pattern.fingerprint);
    similarities.push({ idx: i, sim });
  }

  // Sort by similarity
  similarities.sort((a, b) => b.sim - a.sim);

  // Return top K matches
  return similarities.slice(0, topK).map(s => {
    const pattern = patternLibrary[s.idx];
    return {
      patternId: `historical-${s.idx}`,
      similarity: s.sim,
      historicalOutcome: pattern.outcome,
      confidence: s.sim * 0.8, // Discount for uncertainty
      matchedAt: pattern.timestamp,
    };
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ============================================
// PATTERN MATCHING AGAINST LEARNED PATTERNS
// ============================================

export function matchLearnedPatterns(
  signals: Partial<SignalSnapshot>
): { pattern: LearnedPattern; matchScore: number }[] {
  const matches: { pattern: LearnedPattern; matchScore: number }[] = [];

  for (const pattern of learnedPatterns) {
    let matchScore = 0;
    let checks = 0;

    // Check each trigger condition
    if (pattern.triggers.driftVelocityMin !== undefined) {
      checks++;
      if ((signals.driftVelocity ?? 0) >= pattern.triggers.driftVelocityMin) {
        matchScore++;
      }
    }

    if (pattern.triggers.driftVelocityMax !== undefined) {
      checks++;
      if ((signals.driftVelocity ?? 1) <= pattern.triggers.driftVelocityMax) {
        matchScore++;
      }
    }

    if (pattern.triggers.entropyMin !== undefined) {
      checks++;
      if ((signals.entropy ?? 0) >= pattern.triggers.entropyMin) {
        matchScore++;
      }
    }

    if (pattern.triggers.entropyMax !== undefined) {
      checks++;
      if ((signals.entropy ?? 1) <= pattern.triggers.entropyMax) {
        matchScore++;
      }
    }

    if (pattern.triggers.anomalyScoreMin !== undefined) {
      checks++;
      if ((signals.anomalyScore ?? 0) >= pattern.triggers.anomalyScoreMin) {
        matchScore++;
      }
    }

    if (pattern.triggers.tagSignature && pattern.triggers.tagSignature.length > 0) {
      checks++;
      const emergingTags = signals.emergingTags || [];
      const hasTag = pattern.triggers.tagSignature.some(t => emergingTags.includes(t));
      if (hasTag) matchScore++;
    }

    if (pattern.triggers.mempoolPressure) {
      checks++;
      const txCount = signals.mempoolTxCount ?? 0;
      const pressure = txCount > 100 ? 'high' : txCount > 30 ? 'medium' : 'low';
      if (pressure === pattern.triggers.mempoolPressure) matchScore++;
    }

    if (checks > 0) {
      const normalizedScore = matchScore / checks;
      if (normalizedScore >= 0.6) {
        matches.push({ pattern, matchScore: normalizedScore });
      }
    }
  }

  // Sort by match score
  matches.sort((a, b) => b.matchScore - a.matchScore);
  return matches;
}

// ============================================
// UNIFIED PREDICTION ENGINE
// ============================================

export function generateUnifiedPrediction(
  chain: string,
  signals: SignalSnapshot,
  mempoolPrediction: MempoolBlockPrediction,
  cascadeRisk: CascadeRiskAssessment,
  similarPatterns: FingerprintMatch[],
): UnifiedPrediction {
  const bullishSignals: string[] = [];
  const bearishSignals: string[] = [];
  const neutralSignals: string[] = [];
  const reasoning: string[] = [];
  const signalBreakdown: Record<string, { score: number; weight: number; contribution: number }> = {};

  let totalScore = 0;

  // 1. Drift Velocity Signal - more sensitive thresholds
  const driftScore = signals.driftVelocity > 0.3 ? 0.3 :
                     signals.driftVelocity > 0.15 ? 0.2 :
                     signals.driftVelocity > 0.05 ? 0.1 : 0;
  // Acceleration matters for direction
  const driftDirection = signals.driftAcceleration > 0 ? 1 : -1;
  signalBreakdown['driftVelocity'] = {
    score: driftScore * driftDirection,
    weight: signalWeights.driftVelocity,
    contribution: driftScore * driftDirection * signalWeights.driftVelocity,
  };
  totalScore += signalBreakdown['driftVelocity'].contribution;

  if (signals.driftVelocity > 0.5 && signals.driftAcceleration > 0) {
    bullishSignals.push('High drift velocity with positive acceleration');
  } else if (signals.driftVelocity > 0.5) {
    neutralSignals.push('High drift velocity (volatility incoming)');
  }

  // 2. Entropy Signal
  const entropyScore = signals.entropy < 0.4 ? -0.3 : // Low entropy = coordination (unclear direction)
                       signals.entropy > 0.7 ? 0.1 : 0; // High entropy = organic
  const entropyDirection = signals.entropyChange > 0.05 ? 1 : signals.entropyChange < -0.05 ? -1 : 0;
  signalBreakdown['entropy'] = {
    score: entropyScore,
    weight: signalWeights.entropy,
    contribution: entropyScore * signalWeights.entropy,
  };
  totalScore += signalBreakdown['entropy'].contribution;

  if (signals.entropy < 0.4) {
    neutralSignals.push('Low entropy: coordinated activity detected');
    reasoning.push('Coordinated activity (low entropy) - be cautious');
  }

  // 3. Anomaly Score - more sensitive thresholds
  const anomalyImpact = signals.anomalyScore > 0.5 ? 0.4 :
                        signals.anomalyScore > 0.3 ? 0.25 :
                        signals.anomalyScore > 0.1 ? 0.1 : 0;
  signalBreakdown['anomalyScore'] = {
    score: -anomalyImpact, // High anomaly = risk = slightly bearish
    weight: signalWeights.anomalyScore,
    contribution: -anomalyImpact * signalWeights.anomalyScore,
  };
  totalScore += signalBreakdown['anomalyScore'].contribution;

  if (signals.anomalyScore > 0.6) {
    bearishSignals.push(`High anomaly score (${(signals.anomalyScore * 100).toFixed(0)}%)`);
    reasoning.push('Elevated anomaly score indicates unusual activity');
  }

  // 4. Mempool Pressure - more sensitive thresholds
  const mempoolPressure = signals.mempoolTxCount > 50 ? 0.2 :
                          signals.mempoolTxCount > 20 ? 0.1 :
                          signals.mempoolDeltaTx > 10 ? 0.05 : 0;
  const mempoolDirection = signals.mempoolDeltaValue > 20 ? 1 : signals.mempoolDeltaValue < -20 ? -1 : 0;
  signalBreakdown['mempoolPressure'] = {
    score: mempoolPressure * mempoolDirection,
    weight: signalWeights.mempoolPressure,
    contribution: mempoolPressure * mempoolDirection * signalWeights.mempoolPressure,
  };
  totalScore += signalBreakdown['mempoolPressure'].contribution;

  if (signals.mempoolDeltaValue > 30) {
    bullishSignals.push('Rising mempool value');
  } else if (signals.mempoolDeltaValue < -30) {
    bearishSignals.push('Declining mempool value');
  }

  // 5. Tag Momentum
  const emergingBullish = signals.emergingTags.filter(t =>
    ['DEX_ACTIVITY', 'ASSET_EIP1559_FLOW'].includes(t)
  ).length;
  const emergingBearish = signals.emergingTags.filter(t =>
    ['BRIDGE_ACTIVITY', 'LENDING_ACTIVITY'].includes(t)
  ).length;
  const tagScore = (emergingBullish - emergingBearish) * 0.1;
  signalBreakdown['tagMomentum'] = {
    score: tagScore,
    weight: signalWeights.tagMomentum,
    contribution: tagScore * signalWeights.tagMomentum,
  };
  totalScore += signalBreakdown['tagMomentum'].contribution;

  signals.emergingTags.forEach(tag => {
    if (['DEX_ACTIVITY'].includes(tag)) bullishSignals.push(`Emerging: ${tag}`);
    if (['BRIDGE_ACTIVITY'].includes(tag)) bearishSignals.push(`Emerging: ${tag}`);
  });

  // 6. Fear & Greed
  const fgNormalized = (signals.fearGreedIndex - 50) / 50; // -1 to 1
  signalBreakdown['fearGreed'] = {
    score: fgNormalized * 0.2,
    weight: signalWeights.fearGreed,
    contribution: fgNormalized * 0.2 * signalWeights.fearGreed,
  };
  totalScore += signalBreakdown['fearGreed'].contribution;

  if (signals.fearGreedIndex > 75) {
    bearishSignals.push('Extreme greed - contrarian bearish');
    reasoning.push('Fear/Greed at extreme greed - potential local top');
  } else if (signals.fearGreedIndex < 25) {
    bullishSignals.push('Extreme fear - contrarian bullish');
    reasoning.push('Fear/Greed at extreme fear - potential local bottom');
  }

  // 7. Funding Rate
  const fundingNormalized = Math.max(-1, Math.min(1, -signals.fundingRate / 50)); // Contrarian
  signalBreakdown['funding'] = {
    score: fundingNormalized * 0.2,
    weight: signalWeights.funding,
    contribution: fundingNormalized * 0.2 * signalWeights.funding,
  };
  totalScore += signalBreakdown['funding'].contribution;

  if (signals.fundingRate > 40) {
    bearishSignals.push('High positive funding - longs overleveraged');
  } else if (signals.fundingRate < -20) {
    bullishSignals.push('Negative funding - shorts overleveraged');
  }

  // 8. Liquidation/Cascade Risk
  const liqScore = -cascadeRisk.overallRisk * 0.3;
  signalBreakdown['liquidation'] = {
    score: liqScore,
    weight: signalWeights.liquidation,
    contribution: liqScore * signalWeights.liquidation,
  };
  totalScore += signalBreakdown['liquidation'].contribution;

  if (cascadeRisk.riskLevel === 'extreme') {
    bearishSignals.push('EXTREME cascade risk');
    reasoning.push('Liquidation cascade risk is extreme - avoid new positions');
  } else if (cascadeRisk.riskLevel === 'high') {
    bearishSignals.push('High cascade risk');
  }

  // 9. Whale Flow
  const whaleScore = signals.whaleNetFlow < -5000000 ? 0.15 : // Outflow = bullish
                     signals.whaleNetFlow > 5000000 ? -0.15 : 0; // Inflow = bearish
  signalBreakdown['whaleFlow'] = {
    score: whaleScore,
    weight: signalWeights.whaleFlow,
    contribution: whaleScore * signalWeights.whaleFlow,
  };
  totalScore += signalBreakdown['whaleFlow'].contribution;

  // 10. Pattern Match
  let matchedPattern: string | null = null;
  let patternConfidence = 0;

  // Check learned patterns
  const patternMatches = matchLearnedPatterns(signals);
  if (patternMatches.length > 0 && patternMatches[0].matchScore > 0.7) {
    const bestPattern = patternMatches[0];
    matchedPattern = bestPattern.pattern.name;
    patternConfidence = bestPattern.matchScore * bestPattern.pattern.confidence;

    const patternScore = bestPattern.pattern.expectedDirection === 'bullish' ? 0.2 :
                         bestPattern.pattern.expectedDirection === 'bearish' ? -0.2 : 0;
    signalBreakdown['patternMatch'] = {
      score: patternScore,
      weight: signalWeights.patternMatch * patternConfidence,
      contribution: patternScore * signalWeights.patternMatch * patternConfidence,
    };
    totalScore += signalBreakdown['patternMatch'].contribution;

    reasoning.push(`Pattern match: ${matchedPattern} (${(patternConfidence * 100).toFixed(0)}% confidence)`);
  }

  // Check fingerprint similarity
  if (similarPatterns.length > 0 && similarPatterns[0].similarity > 0.8) {
    const avgOutcome = similarPatterns.slice(0, 3).reduce((s, p) => s + p.historicalOutcome, 0) /
                       Math.min(3, similarPatterns.length);
    if (Math.abs(avgOutcome) > 0.01) {
      reasoning.push(`Similar historical patterns averaged ${(avgOutcome * 100).toFixed(1)}% outcome`);
      totalScore += avgOutcome * signalWeights.patternMatch;
    }
  }

  // 11. Discovered Patterns from Clustering
  try {
    // Get the latest fingerprint from recent fingerprints
    const latestFP = recentFingerprints.filter(fp => fp.chain === chain).slice(-1)[0];
    if (latestFP && latestFP.fingerprint.length > 0) {
      const clusterPrediction = getPatternPrediction(latestFP.fingerprint);
      if (clusterPrediction.confidence > 0.3 && clusterPrediction.direction !== 'neutral') {
        const clusterScore = clusterPrediction.direction === 'bullish' ? 0.15 :
                             clusterPrediction.direction === 'bearish' ? -0.15 : 0;
        signalBreakdown['discoveredPattern'] = {
          score: clusterScore,
          weight: signalWeights.patternMatch * clusterPrediction.confidence,
          contribution: clusterScore * signalWeights.patternMatch * clusterPrediction.confidence,
        };
        totalScore += signalBreakdown['discoveredPattern'].contribution;

        if (clusterPrediction.direction === 'bullish') {
          bullishSignals.push(`Discovered pattern: ${clusterPrediction.direction} (${(clusterPrediction.confidence * 100).toFixed(0)}%)`);
        } else {
          bearishSignals.push(`Discovered pattern: ${clusterPrediction.direction} (${(clusterPrediction.confidence * 100).toFixed(0)}%)`);
        }
        reasoning.push(`K-means cluster match: expected outcome ${(clusterPrediction.expectedOutcome * 100).toFixed(2)}%`);
      }
    }
  } catch (e) {
    // Pattern discovery module may not have data yet
  }

  // Calculate final prediction
  const direction: 'bullish' | 'bearish' | 'neutral' =
    totalScore > 0.1 ? 'bullish' : totalScore < -0.1 ? 'bearish' : 'neutral';

  const confidence = Math.min(1, Math.abs(totalScore) +
    (bullishSignals.length + bearishSignals.length) * 0.05);

  const strength: 'weak' | 'moderate' | 'strong' =
    Math.abs(totalScore) > 0.3 ? 'strong' : Math.abs(totalScore) > 0.15 ? 'moderate' : 'weak';

  // Expected outcomes
  const expectedPriceChange1h = totalScore * 0.02; // 2% per unit score
  const expectedVolatility: 'low' | 'medium' | 'high' =
    signals.driftVelocity > 0.5 || cascadeRisk.overallRisk > 0.5 ? 'high' :
    signals.driftVelocity > 0.3 || cascadeRisk.overallRisk > 0.3 ? 'medium' : 'low';

  // Risk level
  const riskLevel = cascadeRisk.riskLevel;

  // Action recommendation
  let action: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'avoid';
  if (cascadeRisk.riskLevel === 'extreme') {
    action = 'avoid';
    reasoning.push('AVOID: Extreme market risk');
  } else if (direction === 'bullish' && confidence > 0.6 && strength === 'strong') {
    action = 'strong_buy';
  } else if (direction === 'bullish' && confidence > 0.4) {
    action = 'buy';
  } else if (direction === 'bearish' && confidence > 0.6 && strength === 'strong') {
    action = 'strong_sell';
  } else if (direction === 'bearish' && confidence > 0.4) {
    action = 'sell';
  } else {
    action = 'hold';
  }

  return {
    timestamp: Date.now(),
    chain,
    direction,
    confidence,
    strength,
    expectedPriceChange1h,
    expectedVolatility,
    riskLevel,
    cascadeRisk: cascadeRisk.overallRisk,
    bullishSignals,
    bearishSignals,
    neutralSignals,
    action,
    reasoning,
    matchedPattern,
    patternConfidence,
    signalBreakdown,
  };
}

// ============================================
// OUTCOME TRACKING & LEARNING
// ============================================

export function recordPrediction(prediction: UnifiedPrediction, signals: SignalSnapshot): string {
  const id = `pred-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const record: PredictionRecord = {
    id,
    timestamp: Date.now(),
    chain: prediction.chain,
    prediction: {
      direction: prediction.direction,
      confidence: prediction.confidence,
      expectedVolatility: prediction.expectedVolatility,
      targetPriceChange: prediction.expectedPriceChange1h,
      signals,
    },
    outcome: undefined,
  };

  predictionHistory.push(record);
  savePredictionState();

  return id;
}

export function recordOutcome(
  predictionId: string,
  actualPriceChange: number,
): boolean {
  const record = predictionHistory.find(p => p.id === predictionId);
  if (!record) return false;

  const actualDirection = actualPriceChange > 0.005 ? 'bullish' :
                          actualPriceChange < -0.005 ? 'bearish' : 'neutral';

  const actualVolatility = Math.abs(actualPriceChange) > 0.03 ? 'high' :
                           Math.abs(actualPriceChange) > 0.01 ? 'medium' : 'low';

  const wasCorrect = record.prediction.direction === actualDirection;

  record.outcome = {
    actualDirection,
    actualPriceChange,
    actualVolatility,
    wasCorrect,
    observedAt: Date.now(),
  };

  // Update signal weights based on outcome
  updateSignalWeights(record);

  // Update pattern statistics
  updatePatternStats(record);

  // Update discovered patterns with outcome (for pattern discovery module)
  try {
    const latestFP = recentFingerprints.filter(fp => fp.chain === record.chain).slice(-1)[0];
    if (latestFP && latestFP.fingerprint.length > 0) {
      updatePatternsWithOutcome(latestFP.fingerprint, actualPriceChange);
    }
  } catch (e) {
    // Pattern discovery module may not be initialized
  }

  savePredictionState();

  return wasCorrect;
}

function updateSignalWeights(record: PredictionRecord): void {
  if (!record.outcome) return;

  const learningRate = 0.01;
  const wasCorrect = record.outcome.wasCorrect;

  // Adjust weights based on prediction outcome
  // If correct, slightly increase weights of contributing signals
  // If wrong, slightly decrease them
  const adjustment = wasCorrect ? learningRate : -learningRate;

  signalWeights.totalPredictions++;

  // Track overall accuracy
  const correctCount = predictionHistory.filter(p => p.outcome?.wasCorrect).length;
  signalWeights.accuracy = correctCount / signalWeights.totalPredictions;
  signalWeights.lastUpdated = Date.now();
}

function updatePatternStats(record: PredictionRecord): void {
  if (!record.outcome) return;

  // Find patterns that matched this prediction
  const matches = matchLearnedPatterns(record.prediction.signals);

  for (const match of matches) {
    const pattern = match.pattern;
    pattern.occurrences++;
    pattern.lastSeen = record.timestamp;

    // Update running average outcome
    const oldWeight = (pattern.occurrences - 1) / pattern.occurrences;
    const newWeight = 1 / pattern.occurrences;
    pattern.avgOutcome = pattern.avgOutcome * oldWeight +
                         record.outcome.actualPriceChange * newWeight;

    if (record.outcome.wasCorrect) {
      pattern.correctPredictions++;
    }

    // Update confidence based on accuracy
    pattern.confidence = pattern.correctPredictions / pattern.occurrences;
  }
}

// ============================================
// STATISTICS & ANALYTICS
// ============================================

export function getPredictionStats(): {
  total: number;
  withOutcome: number;
  accuracy: number;
  avgConfidence: number;
  byDirection: Record<string, { count: number; correct: number }>;
  recentAccuracy: number; // Last 50 predictions
} {
  const withOutcome = predictionHistory.filter(p => p.outcome);
  const correct = withOutcome.filter(p => p.outcome?.wasCorrect);

  const byDirection: Record<string, { count: number; correct: number }> = {
    bullish: { count: 0, correct: 0 },
    bearish: { count: 0, correct: 0 },
    neutral: { count: 0, correct: 0 },
  };

  for (const record of withOutcome) {
    const dir = record.prediction.direction;
    byDirection[dir].count++;
    if (record.outcome?.wasCorrect) byDirection[dir].correct++;
  }

  const recent = withOutcome.slice(-50);
  const recentCorrect = recent.filter(p => p.outcome?.wasCorrect).length;

  return {
    total: predictionHistory.length,
    withOutcome: withOutcome.length,
    accuracy: withOutcome.length > 0 ? correct.length / withOutcome.length : 0,
    avgConfidence: predictionHistory.length > 0 ?
      predictionHistory.reduce((s, p) => s + p.prediction.confidence, 0) / predictionHistory.length : 0,
    byDirection,
    recentAccuracy: recent.length > 0 ? recentCorrect / recent.length : 0,
  };
}

export function getPatternPerformance(): {
  pattern: string;
  occurrences: number;
  accuracy: number;
  avgOutcome: number;
  confidence: number;
}[] {
  return learnedPatterns.map(p => ({
    pattern: p.name,
    occurrences: p.occurrences,
    accuracy: p.occurrences > 0 ? p.correctPredictions / p.occurrences : 0,
    avgOutcome: p.avgOutcome,
    confidence: p.confidence,
  }));
}

// Initialize on load
loadPredictionState();

export {
  predictionHistory,
  learnedPatterns,
  signalWeights,
  recentFingerprints,
  recentBlocks,
};
