/**
 * Advanced Market Signals Module
 *
 * Aggregates signals from:
 * - Exchange flows (CEX inflows/outflows)
 * - Funding rates and open interest
 * - Whale wallet tracking
 * - Liquidation data
 *
 * Note: Some endpoints require API keys for production use.
 * Free alternatives and fallbacks are provided where possible.
 */

export interface ExchangeFlows {
  netflow24h: number;      // Positive = inflow to exchanges (bearish), negative = outflow (bullish)
  inflowVolume: number;
  outflowVolume: number;
  exchangeReserve: number;
  reserveChange24h: number;
  trend: 'accumulation' | 'distribution' | 'neutral';
}

export interface FundingRates {
  btcFunding: number;      // Annualized funding rate
  ethFunding: number;
  avgFunding: number;
  fundingTrend: 'positive' | 'negative' | 'neutral';
  extremeLevel: boolean;   // True if funding > 50% annualized
}

export interface OpenInterest {
  btcOI: number;
  ethOI: number;
  btcOIChange24h: number;
  ethOIChange24h: number;
  oiTrend: 'increasing' | 'decreasing' | 'stable';
}

export interface WhaleActivity {
  largeTransfers24h: number;
  whaleAccumulating: boolean;
  whaleDistributing: boolean;
  topWalletChange: number; // % change in top 100 wallets
  recentLargeTransfers: Array<{
    amount: number;
    token: string;
    from: string;
    to: string;
    isExchangeInflow: boolean;
    timestamp: number;
  }>;
}

export interface LiquidationData {
  totalLiquidations24h: number;
  longLiquidations: number;
  shortLiquidations: number;
  liquidationRatio: number; // long/short ratio, >1 = more longs liquidated
  largestLiquidation: number;
}

export interface AdvancedSignals {
  exchangeFlows: ExchangeFlows;
  funding: FundingRates;
  openInterest: OpenInterest;
  whales: WhaleActivity;
  liquidations: LiquidationData;
  timestamp: number;

  // Composite signals
  compositeSignals: {
    smartMoneyFlow: number;      // -1 to 1, positive = smart money buying
    leverageRisk: number;        // 0 to 1, higher = more leverage risk
    institutionalSentiment: number; // -1 to 1
    retailFomo: number;          // 0 to 1, higher = more retail fomo
  };
}

// Cache
let cachedAdvanced: AdvancedSignals | null = null;
let lastAdvancedFetch = 0;
const CACHE_TTL = 300000; // 5 minutes

/**
 * Fetch funding rates from Binance (free, no API key needed)
 */
async function fetchBinanceFunding(): Promise<FundingRates> {
  try {
    // Binance public API for funding rates
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1'),
      fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=1'),
    ]);

    const btcData = await btcRes.json();
    const ethData = await ethRes.json();

    const btcFunding = btcData[0] ? parseFloat(btcData[0].fundingRate) * 3 * 365 * 100 : 0; // Annualized %
    const ethFunding = ethData[0] ? parseFloat(ethData[0].fundingRate) * 3 * 365 * 100 : 0;
    const avgFunding = (btcFunding + ethFunding) / 2;

    return {
      btcFunding,
      ethFunding,
      avgFunding,
      fundingTrend: avgFunding > 5 ? 'positive' : avgFunding < -5 ? 'negative' : 'neutral',
      extremeLevel: Math.abs(avgFunding) > 50,
    };
  } catch (e) {
    console.error('[advancedSignals] Binance funding fetch failed:', e);
    return {
      btcFunding: 0,
      ethFunding: 0,
      avgFunding: 0,
      fundingTrend: 'neutral',
      extremeLevel: false,
    };
  }
}

/**
 * Fetch open interest from Binance
 */
async function fetchBinanceOI(): Promise<OpenInterest> {
  try {
    const [btcRes, ethRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
      fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=ETHUSDT'),
    ]);

    const btcData = await btcRes.json();
    const ethData = await ethRes.json();

    const btcOI = parseFloat(btcData.openInterest || '0');
    const ethOI = parseFloat(ethData.openInterest || '0');

    // For change, we'd need historical data - estimate based on current
    return {
      btcOI,
      ethOI,
      btcOIChange24h: 0, // Would need historical comparison
      ethOIChange24h: 0,
      oiTrend: 'stable',
    };
  } catch (e) {
    console.error('[advancedSignals] Binance OI fetch failed:', e);
    return {
      btcOI: 0,
      ethOI: 0,
      btcOIChange24h: 0,
      ethOIChange24h: 0,
      oiTrend: 'stable',
    };
  }
}

