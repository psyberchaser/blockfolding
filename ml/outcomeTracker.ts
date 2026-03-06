/**
 * Price Outcome Automation System
 *
 * Automatically tracks predictions and records their outcomes:
 * - Fetches price at prediction time
 * - Schedules price check at outcome time (5m, 1h, 4h, 24h)
 * - Records actual price change
 * - Updates prediction accuracy stats
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';
const PRICE_CACHE_FILE = join(DATA_DIR, 'ml', 'price-cache.json');
const PENDING_OUTCOMES_FILE = join(DATA_DIR, 'ml', 'pending-outcomes.json');

export interface PricePoint {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface PendingOutcome {
  predictionId: string;
  chain: string;
  timeframe: string; // '5m', '1h', '4h', '24h'
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  entryPrice: number;
  entryTime: number;
  outcomeTime: number; // When to check
  checked: boolean;
  actualPriceChange?: number;
  wasCorrect?: boolean;
}

// In-memory state
let priceCache: PricePoint[] = [];
let pendingOutcomes: PendingOutcome[] = [];
let isTrackerRunning = false;

// Timeframe durations in milliseconds
const TIMEFRAME_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/**
 * Fetch current price for a symbol
 */
export async function fetchCurrentPrice(symbol: string = 'ETH'): Promise<number> {
  try {
    // Try Binance first (most reliable)
    const binanceSymbol = symbol === 'ETH' ? 'ETHUSDT' : symbol === 'BTC' ? 'BTCUSDT' : `${symbol}USDT`;
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`);
    const data = await res.json();

    if (data.price) {
      const price = parseFloat(data.price);
      // Cache the price
      addPriceToCache(symbol, price);
      return price;
    }
  } catch (e) {
    console.warn(`[outcome] Binance price fetch failed for ${symbol}`);
  }

  try {
    // Fallback to CoinGecko
    const geckoId = symbol === 'ETH' ? 'ethereum' : symbol === 'BTC' ? 'bitcoin' : symbol.toLowerCase();
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`);
    const data = await res.json();

    if (data[geckoId]?.usd) {
      const price = data[geckoId].usd;
      addPriceToCache(symbol, price);
      return price;
    }
  } catch (e) {
    console.warn(`[outcome] CoinGecko price fetch failed for ${symbol}`);
  }

  // Return last cached price if available
  const cached = priceCache.filter(p => p.symbol === symbol).pop();
  return cached?.price || 0;
}

/**
 * Add price to cache
 */
function addPriceToCache(symbol: string, price: number): void {
  priceCache.push({
    symbol,
    price,
    timestamp: Date.now(),
  });

  // Keep last 1000 prices per symbol
  const symbolPrices = priceCache.filter(p => p.symbol === symbol);
  if (symbolPrices.length > 1000) {
    priceCache = priceCache.filter(p => p.symbol !== symbol || p.timestamp > Date.now() - 86400000);
  }

  savePriceCache();
}

/**
 * Get historical price at a specific time
 */
export function getHistoricalPrice(symbol: string, timestamp: number): number | null {
  const prices = priceCache.filter(p => p.symbol === symbol);

  // Find closest price within 1 minute of target time
  let closest: PricePoint | null = null;
  let minDiff = Infinity;

  for (const price of prices) {
    const diff = Math.abs(price.timestamp - timestamp);
    if (diff < minDiff && diff < 60000) {
      minDiff = diff;
      closest = price;
    }
  }

  return closest?.price || null;
}

/**
 * Register a prediction for outcome tracking
 */
export async function registerPredictionForTracking(
  predictionId: string,
  chain: string,
  direction: 'bullish' | 'bearish' | 'neutral',
  confidence: number,
  timeframe: string = '1h',
): Promise<void> {
  const entryPrice = await fetchCurrentPrice(chain === 'eth' ? 'ETH' : 'BTC');
  const entryTime = Date.now();
  const outcomeTime = entryTime + (TIMEFRAME_MS[timeframe] || TIMEFRAME_MS['1h']);

  const pending: PendingOutcome = {
    predictionId,
    chain,
    timeframe,
    direction,
    confidence,
    entryPrice,
    entryTime,
    outcomeTime,
    checked: false,
  };

  pendingOutcomes.push(pending);
  savePendingOutcomes();

  console.log(`[outcome] Registered prediction ${predictionId} for ${timeframe} outcome tracking at price ${entryPrice}`);
}

/**
 * Check all pending outcomes
 */
export async function checkPendingOutcomes(): Promise<{
  checked: number;
  correct: number;
  incorrect: number;
}> {
  const now = Date.now();
  let checked = 0;
  let correct = 0;
  let incorrect = 0;

  for (const pending of pendingOutcomes) {
    if (pending.checked) continue;
    if (now < pending.outcomeTime) continue;

    // Time to check this outcome
    const currentPrice = await fetchCurrentPrice(pending.chain === 'eth' ? 'ETH' : 'BTC');

    if (currentPrice > 0 && pending.entryPrice > 0) {
      const priceChange = (currentPrice - pending.entryPrice) / pending.entryPrice;

      // Determine actual direction
      const actualDirection = priceChange > 0.005 ? 'bullish' :
                              priceChange < -0.005 ? 'bearish' : 'neutral';

      const wasCorrect = pending.direction === actualDirection;

      pending.actualPriceChange = priceChange;
      pending.wasCorrect = wasCorrect;
      pending.checked = true;

      checked++;
      if (wasCorrect) correct++;
      else incorrect++;

      console.log(`[outcome] Prediction ${pending.predictionId}: ${pending.direction} → ${actualDirection} (${(priceChange * 100).toFixed(2)}%) - ${wasCorrect ? 'CORRECT' : 'INCORRECT'}`);

      // Call the recordOutcome function if available
      try {
        const { recordOutcome } = await import('./predictiveEngine.js');
        recordOutcome(pending.predictionId, priceChange);
      } catch (e) {
        // Module might not be loaded yet
      }
    }
  }

  // Clean up old checked outcomes (keep last 1000)
  const checkedOutcomes = pendingOutcomes.filter(p => p.checked);
  if (checkedOutcomes.length > 1000) {
    pendingOutcomes = [
      ...pendingOutcomes.filter(p => !p.checked),
      ...checkedOutcomes.slice(-1000),
    ];
  }

  savePendingOutcomes();

  return { checked, correct, incorrect };
}

