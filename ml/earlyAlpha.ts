/**
 * Early Alpha Detection Module
 *
 * Detects potential 100x opportunities by monitoring:
 * 1. New token deployments
 * 2. DEX liquidity additions
 * 3. Smart money wallet activity
 * 4. Social signals (Twitter, Discord, Telegram)
 */

import { ethers } from 'ethers';

// ============================================
// TYPES
// ============================================

export interface NewToken {
  address: string;
  deployer: string;
  deployTx: string;
  blockNumber: number;
  timestamp: number;
  name?: string;
  symbol?: string;
  totalSupply?: string;
  // Scoring
  score: number;
  signals: string[];
}

export interface LiquidityEvent {
  pairAddress: string;
  token0: string;
  token1: string;
  dex: 'uniswap_v2' | 'uniswap_v3' | 'sushiswap';
  liquidityUSD: number;
  timestamp: number;
  creator: string;
  isNewPair: boolean;
}

export interface SmartMoneyWallet {
  address: string;
  label: string;
  winRate: number;
  avgReturn: number;
  recentTrades: SmartMoneyTrade[];
  lastActive: number;
}

export interface SmartMoneyTrade {
  wallet: string;
  token: string;
  action: 'buy' | 'sell';
  amountUSD: number;
  timestamp: number;
  txHash: string;
}

export interface SocialSignal {
  source: 'twitter' | 'discord' | 'telegram' | 'reddit';
  token?: string;
  mentions: number;
  sentiment: number; // -1 to 1
  velocity: number; // rate of increase
  timestamp: number;
  samplePosts: string[];
}

export interface EarlyAlphaSignal {
  token: string;
  name?: string;
  symbol?: string;
  score: number; // 0-100
  confidence: number;
  signals: {
    deployment: NewToken | null;
    liquidity: LiquidityEvent[];
    smartMoney: SmartMoneyTrade[];
    social: SocialSignal[];
  };
  reasoning: string[];
  risk: 'low' | 'medium' | 'high' | 'extreme';
  timestamp: number;
}

// ============================================
// CONFIGURATION
// ============================================

// Known smart money wallets (these are example addresses - you'd want real ones)
const SMART_MONEY_WALLETS: SmartMoneyWallet[] = [
  {
    address: '0x9531C059098e3d194fF87FebB587aB07B30B1306', // Example whale
    label: 'Top Trader 1',
    winRate: 0.72,
    avgReturn: 3.2,
    recentTrades: [],
    lastActive: 0,
  },
  {
    address: '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance hot wallet
    label: 'Binance',
    winRate: 0.65,
    avgReturn: 1.5,
    recentTrades: [],
    lastActive: 0,
  },
];

// DEX Factory addresses
const DEX_FACTORIES = {
  uniswap_v2: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  uniswap_v3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  sushiswap: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
};

// Common scam patterns
const SCAM_INDICATORS = [
  'honeypot',
  'cant_sell',
  'high_tax',
  'hidden_mint',
  'blacklist',
  'proxy_upgradeable',
];

// ERC20 ABI for token info
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

// Uniswap V2 Factory ABI
const UNISWAP_V2_FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
];

// ============================================
// STATE
// ============================================

let provider: ethers.JsonRpcProvider | null = null;
let isWatching = false;
let newTokens: NewToken[] = [];
let liquidityEvents: LiquidityEvent[] = [];
let smartMoneyTrades: SmartMoneyTrade[] = [];
let socialSignals: SocialSignal[] = [];
let earlyAlphaSignals: EarlyAlphaSignal[] = [];

// ============================================
// INITIALIZATION
// ============================================

export function initEarlyAlpha(rpcUrl?: string) {
  const url = rpcUrl || process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
  provider = new ethers.JsonRpcProvider(url);
  console.log('[early-alpha] Initialized with RPC:', url.slice(0, 30) + '...');
  return provider;
}

// ============================================
// 1. NEW TOKEN DEPLOYMENT MONITOR
// ============================================

export async function scanRecentDeployments(blocks: number = 100): Promise<NewToken[]> {
  if (!provider) initEarlyAlpha();

  const latestBlock = await provider!.getBlockNumber();
  const tokens: NewToken[] = [];

  console.log(`[early-alpha] Scanning blocks ${latestBlock - blocks} to ${latestBlock} for new tokens...`);

  for (let i = latestBlock - blocks; i <= latestBlock; i++) {
    try {
      const block = await provider!.getBlock(i, true);
      if (!block || !block.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        // Contract creation = tx.to is null
        if (tx.to === null && tx.data && tx.data.length > 100) {
          const receipt = await provider!.getTransactionReceipt(tx.hash);
          if (receipt && receipt.contractAddress) {
            const token = await analyzeDeployedContract(
              receipt.contractAddress,
              tx.from,
              tx.hash,
              i,
              block.timestamp
            );
            if (token) {
              tokens.push(token);
            }
          }
        }
      }
    } catch (e) {
      // Skip blocks that fail
    }
  }

  // Update cache
  newTokens = [...tokens, ...newTokens].slice(0, 1000);

  console.log(`[early-alpha] Found ${tokens.length} new potential tokens`);
  return tokens;
}

