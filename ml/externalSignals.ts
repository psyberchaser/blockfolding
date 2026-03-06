/**
 * External Data Signals Module
 *
 * Additional signals from external APIs:
 * 1. Options Flow - Deribit put/call ratio, max pain
 * 2. Liquidation Heatmap - Liquidation clusters by price
 * 3. Whale Tracker - Large wallet movements
 * 4. Token Unlocks - Upcoming supply events
 * 5. Google Trends - Search volume signals
 */

// ============================================
// 1. OPTIONS FLOW (Deribit)
// ============================================

export interface OptionsFlow {
  btcPutCallRatio: number;      // >1 = bearish, <1 = bullish
  ethPutCallRatio: number;
  btcMaxPain: number;           // Price where most options expire worthless
  ethMaxPain: number;
  btcIV: number;                // Implied volatility
  ethIV: number;
  ivSkew: number;               // Put IV - Call IV (positive = fear)
  sentiment: 'bullish' | 'bearish' | 'neutral';
  unusualActivity: boolean;     // Large option trades detected
}

let cachedOptions: OptionsFlow | null = null;
let lastOptionsFetch = 0;
const OPTIONS_CACHE_TTL = 300000; // 5 min

export async function fetchOptionsFlow(): Promise<OptionsFlow> {
  if (cachedOptions && Date.now() - lastOptionsFetch < OPTIONS_CACHE_TTL) {
    return cachedOptions;
  }

  try {
    // Deribit public API for options data
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'),
      fetch('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=option'),
    ]);

    const btcData = await btcRes.json();
    const ethData = await ethRes.json();

    // Calculate put/call ratios from open interest
    let btcPuts = 0, btcCalls = 0, ethPuts = 0, ethCalls = 0;
    let btcTotalIV = 0, ethTotalIV = 0, btcIVCount = 0, ethIVCount = 0;

    for (const opt of btcData.result || []) {
      if (opt.instrument_name.includes('-P')) {
        btcPuts += opt.open_interest || 0;
      } else if (opt.instrument_name.includes('-C')) {
        btcCalls += opt.open_interest || 0;
      }
      if (opt.mark_iv) {
        btcTotalIV += opt.mark_iv;
        btcIVCount++;
      }
    }

    for (const opt of ethData.result || []) {
      if (opt.instrument_name.includes('-P')) {
        ethPuts += opt.open_interest || 0;
      } else if (opt.instrument_name.includes('-C')) {
        ethCalls += opt.open_interest || 0;
      }
      if (opt.mark_iv) {
        ethTotalIV += opt.mark_iv;
        ethIVCount++;
      }
    }

    const btcPutCallRatio = btcCalls > 0 ? btcPuts / btcCalls : 1;
    const ethPutCallRatio = ethCalls > 0 ? ethPuts / ethCalls : 1;
    const btcIV = btcIVCount > 0 ? btcTotalIV / btcIVCount : 50;
    const ethIV = ethIVCount > 0 ? ethTotalIV / ethIVCount : 50;

    // Fetch max pain from index prices
    const [btcIndexRes, ethIndexRes] = await Promise.all([
      fetch('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd'),
      fetch('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd'),
    ]);

    const btcIndex = await btcIndexRes.json();
    const ethIndex = await ethIndexRes.json();

    // Max pain approximation (would need full calculation in production)
    const btcPrice = btcIndex.result?.index_price || 90000;
    const ethPrice = ethIndex.result?.index_price || 3000;
    const btcMaxPain = Math.round(btcPrice * 0.95); // Simplified
    const ethMaxPain = Math.round(ethPrice * 0.95);

    const avgPCR = (btcPutCallRatio + ethPutCallRatio) / 2;
    const sentiment = avgPCR > 1.2 ? 'bearish' : avgPCR < 0.8 ? 'bullish' : 'neutral';

    cachedOptions = {
      btcPutCallRatio,
      ethPutCallRatio,
      btcMaxPain,
      ethMaxPain,
      btcIV,
      ethIV,
      ivSkew: 0, // Would need more granular data
      sentiment,
      unusualActivity: btcIV > 80 || ethIV > 100,
    };
    lastOptionsFetch = Date.now();

    return cachedOptions;
  } catch (e) {
    console.warn('[signals] Options data unavailable');
    return {
      btcPutCallRatio: 1,
      ethPutCallRatio: 1,
      btcMaxPain: 90000,
      ethMaxPain: 3000,
      btcIV: 50,
      ethIV: 50,
      ivSkew: 0,
      sentiment: 'neutral',
      unusualActivity: false,
    };
  }
}

// ============================================
// 2. LIQUIDATION HEATMAP
// ============================================

