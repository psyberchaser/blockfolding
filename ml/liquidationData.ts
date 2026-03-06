/**
 * Real Liquidation Data Integration
 *
 * Fetches actual liquidation levels from multiple sources:
 * - CoinGlass API (primary)
 * - Binance Futures API (backup)
 * - Calculated from open interest and funding
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'artifacts';
const LIQUIDATION_CACHE_FILE = join(DATA_DIR, 'ml', 'liquidation-cache.json');

export interface LiquidationLevel {
  price: number;
  longLiquidationUsd: number;
  shortLiquidationUsd: number;
  totalUsd: number;
  leverage: number; // Estimated average leverage at this level
}

export interface LiquidationHeatmap {
  symbol: string;
  currentPrice: number;
  levels: LiquidationLevel[];
  totalLongLiquidation: number;
  totalShortLiquidation: number;
  nearestLongLevel: number;
  nearestShortLevel: number;
  heaviestLongLevel: number;
  heaviestShortLevel: number;
  timestamp: number;
}

export interface AggregatedLiquidationData {
  btc: LiquidationHeatmap | null;
  eth: LiquidationHeatmap | null;
  timestamp: number;
}

// Cache
let cachedLiquidations: AggregatedLiquidationData | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Fetch liquidation data from CoinGlass
 * Note: Free tier has rate limits, paid API recommended for production
 */
async function fetchCoinGlassLiquidations(symbol: string): Promise<LiquidationHeatmap | null> {
  try {
    // CoinGlass liquidation map endpoint
    const res = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidation_map?symbol=${symbol}&interval=h4`,
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!res.ok) {
      console.warn(`[liquidation] CoinGlass returned ${res.status} for ${symbol}`);
      return null;
    }

    const data = await res.json();

    if (data.code !== '0' || !data.data?.list) {
      return null;
    }

    const levels: LiquidationLevel[] = data.data.list.map((l: any) => ({
      price: l.price,
      longLiquidationUsd: l.longLiqUsd || 0,
      shortLiquidationUsd: l.shortLiqUsd || 0,
      totalUsd: (l.longLiqUsd || 0) + (l.shortLiqUsd || 0),
      leverage: l.avgLeverage || 10,
    }));

    // Get current price
    const priceRes = await fetch(
      `https://open-api.coinglass.com/public/v2/index?symbol=${symbol}`
    );
    const priceData = await priceRes.json();
    const currentPrice = priceData.data?.price || (symbol === 'BTC' ? 90000 : 3000);

    // Calculate aggregates
    const totalLong = levels.reduce((sum, l) => sum + l.longLiquidationUsd, 0);
    const totalShort = levels.reduce((sum, l) => sum + l.shortLiquidationUsd, 0);

    // Find nearest levels with significant liquidations (> $1M)
    const significantLong = levels.filter(l => l.longLiquidationUsd > 1000000 && l.price < currentPrice);
    const significantShort = levels.filter(l => l.shortLiquidationUsd > 1000000 && l.price > currentPrice);

    significantLong.sort((a, b) => b.price - a.price); // Highest first (nearest to current)
    significantShort.sort((a, b) => a.price - b.price); // Lowest first (nearest to current)

    const nearestLong = significantLong[0]?.price || currentPrice * 0.9;
    const nearestShort = significantShort[0]?.price || currentPrice * 1.1;

    // Find heaviest levels
    const heaviestLong = levels.reduce((max, l) =>
      l.longLiquidationUsd > max.longLiquidationUsd ? l : max, levels[0])?.price || currentPrice * 0.85;
    const heaviestShort = levels.reduce((max, l) =>
      l.shortLiquidationUsd > max.shortLiquidationUsd ? l : max, levels[0])?.price || currentPrice * 1.15;

    return {
      symbol,
      currentPrice,
      levels,
      totalLongLiquidation: totalLong,
      totalShortLiquidation: totalShort,
      nearestLongLevel: nearestLong,
      nearestShortLevel: nearestShort,
      heaviestLongLevel: heaviestLong,
      heaviestShortLevel: heaviestShort,
      timestamp: Date.now(),
    };
  } catch (e) {
    console.warn(`[liquidation] Failed to fetch CoinGlass data for ${symbol}:`, e);
    return null;
  }
}

