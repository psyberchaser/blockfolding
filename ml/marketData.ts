/**
 * Enhanced Market Data Module
 *
 * Aggregates signals from multiple sources:
 * - Pyth (real-time prices)
 * - CoinGecko (market data, volume, momentum)
 * - DeFiLlama (TVL, protocol flows)
 * - Fear/Greed Index
 * - On-chain data (from our fingerprints)
 */

export interface PriceData {
  symbol: string;
  price: number;
  change24h: number;
  change7d: number;
  volume24h: number;
  marketCap: number;
  high24h: number;
  low24h: number;
}

export interface TVLData {
  chain: string;
  tvl: number;
  change24h: number;
  change7d: number;
}

export interface SentimentData {
  fearGreedIndex: number;
  fearGreedLabel: string;
  socialVolume: number;
  socialSentiment: number; // -1 to 1
}

export interface MarketConditions {
  // Price momentum
  ethMomentum: number;      // -1 (bearish) to 1 (bullish)
  solMomentum: number;
  btcMomentum: number;

  // Volatility
  volatility24h: number;    // 0-1 scale
  volatilityTrend: 'increasing' | 'decreasing' | 'stable';

  // Liquidity
  volumeToMcapRatio: number;
  tvlChange: number;

  // Sentiment
  fearGreedIndex: number;
  fearGreedZone: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';

  // Market structure
  btcDominance: number;
  altcoinSeason: boolean;   // True if alts outperforming BTC

  // Composite scores
  bullishScore: number;     // 0-100
  riskScore: number;        // 0-100 (higher = more risky)

  timestamp: number;
}

export interface EnhancedSignals {
  market: MarketConditions;
  prices: Record<string, PriceData>;
  tvl: TVLData[];

  // Computed signals
  signals: {
    trendStrength: number;      // 0-1
    reversalProbability: number; // 0-1
    volatilityBreakout: boolean;
    volumeAnomaly: boolean;
    tvlDivergence: boolean;     // Price up but TVL down = bearish divergence
    momentumAlignment: boolean;  // All assets moving same direction
  };
}

// Cache
let cachedData: EnhancedSignals | null = null;
let lastFetch = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Fetch price data from CoinGecko
 */
async function fetchCoinGeckoData(): Promise<Record<string, PriceData>> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,solana,bitcoin&sparkline=false&price_change_percentage=24h,7d'
    );
    const data = await res.json();

    // CoinGecko returns error object if rate limited
    if (!Array.isArray(data)) {
      console.warn('[market] CoinGecko rate limited');
      return {};
    }

    const prices: Record<string, PriceData> = {};
    for (const coin of data) {
      prices[coin.symbol.toUpperCase()] = {
        symbol: coin.symbol.toUpperCase(),
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h || 0,
        change7d: coin.price_change_percentage_7d_in_currency || 0,
        volume24h: coin.total_volume,
        marketCap: coin.market_cap,
        high24h: coin.high_24h,
        low24h: coin.low_24h,
      };
    }
    return prices;
  } catch (e) {
    console.warn('[market] Price data unavailable');
    return {};
  }
}

/**
 * Fetch TVL data from DeFiLlama
 */
async function fetchTVLData(): Promise<TVLData[]> {
  try {
    const chains = ['Ethereum', 'Solana', 'Avalanche'];
    const tvlData: TVLData[] = [];

    for (const chain of chains) {
      const res = await fetch(`https://api.llama.fi/v2/historicalChainTvl/${chain}`);
      const data = await res.json();

      if (data.length >= 2) {
        const current = data[data.length - 1].tvl;
        const yesterday = data[data.length - 2].tvl;
        const weekAgo = data.length >= 8 ? data[data.length - 8].tvl : current;

        tvlData.push({
          chain: chain.toLowerCase(),
          tvl: current,
          change24h: ((current - yesterday) / yesterday) * 100,
          change7d: ((current - weekAgo) / weekAgo) * 100,
        });
      }
    }
    return tvlData;
  } catch (e) {
    console.warn('[market] TVL data unavailable');
    return [];
  }
}