export interface LiquidationLevel {
  price: number;
  longLiquidations: number;   // USD value of longs liquidated at this level
  shortLiquidations: number;  // USD value of shorts liquidated
  totalLiquidations: number;
}

export interface LiquidationHeatmap {
  btcLevels: LiquidationLevel[];
  ethLevels: LiquidationLevel[];
  btcNearestLongLiq: number;    // Nearest price level with heavy long liquidations
  btcNearestShortLiq: number;
  ethNearestLongLiq: number;
  ethNearestShortLiq: number;
  cascadeRisk: 'low' | 'medium' | 'high';
}

let cachedLiquidations: LiquidationHeatmap | null = null;
let lastLiqFetch = 0;
const LIQ_CACHE_TTL = 60000; // 1 min

export async function fetchLiquidationHeatmap(): Promise<LiquidationHeatmap> {
  if (cachedLiquidations && Date.now() - lastLiqFetch < LIQ_CACHE_TTL) {
    return cachedLiquidations;
  }

  try {
    // Use CoinGlass public API for liquidation data
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://open-api.coinglass.com/public/v2/liquidation_map?symbol=BTC&interval=h4'),
      fetch('https://open-api.coinglass.com/public/v2/liquidation_map?symbol=ETH&interval=h4'),
    ]);

    const btcData = await btcRes.json();
    const ethData = await ethRes.json();

    // Parse liquidation levels
    const parseLevels = (data: any): LiquidationLevel[] => {
      if (!data?.data?.list) return [];
      return data.data.list.map((l: any) => ({
        price: l.price,
        longLiquidations: l.longLiqUsd || 0,
        shortLiquidations: l.shortLiqUsd || 0,
        totalLiquidations: (l.longLiqUsd || 0) + (l.shortLiqUsd || 0),
      })).slice(0, 20); // Top 20 levels
    };

    const btcLevels = parseLevels(btcData);
    const ethLevels = parseLevels(ethData);

    // Find nearest significant liquidation levels
    const findNearest = (levels: LiquidationLevel[], type: 'long' | 'short', currentPrice: number) => {
      const filtered = levels.filter(l =>
        type === 'long' ? l.longLiquidations > 1000000 : l.shortLiquidations > 1000000
      );
      if (filtered.length === 0) return currentPrice * (type === 'long' ? 0.95 : 1.05);

      filtered.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
      return filtered[0].price;
    };

    // Estimate current prices
    const btcPrice = 90000; // Would get from market data
    const ethPrice = 3000;

    const btcNearestLongLiq = findNearest(btcLevels, 'long', btcPrice);
    const btcNearestShortLiq = findNearest(btcLevels, 'short', btcPrice);
    const ethNearestLongLiq = findNearest(ethLevels, 'long', ethPrice);
    const ethNearestShortLiq = findNearest(ethLevels, 'short', ethPrice);

    // Calculate cascade risk
    const btcLongDist = Math.abs(btcPrice - btcNearestLongLiq) / btcPrice;
    const btcShortDist = Math.abs(btcPrice - btcNearestShortLiq) / btcPrice;
    const minDist = Math.min(btcLongDist, btcShortDist);

    const cascadeRisk = minDist < 0.02 ? 'high' : minDist < 0.05 ? 'medium' : 'low';

    cachedLiquidations = {
      btcLevels,
      ethLevels,
      btcNearestLongLiq,
      btcNearestShortLiq,
      ethNearestLongLiq,
      ethNearestShortLiq,
      cascadeRisk,
    };
    lastLiqFetch = Date.now();

    return cachedLiquidations;
  } catch (e) {
    console.warn('[signals] Liquidation data unavailable');
    return {
      btcLevels: [],
      ethLevels: [],
      btcNearestLongLiq: 85000,
      btcNearestShortLiq: 95000,
      ethNearestLongLiq: 2850,
      ethNearestShortLiq: 3150,
      cascadeRisk: 'low',
    };
  }
}

// ============================================
// 3. WHALE TRACKER
// ============================================

export interface WhaleMovement {
  address: string;
  label: string;            // Known entity name if available
  token: string;
  amount: number;
  usdValue: number;
  type: 'deposit' | 'withdrawal' | 'transfer';
  destination: string;
  timestamp: number;
}

export interface WhaleSignals {
  recentMovements: WhaleMovement[];
  netExchangeFlow: number;      // Positive = to exchanges (bearish)
  largeTransfers24h: number;    // Count of >$1M transfers
  whaleAccumulating: boolean;
  whaleDistributing: boolean;
  smartMoneyDirection: 'buying' | 'selling' | 'neutral';
}

let cachedWhales: WhaleSignals | null = null;
let lastWhaleFetch = 0;
const WHALE_CACHE_TTL = 120000; // 2 min