/**
 * Fetch liquidation data from Binance Futures (backup)
 * Uses open interest and funding to estimate liquidation clusters
 */
async function fetchBinanceLiquidationEstimate(symbol: string): Promise<LiquidationHeatmap | null> {
  try {
    const binanceSymbol = symbol === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';

    // Get current price and open interest
    const [priceRes, oiRes, fundingRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${binanceSymbol}`),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${binanceSymbol}`),
      fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${binanceSymbol}&limit=1`),
    ]);

    const priceData = await priceRes.json();
    const oiData = await oiRes.json();
    const fundingData = await fundingRes.json();

    const currentPrice = parseFloat(priceData.price);
    const openInterest = parseFloat(oiData.openInterest) * currentPrice;
    const fundingRate = parseFloat(fundingData[0]?.fundingRate || '0');

    // Estimate liquidation levels based on common leverage tiers
    // Assuming traders use 5x, 10x, 20x, 50x leverage
    const leverageTiers = [5, 10, 20, 50, 100];
    const levels: LiquidationLevel[] = [];

    for (const leverage of leverageTiers) {
      // Liquidation price = entry * (1 - 1/leverage) for longs
      // Liquidation price = entry * (1 + 1/leverage) for shorts
      const longLiqPrice = currentPrice * (1 - 1 / leverage);
      const shortLiqPrice = currentPrice * (1 + 1 / leverage);

      // Estimate USD at each level (rough distribution)
      const tierWeight = leverage <= 10 ? 0.4 : leverage <= 20 ? 0.3 : 0.15;
      const estimatedUsd = openInterest * tierWeight / leverageTiers.length;

      // Long liquidations below current price
      levels.push({
        price: longLiqPrice,
        longLiquidationUsd: estimatedUsd * (fundingRate > 0 ? 0.6 : 0.4), // More longs if positive funding
        shortLiquidationUsd: 0,
        totalUsd: estimatedUsd * (fundingRate > 0 ? 0.6 : 0.4),
        leverage,
      });

      // Short liquidations above current price
      levels.push({
        price: shortLiqPrice,
        longLiquidationUsd: 0,
        shortLiquidationUsd: estimatedUsd * (fundingRate < 0 ? 0.6 : 0.4), // More shorts if negative funding
        totalUsd: estimatedUsd * (fundingRate < 0 ? 0.6 : 0.4),
        leverage,
      });
    }

    levels.sort((a, b) => a.price - b.price);

    const totalLong = levels.reduce((sum, l) => sum + l.longLiquidationUsd, 0);
    const totalShort = levels.reduce((sum, l) => sum + l.shortLiquidationUsd, 0);

    return {
      symbol,
      currentPrice,
      levels,
      totalLongLiquidation: totalLong,
      totalShortLiquidation: totalShort,
      nearestLongLevel: currentPrice * (1 - 1 / 20), // 20x leverage
      nearestShortLevel: currentPrice * (1 + 1 / 20),
      heaviestLongLevel: currentPrice * (1 - 1 / 10), // 10x leverage (most common)
      heaviestShortLevel: currentPrice * (1 + 1 / 10),
      timestamp: Date.now(),
    };
  } catch (e) {
    console.warn(`[liquidation] Failed to fetch Binance estimate for ${symbol}:`, e);
    return null;
  }
}

/**
 * Fetch aggregated liquidation data from all sources
 */
export async function fetchLiquidationData(): Promise<AggregatedLiquidationData> {
  // Check cache
  if (cachedLiquidations && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedLiquidations;
  }

  // Try CoinGlass first, fall back to Binance estimate
  let btcData = await fetchCoinGlassLiquidations('BTC');
  if (!btcData) {
    btcData = await fetchBinanceLiquidationEstimate('BTC');
  }

  let ethData = await fetchCoinGlassLiquidations('ETH');
  if (!ethData) {
    ethData = await fetchBinanceLiquidationEstimate('ETH');
  }

  cachedLiquidations = {
    btc: btcData,
    eth: ethData,
    timestamp: Date.now(),
  };
  lastFetchTime = Date.now();

  // Persist to cache file
  try {
    writeFileSync(LIQUIDATION_CACHE_FILE, JSON.stringify(cachedLiquidations, null, 2));
  } catch (e) {
    // Ignore write errors
  }

  return cachedLiquidations;
}

/**
 * Get liquidation levels for cascade risk calculation
 */
export async function getLiquidationLevelsForCascade(): Promise<{ long: number; short: number; size: number }[]> {
  const data = await fetchLiquidationData();
  const levels: { long: number; short: number; size: number }[] = [];

  // Combine BTC and ETH levels (weighted by market cap)
  const btcWeight = 0.6;
  const ethWeight = 0.4;

  if (data.btc) {
    for (const level of data.btc.levels) {
      levels.push({
        long: level.price,
        short: level.price,
        size: level.totalUsd * btcWeight,
      });
    }
  }

  if (data.eth) {
    for (const level of data.eth.levels) {
      // Normalize ETH prices to BTC equivalent for comparison
      const btcPrice = data.btc?.currentPrice || 90000;
      const ethPrice = data.eth.currentPrice;
      const ratio = btcPrice / ethPrice;

      levels.push({
        long: level.price * ratio,
        short: level.price * ratio,
        size: level.totalUsd * ethWeight,
      });
    }
  }

  return levels;
}

/**
 * Calculate cascade probability based on current price and levels
 */
export function calculateCascadeProbability(
  currentPrice: number,
  levels: { long: number; short: number; size: number }[],
  volatility: number, // 24h volatility as decimal (e.g., 0.05 = 5%)
): {
  longCascadeProb: number;
  shortCascadeProb: number;
  expectedLongCascadeUsd: number;
  expectedShortCascadeUsd: number;
} {
  // Calculate probability of reaching each level based on volatility
  // Using simplified normal distribution assumption
  const stdDev = currentPrice * volatility;

  let longCascadeProb = 0;
  let shortCascadeProb = 0;
  let expectedLong = 0;
  let expectedShort = 0;

  for (const level of levels) {
    if (level.long < currentPrice && level.size > 0) {
      // Probability of price falling to long liquidation level
      const zScore = (currentPrice - level.long) / stdDev;
      const prob = 1 - normalCDF(zScore);
      longCascadeProb = Math.max(longCascadeProb, prob);
      expectedLong += prob * level.size;
    }

    if (level.short > currentPrice && level.size > 0) {
      // Probability of price rising to short liquidation level
      const zScore = (level.short - currentPrice) / stdDev;
      const prob = 1 - normalCDF(zScore);
      shortCascadeProb = Math.max(shortCascadeProb, prob);
      expectedShort += prob * level.size;
    }
  }

  return {
    longCascadeProb: Math.min(1, longCascadeProb),
    shortCascadeProb: Math.min(1, shortCascadeProb),
    expectedLongCascadeUsd: expectedLong,
    expectedShortCascadeUsd: expectedShort,
  };
}

/**
 * Standard normal CDF approximation
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Load cached liquidation data (for fast startup)
 */
export function loadCachedLiquidationData(): AggregatedLiquidationData | null {
  try {
    if (existsSync(LIQUIDATION_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(LIQUIDATION_CACHE_FILE, 'utf-8'));
      // Only use if less than 5 minutes old
      if (Date.now() - data.timestamp < 300000) {
        cachedLiquidations = data;
        lastFetchTime = data.timestamp;
        return data;
      }
    }
  } catch (e) {
    // Ignore load errors
  }
  return null;
}

// Load cache on module init
loadCachedLiquidationData();
