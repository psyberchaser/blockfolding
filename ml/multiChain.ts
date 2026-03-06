/**
 * Multi-Chain Data Module
 *
 * Tracks metrics across multiple chains:
 * - ETH, SOL, AVAX (existing)
 * - Base, Arbitrum, Optimism, Polygon (L2s)
 * - BSC, Sui, Aptos (alt L1s)
 */

export interface ChainMetrics {
  chain: string;
  chainId: number;
  tvl: number;
  tvlChange24h: number;
  tvlChange7d: number;
  gasPrice: number;           // In native token
  gasPriceUsd: number;        // In USD
  txCount24h: number;
  activeAddresses24h: number;
  bridgeVolume24h: number;
  dominantProtocol: string;
  dominantProtocolTvl: number;
}

export interface StablecoinFlows {
  totalSupply: number;
  supplyChange24h: number;
  supplyChange7d: number;

  // Per stablecoin
  usdt: { supply: number; change24h: number };
  usdc: { supply: number; change24h: number };
  dai: { supply: number; change24h: number };

  // Chain distribution
  chainDistribution: Record<string, number>;

  // Signals
  minting: boolean;           // Net minting > $100M
  burning: boolean;           // Net burning > $100M
  flowToExchanges: number;    // Positive = to exchanges
}

export interface GasTracker {
  chains: Record<string, {
    fast: number;
    standard: number;
    slow: number;
    baseFee?: number;
    priorityFee?: number;
    usdCost: number;          // Cost in USD for standard tx
  }>;
  cheapestChain: string;
  mostExpensiveChain: string;
  avgCost: number;
}

export interface MultiChainData {
  chains: ChainMetrics[];
  stablecoins: StablecoinFlows;
  gas: GasTracker;

  // Cross-chain signals
  signals: {
    l2Migration: boolean;         // TVL flowing to L2s
    chainRotation: string | null; // Which chain is gaining
    gasSpike: string | null;      // Chain with unusual gas
    bridgeActivity: boolean;      // High bridge volume
  };

  timestamp: number;
}

const SUPPORTED_CHAINS = [
  { name: 'ethereum', id: 1, llamaId: 'Ethereum', native: 'ETH' },
  { name: 'arbitrum', id: 42161, llamaId: 'Arbitrum', native: 'ETH' },
  { name: 'optimism', id: 10, llamaId: 'Optimism', native: 'ETH' },
  { name: 'base', id: 8453, llamaId: 'Base', native: 'ETH' },
  { name: 'polygon', id: 137, llamaId: 'Polygon', native: 'MATIC' },
  { name: 'bsc', id: 56, llamaId: 'BSC', native: 'BNB' },
  { name: 'avalanche', id: 43114, llamaId: 'Avalanche', native: 'AVAX' },
  { name: 'solana', id: 101, llamaId: 'Solana', native: 'SOL' },
];

let cachedMultiChain: MultiChainData | null = null;
let lastMultiChainFetch = 0;
const CACHE_TTL = 300000; // 5 minutes

/**
 * Fetch TVL data from DeFiLlama for all chains
 */
async function fetchAllChainsTVL(): Promise<ChainMetrics[]> {
  const metrics: ChainMetrics[] = [];

  try {
    // Fetch all chains TVL
    const res = await fetch('https://api.llama.fi/v2/chains');
    const data = await res.json();

    for (const chain of SUPPORTED_CHAINS) {
      const chainData = data.find((d: any) =>
        d.name.toLowerCase() === chain.llamaId.toLowerCase() ||
        d.gecko_id === chain.name
      );

      if (chainData) {
        metrics.push({
          chain: chain.name,
          chainId: chain.id,
          tvl: chainData.tvl || 0,
          tvlChange24h: 0, // Would need historical
          tvlChange7d: 0,
          gasPrice: 0,
          gasPriceUsd: 0,
          txCount24h: 0,
          activeAddresses24h: 0,
          bridgeVolume24h: 0,
          dominantProtocol: '',
          dominantProtocolTvl: 0,
        });
      }
    }
  } catch (e) {
    console.error('[multiChain] Failed to fetch TVL:', e);
  }

  return metrics;
}

/**
 * Fetch gas prices for EVM chains
 */
async function fetchGasPrices(): Promise<GasTracker> {
  const chains: GasTracker['chains'] = {};

  // Ethereum gas from Etherscan
  try {
    const ethRes = await fetch('https://api.etherscan.io/api?module=gastracker&action=gasoracle');
    const ethData = await ethRes.json();
    if (ethData.result) {
      chains['ethereum'] = {
        fast: parseFloat(ethData.result.FastGasPrice) || 0,
        standard: parseFloat(ethData.result.ProposeGasPrice) || 0,
        slow: parseFloat(ethData.result.SafeGasPrice) || 0,
        baseFee: parseFloat(ethData.result.suggestBaseFee) || 0,
        usdCost: 0, // Would calculate based on ETH price
      };
    }
  } catch {}

  // L2 gas estimates (simplified)
  chains['arbitrum'] = { fast: 0.1, standard: 0.1, slow: 0.1, usdCost: 0.05 };
  chains['optimism'] = { fast: 0.001, standard: 0.001, slow: 0.001, usdCost: 0.02 };
  chains['base'] = { fast: 0.001, standard: 0.001, slow: 0.001, usdCost: 0.01 };
  chains['polygon'] = { fast: 100, standard: 50, slow: 30, usdCost: 0.01 };
  chains['bsc'] = { fast: 5, standard: 3, slow: 1, usdCost: 0.10 };

  // Find cheapest/most expensive
  const chainCosts = Object.entries(chains).map(([name, data]) => ({ name, cost: data.usdCost }));
  chainCosts.sort((a, b) => a.cost - b.cost);

  return {
    chains,
    cheapestChain: chainCosts[0]?.name || 'base',
    mostExpensiveChain: chainCosts[chainCosts.length - 1]?.name || 'ethereum',
    avgCost: chainCosts.reduce((sum, c) => sum + c.cost, 0) / chainCosts.length,
  };
}

