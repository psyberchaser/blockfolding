/**
 * Multi-Timeframe Predictions & Position Sizing
 *
 * Provides predictions across multiple timeframes and Kelly criterion position sizing:
 * - 5 minute predictions (scalping)
 * - 1 hour predictions (day trading)
 * - 4 hour predictions (swing trading)
 * - 24 hour predictions (position trading)
 * - Kelly criterion for optimal position sizing
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';
const TIMEFRAME_STATS_FILE = join(DATA_DIR, 'ml', 'timeframe-stats.json');
const POSITION_HISTORY_FILE = join(DATA_DIR, 'ml', 'position-history.json');

export type Timeframe = '5m' | '1h' | '4h' | '24h';

export interface TimeframePrediction {
  timeframe: Timeframe;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  expectedReturn: number; // Expected % return
  volatilityEstimate: number; // Expected volatility
  signalStrength: number; // 0-1 strength of the signal
}

export interface MultiTimeframePrediction {
  timestamp: number;
  chain: string;
  predictions: TimeframePrediction[];
  consensus: {
    direction: 'bullish' | 'bearish' | 'neutral' | 'mixed';
    strength: number;
    alignment: number; // 0-1, how aligned are the timeframes
  };
  recommendedTimeframe: Timeframe;
  overallConfidence: number;
}

export interface PositionSizeRecommendation {
  kellyFraction: number; // Raw Kelly %
  adjustedKelly: number; // Quarter Kelly for safety
  recommendedSize: number; // % of portfolio
  maxSize: number; // Hard cap
  riskPerTrade: number; // % of portfolio at risk
  reasoning: string[];
}

export interface TimeframeStats {
  timeframe: Timeframe;
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
  avgWin: number;
  avgLoss: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  lastUpdated: number;
}

// Historical stats per timeframe
let timeframeStats: Record<Timeframe, TimeframeStats> = {
  '5m': createDefaultStats('5m'),
  '1h': createDefaultStats('1h'),
  '4h': createDefaultStats('4h'),
  '24h': createDefaultStats('24h'),
};

function createDefaultStats(tf: Timeframe): TimeframeStats {
  return {
    timeframe: tf,
    totalPredictions: 0,
    correctPredictions: 0,
    accuracy: 0.5,
    avgWin: 0.01,
    avgLoss: 0.01,
    winRate: 0.5,
    profitFactor: 1.0,
    sharpeRatio: 0,
    lastUpdated: Date.now(),
  };
}

// Timeframe-specific parameters
const TIMEFRAME_PARAMS: Record<Timeframe, {
  volatilityMultiplier: number;
  signalDecay: number;
  minConfidence: number;
}> = {
  '5m': {
    volatilityMultiplier: 0.5,  // Lower expected moves
    signalDecay: 0.9,           // Signals decay fast
    minConfidence: 0.6,         // Need high confidence for short term
  },
  '1h': {
    volatilityMultiplier: 1.0,
    signalDecay: 0.7,
    minConfidence: 0.5,
  },
  '4h': {
    volatilityMultiplier: 1.5,
    signalDecay: 0.5,
    minConfidence: 0.45,
  },
  '24h': {
    volatilityMultiplier: 2.5,
    signalDecay: 0.3,
    minConfidence: 0.4,
  },
};

/**
 * Generate prediction for a specific timeframe
 */
export function generateTimeframePrediction(
  baseDirection: 'bullish' | 'bearish' | 'neutral',
  baseConfidence: number,
  baseSignals: Record<string, number>,
  timeframe: Timeframe,
): TimeframePrediction {
  const params = TIMEFRAME_PARAMS[timeframe];

  // Adjust confidence based on timeframe
  // Shorter timeframes need higher base confidence to be reliable
  let confidence = baseConfidence * params.signalDecay;

  // Volatility estimate based on signals
  const driftVelocity = baseSignals.driftVelocity || 0;
  const anomalyScore = baseSignals.anomalyScore || 0;
  const volatilityEstimate = (driftVelocity * 0.5 + anomalyScore * 0.3 + 0.02) * params.volatilityMultiplier;

  // Expected return based on direction and volatility
  let expectedReturn = 0;
  if (baseDirection === 'bullish') {
    expectedReturn = volatilityEstimate * confidence;
  } else if (baseDirection === 'bearish') {
    expectedReturn = -volatilityEstimate * confidence;
  }

  // Signal strength combines confidence and consistency
  const signalStrength = Math.min(1, confidence * (1 + Math.abs(expectedReturn) * 10));

  // Determine direction (may flip for longer timeframes if momentum is weak)
  let direction = baseDirection;
  if (confidence < params.minConfidence) {
    direction = 'neutral';
    confidence = confidence * 0.5;
  }

  return {
    timeframe,
    direction,
    confidence,
    expectedReturn,
    volatilityEstimate,
    signalStrength,
  };
}

/**
 * Generate predictions for all timeframes
 */