async function analyzeDeployedContract(
  address: string,
  deployer: string,
  txHash: string,
  blockNumber: number,
  timestamp: number
): Promise<NewToken | null> {
  if (!provider) return null;

  try {
    const contract = new ethers.Contract(address, ERC20_ABI, provider);

    // Try to get token info - if these fail, it's not an ERC20
    const [name, symbol, totalSupply] = await Promise.all([
      contract.name().catch(() => null),
      contract.symbol().catch(() => null),
      contract.totalSupply().catch(() => null),
    ]);

    // Must have name and symbol to be a token
    if (!name || !symbol) return null;

    // Score the token
    const { score, signals } = await scoreNewToken(address, deployer, name, symbol);

    return {
      address,
      deployer,
      deployTx: txHash,
      blockNumber,
      timestamp,
      name,
      symbol,
      totalSupply: totalSupply?.toString(),
      score,
      signals,
    };
  } catch {
    return null;
  }
}

async function scoreNewToken(
  address: string,
  deployer: string,
  name: string,
  symbol: string
): Promise<{ score: number; signals: string[] }> {
  let score = 30; // Start lower, earn points
  const signals: string[] = [];

  const lowerName = name.toLowerCase();
  const lowerSymbol = symbol.toLowerCase();

  // ============ NEGATIVE SIGNALS ============

  // Meme/scam name patterns
  const scamPatterns = ['elon', 'trump', 'pepe', 'doge', 'shib', 'moon', 'safe', 'baby', 'inu', 'floki'];
  const hasScamPattern = scamPatterns.some(p => lowerName.includes(p) || lowerSymbol.includes(p));
  if (hasScamPattern) {
    score -= 15;
    signals.push('Meme/hype name pattern (-15)');
  }

  // Unusual symbol length
  if (lowerSymbol.length > 10) {
    score -= 10;
    signals.push('Long symbol (-10)');
  } else if (lowerSymbol.length < 2) {
    score -= 5;
    signals.push('Very short symbol (-5)');
  }

  // Numbers in name (often scams)
  if (/\d/.test(name)) {
    score -= 5;
    signals.push('Numbers in name (-5)');
  }

  // All caps name (often low effort)
  if (name === name.toUpperCase() && name.length > 3) {
    score -= 3;
    signals.push('All caps name (-3)');
  }

  // ============ POSITIVE SIGNALS ============

  // Clean professional name (no special chars, reasonable length)
  if (/^[A-Za-z\s]+$/.test(name) && name.length >= 3 && name.length <= 30) {
    score += 10;
    signals.push('Clean name format (+10)');
  }

  // Standard symbol format (3-5 uppercase letters)
  if (/^[A-Z]{3,5}$/.test(symbol)) {
    score += 10;
    signals.push('Standard symbol format (+10)');
  }

  // Check if deployer has deployed other tokens (simplified check via nonce)
  try {
    if (provider) {
      const nonce = await provider.getTransactionCount(deployer);
      if (nonce > 100) {
        score += 15;
        signals.push(`Active deployer (${nonce} txs) (+15)`);
      } else if (nonce > 20) {
        score += 10;
        signals.push(`Moderate deployer (${nonce} txs) (+10)`);
      } else if (nonce < 5) {
        score -= 10;
        signals.push(`New deployer (${nonce} txs) (-10)`);
      }
    }
  } catch {}

  // Check contract code size (larger = more complex = potentially more legitimate)
  try {
    if (provider) {
      const code = await provider.getCode(address);
      const codeSize = (code.length - 2) / 2; // Remove 0x and divide by 2 for bytes
      if (codeSize > 10000) {
        score += 15;
        signals.push(`Large contract (${Math.round(codeSize/1000)}kb) (+15)`);
      } else if (codeSize > 5000) {
        score += 10;
        signals.push(`Medium contract (${Math.round(codeSize/1000)}kb) (+10)`);
      } else if (codeSize < 1000) {
        score -= 5;
        signals.push(`Small contract (${Math.round(codeSize/1000)}kb) (-5)`);
      }
    }
  } catch {}

  // Check if already has liquidity pairs
  const hasLiquidity = liquidityEvents.some(
    e => e.token0.toLowerCase() === address.toLowerCase() ||
         e.token1.toLowerCase() === address.toLowerCase()
  );
  if (hasLiquidity) {
    score += 20;
    signals.push('Has liquidity (+20)');
  }

  // Check smart money interest
  const smartMoneyBuys = smartMoneyTrades.filter(
    t => t.token.toLowerCase() === address.toLowerCase() && t.action === 'buy'
  );
  if (smartMoneyBuys.length > 0) {
    score += smartMoneyBuys.length * 15;
    signals.push(`Smart money interest (${smartMoneyBuys.length} buys) (+${smartMoneyBuys.length * 15})`);
  }

  signals.push(`Deployer: ${deployer.slice(0, 10)}...`);

  return { score: Math.max(0, Math.min(100, score)), signals };
}