export async function fetchWhaleSignals(): Promise<WhaleSignals> {
  if (cachedWhales && Date.now() - lastWhaleFetch < WHALE_CACHE_TTL) {
    return cachedWhales;
  }

  try {
    // Use Whale Alert API (free tier) or etherscan for large transfers
    // For demo, using blockchain.com API for large BTC transactions
    const res = await fetch('https://blockchain.info/unconfirmed-transactions?format=json');
    const data = await res.json();

    const movements: WhaleMovement[] = [];
    let totalInflow = 0;
    let totalOutflow = 0;
    let largeCount = 0;

    // Known exchange addresses (simplified list)
    const exchangeAddresses = new Set([
      'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', // Binance
      '3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6', // Binance
    ]);

    for (const tx of (data.txs || []).slice(0, 100)) {
      const value = tx.out?.reduce((s: number, o: any) => s + (o.value || 0), 0) / 1e8;
      const usdValue = value * 90000; // Approximate BTC price

      if (usdValue > 1000000) { // >$1M
        largeCount++;

        const toExchange = tx.out?.some((o: any) => exchangeAddresses.has(o.addr));
        const fromExchange = tx.inputs?.some((i: any) => exchangeAddresses.has(i.prev_out?.addr));

        if (toExchange) totalInflow += usdValue;
        if (fromExchange) totalOutflow += usdValue;

        movements.push({
          address: tx.inputs?.[0]?.prev_out?.addr || 'unknown',
          label: fromExchange ? 'Exchange' : 'Whale',
          token: 'BTC',
          amount: value,
          usdValue,
          type: toExchange ? 'deposit' : fromExchange ? 'withdrawal' : 'transfer',
          destination: tx.out?.[0]?.addr || 'unknown',
          timestamp: tx.time * 1000,
        });
      }
    }

    const netFlow = totalInflow - totalOutflow;

    cachedWhales = {
      recentMovements: movements.slice(0, 10),
      netExchangeFlow: netFlow,
      largeTransfers24h: largeCount,
      whaleAccumulating: netFlow < -10000000, // >$10M outflow
      whaleDistributing: netFlow > 10000000,  // >$10M inflow
      smartMoneyDirection: netFlow < -5000000 ? 'buying' : netFlow > 5000000 ? 'selling' : 'neutral',
    };
    lastWhaleFetch = Date.now();

    return cachedWhales;
  } catch (e) {
    console.warn('[signals] Whale data unavailable');
    return {
      recentMovements: [],
      netExchangeFlow: 0,
      largeTransfers24h: 0,
      whaleAccumulating: false,
      whaleDistributing: false,
      smartMoneyDirection: 'neutral',
    };
  }
}

// ============================================
// 4. TOKEN UNLOCKS
// ============================================

export interface TokenUnlock {
  token: string;
  symbol: string;
  unlockDate: number;
  unlockAmount: number;
  unlockValueUsd: number;
  percentOfSupply: number;
  type: 'cliff' | 'linear' | 'team' | 'investor';
}

export interface UnlockSignals {
  upcomingUnlocks: TokenUnlock[];   // Next 7 days
  totalUnlockValue7d: number;
  majorUnlockImminent: boolean;     // >$100M in next 48h
  affectedTokens: string[];
}

let cachedUnlocks: UnlockSignals | null = null;
let lastUnlockFetch = 0;
const UNLOCK_CACHE_TTL = 3600000; // 1 hour

export async function fetchTokenUnlocks(): Promise<UnlockSignals> {
  if (cachedUnlocks && Date.now() - lastUnlockFetch < UNLOCK_CACHE_TTL) {
    return cachedUnlocks;
  }

  try {
    // Use Token Unlocks API or DeFiLlama unlocks endpoint
    const res = await fetch('https://api.llama.fi/unlocks');
    const data = await res.json();

    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const fortyEightHours = 48 * 60 * 60 * 1000;

    const upcomingUnlocks: TokenUnlock[] = [];
    let totalValue = 0;
    let majorImminent = false;
    const affectedTokens: string[] = [];

    for (const unlock of data || []) {
      const unlockTime = unlock.timestamp * 1000;
      if (unlockTime > now && unlockTime < now + sevenDays) {
        const value = unlock.unlockValueUsd || 0;

        upcomingUnlocks.push({
          token: unlock.name || unlock.symbol,
          symbol: unlock.symbol,
          unlockDate: unlockTime,
          unlockAmount: unlock.unlockAmount || 0,
          unlockValueUsd: value,
          percentOfSupply: unlock.percentOfSupply || 0,
          type: unlock.type || 'cliff',
        });

        totalValue += value;

        if (value > 100000000 && unlockTime < now + fortyEightHours) {
          majorImminent = true;
        }

        if (value > 10000000 && !affectedTokens.includes(unlock.symbol)) {
          affectedTokens.push(unlock.symbol);
        }
      }
    }

    // Sort by unlock date
    upcomingUnlocks.sort((a, b) => a.unlockDate - b.unlockDate);

    cachedUnlocks = {
      upcomingUnlocks: upcomingUnlocks.slice(0, 10),
      totalUnlockValue7d: totalValue,
      majorUnlockImminent: majorImminent,
      affectedTokens,
    };
    lastUnlockFetch = Date.now();

    return cachedUnlocks;
  } catch (e) {
    console.warn('[signals] Unlock data unavailable');
    return {
      upcomingUnlocks: [],
      totalUnlockValue7d: 0,
      majorUnlockImminent: false,
      affectedTokens: [],
    };
  }
}