export function generateMultiTimeframePrediction(
  chain: string,
  baseDirection: 'bullish' | 'bearish' | 'neutral',
  baseConfidence: number,
  baseSignals: Record<string, number>,
): MultiTimeframePrediction {
  const timeframes: Timeframe[] = ['5m', '1h', '4h', '24h'];

  const predictions = timeframes.map(tf =>
    generateTimeframePrediction(baseDirection, baseConfidence, baseSignals, tf)
  );

  // Calculate consensus
  const bullishCount = predictions.filter(p => p.direction === 'bullish').length;
  const bearishCount = predictions.filter(p => p.direction === 'bearish').length;
  const neutralCount = predictions.filter(p => p.direction === 'neutral').length;

  let consensusDirection: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  if (bullishCount >= 3) consensusDirection = 'bullish';
  else if (bearishCount >= 3) consensusDirection = 'bearish';
  else if (neutralCount >= 3) consensusDirection = 'neutral';
  else consensusDirection = 'mixed';

  // Alignment: how many timeframes agree
  const maxAgreement = Math.max(bullishCount, bearishCount, neutralCount);
  const alignment = maxAgreement / timeframes.length;

  // Consensus strength
  const avgConfidence = predictions.reduce((s, p) => s + p.confidence, 0) / predictions.length;
  const strength = avgConfidence * alignment;

  // Recommend timeframe based on signal strength and historical accuracy
  let recommendedTimeframe: Timeframe = '1h'; // Default
  let bestScore = 0;

  for (const pred of predictions) {
    const stats = timeframeStats[pred.timeframe];
    const score = pred.signalStrength * stats.accuracy * stats.profitFactor;
    if (score > bestScore && pred.direction !== 'neutral') {
      bestScore = score;
      recommendedTimeframe = pred.timeframe;
    }
  }

  return {
    timestamp: Date.now(),
    chain,
    predictions,
    consensus: {
      direction: consensusDirection,
      strength,
      alignment,
    },
    recommendedTimeframe,
    overallConfidence: avgConfidence,
  };
}

/**
 * Kelly Criterion Position Sizing
 *
 * Kelly % = (p * b - q) / b
 * Where:
 *   p = probability of winning
 *   q = probability of losing (1 - p)
 *   b = win/loss ratio (avg win / avg loss)
 */
export function calculateKellyPosition(
  direction: 'bullish' | 'bearish' | 'neutral',
  confidence: number,
  timeframe: Timeframe,
  portfolioValue: number,
  riskTolerance: number = 0.02, // 2% max risk per trade
): PositionSizeRecommendation {
  const reasoning: string[] = [];

  // Can't size a neutral position
  if (direction === 'neutral') {
    return {
      kellyFraction: 0,
      adjustedKelly: 0,
      recommendedSize: 0,
      maxSize: 0,
      riskPerTrade: 0,
      reasoning: ['Neutral direction - no position recommended'],
    };
  }

  const stats = timeframeStats[timeframe];

  // Use historical stats if available, otherwise use confidence-based estimate
  let winProb: number;
  let avgWin: number;
  let avgLoss: number;

  if (stats.totalPredictions >= 20) {
    // Use historical data
    winProb = stats.winRate;
    avgWin = stats.avgWin;
    avgLoss = stats.avgLoss;
    reasoning.push(`Using ${stats.totalPredictions} historical predictions for ${timeframe}`);
  } else {
    // Estimate from confidence
    // Higher confidence = higher estimated win rate
    winProb = 0.45 + confidence * 0.2; // 45-65% based on confidence
    avgWin = 0.015; // 1.5% average win
    avgLoss = 0.01; // 1% average loss
    reasoning.push('Insufficient history - using confidence-based estimates');
  }

  // Adjust win probability by signal confidence
  winProb = winProb * 0.7 + confidence * 0.3; // Blend historical and current

  const lossProb = 1 - winProb;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

  // Kelly formula
  const kellyFraction = (winProb * winLossRatio - lossProb) / winLossRatio;

  reasoning.push(`Win probability: ${(winProb * 100).toFixed(1)}%`);
  reasoning.push(`Win/Loss ratio: ${winLossRatio.toFixed(2)}`);
  reasoning.push(`Raw Kelly: ${(kellyFraction * 100).toFixed(1)}%`);

  // Safety adjustments
  // 1. Quarter Kelly (industry standard for safety)
  const quarterKelly = kellyFraction * 0.25;

  // 2. Cap at max risk tolerance
  const maxFromRisk = riskTolerance / (avgLoss || 0.01);

  // 3. Hard caps
  const MAX_SINGLE_POSITION = 0.10; // 10% max per position
  const MIN_POSITION = 0.01; // 1% minimum to be worth it

  let recommendedSize = Math.min(quarterKelly, maxFromRisk, MAX_SINGLE_POSITION);

  // Don't recommend tiny positions
  if (recommendedSize < MIN_POSITION) {
    recommendedSize = 0;
    reasoning.push('Position too small to be worthwhile');
  }

  // Adjust for confidence
  if (confidence < 0.5) {
    recommendedSize *= 0.5;
    reasoning.push('Low confidence - halving position size');
  } else if (confidence > 0.7) {
    reasoning.push('High confidence signal');
  }

  // Calculate actual risk
  const riskPerTrade = recommendedSize * avgLoss;

  return {
    kellyFraction: Math.max(0, kellyFraction),
    adjustedKelly: Math.max(0, quarterKelly),
    recommendedSize: Math.max(0, recommendedSize),
    maxSize: MAX_SINGLE_POSITION,
    riskPerTrade,
    reasoning,
  };
}