/**
 * Get outcome statistics
 */
export function getOutcomeStats(): {
  total: number;
  pending: number;
  checked: number;
  correct: number;
  accuracy: number;
  byTimeframe: Record<string, { total: number; correct: number; accuracy: number }>;
  byConfidence: { high: { total: number; correct: number }; medium: { total: number; correct: number }; low: { total: number; correct: number } };
  avgPriceChange: number;
  avgCorrectChange: number;
  avgIncorrectChange: number;
} {
  const checked = pendingOutcomes.filter(p => p.checked);
  const correct = checked.filter(p => p.wasCorrect);

  // By timeframe
  const byTimeframe: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const tf of Object.keys(TIMEFRAME_MS)) {
    const tfChecked = checked.filter(p => p.timeframe === tf);
    const tfCorrect = tfChecked.filter(p => p.wasCorrect);
    byTimeframe[tf] = {
      total: tfChecked.length,
      correct: tfCorrect.length,
      accuracy: tfChecked.length > 0 ? tfCorrect.length / tfChecked.length : 0,
    };
  }

  // By confidence
  const highConf = checked.filter(p => p.confidence >= 0.7);
  const medConf = checked.filter(p => p.confidence >= 0.4 && p.confidence < 0.7);
  const lowConf = checked.filter(p => p.confidence < 0.4);

  // Price change stats
  const changes = checked.map(p => p.actualPriceChange || 0);
  const correctChanges = correct.map(p => p.actualPriceChange || 0);
  const incorrectChanges = checked.filter(p => !p.wasCorrect).map(p => p.actualPriceChange || 0);

  return {
    total: pendingOutcomes.length,
    pending: pendingOutcomes.filter(p => !p.checked).length,
    checked: checked.length,
    correct: correct.length,
    accuracy: checked.length > 0 ? correct.length / checked.length : 0,
    byTimeframe,
    byConfidence: {
      high: {
        total: highConf.length,
        correct: highConf.filter(p => p.wasCorrect).length,
      },
      medium: {
        total: medConf.length,
        correct: medConf.filter(p => p.wasCorrect).length,
      },
      low: {
        total: lowConf.length,
        correct: lowConf.filter(p => p.wasCorrect).length,
      },
    },
    avgPriceChange: changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0,
    avgCorrectChange: correctChanges.length > 0 ? correctChanges.reduce((a, b) => a + Math.abs(b), 0) / correctChanges.length : 0,
    avgIncorrectChange: incorrectChanges.length > 0 ? incorrectChanges.reduce((a, b) => a + Math.abs(b), 0) / incorrectChanges.length : 0,
  };
}

/**
 * Start the outcome tracker background process
 */
export function startOutcomeTracker(intervalMs: number = 60000): void {
  if (isTrackerRunning) return;

  isTrackerRunning = true;
  console.log('[outcome] Starting outcome tracker');

  // Check outcomes every interval
  setInterval(async () => {
    try {
      const result = await checkPendingOutcomes();
      if (result.checked > 0) {
        console.log(`[outcome] Checked ${result.checked} outcomes: ${result.correct} correct, ${result.incorrect} incorrect`);
      }
    } catch (e) {
      console.warn('[outcome] Error checking outcomes:', e);
    }
  }, intervalMs);

  // Also fetch and cache price periodically
  setInterval(async () => {
    try {
      await fetchCurrentPrice('ETH');
      await fetchCurrentPrice('BTC');
    } catch (e) {
      // Ignore price fetch errors
    }
  }, 30000); // Every 30 seconds
}

/**
 * Persistence functions
 */
function savePriceCache(): void {
  try {
    writeFileSync(PRICE_CACHE_FILE, JSON.stringify(priceCache.slice(-5000), null, 2));
  } catch (e) {
    // Ignore
  }
}

function savePendingOutcomes(): void {
  try {
    writeFileSync(PENDING_OUTCOMES_FILE, JSON.stringify(pendingOutcomes, null, 2));
  } catch (e) {
    // Ignore
  }
}

function loadState(): void {
  try {
    if (existsSync(PRICE_CACHE_FILE)) {
      priceCache = JSON.parse(readFileSync(PRICE_CACHE_FILE, 'utf-8'));
      console.log(`[outcome] Loaded ${priceCache.length} cached prices`);
    }
  } catch (e) {
    priceCache = [];
  }

  try {
    if (existsSync(PENDING_OUTCOMES_FILE)) {
      pendingOutcomes = JSON.parse(readFileSync(PENDING_OUTCOMES_FILE, 'utf-8'));
      console.log(`[outcome] Loaded ${pendingOutcomes.length} pending outcomes`);
    }
  } catch (e) {
    pendingOutcomes = [];
  }
}

// Load state on module init
loadState();

export { priceCache, pendingOutcomes };