// ============================================
// 2. DEX LIQUIDITY TRACKING
// ============================================

export async function scanNewPairs(blocks: number = 100): Promise<LiquidityEvent[]> {
  if (!provider) initEarlyAlpha();

  const events: LiquidityEvent[] = [];
  const latestBlock = await provider!.getBlockNumber();

  console.log(`[early-alpha] Scanning for new DEX pairs...`);

  // Scan Uniswap V2 PairCreated events
  const v2Factory = new ethers.Contract(
    DEX_FACTORIES.uniswap_v2,
    UNISWAP_V2_FACTORY_ABI,
    provider
  );

  try {
    const filter = v2Factory.filters.PairCreated();
    const logs = await v2Factory.queryFilter(filter, latestBlock - blocks, latestBlock);

    for (const log of logs) {
      const event = log as ethers.EventLog;
      if (event.args) {
        events.push({
          pairAddress: event.args[2], // pair address
          token0: event.args[0],
          token1: event.args[1],
          dex: 'uniswap_v2',
          liquidityUSD: 0, // Would need to fetch from pair
          timestamp: Date.now(),
          creator: '', // Would need to get from tx
          isNewPair: true,
        });
      }
    }
  } catch (e) {
    console.warn('[early-alpha] Failed to scan Uniswap V2:', e);
  }

  // Update cache
  liquidityEvents = [...events, ...liquidityEvents].slice(0, 1000);

  console.log(`[early-alpha] Found ${events.length} new pairs`);
  return events;
}

// ============================================
// 3. SMART MONEY TRACKING
// ============================================

export async function trackSmartMoney(): Promise<SmartMoneyTrade[]> {
  if (!provider) initEarlyAlpha();

  const trades: SmartMoneyTrade[] = [];
  const latestBlock = await provider!.getBlockNumber();

  console.log(`[early-alpha] Tracking smart money wallets...`);

  for (const wallet of SMART_MONEY_WALLETS) {
    try {
      // Check transaction count to see if wallet is active
      // Note: For full tracking, use Etherscan API or index Transfer events
      const txCount = await provider!.getTransactionCount(wallet.address);

      // For now, just mark as active if they have transactions
      if (txCount > 0) {
        wallet.lastActive = Date.now();
      }
    } catch (e) {
      // Skip failed wallets
    }
  }

  // Update cache
  smartMoneyTrades = [...trades, ...smartMoneyTrades].slice(0, 1000);

  return trades;
}

export function addSmartMoneyWallet(address: string, label: string) {
  SMART_MONEY_WALLETS.push({
    address,
    label,
    winRate: 0.5,
    avgReturn: 0,
    recentTrades: [],
    lastActive: 0,
  });
  console.log(`[early-alpha] Added smart money wallet: ${label} (${address.slice(0, 10)}...)`);
}

export function getSmartMoneyWallets(): SmartMoneyWallet[] {
  return SMART_MONEY_WALLETS;
}

// ============================================
// 4. SOCIAL SIGNAL AGGREGATION
// ============================================

// This would integrate with Twitter API, Discord bots, etc.
// For now, we'll create the structure and allow manual updates

export function addSocialSignal(signal: Omit<SocialSignal, 'timestamp'>) {
  socialSignals.push({
    ...signal,
    timestamp: Date.now(),
  });
  socialSignals = socialSignals.slice(-1000);
}

