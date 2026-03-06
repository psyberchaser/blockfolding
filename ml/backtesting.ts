/**
 * Historical Backtesting Framework
 *
 * Tests predictions against historical data to validate signal effectiveness:
 * - Loads historical block data and fingerprints
 * - Fetches historical price data
 * - Runs predictions at each point in time
 * - Calculates accuracy, Sharpe ratio, max drawdown
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';
const BACKTEST_RESULTS_FILE = join(DATA_DIR, 'ml', 'backtest-results.json');
const HISTORICAL_PRICES_FILE = join(DATA_DIR, 'ml', 'historical-prices.json');

export interface BacktestConfig {
  chain: string;
  startBlock?: number;
  endBlock?: number;
  startTime?: number;
  endTime?: number;
  timeframe: string; // '5m', '1h', '4h', '24h'
  signalThreshold: number; // Minimum confidence to count as signal
}

export interface BacktestPrediction {
  blockHeight: number;
  timestamp: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  entryPrice: number;
  exitPrice: number;
  priceChange: number;
  wasCorrect: boolean;
  signals: Record<string, number>;
}

export interface BacktestResult {
  config: BacktestConfig;
  startTime: number;
  endTime: number;
  totalBlocks: number;
  totalPredictions: number;
  signalPredictions: number; // Predictions above threshold

  // Accuracy metrics
  accuracy: number;
  precision: number; // True positives / (True + False positives)
  recall: number;    // True positives / (True positives + False negatives)
  f1Score: number;

  // Financial metrics (if followed signals)
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;

  // Per-signal analysis
  signalEffectiveness: Record<string, {
    correlation: number;
    avgReturnWhenPositive: number;
    avgReturnWhenNegative: number;
  }>;

  // Confidence bucket analysis
  byConfidence: {
    bucket: string;
    count: number;
    accuracy: number;
    avgReturn: number;
  }[];

  // Individual predictions
  predictions: BacktestPrediction[];

  // Timestamp
  ranAt: number;
}

// Historical price cache
let historicalPrices: { timestamp: number; price: number }[] = [];

/**
 * Fetch historical price data from CoinGecko
 */