/**
 * Fetch Fear/Greed Index
 */
async function fetchFearGreed(): Promise<SentimentData> {
  try {
    const res = await fetch('https://api.alternative.me/fng/');
    const data = await res.json();
    const fg = data.data[0];

    return {
      fearGreedIndex: parseInt(fg.value),
      fearGreedLabel: fg.value_classification,
      socialVolume: 0, // Would need Twitter API
      socialSentiment: 0,
    };
  } catch (e) {
    return {
      fearGreedIndex: 50,
      fearGreedLabel: 'Neutral',
      socialVolume: 0,
      socialSentiment: 0,
    };
  }
}

/**
 * Calculate momentum from price changes
 */
function calculateMomentum(change24h: number, change7d: number): number {
  // Weight recent changes more heavily
  const shortTerm = change24h / 10; // Normalize: 10% change = 1.0
  const mediumTerm = change7d / 20;  // Normalize: 20% weekly change = 1.0

  const momentum = (shortTerm * 0.7 + mediumTerm * 0.3);
  return Math.max(-1, Math.min(1, momentum)); // Clamp to [-1, 1]
}

/**
 * Calculate volatility from price range
 */
function calculateVolatility(high: number, low: number, current: number): number {
  if (current === 0) return 0;
  const range = (high - low) / current;
  return Math.min(1, range * 5); // 20% range = 1.0 volatility
}

/**
 * Determine Fear/Greed zone
 */
function getFearGreedZone(index: number): MarketConditions['fearGreedZone'] {
  if (index <= 20) return 'extreme_fear';
  if (index <= 40) return 'fear';
  if (index <= 60) return 'neutral';
  if (index <= 80) return 'greed';
  return 'extreme_greed';
}

/**
 * Calculate composite bullish score
 */