export async function fetchTwitterMentions(token: string): Promise<SocialSignal | null> {
  // This would use Twitter API v2
  // Requires: TWITTER_BEARER_TOKEN env var

  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) {
    console.warn('[early-alpha] Twitter API not configured');
    return null;
  }

  try {
    const response = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(token)}&max_results=100`,
      {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
        },
      }
    );

    if (!response.ok) {
      console.warn('[early-alpha] Twitter API error:', response.status);
      return null;
    }

    const data = await response.json();
    const tweets = data.data || [];

    // Simple sentiment analysis (would use LLM for better results)
    let sentiment = 0;
    for (const tweet of tweets) {
      const text = tweet.text.toLowerCase();
      if (text.includes('moon') || text.includes('gem') || text.includes('bullish')) {
        sentiment += 0.1;
      }
      if (text.includes('scam') || text.includes('rug') || text.includes('dump')) {
        sentiment -= 0.1;
      }
    }
    sentiment = Math.max(-1, Math.min(1, sentiment));

    return {
      source: 'twitter',
      token,
      mentions: tweets.length,
      sentiment,
      velocity: 0, // Would need historical data
      timestamp: Date.now(),
      samplePosts: tweets.slice(0, 5).map((t: any) => t.text),
    };
  } catch (e) {
    console.warn('[early-alpha] Twitter fetch failed:', e);
    return null;
  }
}

// ============================================
// 5. UNIFIED EARLY ALPHA SCORING
// ============================================

export async function computeEarlyAlphaScore(tokenAddress: string): Promise<EarlyAlphaSignal | null> {
  if (!provider) initEarlyAlpha();

  const reasoning: string[] = [];
  let score = 0;

  // Find deployment info
  const deployment = newTokens.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase()) || null;
  if (deployment) {
    score += deployment.score * 0.3;
    reasoning.push(`Deployment score: ${deployment.score}`);
  }

  // Find liquidity events
  const liquidity = liquidityEvents.filter(
    e => e.token0.toLowerCase() === tokenAddress.toLowerCase() ||
         e.token1.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (liquidity.length > 0) {
    score += 20;
    reasoning.push(`Found ${liquidity.length} liquidity events`);
  }

  // Find smart money activity
  const smartMoney = smartMoneyTrades.filter(
    t => t.token.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (smartMoney.length > 0) {
    const buys = smartMoney.filter(t => t.action === 'buy');
    if (buys.length > 0) {
      score += buys.length * 15;
      reasoning.push(`${buys.length} smart money buys detected`);
    }
  }

  // Find social signals
  const social = socialSignals.filter(
    s => s.token?.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (social.length > 0) {
    const avgSentiment = social.reduce((sum, s) => sum + s.sentiment, 0) / social.length;
    score += avgSentiment * 20;
    reasoning.push(`Social sentiment: ${(avgSentiment * 100).toFixed(0)}%`);
  }

  // Determine risk level
  let risk: 'low' | 'medium' | 'high' | 'extreme' = 'medium';
  if (score < 20) risk = 'extreme';
  else if (score < 40) risk = 'high';
  else if (score < 60) risk = 'medium';
  else risk = 'low';

  // Get token info
  let name: string | undefined;
  let symbol: string | undefined;
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    name = await contract.name().catch(() => undefined);
    symbol = await contract.symbol().catch(() => undefined);
  } catch {}

  const signal: EarlyAlphaSignal = {
    token: tokenAddress,
    name,
    symbol,
    score: Math.min(100, Math.max(0, score)),
    confidence: Math.min(1, score / 100),
    signals: {
      deployment,
      liquidity,
      smartMoney,
      social,
    },
    reasoning,
    risk,
    timestamp: Date.now(),
  };

  // Cache it
  earlyAlphaSignals = [signal, ...earlyAlphaSignals.filter(s => s.token !== tokenAddress)].slice(0, 100);

  return signal;
}

// ============================================
// 6. GETTERS
// ============================================

export function getNewTokens(limit: number = 50): NewToken[] {
  return newTokens.slice(0, limit);
}

export function getLiquidityEvents(limit: number = 50): LiquidityEvent[] {
  return liquidityEvents.slice(0, limit);
}

export function getSmartMoneyTrades(limit: number = 50): SmartMoneyTrade[] {
  return smartMoneyTrades.slice(0, limit);
}

export function getSocialSignals(limit: number = 50): SocialSignal[] {
  return socialSignals.slice(0, limit);
}

export function getEarlyAlphaSignals(limit: number = 20): EarlyAlphaSignal[] {
  return earlyAlphaSignals.slice(0, limit);
}

// ============================================
// 7. BACKGROUND SCANNER
// ============================================

let scanInterval: NodeJS.Timeout | null = null;

export function startEarlyAlphaScanner(intervalMs: number = 60000) {
  if (scanInterval) return;

  console.log('[early-alpha] Starting background scanner...');
  isWatching = true;

  // Initial scan
  runScan();

  // Periodic scan
  scanInterval = setInterval(runScan, intervalMs);
}

export function stopEarlyAlphaScanner() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  isWatching = false;
  console.log('[early-alpha] Scanner stopped');
}

async function runScan() {
  try {
    console.log('[early-alpha] Running scan...');

    // Scan for new tokens (last 50 blocks)
    await scanRecentDeployments(50);

    // Scan for new pairs
    await scanNewPairs(50);

    // Track smart money
    await trackSmartMoney();

    console.log(`[early-alpha] Scan complete: ${newTokens.length} tokens, ${liquidityEvents.length} pairs`);
  } catch (e) {
    console.error('[early-alpha] Scan error:', e);
  }
}

export function isScanning(): boolean {
  return isWatching;
}