// ============================================
// 5. GOOGLE TRENDS
// ============================================

export interface TrendSignals {
  btcInterest: number;          // 0-100 relative search interest
  ethInterest: number;
  cryptoInterest: number;
  btcTrend: 'rising' | 'falling' | 'stable';
  searchSpike: boolean;         // Sudden >50% increase
  retailFomo: boolean;          // High search + rising
  relatedQueries: string[];     // Top related searches
}

let cachedTrends: TrendSignals | null = null;
let lastTrendFetch = 0;
const TREND_CACHE_TTL = 3600000; // 1 hour (Google Trends data is slow-moving)

export async function fetchGoogleTrends(): Promise<TrendSignals> {
  if (cachedTrends && Date.now() - lastTrendFetch < TREND_CACHE_TTL) {
    return cachedTrends;
  }

  try {
    // Note: Google Trends doesn't have a free public API
    // Using SerpAPI or similar would require a key
    // For now, we'll use a proxy estimation based on social metrics

    // Alternative: Use CoinGecko trending as proxy for retail interest
    const trendingRes = await fetch('https://api.coingecko.com/api/v3/search/trending');
    const trending = await trendingRes.json();

    // Check if BTC/ETH are in trending (indicates retail interest)
    const trendingSymbols = (trending.coins || []).map((c: any) => c.item.symbol.toLowerCase());
    const btcTrending = trendingSymbols.includes('btc');
    const ethTrending = trendingSymbols.includes('eth');

    // Use Fear & Greed as proxy for retail sentiment
    const fgRes = await fetch('https://api.alternative.me/fng/?limit=7');
    const fgData = await fgRes.json();

    const currentFG = parseInt(fgData.data?.[0]?.value || '50');
    const prevFG = parseInt(fgData.data?.[1]?.value || '50');
    const weekAgoFG = parseInt(fgData.data?.[6]?.value || '50');

    // Estimate search interest from fear/greed (high greed = high search)
    const btcInterest = Math.min(100, currentFG + (btcTrending ? 20 : 0));
    const ethInterest = Math.min(100, currentFG + (ethTrending ? 20 : 0));
    const cryptoInterest = Math.min(100, (btcInterest + ethInterest) / 2);

    // Determine trend
    const btcTrend = currentFG > prevFG + 5 ? 'rising' : currentFG < prevFG - 5 ? 'falling' : 'stable';

    // Search spike: current significantly higher than week ago
    const searchSpike = currentFG > weekAgoFG + 20;

    // Retail FOMO: high interest + rising
    const retailFomo = cryptoInterest > 70 && btcTrend === 'rising';

    cachedTrends = {
      btcInterest,
      ethInterest,
      cryptoInterest,
      btcTrend,
      searchSpike,
      retailFomo,
      relatedQueries: trendingSymbols.slice(0, 5),
    };
    lastTrendFetch = Date.now();

    return cachedTrends;
  } catch (e) {
    console.warn('[signals] Trends data unavailable');
    return {
      btcInterest: 50,
      ethInterest: 50,
      cryptoInterest: 50,
      btcTrend: 'stable',
      searchSpike: false,
      retailFomo: false,
      relatedQueries: [],
    };
  }
}

// ============================================
// AGGREGATE ALL EXTERNAL SIGNALS
// ============================================

export interface AllExternalSignals {
  options: OptionsFlow;
  liquidations: LiquidationHeatmap;
  whales: WhaleSignals;
  unlocks: UnlockSignals;
  trends: TrendSignals;
  timestamp: number;
}

export async function fetchAllExternalSignals(): Promise<AllExternalSignals> {
  const [options, liquidations, whales, unlocks, trends] = await Promise.all([
    fetchOptionsFlow(),
    fetchLiquidationHeatmap(),
    fetchWhaleSignals(),
    fetchTokenUnlocks(),
    fetchGoogleTrends(),
  ]);

  return {
    options,
    liquidations,
    whales,
    unlocks,
    trends,
    timestamp: Date.now(),
  };
}