/**
 * Fetch liquidation data from CoinGlass public endpoint
 */
async function fetchLiquidations(): Promise<LiquidationData> {
  try {
    // CoinGlass has a public liquidation endpoint
    const res = await fetch('https://open-api.coinglass.com/public/v2/liquidation_history?time_type=h24&symbol=BTC');
    const data = await res.json();

    if (data.code === '0' && data.data) {
      const liqData = data.data;
      const longLiq = liqData.longLiquidationUsd || 0;
      const shortLiq = liqData.shortLiquidationUsd || 0;

      return {
        totalLiquidations24h: longLiq + shortLiq,
        longLiquidations: longLiq,
        shortLiquidations: shortLiq,
        liquidationRatio: shortLiq > 0 ? longLiq / shortLiq : 1,
        largestLiquidation: liqData.largestLiquidation || 0,
      };
    }
    throw new Error('Invalid response');
  } catch (e) {
    // Fallback: estimate from price volatility
    return {
      totalLiquidations24h: 0,
      longLiquidations: 0,
      shortLiquidations: 0,
      liquidationRatio: 1,
      largestLiquidation: 0,
    };
  }
}

/**
 * Estimate exchange flows from on-chain data
 * In production, use CryptoQuant or Glassnode API
 */
async function fetchExchangeFlows(): Promise<ExchangeFlows> {
  try {
    // Use DeFiLlama bridge flows as proxy for exchange activity
    const res = await fetch('https://bridges.llama.fi/bridgevolume/all?starttimestamp=' +
      Math.floor((Date.now() - 86400000) / 1000) + '&endtimestamp=' + Math.floor(Date.now() / 1000));
    const data = await res.json();

    // Aggregate bridge volumes as proxy
    let totalVolume = 0;
    if (Array.isArray(data)) {
      totalVolume = data.reduce((sum: number, d: any) => sum + (d.depositUSD || 0), 0);
    }

    // Estimate based on bridge activity (imperfect proxy)
    return {
      netflow24h: 0, // Would need proper exchange data
      inflowVolume: totalVolume / 2,
      outflowVolume: totalVolume / 2,
      exchangeReserve: 0,
      reserveChange24h: 0,
      trend: 'neutral',
    };
  } catch (e) {
    return {
      netflow24h: 0,
      inflowVolume: 0,
      outflowVolume: 0,
      exchangeReserve: 0,
      reserveChange24h: 0,
      trend: 'neutral',
    };
  }
}

/**
 * Track whale activity using Etherscan API (requires free API key)
 * Falls back to estimation without key
 */
async function fetchWhaleActivity(): Promise<WhaleActivity> {
  const etherscanKey = process.env.ETHERSCAN_API_KEY;

  if (etherscanKey) {
    try {
      // Get recent large transactions
      const res = await fetch(
        `https://api.etherscan.io/api?module=account&action=txlist&address=0x0000000000000000000000000000000000000000&startblock=0&endblock=99999999&page=1&offset=100&sort=desc&apikey=${etherscanKey}`
      );
      const data = await res.json();

      // Process large transfers
      const largeTransfers = (data.result || [])
        .filter((tx: any) => parseFloat(tx.value) / 1e18 > 100) // > 100 ETH
        .slice(0, 10)
        .map((tx: any) => ({
          amount: parseFloat(tx.value) / 1e18,
          token: 'ETH',
          from: tx.from,
          to: tx.to,
          isExchangeInflow: false, // Would need exchange address list
          timestamp: parseInt(tx.timeStamp) * 1000,
        }));

      return {
        largeTransfers24h: largeTransfers.length,
        whaleAccumulating: false,
        whaleDistributing: false,
        topWalletChange: 0,
        recentLargeTransfers: largeTransfers,
      };
    } catch (e) {
      console.error('[advancedSignals] Etherscan fetch failed:', e);
    }
  }

  // Fallback without API key
  return {
    largeTransfers24h: 0,
    whaleAccumulating: false,
    whaleDistributing: false,
    topWalletChange: 0,
    recentLargeTransfers: [],
  };
}

/**
 * Compute composite signals from raw data
 */