/**
 * Update timeframe stats with outcome
 */
export function updateTimeframeStats(
  timeframe: Timeframe,
  wasCorrect: boolean,
  actualReturn: number,
): void {
  const stats = timeframeStats[timeframe];

  stats.totalPredictions++;
  if (wasCorrect) stats.correctPredictions++;

  stats.accuracy = stats.correctPredictions / stats.totalPredictions;

  // Update win/loss stats
  if (actualReturn > 0) {
    const oldWins = stats.winRate * (stats.totalPredictions - 1);
    stats.winRate = (oldWins + 1) / stats.totalPredictions;

    // Running average of wins
    const winCount = Math.round(stats.winRate * stats.totalPredictions);
    stats.avgWin = ((stats.avgWin * (winCount - 1)) + actualReturn) / winCount;
  } else if (actualReturn < 0) {
    const lossCount = Math.round((1 - stats.winRate) * stats.totalPredictions);
    if (lossCount > 0) {
      stats.avgLoss = ((stats.avgLoss * (lossCount - 1)) + Math.abs(actualReturn)) / lossCount;
    }
  }

  // Profit factor
  stats.profitFactor = stats.avgLoss > 0 ? stats.avgWin / stats.avgLoss : 1;

  stats.lastUpdated = Date.now();

  saveTimeframeStats();
}

/**
 * Get recommended action based on multi-timeframe analysis
 */
export function getMultiTimeframeAction(
  prediction: MultiTimeframePrediction,
  portfolioValue: number,
): {
  action: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'avoid';
  timeframe: Timeframe;
  positionSize: PositionSizeRecommendation;
  reasoning: string[];
} {
  const reasoning: string[] = [];

  // Check consensus
  if (prediction.consensus.direction === 'mixed') {
    reasoning.push('Timeframes are not aligned - avoid trading');
    return {
      action: 'avoid',
      timeframe: '1h',
      positionSize: calculateKellyPosition('neutral', 0, '1h', portfolioValue),
      reasoning,
    };
  }

  // Get prediction for recommended timeframe
  const tfPrediction = prediction.predictions.find(p => p.timeframe === prediction.recommendedTimeframe);
  if (!tfPrediction) {
    return {
      action: 'hold',
      timeframe: '1h',
      positionSize: calculateKellyPosition('neutral', 0, '1h', portfolioValue),
      reasoning: ['No valid prediction found'],
    };
  }

  // Calculate position size
  const positionSize = calculateKellyPosition(
    tfPrediction.direction,
    tfPrediction.confidence,
    tfPrediction.timeframe,
    portfolioValue,
  );

  reasoning.push(...positionSize.reasoning);

  // Determine action
  let action: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'avoid';

  if (tfPrediction.direction === 'neutral') {
    action = 'hold';
  } else if (prediction.consensus.alignment >= 0.75 && tfPrediction.confidence >= 0.6) {
    // Strong signal: aligned timeframes + high confidence
    action = tfPrediction.direction === 'bullish' ? 'strong_buy' : 'strong_sell';
    reasoning.push('Strong signal: timeframes aligned with high confidence');
  } else if (tfPrediction.confidence >= 0.5) {
    action = tfPrediction.direction === 'bullish' ? 'buy' : 'sell';
  } else {
    action = 'hold';
    reasoning.push('Confidence too low for action');
  }

  return {
    action,
    timeframe: prediction.recommendedTimeframe,
    positionSize,
    reasoning,
  };
}

/**
 * Persistence
 */
function saveTimeframeStats(): void {
  try {
    writeFileSync(TIMEFRAME_STATS_FILE, JSON.stringify(timeframeStats, null, 2));
  } catch (e) {
    // Ignore
  }
}

function loadTimeframeStats(): void {
  try {
    if (existsSync(TIMEFRAME_STATS_FILE)) {
      const loaded = JSON.parse(readFileSync(TIMEFRAME_STATS_FILE, 'utf-8'));
      // Merge with defaults to handle new timeframes
      timeframeStats = {
        '5m': { ...createDefaultStats('5m'), ...loaded['5m'] },
        '1h': { ...createDefaultStats('1h'), ...loaded['1h'] },
        '4h': { ...createDefaultStats('4h'), ...loaded['4h'] },
        '24h': { ...createDefaultStats('24h'), ...loaded['24h'] },
      };
      console.log('[timeframe] Loaded timeframe stats');
    }
  } catch (e) {
    // Ignore
  }
}

// Load on module init
loadTimeframeStats();

export { timeframeStats };