function calculateBullishScore(
  prices: Record<string, PriceData>,
  fearGreed: number,
  tvlChange: number
): number {
  let score = 50; // Start neutral

  // Price momentum contribution (max ±30)
  const ethMomentum = prices['ETH']?.change24h || 0;
  score += Math.min(30, Math.max(-30, ethMomentum * 3));

  // Fear/Greed contrarian (max ±15)
  // Extreme fear = bullish, extreme greed = bearish
  if (fearGreed <= 20) score += 15;
  else if (fearGreed <= 35) score += 7;
  else if (fearGreed >= 80) score -= 15;
  else if (fearGreed >= 65) score -= 7;

  // TVL trend (max ±5)
  score += Math.min(5, Math.max(-5, tvlChange));

  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate risk score
 */
function calculateRiskScore(
  volatility: number,
  fearGreed: number,
  volumeRatio: number
): number {
  let risk = 50;

  // High volatility = higher risk
  risk += volatility * 30;

  // Extreme sentiment = higher risk
  const sentimentExtreme = Math.abs(fearGreed - 50) / 50;
  risk += sentimentExtreme * 20;

  // Low volume = higher risk (less liquidity)
  if (volumeRatio < 0.03) risk += 10;

  return Math.max(0, Math.min(100, risk));
}

/**
 * Fetch all market data and compute signals
 */
export async function fetchEnhancedMarketData(): Promise<EnhancedSignals> {
  // Check cache
  if (cachedData && Date.now() - lastFetch < CACHE_TTL) {
    return cachedData;
  }

  // Fetch all data in parallel
  const [prices, tvl, sentiment] = await Promise.all([
    fetchCoinGeckoData(),
    fetchTVLData(),
    fetchFearGreed(),
  ]);

  // Calculate derived metrics
  const eth = prices['ETH'] || { price: 0, change24h: 0, change7d: 0, volume24h: 0, marketCap: 1, high24h: 0, low24h: 0 };
  const sol = prices['SOL'] || { price: 0, change24h: 0, change7d: 0, volume24h: 0, marketCap: 1, high24h: 0, low24h: 0 };
  const btc = prices['BTC'] || { price: 0, change24h: 0, change7d: 0, volume24h: 0, marketCap: 1, high24h: 0, low24h: 0 };

  const ethVolatility = calculateVolatility(eth.high24h, eth.low24h, eth.price);
  const ethTVL = tvl.find(t => t.chain === 'ethereum');
  const tvlChange = ethTVL?.change24h || 0;

  const volumeToMcap = eth.volume24h / eth.marketCap;

  const market: MarketConditions = {
    ethMomentum: calculateMomentum(eth.change24h, eth.change7d),
    solMomentum: calculateMomentum(sol.change24h, sol.change7d),
    btcMomentum: calculateMomentum(btc.change24h, btc.change7d),

    volatility24h: ethVolatility,
    volatilityTrend: ethVolatility > 0.5 ? 'increasing' : ethVolatility < 0.2 ? 'decreasing' : 'stable',

    volumeToMcapRatio: volumeToMcap,
    tvlChange,

    fearGreedIndex: sentiment.fearGreedIndex,
    fearGreedZone: getFearGreedZone(sentiment.fearGreedIndex),

    btcDominance: btc.marketCap / (btc.marketCap + eth.marketCap + sol.marketCap),
    altcoinSeason: (eth.change7d > btc.change7d) && (sol.change7d > btc.change7d),

    bullishScore: calculateBullishScore(prices, sentiment.fearGreedIndex, tvlChange),
    riskScore: calculateRiskScore(ethVolatility, sentiment.fearGreedIndex, volumeToMcap),

    timestamp: Date.now(),
  };

  // Compute signals
  const signals = {
    trendStrength: Math.abs(market.ethMomentum),
    reversalProbability: market.fearGreedZone === 'extreme_fear' || market.fearGreedZone === 'extreme_greed' ? 0.7 : 0.3,
    volatilityBreakout: ethVolatility > 0.6,
    volumeAnomaly: volumeToMcap > 0.1, // Volume > 10% of market cap is unusual
    tvlDivergence: (eth.change24h > 0 && tvlChange < -2) || (eth.change24h < 0 && tvlChange > 2),
    momentumAlignment: Math.sign(market.ethMomentum) === Math.sign(market.solMomentum) &&
                       Math.sign(market.ethMomentum) === Math.sign(market.btcMomentum),
  };

  cachedData = {
    market,
    prices,
    tvl,
    signals,
  };
  lastFetch = Date.now();

  return cachedData;
}

/**
 * Get a human-readable market summary
 */
export function getMarketSummary(data: EnhancedSignals): string {
  const m = data.market;
  const lines = [
    `Market: ${m.bullishScore > 60 ? 'BULLISH' : m.bullishScore < 40 ? 'BEARISH' : 'NEUTRAL'} (${m.bullishScore}/100)`,
    `Risk: ${m.riskScore > 60 ? 'HIGH' : m.riskScore < 40 ? 'LOW' : 'MEDIUM'} (${m.riskScore}/100)`,
    `Fear/Greed: ${m.fearGreedIndex} (${m.fearGreedZone.replace('_', ' ')})`,
    `ETH Momentum: ${(m.ethMomentum * 100).toFixed(0)}%`,
    `Volatility: ${(m.volatility24h * 100).toFixed(0)}%`,
  ];

  if (data.signals.tvlDivergence) {
    lines.push('⚠️ TVL DIVERGENCE DETECTED');
  }
  if (data.signals.volumeAnomaly) {
    lines.push('⚠️ VOLUME ANOMALY DETECTED');
  }
  if (m.altcoinSeason) {
    lines.push('🔥 ALTCOIN SEASON');
  }

  return lines.join('\n');
}