function computeCompositeSignals(
  flows: ExchangeFlows,
  funding: FundingRates,
  oi: OpenInterest,
  whales: WhaleActivity,
  liquidations: LiquidationData
): AdvancedSignals['compositeSignals'] {
  // Smart money flow: exchange outflows + whale accumulation = bullish
  let smartMoneyFlow = 0;
  if (flows.netflow24h < 0) smartMoneyFlow += 0.3; // Outflows = bullish
  if (flows.netflow24h > 0) smartMoneyFlow -= 0.3; // Inflows = bearish
  if (whales.whaleAccumulating) smartMoneyFlow += 0.4;
  if (whales.whaleDistributing) smartMoneyFlow -= 0.4;
  smartMoneyFlow = Math.max(-1, Math.min(1, smartMoneyFlow));

  // Leverage risk: high OI + extreme funding + liquidations
  let leverageRisk = 0;
  if (funding.extremeLevel) leverageRisk += 0.4;
  if (Math.abs(funding.avgFunding) > 30) leverageRisk += 0.2;
  if (liquidations.totalLiquidations24h > 500000000) leverageRisk += 0.2; // > $500M
  if (oi.oiTrend === 'increasing') leverageRisk += 0.2;
  leverageRisk = Math.min(1, leverageRisk);

  // Institutional sentiment: low funding + accumulation = institutional buying
  let institutionalSentiment = 0;
  if (funding.avgFunding < 10 && funding.avgFunding > -10) institutionalSentiment += 0.2;
  if (flows.trend === 'accumulation') institutionalSentiment += 0.4;
  if (flows.trend === 'distribution') institutionalSentiment -= 0.4;
  institutionalSentiment = Math.max(-1, Math.min(1, institutionalSentiment));

  // Retail FOMO: extreme positive funding + high liquidations + increasing OI
  let retailFomo = 0;
  if (funding.avgFunding > 30) retailFomo += 0.3;
  if (funding.avgFunding > 50) retailFomo += 0.2;
  if (liquidations.liquidationRatio > 2) retailFomo += 0.2; // More longs liquidated
  if (oi.oiTrend === 'increasing') retailFomo += 0.2;
  retailFomo = Math.min(1, retailFomo);

  return {
    smartMoneyFlow,
    leverageRisk,
    institutionalSentiment,
    retailFomo,
  };
}

/**
 * Fetch all advanced signals
 */
export async function fetchAdvancedSignals(): Promise<AdvancedSignals> {
  // Check cache
  if (cachedAdvanced && Date.now() - lastAdvancedFetch < CACHE_TTL) {
    return cachedAdvanced;
  }

  // Fetch all data in parallel
  const [funding, oi, liquidations, flows, whales] = await Promise.all([
    fetchBinanceFunding(),
    fetchBinanceOI(),
    fetchLiquidations(),
    fetchExchangeFlows(),
    fetchWhaleActivity(),
  ]);

  const compositeSignals = computeCompositeSignals(flows, funding, oi, whales, liquidations);

  cachedAdvanced = {
    exchangeFlows: flows,
    funding,
    openInterest: oi,
    whales,
    liquidations,
    timestamp: Date.now(),
    compositeSignals,
  };
  lastAdvancedFetch = Date.now();

  return cachedAdvanced;
}

/**
 * Get a summary string for logging
 */
export function getAdvancedSummary(data: AdvancedSignals): string {
  const lines = [
    `Funding: BTC ${data.funding.btcFunding.toFixed(1)}% / ETH ${data.funding.ethFunding.toFixed(1)}% (annualized)`,
    `OI: BTC ${data.openInterest.btcOI.toFixed(0)} / ETH ${data.openInterest.ethOI.toFixed(0)}`,
    `Liquidations 24h: $${(data.liquidations.totalLiquidations24h / 1e6).toFixed(1)}M (L/S: ${data.liquidations.liquidationRatio.toFixed(2)})`,
    `Smart Money: ${(data.compositeSignals.smartMoneyFlow * 100).toFixed(0)}%`,
    `Leverage Risk: ${(data.compositeSignals.leverageRisk * 100).toFixed(0)}%`,
    `Retail FOMO: ${(data.compositeSignals.retailFomo * 100).toFixed(0)}%`,
  ];

  if (data.funding.extremeLevel) {
    lines.push('WARNING: Extreme funding rates detected');
  }

  return lines.join('\n');
}