/**
 * Fetch stablecoin data from DeFiLlama
 */
async function fetchStablecoinData(): Promise<StablecoinFlows> {
  try {
    const res = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    const data = await res.json();

    let totalSupply = 0;
    let usdtSupply = 0, usdcSupply = 0, daiSupply = 0;
    const chainDist: Record<string, number> = {};

    for (const stable of data.peggedAssets || []) {
      const supply = stable.circulating?.peggedUSD || 0;
      totalSupply += supply;

      if (stable.symbol === 'USDT') usdtSupply = supply;
      if (stable.symbol === 'USDC') usdcSupply = supply;
      if (stable.symbol === 'DAI') daiSupply = supply;

      // Aggregate by chain
      for (const [chain, amount] of Object.entries(stable.chainCirculating || {})) {
        const chainAmount = (amount as any)?.peggedUSD || 0;
        chainDist[chain] = (chainDist[chain] || 0) + chainAmount;
      }
    }

    return {
      totalSupply,
      supplyChange24h: 0,
      supplyChange7d: 0,
      usdt: { supply: usdtSupply, change24h: 0 },
      usdc: { supply: usdcSupply, change24h: 0 },
      dai: { supply: daiSupply, change24h: 0 },
      chainDistribution: chainDist,
      minting: false,
      burning: false,
      flowToExchanges: 0,
    };
  } catch (e) {
    return {
      totalSupply: 0,
      supplyChange24h: 0,
      supplyChange7d: 0,
      usdt: { supply: 0, change24h: 0 },
      usdc: { supply: 0, change24h: 0 },
      dai: { supply: 0, change24h: 0 },
      chainDistribution: {},
      minting: false,
      burning: false,
      flowToExchanges: 0,
    };
  }
}

/**
 * Main multi-chain data fetch
 */
export async function fetchMultiChainData(): Promise<MultiChainData> {
  if (cachedMultiChain && Date.now() - lastMultiChainFetch < CACHE_TTL) {
    return cachedMultiChain;
  }

  const [chains, gas, stablecoins] = await Promise.all([
    fetchAllChainsTVL(),
    fetchGasPrices(),
    fetchStablecoinData(),
  ]);

  // Calculate L2 vs L1 TVL
  const l2Chains = ['arbitrum', 'optimism', 'base', 'polygon'];
  const l2Tvl = chains.filter(c => l2Chains.includes(c.chain)).reduce((sum, c) => sum + c.tvl, 0);
  const ethTvl = chains.find(c => c.chain === 'ethereum')?.tvl || 0;
  const l2Ratio = ethTvl > 0 ? l2Tvl / ethTvl : 0;

  // Find chain gaining most TVL
  const sortedByTvl = [...chains].sort((a, b) => b.tvlChange24h - a.tvlChange24h);
  const gainingChain = sortedByTvl[0]?.tvlChange24h > 2 ? sortedByTvl[0].chain : null;

  // Check for gas spikes
  const ethGas = gas.chains['ethereum']?.standard || 0;
  const gasSpike = ethGas > 50 ? 'ethereum' : null;

  cachedMultiChain = {
    chains,
    stablecoins,
    gas,
    signals: {
      l2Migration: l2Ratio > 0.3, // L2s have 30%+ of ETH TVL
      chainRotation: gainingChain,
      gasSpike,
      bridgeActivity: false,
    },
    timestamp: Date.now(),
  };
  lastMultiChainFetch = Date.now();

  return cachedMultiChain;
}

export function getMultiChainSummary(data: MultiChainData): string {
  const topChains = [...data.chains].sort((a, b) => b.tvl - a.tvl).slice(0, 5);
  const lines = [
    'Top Chains by TVL:',
    ...topChains.map(c => `  ${c.chain}: $${(c.tvl / 1e9).toFixed(1)}B`),
    '',
    `Stablecoin Supply: $${(data.stablecoins.totalSupply / 1e9).toFixed(1)}B`,
    `Cheapest Gas: ${data.gas.cheapestChain}`,
  ];

  if (data.signals.l2Migration) lines.push('L2 MIGRATION IN PROGRESS');
  if (data.signals.gasSpike) lines.push(`GAS SPIKE ON ${data.signals.gasSpike.toUpperCase()}`);

  return lines.join('\n');
}