export async function fetchHistoricalPrices(
  symbol: string = 'ethereum',
  days: number = 30
): Promise<{ timestamp: number; price: number }[]> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${symbol}/market_chart?vs_currency=usd&days=${days}&interval=hourly`
    );
    const data = await res.json();

    if (data.prices && Array.isArray(data.prices)) {
      historicalPrices = data.prices.map((p: [number, number]) => ({
        timestamp: p[0],
        price: p[1],
      }));

      // Save to cache
      writeFileSync(HISTORICAL_PRICES_FILE, JSON.stringify(historicalPrices, null, 2));
      console.log(`[backtest] Fetched ${historicalPrices.length} historical prices`);

      return historicalPrices;
    }
  } catch (e) {
    console.warn('[backtest] Failed to fetch historical prices:', e);
  }

  // Try to load from cache
  if (existsSync(HISTORICAL_PRICES_FILE)) {
    historicalPrices = JSON.parse(readFileSync(HISTORICAL_PRICES_FILE, 'utf-8'));
    return historicalPrices;
  }

  return [];
}

/**
 * Get price at a specific timestamp
 */
function getPriceAtTime(timestamp: number): number | null {
  if (historicalPrices.length === 0) return null;

  // Find closest price within 1 hour
  let closest: { timestamp: number; price: number } | null = null;
  let minDiff = Infinity;

  for (const p of historicalPrices) {
    const diff = Math.abs(p.timestamp - timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = p;
    }
  }

  // Only return if within 1 hour
  if (closest && minDiff < 3600000) {
    return closest.price;
  }

  return null;
}

/**
 * Load historical block data
 */
function loadHistoricalBlocks(chain: string, limit: number = 1000): {
  height: number;
  timestamp: number;
  fingerprint: number[];
  tags: string[];
  anomalyScore: number;
}[] {
  const blocksDir = join(DATA_DIR, 'blocks', chain);
  if (!existsSync(blocksDir)) return [];

  const dirs = readdirSync(blocksDir)
    .filter(d => /^\d+$/.test(d))
    .map(d => parseInt(d))
    .sort((a, b) => b - a)
    .slice(0, limit);

  const blocks: {
    height: number;
    timestamp: number;
    fingerprint: number[];
    tags: string[];
    anomalyScore: number;
  }[] = [];

  for (const blockNum of dirs) {
    const summaryPath = join(blocksDir, blockNum.toString(), 'summary.json');

    if (existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

        // Get fingerprint from foldedBlock.foldedVectors (first vector is the block fingerprint)
        const foldedVectors = summary.foldedBlock?.foldedVectors || [];
        const fingerprint = foldedVectors[0] || [];

        // Compute anomaly score from hotzones if not stored
        const hotzones = summary.hotzones || [];
        const densities = hotzones.map((hz: any) => hz.density || 0);
        const avgDensity = densities.length > 0 ? densities.reduce((a: number, b: number) => a + b, 0) / densities.length : 0;
        const anomalyScore = summary.anomalyScore ?? (avgDensity > 100 ? Math.min(1, avgDensity / 1000) : 0.1);

        // Get timestamp from foldedBlock metadata
        const timestamp = summary.foldedBlock?.metadata?.timestamp || summary.timestamp || Date.now() / 1000;

        blocks.push({
          height: blockNum,
          timestamp: timestamp * 1000, // Convert to milliseconds for CoinGecko compatibility
          fingerprint,
          tags: summary.semanticTags || summary.rawTags || [],
          anomalyScore,
        });
      } catch (e) {
        // Skip blocks with parse errors
      }
    }
  }

  // Sort by height ascending for chronological order
  blocks.sort((a, b) => a.height - b.height);

  return blocks;
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
 * Generate a prediction for a historical block
 */
function generateHistoricalPrediction(
  currentBlock: { fingerprint: number[]; tags: string[]; anomalyScore: number },
  previousBlock: { fingerprint: number[]; tags: string[]; anomalyScore: number } | null,
): { direction: 'bullish' | 'bearish' | 'neutral'; confidence: number; signals: Record<string, number> } {
  const signals: Record<string, number> = {};

  // Drift velocity
  const driftVelocity = previousBlock
    ? computeDriftVelocity(currentBlock.fingerprint, previousBlock.fingerprint)
    : 0;
  signals.driftVelocity = driftVelocity;

  // Entropy
  const entropy = computeEntropy(currentBlock.fingerprint);
  signals.entropy = entropy;

  // Anomaly score
  signals.anomalyScore = currentBlock.anomalyScore;

  // Tag analysis
  const bullishTags = ['DEX_ACTIVITY', 'ASSET_EIP1559_FLOW'].filter(t => currentBlock.tags.includes(t));
  const bearishTags = ['BRIDGE_ACTIVITY', 'LENDING_ACTIVITY'].filter(t => currentBlock.tags.includes(t));
  signals.tagScore = (bullishTags.length - bearishTags.length) * 0.1;

  // Calculate score
  let score = 0;

  // High drift velocity + acceleration = volatility (slightly bearish due to uncertainty)
  if (driftVelocity > 0.5) score -= 0.1;
  else if (driftVelocity < 0.2) score += 0.05;

  // Low entropy = coordination (cautious)
  if (entropy < 0.4) score -= 0.05;
  else if (entropy > 0.7) score += 0.05;

  // High anomaly = risk
  if (currentBlock.anomalyScore > 0.6) score -= 0.15;
  else if (currentBlock.anomalyScore < 0.2) score += 0.05;

  // Tags
  score += signals.tagScore;

  const direction: 'bullish' | 'bearish' | 'neutral' =
    score > 0.1 ? 'bullish' : score < -0.1 ? 'bearish' : 'neutral';

  const confidence = Math.min(1, Math.abs(score) + 0.3);

  return { direction, confidence, signals };
}

/**
 * Run backtest
 */
export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  console.log(`[backtest] Starting backtest for ${config.chain} with ${config.timeframe} timeframe`);

  // Load historical prices
  await fetchHistoricalPrices('ethereum', 90); // 90 days

  // Load historical blocks
  const blocks = loadHistoricalBlocks(config.chain, 1000);
  console.log(`[backtest] Loaded ${blocks.length} blocks`);

  if (blocks.length < 10) {
    throw new Error('Insufficient historical data for backtest');
  }

  // Timeframe in milliseconds
  const timeframeMs: Record<string, number> = {
    '5m': 5 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };
  const tfMs = timeframeMs[config.timeframe] || timeframeMs['1h'];

  const predictions: BacktestPrediction[] = [];

  // Generate predictions for each block
  for (let i = 1; i < blocks.length; i++) {
    const currentBlock = blocks[i];
    const previousBlock = blocks[i - 1];

    // Get entry price
    const entryPrice = getPriceAtTime(currentBlock.timestamp);
    if (!entryPrice) continue;

    // Get exit price (after timeframe)
    const exitPrice = getPriceAtTime(currentBlock.timestamp + tfMs);
    if (!exitPrice) continue;

    // Generate prediction
    const prediction = generateHistoricalPrediction(currentBlock, previousBlock);

    // Calculate actual outcome
    const priceChange = (exitPrice - entryPrice) / entryPrice;
    const actualDirection = priceChange > 0.005 ? 'bullish' :
                            priceChange < -0.005 ? 'bearish' : 'neutral';
    const wasCorrect = prediction.direction === actualDirection;

    predictions.push({
      blockHeight: currentBlock.height,
      timestamp: currentBlock.timestamp,
      direction: prediction.direction,
      confidence: prediction.confidence,
      entryPrice,
      exitPrice,
      priceChange,
      wasCorrect,
      signals: prediction.signals,
    });
  }

  console.log(`[backtest] Generated ${predictions.length} predictions`);

  // Filter to signal predictions (above threshold)
  const signalPredictions = predictions.filter(p => p.confidence >= config.signalThreshold);

  // Calculate metrics
  const correct = predictions.filter(p => p.wasCorrect);
  const accuracy = predictions.length > 0 ? correct.length / predictions.length : 0;

  // Precision/Recall for bullish predictions
  const bullishPredictions = predictions.filter(p => p.direction === 'bullish');
  const trueBullish = bullishPredictions.filter(p => p.priceChange > 0);
  const actualBullish = predictions.filter(p => p.priceChange > 0.005);
  const precision = bullishPredictions.length > 0 ? trueBullish.length / bullishPredictions.length : 0;
  const recall = actualBullish.length > 0 ? trueBullish.length / actualBullish.length : 0;
  const f1Score = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  // Financial metrics (if following signals)
  const returns = signalPredictions.map(p => {
    // Long if bullish, short if bearish, no position if neutral
    if (p.direction === 'bullish') return p.priceChange;
    if (p.direction === 'bearish') return -p.priceChange;
    return 0;
  });

  const totalReturn = returns.reduce((a, b) => a + b, 0);
  const avgReturn = returns.length > 0 ? totalReturn / returns.length : 0;
  const returnStd = returns.length > 1 ? Math.sqrt(
    returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (returns.length - 1)
  ) : 0;

  // Sharpe ratio (assuming risk-free rate of 0)
  const sharpeRatio = returnStd > 0 ? (avgReturn / returnStd) * Math.sqrt(365 * 24) : 0; // Annualized

  // Max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let cumReturn = 0;
  for (const r of returns) {
    cumReturn += r;
    peak = Math.max(peak, cumReturn);
    maxDrawdown = Math.max(maxDrawdown, peak - cumReturn);
  }

  // Win/loss stats
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0);
  const winRate = returns.length > 0 ? wins.length / returns.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  // Signal effectiveness
  const signalNames = ['driftVelocity', 'entropy', 'anomalyScore', 'tagScore'];
  const signalEffectiveness: Record<string, { correlation: number; avgReturnWhenPositive: number; avgReturnWhenNegative: number }> = {};

  for (const signal of signalNames) {
    const signalValues = predictions.map(p => p.signals[signal] || 0);
    const returnValues = predictions.map(p => p.priceChange);

    // Pearson correlation
    const n = signalValues.length;
    const sumX = signalValues.reduce((a, b) => a + b, 0);
    const sumY = returnValues.reduce((a, b) => a + b, 0);
    const sumXY = signalValues.reduce((sum, x, i) => sum + x * returnValues[i], 0);
    const sumX2 = signalValues.reduce((sum, x) => sum + x * x, 0);
    const sumY2 = returnValues.reduce((sum, y) => sum + y * y, 0);

    const correlation = n > 0 ? (n * sumXY - sumX * sumY) /
      (Math.sqrt(n * sumX2 - sumX * sumX) * Math.sqrt(n * sumY2 - sumY * sumY)) : 0;

    // Avg return when signal is positive/negative
    const positive = predictions.filter(p => (p.signals[signal] || 0) > 0);
    const negative = predictions.filter(p => (p.signals[signal] || 0) < 0);

    signalEffectiveness[signal] = {
      correlation: isNaN(correlation) ? 0 : correlation,
      avgReturnWhenPositive: positive.length > 0 ? positive.reduce((s, p) => s + p.priceChange, 0) / positive.length : 0,
      avgReturnWhenNegative: negative.length > 0 ? negative.reduce((s, p) => s + p.priceChange, 0) / negative.length : 0,
    };
  }

  // Confidence buckets
  const buckets = [
    { min: 0, max: 0.4, label: 'Low (0-40%)' },
    { min: 0.4, max: 0.6, label: 'Medium (40-60%)' },
    { min: 0.6, max: 0.8, label: 'High (60-80%)' },
    { min: 0.8, max: 1.0, label: 'Very High (80-100%)' },
  ];

  const byConfidence = buckets.map(b => {
    const bucket = predictions.filter(p => p.confidence >= b.min && p.confidence < b.max);
    const correct = bucket.filter(p => p.wasCorrect);
    return {
      bucket: b.label,
      count: bucket.length,
      accuracy: bucket.length > 0 ? correct.length / bucket.length : 0,
      avgReturn: bucket.length > 0 ? bucket.reduce((s, p) => s + p.priceChange, 0) / bucket.length : 0,
    };
  });

  const result: BacktestResult = {
    config,
    startTime: blocks[0]?.timestamp || 0,
    endTime: blocks[blocks.length - 1]?.timestamp || 0,
    totalBlocks: blocks.length,
    totalPredictions: predictions.length,
    signalPredictions: signalPredictions.length,
    accuracy,
    precision,
    recall,
    f1Score,
    totalReturn,
    sharpeRatio,
    maxDrawdown,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    signalEffectiveness,
    byConfidence,
    predictions,
    ranAt: Date.now(),
  };

  // Save results
  saveBacktestResults(result);

  console.log(`[backtest] Completed: ${predictions.length} predictions, ${(accuracy * 100).toFixed(1)}% accuracy, Sharpe ${sharpeRatio.toFixed(2)}`);

  return result;
}

/**
 * Save backtest results
 */
function saveBacktestResults(result: BacktestResult): void {
  try {
    let results: BacktestResult[] = [];

    if (existsSync(BACKTEST_RESULTS_FILE)) {
      results = JSON.parse(readFileSync(BACKTEST_RESULTS_FILE, 'utf-8'));
    }

    // Keep last 10 backtest results
    results.push(result);
    if (results.length > 10) {
      results = results.slice(-10);
    }

    writeFileSync(BACKTEST_RESULTS_FILE, JSON.stringify(results, null, 2));
  } catch (e) {
    console.warn('[backtest] Failed to save results:', e);
  }
}

/**
 * Load previous backtest results
 */
export function loadBacktestResults(): BacktestResult[] {
  try {
    if (existsSync(BACKTEST_RESULTS_FILE)) {
      return JSON.parse(readFileSync(BACKTEST_RESULTS_FILE, 'utf-8'));
    }
  } catch (e) {
    // Ignore
  }
  return [];
}

/**
 * Get summary of all backtest results
 */
export function getBacktestSummary(): {
  totalRuns: number;
  avgAccuracy: number;
  avgSharpe: number;
  bestRun: BacktestResult | null;
  worstRun: BacktestResult | null;
} {
  const results = loadBacktestResults();

  if (results.length === 0) {
    return {
      totalRuns: 0,
      avgAccuracy: 0,
      avgSharpe: 0,
      bestRun: null,
      worstRun: null,
    };
  }

  const avgAccuracy = results.reduce((s, r) => s + r.accuracy, 0) / results.length;
  const avgSharpe = results.reduce((s, r) => s + r.sharpeRatio, 0) / results.length;

  results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  return {
    totalRuns: results.length,
    avgAccuracy,
    avgSharpe,
    bestRun: results[0],
    worstRun: results[results.length - 1],
  };
}
