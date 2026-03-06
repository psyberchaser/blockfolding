import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

// Set DATA_DIR before importing modules that depend on it
const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'artifacts');
process.env.DATA_DIR = DEFAULT_DATA_DIR;

import cors from 'cors';
import express from 'express';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { computeAnomalyScore } from '../shared/dashboard-lib/anomaly.js';
import { loadAtlasGraph, filterAtlas } from '../shared/dashboard-lib/atlas.js';
import {
  getBlockSummary,
  getLatestBlockSummary,
  getTagStats,
  listRecentBlockSummaries,
  listSources,
  searchBlockSummaries,
  StoredBlockSummary,
} from '../shared/dashboard-lib/blocks.js';
import { getChainMetadata } from '../shared/dashboard-lib/chains.js';
import { readLatestMempoolSnapshots } from '../shared/dashboard-lib/mempool.js';
import { queryPQResidualHistogram } from '../shared/dashboard-lib/pqMetrics.js';
import { queryTimeseries } from '../shared/dashboard-lib/metrics.js';
import { readLatestPredictions } from '../shared/dashboard-lib/predictions.js';
import { summarizeBehaviorRegime } from '../shared/dashboard-lib/regime.js';
import { findLendingTransactions } from '../shared/dashboard-lib/tagEvidence.js';
import { aggregateDerivedSignals, computeEntropy, type AllDerivedSignals } from '../ml/derivedSignals.js';
import { fetchAllExternalSignals, type AllExternalSignals } from '../ml/externalSignals.js';
import {
  loadPredictionState,
  generateUnifiedPrediction,
  predictBlockFromMempool,
  assessCascadeRisk,
  findSimilarPatterns,
  addToPatternLibrary,
  recordPrediction,
  recordOutcome,
  getPredictionStats,
  getPatternPerformance,
  type SignalSnapshot,
  type UnifiedPrediction,
} from '../ml/predictiveEngine.js';
import {
  initEarlyAlpha,
  startEarlyAlphaScanner,
  stopEarlyAlphaScanner,
  isScanning,
  scanRecentDeployments,
  scanNewPairs,
  trackSmartMoney,
  getNewTokens,
  getLiquidityEvents,
  getSmartMoneyTrades,
  getSmartMoneyWallets,
  addSmartMoneyWallet,
  getSocialSignals,
  addSocialSignal,
  getEarlyAlphaSignals,
  computeEarlyAlphaScore,
  fetchTwitterMentions,
} from '../ml/earlyAlpha.js';
import {
  chat,
  quickQuery,
  analyzeToken,
  isConfigured as isChatConfigured,
  type ChatMessage,
} from '../ml/chatInterface.js';
import {
  fetchLiquidationData,
  getLiquidationLevelsForCascade,
  calculateCascadeProbability,
} from '../ml/liquidationData.js';
import {
  registerPredictionForTracking,
  checkPendingOutcomes,
  getOutcomeStats,
  startOutcomeTracker,
  fetchCurrentPrice,
} from '../ml/outcomeTracker.js';
import {
  runBacktest,
  getBacktestSummary,
  fetchHistoricalPrices,
} from '../ml/backtesting.js';
import {
  discoverPatterns,
  matchFingerprint,
  getPatternPrediction,
  updatePatternsWithOutcome,
  discoveredPatterns,
} from '../ml/patternDiscovery.js';
import {
  generateMultiTimeframePrediction,
  calculateKellyPosition,
  getMultiTimeframeAction,
  updateTimeframeStats,
  timeframeStats,
  type Timeframe,
} from '../ml/multiTimeframe.js';
import { ethers } from 'ethers';
import {
  extractEightDimFeatures,
  generatePatternSignature,
  generateMetaBlocks,
  buildPatternIndex,
  validateTransaction,
  validateBatch,
  getIndexStatistics,
  ValidatorNetwork,
  classifyDeviceTier,
  createValidationRequest,
  DEVICE_PROFILES,
  type BlockFeatureInput,
  type FullBlockInput,
  type TransactionValidationInput,
  type MetaBlockIndex,
} from '../validator/index.js';
import { computeFoldedBlock } from '../folding/compute.js';
import { loadCodebookFromFile, createDeterministicCodebook } from '../folding/codebook.js';
import { detectHotzones } from '../analytics/hotzones.js';
import { buildHypergraph } from '../analytics/hypergraph.js';
import { deriveRawBlockTags } from '../analytics/tags.js';
import { computeBehaviorMetrics } from '../analytics/blockMetrics.js';
import type { RawBlock, PQCodebook } from '../folding/types.js';
import { toQuantity } from 'ethers';

// Initialize predictive engine
loadPredictionState();

// Start outcome tracker for automatic prediction tracking
startOutcomeTracker(60000); // Check every minute

// Lazy-loaded codebook for real benchmark pipeline
let _benchmarkCodebook: PQCodebook | null = null;
function getBenchmarkCodebook(): PQCodebook {
  if (_benchmarkCodebook) return _benchmarkCodebook;
  const codebookPath = process.env.CODEBOOK_PATH ?? path.resolve(DEFAULT_DATA_DIR, 'codebooks', 'latest.json');
  if (existsSync(codebookPath)) {
    _benchmarkCodebook = loadCodebookFromFile(codebookPath);
  } else {
    _benchmarkCodebook = createDeterministicCodebook({ numSubspaces: 4, subvectorDim: 4, numCentroids: 64, seed: 'pipeline-demo' });
  }
  return _benchmarkCodebook;
}

// RPC endpoints for benchmark (public, no auth needed)
const BENCHMARK_RPCS: Record<string, { kind: 'evm' | 'solana'; urls: string[] }> = {
  eth: { kind: 'evm', urls: [process.env.ETH_RPC_URL, 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://eth-mainnet.public.blastapi.io'].filter(Boolean) as string[] },
  avax: { kind: 'evm', urls: [process.env.AVAX_RPC_URL, 'https://avalanche.public-rpc.com', 'https://rpc.ankr.com/avalanche'].filter(Boolean) as string[] },
};

// Convert raw eth_getBlockByNumber JSON to RawBlock for benchmark pipeline
function ethRpcBlockToRawBlock(chainId: string, block: Record<string, any>): RawBlock {
  const parseQ = (v: any): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string' && v.startsWith('0x')) return parseInt(v, 16) || 0;
    return Number(v) || 0;
  };
  const txs: Record<string, unknown>[] = Array.isArray(block.transactions)
    ? block.transactions.map((tx: any) => {
        const gasUsed = parseQ(tx.gas ?? tx.gasUsed ?? 0);
        const gasPrice = parseQ(tx.gasPrice ?? 0);
        return {
          hash: tx.hash ?? '',
          amountWei: parseQ(tx.value ?? 0),
          amountEth: parseQ(tx.value ?? 0) / 1e18,
          fee: gasPrice * gasUsed,
          gasUsed,
          gasPrice,
          nonce: parseQ(tx.nonce ?? 0),
          status: 'success',
          chainId: parseQ(tx.chainId ?? 0),
          sender: tx.from ?? '',
          receiver: tx.to ?? '',
          contractType: tx.type ?? 'LEGACY',
          dataSize: typeof tx.input === 'string' ? Math.max(0, (tx.input.length - 2) / 2) : 0,
          functionSelector: typeof tx.input === 'string' && tx.input.length >= 10 ? tx.input.slice(0, 10) : '0x',
        };
      })
    : [];
  return {
    header: {
      height: parseQ(block.number),
      hash: block.hash ?? '',
      parentHash: block.parentHash ?? '',
      stateRoot: block.stateRoot ?? block.hash ?? '',
      txRoot: block.transactionsRoot ?? '',
      receiptsRoot: block.receiptsRoot ?? '',
      timestamp: parseQ(block.timestamp),
      headerRlp: block.hash ?? '',
    },
    transactions: txs,
    executionTraces: txs.map((tx: any, i: number) => ({
      balanceDelta: Number(tx.amountWei ?? 0),
      storageWrites: tx.dataSize ? Math.floor(tx.dataSize / 32) : 0,
      storageReads: tx.receiver ? 2 : 1,
      logEvents: tx.amountWei ? 1 : 0,
      contract: tx.receiver ?? '',
      asset: chainId.toUpperCase(),
      traceType: tx.contractType ?? 'LEGACY',
      gasConsumed: tx.gasUsed ?? 0,
      slotIndex: i,
      reverted: false,
    })),
    witnessData: {
      bundles: [{
        constraintCount: txs.length * 1000,
        degree: 2048,
        gateCount: txs.length * 500,
        quotientDegree: 4096,
        proverLabel: 'benchmark',
        circuitType: 'AGGREGATION',
      }],
    },
  };
}

// Trading configuration - use RELAYER_KEY from ghostprotocol or TRADING_PRIVATE_KEY
const TRADING_PRIVATE_KEY = process.env.RELAYER_KEY ?? process.env.TRADING_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL ?? 'https://sepolia.infura.io/v3/84842078b09946638c03157f83405213';

// Uniswap V3 on Sepolia
const UNISWAP_ROUTER = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E'; // SwapRouter02
const UNISWAP_QUOTER = '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3'; // Quoter V2

// Token addresses on Sepolia
// Token addresses - Sepolia testnet (switch to mainnet for production)
const TOKENS: Record<string, { address: string; decimals: number; name: string }> = {
  // Core tokens (Sepolia)
  WETH: { address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', decimals: 18, name: 'Wrapped ETH' },
  USDC: { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, name: 'USD Coin' },
  WBTC: { address: '0x29f2D40B0605204364af54EC677bD022dA425d03', decimals: 8, name: 'Wrapped BTC' },
  UNI: { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, name: 'Uniswap' },
  LINK: { address: '0x779877A7B0D9E8603169DdbD7836e478b4624789', decimals: 18, name: 'Chainlink' },
  // DeFi tokens (mainnet addresses - for production)
  // AAVE: { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, name: 'Aave' },
  // MKR: { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', decimals: 18, name: 'Maker' },
  // CRV: { address: '0xD533a949740bb3306d119CC777fa900bA034cd52', decimals: 18, name: 'Curve' },
  // L2 tokens (mainnet)
  // ARB: { address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', decimals: 18, name: 'Arbitrum' },
  // OP: { address: '0x4200000000000000000000000000000000000042', decimals: 18, name: 'Optimism' },
  // Meme coins (mainnet - high volatility)
  // PEPE: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18, name: 'Pepe' },
  // SHIB: { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18, name: 'Shiba Inu' },
  // FLOKI: { address: '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E', decimals: 9, name: 'Floki' },
};

// Uniswap ABIs
const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)',
  'function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];
const WETH_ABI = [
  ...ERC20_ABI,
  'function deposit() payable',
  'function withdraw(uint256 amount)',
];

// Portfolio configuration
const PORTFOLIO_CONFIG = {
  defaultSlippage: 0.5, // 0.5%
  poolFee: 3000, // 0.3% pool (3000 = 0.3%)
  minTradeUSD: 10, // Minimum $10 trade
  maxTradePercent: 25, // Max 25% of portfolio per trade
};

// Target allocations based on signal regime
type SignalRegime = 'risk_on' | 'risk_off' | 'btc_strength' | 'alt_rotation' | 'neutral';
const TARGET_ALLOCATIONS: Record<SignalRegime, Record<string, number>> = {
  risk_on: { ETH: 60, WBTC: 20, USDC: 20 },      // Bullish - heavy ETH
  risk_off: { ETH: 10, WBTC: 10, USDC: 80 },     // Bearish - mostly stable
  btc_strength: { ETH: 20, WBTC: 50, USDC: 30 }, // BTC dominance rising
  alt_rotation: { ETH: 40, WBTC: 15, UNI: 15, LINK: 10, USDC: 20 }, // Altcoin season
  neutral: { ETH: 35, WBTC: 15, USDC: 50 },      // Default balanced
};

// Server wallet for auto-trading (if private key is configured)
let serverWallet: ethers.Wallet | null = null;
let serverProvider: ethers.JsonRpcProvider | null = null;

if (TRADING_PRIVATE_KEY) {
  try {
    serverProvider = new ethers.JsonRpcProvider(RPC_URL);
    serverWallet = new ethers.Wallet(TRADING_PRIVATE_KEY, serverProvider);
    console.log('[trading] Server wallet configured:', serverWallet.address);
  } catch (e) {
    console.error('[trading] Failed to setup server wallet:', e);
  }
}

const HEARTBEAT_EVENT_MS = parseInt(process.env.SSE_HEARTBEAT_INTERVAL_MS ?? '5000', 10);
const HEARTBEAT_INTERVAL_MS = Number.isFinite(HEARTBEAT_EVENT_MS) ? HEARTBEAT_EVENT_MS : 5000;
const SPOTLIGHT_TAGS = [
  'NFT_ACTIVITY',
  'DEX_ACTIVITY',
  'HIGH_FEE',
  'LARGE_VALUE',
  'LENDING_ACTIVITY',
];

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()).filter(Boolean) ?? '*',
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use('/fonts', express.static(path.resolve(process.cwd(), 'public/fonts')));

// Serve validator UI static files in production
const uiDistPath = path.resolve(process.cwd(), 'validator-ui/dist');
if (existsSync(uiDistPath)) {
  app.use(express.static(uiDistPath));
}

// Redirect root to validator UI (or fallback SPA)
app.get('/', (_req, res) => {
  if (existsSync(path.join(uiDistPath, 'index.html'))) {
    res.sendFile(path.join(uiDistPath, 'index.html'));
  } else {
    res.redirect('/trading-bot');
  }
});

app.get('/healthz', (_req, res) => {
  const summary = getLatestBlockSummary();
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    latestBlock: summary
      ? {
          chain: summary.chain,
          height: summary.height,
          timestamp: summary.timestamp,
        }
      : null,
  });
});

app.get('/dashboard', (req, res) => {
  try {
    const tagFilter = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const data = loadDashboardData(tagFilter);
    res.json(data);
  } catch (error) {
    console.error('[api] dashboard error', error);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

app.get('/blocks/recent', (req, res) => {
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt((req.query.limit as string) ?? '12', 10) || 12),
  );
  const tagFilter = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  const chainFilter = typeof req.query.chain === 'string' ? req.query.chain : undefined;
  const blocks = listRecentBlockSummaries(limit, tagFilter, chainFilter);
  res.json({ blocks });
});

app.get('/blocks/:chain/:height', (req, res) => {
  const { chain } = req.params;
  const height = Number(req.params.height);
  if (!Number.isFinite(height)) {
    return res.status(400).json({ error: 'Invalid height parameter' });
  }
  const record = getBlockSummary(chain, height);
  if (!record) {
    return res.status(404).json({ error: 'Block not found' });
  }
  try {
    const payload = JSON.parse(readFileSync(record.summaryPath, 'utf-8'));
    const rawBlock = JSON.parse(readFileSync(record.blockPath, 'utf-8'));
    const hotzones = payload.hotzones ?? [];
    const pqResidualStats = payload.pqResidualStats;
    const tags = payload.semanticTags ?? record.tags ?? [];
    const anomaly = computeAnomalyScore({
      hotzones,
      pqResidualStats,
      tagVector: tags,
    });
    const regime = summarizeBehaviorRegime(hotzones);
    const chainMeta = getChainMetadata(record.chain);
    const lendingTransactions = findLendingTransactions(record.blockPath, 50);
    return res.json({
      record,
      payload,
      rawBlock,
      anomaly,
      regime,
      chainMeta,
      lendingTransactions,
    });
  } catch (error) {
    console.error('[api] block detail error', error);
    return res.status(500).json({ error: 'Failed to load block detail' });
  }
});

app.get('/mempool', (_req, res) => {
  try {
    const snapshots = readLatestMempoolSnapshots();
    const predictions = readLatestPredictions();
    res.json({ snapshots, predictions });
  } catch (error) {
    console.error('[api] mempool error', error);
    res.status(500).json({ error: 'Failed to load mempool data' });
  }
});

app.get('/atlas', (req, res) => {
  try {
    const graph = loadAtlasGraph();
    if (!graph) {
      return res.status(404).json({ error: 'Atlas not generated yet' });
    }
    const now = Date.now();
    const range = typeof req.query.range === 'string' ? req.query.range : '30d';
    const ranges: Record<string, number> = {
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
      '90d': 90 * 24 * 60 * 60 * 1000,
    };
    const from = now - (ranges[range] ?? ranges['30d']);
    const tagsParam = req.query.tags;
    const tags: string[] =
      typeof tagsParam === 'string'
        ? tagsParam
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0)
        : Array.isArray(tagsParam)
          ? tagsParam.map((value) => String(value))
          : [];
    const filtered = filterAtlas(graph, { from, to: now, tags });
    res.json({ graph: filtered, from, to: now });
  } catch (error) {
    console.error('[api] atlas error', error);
    res.status(500).json({ error: 'Failed to load atlas' });
  }
});

app.get('/artifacts/*', (req, res) => {
  const relativePath = (req.params as Record<string, string | undefined>)['0'];
  if (!relativePath) {
    return res.status(400).json({ error: 'Missing artifact path' });
  }
  const targetPath = path.resolve(DEFAULT_DATA_DIR, relativePath);
  if (!targetPath.startsWith(DEFAULT_DATA_DIR)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    return res.status(404).json({ error: 'Artifact not found' });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  createReadStream(targetPath).pipe(res);
});

app.get('/heartbeat', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = () => {
    const summary = getLatestBlockSummary();
    const payload = buildHeartbeatPayload(summary);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send();
  const interval = setInterval(send, HEARTBEAT_INTERVAL_MS);
  req.on('close', () => {
    clearInterval(interval);
  });
});

// Metrics endpoints
app.get('/metrics/pq', (req, res) => {
  try {
    const chain = typeof req.query.chain === 'string' ? req.query.chain : undefined;
    const from = typeof req.query.from === 'string' ? Number(req.query.from) : undefined;
    const to = typeof req.query.to === 'string' ? Number(req.query.to) : undefined;
    const result = queryPQResidualHistogram({ chain, from, to });
    res.json(result);
  } catch (error) {
    console.error('[api] metrics/pq error', error);
    res.status(500).json({ error: 'Failed to query PQ metrics' });
  }
});

app.get('/metrics/timeseries', (req, res) => {
  try {
    const chain = typeof req.query.chain === 'string' ? req.query.chain : undefined;
    const now = Math.floor(Date.now() / 1000);
    const from = typeof req.query.from === 'string' ? Number(req.query.from) : now - 7 * 24 * 60 * 60;
    const to = typeof req.query.to === 'string' ? Number(req.query.to) : now;
    const intervalParam = typeof req.query.interval === 'string' ? req.query.interval : 'hour';
    const interval = intervalParam === 'daily' ? 'day' : 'hour';
    const result = queryTimeseries({ 
      from, 
      to, 
      interval,
      chains: chain ? [chain] : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error('[api] metrics/timeseries error', error);
    res.status(500).json({ error: 'Failed to query timeseries' });
  }
});

// Search endpoint
app.get('/blocks/search', (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const results = searchBlockSummaries(query, limit);
    res.json({ results });
  } catch (error) {
    console.error('[api] search error', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Verify endpoint
app.post('/verify', (req, res) => {
  try {
    const { chain, height } = req.body;
    if (!chain || height === undefined) {
      return res.status(400).json({ error: 'Missing chain or height' });
    }
    const record = getBlockSummary(chain, Number(height));
    if (!record) {
      return res.status(404).json({ error: 'Block not found' });
    }
    // Read proof file
    const proofPath = record.proofPath;
    if (!existsSync(proofPath)) {
      return res.json({ 
        valid: false, 
        error: 'No proof file found',
        chain,
        height: Number(height),
      });
    }
    const proofData = JSON.parse(readFileSync(proofPath, 'utf-8'));
    // For now, return the proof data - actual ZK verification would go here
    return res.json({
      valid: true,
      chain,
      height: Number(height),
      proofHex: proofData.proofHex || '',
      publicInputs: proofData.publicInputs || {},
      message: 'Proof data retrieved (ZK verification skipped - prover not available)',
    });
  } catch (error) {
    console.error('[api] verify error', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

function loadDashboardData(tagFilter?: string) {
  const summary = getLatestBlockSummary();
  if (!summary) {
    return {
      summary: null,
      payload: null,
      recent: [],
      spotlights: [],
      chains: [],
      mempoolSnapshots: [],
      predictions: [],
    };
  }
  const payload = JSON.parse(readFileSync(summary.summaryPath, 'utf-8'));
  const recent = listRecentBlockSummaries(12, tagFilter);
  const spotlights = SPOTLIGHT_TAGS.map((tag) => getTagStats(tag));
  const chains = listSources();
  const mempoolSnapshots = readLatestMempoolSnapshots();
  const predictions = readLatestPredictions();
  return { summary, payload, recent, spotlights, chains, mempoolSnapshots, predictions };
}

function buildHeartbeatPayload(summary: StoredBlockSummary | null) {
  const mempool = readLatestMempoolSnapshots();
  const predictions = readLatestPredictions();

  // Try to get txCount from raw block file and compute anomalyScore from hotzones
  let txCount = 0;
  let anomalyScore = 0;
  if (summary) {
    try {
      const rawBlockPath = summary.blockPath;
      if (rawBlockPath && existsSync(rawBlockPath)) {
        const rawBlock = JSON.parse(readFileSync(rawBlockPath, 'utf-8'));
        txCount = rawBlock.transactions?.length ?? 0;
      }
      // Compute anomalyScore from hotzones (not stored in summary file)
      if (summary.hotzonesPath && existsSync(summary.hotzonesPath)) {
        const hotzonesData = JSON.parse(readFileSync(summary.hotzonesPath, 'utf-8'));
        // Hotzones file has structure { hotzones: [...], hypergraph: ... }
        const hotzones = hotzonesData.hotzones ?? hotzonesData;
        const result = computeAnomalyScore({ hotzones, tagVector: summary.tags ?? [] });
        anomalyScore = result.score;
      } else {
        // Fallback: compute from tags only
        const result = computeAnomalyScore({ tagVector: summary.tags ?? [] });
        anomalyScore = result.score;
      }
    } catch { /* ignore read errors */ }
  }

  return {
    status: summary ? 'ok' : 'empty',
    digest: summary ? `${summary.chain}-${summary.height}-${summary.blockHash}` : null,
    latestBlock: summary ? {
      chain: summary.chain,
      height: summary.height,
      timestamp: (summary.timestamp ?? 0) * 1000, // Convert seconds to milliseconds
      txCount,
      tags: summary.tags ?? [],
      anomalyScore,
    } : null,
    mempool,
    predictions,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADING BOT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

import {
  computeDriftVelocity,
  computeHotzoneDeparture,
  computeTagAcceleration,
  computeCrossChainCorrelation,
  aggregateSignals,
} from '../ml/signals.js';

import { readdirSync } from 'node:fs';

// Load fingerprints for signal computation
function loadTradingFingerprints(chain: string, count: number = 10): number[][] {
  const blocksDir = path.join(DEFAULT_DATA_DIR, 'blocks', chain);
  if (!existsSync(blocksDir)) return [];

  const dirs = readdirSync(blocksDir)
    .filter((d: string) => /^\d+$/.test(d))
    .map((d: string) => parseInt(d))
    .sort((a: number, b: number) => b - a)
    .slice(0, count);

  const fingerprints: number[][] = [];
  for (const blockNum of dirs) {
    const summaryPath = path.join(blocksDir, blockNum.toString(), 'summary.json');
    if (existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        const vectors = summary.vectors || summary.foldedBlock?.foldedVectors;
        if (vectors) {
          fingerprints.push(vectors.flat());
        }
      } catch (e) {
        // Skip
      }
    }
  }
  return fingerprints.reverse();
}

function loadTradingTags(chain: string, count: number = 10): Record<string, number>[] {
  const blocksDir = path.join(DEFAULT_DATA_DIR, 'blocks', chain);
  if (!existsSync(blocksDir)) return [];

  const dirs = readdirSync(blocksDir)
    .filter((d: string) => /^\d+$/.test(d))
    .map((d: string) => parseInt(d))
    .sort((a: number, b: number) => b - a)
    .slice(0, count);

  const tags: Record<string, number>[] = [];
  for (const blockNum of dirs) {
    const summaryPath = path.join(blocksDir, blockNum.toString(), 'summary.json');
    if (existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        const tagList = summary.tags || summary.rawTags || [];
        if (tagList.length > 0) {
          const tagCounts: Record<string, number> = {};
          for (const tag of tagList) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
          tags.push(tagCounts);
        }
      } catch (e) {
        // Skip
      }
    }
  }
  return tags.reverse();
}

function loadHotzoneCentroids(): number[][] {
  const atlasPath = path.join(DEFAULT_DATA_DIR, 'atlas', 'graph.json');
  if (!existsSync(atlasPath)) return [];
  try {
    const atlas = JSON.parse(readFileSync(atlasPath, 'utf-8'));
    if (atlas.clusters) {
      return atlas.clusters.map((c: any) => c.centroid).filter(Boolean);
    }
  } catch (e) {}
  return [];
}

// Fetch live market data
async function fetchLiveMarketData() {
  try {
    // Try enhanced market data and advanced signals
    const [{ fetchEnhancedMarketData }, { fetchAdvancedSignals }] = await Promise.all([
      import('../ml/marketData.js'),
      import('../ml/advancedSignals.js'),
    ]);

    const [enhanced, advanced] = await Promise.all([
      fetchEnhancedMarketData(),
      fetchAdvancedSignals(),
    ]);

    const ethPrice = enhanced.prices['ETH']?.price || 0;
    const solPrice = enhanced.prices['SOL']?.price || 0;
    const btcPrice = enhanced.prices['BTC']?.price || 0;

    // If prices are 0, CoinGecko failed - throw to trigger Pyth fallback
    if (ethPrice === 0 && btcPrice === 0) {
      throw new Error('CoinGecko returned no prices');
    }

    return {
      ethPrice,
      solPrice,
      btcPrice,
      fearGreedIndex: enhanced.market.fearGreedIndex,
      fearGreedLabel: enhanced.market.fearGreedZone.replace('_', ' '),
      bullishScore: enhanced.market.bullishScore,
      riskScore: enhanced.market.riskScore,
      volatility: enhanced.market.volatility24h,
      tvlChange: enhanced.market.tvlChange,
      volumeAnomaly: enhanced.signals.volumeAnomaly,
      tvlDivergence: enhanced.signals.tvlDivergence,
      momentumAlignment: enhanced.signals.momentumAlignment,
      ethMomentum: enhanced.market.ethMomentum,
      solMomentum: enhanced.market.solMomentum,
      altcoinSeason: enhanced.market.altcoinSeason,
      // Advanced signals
      btcFunding: advanced.funding.btcFunding,
      ethFunding: advanced.funding.ethFunding,
      fundingExtreme: advanced.funding.extremeLevel,
      leverageRisk: advanced.compositeSignals.leverageRisk,
      smartMoneyFlow: advanced.compositeSignals.smartMoneyFlow,
      retailFomo: advanced.compositeSignals.retailFomo,
      liquidations24h: advanced.liquidations.totalLiquidations24h,
      liquidationRatio: advanced.liquidations.liquidationRatio,
    };
  } catch (e) {
    // Fallback to basic Pyth data
    try {
      // Pyth price feed IDs: ETH, SOL, BTC
      const pythUrl = 'https://hermes.pyth.network/api/latest_price_feeds?ids[]=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace&ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d&ids[]=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
      const pythRes = await fetch(pythUrl);
      const pythData = await pythRes.json();

      let ethPrice = 0, solPrice = 0, btcPrice = 0;
      for (const feed of pythData) {
        const price = Number(feed.price.price) * Math.pow(10, feed.price.expo);
        if (feed.id.includes('ff61491a')) ethPrice = price;
        else if (feed.id.includes('ef0d8b6f')) solPrice = price;
        else if (feed.id.includes('e62df6c8')) btcPrice = price;
      }

      const fgRes = await fetch('https://api.alternative.me/fng/');
      const fgData = await fgRes.json();
      const fearGreedIndex = parseInt(fgData.data[0].value);
      const fearGreedLabel = fgData.data[0].value_classification;

      return {
        ethPrice, solPrice, btcPrice, fearGreedIndex, fearGreedLabel,
        bullishScore: 50, riskScore: 50, volatility: 0, tvlChange: 0,
        volumeAnomaly: false, tvlDivergence: false, momentumAlignment: false,
        ethMomentum: 0, solMomentum: 0, altcoinSeason: false,
        btcFunding: 0, ethFunding: 0, fundingExtreme: false,
        leverageRisk: 0, smartMoneyFlow: 0, retailFomo: 0,
        liquidations24h: 0, liquidationRatio: 1,
      };
    } catch {
      return {
        ethPrice: 0, solPrice: 0, btcPrice: 0, fearGreedIndex: 50, fearGreedLabel: 'Unknown',
        bullishScore: 50, riskScore: 50, volatility: 0, tvlChange: 0,
        volumeAnomaly: false, tvlDivergence: false, momentumAlignment: false,
        ethMomentum: 0, solMomentum: 0, altcoinSeason: false,
        btcFunding: 0, ethFunding: 0, fundingExtreme: false,
        leverageRisk: 0, smartMoneyFlow: 0, retailFomo: 0,
        liquidations24h: 0, liquidationRatio: 1,
      };
    }
  }
}

app.get('/trading-bot/signals', async (_req, res) => {
  try {
    const market = await fetchLiveMarketData();
    const ethFingerprints = loadTradingFingerprints('eth', 10);
    const solFingerprints = loadTradingFingerprints('sol', 10);
    const ethTags = loadTradingTags('eth', 10);
    const hotzones = loadHotzoneCentroids();

    if (ethFingerprints.length < 3) {
      return res.json({
        status: 'insufficient_data',
        message: 'Need at least 3 blocks for signal computation',
        blockCount: ethFingerprints.length,
      });
    }

    const current = ethFingerprints[ethFingerprints.length - 1];
    const previous = ethFingerprints[ethFingerprints.length - 2];
    const older = ethFingerprints[ethFingerprints.length - 3];

    const driftVelocity = computeDriftVelocity(current, previous, older);
    const hotzoneDeparture = computeHotzoneDeparture(current, hotzones);
    const tagAcceleration = computeTagAcceleration(ethTags);

    const crossChainCorrelations = [];
    if (solFingerprints.length >= 3) {
      crossChainCorrelations.push(
        computeCrossChainCorrelation(ethFingerprints, solFingerprints, 'eth', 'sol', 5)
      );
    }

    // Compute actual anomaly score from latest block
    const latestBlock = getLatestBlockSummary();
    let blockAnomalyScore = 0.1; // Only use as fallback
    if (latestBlock?.hotzonesPath && existsSync(latestBlock.hotzonesPath)) {
      try {
        const hotzonesData = JSON.parse(readFileSync(latestBlock.hotzonesPath, 'utf-8'));
        const blockHotzones = hotzonesData.hotzones ?? hotzonesData;
        const anomalyResult = computeAnomalyScore({ hotzones: blockHotzones, tagVector: latestBlock.tags ?? [] });
        blockAnomalyScore = anomalyResult.score;
      } catch { /* use fallback */ }
    }

    const signals = aggregateSignals(
      blockAnomalyScore,
      driftVelocity,
      hotzoneDeparture,
      tagAcceleration,
      crossChainCorrelations
    );

    // Evaluate ALL 12 strategies (always show current state)
    const strategies = [];
    const ethSolCorr = crossChainCorrelations.find(c => c.chain1 === 'eth' && c.chain2 === 'sol');
    const avgFunding = ((market.btcFunding || 0) + (market.ethFunding || 0)) / 2;

    // 1. Lead/Lag Arbitrage - cross-chain signal propagation
    const leadLagActive = ethSolCorr && Math.abs(ethSolCorr.correlation) >= 0.5 && Math.abs(ethSolCorr.lag) >= 2;
    strategies.push({
      name: 'Lead/Lag Arbitrage',
      signal: leadLagActive ? (ethSolCorr.correlation > 0 ? 'BUY SOL' : 'SELL SOL') : 'WAITING',
      reason: ethSolCorr ? `Corr ${ethSolCorr.correlation.toFixed(2)}, lag ${ethSolCorr.lag}` : 'No cross-chain data',
      confidence: leadLagActive ? Math.abs(ethSolCorr.correlation) : 0.1,
      active: leadLagActive,
    });

    // 2. Drift Monitor - behavioral regime changes
    const driftActive = driftVelocity.velocity >= 0.4;
    strategies.push({
      name: 'Drift Monitor',
      signal: driftActive ? (driftVelocity.isAccelerating ? 'BUY BREAKOUT' : 'MOMENTUM') : 'STABLE',
      reason: `Drift ${(driftVelocity.velocity * 100).toFixed(0)}%${driftVelocity.isAccelerating ? ' accelerating' : ''}`,
      confidence: Math.min(1, driftVelocity.velocity),
      active: driftActive,
    });

    // 3. Anomaly Detector - isolation forest outliers
    const anomalyActive = signals.anomalyScore >= 0.7 || hotzoneDeparture.isOutlier;
    strategies.push({
      name: 'Anomaly Detector',
      signal: anomalyActive ? 'FADE MOVE' : (signals.anomalyScore >= 0.4 ? 'ELEVATED' : 'NORMAL'),
      reason: `Score ${(signals.anomalyScore * 100).toFixed(0)}%, σ=${hotzoneDeparture.departureSigma.toFixed(1)}`,
      confidence: signals.anomalyScore,
      active: anomalyActive,
    });

    // 4. Fear/Greed Contrarian
    const fgActive = market.fearGreedIndex <= 20 || market.fearGreedIndex >= 80;
    strategies.push({
      name: 'Fear/Greed Contrarian',
      signal: market.fearGreedIndex <= 20 ? 'BUY FEAR' : (market.fearGreedIndex >= 80 ? 'SELL GREED' : 'NEUTRAL'),
      reason: `F&G ${market.fearGreedIndex} (${market.fearGreedLabel})`,
      confidence: fgActive ? 0.8 : 0.2,
      active: fgActive,
    });

    // 5. Risk-Adjusted Position
    const bullBear = market.bullishScore >= 65 ? 'bullish' : (market.bullishScore <= 35 ? 'bearish' : 'neutral');
    const riskAdjActive = (market.bullishScore >= 65 && market.riskScore <= 40) || (market.bullishScore <= 35 && market.riskScore >= 60);
    strategies.push({
      name: 'Risk-Adjusted',
      signal: riskAdjActive ? (bullBear === 'bullish' ? 'BUY ETH' : 'SELL ETH') : 'HOLD',
      reason: `Bull ${Math.round(market.bullishScore)}/100, Risk ${Math.round(market.riskScore)}/100`,
      confidence: riskAdjActive ? Math.abs(market.bullishScore - 50) / 50 : 0.2,
      active: riskAdjActive,
    });

    // 6. TVL Divergence - smart money vs price
    const tvlDivActive = Math.abs(market.tvlChange || 0) > 3;
    strategies.push({
      name: 'TVL Divergence',
      signal: tvlDivActive ? ((market.tvlChange || 0) > 0 ? 'BULLISH DIV' : 'BEARISH DIV') : 'ALIGNED',
      reason: `TVL ${(market.tvlChange || 0) > 0 ? '+' : ''}${(market.tvlChange || 0).toFixed(1)}% 24h`,
      confidence: tvlDivActive ? Math.min(1, Math.abs(market.tvlChange || 0) / 10) : 0.2,
      active: tvlDivActive,
    });

    // 7. Altcoin Rotation
    strategies.push({
      name: 'Altcoin Rotation',
      signal: market.altcoinSeason ? 'BUY ALTS' : 'BTC DOMINANT',
      reason: market.altcoinSeason ? 'Alts outperforming' : 'BTC leading',
      confidence: market.altcoinSeason ? 0.7 : 0.3,
      active: market.altcoinSeason,
    });

    // 8. Volume Breakout
    strategies.push({
      name: 'Volume Breakout',
      signal: market.volumeAnomaly ? 'BREAKOUT' : 'NORMAL VOL',
      reason: market.volumeAnomaly ? 'Unusual volume spike' : 'Volume in range',
      confidence: market.volumeAnomaly ? 0.75 : 0.2,
      active: market.volumeAnomaly,
    });

    // 9. Funding Arbitrage - perpetual market signal
    const fundingActive = Math.abs(avgFunding) > 25;
    strategies.push({
      name: 'Funding Arbitrage',
      signal: fundingActive ? (avgFunding > 0 ? 'SHORT PERPS' : 'LONG PERPS') : 'NEUTRAL',
      reason: `Funding ${avgFunding.toFixed(0)}% APR`,
      confidence: fundingActive ? Math.min(1, Math.abs(avgFunding) / 50) : 0.2,
      active: fundingActive,
    });

    // 10. Leverage Risk Monitor
    const levRisk = market.leverageRisk || 0;
    const levActive = levRisk > 0.5;
    strategies.push({
      name: 'Leverage Risk',
      signal: levActive ? 'REDUCE SIZE' : 'NORMAL',
      reason: `Risk ${(levRisk * 100).toFixed(0)}%, Liqs $${((market.liquidations24h || 0) / 1e6).toFixed(0)}M`,
      confidence: levActive ? levRisk : 0.2,
      active: levActive,
    });

    // 11. Smart Money Flow
    const smf = market.smartMoneyFlow || 0;
    const smfActive = Math.abs(smf) > 0.25;
    strategies.push({
      name: 'Smart Money',
      signal: smfActive ? (smf > 0 ? 'FOLLOW LONGS' : 'FOLLOW SHORTS') : 'MIXED',
      reason: `Flow ${smf > 0 ? '+' : ''}${(smf * 100).toFixed(0)}%`,
      confidence: smfActive ? Math.abs(smf) : 0.2,
      active: smfActive,
    });

    // 12. Retail Sentiment (Contrarian)
    const fomo = market.retailFomo || 0;
    const fomoActive = fomo > 0.6;
    strategies.push({
      name: 'Retail Sentiment',
      signal: fomoActive ? 'CONTRARIAN SELL' : (fomo < 0.2 ? 'CONTRARIAN BUY' : 'NEUTRAL'),
      reason: `Retail FOMO ${(fomo * 100).toFixed(0)}%`,
      confidence: fomoActive ? fomo : (fomo < 0.2 ? 0.6 : 0.2),
      active: fomoActive || fomo < 0.2,
    });

    // ═══════════════════════════════════════════════════════════════
    // DERIVED SIGNALS (13-18) - Unique YYSFOLD edge
    // ═══════════════════════════════════════════════════════════════

    const derived = aggregateDerivedSignals(
      ethFingerprints,
      ethTags,
      market.fearGreedIndex,
      signals.anomalyScore
    );

    // 13. Mempool Pressure - Detect incoming volatility
    const mempoolActive = derived.mempool.volatilityPrecursor || derived.mempool.whaleActivity;
    strategies.push({
      name: 'Mempool Pressure',
      signal: derived.mempool.volatilityPrecursor ? 'VOL INCOMING' :
              derived.mempool.whaleActivity ? 'WHALE ALERT' : 'CALM',
      reason: `TX pressure ${(derived.mempool.txPressure * 100).toFixed(0)}%, MEV risk ${(derived.mempool.mevRisk * 100).toFixed(0)}%`,
      confidence: mempoolActive ? 0.7 : 0.2,
      active: mempoolActive,
    });

    // 14. Entropy Monitor - Coordination detection
    const entropyActive = derived.entropy.coordinationDetected || derived.entropy.chaosDetected;
    strategies.push({
      name: 'Entropy Monitor',
      signal: derived.entropy.coordinationDetected ? 'COORDINATED' :
              derived.entropy.chaosDetected ? 'CHAOTIC' : 'NORMAL',
      reason: `Entropy ${(derived.entropy.entropy * 100).toFixed(0)}%, Δ${(derived.entropy.entropyChange * 100).toFixed(1)}%`,
      confidence: entropyActive ? 0.75 : 0.2,
      active: entropyActive,
    });

    // 15. Tag Momentum - Activity surge detection
    const tagActive = derived.tagMomentum.activitySurge || derived.tagMomentum.activityCollapse;
    strategies.push({
      name: 'Tag Momentum',
      signal: derived.tagMomentum.activitySurge ? 'SURGE' :
              derived.tagMomentum.activityCollapse ? 'COLLAPSE' : 'STABLE',
      reason: derived.tagMomentum.dominantTag ?
              `${derived.tagMomentum.dominantTag} leading` : 'No dominant tag',
      confidence: tagActive ? 0.65 : 0.2,
      active: tagActive,
    });

    // 16. Pattern Match - Historical similarity
    const patternActive = derived.pattern && derived.pattern.confidence > 0.6;
    strategies.push({
      name: 'Pattern Match',
      signal: derived.pattern ?
              (derived.pattern.historicalOutcome > 0 ? 'BULLISH PATTERN' : 'BEARISH PATTERN') :
              'NO MATCH',
      reason: derived.pattern ?
              `${derived.pattern.patternType} (${(derived.pattern.similarity * 100).toFixed(0)}% match)` :
              'Scanning patterns...',
      confidence: derived.pattern?.confidence || 0.1,
      active: patternActive,
    });

    // 17. Regime Detector - Risk-on/off classification
    const regimeActive = derived.regime.regimeStrength > 0.5;
    strategies.push({
      name: 'Regime Detector',
      signal: derived.regime.currentRegime === 'risk-on' ? 'RISK ON' :
              derived.regime.currentRegime === 'risk-off' ? 'RISK OFF' :
              derived.regime.currentRegime === 'transition' ? 'TRANSITION' : 'UNCLEAR',
      reason: `${(derived.regime.regimeStrength * 100).toFixed(0)}% confidence, ${(derived.regime.transitionProbability * 100).toFixed(0)}% transition risk`,
      confidence: derived.regime.regimeStrength,
      active: regimeActive,
    });

    // 18. Composite Signal - Aggregated derived view
    const compositeActive = Math.abs(derived.overallBullish) > 0.3 || derived.overallVolatility > 0.5;
    strategies.push({
      name: 'YYSFOLD Composite',
      signal: derived.overallBullish > 0.3 ? 'BUY SIGNAL' :
              derived.overallBullish < -0.3 ? 'SELL SIGNAL' :
              derived.overallVolatility > 0.5 ? 'HIGH VOL' : 'NEUTRAL',
      reason: derived.actionableSignal || `Bull ${(derived.overallBullish * 100).toFixed(0)}%, Vol ${(derived.overallVolatility * 100).toFixed(0)}%`,
      confidence: Math.max(Math.abs(derived.overallBullish), derived.overallVolatility * 0.8),
      active: compositeActive,
    });

    // ═══════════════════════════════════════════════════════════════
    // EXTERNAL SIGNALS (19-23) - Options, Liquidations, Whales, Unlocks, Trends
    // ═══════════════════════════════════════════════════════════════

    const external = await fetchAllExternalSignals();

    // 19. Options Flow - Deribit put/call ratio
    const optionsActive = external.options.sentiment !== 'neutral' || external.options.unusualActivity;
    strategies.push({
      name: 'Options Flow',
      signal: external.options.sentiment === 'bullish' ? 'CALLS HEAVY' :
              external.options.sentiment === 'bearish' ? 'PUTS HEAVY' :
              external.options.unusualActivity ? 'UNUSUAL' : 'BALANCED',
      reason: `P/C ${external.options.btcPutCallRatio.toFixed(2)}, IV ${external.options.btcIV.toFixed(0)}%`,
      confidence: optionsActive ? 0.7 : 0.2,
      active: optionsActive,
    });

    // 20. Liquidation Heatmap - Cascade risk detection
    const liqActive = external.liquidations.cascadeRisk !== 'low';
    strategies.push({
      name: 'Liquidation Heatmap',
      signal: external.liquidations.cascadeRisk === 'high' ? 'CASCADE RISK' :
              external.liquidations.cascadeRisk === 'medium' ? 'CAUTION' : 'CLEAR',
      reason: `Long liq $${(external.liquidations.btcNearestLongLiq/1000).toFixed(0)}k, Short $${(external.liquidations.btcNearestShortLiq/1000).toFixed(0)}k`,
      confidence: external.liquidations.cascadeRisk === 'high' ? 0.85 :
                  external.liquidations.cascadeRisk === 'medium' ? 0.6 : 0.2,
      active: liqActive,
    });

    // 21. Whale Tracker - Large wallet movements
    const whaleActive = external.whales.smartMoneyDirection !== 'neutral' || external.whales.largeTransfers24h > 5;
    strategies.push({
      name: 'Whale Tracker',
      signal: external.whales.smartMoneyDirection === 'buying' ? 'WHALES BUYING' :
              external.whales.smartMoneyDirection === 'selling' ? 'WHALES SELLING' :
              external.whales.largeTransfers24h > 5 ? 'ACTIVE' : 'QUIET',
      reason: `${external.whales.largeTransfers24h} large txs, Flow $${(external.whales.netExchangeFlow/1e6).toFixed(1)}M`,
      confidence: whaleActive ? 0.75 : 0.2,
      active: whaleActive,
    });

    // 22. Token Unlocks - Supply pressure
    const unlockActive = external.unlocks.majorUnlockImminent || external.unlocks.totalUnlockValue7d > 500000000;
    strategies.push({
      name: 'Token Unlocks',
      signal: external.unlocks.majorUnlockImminent ? 'MAJOR UNLOCK' :
              external.unlocks.totalUnlockValue7d > 500000000 ? 'HIGH SUPPLY' : 'NORMAL',
      reason: external.unlocks.affectedTokens.length > 0 ?
              `$${(external.unlocks.totalUnlockValue7d/1e9).toFixed(1)}B 7d (${external.unlocks.affectedTokens.slice(0,3).join(', ')})` :
              'No major unlocks',
      confidence: unlockActive ? 0.7 : 0.2,
      active: unlockActive,
    });

    // 23. Google Trends / Retail Interest
    const trendsActive = external.trends.searchSpike || external.trends.retailFomo;
    strategies.push({
      name: 'Retail Interest',
      signal: external.trends.retailFomo ? 'FOMO SPIKE' :
              external.trends.searchSpike ? 'SEARCH SPIKE' :
              external.trends.btcTrend === 'rising' ? 'RISING' : 'NORMAL',
      reason: `Interest ${external.trends.cryptoInterest}/100, ${external.trends.btcTrend}`,
      confidence: trendsActive ? 0.65 : 0.2,
      active: trendsActive,
    });

    // Sort by confidence (active strategies first)
    strategies.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return b.confidence - a.confidence;
    });

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      market: {
        ethPrice: market.ethPrice,
        solPrice: market.solPrice,
        btcPrice: market.btcPrice || 0,
        fearGreedIndex: market.fearGreedIndex,
        fearGreedLabel: market.fearGreedLabel,
        bullishScore: market.bullishScore || 50,
        riskScore: market.riskScore || 50,
        volatility: market.volatility || 0,
        tvlChange: market.tvlChange || 0,
        volumeAnomaly: market.volumeAnomaly || false,
        tvlDivergence: market.tvlDivergence || false,
        momentumAlignment: market.momentumAlignment || false,
        altcoinSeason: market.altcoinSeason || false,
        // Advanced signals
        btcFunding: market.btcFunding || 0,
        ethFunding: market.ethFunding || 0,
        fundingExtreme: market.fundingExtreme || false,
        leverageRisk: market.leverageRisk || 0,
        smartMoneyFlow: market.smartMoneyFlow || 0,
        retailFomo: market.retailFomo || 0,
        liquidations24h: market.liquidations24h || 0,
        liquidationRatio: market.liquidationRatio || 1,
      },
      signals: {
        sentiment: signals.overallSentiment,
        confidence: signals.confidence,
        driftVelocity: driftVelocity.velocity,
        driftAccelerating: driftVelocity.isAccelerating,
        anomalyScore: signals.anomalyScore,
        isOutlier: hotzoneDeparture.isOutlier,
        emergingTags: tagAcceleration.emergingTags,
        decliningTags: tagAcceleration.decliningTags,
      },
      crossChain: crossChainCorrelations.map(c => ({
        pair: `${c.chain1}/${c.chain2}`,
        correlation: c.correlation,
        lag: c.lag,
        leadChain: c.leadChain,
      })),
      strategies,
      blockCount: ethFingerprints.length,
    });
  } catch (error: any) {
    console.error('[api] trading-bot signals error', error);
    res.status(500).json({ error: error.message });
  }
});

// Comprehensive HTML frontend for trading bot with wallet connection
app.get('/trading-bot', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YYSFOLD</title>
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.umd.min.js"></script>
  <script src="https://unpkg.com/@walletconnect/web3-provider@1.8.0/dist/umd/index.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js"></script>
  <style>
    @font-face {
      font-family: 'Circular';
      src: url('/fonts/lineto-circular-book.ttf') format('truetype');
      font-weight: 400;
      font-style: normal;
    }
    @font-face {
      font-family: 'Circular';
      src: url('/fonts/lineto-circular-medium.ttf') format('truetype');
      font-weight: 500;
      font-style: normal;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #111;
      --bg-tertiary: #1a1a1a;
      --border-color: #222;
      --border-hover: #333;
      --text-primary: #e0e0e0;
      --text-secondary: #888;
      --text-muted: #555;
      --accent: #00ff88;
      --accent-dim: #00ff8822;
      --danger: #ff4444;
      --warning: #ffaa00;
      --purple: #9945FF;
      --sidebar-width: 220px;
      --header-height: 56px;
      --right-sidebar-width: 260px;
      --trades-sidebar-width: 240px;
    }
    body {
      font-family: 'Circular', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      overflow: hidden;
    }
    h1, h2, h3, h4, h5, h6 { font-weight: 500; }

    /* Layout */
    .app-layout {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr var(--right-sidebar-width) var(--trades-sidebar-width);
      grid-template-rows: var(--header-height) 1fr;
      height: 100vh;
    }

    /* Header */
    .header {
      grid-column: 1 / -1;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      z-index: 100;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 16px;
      font-weight: 500;
      color: var(--accent);
    }
    .logo-icon {
      width: 28px;
      height: 28px;
      background: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #000;
      font-size: 14px;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--bg-tertiary);
      font-size: 12px;
      color: var(--text-secondary);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 2s infinite;
    }
    .status-dot.warning { background: var(--warning); }
    .status-dot.danger { background: var(--danger); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-btn {
      padding: 8px 14px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .header-btn:hover { border-color: var(--border-hover); color: var(--text-primary); }
    .header-btn.active { background: var(--accent); color: #000; border-color: var(--accent); }
    .wallet-btn {
      padding: 8px 16px;
      background: var(--accent);
      border: none;
      color: #000;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .wallet-btn:hover { background: #00cc6a; }
    .wallet-btn.connected {
      background: var(--bg-tertiary);
      color: var(--accent);
      border: 1px solid var(--accent);
    }

    /* Left Sidebar */
    .sidebar {
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      padding: 16px 0;
      overflow-y: auto;
    }
    .nav-section {
      padding: 0 12px;
      margin-bottom: 24px;
    }
    .nav-section-title {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 8px 12px;
      margin-bottom: 4px;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;
      font-size: 13px;
    }
    .nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
    .nav-item.active { background: var(--bg-tertiary); color: var(--text-primary); }
    .nav-item svg { width: 18px; height: 18px; opacity: 0.7; }
    .nav-item.active svg { opacity: 1; }
    .nav-badge {
      margin-left: auto;
      padding: 2px 8px;
      background: var(--accent-dim);
      color: var(--accent);
      font-size: 10px;
      font-weight: 500;
    }
    .nav-spacer { flex: 1; }

    /* Main Content */
    .main-content {
      background: var(--bg-primary);
      overflow-y: auto;
      padding: 20px;
    }
    .page-title {
      font-size: 20px;
      color: var(--text-primary);
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .page-title .badge {
      font-size: 11px;
      padding: 4px 10px;
      background: var(--accent-dim);
      color: var(--accent);
    }
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border-color);
    }
    .tab {
      padding: 12px 24px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.2s, border-color 0.2s;
    }
    .tab:hover {
      color: var(--text-secondary);
    }
    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent);
    }
    .tab-badge {
      font-size: 11px;
      padding: 2px 6px;
      background: var(--accent-dim);
      color: var(--accent);
      margin-left: 8px;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .signals-page {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 0;
    }
    .signal-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      padding: 16px;
      margin: -1px 0 0 -1px;
    }
    .signal-section h3 {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
    }
    .signal-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .signal-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
    }
    .signal-label {
      color: var(--text-muted);
      font-size: 12px;
    }
    .signal-value {
      font-size: 14px;
    }
    .signal-value.bullish { color: #00ff88; }
    .signal-value.bearish { color: #ff4444; }
    .signal-value.neutral { color: var(--text-secondary); }
    .signal-value.warning { color: #ffaa00; }
    .signal-bar {
      height: 4px;
      background: var(--border-color);
      margin-top: 8px;
    }
    .signal-bar-fill {
      height: 100%;
      transition: width 0.3s ease;
    }
    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tag-emerging {
      background: rgba(0, 255, 136, 0.15);
      color: #00ff88;
      padding: 4px 8px;
      font-size: 10px;
    }
    .tag-declining {
      background: rgba(255, 68, 68, 0.15);
      color: #ff4444;
      padding: 4px 8px;
      font-size: 10px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 0;
    }
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      padding: 16px;
      margin: -1px 0 0 -1px; /* overlap borders so they don't double up */
    }
    .card h2 {
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .metric {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 13px;
    }
    .metric-label { color: var(--text-secondary); }
    .metric-value { }
    .sentiment-bullish { color: var(--accent); }
    .sentiment-bearish { color: var(--danger); }
    .sentiment-neutral { color: var(--text-secondary); }
    .sentiment-volatile { color: var(--warning); }

    /* Strategies */
    .strategies-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 0;
    }
    .strategy {
      background: var(--bg-tertiary);
      padding: 14px;
      border: 1px solid var(--border-color);
      margin: -1px 0 0 -1px;
      transition: all 0.15s;
    }
    .strategy:hover { border-color: var(--border-hover); }
    .strategy.active { border-color: var(--accent); }
    .strategy.inactive { opacity: 0.5; }
    .strategy-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .strategy-name { color: var(--accent); font-weight: 500; font-size: 13px; }
    .strategy-signal {
      padding: 3px 10px;
      background: var(--accent-dim);
      color: var(--accent);
      font-size: 11px;
      font-weight: 500;
    }
    .strategy-signal.signal-active { background: var(--accent); color: #000; }
    .strategy-reason { color: var(--text-secondary); font-size: 11px; margin-bottom: 10px; }
    .strategy-actions { display: flex; gap: 10px; align-items: center; }
    .execute-btn {
      background: var(--accent);
      color: #000;
      border: none;
      padding: 6px 14px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      transition: all 0.15s;
    }
    .execute-btn:hover { background: #00cc6a; }
    .execute-btn:disabled { background: var(--bg-tertiary); color: var(--text-muted); cursor: not-allowed; }
    .trade-amount { font-size: 11px; color: var(--text-muted); }

    /* Right Sidebar - Block Feed */
    .block-feed {
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .feed-header {
      padding: 16px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .feed-title {
      font-size: 12px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .feed-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .feed-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
      position: relative;
      /* Scroll fade mask - only at bottom */
      mask-image: linear-gradient(to bottom, black 0%, black 85%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 0%, black 85%, transparent 100%);
    }
    .feed-list-inner {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 4px;
    }
    .block-item {
      padding: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      opacity: 0;
      transform: translateY(-10px);
    }
    .block-item.visible {
      opacity: 1;
      transform: translateY(0);
    }
    .block-chain {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .chain-badge {
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .chain-eth { background: #627eea22; color: #627eea; }
    .chain-sol { background: #9945FF22; color: #9945FF; }
    .chain-avax { background: #e8414122; color: #e84141; }
    .block-height {
      font-size: 12px;
      color: var(--text-primary);
      font-weight: 500;
    }
    .block-meta {
      display: flex;
      gap: 12px;
      font-size: 10px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .block-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .block-tag {
      padding: 2px 6px;
      background: var(--bg-secondary);
      font-size: 9px;
      color: var(--text-secondary);
    }
    .block-tag.hot { background: #ff444422; color: var(--danger); }
    .block-anomaly {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .anomaly-bar {
      flex: 1;
      height: 4px;
      background: var(--border-color);
      overflow: hidden;
    }
    .anomaly-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s;
    }
    .anomaly-fill.warning { background: var(--warning); }
    .anomaly-fill.danger { background: var(--danger); }

    /* Block item divider line like skiper87 */
    .block-divider {
      height: 1px;
      background: var(--border-color);
      flex: 1;
      margin-left: 8px;
    }

    /* Active Trades Sidebar */
    .trades-feed {
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .trades-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
      mask-image: linear-gradient(to bottom, black 0%, black 85%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 0%, black 85%, transparent 100%);
    }
    .trades-list-inner {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 4px;
    }
    .trade-item {
      padding: 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      opacity: 0;
      transform: translateX(10px);
    }
    .trade-item.visible {
      opacity: 1;
      transform: translateX(0);
    }
    .trade-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .trade-pair {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-primary);
    }
    .trade-side {
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 500;
    }
    .trade-side.buy { background: #00ff8822; color: var(--accent); }
    .trade-side.sell { background: #ff444422; color: var(--danger); }
    .trade-details {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
    }
    .trade-pnl {
      font-weight: 500;
    }
    .trade-pnl.positive { color: var(--accent); }
    .trade-pnl.negative { color: var(--danger); }
    .trade-status {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      color: var(--text-muted);
    }
    .status-badge {
      padding: 2px 6px;
      font-size: 9px;
      font-weight: 500;
    }
    .status-badge.pending { background: #ffaa0022; color: var(--warning); }
    .status-badge.active { background: #00ff8822; color: var(--accent); }
    .status-badge.filled { background: #627eea22; color: #627eea; }
    .no-trades {
      padding: 20px;
      text-align: center;
      color: var(--text-muted);
      font-size: 11px;
    }

    /* Wallet Info Overlay */
    .wallet-overlay {
      display: none;
      position: fixed;
      top: var(--header-height);
      right: 20px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      width: 280px;
      z-index: 200;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .wallet-overlay.show { display: block; }

    /* Correlation bar */
    .correlation-bar {
      height: 6px;
      background: var(--border-color);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
    }
    .correlation-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--danger), var(--text-secondary), var(--accent));
      transition: width 0.3s;
    }

    .no-signal { color: var(--text-muted); font-style: italic; font-size: 12px; }
    .full-width { grid-column: 1 / -1; }

    /* Hide scrollbars but keep scroll functionality */
    * {
      scrollbar-width: none; /* Firefox */
      -ms-overflow-style: none; /* IE/Edge */
    }
    *::-webkit-scrollbar {
      display: none; /* Chrome/Safari/Opera */
    }
  </style>
</head>
<body>
  <div class="app-layout">
    <!-- Header -->
    <header class="header" style="display:flex; justify-content:space-between; align-items:center;">
      <div class="header-left">
        <div class="logo">
          <div class="logo-icon">Y</div>
          <span>YYSFOLD</span>
        </div>
        <div class="status-indicator">
          <div class="status-dot" id="statusDot"></div>
          <span id="statusText">Syncing...</span>
        </div>
      </div>
      <div style="display:flex; gap:24px; align-items:center;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:10px; color:var(--text-muted);">PORTFOLIO</span>
          <span style="font-size:14px; font-weight:600;" id="headerPortfolioValue">$0.00</span>
        </div>
        <div style="width:1px; height:20px; background:var(--border);"></div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:10px; color:var(--text-muted);">P&L</span>
          <span style="font-size:14px; font-weight:600;" id="headerPnL">$0.00</span>
        </div>
        <div style="width:1px; height:20px; background:var(--border);"></div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:10px; color:var(--text-muted);">TRADES</span>
          <span style="font-size:14px; font-weight:600;" id="headerTradeCount">0</span>
        </div>
      </div>
      <div class="header-right">
        <span style="font-size:11px; color:var(--text-muted);" id="lastUpdate">Loading...</span>
        <button class="header-btn" id="autoRebalanceBtn" onclick="toggleAutoRebalance()" style="background:#222;">Auto-Rebalance: OFF</button>
        <button class="header-btn" id="autoTradeBtn" onclick="toggleAutoTrade()">Auto-Trade: OFF</button>
        <button class="wallet-btn" id="connectBtn" onclick="connectWallet()">Connect Wallet</button>
      </div>
    </header>

    <!-- Left Sidebar -->
    <nav class="sidebar">
      <div class="nav-section">
        <div class="nav-item active" data-page="home">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9,22 9,12 15,12 15,22"></polyline></svg>
          Home
        </div>
        <div class="nav-item" data-page="signals">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"></polyline></svg>
          Signals
          <span class="nav-badge" id="activeSignals">0</span>
        </div>
        <div class="nav-item" data-page="strategies">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>
          Strategies
        </div>
        <div class="nav-item" data-page="blocks">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
          Blocks
        </div>
        <div class="nav-item" data-page="mempool">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"></path></svg>
          Mempool
          <span class="nav-badge" id="mempoolScore">0</span>
        </div>
      </div>

      <div class="nav-section">
        <div class="nav-section-title">Analysis</div>
        <div class="nav-item" data-page="atlas">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
          Atlas
        </div>
        <div class="nav-item" data-page="fingerprints">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10"></path><path d="M12 2c5.52 0 10 4.48 10 10"></path><path d="M12 12l4 4"></path></svg>
          Fingerprints
        </div>
        <div class="nav-item" data-page="anomalies">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          Anomalies
        </div>
        <div class="nav-item" data-page="predictions">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path><circle cx="12" cy="12" r="4"></circle></svg>
          Predictions
          <span class="nav-badge" style="background:var(--accent);">AI</span>
        </div>
      </div>

      <div class="nav-section">
        <div class="nav-section-title">Trading</div>
        <div class="nav-item" data-page="orders">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14,2 14,8 20,8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
          Orders
        </div>
        <div class="nav-item" data-page="history">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          History
        </div>
      </div>

      <div class="nav-spacer"></div>

      <div class="nav-section">
        <div class="nav-item" data-page="settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          Settings
        </div>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="main-content">
      <div class="tabs">
        <button class="tab active" data-tab="dashboard" onclick="switchTab('dashboard')">Dashboard</button>
        <button class="tab" data-tab="signals" onclick="switchTab('signals')">Signals <span class="tab-badge" id="signalCountTab">0</span></button>
        <button class="tab" data-tab="strategies" onclick="switchTab('strategies')">Strategies <span class="tab-badge" id="strategyCount">23</span></button>
        <button class="tab" data-tab="portfolio" onclick="switchTab('portfolio')">Portfolio</button>
        <button class="tab" data-tab="mempool" onclick="switchTab('mempool')">Mempool <span class="tab-badge" id="mempoolBadge">-</span></button>
        <button class="tab" data-tab="orders" onclick="switchTab('orders')">Orders <span class="tab-badge" id="ordersBadge">0</span></button>
        <button class="tab" data-tab="predictions" onclick="switchTab('predictions')">Predictions <span class="tab-badge" id="predictionBadge" style="background:var(--accent);">AI</span></button>
        <button class="tab" data-tab="alpha" onclick="switchTab('alpha')">Alpha <span class="tab-badge" id="alphaBadge" style="background:#ff6b00;">NEW</span></button>
        <button class="tab" data-tab="validator" onclick="switchTab('validator')">Validator <span class="tab-badge" style="background:#00aaff;">USPTO</span></button>
      </div>

      <!-- Dashboard Tab -->
      <div id="tab-dashboard" class="tab-content active">

      <!-- Connected Wallet Info -->
      <div id="walletInfo" style="display:none; margin-bottom:20px; padding:16px; background:var(--bg-secondary); border:1px solid var(--accent);">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="color:var(--accent); font-weight:500; font-size:12px;">CONNECTED</div>
            <div id="walletAddress" style="font-size:12px; color:var(--text-secondary);"></div>
          </div>
          <div style="text-align:right;">
            <div id="walletBalance" style="font-size:18px; color:var(--accent);"></div>
            <div id="walletNetwork" style="font-size:11px; color:var(--text-muted);"></div>
          </div>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Live Prices</h2>
          <div id="prices">Loading...</div>
        </div>

        <div class="card">
          <h2>Market Scores</h2>
          <div id="scores">Loading...</div>
        </div>

        <div class="card">
          <h2>Fear/Greed</h2>
          <div id="feargreed">Loading...</div>
        </div>

        <div class="card">
          <h2>Social Sentiment</h2>
          <div id="social">Loading...</div>
        </div>

        <div class="card">
          <h2>On-Chain Signals</h2>
          <div id="signals">Loading...</div>
        </div>

        <div class="card">
          <h2>Cross-Chain</h2>
          <div id="crosschain">Loading...</div>
        </div>

        <div class="card">
          <h2>Derivatives</h2>
          <div id="derivatives">Loading...</div>
        </div>

        <div class="card">
          <h2>Flow Analysis</h2>
          <div id="flows">Loading...</div>
        </div>

        <div class="card">
          <h2>Multi-Chain TVL</h2>
          <div id="chains">Loading...</div>
        </div>

        <div class="card">
          <h2>Gas Prices</h2>
          <div id="gas">Loading...</div>
        </div>

        <div class="card">
          <h2>Stablecoins</h2>
          <div id="stablecoins">Loading...</div>
        </div>

        <div class="card">
          <h2>Your Orders</h2>
          <div id="orders"><p class="no-signal">Connect wallet to view orders</p></div>
        </div>
      </div>
      </div>

      <!-- Signals Tab -->
      <div id="tab-signals" class="tab-content">
        <div class="signals-page">
          <div class="signal-section">
            <h3>Behavioral Regime</h3>
            <div id="signalRegime" class="signal-grid">Loading...</div>
          </div>
          <div class="signal-section">
            <h3>Drift Analysis</h3>
            <div id="signalDrift" class="signal-grid">Loading...</div>
          </div>
          <div class="signal-section">
            <h3>Anomaly Detection</h3>
            <div id="signalAnomaly" class="signal-grid">Loading...</div>
          </div>
          <div class="signal-section">
            <h3>Cross-Chain Correlation</h3>
            <div id="signalCrossChain" class="signal-grid">Loading...</div>
          </div>
          <div class="signal-section">
            <h3>Tag Dynamics</h3>
            <div id="signalTags" class="signal-grid">Loading...</div>
          </div>
        </div>
      </div>

      <!-- Strategies Tab -->
      <div id="tab-strategies" class="tab-content">
        <div class="strategies-grid" id="strategies">Loading...</div>
      </div>

      <!-- Portfolio Tab -->
      <div id="tab-portfolio" class="tab-content">
        <div class="grid" style="gap:0;">
          <!-- Regime & Allocation -->
          <div class="card" style="border-bottom:none;">
            <h2>Signal Regime</h2>
            <div id="regimeDisplay">
              <div class="metric">
                <span class="metric-label">Current Regime</span>
                <span class="metric-value" id="currentRegime">Loading...</span>
              </div>
              <div style="margin-top:16px;">
                <div style="color:var(--text-muted); font-size:11px; margin-bottom:8px;">TARGET ALLOCATION</div>
                <div id="targetAllocation"></div>
              </div>
            </div>
          </div>

          <div class="card" style="border-bottom:none;">
            <h2>Current Holdings</h2>
            <div id="portfolioHoldings">Loading...</div>
            <div style="margin-top:12px; font-size:12px; color:var(--text-muted);">
              Total: <span id="portfolioTotal" style="color:var(--accent);">$0</span>
            </div>
          </div>

          <div class="card" style="border-bottom:none;">
            <h2>Allocation Chart</h2>
            <div id="allocationChart" style="display:flex; height:20px; border-radius:4px; overflow:hidden; margin-bottom:12px;"></div>
            <div id="allocationLegend" style="display:flex; flex-wrap:wrap; gap:12px;"></div>
          </div>

          <div class="card">
            <h2>Suggested Rebalance</h2>
            <div id="rebalanceTrades">Loading...</div>
            <button id="executeRebalanceBtn" onclick="executeRebalance()" style="margin-top:16px; width:100%; padding:12px; background:var(--accent); color:#000; border:none; cursor:pointer; font-weight:500;">
              Execute Rebalance
            </button>
          </div>
        </div>

        <!-- Manual Swap -->
        <div class="card" style="margin-top:0; border-top:none;">
          <h2>Manual Swap</h2>
          <div style="display:grid; grid-template-columns:1fr auto 1fr auto; gap:12px; align-items:end;">
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">From</label>
              <select id="swapFrom" style="width:100%; padding:8px; background:var(--bg-primary); border:1px solid var(--border); color:var(--text-primary);">
                <option value="ETH">ETH</option>
                <option value="WETH">WETH</option>
                <option value="USDC">USDC</option>
                <option value="WBTC">WBTC</option>
              </select>
            </div>
            <div style="padding-bottom:8px; color:var(--text-muted);">→</div>
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">To</label>
              <select id="swapTo" style="width:100%; padding:8px; background:var(--bg-primary); border:1px solid var(--border); color:var(--text-primary);">
                <option value="USDC">USDC</option>
                <option value="ETH">ETH</option>
                <option value="WETH">WETH</option>
                <option value="WBTC">WBTC</option>
              </select>
            </div>
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">Amount</label>
              <input type="text" id="swapAmount" placeholder="0.01" style="width:80px; padding:8px; background:var(--bg-primary); border:1px solid var(--border); color:var(--text-primary);">
            </div>
          </div>
          <button onclick="executeManualSwap()" style="margin-top:16px; width:100%; padding:12px; background:transparent; border:1px solid var(--accent); color:var(--accent); cursor:pointer;">
            Execute Swap
          </button>
        </div>
      </div>

      <!-- Mempool Tab -->
      <div id="tab-mempool" class="tab-content">
        <div class="grid">
          <div class="card">
            <h2>Mempool Status</h2>
            <div id="mempoolStatus">
              <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:16px;">
                <div class="metric">
                  <span class="metric-label">Pending TXs</span>
                  <span class="metric-value" id="mempoolTxCount">-</span>
                </div>
                <div class="metric">
                  <span class="metric-label">Total Value</span>
                  <span class="metric-value" id="mempoolValue">-</span>
                </div>
                <div class="metric">
                  <span class="metric-label">Anomaly Score</span>
                  <span class="metric-value" id="mempoolAnomaly">-</span>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <h2>Trading Signal</h2>
            <div id="mempoolSignal">
              <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:16px;">
                <div class="metric">
                  <span class="metric-label">Signal</span>
                  <span class="metric-value" id="mempoolSignalType">-</span>
                </div>
                <div class="metric">
                  <span class="metric-label">Confidence</span>
                  <span class="metric-value" id="mempoolConfidence">-</span>
                </div>
              </div>
              <div style="margin-top:16px;">
                <div style="display:flex; gap:12px;">
                  <div class="metric" style="flex:1;">
                    <span class="metric-label">Bullish Score</span>
                    <span class="metric-value" style="color:#00ff88;" id="mempoolBullish">0</span>
                  </div>
                  <div class="metric" style="flex:1;">
                    <span class="metric-label">Bearish Score</span>
                    <span class="metric-value" style="color:#ff6b6b;" id="mempoolBearish">0</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <h2>Detected Activity</h2>
            <div id="mempoolTags" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
          </div>

          <div class="card">
            <h2>Analysis Reasons</h2>
            <div id="mempoolReasons" style="font-size:12px; color:var(--text-secondary);"></div>
          </div>

          <div class="card" style="grid-column: span 2;">
            <h2>Mempool History</h2>
            <div id="mempoolHistory" style="max-height:200px; overflow-y:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:11px;">
                <thead>
                  <tr style="color:#666; text-align:left; border-bottom:1px solid #333;">
                    <th style="padding:6px;">Time</th>
                    <th style="padding:6px;">TXs</th>
                    <th style="padding:6px;">Value (ETH)</th>
                    <th style="padding:6px;">Score</th>
                    <th style="padding:6px;">Tags</th>
                  </tr>
                </thead>
                <tbody id="mempoolHistoryBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Orders Tab -->
      <div id="tab-orders" class="tab-content">
        <div class="card">
          <h2>Trade History</h2>
          <div style="margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
            <span style="color:var(--text-muted); font-size:12px;">All executed swaps</span>
            <button onclick="localStorage.removeItem('initialPortfolioValue'); location.reload();" style="padding:6px 12px; background:#333; border:1px solid #444; color:#888; cursor:pointer; font-size:11px;">Reset P&L</button>
          </div>
          <div id="ordersTable" style="max-height:500px; overflow-y:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
              <thead>
                <tr style="color:#888; text-align:left; border-bottom:1px solid #333; position:sticky; top:0; background:var(--bg-secondary);">
                  <th style="padding:10px 8px;">Time</th>
                  <th style="padding:10px 8px;">Pair</th>
                  <th style="padding:10px 8px;">Side</th>
                  <th style="padding:10px 8px;">Amount</th>
                  <th style="padding:10px 8px;">Status</th>
                  <th style="padding:10px 8px;">Transaction</th>
                </tr>
              </thead>
              <tbody id="ordersTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Predictions Tab -->
      <div id="tab-predictions" class="tab-content">
        <div class="grid">
          <!-- Main Prediction Card -->
          <div class="card" style="grid-column: span 2;">
            <h2>Unified Prediction <span id="predictionChain" style="color:var(--accent); font-size:12px;">ETH</span></h2>
            <div id="predictionMain" style="padding:16px 0;">
              <div style="display:flex; gap:32px; align-items:center; margin-bottom:24px;">
                <div id="predictionDirection" style="font-size:48px; font-weight:700; color:var(--text-muted);">-</div>
                <div>
                  <div style="display:flex; gap:16px; margin-bottom:8px;">
                    <div>
                      <span style="font-size:10px; color:var(--text-muted);">CONFIDENCE</span>
                      <div id="predictionConfidence" style="font-size:24px; font-weight:600;">-</div>
                    </div>
                    <div>
                      <span style="font-size:10px; color:var(--text-muted);">STRENGTH</span>
                      <div id="predictionStrength" style="font-size:24px; font-weight:600;">-</div>
                    </div>
                    <div>
                      <span style="font-size:10px; color:var(--text-muted);">EXPECTED 1H</span>
                      <div id="predictionExpected" style="font-size:24px; font-weight:600;">-</div>
                    </div>
                  </div>
                  <div id="predictionAction" style="padding:8px 16px; background:var(--bg-secondary); display:inline-block; font-weight:600; text-transform:uppercase;">-</div>
                </div>
              </div>
              <div id="predictionReasoning" style="padding:16px; background:var(--bg-secondary); border-radius:4px; font-size:12px; color:var(--text-secondary);">
                Loading prediction...
              </div>
            </div>
          </div>

          <!-- Cascade Risk Card -->
          <div class="card">
            <h2>Cascade Risk</h2>
            <div id="cascadeRiskContent">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <span style="font-size:10px; color:var(--text-muted);">RISK LEVEL</span>
                <div id="cascadeRiskLevel" style="padding:4px 12px; background:#333; font-size:14px; font-weight:600;">-</div>
              </div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; font-size:12px;">
                <div>
                  <span style="color:var(--text-muted);">Leverage</span>
                  <div id="cascadeLeverage" style="font-weight:500;">-</div>
                </div>
                <div>
                  <span style="color:var(--text-muted);">Proximity</span>
                  <div id="cascadeProximity" style="font-weight:500;">-</div>
                </div>
                <div>
                  <span style="color:var(--text-muted);">Momentum</span>
                  <div id="cascadeMomentum" style="font-weight:500;">-</div>
                </div>
                <div>
                  <span style="color:var(--text-muted);">Contagion</span>
                  <div id="cascadeContagion" style="font-weight:500;">-</div>
                </div>
              </div>
              <div id="cascadeWarnings" style="margin-top:16px; padding:12px; background:#331111; border-radius:4px; font-size:11px; color:#ff6b6b; display:none;"></div>
            </div>
          </div>

          <!-- Signal Breakdown Card -->
          <div class="card">
            <h2>Signal Breakdown</h2>
            <div id="signalBreakdown" style="font-size:12px;">
              <div style="display:grid; gap:8px;">
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Drift Velocity</span>
                  <span id="sigDrift" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Entropy</span>
                  <span id="sigEntropy" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Anomaly Score</span>
                  <span id="sigAnomaly" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Mempool Pressure</span>
                  <span id="sigMempool" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Tag Momentum</span>
                  <span id="sigTags" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Fear/Greed</span>
                  <span id="sigFearGreed" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">
                  <span>Funding Rate</span>
                  <span id="sigFunding" style="font-weight:500;">-</span>
                </div>
                <div class="signal-row" style="display:flex; justify-content:space-between; padding:6px 0;">
                  <span>Liquidation Risk</span>
                  <span id="sigLiquidation" style="font-weight:500;">-</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Bullish/Bearish Signals -->
          <div class="card">
            <h2>Bullish Signals</h2>
            <div id="bullishSignals" style="font-size:12px; color:#00ff88;">
              <div style="color:var(--text-muted);">No bullish signals</div>
            </div>
          </div>

          <div class="card">
            <h2>Bearish Signals</h2>
            <div id="bearishSignals" style="font-size:12px; color:#ff6b6b;">
              <div style="color:var(--text-muted);">No bearish signals</div>
            </div>
          </div>

          <!-- Pattern Match Card -->
          <div class="card">
            <h2>Pattern Match</h2>
            <div id="patternMatch">
              <div id="matchedPattern" style="font-size:16px; font-weight:600; margin-bottom:8px;">No pattern detected</div>
              <div id="patternConfidence" style="font-size:12px; color:var(--text-muted);">-</div>
              <div id="similarPatterns" style="margin-top:16px; padding:12px; background:var(--bg-secondary); border-radius:4px; font-size:11px;">
                <div style="color:var(--text-muted); margin-bottom:8px;">Similar Historical Patterns:</div>
                <div id="similarPatternsList"></div>
              </div>
            </div>
          </div>

          <!-- Prediction Stats Card -->
          <div class="card" style="grid-column: span 2;">
            <h2>Prediction Performance</h2>
            <div id="predictionStats">
              <div style="display:flex; gap:32px; margin-bottom:16px;">
                <div>
                  <span style="font-size:10px; color:var(--text-muted);">TOTAL PREDICTIONS</span>
                  <div id="statTotal" style="font-size:24px; font-weight:600;">0</div>
                </div>
                <div>
                  <span style="font-size:10px; color:var(--text-muted);">ACCURACY</span>
                  <div id="statAccuracy" style="font-size:24px; font-weight:600; color:var(--accent);">-</div>
                </div>
                <div>
                  <span style="font-size:10px; color:var(--text-muted);">RECENT ACCURACY (50)</span>
                  <div id="statRecentAccuracy" style="font-size:24px; font-weight:600;">-</div>
                </div>
                <div>
                  <span style="font-size:10px; color:var(--text-muted);">AVG CONFIDENCE</span>
                  <div id="statAvgConfidence" style="font-size:24px; font-weight:600;">-</div>
                </div>
              </div>
              <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
                <div style="padding:12px; background:var(--bg-secondary); border-radius:4px;">
                  <div style="font-size:10px; color:#00ff88; margin-bottom:4px;">BULLISH</div>
                  <div style="display:flex; justify-content:space-between;">
                    <span id="statBullishCount">0</span>
                    <span id="statBullishAccuracy" style="color:#00ff88;">-</span>
                  </div>
                </div>
                <div style="padding:12px; background:var(--bg-secondary); border-radius:4px;">
                  <div style="font-size:10px; color:#ff6b6b; margin-bottom:4px;">BEARISH</div>
                  <div style="display:flex; justify-content:space-between;">
                    <span id="statBearishCount">0</span>
                    <span id="statBearishAccuracy" style="color:#ff6b6b;">-</span>
                  </div>
                </div>
                <div style="padding:12px; background:var(--bg-secondary); border-radius:4px;">
                  <div style="font-size:10px; color:#888; margin-bottom:4px;">NEUTRAL</div>
                  <div style="display:flex; justify-content:space-between;">
                    <span id="statNeutralCount">0</span>
                    <span id="statNeutralAccuracy" style="color:#888;">-</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pattern Performance Card -->
          <div class="card" style="grid-column: span 2;">
            <h2>Learned Patterns Performance</h2>
            <div id="patternPerformance" style="max-height:300px; overflow-y:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr style="color:#888; text-align:left; border-bottom:1px solid #333;">
                    <th style="padding:8px;">Pattern</th>
                    <th style="padding:8px;">Occurrences</th>
                    <th style="padding:8px;">Accuracy</th>
                    <th style="padding:8px;">Avg Outcome</th>
                    <th style="padding:8px;">Confidence</th>
                  </tr>
                </thead>
                <tbody id="patternTableBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Alpha Tab - Early Alpha Detection -->
      <div id="tab-alpha" class="tab-content">
        <div class="grid" style="gap:20px;">
          <!-- Scanner Status Card -->
          <div class="card">
            <h2>Alpha Scanner</h2>
            <div id="alphaStatus" style="display:flex; flex-direction:column; gap:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="color:var(--text-secondary);">Status</span>
                <span id="scannerStatus" style="color:var(--text-muted);">Inactive</span>
              </div>
              <div style="display:flex; gap:10px;">
                <button onclick="startAlphaScanner()" class="btn btn-primary" style="flex:1;">Start Scanner</button>
                <button onclick="stopAlphaScanner()" class="btn btn-secondary" style="flex:1;">Stop</button>
              </div>
              <button onclick="runAlphaScan()" class="btn" style="background:var(--accent); color:#000;">Scan Now (50 blocks)</button>
            </div>
            <div style="margin-top:16px; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div style="text-align:center; padding:10px; background:rgba(0,255,136,0.05); border-radius:4px;">
                <div id="tokensTracked" style="font-size:24px; color:var(--accent);">0</div>
                <div style="font-size:10px; color:var(--text-muted);">TOKENS</div>
              </div>
              <div style="text-align:center; padding:10px; background:rgba(0,255,136,0.05); border-radius:4px;">
                <div id="pairsTracked" style="font-size:24px; color:var(--accent);">0</div>
                <div style="font-size:10px; color:var(--text-muted);">PAIRS</div>
              </div>
            </div>
          </div>

          <!-- Chat Interface Card -->
          <div class="card">
            <h2>Ask AI</h2>
            <div id="chatContainer" style="display:flex; flex-direction:column; gap:10px;">
              <div id="chatMessages" style="min-height:100px; max-height:200px; overflow-y:auto; padding:10px; background:#0a0a0a; border-radius:4px; font-size:12px;">
                <div style="color:var(--text-muted);">Ask about tokens, smart money, or market signals...</div>
              </div>
              <div style="display:flex; gap:10px;">
                <input type="text" id="chatInput" placeholder="e.g. Show hot tokens..." style="flex:1; padding:10px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary);" onkeypress="if(event.key==='Enter')sendChatMessage()">
                <button onclick="sendChatMessage()" class="btn btn-primary">Send</button>
              </div>
              <div id="chatSuggestions" style="display:flex; flex-wrap:wrap; gap:6px;"></div>
            </div>
          </div>

          <!-- Hot Tokens Card -->
          <div class="card" style="grid-column:span 2;">
            <h2>Hottest Opportunities</h2>
            <div id="hotTokens" style="max-height:300px; overflow-y:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr style="color:#888; text-align:left; border-bottom:1px solid #333;">
                    <th style="padding:8px;">Token</th>
                    <th style="padding:8px;">Score</th>
                    <th style="padding:8px;">Signals</th>
                    <th style="padding:8px;">Block</th>
                    <th style="padding:8px;">Actions</th>
                  </tr>
                </thead>
                <tbody id="hotTokensBody">
                  <tr><td colspan="5" style="padding:20px; text-align:center; color:var(--text-muted);">Run a scan to find tokens</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- New Pairs Card -->
          <div class="card">
            <h2>New DEX Pairs</h2>
            <div id="newPairs" style="max-height:250px; overflow-y:auto;">
              <div style="padding:20px; text-align:center; color:var(--text-muted); font-size:12px;">
                No pairs detected yet
              </div>
            </div>
          </div>

          <!-- Smart Money Card -->
          <div class="card">
            <h2>Smart Money Activity</h2>
            <div id="smartMoney" style="max-height:250px; overflow-y:auto;">
              <div style="padding:10px 0; border-bottom:1px solid #222;">
                <div style="font-size:11px; color:var(--text-muted);">Tracked Wallets</div>
                <div id="trackedWallets" style="font-size:12px; margin-top:5px;"></div>
              </div>
              <div style="padding:10px 0;">
                <div style="font-size:11px; color:var(--text-muted);">Recent Trades</div>
                <div id="smartMoneyTrades" style="font-size:12px; margin-top:5px;">
                  <div style="color:var(--text-muted);">No trades detected</div>
                </div>
              </div>
              <div style="margin-top:10px;">
                <input type="text" id="newWalletAddress" placeholder="0x..." style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:11px; margin-bottom:5px;">
                <input type="text" id="newWalletLabel" placeholder="Label (e.g. Whale 1)" style="width:100%; padding:8px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:11px; margin-bottom:5px;">
                <button onclick="addWalletToTrack()" class="btn btn-secondary" style="width:100%; font-size:11px;">Add Wallet to Track</button>
              </div>
            </div>
          </div>

          <!-- Token Analysis Card -->
          <div class="card" style="grid-column:span 2;">
            <h2>Analyze Token</h2>
            <div style="display:flex; gap:10px; margin-bottom:15px;">
              <input type="text" id="analyzeTokenAddress" placeholder="Enter token address (0x...)" style="flex:1; padding:10px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary);">
              <button onclick="analyzeTokenAddress()" class="btn btn-primary">Analyze</button>
            </div>
            <div id="tokenAnalysis" style="min-height:100px; padding:15px; background:#0a0a0a; border-radius:4px; font-size:12px; white-space:pre-wrap;">
              <span style="color:var(--text-muted);">Enter a token address to analyze...</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Validator Tab - Patent Architecture -->
      <div id="tab-validator" class="tab-content">
        <div style="margin-bottom:20px;">
          <h2 style="margin:0 0 4px;">Pattern-Based Blockchain Validation Architecture</h2>
          <div style="color:var(--text-muted); font-size:11px;">USPTO Provisional Patent 63/906,240 | Implements 8-Dimensional Pattern Recognition for Universal Device Participation</div>
        </div>

        <!-- Top Stats Row -->
        <div class="grid" style="grid-template-columns: repeat(5, 1fr); gap:12px; margin-bottom:20px;">
          <div class="card" style="padding:16px; text-align:center;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Pattern Index</div>
            <div id="vIndexLoaded" style="font-size:22px; font-weight:700; color:#00aaff;">-</div>
            <div style="font-size:10px; color:var(--text-muted);" id="vIndexSize">Loading...</div>
          </div>
          <div class="card" style="padding:16px; text-align:center;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Meta-Blocks</div>
            <div id="vMetaBlocks" style="font-size:22px; font-weight:700; color:#00ff88;">-</div>
            <div style="font-size:10px; color:var(--text-muted);" id="vBlocksCovered">- blocks covered</div>
          </div>
          <div class="card" style="padding:16px; text-align:center;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Storage Reduction</div>
            <div id="vStorageReduction" style="font-size:22px; font-weight:700; color:#ff6b00;">-</div>
            <div style="font-size:10px; color:var(--text-muted);">vs full blockchain</div>
          </div>
          <div class="card" style="padding:16px; text-align:center;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Validator Nodes</div>
            <div id="vNodeCount" style="font-size:22px; font-weight:700; color:#aa88ff;">-</div>
            <div style="font-size:10px; color:var(--text-muted);" id="vTierBreakdown">-M / -P / -A</div>
          </div>
          <div class="card" style="padding:16px; text-align:center;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase;">Consensus Health</div>
            <div id="vConsensus" style="font-size:22px; font-weight:700; color:#00ff88;">-</div>
            <div style="font-size:10px; color:var(--text-muted);" id="vValidations">- validations</div>
          </div>
        </div>

        <div class="grid" style="grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:20px;">
          <!-- Live Benchmark Card -->
          <div class="card" style="padding:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
              <h3 style="margin:0;">Patent Claims Benchmark</h3>
              <button onclick="runLiveBenchmark()" style="padding:6px 14px; background:#00aaff; border:none; color:#000; border-radius:4px; cursor:pointer; font-weight:600; font-size:12px;">Run Benchmark</button>
            </div>
            <div id="benchmarkResults" style="font-family:monospace; font-size:12px; line-height:1.8;">
              <div style="color:var(--text-muted);">Click "Run Benchmark" to test patent claims on real data...</div>
            </div>
          </div>

          <!-- 8D Feature Extractor -->
          <div class="card" style="padding:20px;">
            <h3 style="margin:0 0 16px;">8-Dimensional Feature Extractor</h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Block Height</label>
                <input type="number" id="feBlockHeight" value="24288271" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Block Size (bytes)</label>
                <input type="number" id="feBlockSize" value="357982" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Tx Count</label>
                <input type="number" id="feTxCount" value="539" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Timestamp</label>
                <input type="number" id="feTimestamp" value="1769060099" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
            </div>
            <button onclick="extractFeatures()" style="width:100%; padding:8px; background:#00aaff; border:none; color:#000; border-radius:4px; cursor:pointer; font-weight:600; font-size:12px; margin-bottom:12px;">Extract 8D Features</button>
            <div id="featureResults" style="font-family:monospace; font-size:11px; line-height:1.6;">
              <div style="color:var(--text-muted);">Enter block data and click extract...</div>
            </div>
          </div>
        </div>

        <div class="grid" style="grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:20px;">
          <!-- Transaction Validator -->
          <div class="card" style="padding:20px;">
            <h3 style="margin:0 0 16px;">Pattern-Based Transaction Validator</h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
              <div style="grid-column: span 2;">
                <label style="font-size:10px; color:var(--text-muted);">Transaction Hash</label>
                <input type="text" id="valTxHash" value="0x3f24edea34ce3078ebf95184eec058afaa776f3384fc74664c6057647c16c8c7" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:11px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Block Height</label>
                <input type="number" id="valBlockHeight" value="24288271" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Block Size</label>
                <input type="number" id="valBlockSize" value="357982" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Tx Count</label>
                <input type="number" id="valTxCount" value="539" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-muted);">Timestamp</label>
                <input type="number" id="valTimestamp" value="1769060099" style="width:100%; padding:6px; background:#0a0a0a; border:1px solid #333; border-radius:4px; color:var(--text-primary); font-size:12px;">
              </div>
            </div>
            <button onclick="validateTx()" style="width:100%; padding:8px; background:#00ff88; border:none; color:#000; border-radius:4px; cursor:pointer; font-weight:600; font-size:12px; margin-bottom:12px;">Validate Transaction</button>
            <div id="validationResults" style="font-family:monospace; font-size:11px; line-height:1.6;">
              <div style="color:var(--text-muted);">Enter transaction data and click validate...</div>
            </div>
          </div>

          <!-- Network Nodes -->
          <div class="card" style="padding:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
              <h3 style="margin:0;">Validator Network Nodes</h3>
              <button onclick="registerDemoNodes()" style="padding:6px 14px; background:#aa88ff; border:none; color:#000; border-radius:4px; cursor:pointer; font-weight:600; font-size:12px;">Add Demo Nodes</button>
            </div>
            <div id="nodesList" style="font-family:monospace; font-size:11px; line-height:1.6;">
              <div style="color:var(--text-muted);">Loading nodes...</div>
            </div>
          </div>
        </div>

        <!-- Tier Architecture Diagram -->
        <div class="card" style="padding:20px; margin-bottom:20px;">
          <h3 style="margin:0 0 16px;">Three-Tier Validator Architecture</h3>
          <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px;">
            <div style="border:1px solid #00aaff; border-radius:8px; padding:16px; text-align:center;">
              <div style="font-size:28px; margin-bottom:8px;">&#128241;</div>
              <div style="font-weight:700; color:#00aaff; margin-bottom:4px;">TIER 1: Mobile Validators</div>
              <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">Smartphones, Tablets, IoT</div>
              <div style="font-size:12px; line-height:1.6;">
                <div>Storage: <span style="color:#00ff88;">94 MB</span> pattern index</div>
                <div>Sync: <span style="color:#00ff88;">30 seconds</span></div>
                <div>Validation: <span style="color:#00ff88;">Pattern-based</span></div>
                <div>Role: <span style="color:#00aaff;">Independent validator</span></div>
              </div>
            </div>
            <div style="border:1px solid #aa88ff; border-radius:8px; padding:16px; text-align:center;">
              <div style="font-size:28px; margin-bottom:8px;">&#128187;</div>
              <div style="font-weight:700; color:#aa88ff; margin-bottom:4px;">TIER 2: Pattern Nodes</div>
              <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">Laptops, Desktops, Edge Servers</div>
              <div style="font-size:12px; line-height:1.6;">
                <div>Storage: <span style="color:#00ff88;">94 MB + recent blocks</span></div>
                <div>Sync: <span style="color:#00ff88;">Sub-second</span></div>
                <div>Validation: <span style="color:#00ff88;">Full pattern + recent</span></div>
                <div>Role: <span style="color:#aa88ff;">Aggregator + validator</span></div>
              </div>
            </div>
            <div style="border:1px solid #ff6b00; border-radius:8px; padding:16px; text-align:center;">
              <div style="font-size:28px; margin-bottom:8px;">&#127981;</div>
              <div style="font-weight:700; color:#ff6b00; margin-bottom:4px;">TIER 3: Archive Nodes</div>
              <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">Servers, Data Centers</div>
              <div style="font-size:12px; line-height:1.6;">
                <div>Storage: <span style="color:#00ff88;">Full chain + index</span></div>
                <div>Sync: <span style="color:#00ff88;">Full blockchain</span></div>
                <div>Validation: <span style="color:#00ff88;">Complete verification</span></div>
                <div>Role: <span style="color:#ff6b00;">Anomaly resolution</span></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Meta-Block Index -->
        <div class="card" style="padding:20px;">
          <h3 style="margin:0 0 16px;">Meta-Block Index</h3>
          <div id="metaBlockInfo" style="font-family:monospace; font-size:11px; line-height:1.6;">
            <div style="color:var(--text-muted);">Loading meta-block data...</div>
          </div>
        </div>
      </div>

    </main>

    <!-- Right Sidebar - Block Feed -->
    <aside class="block-feed">
      <div class="feed-header">
        <span class="feed-title">Live Blocks</span>
        <div class="feed-status">
          <div class="status-dot" id="feedDot"></div>
          <span id="feedStatus">Connecting...</span>
        </div>
      </div>
      <div class="feed-list" id="blockFeed">
        <div class="feed-list-inner" id="blockFeedInner">
          <div style="padding:20px; text-align:center; color:var(--text-muted); font-size:12px;">
            Waiting for blocks...
          </div>
        </div>
      </div>
    </aside>

    <!-- Right Sidebar - Active Trades -->
    <aside class="trades-feed">
      <div class="feed-header">
        <span class="feed-title">Active Trades</span>
        <div class="feed-status">
          <span id="tradeCount">0</span>
        </div>
      </div>
      <div class="trades-list" id="tradesFeed">
        <div class="trades-list-inner" id="tradesFeedInner">
          <div class="no-trades">
            Connect wallet to view trades
          </div>
        </div>
      </div>
    </aside>
  </div>

  <script>

    // Helper to safely set innerHTML
    const setEl = (id, html) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
      else console.warn('Element not found:', id);
    };

    // Tab switching
    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      const tabBtn = document.querySelector('.tab[data-tab="' + tabName + '"]');
      if (tabBtn) tabBtn.classList.add('active');
      const tabContent = document.getElementById('tab-' + tabName);
      if (tabContent) tabContent.classList.add('active');

      // Update sidebar nav active state
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const navItem = document.querySelector('.nav-item[data-page="' + tabName + '"]');
      if (navItem) navItem.classList.add('active');

      // Load data for specific tabs
      if (tabName === 'orders') loadOrdersTable();
      if (tabName === 'portfolio') loadPortfolio();
      if (tabName === 'predictions') { fetchPrediction(); fetchPredictionStats(); }
      if (tabName === 'alpha') { loadAlphaDashboard(); loadChatSuggestions(); }
    }

    // Sidebar nav click handlers
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        // Map sidebar pages to tabs
        const tabMap = {
          'home': 'dashboard',
          'signals': 'signals',
          'strategies': 'strategies',
          'blocks': 'dashboard',
          'mempool': 'mempool',
          'orders': 'orders',
          'portfolio': 'portfolio',
          'atlas': 'dashboard',
          'fingerprints': 'signals',
          'anomalies': 'signals',
          'history': 'orders',
          'predictions': 'predictions'
        };
        switchTab(tabMap[page] || 'dashboard');
      });
    });

    async function loadOrdersTable() {
      try {
        const res = await fetch('/trading-bot/swaps');
        const data = await res.json();
        const swaps = data.swaps || [];

        document.getElementById('ordersBadge').textContent = swaps.length;

        const rows = swaps.map(swap => {
          const isBuy = swap.fromToken === 'USDC';
          const time = new Date(swap.timestamp).toLocaleString();
          const shortTx = swap.txHash.slice(0, 10) + '...' + swap.txHash.slice(-6);
          return \`
            <tr style="border-bottom:1px solid #222;">
              <td style="padding:10px 8px; color:#888;">\${time}</td>
              <td style="padding:10px 8px; color:var(--accent);">\${swap.fromToken} → \${swap.toToken}</td>
              <td style="padding:10px 8px;"><span style="padding:3px 8px; background:\${isBuy ? '#00ff8822' : '#ff6b6b22'}; color:\${isBuy ? '#00ff88' : '#ff6b6b'}; font-size:11px;">\${isBuy ? 'BUY' : 'SELL'}</span></td>
              <td style="padding:10px 8px;">\${swap.amountIn} \${swap.fromToken}</td>
              <td style="padding:10px 8px;"><span style="color:#00ff88;">✓ Confirmed</span></td>
              <td style="padding:10px 8px;"><a href="https://sepolia.etherscan.io/tx/\${swap.txHash}" target="_blank" style="color:var(--accent); text-decoration:none;">\${shortTx}</a></td>
            </tr>
          \`;
        }).join('');

        document.getElementById('ordersTableBody').innerHTML = rows || '<tr><td colspan="6" style="padding:20px; text-align:center; color:#666;">No trades yet</td></tr>';
      } catch (e) {
        console.error('Failed to load orders:', e);
      }
    }

    async function fetchSignals() {
      try {
        const res = await fetch('/trading-bot/signals');
        const data = await res.json();

        if (data.error || data.status === 'insufficient_data') {
          setEl('signals', '<p class="no-signal">' + (data.message || data.error || 'Loading...') + '</p>');
          return;
        }

        if (!data.signals || !data.market) {
          setEl('signals', '<p class="no-signal">Waiting for data...</p>');
          return;
        }

        // Live Prices
        const m = data.market;
        setEl('prices', \`
          <div class="metric">
            <span class="metric-label">ETH/USD</span>
            <span class="metric-value" style="color: #00ff88;">$\${m.ethPrice.toFixed(2)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">SOL/USD</span>
            <span class="metric-value" style="color: #9945FF;">$\${m.solPrice.toFixed(2)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">BTC/USD</span>
            <span class="metric-value" style="color: #f7931a;">$\${(m.btcPrice || 0).toFixed(0)}</span>
          </div>
        \`);

        // Market Scores
        const bullScore = Math.round(m.bullishScore || 50);
        const riskScoreVal = Math.round(m.riskScore || 50);
        const bullColor = bullScore >= 60 ? '#00ff88' : bullScore <= 40 ? '#ff4444' : '#ffaa00';
        const riskColor = riskScoreVal >= 60 ? '#ff4444' : riskScoreVal <= 40 ? '#00ff88' : '#ffaa00';
        setEl('scores', \`
          <div class="metric">
            <span class="metric-label">Bullish Score</span>
            <span class="metric-value" style="color: \${bullColor};">\${bullScore}/100</span>
          </div>
          <div class="metric">
            <span class="metric-label">Risk Score</span>
            <span class="metric-value" style="color: \${riskColor};">\${riskScoreVal}/100</span>
          </div>
          <div class="metric">
            <span class="metric-label">Volatility</span>
            <span class="metric-value">\${((m.volatility || 0) * 100).toFixed(0)}%</span>
          </div>
        \`);

        // Fear/Greed
        const fgColor = m.fearGreedIndex < 30 ? '#ff4444' : m.fearGreedIndex > 70 ? '#00ff88' : '#ffaa00';
        const fgWidth = m.fearGreedIndex + '%';
        setEl('feargreed', \`
          <div class="metric">
            <span class="metric-label">Index</span>
            <span class="metric-value" style="color: \${fgColor};">\${m.fearGreedIndex}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Label</span>
            <span class="metric-value" style="color: \${fgColor};">\${m.fearGreedLabel}</span>
          </div>
          <div class="correlation-bar" style="margin-top: 10px;">
            <div style="height: 100%; width: \${fgWidth}; background: linear-gradient(90deg, #ff4444, #ffaa00, #00ff88);"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #555; margin-top: 5px;">
            <span>Fear</span><span>Neutral</span><span>Greed</span>
          </div>
        \`);

        // On-Chain Signals
        const s = data.signals;
        const sentimentClass = 'sentiment-' + s.sentiment;
        setEl('signals', \`
          <div class="metric">
            <span class="metric-label">Behavioral Sentiment</span>
            <span class="metric-value \${sentimentClass}">\${s.sentiment.toUpperCase()}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Drift Velocity</span>
            <span class="metric-value">\${s.driftVelocity.toFixed(3)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Anomaly Score</span>
            <span class="metric-value">\${(s.anomalyScore * 100).toFixed(0)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">Confidence</span>
            <span class="metric-value">\${(s.confidence * 100).toFixed(0)}%</span>
          </div>
        \`);

        // Cross-chain
        if (data.crossChain && data.crossChain.length > 0) {
          const cc = data.crossChain[0];
          const corrPercent = ((cc.correlation + 1) / 2 * 100).toFixed(0);
          setEl('crosschain', \`
            <div class="metric">
              <span class="metric-label">Pair</span>
              <span class="metric-value">\${cc.pair}</span>
            </div>
            <div class="metric">
              <span class="metric-label">Correlation</span>
              <span class="metric-value">\${cc.correlation.toFixed(3)}</span>
            </div>
            <div class="correlation-bar">
              <div class="correlation-fill" style="width: \${corrPercent}%"></div>
            </div>
            <div class="metric">
              <span class="metric-label">Lag</span>
              <span class="metric-value">\${cc.lag} blocks</span>
            </div>
            <div class="metric">
              <span class="metric-label">Lead Chain</span>
              <span class="metric-value">\${cc.leadChain || 'None'}</span>
            </div>
          \`);
        } else {
          setEl('crosschain', '<p class="no-signal">No cross-chain data</p>');
        }

        // Market Structure - skipped (no element)

        // Derivatives
        const fundingColor = (m.btcFunding || 0) > 20 ? '#ff4444' : (m.btcFunding || 0) < -10 ? '#00ff88' : '#888';
        setEl('derivatives', \`
          <div class="metric">
            <span class="metric-label">BTC Funding</span>
            <span class="metric-value" style="color: \${fundingColor};">\${(m.btcFunding || 0).toFixed(1)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">ETH Funding</span>
            <span class="metric-value" style="color: \${fundingColor};">\${(m.ethFunding || 0).toFixed(1)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">Extreme Funding</span>
            <span class="metric-value">\${m.fundingExtreme ? '<span style="color:#ff4444;">YES</span>' : '<span style="color:#555;">No</span>'}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Leverage Risk</span>
            <span class="metric-value" style="color: \${(m.leverageRisk || 0) > 0.6 ? '#ff4444' : '#888'};">\${((m.leverageRisk || 0) * 100).toFixed(0)}%</span>
          </div>
        \`);

        // Flows
        const flowColor = (m.smartMoneyFlow || 0) > 0 ? '#00ff88' : (m.smartMoneyFlow || 0) < 0 ? '#ff4444' : '#888';
        setEl('flows', \`
          <div class="metric">
            <span class="metric-label">Smart Money Flow</span>
            <span class="metric-value" style="color: \${flowColor};">\${((m.smartMoneyFlow || 0) * 100).toFixed(0)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">Retail FOMO</span>
            <span class="metric-value" style="color: \${(m.retailFomo || 0) > 0.5 ? '#ffaa00' : '#555'};">\${((m.retailFomo || 0) * 100).toFixed(0)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">Liquidations 24h</span>
            <span class="metric-value">$\${((m.liquidations24h || 0) / 1e6).toFixed(1)}M</span>
          </div>
          <div class="metric">
            <span class="metric-label">Long/Short Ratio</span>
            <span class="metric-value">\${(m.liquidationRatio || 1).toFixed(2)}</span>
          </div>
        \`);

        // Strategies with Execute buttons
        if (data.strategies && data.strategies.length > 0) {
          // Store strategies globally for execution
          window.currentStrategies = data.strategies;
          window.currentMarket = data.market;

          // Count active signals and update sidebar badge
          const activeCount = data.strategies.filter(s => s.active).length;
          updateSignalCount(activeCount);

          setEl('strategies', data.strategies.map((st, idx) => \`
            <div class="strategy \${st.active ? 'active' : 'inactive'}">
              <div class="strategy-header">
                <span class="strategy-name">\${st.name}</span>
                <span class="strategy-signal \${st.active ? 'signal-active' : ''}">\${st.signal}</span>
              </div>
              <div class="strategy-reason">\${st.reason} (conf: \${(st.confidence * 100).toFixed(0)}%)</div>
              <div class="strategy-actions">
                <button class="execute-btn" data-strategy="\${idx}" onclick="executeStrategy(\${idx}, this)" \${!walletAddress ? 'disabled title="Connect wallet first"' : ''} \${!st.active ? 'disabled title="Strategy not active"' : ''}>
                  \${st.active ? 'Execute' : 'Waiting'}
                </button>
                <span class="trade-amount">\${st.active ? '0.01 ETH' : ''}</span>
              </div>
            </div>
          \`).join(''));
        } else {
          setEl('strategies', '<p class="no-signal">No active signals - monitoring... (23 strategies watching)</p>');
          updateSignalCount(0);
        }

        // Update Signals Tab
        const sentimentColor = s.sentiment === 'bullish' ? 'bullish' : s.sentiment === 'bearish' ? 'bearish' : 'neutral';
        setEl('signalRegime', \`
          <div class="signal-item">
            <span class="signal-label">Overall Sentiment</span>
            <span class="signal-value \${sentimentColor}">\${s.sentiment.toUpperCase()}</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">Confidence</span>
            <span class="signal-value">\${(s.confidence * 100).toFixed(0)}%</span>
          </div>
          <div class="signal-bar"><div class="signal-bar-fill" style="width:\${s.confidence * 100}%;background:var(--accent);"></div></div>
        \`);

        const driftColor = s.driftVelocity > 0.3 ? 'warning' : s.driftVelocity > 0.5 ? 'bearish' : 'neutral';
        setEl('signalDrift', \`
          <div class="signal-item">
            <span class="signal-label">Drift Velocity</span>
            <span class="signal-value \${driftColor}">\${(s.driftVelocity * 100).toFixed(1)}%</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">Accelerating</span>
            <span class="signal-value \${s.driftAccelerating ? 'warning' : 'neutral'}">\${s.driftAccelerating ? 'YES' : 'No'}</span>
          </div>
          <div class="signal-bar"><div class="signal-bar-fill" style="width:\${Math.min(s.driftVelocity * 200, 100)}%;background:\${s.driftVelocity > 0.3 ? '#ffaa00' : '#555'};"></div></div>
        \`);

        const anomalyColor = s.anomalyScore > 0.7 ? 'bearish' : s.anomalyScore > 0.4 ? 'warning' : 'bullish';
        setEl('signalAnomaly', \`
          <div class="signal-item">
            <span class="signal-label">Anomaly Score</span>
            <span class="signal-value \${anomalyColor}">\${(s.anomalyScore * 100).toFixed(0)}%</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">Is Outlier</span>
            <span class="signal-value \${s.isOutlier ? 'bearish' : 'bullish'}">\${s.isOutlier ? 'YES' : 'No'}</span>
          </div>
          <div class="signal-bar"><div class="signal-bar-fill" style="width:\${s.anomalyScore * 100}%;background:\${anomalyColor === 'bearish' ? '#ff4444' : anomalyColor === 'warning' ? '#ffaa00' : '#00ff88'};"></div></div>
        \`);

        if (data.crossChain && data.crossChain.length > 0) {
          const cc = data.crossChain[0];
          const corrColor = Math.abs(cc.correlation) > 0.7 ? 'bullish' : Math.abs(cc.correlation) > 0.4 ? 'neutral' : 'warning';
          setEl('signalCrossChain', \`
            <div class="signal-item">
              <span class="signal-label">Pair</span>
              <span class="signal-value">\${cc.pair.toUpperCase()}</span>
            </div>
            <div class="signal-item">
              <span class="signal-label">Correlation</span>
              <span class="signal-value \${corrColor}">\${cc.correlation.toFixed(3)}</span>
            </div>
            <div class="signal-item">
              <span class="signal-label">Lag</span>
              <span class="signal-value">\${cc.lag} blocks</span>
            </div>
            <div class="signal-item">
              <span class="signal-label">Lead Chain</span>
              <span class="signal-value" style="color:var(--accent);">\${(cc.leadChain || 'none').toUpperCase()}</span>
            </div>
          \`);
        } else {
          setEl('signalCrossChain', '<div class="signal-item"><span class="signal-label">No cross-chain data available</span></div>');
        }

        const emergingTags = s.emergingTags || [];
        const decliningTags = s.decliningTags || [];
        setEl('signalTags', \`
          <div class="signal-item" style="flex-direction:column;align-items:flex-start;">
            <span class="signal-label" style="margin-bottom:8px;">Emerging Tags</span>
            <div class="tag-list">\${emergingTags.length > 0 ? emergingTags.map(t => '<span class="tag-emerging">' + t + '</span>').join('') : '<span class="signal-value neutral">None</span>'}</div>
          </div>
          <div class="signal-item" style="flex-direction:column;align-items:flex-start;">
            <span class="signal-label" style="margin-bottom:8px;">Declining Tags</span>
            <div class="tag-list">\${decliningTags.length > 0 ? decliningTags.map(t => '<span class="tag-declining">' + t + '</span>').join('') : '<span class="signal-value neutral">None</span>'}</div>
          </div>
        \`);

        // Update signal count in tab - sync with sidebar (active strategies count)
        const activeStrategiesCount = window.currentStrategies?.filter(st => st.active).length || 0;
        const signalTabBadge = document.getElementById('signalCountTab');
        if (signalTabBadge) signalTabBadge.textContent = activeStrategiesCount;

        // Update time
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

      } catch (err) {
        console.error('Fetch error:', err);
        setEl('signals', '<p class="no-signal">Error: ' + err.message + '</p>');
      }
    }

    // Wallet connection - Sepolia Testnet with WalletConnect support
    const SEPOLIA_CHAIN_ID = 11155111;
    const SEPOLIA_RPC = 'https://rpc.sepolia.org';
    const WALLET_CONNECT_PROJECT_ID = 'c4f79cc821d89e2f7b618e0b018b0c91'; // Public project ID for demo

    let provider = null;
    let signer = null;
    let walletAddress = null;
    let wcProvider = null;
    let connectionType = null; // 'metamask', 'walletconnect', or 'server'
    let serverWalletAddress = null;
    let serverWalletBalance = null;
    let serverWalletAvailable = false;

    // Check server wallet status
    async function checkServerWallet() {
      try {
        const res = await fetch('/trading-bot/wallet-status');
        const data = await res.json();
        serverWalletAvailable = data.serverWalletConfigured;
        serverWalletAddress = data.serverWalletAddress;
        serverWalletBalance = data.serverWalletBalance;
        if (serverWalletAvailable) {
          console.log('Server wallet available:', serverWalletAddress, 'Balance:', serverWalletBalance);
          updateServerWalletUI();
        }
      } catch (e) {
        console.log('Server wallet check failed:', e);
      }
    }

    function updateServerWalletUI() {
      const connectBtn = document.getElementById('connectBtn');
      if (serverWalletAvailable && !walletAddress) {
        connectBtn.textContent = 'Private Mode';
        connectBtn.style.borderColor = 'var(--accent)';
      }
    }

    function useServerWallet() {
      walletAddress = serverWalletAddress;
      connectionType = 'server';
      const connectBtn = document.getElementById('connectBtn');
      const balDisplay = serverWalletBalance ? parseFloat(serverWalletBalance).toFixed(4) + ' ETH' : '';
      connectBtn.innerHTML = 'Private: ' + serverWalletAddress.slice(0, 6) + '...' + serverWalletAddress.slice(-4) + (balDisplay ? ' (' + balDisplay + ')' : '');
      connectBtn.style.background = 'var(--accent)';
      connectBtn.style.color = '#000';
      connectBtn.style.borderColor = 'var(--accent)';
      setEl('walletInfo', '<div style="color:var(--accent); font-size:12px;">PRIVATE MODE</div><div style="font-size:11px; color:var(--text-muted);">Auto-trade ready' + (balDisplay ? ' - ' + balDisplay : '') + '</div>');
      saveConnection('server', serverWalletAddress);
      loadUserOrders();
    }

    // Check for saved connection on page load
    async function checkSavedConnection() {
      const saved = localStorage.getItem('walletConnection');

      // If server wallet available and no saved connection, auto-connect to server
      if (!saved && serverWalletAvailable) {
        useServerWallet();
        return;
      }

      if (!saved) return;

      try {
        const { type, address } = JSON.parse(saved);
        if (type === 'server' && serverWalletAvailable) {
          // Restore server wallet connection
          useServerWallet();
        } else if (type === 'metamask' && window.ethereum) {
          // Try to reconnect to MetaMask silently
          const accounts = await window.ethereum.request({ method: 'eth_accounts' });
          if (accounts.length > 0 && accounts[0].toLowerCase() === address.toLowerCase()) {
            await connectWithMetaMask(true); // silent = true
          }
        } else if (type === 'walletconnect') {
          // WalletConnect persists its own session
          await connectWithWalletConnect(true);
        }
      } catch (e) {
        console.log('Could not restore wallet connection:', e);
        localStorage.removeItem('walletConnection');
        // Fall back to server wallet if available
        if (serverWalletAvailable) {
          useServerWallet();
        }
      }
    }

    // Save connection to localStorage
    function saveConnection(type, address) {
      localStorage.setItem('walletConnection', JSON.stringify({ type, address }));
      connectionType = type;
    }

    // Clear connection
    function clearConnection() {
      localStorage.removeItem('walletConnection');
      walletAddress = null;
      signer = null;
      provider = null;
      connectionType = null;
      if (wcProvider) {
        wcProvider.disconnect();
        wcProvider = null;
      }
    }

    // Connect with MetaMask/injected wallet
    async function connectWithMetaMask(silent = false) {
      if (typeof window.ethereum === 'undefined') {
        if (!silent) alert('MetaMask not found! Try WalletConnect instead.');
        return false;
      }

      try {
        // Request accounts
        const accounts = silent
          ? await window.ethereum.request({ method: 'eth_accounts' })
          : await window.ethereum.request({ method: 'eth_requestAccounts' });

        if (accounts.length === 0) return false;

        // Switch to Sepolia
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x' + SEPOLIA_CHAIN_ID.toString(16) }],
          });
        } catch (switchError) {
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: '0x' + SEPOLIA_CHAIN_ID.toString(16),
                chainName: 'Sepolia Testnet',
                nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                rpcUrls: [SEPOLIA_RPC],
                blockExplorerUrls: ['https://sepolia.etherscan.io']
              }],
            });
          }
        }

        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        walletAddress = await signer.getAddress();

        saveConnection('metamask', walletAddress);
        await updateWalletUI();

        try {
          window.ethereum.on('accountsChanged', () => { clearConnection(); location.reload(); });
          window.ethereum.on('chainChanged', () => location.reload());
        } catch (e) {
          console.warn('Could not add wallet listeners:', e);
        }

        return true;
      } catch (err) {
        console.error('MetaMask connection failed:', err);
        if (!silent) alert('Connection failed: ' + err.message);
        return false;
      }
    }

    // Connect with WalletConnect
    async function connectWithWalletConnect(silent = false) {
      try {
        wcProvider = new WalletConnectProvider.default({
          rpc: { [SEPOLIA_CHAIN_ID]: SEPOLIA_RPC },
          chainId: SEPOLIA_CHAIN_ID,
          qrcode: !silent,
        });

        // Check if already connected
        if (silent && !wcProvider.connected) {
          return false;
        }

        await wcProvider.enable();

        provider = new ethers.BrowserProvider(wcProvider);
        signer = await provider.getSigner();
        walletAddress = await signer.getAddress();

        saveConnection('walletconnect', walletAddress);
        await updateWalletUI();

        try {
          wcProvider.on('accountsChanged', () => { clearConnection(); location.reload(); });
          wcProvider.on('chainChanged', () => location.reload());
          wcProvider.on('disconnect', () => { clearConnection(); location.reload(); });
        } catch (e) {
          console.warn('Could not add WalletConnect listeners:', e);
        }

        return true;
      } catch (err) {
        console.error('WalletConnect failed:', err);
        if (!silent) alert('WalletConnect failed: ' + err.message);
        return false;
      }
    }

    // Update wallet UI after connection
    async function updateWalletUI() {
      const balance = await provider.getBalance(walletAddress);
      const network = await provider.getNetwork();

      if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        alert('Please switch to Sepolia testnet in your wallet!');
        return;
      }

      document.getElementById('connectBtn').textContent = walletAddress.slice(0, 6) + '...' + walletAddress.slice(-4);
      document.getElementById('connectBtn').classList.add('connected');
      document.getElementById('connectBtn').onclick = disconnectWallet;

      document.getElementById('walletInfo').style.display = 'block';
      document.getElementById('walletAddress').textContent = walletAddress;
      document.getElementById('walletBalance').textContent = parseFloat(ethers.formatEther(balance)).toFixed(4) + ' SepoliaETH';
      document.getElementById('walletNetwork').textContent = 'Sepolia (' + (connectionType === 'walletconnect' ? 'WC' : 'MM') + ')';

      if (parseFloat(ethers.formatEther(balance)) < 0.01) {
        document.getElementById('walletNetwork').innerHTML += ' <a href="https://sepoliafaucet.com" target="_blank" style="color:#00ff88;">[Faucet]</a>';
      }

      loadUserOrders();
    }

    // Disconnect wallet
    function disconnectWallet() {
      clearConnection();
      document.getElementById('connectBtn').textContent = 'Connect Wallet';
      document.getElementById('connectBtn').classList.remove('connected');
      document.getElementById('connectBtn').onclick = connectWallet;
      document.getElementById('walletInfo').style.display = 'none';
      document.getElementById('orders').innerHTML = '<p class="no-signal">Connect wallet to view orders</p>';
    }

    // Main connect function - shows options
    async function connectWallet() {
      // Show connection options modal
      const choice = await showWalletModal();
      if (choice === 'metamask') {
        await connectWithMetaMask();
      } else if (choice === 'walletconnect') {
        await connectWithWalletConnect();
      } else if (choice === 'server') {
        useServerWallet();
      }
    }

    // Simple modal for wallet selection
    function showWalletModal() {
      return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:1000;';

        const serverWalletBtn = serverWalletAvailable ? \`
            <button id="serverBtn" style="width:100%;padding:15px;margin:8px 0;background:#1a1a1a;border:1px solid var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;">🤖</span>
              <span style="flex:1;text-align:left;">
                <div>Server Wallet (Auto-Trade)</div>
                <div style="font-size:10px;color:var(--text-muted);">\${serverWalletAddress.slice(0,6)}...\${serverWalletAddress.slice(-4)}</div>
              </span>
            </button>
        \` : '';

        modal.innerHTML = \`
          <div style="background:#111;border:1px solid #333;padding:30px;max-width:350px;width:90%;">
            <h3 style="color:#00ff88;margin-bottom:20px;text-align:center;">Connect Wallet</h3>
            \${serverWalletBtn}
            <button id="mmBtn" style="width:100%;padding:15px;margin:8px 0;background:#1a1a1a;border:1px solid #333;color:#fff;cursor:pointer;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;">🦊</span>
              <span>MetaMask / Browser</span>
            </button>
            <button id="wcBtn" style="width:100%;padding:15px;margin:8px 0;background:#1a1a1a;border:1px solid #333;color:#fff;cursor:pointer;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;">📱</span>
              <span>WalletConnect</span>
            </button>
            <button id="cancelBtn" style="width:100%;padding:10px;margin-top:15px;background:transparent;border:1px solid #444;color:#888;cursor:pointer;">Cancel</button>
          </div>
        \`;
        document.body.appendChild(modal);

        modal.querySelector('#mmBtn').onclick = () => { document.body.removeChild(modal); resolve('metamask'); };
        modal.querySelector('#wcBtn').onclick = () => { document.body.removeChild(modal); resolve('walletconnect'); };
        if (serverWalletAvailable) {
          modal.querySelector('#serverBtn').onclick = () => { document.body.removeChild(modal); resolve('server'); };
        }
        modal.querySelector('#cancelBtn').onclick = () => { document.body.removeChild(modal); resolve(null); };
        modal.onclick = (e) => { if (e.target === modal) { document.body.removeChild(modal); resolve(null); } };
      });
    }

    // Check for server wallet first, then auto-reconnect
    checkServerWallet().then(() => {
      checkSavedConnection();
    });

    // Fetch social sentiment
    async function fetchSentiment() {
      try {
        const res = await fetch('/trading-bot/sentiment');
        const data = await res.json();

        const sentColor = data.overall > 0.2 ? '#00ff88' : data.overall < -0.2 ? '#ff4444' : '#888';
        document.getElementById('social').innerHTML = \`
          <div class="metric">
            <span class="metric-label">Overall</span>
            <span class="metric-value" style="color:\${sentColor};">\${data.overallLabel.replace('_',' ').toUpperCase()}</span>
          </div>
          <div class="metric">
            <span class="metric-label">BTC Sentiment</span>
            <span class="metric-value">\${((data.btc?.sentiment || 0) * 100).toFixed(0)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">ETH Sentiment</span>
            <span class="metric-value">\${((data.eth?.sentiment || 0) * 100).toFixed(0)}%</span>
          </div>
          <div class="metric">
            <span class="metric-label">FOMO/FUD</span>
            <span class="metric-value">\${data.signals?.fomoDetected ? '<span style="color:#00ff88;">FOMO</span>' : data.signals?.fudDetected ? '<span style="color:#ff4444;">FUD</span>' : '<span style="color:#555;">None</span>'}</span>
          </div>
        \`;
      } catch (e) {
        document.getElementById('social').innerHTML = '<p class="no-signal">Loading...</p>';
      }
    }

    // Fetch multi-chain data
    async function fetchChains() {
      try {
        const res = await fetch('/trading-bot/chains');
        const data = await res.json();

        const topChains = (data.chains || []).sort((a,b) => b.tvl - a.tvl).slice(0, 5);
        document.getElementById('chains').innerHTML = topChains.map(c => \`
          <div class="metric">
            <span class="metric-label">\${c.chain.charAt(0).toUpperCase() + c.chain.slice(1)}</span>
            <span class="metric-value">$\${(c.tvl / 1e9).toFixed(1)}B</span>
          </div>
        \`).join('');

        // Gas prices
        const gas = data.gas || {};
        document.getElementById('gas').innerHTML = \`
          <div class="metric">
            <span class="metric-label">Ethereum</span>
            <span class="metric-value">\${gas.chains?.ethereum?.standard || 0} gwei</span>
          </div>
          <div class="metric">
            <span class="metric-label">Cheapest</span>
            <span class="metric-value" style="color:#00ff88;">\${gas.cheapestChain || 'base'}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Avg Cost</span>
            <span class="metric-value">$\${(gas.avgCost || 0).toFixed(2)}</span>
          </div>
        \`;

        // Stablecoins
        const stable = data.stablecoins || {};
        document.getElementById('stablecoins').innerHTML = \`
          <div class="metric">
            <span class="metric-label">Total Supply</span>
            <span class="metric-value">$\${((stable.totalSupply || 0) / 1e9).toFixed(0)}B</span>
          </div>
          <div class="metric">
            <span class="metric-label">USDT</span>
            <span class="metric-value">$\${((stable.usdt?.supply || 0) / 1e9).toFixed(0)}B</span>
          </div>
          <div class="metric">
            <span class="metric-label">USDC</span>
            <span class="metric-value">$\${((stable.usdc?.supply || 0) / 1e9).toFixed(0)}B</span>
          </div>
        \`;

        // Signals
        if (data.signals?.l2Migration) {
          document.getElementById('chains').innerHTML += '<div class="metric"><span style="color:#9945FF;">L2 MIGRATION ACTIVE</span></div>';
        }
      } catch (e) {
        document.getElementById('chains').innerHTML = '<p class="no-signal">Loading...</p>';
      }
    }

    // Contract constants
    const VAULT_ADDRESS = '0x5bbb244ef4F39c594F3f509917957534753D2819';
    const VAULT_ABI = [
      'function createOrder(bytes32 pythPriceFeedId, uint8 conditionType, int64 targetPrice, uint256 duration, uint256 destChainId, bytes destAddress, bytes destToken) external payable returns (bytes32)',
      'function cancelOrder(bytes32 orderId) external',
      'function orders(bytes32) view returns (address user, uint256 amount, bytes32 pythPriceFeedId, uint8 conditionType, int64 targetPrice, uint256 expiry, uint256 destChainId, bytes destAddress, bytes destToken, uint8 status, uint256 createdAt, uint256 executedAt, bytes32 intentId)',
      'event OrderCreated(bytes32 indexed orderId, address indexed user, uint256 amount)',
    ];
    const PYTH_FEEDS = {
      ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    };
    const TRADE_AMOUNT = ethers.parseEther('0.01');
    let userOrders = [];
    let autoTradeEnabled = false;
    let autoRebalanceEnabled = false;
    let lastRebalanceTime = 0;
    const REBALANCE_INTERVAL = 60000; // Check every 60 seconds
    const REBALANCE_THRESHOLD = 10; // Only rebalance if >10% off target

    // Execute a strategy
    async function executeStrategy(strategyIndex, buttonElement) {
      if (!walletAddress) {
        alert('Please connect your wallet first!');
        return;
      }

      const strategy = window.currentStrategies[strategyIndex];
      if (!strategy) return;

      // Always fetch fresh market data before executing
      let market;
      try {
        const res = await fetch('/trading-bot/signals');
        const data = await res.json();
        market = data.market;
        window.currentMarket = market;
        console.log('Fetched fresh market data:', market);
      } catch (e) {
        alert('Failed to get market prices: ' + e.message);
        return;
      }

      if (!market || !market.ethPrice) {
        alert('Market data unavailable. Please try again.');
        return;
      }

      // Determine parameters from strategy
      const isBuy = strategy.signal.includes('BUY');
      const asset = strategy.signal.includes('SOL') ? 'SOL' : (strategy.signal.includes('BTC') ? 'BTC' : 'ETH');
      const currentPrice = asset === 'SOL' ? market.solPrice : (asset === 'BTC' ? market.btcPrice : market.ethPrice);

      console.log('Trade params:', { asset, isBuy, currentPrice, market });

      if (!currentPrice || currentPrice <= 0) {
        alert('Invalid price for ' + asset + ': ' + currentPrice);
        return;
      }

      const targetPrice = isBuy
        ? currentPrice * 0.98 // Buy 2% below
        : currentPrice * 1.02; // Sell 2% above
      const duration = 3600; // 1 hour

      console.log('Execute:', { asset, isBuy, currentPrice, targetPrice });

      // Get button element
      const btn = buttonElement || document.querySelector(\`button[data-strategy="\${strategyIndex}"]\`);

      // Use server wallet for execution (no signing needed)
      if (connectionType === 'server') {
        try {
          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Executing...';
          }

          const res = await fetch('/trading-bot/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset, isBuy, targetPrice, duration })
          });

          const result = await res.json();
          if (!res.ok) throw new Error(result.error);

          if (btn) {
            btn.textContent = 'Done!';
            setTimeout(() => { btn.textContent = 'Execute'; btn.disabled = false; }, 2000);
          }

          console.log('Server trade executed:', result);
          loadUserOrders();
          return;

        } catch (err) {
          console.error('Server trade failed:', err);
          alert('Trade failed: ' + err.message);
          if (btn) {
            btn.textContent = 'Execute';
            btn.disabled = false;
          }
          return;
        }
      }

      // Browser wallet execution (requires signer)
      if (!signer) {
        alert('Please connect your wallet first!');
        return;
      }

      const pythFeed = PYTH_FEEDS[asset];
      const conditionType = isBuy ? 0 : 1; // 0 = PRICE_BELOW, 1 = PRICE_ABOVE
      const targetPriceBigInt = BigInt(Math.round(targetPrice * 1e8));

      try {
        const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);

        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Signing...';
        }

        const tx = await vault.createOrder(
          pythFeed,
          conditionType,
          targetPriceBigInt,
          duration,
          11155111, // Sepolia
          ethers.toUtf8Bytes(walletAddress),
          ethers.toUtf8Bytes(asset),
          { value: TRADE_AMOUNT }
        );

        if (btn) btn.textContent = 'Confirming...';
        const receipt = await tx.wait();

        if (btn) {
          btn.textContent = 'Done!';
          setTimeout(() => { btn.textContent = 'Execute'; btn.disabled = false; }, 2000);
        }

        alert('Order created! TX: ' + tx.hash);
        loadUserOrders();

      } catch (err) {
        console.error('Trade failed:', err);
        alert('Trade failed: ' + (err.reason || err.message));
        if (btn) {
          btn.textContent = 'Execute';
          btn.disabled = false;
        }
      }
    }

    // Load user's orders from blockchain events
    let userTrades = [];

    async function loadUserOrders() {
      const tradesInner = document.getElementById('tradesFeedInner');

      if (!walletAddress) {
        document.getElementById('orders').innerHTML = '<p class="no-signal">Connect wallet to view orders</p>';
        tradesInner.innerHTML = '<div class="no-trades">Connect wallet to view trades</div>';
        document.getElementById('tradeCount').textContent = '0';
        return;
      }

      // Server mode - fetch swap history
      if (connectionType === 'server') {
        try {
          const res = await fetch('/trading-bot/swaps');
          const data = await res.json();
          const swaps = data.swaps || [];

          document.getElementById('tradeCount').textContent = swaps.length;

          if (swaps.length === 0) {
            document.getElementById('orders').innerHTML = \`
              <div class="metric">
                <span class="metric-label">Private Wallet</span>
                <span class="metric-value" style="color:var(--accent);">\${walletAddress.slice(0,6)}...\${walletAddress.slice(-4)}</span>
              </div>
              <p style="color:#888; font-size:11px; margin-top:10px;">No swaps yet.</p>
              <p style="color:#00ff88; font-size:11px;">Enable Auto-Trade or execute strategies.</p>
            \`;
            tradesInner.innerHTML = '<div class="no-trades" style="color:var(--accent);">Private Mode Active<br><span style="color:#888;">No swaps yet</span></div>';
          } else {
            // Build swap table
            let ordersHtml = \`
              <div style="max-height:220px; overflow-y:auto;">
                <table style="width:100%; border-collapse:collapse; font-size:11px;">
                  <thead>
                    <tr style="color:#888; text-align:left; border-bottom:1px solid #333;">
                      <th style="padding:4px 6px;">Pair</th>
                      <th style="padding:4px 6px;">Amount</th>
                      <th style="padding:4px 6px;">TX</th>
                      <th style="padding:4px 6px;">Time</th>
                    </tr>
                  </thead>
                  <tbody>
            \`;
            for (const swap of swaps.slice(0, 10)) {
              const shortTx = swap.txHash.slice(0, 8) + '...';
              const time = new Date(swap.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
              ordersHtml += \`
                <tr style="border-bottom:1px solid #222;">
                  <td style="padding:5px 6px; color:var(--accent);">\${swap.fromToken}→\${swap.toToken}</td>
                  <td style="padding:5px 6px; color:#ccc;">\${swap.amountIn}</td>
                  <td style="padding:5px 6px;"><a href="https://sepolia.etherscan.io/tx/\${swap.txHash}" target="_blank" style="color:#888; text-decoration:none;">\${shortTx}</a></td>
                  <td style="padding:5px 6px; color:#666;">\${time}</td>
                </tr>
              \`;
            }
            ordersHtml += '</tbody></table></div>';
            document.getElementById('orders').innerHTML = ordersHtml;

            // Update trades feed with cards
            tradesInner.innerHTML = swaps.slice(0, 15).map(swap => {
              const isBuy = swap.fromToken === 'USDC';
              const shortTx = swap.txHash.slice(0, 8) + '...';
              const time = new Date(swap.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
              return \`
                <div class="trade-item visible" style="padding:10px; margin-bottom:8px; background:#1a1a1a; border-left:3px solid \${isBuy ? '#00ff88' : '#ff6b6b'};">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:var(--accent); font-weight:500;">\${swap.fromToken} → \${swap.toToken}</span>
                    <span style="font-size:10px; padding:2px 6px; background:\${isBuy ? '#00ff8822' : '#ff6b6b22'}; color:\${isBuy ? '#00ff88' : '#ff6b6b'};">\${isBuy ? 'BUY' : 'SELL'}</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:11px; color:#888;">
                    <span>\${swap.amountIn} \${swap.fromToken}</span>
                    <span>\${time}</span>
                  </div>
                  <div style="margin-top:4px;">
                    <a href="https://sepolia.etherscan.io/tx/\${swap.txHash}" target="_blank" style="font-size:10px; color:#666;">\${shortTx}</a>
                  </div>
                </div>
              \`;
            }).join('');
          }
        } catch (e) {
          console.error('Failed to load swaps:', e);
          tradesInner.innerHTML = '<div class="no-trades">Error loading swaps</div>';
        }
        return;
      }

      if (!provider) {
        document.getElementById('orders').innerHTML = '<p class="no-signal">Connect wallet to view orders</p>';
        tradesInner.innerHTML = '<div class="no-trades">Connect wallet to view trades</div>';
        document.getElementById('tradeCount').textContent = '0';
        return;
      }

      try {
        const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

        // Query OrderCreated events for this user
        const filter = vault.filters.OrderCreated(null, walletAddress);
        const events = await vault.queryFilter(filter, -10000); // Last ~10k blocks

        // Update trade count
        document.getElementById('tradeCount').textContent = events.length;

        if (events.length === 0) {
          document.getElementById('orders').innerHTML = \`
            <div class="metric">
              <span class="metric-label">Wallet</span>
              <span class="metric-value">\${walletAddress.slice(0,6)}...\${walletAddress.slice(-4)}</span>
            </div>
            <p style="color:#888; font-size:11px; margin-top:10px;">No active orders found.</p>
            <p style="color:#00ff88; font-size:11px;">Create one by clicking Execute on a strategy above.</p>
          \`;
          tradesInner.innerHTML = '<div class="no-trades">No active trades<br><span style="color:var(--accent);">Execute a strategy to start</span></div>';
          return;
        }

        // Build order list HTML for main card
        let ordersHtml = \`<div style="max-height:200px; overflow-y:auto;">\`;
        for (const event of events.slice(-5)) {
          const orderId = event.args.orderId;
          const amount = ethers.formatEther(event.args.amount);
          const shortId = orderId.slice(0, 10) + '...';
          ordersHtml += \`
            <div style="padding:8px; margin:5px 0; background:#1a1a1a; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <div style="font-size:11px; color:#00ff88;">Order \${shortId}</div>
                <div style="font-size:10px; color:#888;">\${amount} ETH</div>
              </div>
              <button onclick="cancelOrder('\${orderId}')" style="padding:4px 8px; background:#ff4444; color:#fff; border:none; cursor:pointer; font-size:10px;">Cancel</button>
            </div>
          \`;
        }
        ordersHtml += \`</div>\`;
        ordersHtml += \`<p style="color:#00ff88; font-size:11px; margin-top:10px;">View all on <a href="https://sepolia.etherscan.io/address/\${VAULT_ADDRESS}" target="_blank" style="color:#00ff88;">Etherscan</a></p>\`;
        document.getElementById('orders').innerHTML = ordersHtml;

        // Build trades sidebar
        userTrades = events.slice(-10).reverse().map((event, idx) => ({
          orderId: event.args.orderId,
          amount: ethers.formatEther(event.args.amount),
          pair: 'ETH/USD',
          side: idx % 2 === 0 ? 'buy' : 'sell',
          status: 'pending',
          pnl: 0,
        }));
        renderTradesFeed();

      } catch (e) {
        console.error('Failed to load orders:', e);
        document.getElementById('orders').innerHTML = \`
          <div class="metric">
            <span class="metric-label">Wallet</span>
            <span class="metric-value">\${walletAddress.slice(0,6)}...\${walletAddress.slice(-4)}</span>
          </div>
          <p style="color:#888; font-size:11px; margin-top:10px;">Could not load orders. Orders execute automatically when conditions are met.</p>
          <p style="color:#00ff88; font-size:11px;">View on <a href="https://sepolia.etherscan.io/address/\${VAULT_ADDRESS}" target="_blank" style="color:#00ff88;">Etherscan</a></p>
        \`;
        tradesInner.innerHTML = '<div class="no-trades">Error loading trades</div>';
      }
    }

    function renderTradesFeed() {
      const container = document.getElementById('tradesFeedInner');
      if (userTrades.length === 0) {
        container.innerHTML = '<div class="no-trades">No active trades</div>';
        return;
      }

      container.innerHTML = userTrades.map((trade, idx) => \`
        <div class="trade-item visible" data-idx="\${idx}">
          <div class="trade-header">
            <span class="trade-pair">\${trade.pair}</span>
            <span class="trade-side \${trade.side}">\${trade.side.toUpperCase()}</span>
          </div>
          <div class="trade-details">
            <span>\${trade.amount} ETH</span>
            <span class="trade-pnl \${trade.pnl >= 0 ? 'positive' : 'negative'}">\${trade.pnl >= 0 ? '+' : ''}\${trade.pnl.toFixed(2)}%</span>
          </div>
          <div class="trade-status">
            <span class="status-badge \${trade.status}">\${trade.status.toUpperCase()}</span>
            <span>\${trade.orderId.slice(0, 8)}...</span>
          </div>
        </div>
      \`).join('');
    }

    // Cancel an order
    async function cancelOrder(orderId) {
      if (!signer) {
        alert('Please connect your wallet first!');
        return;
      }

      try {
        const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
        const tx = await vault.cancelOrder(orderId);
        alert('Cancelling order... TX: ' + tx.hash);
        await tx.wait();
        alert('Order cancelled successfully!');
        loadUserOrders(); // Refresh the list
      } catch (err) {
        console.error('Cancel failed:', err);
        alert('Cancel failed: ' + (err.reason || err.message));
      }
    }

    // Toggle auto-trade mode
    function toggleAutoTrade() {
      autoTradeEnabled = !autoTradeEnabled;
      const btn = document.getElementById('autoTradeBtn');
      if (autoTradeEnabled) {
        btn.textContent = 'Auto-Trade: ON';
        btn.style.background = '#00ff88';
        btn.style.color = '#000';
      } else {
        btn.textContent = 'Auto-Trade: OFF';
        btn.style.background = '#333';
        btn.style.color = '#888';
      }
    }

    // Auto-execute top strategy if enabled
    async function checkAutoTrade() {
      console.log('[auto-trade] Check:', {
        enabled: autoTradeEnabled,
        wallet: walletAddress,
        strategies: window.currentStrategies?.length || 0,
        topConf: window.currentStrategies?.[0]?.confidence
      });
      if (!autoTradeEnabled) { console.log('[auto-trade] SKIP: not enabled'); return; }
      if (!walletAddress) { console.log('[auto-trade] SKIP: no wallet'); return; }
      if (!window.currentStrategies?.length) { console.log('[auto-trade] SKIP: no strategies'); return; }

      const topStrategy = window.currentStrategies[0];
      if (topStrategy.confidence >= 0.6) {
        console.log('[auto-trade] EXECUTING:', topStrategy.name, 'conf:', topStrategy.confidence);
        await executeStrategy(0);
      } else {
        console.log('[auto-trade] SKIP: low confidence', topStrategy.confidence);
      }
    }

    // Toggle auto-rebalance mode
    function toggleAutoRebalance() {
      autoRebalanceEnabled = !autoRebalanceEnabled;
      const btn = document.getElementById('autoRebalanceBtn');
      if (autoRebalanceEnabled) {
        btn.textContent = 'Auto-Rebalance: ON';
        btn.style.background = '#FF007A';
        btn.style.color = '#fff';
        console.log('[auto-rebalance] Enabled - checking every', REBALANCE_INTERVAL/1000, 'seconds');
        checkAutoRebalance(); // Run immediately
      } else {
        btn.textContent = 'Auto-Rebalance: OFF';
        btn.style.background = '#222';
        btn.style.color = '#888';
        console.log('[auto-rebalance] Disabled');
      }
    }

    // Auto-rebalance check
    async function checkAutoRebalance() {
      if (!autoRebalanceEnabled || !connectionType) return;

      const now = Date.now();
      if (now - lastRebalanceTime < REBALANCE_INTERVAL) return;

      try {
        console.log('[auto-rebalance] Checking portfolio...');

        // Get current portfolio and regime
        const [portfolioRes, regimeRes] = await Promise.all([
          fetch('/trading-bot/portfolio'),
          fetch('/trading-bot/regime')
        ]);

        const portfolio = await portfolioRes.json();
        const regime = await regimeRes.json();

        if (portfolio.error) {
          console.log('[auto-rebalance] Portfolio error:', portfolio.error);
          return;
        }

        // Check if any allocation is more than REBALANCE_THRESHOLD% off target
        let needsRebalance = false;
        let largestDrift = { token: '', diff: 0 };

        for (const [token, targetPct] of Object.entries(regime.targetAllocation)) {
          const currentPct = portfolio.allocations[token] || 0;
          const diff = Math.abs(targetPct - currentPct);
          if (diff > REBALANCE_THRESHOLD) {
            needsRebalance = true;
            if (diff > largestDrift.diff) {
              largestDrift = { token, diff, targetPct, currentPct };
            }
          }
        }

        if (needsRebalance) {
          console.log('[auto-rebalance] Drift detected:', largestDrift);

          // Determine the swap to make
          let fromToken, toToken, amount;

          if (largestDrift.currentPct > largestDrift.targetPct) {
            // Need to sell this token
            fromToken = largestDrift.token === 'ETH' ? 'WETH' : largestDrift.token;
            toToken = 'USDC';
            // Sell enough to get closer to target (10% of portfolio value)
            const sellValue = (largestDrift.diff / 100) * parseFloat(portfolio.totalValueUSD) * 0.5; // Sell half the drift
            amount = fromToken === 'WETH' ? (sellValue / 3000).toFixed(4) : sellValue.toFixed(2);
          } else {
            // Need to buy this token
            fromToken = 'USDC';
            toToken = largestDrift.token === 'ETH' ? 'WETH' : largestDrift.token;
            const buyValue = (largestDrift.diff / 100) * parseFloat(portfolio.totalValueUSD) * 0.5;
            amount = buyValue.toFixed(2);
          }

          console.log('[auto-rebalance] Executing swap:', { fromToken, toToken, amount });

          // Execute the swap
          const swapRes = await fetch('/trading-bot/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromToken, toToken, amount })
          });

          const swapResult = await swapRes.json();
          if (swapResult.success) {
            console.log('[auto-rebalance] Swap successful:', swapResult.txHash);
            lastRebalanceTime = Date.now();

            // Update UI notification
            const notification = document.createElement('div');
            notification.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#FF007A; color:#fff; padding:12px 20px; border-radius:4px; z-index:9999; font-size:12px;';
            notification.innerHTML = 'Auto-rebalanced: ' + fromToken + ' → ' + toToken + '<br><a href="https://sepolia.etherscan.io/tx/' + swapResult.txHash + '" target="_blank" style="color:#fff;">View TX</a>';
            document.body.appendChild(notification);
            setTimeout(() => notification.remove(), 10000);

            // Reload portfolio if on that tab
            if (document.getElementById('tab-portfolio').classList.contains('active')) {
              setTimeout(loadPortfolio, 3000);
            }
          } else {
            console.error('[auto-rebalance] Swap failed:', swapResult.error);
          }
        } else {
          console.log('[auto-rebalance] Portfolio balanced within', REBALANCE_THRESHOLD + '% threshold');
        }

        lastRebalanceTime = now;
      } catch (err) {
        console.error('[auto-rebalance] Error:', err);
      }
    }

    // Run auto-rebalance check periodically
    setInterval(checkAutoRebalance, 30000); // Check every 30 seconds

    // ==================== PORTFOLIO MANAGEMENT ====================
    const ALLOCATION_COLORS = {
      ETH: '#627EEA',
      WETH: '#627EEA',
      USDC: '#2775CA',
      WBTC: '#F7931A',
      UNI: '#FF007A',
      LINK: '#375BD2',
    };

    async function loadPortfolio() {
      try {
        const [portfolioRes, regimeRes] = await Promise.all([
          fetch('/trading-bot/portfolio'),
          fetch('/trading-bot/regime')
        ]);

        const portfolio = await portfolioRes.json();
        const regime = await regimeRes.json();

        if (portfolio.error) {
          setEl('portfolioHoldings', '<p style="color:#ff4444;">Wallet not connected</p>');
          return;
        }

        // Update regime display
        const regimeColors = {
          risk_on: '#00ff88',
          risk_off: '#ff4444',
          btc_strength: '#F7931A',
          alt_rotation: '#FF007A',
          neutral: '#888'
        };
        document.getElementById('currentRegime').textContent = regime.regime.replace('_', ' ').toUpperCase();
        document.getElementById('currentRegime').style.color = regimeColors[regime.regime] || '#888';

        // Update target allocation
        let targetHtml = '';
        for (const [token, pct] of Object.entries(regime.targetAllocation)) {
          targetHtml += '<div style="display:flex; justify-content:space-between; padding:4px 0;"><span>' + token + '</span><span style="color:var(--accent);">' + pct + '%</span></div>';
        }
        setEl('targetAllocation', targetHtml);

        // Update holdings
        let holdingsHtml = '';
        for (const [token, data] of Object.entries(portfolio.holdings)) {
          if (parseFloat(data.balance) > 0.0001) {
            holdingsHtml += '<div style="display:flex; justify-content:space-between; padding:6px 0;"><span style="color:' + (ALLOCATION_COLORS[token] || '#888') + ';">' + token + '</span><span>' + data.balance + ' <span style="color:var(--text-muted);">($' + data.valueUSD.toFixed(2) + ')</span></span></div>';
          }
        }
        setEl('portfolioHoldings', holdingsHtml || '<p style="color:var(--text-muted);">No holdings</p>');
        document.getElementById('portfolioTotal').textContent = '$' + portfolio.totalValueUSD;

        // Update allocation chart
        const chartEl = document.getElementById('allocationChart');
        const legendEl = document.getElementById('allocationLegend');
        let chartHtml = '';
        let legendHtml = '';
        for (const [token, pct] of Object.entries(portfolio.allocations)) {
          if (pct > 0.1) {
            const color = ALLOCATION_COLORS[token] || '#888';
            chartHtml += '<div style="width:' + pct + '%; background:' + color + ';" title="' + token + ': ' + pct.toFixed(1) + '%"></div>';
            legendHtml += '<div style="display:flex; align-items:center; gap:6px;"><div style="width:12px; height:12px; background:' + color + ';"></div><span style="font-size:11px;">' + token + ' ' + pct.toFixed(1) + '%</span></div>';
          }
        }
        chartEl.innerHTML = chartHtml;
        legendEl.innerHTML = legendHtml;

        // Load rebalance suggestions
        loadRebalanceSuggestions();

      } catch (err) {
        console.error('Portfolio load error:', err);
        setEl('portfolioHoldings', '<p style="color:#ff4444;">Error loading portfolio</p>');
      }
    }

    async function loadRebalanceSuggestions() {
      try {
        const res = await fetch('/trading-bot/rebalance', { method: 'POST' });
        const data = await res.json();

        if (data.suggestedTrades && data.suggestedTrades.length > 0) {
          let html = '<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">Suggested for ' + data.regime.toUpperCase() + ' regime:</div>';
          for (const trade of data.suggestedTrades) {
            html += '<div style="padding:8px; background:var(--bg-primary); margin-bottom:6px; font-size:12px;">';
            html += '<div style="color:var(--accent);">' + trade.from + ' → ' + trade.to + '</div>';
            html += '<div style="color:var(--text-muted);">~$' + trade.amount + ' - ' + trade.reason + '</div>';
            html += '</div>';
          }
          setEl('rebalanceTrades', html);
          document.getElementById('executeRebalanceBtn').disabled = false;
        } else {
          setEl('rebalanceTrades', '<p style="color:var(--accent);">Portfolio is balanced for current regime</p>');
          document.getElementById('executeRebalanceBtn').disabled = true;
        }
      } catch (err) {
        setEl('rebalanceTrades', '<p style="color:#ff4444;">Error loading suggestions</p>');
      }
    }

    async function executeRebalance() {
      const btn = document.getElementById('executeRebalanceBtn');
      btn.disabled = true;
      btn.textContent = 'Executing...';

      try {
        const res = await fetch('/trading-bot/rebalance', { method: 'POST' });
        const data = await res.json();

        if (data.suggestedTrades && data.suggestedTrades.length > 0) {
          // Execute first trade
          const trade = data.suggestedTrades[0];
          const swapRes = await fetch('/trading-bot/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fromToken: trade.from,
              toToken: trade.to,
              amount: trade.from === 'USDC' ? Math.min(100, parseFloat(trade.amount)).toString() : '0.1'
            })
          });

          const swapResult = await swapRes.json();
          if (swapResult.success) {
            alert('Swap executed! TX: ' + swapResult.txHash);
            setTimeout(loadPortfolio, 3000);
          } else {
            alert('Swap failed: ' + swapResult.error);
          }
        }
      } catch (err) {
        alert('Rebalance error: ' + err.message);
      }

      btn.disabled = false;
      btn.textContent = 'Execute Rebalance';
    }

    async function executeManualSwap() {
      const fromToken = document.getElementById('swapFrom').value;
      const toToken = document.getElementById('swapTo').value;
      const amount = document.getElementById('swapAmount').value;

      if (!amount || parseFloat(amount) <= 0) {
        alert('Please enter a valid amount');
        return;
      }

      if (fromToken === toToken) {
        alert('Cannot swap same token');
        return;
      }

      try {
        const res = await fetch('/trading-bot/swap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromToken, toToken, amount })
        });

        const result = await res.json();
        if (result.success) {
          alert('Swap executed! TX: ' + result.txHash);
          setTimeout(loadPortfolio, 3000);
        } else {
          alert('Swap failed: ' + result.error);
        }
      } catch (err) {
        alert('Swap error: ' + err.message);
      }
    }

    // Load portfolio when switching to Portfolio tab
    const origSwitchTab = switchTab;
    switchTab = function(tabName) {
      origSwitchTab(tabName);
      if (tabName === 'portfolio') {
        loadPortfolio();
      }
    };

    // Block Feed - SSE connection to /heartbeat
    let blockFeedData = [];
    const MAX_BLOCKS_SHOWN = 25;

    function connectBlockFeed() {
      const feedDot = document.getElementById('feedDot');
      const feedStatus = document.getElementById('feedStatus');
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');

      const eventSource = new EventSource('/heartbeat');

      eventSource.onopen = () => {
        feedDot.style.background = 'var(--accent)';
        feedStatus.textContent = 'Live';
        statusDot.style.background = 'var(--accent)';
        statusText.textContent = 'Connected';
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.latestBlock) {
            addBlockToFeed(data.latestBlock, true);
          }
        } catch (e) {
          console.error('Block feed parse error:', e);
        }
      };

      eventSource.onerror = () => {
        feedDot.style.background = 'var(--warning)';
        feedStatus.textContent = 'Reconnecting...';
        statusDot.style.background = 'var(--warning)';
        statusText.textContent = 'Reconnecting...';
        eventSource.close();
        setTimeout(connectBlockFeed, 5000);
      };
    }

    function addBlockToFeed(block, animate = false) {
      // Check if we already have this block
      const existing = blockFeedData.find(b => b.chain === block.chain && b.height === block.height);
      if (existing) return;

      // Add to front of array
      blockFeedData.unshift({ ...block, isNew: animate });

      // Trim to max
      if (blockFeedData.length > MAX_BLOCKS_SHOWN) {
        blockFeedData = blockFeedData.slice(0, MAX_BLOCKS_SHOWN);
      }

      renderBlockFeed(animate);
    }

    function renderBlockFeed(animateFirst = false) {
      const container = document.getElementById('blockFeedInner');
      if (blockFeedData.length === 0) {
        container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:12px;">Waiting for blocks...</div>';
        return;
      }

      container.innerHTML = blockFeedData.map((block, idx) => {
        const chainClass = block.chain === 'eth' ? 'chain-eth' : block.chain === 'sol' ? 'chain-sol' : 'chain-avax';
        const tags = (block.tags || []).slice(0, 3);
        const anomalyPct = Math.round((block.anomalyScore || 0) * 100);
        const anomalyClass = anomalyPct > 70 ? 'danger' : anomalyPct > 40 ? 'warning' : '';
        const timeAgo = formatTimeAgo(block.timestamp);
        const visibleClass = (animateFirst && idx === 0) ? '' : 'visible';

        return \`
          <div class="block-item \${visibleClass}" data-idx="\${idx}">
            <div class="block-chain">
              <span class="chain-badge \${chainClass}">\${block.chain.toUpperCase()}</span>
              <span class="block-height">#\${block.height.toLocaleString()}</span>
              <div class="block-divider"></div>
            </div>
            <div class="block-meta">
              <span>\${block.txCount || 0} txs</span>
              <span>\${timeAgo}</span>
            </div>
            \${tags.length > 0 ? \`
              <div class="block-tags">
                \${tags.map(t => \`<span class="block-tag \${t.includes('HIGH') || t.includes('LARGE') ? 'hot' : ''}">\${t}</span>\`).join('')}
              </div>
            \` : ''}
            <div class="block-anomaly">
              <span style="font-size:9px; color:var(--text-muted);">Anomaly</span>
              <div class="anomaly-bar">
                <div class="anomaly-fill \${anomalyClass}" style="width:\${anomalyPct}%"></div>
              </div>
              <span style="font-size:9px; color:var(--text-muted);">\${anomalyPct}%</span>
            </div>
          </div>
        \`;
      }).join('');

      // Animate the first (new) block with anime.js
      if (animateFirst && typeof anime !== 'undefined') {
        const newBlock = container.querySelector('.block-item[data-idx="0"]');
        if (newBlock) {
          anime({
            targets: newBlock,
            translateY: [-20, 0],
            opacity: [0, 1],
            duration: 400,
            easing: 'easeOutExpo',
            complete: () => {
              newBlock.classList.add('visible');
            }
          });
        }
      }
    }

    function formatTimeAgo(timestamp) {
      if (!timestamp) return '';
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 60) return seconds + 's ago';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
      return Math.floor(seconds / 3600) + 'h ago';
    }

    // Fetch recent blocks on load
    async function fetchRecentBlocks() {
      try {
        const res = await fetch('/blocks/recent?limit=15');
        const data = await res.json();
        if (data.blocks && data.blocks.length > 0) {
          // Add blocks in reverse order so newest is first
          data.blocks.reverse().forEach(block => {
            // Convert timestamp from seconds to milliseconds if needed
            const ts = block.timestamp > 1e12 ? block.timestamp : block.timestamp * 1000;
            addBlockToFeed({
              chain: block.chain,
              height: block.height,
              timestamp: ts,
              txCount: block.txCount || 0,
              tags: block.tags || [],
              anomalyScore: block.anomalyScore || 0,
            }, false);
          });
        }
      } catch (e) {
        console.error('Failed to fetch recent blocks:', e);
      }
    }

    // Update active signals count
    function updateSignalCount(count) {
      document.getElementById('activeSignals').textContent = count;
    }

    // Initial fetch
    fetchSignals();
    fetchSentiment();
    fetchChains();
    fetchRecentBlocks();
    connectBlockFeed();
    fetchMempool();
    updateHeaderStats();

    // P&L tracking
    let initialPortfolioValue = null;
    const mempoolHistory = [];

    async function updateHeaderStats() {
      try {
        // Get portfolio value
        const portfolioRes = await fetch('/trading-bot/portfolio');
        const portfolio = await portfolioRes.json();
        const currentValue = parseFloat(portfolio.totalValueUSD);

        document.getElementById('headerPortfolioValue').textContent = '$' + currentValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});

        // Calculate P&L (store initial value in localStorage)
        if (!localStorage.getItem('initialPortfolioValue')) {
          localStorage.setItem('initialPortfolioValue', currentValue.toString());
        }
        const initial = parseFloat(localStorage.getItem('initialPortfolioValue'));
        const pnl = currentValue - initial;
        const pnlPercent = initial > 0 ? ((pnl / initial) * 100).toFixed(2) : 0;

        const pnlEl = document.getElementById('headerPnL');
        pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (' + pnlPercent + '%)';
        pnlEl.style.color = pnl >= 0 ? '#00ff88' : '#ff6b6b';

        // Get trade count
        const swapsRes = await fetch('/trading-bot/swaps');
        const swaps = await swapsRes.json();
        document.getElementById('headerTradeCount').textContent = swaps.count || 0;
      } catch (e) {
        console.warn('Header stats error:', e);
      }
    }

    async function fetchMempool() {
      try {
        const res = await fetch('/trading-bot/mempool');
        const data = await res.json();

        if (data.snapshot) {
          document.getElementById('mempoolTxCount').textContent = data.snapshot.txCount;
          document.getElementById('mempoolValue').textContent = data.snapshot.totalValueEth?.toFixed(2) + ' ETH';
          document.getElementById('mempoolAnomaly').textContent = (data.snapshot.anomalyScore * 100).toFixed(0) + '%';
          document.getElementById('mempoolAnomaly').style.color = data.snapshot.anomalyScore > 0.5 ? '#ff6b6b' : data.snapshot.anomalyScore > 0.3 ? '#ffaa00' : '#00ff88';

          // Tags
          const tagsHtml = (data.snapshot.tags || []).map(tag =>
            '<span style="padding:4px 8px; background:#1a1a1a; border:1px solid #333; font-size:10px; color:var(--accent);">' + tag + '</span>'
          ).join('');
          document.getElementById('mempoolTags').innerHTML = tagsHtml || '<span style="color:#666;">No activity detected</span>';

          // Update badges - sync sidebar and tab to both show tx count
          document.getElementById('mempoolBadge').textContent = data.snapshot.txCount;
          document.getElementById('mempoolScore').textContent = data.snapshot.txCount;
        }

        if (data.analysis) {
          const signalEl = document.getElementById('mempoolSignalType');
          signalEl.textContent = data.analysis.signal.toUpperCase();
          signalEl.style.color = data.analysis.signal === 'bullish' ? '#00ff88' : data.analysis.signal === 'bearish' ? '#ff6b6b' : '#888';

          document.getElementById('mempoolConfidence').textContent = (data.analysis.confidence * 100).toFixed(0) + '%';
          document.getElementById('mempoolBullish').textContent = data.analysis.bullishScore || 0;
          document.getElementById('mempoolBearish').textContent = data.analysis.bearishScore || 0;

          // Reasons
          const reasonsHtml = (data.analysis.reasons || []).map(r => '<div style="padding:4px 0; border-bottom:1px solid #222;">• ' + r + '</div>').join('');
          document.getElementById('mempoolReasons').innerHTML = reasonsHtml || '<span style="color:#666;">No signals</span>';
        }

        // Add to history
        if (data.snapshot) {
          mempoolHistory.unshift({
            time: new Date().toLocaleTimeString(),
            txCount: data.snapshot.txCount,
            value: data.snapshot.totalValueEth?.toFixed(2),
            score: (data.snapshot.anomalyScore * 100).toFixed(0),
            tags: (data.snapshot.tags || []).join(', ')
          });
          if (mempoolHistory.length > 20) mempoolHistory.pop();

          const historyHtml = mempoolHistory.map(h =>
            '<tr style="border-bottom:1px solid #1a1a1a;"><td style="padding:4px 6px;">' + h.time + '</td><td style="padding:4px 6px;">' + h.txCount + '</td><td style="padding:4px 6px;">' + h.value + '</td><td style="padding:4px 6px;">' + h.score + '%</td><td style="padding:4px 6px; color:var(--accent); font-size:10px;">' + h.tags + '</td></tr>'
          ).join('');
          document.getElementById('mempoolHistoryBody').innerHTML = historyHtml;
        }
      } catch (e) {
        console.warn('Mempool fetch error:', e);
      }
    }

    // Fetch unified prediction
    async function fetchPrediction() {
      try {
        const res = await fetch('/trading-bot/prediction?chain=eth');
        const data = await res.json();

        if (data.prediction) {
          const p = data.prediction;

          // Direction
          const dirEl = document.getElementById('predictionDirection');
          dirEl.textContent = p.direction.toUpperCase();
          dirEl.style.color = p.direction === 'bullish' ? '#00ff88' : p.direction === 'bearish' ? '#ff6b6b' : '#888';

          // Confidence and strength
          document.getElementById('predictionConfidence').textContent = (p.confidence * 100).toFixed(0) + '%';
          document.getElementById('predictionStrength').textContent = p.strength.toUpperCase();
          document.getElementById('predictionExpected').textContent = (p.expectedPriceChange1h * 100).toFixed(2) + '%';
          document.getElementById('predictionExpected').style.color = p.expectedPriceChange1h > 0 ? '#00ff88' : p.expectedPriceChange1h < 0 ? '#ff6b6b' : '#888';

          // Action
          const actionEl = document.getElementById('predictionAction');
          actionEl.textContent = p.action.replace('_', ' ');
          const actionColors = {
            'strong_buy': '#00ff88',
            'buy': '#88ff88',
            'hold': '#888',
            'sell': '#ff8888',
            'strong_sell': '#ff6b6b',
            'avoid': '#ff0000'
          };
          actionEl.style.background = actionColors[p.action] || '#333';
          actionEl.style.color = p.action === 'avoid' ? '#fff' : '#000';

          // Reasoning
          const reasoningHtml = p.reasoning.map(r => '• ' + r).join('<br>');
          document.getElementById('predictionReasoning').innerHTML = reasoningHtml || 'No specific reasoning';

          // Bullish signals
          const bullishHtml = p.bullishSignals.length > 0
            ? p.bullishSignals.map(s => '<div style="padding:4px 0;">+ ' + s + '</div>').join('')
            : '<div style="color:var(--text-muted);">No bullish signals</div>';
          document.getElementById('bullishSignals').innerHTML = bullishHtml;

          // Bearish signals
          const bearishHtml = p.bearishSignals.length > 0
            ? p.bearishSignals.map(s => '<div style="padding:4px 0;">- ' + s + '</div>').join('')
            : '<div style="color:var(--text-muted);">No bearish signals</div>';
          document.getElementById('bearishSignals').innerHTML = bearishHtml;

          // Pattern match
          if (p.matchedPattern) {
            document.getElementById('matchedPattern').textContent = p.matchedPattern;
            document.getElementById('matchedPattern').style.color = 'var(--accent)';
            document.getElementById('patternConfidence').textContent = 'Confidence: ' + (p.patternConfidence * 100).toFixed(0) + '%';
          } else {
            document.getElementById('matchedPattern').textContent = 'No pattern detected';
            document.getElementById('matchedPattern').style.color = 'var(--text-muted)';
            document.getElementById('patternConfidence').textContent = '';
          }

          // Signal breakdown
          if (p.signalBreakdown) {
            const sigNames = {
              'driftVelocity': 'sigDrift',
              'entropy': 'sigEntropy',
              'anomalyScore': 'sigAnomaly',
              'mempoolPressure': 'sigMempool',
              'tagMomentum': 'sigTags',
              'fearGreed': 'sigFearGreed',
              'funding': 'sigFunding',
              'liquidation': 'sigLiquidation'
            };
            for (const [key, elId] of Object.entries(sigNames)) {
              const sig = p.signalBreakdown[key];
              if (sig) {
                const el = document.getElementById(elId);
                const contrib = sig.contribution;
                el.textContent = (contrib >= 0 ? '+' : '') + (contrib * 100).toFixed(1);
                el.style.color = contrib > 0.01 ? '#00ff88' : contrib < -0.01 ? '#ff6b6b' : '#888';
              }
            }
          }

          // Update badge
          document.getElementById('predictionBadge').textContent = p.direction.charAt(0).toUpperCase();
          document.getElementById('predictionBadge').style.background = p.direction === 'bullish' ? '#00ff88' : p.direction === 'bearish' ? '#ff6b6b' : 'var(--accent)';
        }

        // Cascade risk
        if (data.cascadeRisk) {
          const cr = data.cascadeRisk;
          const riskColors = { low: '#00ff88', medium: '#ffaa00', high: '#ff6b6b', extreme: '#ff0000' };
          const riskEl = document.getElementById('cascadeRiskLevel');
          riskEl.textContent = cr.riskLevel.toUpperCase();
          riskEl.style.background = riskColors[cr.riskLevel];
          riskEl.style.color = cr.riskLevel === 'extreme' ? '#fff' : '#000';

          document.getElementById('cascadeLeverage').textContent = (cr.leverageRisk * 100).toFixed(0) + '%';
          document.getElementById('cascadeProximity').textContent = (cr.proximityRisk * 100).toFixed(0) + '%';
          document.getElementById('cascadeMomentum').textContent = (cr.momentumRisk * 100).toFixed(0) + '%';
          document.getElementById('cascadeContagion').textContent = (cr.contagionRisk * 100).toFixed(0) + '%';

          // Warnings
          const warningsEl = document.getElementById('cascadeWarnings');
          if (cr.warnings && cr.warnings.length > 0) {
            warningsEl.innerHTML = cr.warnings.map(w => '⚠ ' + w).join('<br>');
            warningsEl.style.display = 'block';
          } else {
            warningsEl.style.display = 'none';
          }
        }

        // Similar patterns
        if (data.similarPatterns && data.similarPatterns.length > 0) {
          const patternsHtml = data.similarPatterns.map(p =>
            '<div style="padding:4px 0; border-bottom:1px solid #222;">' +
            '<span style="color:var(--accent);">' + (p.similarity * 100).toFixed(0) + '%</span> similar → ' +
            '<span style="color:' + (p.historicalOutcome > 0 ? '#00ff88' : '#ff6b6b') + ';">' +
            (p.historicalOutcome > 0 ? '+' : '') + (p.historicalOutcome * 100).toFixed(2) + '% outcome</span>' +
            '</div>'
          ).join('');
          document.getElementById('similarPatternsList').innerHTML = patternsHtml;
        } else {
          document.getElementById('similarPatternsList').innerHTML = '<span style="color:#666;">Insufficient historical data</span>';
        }
      } catch (e) {
        console.warn('Prediction fetch error:', e);
      }
    }

    // Fetch prediction stats
    async function fetchPredictionStats() {
      try {
        const res = await fetch('/trading-bot/prediction/stats');
        const data = await res.json();

        if (data.stats) {
          const s = data.stats;
          document.getElementById('statTotal').textContent = s.total;
          document.getElementById('statAccuracy').textContent = s.withOutcome > 0 ? (s.accuracy * 100).toFixed(1) + '%' : '-';
          document.getElementById('statRecentAccuracy').textContent = s.withOutcome > 0 ? (s.recentAccuracy * 100).toFixed(1) + '%' : '-';
          document.getElementById('statAvgConfidence').textContent = (s.avgConfidence * 100).toFixed(0) + '%';

          // By direction
          const dirs = s.byDirection || {};
          document.getElementById('statBullishCount').textContent = dirs.bullish?.count || 0;
          document.getElementById('statBullishAccuracy').textContent = dirs.bullish?.count > 0
            ? ((dirs.bullish.correct / dirs.bullish.count) * 100).toFixed(0) + '%' : '-';
          document.getElementById('statBearishCount').textContent = dirs.bearish?.count || 0;
          document.getElementById('statBearishAccuracy').textContent = dirs.bearish?.count > 0
            ? ((dirs.bearish.correct / dirs.bearish.count) * 100).toFixed(0) + '%' : '-';
          document.getElementById('statNeutralCount').textContent = dirs.neutral?.count || 0;
          document.getElementById('statNeutralAccuracy').textContent = dirs.neutral?.count > 0
            ? ((dirs.neutral.correct / dirs.neutral.count) * 100).toFixed(0) + '%' : '-';
        }

        // Pattern performance table
        if (data.patterns && data.patterns.length > 0) {
          const tableHtml = data.patterns.map(p =>
            '<tr style="border-bottom:1px solid #222;">' +
            '<td style="padding:8px;">' + p.pattern + '</td>' +
            '<td style="padding:8px;">' + p.occurrences + '</td>' +
            '<td style="padding:8px; color:' + (p.accuracy > 0.6 ? '#00ff88' : p.accuracy > 0.4 ? '#ffaa00' : '#ff6b6b') + ';">' + (p.accuracy * 100).toFixed(0) + '%</td>' +
            '<td style="padding:8px; color:' + (p.avgOutcome > 0 ? '#00ff88' : '#ff6b6b') + ';">' + (p.avgOutcome * 100).toFixed(2) + '%</td>' +
            '<td style="padding:8px;">' + (p.confidence * 100).toFixed(0) + '%</td>' +
            '</tr>'
          ).join('');
          document.getElementById('patternTableBody').innerHTML = tableHtml;
        }
      } catch (e) {
        console.warn('Prediction stats error:', e);
      }
    }

    // Initial fetch for predictions
    fetchPrediction();
    fetchPredictionStats();

    // Refresh every 5 seconds
    setInterval(fetchSignals, 5000);
    setInterval(fetchSentiment, 30000);
    setInterval(fetchChains, 60000);
    setInterval(fetchMempool, 5000);
    setInterval(updateHeaderStats, 10000);
    setInterval(fetchPrediction, 10000);
    setInterval(fetchPredictionStats, 60000);

    // Check auto-trade every 30 seconds
    setInterval(checkAutoTrade, 30000);

    // ============================================
    // EARLY ALPHA FUNCTIONS
    // ============================================

    async function loadAlphaDashboard() {
      try {
        const res = await fetch('/trading-bot/early-alpha/dashboard');
        const data = await res.json();

        // Update scanner status
        document.getElementById('scannerStatus').textContent = data.status.scanning ? 'Active' : 'Inactive';
        document.getElementById('scannerStatus').style.color = data.status.scanning ? '#00ff88' : '#888';
        document.getElementById('tokensTracked').textContent = data.summary.newTokens;
        document.getElementById('pairsTracked').textContent = data.summary.newPairs;

        // Update badge
        const alphaBadge = document.getElementById('alphaBadge');
        if (data.summary.hottestOpportunities > 0) {
          alphaBadge.textContent = data.summary.hottestOpportunities;
          alphaBadge.style.background = '#ff6b00';
        }

        // Hot tokens table
        if (data.recentTokens && data.recentTokens.length > 0) {
          const rows = data.recentTokens.map(t => \`
            <tr style="border-bottom:1px solid #222;">
              <td style="padding:8px;">
                <div style="font-weight:500;">\${t.symbol || 'Unknown'}</div>
                <div style="font-size:10px; color:#888;">\${t.address.slice(0, 12)}...</div>
              </td>
              <td style="padding:8px;">
                <span style="padding:3px 8px; background:\${t.score > 50 ? 'rgba(0,255,136,0.2)' : t.score > 30 ? 'rgba(255,180,0,0.2)' : 'rgba(255,107,107,0.2)'}; color:\${t.score > 50 ? '#00ff88' : t.score > 30 ? '#ffb400' : '#ff6b6b'}; border-radius:4px; font-size:11px;">\${t.score}/100</span>
              </td>
              <td style="padding:8px; font-size:11px; color:#888; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${t.signals.slice(0, 2).join(', ')}</td>
              <td style="padding:8px; font-size:11px; color:#888;">\${t.blockNumber || '-'}</td>
              <td style="padding:8px;">
                <button onclick="analyzeTokenFromTable('\${t.address}')" style="padding:4px 8px; background:#333; border:none; color:#fff; cursor:pointer; font-size:10px; border-radius:3px;">Analyze</button>
              </td>
            </tr>
          \`).join('');
          document.getElementById('hotTokensBody').innerHTML = rows;
        }

        // New pairs
        if (data.recentPairs && data.recentPairs.length > 0) {
          const pairHtml = data.recentPairs.map(p => \`
            <div style="padding:8px 0; border-bottom:1px solid #222;">
              <div style="font-size:11px; color:var(--accent);">\${p.dex}</div>
              <div style="font-size:10px; color:#888; margin-top:2px;">\${p.token0.slice(0, 8)} / \${p.token1.slice(0, 8)}</div>
            </div>
          \`).join('');
          document.getElementById('newPairs').innerHTML = pairHtml;
        }

        // Smart money
        const wallets = data.smartMoneyActivity || [];
        if (wallets.length > 0) {
          document.getElementById('smartMoneyTrades').innerHTML = wallets.map(t => \`
            <div style="padding:4px 0; font-size:11px;">
              <span style="color:\${t.action === 'buy' ? '#00ff88' : '#ff6b6b'};">\${t.action.toUpperCase()}</span>
              \${t.token.slice(0, 8)}... ($\${t.amountUSD})
            </div>
          \`).join('') || '<div style="color:#888;">No recent trades</div>';
        }

      } catch (e) {
        console.warn('Alpha dashboard error:', e);
      }
    }

    async function loadAlphaStatus() {
      try {
        const res = await fetch('/trading-bot/early-alpha/status');
        const data = await res.json();
        document.getElementById('scannerStatus').textContent = data.scanning ? 'Active' : 'Inactive';
        document.getElementById('scannerStatus').style.color = data.scanning ? '#00ff88' : '#888';
        document.getElementById('tokensTracked').textContent = data.tokensTracked;
        document.getElementById('pairsTracked').textContent = data.pairsTracked;

        // Update tracked wallets
        const walletsRes = await fetch('/trading-bot/early-alpha/smart-money');
        const walletsData = await walletsRes.json();
        document.getElementById('trackedWallets').innerHTML = walletsData.wallets.map(w =>
          \`<div style="padding:4px 0;">\${w.label}: \${w.address.slice(0, 10)}...</div>\`
        ).join('');
      } catch (e) {
        console.warn('Alpha status error:', e);
      }
    }

    async function startAlphaScanner() {
      try {
        await fetch('/trading-bot/early-alpha/scanner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', intervalMs: 60000 })
        });
        document.getElementById('scannerStatus').textContent = 'Active';
        document.getElementById('scannerStatus').style.color = '#00ff88';
      } catch (e) {
        console.error('Failed to start scanner:', e);
      }
    }

    async function stopAlphaScanner() {
      try {
        await fetch('/trading-bot/early-alpha/scanner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' })
        });
        document.getElementById('scannerStatus').textContent = 'Inactive';
        document.getElementById('scannerStatus').style.color = '#888';
      } catch (e) {
        console.error('Failed to stop scanner:', e);
      }
    }

    async function runAlphaScan() {
      try {
        document.getElementById('scannerStatus').textContent = 'Scanning...';
        document.getElementById('scannerStatus').style.color = '#ffb400';

        const res = await fetch('/trading-bot/early-alpha/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks: 50 })
        });
        const data = await res.json();

        if (data.success) {
          await loadAlphaDashboard();
          document.getElementById('scannerStatus').textContent = \`Found \${data.newTokens} tokens, \${data.newPairs} pairs\`;
        }
      } catch (e) {
        console.error('Scan failed:', e);
        document.getElementById('scannerStatus').textContent = 'Scan failed';
        document.getElementById('scannerStatus').style.color = '#ff6b6b';
      }
    }

    async function addWalletToTrack() {
      const address = document.getElementById('newWalletAddress').value.trim();
      const label = document.getElementById('newWalletLabel').value.trim();

      if (!address || !label) {
        alert('Please enter both address and label');
        return;
      }

      try {
        await fetch('/trading-bot/early-alpha/smart-money', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, label })
        });
        document.getElementById('newWalletAddress').value = '';
        document.getElementById('newWalletLabel').value = '';
        await loadAlphaStatus();
      } catch (e) {
        console.error('Failed to add wallet:', e);
      }
    }

    async function analyzeTokenAddress() {
      const address = document.getElementById('analyzeTokenAddress').value.trim();
      if (!address) {
        alert('Please enter a token address');
        return;
      }

      document.getElementById('tokenAnalysis').innerHTML = '<span style="color:#ffb400;">Analyzing...</span>';

      try {
        const res = await fetch('/trading-bot/chat/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        const data = await res.json();
        document.getElementById('tokenAnalysis').innerHTML = data.message.replace(/\\*\\*/g, '').replace(/\\n/g, '<br>');
      } catch (e) {
        document.getElementById('tokenAnalysis').innerHTML = '<span style="color:#ff6b6b;">Analysis failed: ' + e.message + '</span>';
      }
    }

    function analyzeTokenFromTable(address) {
      document.getElementById('analyzeTokenAddress').value = address;
      analyzeTokenAddress();
    }

    // Chat functions
    async function sendChatMessage() {
      const input = document.getElementById('chatInput');
      const message = input.value.trim();
      if (!message) return;

      const chatMessages = document.getElementById('chatMessages');
      chatMessages.innerHTML += \`<div style="margin-bottom:8px;"><span style="color:var(--accent);">You:</span> \${message}</div>\`;
      input.value = '';

      try {
        const res = await fetch('/trading-bot/chat/quick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: message })
        });
        const data = await res.json();

        chatMessages.innerHTML += \`<div style="margin-bottom:8px; padding:8px; background:#111; border-radius:4px;"><span style="color:#888;">AI:</span> \${data.message.replace(/\\*\\*/g, '<strong>').replace(/\\n/g, '<br>')}</div>\`;
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Update suggestions
        if (data.suggestions) {
          const suggestionsHtml = data.suggestions.map(s =>
            \`<button onclick="quickSuggestion('\${s}')" style="padding:4px 8px; background:#222; border:1px solid #333; color:#888; cursor:pointer; font-size:10px; border-radius:3px;">\${s}</button>\`
          ).join('');
          document.getElementById('chatSuggestions').innerHTML = suggestionsHtml;
        }
      } catch (e) {
        chatMessages.innerHTML += \`<div style="color:#ff6b6b;">Error: \${e.message}</div>\`;
      }
    }

    function quickSuggestion(text) {
      document.getElementById('chatInput').value = text;
      sendChatMessage();
    }

    async function loadChatSuggestions() {
      try {
        const res = await fetch('/trading-bot/chat/suggestions');
        const data = await res.json();
        const suggestionsHtml = data.suggestions.map(s =>
          \`<button onclick="quickSuggestion('\${s}')" style="padding:4px 8px; background:#222; border:1px solid #333; color:#888; cursor:pointer; font-size:10px; border-radius:3px;">\${s}</button>\`
        ).join('');
        document.getElementById('chatSuggestions').innerHTML = suggestionsHtml;
      } catch (e) {
        console.warn('Failed to load suggestions:', e);
      }
    }

    // Auto-refresh alpha tab if active
    setInterval(() => {
      const alphaTab = document.getElementById('tab-alpha');
      if (alphaTab && alphaTab.classList.contains('active')) {
        loadAlphaStatus();
      }
    }, 10000);

    // ============================================
    // VALIDATOR TAB FUNCTIONS
    // ============================================

    async function loadValidatorStatus() {
      try {
        const res = await fetch('/validator/status');
        const data = await res.json();

        document.getElementById('vIndexLoaded').textContent = data.patternIndexLoaded ? 'LOADED' : 'OFFLINE';
        document.getElementById('vIndexLoaded').style.color = data.patternIndexLoaded ? '#00ff88' : '#ff6b6b';

        if (data.index) {
          document.getElementById('vIndexSize').textContent = data.index.indexSizeMB.toFixed(2) + ' MB (' + data.index.storageReduction + ' reduction)';
          document.getElementById('vMetaBlocks').textContent = data.index.totalPatterns;
          document.getElementById('vBlocksCovered').textContent = data.index.totalBlocksCovered + ' blocks covered';
          document.getElementById('vStorageReduction').textContent = data.index.storageReduction;
        }

        if (data.network) {
          document.getElementById('vNodeCount').textContent = data.network.totalNodes;
          document.getElementById('vTierBreakdown').textContent =
            data.network.byTier.mobile + 'M / ' + data.network.byTier.pattern + 'P / ' + data.network.byTier.archive + 'A';
          document.getElementById('vConsensus').textContent = (data.network.consensusHealth * 100).toFixed(0) + '%';
          document.getElementById('vValidations').textContent = data.network.totalValidations + ' validations';
        }
      } catch (e) {
        console.warn('Validator status error:', e);
      }
    }

    async function loadNodes() {
      try {
        const res = await fetch('/validator/nodes');
        const data = await res.json();
        if (data.nodes.length === 0) {
          document.getElementById('nodesList').innerHTML = '<div style="color:var(--text-muted);">No nodes registered. Click "Add Demo Nodes" to simulate a network.</div>';
          return;
        }
        const tierColors = { mobile: '#00aaff', pattern: '#aa88ff', archive: '#ff6b00' };
        document.getElementById('nodesList').innerHTML = data.nodes.map(n =>
          '<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #222;">' +
          '<div><span style="color:' + (tierColors[n.tier] || '#888') + '; font-weight:600;">[' + n.tier.toUpperCase() + ']</span> ' + n.nodeId + '</div>' +
          '<div style="color:var(--text-muted);">' + n.deviceType + ' | ' + n.validationsPerformed + ' validations | ' + n.avgValidationTimeMs.toFixed(3) + 'ms avg</div>' +
          '</div>'
        ).join('');
      } catch (e) {
        console.warn('Nodes error:', e);
      }
    }

    async function loadMetaBlockInfo() {
      try {
        const res = await fetch('/validator/meta-blocks');
        const data = await res.json();
        let html = '<div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:16px; margin-bottom:12px;">';
        html += '<div>Total Blocks: <span style="color:#00ff88; font-weight:700;">' + data.totalBlocks + '</span></div>';
        html += '<div>Meta-Blocks: <span style="color:#00aaff; font-weight:700;">' + data.totalMetaBlocks + '</span></div>';
        html += '<div>Avg Group: <span style="color:#aa88ff; font-weight:700;">' + data.avgGroupSize.toFixed(1) + '</span></div>';
        html += '<div>Compression: <span style="color:#ff6b00; font-weight:700;">' + data.compressionRatio.toFixed(1) + ':1</span></div>';
        html += '</div>';

        if (data.byEra && Object.keys(data.byEra).length > 0) {
          html += '<div style="margin-top:8px;"><strong>By Era:</strong></div>';
          for (const [era, stats] of Object.entries(data.byEra)) {
            html += '<div style="padding:3px 0;">' + era + ': ' + stats.blocks + ' blocks in ' + stats.metaBlocks + ' meta-blocks (avg ' + stats.avgGroupSize.toFixed(1) + ')</div>';
          }
        }
        document.getElementById('metaBlockInfo').innerHTML = html;
      } catch (e) {
        document.getElementById('metaBlockInfo').innerHTML = '<div style="color:#ff6b6b;">Error loading meta-blocks</div>';
      }
    }

    async function runLiveBenchmark() {
      document.getElementById('benchmarkResults').innerHTML = '<div style="color:#00aaff;">Running benchmark on real data...</div>';
      try {
        const res = await fetch('/validator/benchmark');
        const data = await res.json();
        let html = '<table style="width:100%; border-collapse:collapse;">';
        html += '<tr style="border-bottom:1px solid #333;"><td style="padding:6px;">Processing Rate</td><td style="padding:6px; color:#00ff88; font-weight:700;">' + data.processingRate + '</td></tr>';
        html += '<tr style="border-bottom:1px solid #333;"><td style="padding:6px;">Compression Ratio</td><td style="padding:6px; color:#00ff88; font-weight:700;">' + data.compressionRatio + '</td></tr>';
        html += '<tr style="border-bottom:1px solid #333;"><td style="padding:6px;">Storage Reduction</td><td style="padding:6px; color:#00ff88; font-weight:700;">' + data.storageReduction + '</td></tr>';
        html += '<tr style="border-bottom:1px solid #333;"><td style="padding:6px;">Validation Accuracy</td><td style="padding:6px; color:#00ff88; font-weight:700;">' + data.validationAccuracy + '</td></tr>';
        html += '<tr style="border-bottom:1px solid #333;"><td style="padding:6px;">Avg Lookup Time</td><td style="padding:6px; color:#00ff88; font-weight:700;">' + data.avgLookupTimeMs + ' ms</td></tr>';

        html += '<tr><td colspan="2" style="padding:12px 6px 6px; font-weight:700; color:#00aaff;">Patent Claims:</td></tr>';
        for (const [claim, passed] of Object.entries(data.patentClaims)) {
          const color = passed ? '#00ff88' : '#ff6b6b';
          const icon = passed ? 'VERIFIED' : 'PARTIAL';
          html += '<tr style="border-bottom:1px solid #222;"><td style="padding:4px 6px;">' + claim + '</td><td style="padding:4px 6px; color:' + color + '; font-weight:600;">' + icon + '</td></tr>';
        }
        html += '</table>';
        document.getElementById('benchmarkResults').innerHTML = html;
      } catch (e) {
        document.getElementById('benchmarkResults').innerHTML = '<div style="color:#ff6b6b;">Benchmark error: ' + e.message + '</div>';
      }
    }

    async function extractFeatures() {
      try {
        const body = {
          sizeBytes: parseInt(document.getElementById('feBlockSize').value),
          txCount: parseInt(document.getElementById('feTxCount').value),
          timestamp: parseInt(document.getElementById('feTimestamp').value),
          blockHeight: parseInt(document.getElementById('feBlockHeight').value),
          chain: 'eth'
        };
        const res = await fetch('/validator/extract-features', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        const f = data.features;
        const dimColors = { sizeCategory:'#00aaff', txCountCategory:'#00ff88', temporalHour:'#ffaa00', temporalDay:'#ffaa00', era:'#ff6b00', protocolVersion:'#aa88ff', difficultyCategory:'#ff6b6b', transactionComplexity:'#00ffcc' };
        let html = '<div style="font-weight:700; color:#00aaff; margin-bottom:8px;">8-Dimensional Feature Vector</div>';
        const dims = ['sizeCategory','txCountCategory','temporalHour','temporalDay','era','protocolVersion','difficultyCategory','transactionComplexity'];
        dims.forEach((dim, i) => {
          html += '<div style="display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px solid #1a1a1a;">';
          html += '<span style="color:var(--text-muted);">D' + (i+1) + ': ' + dim + '</span>';
          html += '<span style="color:' + (dimColors[dim] || '#fff') + '; font-weight:600;">' + f[dim] + '</span>';
          html += '</div>';
        });
        html += '<div style="margin-top:8px; color:var(--text-muted);">Pattern Signature: <span style="color:#00aaff;">' + data.signature.hash.slice(0, 16) + '...</span></div>';
        html += '<div style="color:var(--text-muted);">Group Key: <span style="color:#fff;">' + data.signature.groupKey + '</span></div>';
        // Show numeric vector as mini bar chart
        html += '<div style="margin-top:8px; display:flex; gap:2px; height:30px; align-items:flex-end;">';
        data.signature.numericVector.forEach((v, i) => {
          const h = Math.max(2, v * 28);
          html += '<div style="flex:1; height:' + h + 'px; background:' + (Object.values(dimColors)[i] || '#00aaff') + '; border-radius:2px 2px 0 0;" title="D' + (i+1) + ': ' + v.toFixed(3) + '"></div>';
        });
        html += '</div>';
        document.getElementById('featureResults').innerHTML = html;
      } catch (e) {
        document.getElementById('featureResults').innerHTML = '<div style="color:#ff6b6b;">Error: ' + e.message + '</div>';
      }
    }

    async function validateTx() {
      try {
        const body = {
          txHash: document.getElementById('valTxHash').value,
          blockHeight: parseInt(document.getElementById('valBlockHeight').value),
          blockSize: parseInt(document.getElementById('valBlockSize').value),
          txCount: parseInt(document.getElementById('valTxCount').value),
          timestamp: parseInt(document.getElementById('valTimestamp').value),
          txIndex: 0,
          chain: 'eth'
        };
        const res = await fetch('/validator/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        const resultColors = { SUCCESS:'#00ff88', PATTERN_MATCH:'#00aaff', ANOMALY_DETECTED:'#ffaa00', REQUIRES_FULL_NODE:'#ff6b6b', VALIDATION_FAILED:'#ff0000' };
        let html = '<div style="font-size:18px; font-weight:700; color:' + (resultColors[data.result] || '#fff') + '; margin-bottom:8px;">' + data.result + '</div>';
        html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-bottom:8px;">';
        html += '<div>Confidence: <span style="color:#00ff88; font-weight:700;">' + (data.confidence * 100).toFixed(1) + '%</span></div>';
        html += '<div>Time: <span style="color:#00aaff;">' + data.validationTimeMs.toFixed(3) + ' ms</span></div>';
        html += '<div>Pattern: <span style="color:#aa88ff;">' + (data.patternId || 'none') + '</span></div>';
        html += '<div>Escalate: <span style="color:' + (data.escalateToArchive ? '#ff6b6b' : '#00ff88') + ';">' + (data.escalateToArchive ? 'YES' : 'NO') + '</span></div>';
        html += '</div>';
        if (data.reasoning.length > 0) {
          html += '<div style="color:var(--text-muted); margin-top:4px;">Reasoning:</div>';
          data.reasoning.forEach(r => { html += '<div style="padding:2px 0; font-size:10px; color:#888;">' + r + '</div>'; });
        }
        if (data.anomalies.length > 0) {
          html += '<div style="color:#ff6b6b; margin-top:4px;">Anomalies: ' + data.anomalies.join(', ') + '</div>';
        }
        document.getElementById('validationResults').innerHTML = html;
        // Refresh status
        loadValidatorStatus();
      } catch (e) {
        document.getElementById('validationResults').innerHTML = '<div style="color:#ff6b6b;">Error: ' + e.message + '</div>';
      }
    }

    async function registerDemoNodes() {
      const demoDevices = [
        { nodeId: 'iphone-15-validator', device: { deviceType: 'smartphone', storageMB: 256000, ramMB: 6000, cpuCores: 6, bandwidthMbps: 100, batteryPowered: true, os: 'iOS' } },
        { nodeId: 'android-pixel-8', device: { deviceType: 'smartphone', storageMB: 128000, ramMB: 8000, cpuCores: 8, bandwidthMbps: 150, batteryPowered: true, os: 'Android' } },
        { nodeId: 'macbook-pro-m3', device: { deviceType: 'laptop', storageMB: 512000, ramMB: 16000, cpuCores: 10, bandwidthMbps: 1000, batteryPowered: true, os: 'macOS' } },
        { nodeId: 'raspberry-pi-5', device: { deviceType: 'iot', storageMB: 32000, ramMB: 4000, cpuCores: 4, bandwidthMbps: 100, batteryPowered: false, os: 'Linux' } },
        { nodeId: 'aws-c5-xlarge', device: { deviceType: 'server', storageMB: 2000000, ramMB: 64000, cpuCores: 32, bandwidthMbps: 10000, batteryPowered: false, os: 'Linux' } },
      ];

      for (const d of demoDevices) {
        try {
          await fetch('/validator/register-node', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(d)
          });
        } catch (e) { console.warn(e); }
      }

      loadNodes();
      loadValidatorStatus();
    }

    // Load validator data when tab is active
    setInterval(() => {
      const validatorTab = document.getElementById('tab-validator');
      if (validatorTab && validatorTab.classList.contains('active')) {
        loadValidatorStatus();
        loadNodes();
      }
    }, 5000);

    // Initial load if validator tab is clicked
    document.querySelector('[data-tab="validator"]')?.addEventListener('click', () => {
      setTimeout(() => {
        loadValidatorStatus();
        loadNodes();
        loadMetaBlockInfo();
      }, 100);
    });

  </script>
</body>
</html>`);
});

// Social sentiment endpoint
app.get('/trading-bot/sentiment', async (_req, res) => {
  try {
    const { fetchSocialSentiment } = await import('../ml/socialSentiment.js');
    const sentiment = await fetchSocialSentiment();
    res.json(sentiment);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Multi-chain data endpoint
app.get('/trading-bot/chains', async (_req, res) => {
  try {
    const { fetchMultiChainData } = await import('../ml/multiChain.js');
    const data = await fetchMultiChainData();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Server wallet status endpoint
app.get('/trading-bot/wallet-status', async (_req, res) => {
  try {
    let balance: string | null = null;
    if (serverWallet && serverProvider) {
      const balWei = await serverProvider.getBalance(serverWallet.address);
      balance = ethers.formatEther(balWei);
    }
    res.json({
      serverWalletConfigured: !!serverWallet,
      serverWalletAddress: serverWallet?.address ?? null,
      serverWalletBalance: balance,
    });
  } catch {
    res.json({
      serverWalletConfigured: !!serverWallet,
      serverWalletAddress: serverWallet?.address ?? null,
      serverWalletBalance: null,
    });
  }
});

// ==================== UNISWAP TRADING SYSTEM ====================
// Track swap history for display (persisted to disk)
interface SwapRecord {
  txHash: string;
  fromToken: string;
  toToken: string;
  amountIn: string;
  timestamp: string;
  status: 'confirmed' | 'pending' | 'failed';
}

const SWAP_HISTORY_FILE = path.join(DEFAULT_DATA_DIR, 'swap-history.json');
let swapHistory: SwapRecord[] = [];

// Load swap history from disk on startup
function loadSwapHistory(): void {
  try {
    if (existsSync(SWAP_HISTORY_FILE)) {
      const data = readFileSync(SWAP_HISTORY_FILE, 'utf-8');
      swapHistory = JSON.parse(data);
      console.log(`[trading] Loaded ${swapHistory.length} swaps from history`);
    }
  } catch (e) {
    console.warn('[trading] Could not load swap history');
  }
}

// Save swap history to disk
function saveSwapHistory(): void {
  try {
    writeFileSync(SWAP_HISTORY_FILE, JSON.stringify(swapHistory, null, 2));
  } catch (e) {
    console.warn('[trading] Could not save swap history');
  }
}

// Initialize swap history on load
loadSwapHistory();

// Helper: Get token balance
async function getTokenBalance(tokenSymbol: string): Promise<{ balance: bigint; formatted: string; decimals: number }> {
  if (!serverWallet || !serverProvider) throw new Error('Wallet not configured');

  if (tokenSymbol === 'ETH') {
    const balance = await serverProvider.getBalance(serverWallet.address);
    return { balance, formatted: ethers.formatEther(balance), decimals: 18 };
  }

  const token = TOKENS[tokenSymbol];
  if (!token) throw new Error(`Unknown token: ${tokenSymbol}`);

  const contract = new ethers.Contract(token.address, ERC20_ABI, serverProvider);
  const balance = await contract.balanceOf(serverWallet.address);
  const formatted = ethers.formatUnits(balance, token.decimals);
  return { balance, formatted, decimals: token.decimals };
}

// Helper: Approve token spending
async function ensureApproval(tokenSymbol: string, amount: bigint): Promise<void> {
  if (!serverWallet) throw new Error('Wallet not configured');
  if (tokenSymbol === 'ETH') return; // ETH doesn't need approval

  const token = TOKENS[tokenSymbol];
  if (!token) throw new Error(`Unknown token: ${tokenSymbol}`);

  const contract = new ethers.Contract(token.address, ERC20_ABI, serverWallet);
  const allowance = await contract.allowance(serverWallet.address, UNISWAP_ROUTER);

  if (allowance < amount) {
    console.log(`[trading] Approving ${tokenSymbol} for Uniswap...`);
    const tx = await contract.approve(UNISWAP_ROUTER, ethers.MaxUint256);
    await tx.wait();
    console.log(`[trading] ${tokenSymbol} approved`);
  }
}

// Helper: Wrap ETH to WETH
async function wrapETH(amount: bigint): Promise<string> {
  if (!serverWallet) throw new Error('Wallet not configured');
  const weth = new ethers.Contract(TOKENS.WETH.address, WETH_ABI, serverWallet);
  const tx = await weth.deposit({ value: amount });
  const receipt = await tx.wait();
  return receipt.hash;
}

// Helper: Unwrap WETH to ETH
async function unwrapWETH(amount: bigint): Promise<string> {
  if (!serverWallet) throw new Error('Wallet not configured');
  const weth = new ethers.Contract(TOKENS.WETH.address, WETH_ABI, serverWallet);
  const tx = await weth.withdraw(amount);
  const receipt = await tx.wait();
  return receipt.hash;
}

// Mempool data interface
interface MempoolSnapshot {
  chain: string;
  fetchedAt: number;
  txCount: number;
  avgGasPriceGwei: number;
  totalValueEth: number;
  tags: string[];
  anomalyScore: number;
  deltaTx: number;
  deltaValue: number;
}

interface MempoolPrediction {
  chain: string;
  tags: string[];
  confidence: number;
  etaSeconds: number;
  reasons: string[];
}

// Read current mempool state
function getMempoolData(): { snapshot: MempoolSnapshot | null; prediction: MempoolPrediction | null } {
  try {
    const snapshotPath = path.join(DEFAULT_DATA_DIR, 'mempool', 'eth.json');
    const predictionPath = path.join(DEFAULT_DATA_DIR, 'mempool', 'predictions', 'eth.json');

    let snapshot: MempoolSnapshot | null = null;
    let prediction: MempoolPrediction | null = null;

    if (existsSync(snapshotPath)) {
      snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    }
    if (existsSync(predictionPath)) {
      prediction = JSON.parse(readFileSync(predictionPath, 'utf-8'));
    }

    return { snapshot, prediction };
  } catch (e) {
    return { snapshot: null, prediction: null };
  }
}

// Analyze mempool for trading signals
function analyzeMempoolSignals(snapshot: MempoolSnapshot | null, prediction: MempoolPrediction | null) {
  if (!snapshot) return { signal: 'neutral', confidence: 0, reasons: [] as string[], metrics: {} };

  const reasons: string[] = [];
  let bullishScore = 0;
  let bearishScore = 0;
  const metrics: Record<string, any> = {};

  // === VALUE ANALYSIS ===
  metrics.valueEth = snapshot.totalValueEth;
  if (snapshot.totalValueEth > 1000) {
    reasons.push(`Very high value: ${snapshot.totalValueEth.toFixed(1)} ETH (whale activity likely)`);
    bullishScore += 30;
  } else if (snapshot.totalValueEth > 500) {
    reasons.push(`High value: ${snapshot.totalValueEth.toFixed(1)} ETH`);
    bullishScore += 20;
  } else if (snapshot.totalValueEth > 100) {
    reasons.push(`Moderate value: ${snapshot.totalValueEth.toFixed(1)} ETH`);
    bullishScore += 10;
  } else if (snapshot.totalValueEth < 10) {
    reasons.push(`Low mempool value: ${snapshot.totalValueEth.toFixed(2)} ETH (quiet)`);
  }

  // === TX COUNT ANALYSIS ===
  metrics.txCount = snapshot.txCount;
  if (snapshot.txCount > 500) {
    reasons.push(`Very high TX count: ${snapshot.txCount} (congestion)`);
    bullishScore += 15;
  } else if (snapshot.txCount > 200) {
    reasons.push(`High TX count: ${snapshot.txCount}`);
    bullishScore += 10;
  } else if (snapshot.txCount < 50) {
    reasons.push(`Low TX count: ${snapshot.txCount} (quiet period)`);
    bearishScore += 5;
  }

  // === DELTA ANALYSIS (rate of change) ===
  metrics.deltaTx = snapshot.deltaTx;
  metrics.deltaValue = snapshot.deltaValue;

  if (snapshot.deltaTx > 100) {
    reasons.push(`TX surge: +${snapshot.deltaTx} pending (rapid growth)`);
    bullishScore += 20;
  } else if (snapshot.deltaTx > 50) {
    reasons.push(`TX increase: +${snapshot.deltaTx}`);
    bullishScore += 10;
  } else if (snapshot.deltaTx < -100) {
    reasons.push(`TX drop: ${snapshot.deltaTx} (clearing out)`);
    bearishScore += 10;
  }

  if (snapshot.deltaValue > 500) {
    reasons.push(`Value inflow: +${snapshot.deltaValue.toFixed(1)} ETH (accumulation)`);
    bullishScore += 25;
  } else if (snapshot.deltaValue > 100) {
    reasons.push(`Value increase: +${snapshot.deltaValue.toFixed(1)} ETH`);
    bullishScore += 15;
  } else if (snapshot.deltaValue < -500) {
    reasons.push(`Value outflow: ${snapshot.deltaValue.toFixed(1)} ETH (distribution)`);
    bearishScore += 25;
  } else if (snapshot.deltaValue < -100) {
    reasons.push(`Value decrease: ${snapshot.deltaValue.toFixed(1)} ETH`);
    bearishScore += 15;
  }

  // === TAG ANALYSIS ===
  metrics.tags = snapshot.tags;

  if (snapshot.tags.includes('DEX_ACTIVITY')) {
    reasons.push('DEX swaps detected');
    bullishScore += 12;
  }
  if (snapshot.tags.includes('HIGH_THROUGHPUT')) {
    reasons.push('High throughput detected');
    bullishScore += 8;
  }
  if (snapshot.tags.includes('NFT_ACTIVITY')) {
    reasons.push('NFT activity detected');
    bullishScore += 5;
  }
  if (snapshot.tags.includes('WHALE_ACCUMULATION') || snapshot.tags.includes('LARGE_TRANSFER')) {
    reasons.push('Large transfers/whale activity');
    bullishScore += 25;
  }
  if (snapshot.tags.includes('WHALE_DISTRIBUTION')) {
    reasons.push('Whale distribution detected');
    bearishScore += 25;
  }
  if (snapshot.tags.includes('CONTRACT_DEPLOYMENT')) {
    reasons.push('Contract deployments detected');
    bullishScore += 8;
  }
  if (snapshot.tags.includes('FLASH_LOAN')) {
    reasons.push('Flash loan activity');
    bullishScore += 5;
    bearishScore += 5; // neutral - could go either way
  }
  if (snapshot.tags.includes('MEV_ACTIVITY') || snapshot.tags.includes('SANDWICH')) {
    reasons.push('MEV/sandwich activity detected');
    bearishScore += 10;
  }

  // === ANOMALY ANALYSIS ===
  metrics.anomalyScore = snapshot.anomalyScore;
  if (snapshot.anomalyScore > 0.8) {
    reasons.push(`Very high anomaly: ${(snapshot.anomalyScore * 100).toFixed(0)}% (unusual patterns)`);
    bullishScore += 20;
  } else if (snapshot.anomalyScore > 0.6) {
    reasons.push(`Elevated anomaly: ${(snapshot.anomalyScore * 100).toFixed(0)}%`);
    bullishScore += 12;
  } else if (snapshot.anomalyScore > 0.4) {
    reasons.push(`Moderate anomaly: ${(snapshot.anomalyScore * 100).toFixed(0)}%`);
    bullishScore += 5;
  }

  // === GAS ANALYSIS ===
  metrics.avgGas = snapshot.avgGasPriceGwei;
  if (snapshot.avgGasPriceGwei > 100) {
    reasons.push(`Very high gas: ${snapshot.avgGasPriceGwei} gwei (high demand)`);
    bullishScore += 15;
  } else if (snapshot.avgGasPriceGwei > 50) {
    reasons.push(`Elevated gas: ${snapshot.avgGasPriceGwei} gwei`);
    bullishScore += 10;
  } else if (snapshot.avgGasPriceGwei < 10 && snapshot.avgGasPriceGwei > 0) {
    reasons.push(`Low gas: ${snapshot.avgGasPriceGwei} gwei (low demand)`);
    bearishScore += 5;
  }

  // === PREDICTION INTEGRATION ===
  if (prediction && prediction.confidence > 0.5) {
    metrics.predictionConfidence = prediction.confidence;
    reasons.push(`Prediction confidence: ${(prediction.confidence * 100).toFixed(0)}%`);
    if (prediction.tags.includes('BULLISH')) bullishScore += 15;
    if (prediction.tags.includes('BEARISH')) bearishScore += 15;
  }

  const netScore = bullishScore - bearishScore;
  const confidence = Math.min(Math.abs(netScore) / 100, 1);

  return {
    signal: netScore > 15 ? 'bullish' : netScore < -15 ? 'bearish' : 'neutral',
    strength: Math.abs(netScore) > 50 ? 'strong' : Math.abs(netScore) > 25 ? 'moderate' : 'weak',
    confidence,
    reasons,
    bullishScore,
    bearishScore,
    netScore,
    metrics,
    snapshot: {
      txCount: snapshot.txCount,
      totalValueEth: snapshot.totalValueEth,
      anomalyScore: snapshot.anomalyScore,
      tags: snapshot.tags,
      deltaTx: snapshot.deltaTx,
      deltaValue: snapshot.deltaValue,
      avgGas: snapshot.avgGasPriceGwei,
    },
  };
}

// Determine signal regime from YYSFOLD signals + mempool
function determineSignalRegime(signals: any, market: any, mempool?: ReturnType<typeof analyzeMempoolSignals>): SignalRegime {
  const { bullishScore = 50, riskScore = 50, fearGreedIndex = 50 } = market || {};
  const { momentumAlignment, altcoinSeason, volumeAnomaly } = market || {};

  // Mempool override: strong bearish mempool signal = risk off
  if (mempool?.signal === 'bearish' && mempool.confidence > 0.5) {
    return 'risk_off';
  }

  // Risk-off: High risk score or extreme fear
  if (riskScore > 70 || fearGreedIndex < 25) {
    return 'risk_off';
  }

  // Alt rotation: Altcoin season indicator
  if (altcoinSeason) {
    return 'alt_rotation';
  }

  // BTC strength: When BTC dominance rising (simplified)
  if (bullishScore > 60 && !altcoinSeason && momentumAlignment) {
    return 'btc_strength';
  }

  // Risk-on: High bullish score, low fear, or strong bullish mempool
  if (bullishScore > 65 && fearGreedIndex > 50) {
    return 'risk_on';
  }

  // Mempool bullish can push to risk-on
  if (mempool?.signal === 'bullish' && mempool.confidence > 0.4 && bullishScore > 50) {
    return 'risk_on';
  }

  return 'neutral';
}

// Helper: Get portfolio data (reusable)
async function getPortfolioData() {
  if (!serverWallet || !serverProvider) {
    throw new Error('Wallet not configured');
  }

  const holdings: Record<string, { balance: string; valueUSD: number }> = {};
  let totalValueUSD = 0;

  // Get ETH balance
  const ethBal = await getTokenBalance('ETH');
  const ethPrice = 3000; // TODO: fetch from market data
  holdings['ETH'] = {
    balance: parseFloat(ethBal.formatted).toFixed(4),
    valueUSD: parseFloat(ethBal.formatted) * ethPrice
  };
  totalValueUSD += holdings['ETH'].valueUSD;

  // Get WETH balance
  const wethBal = await getTokenBalance('WETH');
  holdings['WETH'] = {
    balance: parseFloat(wethBal.formatted).toFixed(4),
    valueUSD: parseFloat(wethBal.formatted) * ethPrice
  };
  totalValueUSD += holdings['WETH'].valueUSD;

  // Get USDC balance
  const usdcBal = await getTokenBalance('USDC');
  holdings['USDC'] = {
    balance: parseFloat(usdcBal.formatted).toFixed(2),
    valueUSD: parseFloat(usdcBal.formatted)
  };
  totalValueUSD += holdings['USDC'].valueUSD;

  // Get WBTC balance
  try {
    const wbtcBal = await getTokenBalance('WBTC');
    const btcPrice = 90000; // TODO: fetch from market data
    holdings['WBTC'] = {
      balance: parseFloat(wbtcBal.formatted).toFixed(6),
      valueUSD: parseFloat(wbtcBal.formatted) * btcPrice
    };
    totalValueUSD += holdings['WBTC'].valueUSD;
  } catch { /* Token might not exist */ }

  // Get UNI balance
  try {
    const uniBal = await getTokenBalance('UNI');
    const uniPrice = 8; // Approximate UNI price
    holdings['UNI'] = {
      balance: parseFloat(uniBal.formatted).toFixed(4),
      valueUSD: parseFloat(uniBal.formatted) * uniPrice
    };
    totalValueUSD += holdings['UNI'].valueUSD;
  } catch { /* Token might not exist */ }

  // Get LINK balance
  try {
    const linkBal = await getTokenBalance('LINK');
    const linkPrice = 15; // Approximate LINK price
    holdings['LINK'] = {
      balance: parseFloat(linkBal.formatted).toFixed(4),
      valueUSD: parseFloat(linkBal.formatted) * linkPrice
    };
    totalValueUSD += holdings['LINK'].valueUSD;
  } catch { /* Token might not exist */ }

  // Calculate allocations
  const allocations: Record<string, number> = {};
  for (const [token, data] of Object.entries(holdings)) {
    allocations[token] = totalValueUSD > 0 ? (data.valueUSD / totalValueUSD) * 100 : 0;
  }

  return {
    address: serverWallet!.address,
    holdings,
    totalValueUSD: totalValueUSD.toFixed(2),
    allocations,
    timestamp: new Date().toISOString(),
  };
}

// Helper: Get regime data (reusable) - uses fetchLiveMarketData
async function getRegimeData() {
  const market = await fetchLiveMarketData();
  const { snapshot, prediction } = getMempoolData();
  const mempoolAnalysis = analyzeMempoolSignals(snapshot, prediction);
  const regime = determineSignalRegime(null, market, mempoolAnalysis);
  const targetAllocation = TARGET_ALLOCATIONS[regime];
  return { regime, targetAllocation, market, mempool: mempoolAnalysis };
}

// Mempool signals endpoint
app.get('/trading-bot/mempool', (_req, res) => {
  const { snapshot, prediction } = getMempoolData();
  const analysis = analyzeMempoolSignals(snapshot, prediction);
  res.json({
    snapshot,
    prediction,
    analysis,
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// PREDICTIVE ENGINE ENDPOINTS
// ============================================

// Helper: Gather all signals for prediction
async function gatherSignalSnapshot(chain: string = 'eth'): Promise<SignalSnapshot> {
  const market = await fetchLiveMarketData();
  const { snapshot: mempoolSnapshot } = getMempoolData();

  // Load recent fingerprints and tags
  const fingerprints = loadTradingFingerprints(chain, 10);
  const tags = loadTradingTags(chain, 10);

  // Compute drift velocity
  let driftVelocity = 0;
  let driftAcceleration = 0;
  if (fingerprints.length >= 2) {
    const drift = computeDriftVelocity(
      fingerprints[fingerprints.length - 1],
      fingerprints[fingerprints.length - 2],
      fingerprints.length >= 3 ? fingerprints[fingerprints.length - 3] : undefined
    );
    driftVelocity = drift.velocity;
    driftAcceleration = drift.acceleration;
  }

  // Compute entropy
  let entropy = 0.5;
  let entropyChange = 0;
  if (fingerprints.length >= 1) {
    entropy = computeEntropy(fingerprints[fingerprints.length - 1]);
    if (fingerprints.length >= 2) {
      const prevEntropy = computeEntropy(fingerprints[fingerprints.length - 2]);
      entropyChange = entropy - prevEntropy;
    }
  }

  // Compute tag acceleration - tags are already Record<string, number>[] from loadTradingTags
  const tagAccel = computeTagAcceleration(tags);

  // Get latest block anomaly score - compute from hotzones
  const latestBlock = getLatestBlockSummary();
  let anomalyScore = 0.1;
  if (latestBlock?.hotzonesPath && existsSync(latestBlock.hotzonesPath)) {
    try {
      const hotzonesData = JSON.parse(readFileSync(latestBlock.hotzonesPath, 'utf-8'));
      const hotzones = hotzonesData.hotzones ?? hotzonesData;
      const anomalyResult = computeAnomalyScore({ hotzones, tagVector: latestBlock.tags ?? [] });
      anomalyScore = anomalyResult.score;
    } catch { /* use fallback */ }
  }

  return {
    // On-chain signals
    driftVelocity,
    driftAcceleration,
    entropy,
    entropyChange,
    anomalyScore,

    // Mempool signals
    mempoolTxCount: mempoolSnapshot?.txCount ?? 0,
    mempoolValueEth: mempoolSnapshot?.totalValueEth ?? 0,
    mempoolDeltaTx: mempoolSnapshot?.deltaTx ?? 0,
    mempoolDeltaValue: mempoolSnapshot?.deltaValue ?? 0,
    mempoolAnomalyScore: mempoolSnapshot?.anomalyScore ?? 0,

    // Tag signals
    emergingTags: tagAccel.emergingTags,
    decliningTags: tagAccel.decliningTags,
    dominantTag: tagAccel.emergingTags[0] ?? null,
    tagVelocitySum: Object.values(tagAccel.tagVelocities).reduce((a, b) => a + b, 0),

    // External signals (from market data)
    fearGreedIndex: market?.fearGreedIndex ?? 50,
    fundingRate: ((market?.btcFunding ?? 0) + (market?.ethFunding ?? 0)) / 2, // Average funding
    openInterestChange: market?.leverageRisk ?? 0, // Use leverage risk as proxy
    liquidationRatio: market?.liquidationRatio ?? 1,
    cascadeRisk: 0, // Will be computed separately
    whaleNetFlow: market?.smartMoneyFlow ?? 0, // Use smart money flow

    // Pattern signals (computed during prediction)
    patternMatch: null,
    patternConfidence: 0,
    fingerprintSimilarity: 0,
  };
}

// Generate unified prediction
app.get('/trading-bot/prediction', async (req, res) => {
  try {
    const chain = (req.query.chain as string) || 'eth';
    const signals = await gatherSignalSnapshot(chain);
    const { snapshot: mempoolSnapshot } = getMempoolData();

    // Get mempool prediction
    const mempoolPrediction = predictBlockFromMempool(mempoolSnapshot ? {
      txCount: mempoolSnapshot.txCount,
      totalValueEth: mempoolSnapshot.totalValueEth,
      avgGasPriceGwei: mempoolSnapshot.avgGasPriceGwei,
      tags: mempoolSnapshot.tags || [],
      anomalyScore: mempoolSnapshot.anomalyScore,
      deltaTx: mempoolSnapshot.deltaTx,
      deltaValue: mempoolSnapshot.deltaValue,
    } : null);

    // Assess cascade risk
    const market = await fetchLiveMarketData();
    const cascadeRisk = assessCascadeRisk(
      market?.btcPrice ?? 90000,
      market?.volatility ?? 0, // Use volatility as price change proxy
      signals.driftVelocity,
      signals.anomalyScore,
      signals.fundingRate,
      signals.openInterestChange,
      [] // Would need liquidation levels from external API
    );
    signals.cascadeRisk = cascadeRisk.overallRisk;

    // Find similar historical patterns
    const fingerprints = loadTradingFingerprints(chain, 10);
    const currentFP = fingerprints[fingerprints.length - 1] || [];
    const similarPatterns = findSimilarPatterns(currentFP, 5);

    // Generate unified prediction
    const prediction = generateUnifiedPrediction(
      chain,
      signals,
      mempoolPrediction,
      cascadeRisk,
      similarPatterns
    );

    // Record this prediction for learning
    const predictionId = recordPrediction(prediction, signals);

    res.json({
      prediction,
      predictionId,
      mempoolPrediction,
      cascadeRisk,
      similarPatterns: similarPatterns.slice(0, 3),
      signals,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[prediction] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Record prediction outcome (for learning)
app.post('/trading-bot/prediction/outcome', (req, res) => {
  try {
    const { predictionId, actualPriceChange } = req.body;

    if (!predictionId || actualPriceChange === undefined) {
      return res.status(400).json({ error: 'Missing predictionId or actualPriceChange' });
    }

    const wasCorrect = recordOutcome(predictionId, actualPriceChange);

    res.json({
      predictionId,
      wasCorrect,
      actualPriceChange,
      message: wasCorrect ? 'Prediction was correct!' : 'Prediction was incorrect',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get prediction statistics
app.get('/trading-bot/prediction/stats', (_req, res) => {
  try {
    const stats = getPredictionStats();
    const patterns = getPatternPerformance();

    res.json({
      stats,
      patterns,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cascade risk assessment endpoint
app.get('/trading-bot/cascade-risk', async (_req, res) => {
  try {
    const signals = await gatherSignalSnapshot('eth');
    const market = await fetchLiveMarketData();

    // Get real liquidation data for cascade risk
    const liquidationLevels = await getLiquidationLevelsForCascade();
    const currentPrice = market?.btcPrice ?? 90000;
    const volatility = market?.volatility ?? 0.05;

    const cascadeProb = calculateCascadeProbability(currentPrice, liquidationLevels, volatility);

    const cascadeRisk = assessCascadeRisk(
      currentPrice,
      volatility, // Use volatility as price change proxy
      signals.driftVelocity,
      signals.anomalyScore,
      signals.fundingRate,
      signals.openInterestChange,
      liquidationLevels
    );

    res.json({
      ...cascadeRisk,
      liquidationCascade: cascadeProb,
      signals: {
        driftVelocity: signals.driftVelocity,
        anomalyScore: signals.anomalyScore,
        fundingRate: signals.fundingRate,
        openInterestChange: signals.openInterestChange,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// REAL LIQUIDATION DATA ENDPOINTS
// ============================================================

// Get live liquidation heatmap data
app.get('/trading-bot/liquidations', async (_req, res) => {
  try {
    const data = await fetchLiquidationData();
    res.json({
      ...data,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// OUTCOME TRACKING ENDPOINTS
// ============================================================

// Get outcome tracking statistics
app.get('/trading-bot/outcomes/stats', (_req, res) => {
  try {
    const stats = getOutcomeStats();
    res.json({
      ...stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger outcome check
app.post('/trading-bot/outcomes/check', async (_req, res) => {
  try {
    const result = await checkPendingOutcomes();
    res.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get current price
app.get('/trading-bot/price/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const price = await fetchCurrentPrice(symbol);
    res.json({
      symbol,
      price,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// BACKTESTING ENDPOINTS
// ============================================================

// Run a backtest
app.post('/trading-bot/backtest', async (req, res) => {
  try {
    const config = {
      chain: req.body.chain ?? 'eth',
      startBlock: req.body.startBlock,
      endBlock: req.body.endBlock,
      timeframe: req.body.timeframe ?? '1h',
      signalThreshold: req.body.signalThreshold ?? 0.5,
    };

    const result = await runBacktest(config);
    res.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get backtest summary
app.get('/trading-bot/backtest/summary', (_req, res) => {
  try {
    const summary = getBacktestSummary();
    res.json({
      ...summary,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get historical prices for charting
app.get('/trading-bot/prices/history/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const days = parseInt(req.query.days as string) || 30;
    const prices = await fetchHistoricalPrices(symbol, days);
    res.json({
      symbol,
      days,
      prices,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PATTERN DISCOVERY ENDPOINTS
// ============================================================

// Discover patterns from historical data
app.post('/trading-bot/patterns/discover', (req, res) => {
  try {
    const chain = req.body.chain ?? 'eth';
    const config = {
      k: req.body.k ?? 8,
      maxIterations: req.body.maxIterations ?? 100,
      convergenceThreshold: req.body.convergenceThreshold ?? 0.001,
      minSamplesPerCluster: req.body.minSamplesPerCluster ?? 5,
    };

    const patterns = discoverPatterns(chain, config);
    res.json({
      patterns,
      count: patterns.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get discovered patterns
app.get('/trading-bot/patterns/discovered', (_req, res) => {
  try {
    res.json({
      patterns: discoveredPatterns,
      count: discoveredPatterns.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Match a fingerprint against patterns
app.post('/trading-bot/patterns/match', (req, res) => {
  try {
    const fingerprint = req.body.fingerprint;
    if (!Array.isArray(fingerprint)) {
      return res.status(400).json({ error: 'fingerprint must be an array of numbers' });
    }

    const matches = matchFingerprint(fingerprint);
    const prediction = getPatternPrediction(fingerprint);

    res.json({
      matches,
      prediction,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// MULTI-TIMEFRAME & POSITION SIZING ENDPOINTS
// ============================================================

// Get multi-timeframe prediction
app.get('/trading-bot/prediction/multi-timeframe', async (req, res) => {
  try {
    const chain = (req.query.chain as string) ?? 'eth';
    const portfolioValue = parseFloat(req.query.portfolioValue as string) || 10000;

    // Gather current signals
    const signals = await gatherSignalSnapshot(chain);
    const { snapshot: mempoolSnapshot } = getMempoolData();

    // Get mempool prediction
    const mempoolPrediction = predictBlockFromMempool(mempoolSnapshot ? {
      txCount: mempoolSnapshot.txCount,
      totalValueEth: mempoolSnapshot.totalValueEth,
      avgGasPriceGwei: mempoolSnapshot.avgGasPriceGwei,
      tags: mempoolSnapshot.tags || [],
      anomalyScore: mempoolSnapshot.anomalyScore,
      deltaTx: mempoolSnapshot.deltaTx,
      deltaValue: mempoolSnapshot.deltaValue,
    } : null);

    // Get real liquidation data for cascade risk
    const liquidationLevels = await getLiquidationLevelsForCascade();
    const market = await fetchLiveMarketData();

    const cascadeRisk = assessCascadeRisk(
      market?.btcPrice ?? 90000,
      market?.volatility ?? 0,
      signals.driftVelocity,
      signals.anomalyScore,
      signals.fundingRate,
      signals.openInterestChange,
      liquidationLevels
    );
    signals.cascadeRisk = cascadeRisk.overallRisk;

    const fingerprints = loadTradingFingerprints(chain, 10);
    const currentFP = fingerprints[fingerprints.length - 1] || [];
    const similarPatterns = findSimilarPatterns(currentFP, 5);

    // Get base prediction
    const basePrediction = generateUnifiedPrediction(
      chain,
      signals,
      mempoolPrediction,
      cascadeRisk,
      similarPatterns
    );

    // Generate multi-timeframe prediction
    const mtfPrediction = generateMultiTimeframePrediction(
      chain,
      basePrediction.direction,
      basePrediction.confidence,
      {
        driftVelocity: signals.driftVelocity,
        anomalyScore: signals.anomalyScore,
        fundingRate: signals.fundingRate,
        openInterestChange: signals.openInterestChange,
      }
    );

    // Get recommended action with position sizing
    const action = getMultiTimeframeAction(mtfPrediction, portfolioValue);

    // Register prediction for outcome tracking
    if (basePrediction.direction !== 'neutral') {
      registerPredictionForTracking(
        `mtf-${Date.now()}`,
        chain,
        basePrediction.direction,
        basePrediction.confidence,
        mtfPrediction.recommendedTimeframe
      ).catch(() => {}); // Don't block on registration
    }

    res.json({
      multiTimeframe: mtfPrediction,
      action,
      basePrediction: {
        direction: basePrediction.direction,
        confidence: basePrediction.confidence,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Calculate Kelly position size
app.post('/trading-bot/position-size', (req, res) => {
  try {
    const direction = req.body.direction ?? 'neutral';
    const confidence = req.body.confidence ?? 0.5;
    const timeframe = (req.body.timeframe ?? '1h') as Timeframe;
    const portfolioValue = req.body.portfolioValue ?? 10000;
    const riskTolerance = req.body.riskTolerance ?? 0.02;

    const recommendation = calculateKellyPosition(
      direction,
      confidence,
      timeframe,
      portfolioValue,
      riskTolerance
    );

    res.json({
      ...recommendation,
      input: { direction, confidence, timeframe, portfolioValue, riskTolerance },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get timeframe stats
app.get('/trading-bot/timeframe-stats', (_req, res) => {
  try {
    res.json({
      stats: timeframeStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update timeframe stats with outcome
app.post('/trading-bot/timeframe-stats/update', (req, res) => {
  try {
    const timeframe = req.body.timeframe as Timeframe;
    const wasCorrect = req.body.wasCorrect as boolean;
    const actualReturn = req.body.actualReturn as number;

    if (!timeframe || wasCorrect === undefined || actualReturn === undefined) {
      return res.status(400).json({ error: 'Missing required fields: timeframe, wasCorrect, actualReturn' });
    }

    updateTimeframeStats(timeframe, wasCorrect, actualReturn);

    res.json({
      success: true,
      stats: timeframeStats[timeframe],
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Swap history endpoint
app.get('/trading-bot/swaps', (_req, res) => {
  res.json({
    swaps: swapHistory,
    count: swapHistory.length,
  });
});

// Portfolio endpoint - get current holdings
app.get('/trading-bot/portfolio', async (_req, res) => {
  try {
    const portfolio = await getPortfolioData();
    res.json(portfolio);
  } catch (error: any) {
    console.error('[portfolio] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Execute a Uniswap swap (reusable)
async function executeSwapInternal(fromToken: string, toToken: string, amount: string, slippage = PORTFOLIO_CONFIG.defaultSlippage) {
  if (!serverWallet || !serverProvider) {
    throw new Error('Wallet not configured');
  }

  console.log('[swap] Request:', { fromToken, toToken, amount, slippage });

  // Validate tokens
  const validTokens = ['ETH', 'WETH', 'USDC', 'WBTC', 'UNI', 'LINK'];
  if (!validTokens.includes(fromToken) || !validTokens.includes(toToken)) {
    throw new Error(`Invalid tokens. Use: ${validTokens.join(', ')}`);
  }

  if (fromToken === toToken) {
    throw new Error('Cannot swap same token');
  }

  // Get from token info
  const fromTokenInfo = fromToken === 'ETH' ? { address: TOKENS.WETH.address, decimals: 18 } : TOKENS[fromToken];
  const toTokenInfo = toToken === 'ETH' ? { address: TOKENS.WETH.address, decimals: 18 } : TOKENS[toToken];

  // Parse amount
  const amountIn = ethers.parseUnits(amount.toString(), fromTokenInfo.decimals);

  // Check balance
  const balance = await getTokenBalance(fromToken);
  if (balance.balance < amountIn) {
    throw new Error(`Insufficient ${fromToken} balance. Have: ${balance.formatted}`);
  }

  // For ETH -> token swaps, we need to wrap ETH first
  let actualFromAddress = fromTokenInfo.address;
  if (fromToken === 'ETH') {
    console.log('[swap] Wrapping ETH to WETH...');
    await wrapETH(amountIn);
    actualFromAddress = TOKENS.WETH.address;
  }

  // Ensure approval
  const tokenToApprove = fromToken === 'ETH' ? 'WETH' : fromToken;
  await ensureApproval(tokenToApprove, amountIn);

  // Build swap params
  const swapParams = {
    tokenIn: actualFromAddress,
    tokenOut: toTokenInfo.address,
    fee: PORTFOLIO_CONFIG.poolFee,
    recipient: serverWallet.address,
    amountIn: amountIn,
    amountOutMinimum: 0n, // Accept any amount for now (testnet)
    sqrtPriceLimitX96: 0n,
  };

  console.log('[swap] Executing swap:', swapParams);

  const router = new ethers.Contract(UNISWAP_ROUTER, SWAP_ROUTER_ABI, serverWallet);
  const tx = await router.exactInputSingle(swapParams);

  console.log('[swap] Transaction sent:', tx.hash);
  const receipt = await tx.wait();
  console.log('[swap] Transaction confirmed:', receipt.hash);

  // If swapping to ETH, unwrap WETH
  if (toToken === 'ETH') {
    const wethBalance = await getTokenBalance('WETH');
    if (wethBalance.balance > 0n) {
      console.log('[swap] Unwrapping WETH to ETH...');
      await unwrapWETH(wethBalance.balance);
    }
  }

  const swapRecord: SwapRecord = {
    txHash: receipt.hash,
    fromToken,
    toToken,
    amountIn: amount,
    timestamp: new Date().toISOString(),
    status: 'confirmed',
  };

  // Add to history (keep last 50) and persist
  swapHistory.unshift(swapRecord);
  if (swapHistory.length > 50) swapHistory.pop();
  saveSwapHistory();

  return {
    success: true,
    ...swapRecord,
  };
}

// Swap endpoint - execute a Uniswap swap
app.post('/trading-bot/swap', async (req, res) => {
  if (!serverWallet || !serverProvider) {
    return res.status(400).json({ error: 'Wallet not configured' });
  }

  try {
    const { fromToken, toToken, amount, slippage } = req.body;
    const result = await executeSwapInternal(fromToken, toToken, amount, slippage);
    res.json(result);
  } catch (error: any) {
    console.error('[swap] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Signal regime endpoint - get current regime and target allocation
app.get('/trading-bot/regime', async (_req, res) => {
  try {
    const regimeData = await getRegimeData();
    res.json(regimeData);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Rebalance endpoint - automatically rebalance to target allocation
app.post('/trading-bot/rebalance', async (req, res) => {
  if (!serverWallet || !serverProvider) {
    return res.status(400).json({ error: 'Wallet not configured' });
  }

  try {
    // Get current portfolio and regime using helper functions
    const portfolio = await getPortfolioData();
    const regimeData = await getRegimeData();

    const { regime, targetAllocation } = regimeData;
    const { allocations, totalValueUSD } = portfolio;

    // Calculate required trades
    const trades: Array<{ from: string; to: string; amount: string; reason: string }> = [];

    for (const [token, targetPct] of Object.entries(targetAllocation) as [string, number][]) {
      const currentPct = (allocations[token] as number) || 0;
      const diff = targetPct - currentPct;

      // Only trade if difference > 5%
      if (Math.abs(diff) > 5) {
        const tradeValueUSD = Math.abs(diff) * parseFloat(totalValueUSD) / 100;

        if (diff > 0) {
          // Need to buy this token - sell USDC or overweight token
          const sellToken = (allocations['USDC'] as number || 0) > (targetAllocation['USDC'] || 0) ? 'USDC' : 'ETH';
          trades.push({
            from: sellToken,
            to: token,
            amount: tradeValueUSD.toFixed(2),
            reason: `Increase ${token} from ${currentPct.toFixed(1)}% to ${targetPct}%`,
          });
        } else {
          // Need to sell this token
          trades.push({
            from: token,
            to: 'USDC',
            amount: tradeValueUSD.toFixed(2),
            reason: `Decrease ${token} from ${currentPct.toFixed(1)}% to ${targetPct}%`,
          });
        }
      }
    }

    res.json({
      regime,
      currentAllocations: allocations,
      targetAllocation,
      suggestedTrades: trades,
      totalValueUSD,
      message: trades.length > 0
        ? `${trades.length} trades suggested for ${regime} regime`
        : 'Portfolio already balanced',
    });
  } catch (error: any) {
    console.error('[rebalance] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Trading mode: set to true to enable automatic trades
const LIVE_TRADING_ENABLED = true; // ENABLED - using server wallet for trades
const MIN_CONFIDENCE_THRESHOLD = 0.75; // Only trade on high-confidence signals

// Execute strategy using Uniswap (replaces old vault-based execute)
app.post('/trading-bot/execute', async (req, res) => {
  if (!serverWallet) {
    return res.status(400).json({ error: 'Server wallet not configured' });
  }

  // Check if live trading is enabled
  if (!LIVE_TRADING_ENABLED) {
    console.log('[execute] Live trading disabled - signal logged only');
    const { asset, isBuy, targetPrice, confidence } = req.body;
    return res.json({
      success: true,
      mode: 'simulation',
      message: 'Live trading disabled. Signal recorded.',
      signal: { asset, isBuy, targetPrice, confidence },
    });
  }

  try {
    let { asset, isBuy, targetPrice, confidence = 0, amount } = req.body;

    // Check confidence threshold
    if (confidence < MIN_CONFIDENCE_THRESHOLD) {
      console.log(`[execute] Skipping low-confidence signal: ${confidence}`);
      return res.json({
        success: false,
        message: `Signal confidence ${confidence} below threshold ${MIN_CONFIDENCE_THRESHOLD}`,
      });
    }

    // SOL isn't on Ethereum - map SOL signals to ETH
    if (asset === 'SOL') {
      console.log('[execute] Mapping SOL signal to ETH (SOL not on Uniswap)');
      asset = 'ETH';
    }

    console.log('[execute] Request:', { asset, isBuy, targetPrice, confidence });

    // Map asset to swap params
    // BUY signal = swap USDC -> asset
    // SELL signal = swap asset -> USDC

    let fromToken: string, toToken: string;
    if (isBuy) {
      // Buying
      if (asset === 'ETH') {
        fromToken = 'USDC';
        toToken = 'WETH';
      } else if (asset === 'BTC') {
        fromToken = 'USDC';
        toToken = 'WBTC';
      } else {
        fromToken = 'USDC';
        toToken = asset;
      }
    } else {
      // Selling
      if (asset === 'ETH') {
        fromToken = 'WETH';
        toToken = 'USDC';
      } else if (asset === 'BTC') {
        fromToken = 'WBTC';
        toToken = 'USDC';
      } else {
        fromToken = 'WETH'; // Default to selling WETH for unsupported assets
        toToken = 'USDC';
      }
    }

    // Use provided amount or calculate based on confidence (higher confidence = bigger trade)
    let swapAmount: string;
    if (amount) {
      swapAmount = amount;
    } else {
      // Scale trade size with confidence: 0.75 = small, 0.9+ = larger
      const scaleFactor = Math.min(confidence, 1.0);
      if (fromToken === 'USDC') {
        const baseAmount = 100; // Base: $100
        swapAmount = String(Math.round(baseAmount * scaleFactor));
      } else {
        const baseAmount = 0.05; // Base: 0.05 ETH
        swapAmount = String(baseAmount * scaleFactor);
      }
    }

    // Execute swap directly using helper function
    const swapResult = await executeSwapInternal(fromToken, toToken, swapAmount);

    res.json({
      success: true,
      txHash: swapResult.txHash,
      action: isBuy ? 'BUY' : 'SELL',
      asset,
      confidence,
      swap: { from: fromToken, to: toToken, amount: swapAmount },
    });
  } catch (error: any) {
    console.error('[execute] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EARLY ALPHA DETECTION ENDPOINTS
// ============================================

// Initialize early alpha scanner on startup
initEarlyAlpha();

// Get scanner status
app.get('/trading-bot/early-alpha/status', (_req, res) => {
  res.json({
    scanning: isScanning(),
    tokensTracked: getNewTokens().length,
    pairsTracked: getLiquidityEvents().length,
    smartWallets: getSmartMoneyWallets().length,
    socialSignals: getSocialSignals().length,
  });
});

// Start/stop scanner
app.post('/trading-bot/early-alpha/scanner', (req, res) => {
  const { action, intervalMs } = req.body;

  if (action === 'start') {
    startEarlyAlphaScanner(intervalMs || 60000);
    res.json({ success: true, message: 'Scanner started' });
  } else if (action === 'stop') {
    stopEarlyAlphaScanner();
    res.json({ success: true, message: 'Scanner stopped' });
  } else {
    res.status(400).json({ error: 'Invalid action. Use "start" or "stop"' });
  }
});

// Manual scan trigger
app.post('/trading-bot/early-alpha/scan', async (req, res) => {
  try {
    const { blocks = 50 } = req.body;
    console.log(`[early-alpha] Manual scan triggered for ${blocks} blocks`);

    const [tokens, pairs, trades] = await Promise.all([
      scanRecentDeployments(blocks),
      scanNewPairs(blocks),
      trackSmartMoney(),
    ]);

    res.json({
      success: true,
      newTokens: tokens.length,
      newPairs: pairs.length,
      smartMoneyTrades: trades.length,
    });
  } catch (error: any) {
    console.error('[early-alpha] Scan error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get new tokens
app.get('/trading-bot/early-alpha/tokens', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getNewTokens(limit));
});

// Get liquidity events
app.get('/trading-bot/early-alpha/liquidity', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getLiquidityEvents(limit));
});

// Get smart money trades
app.get('/trading-bot/early-alpha/smart-money', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json({
    wallets: getSmartMoneyWallets(),
    recentTrades: getSmartMoneyTrades(limit),
  });
});

// Add smart money wallet to track
app.post('/trading-bot/early-alpha/smart-money', (req, res) => {
  const { address, label } = req.body;
  if (!address || !label) {
    return res.status(400).json({ error: 'address and label required' });
  }
  addSmartMoneyWallet(address, label);
  res.json({ success: true, wallets: getSmartMoneyWallets() });
});

// Get social signals
app.get('/trading-bot/early-alpha/social', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getSocialSignals(limit));
});

// Add social signal
app.post('/trading-bot/early-alpha/social', (req, res) => {
  const { source, token, mentions, sentiment, velocity, samplePosts } = req.body;
  if (!source || !mentions) {
    return res.status(400).json({ error: 'source and mentions required' });
  }
  addSocialSignal({ source, token, mentions, sentiment, velocity, samplePosts: samplePosts || [] });
  res.json({ success: true });
});

// Fetch Twitter mentions for a token
app.get('/trading-bot/early-alpha/twitter/:token', async (req, res) => {
  try {
    const result = await fetchTwitterMentions(req.params.token);
    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'No Twitter data or API not configured' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get all early alpha signals (unified scoring)
app.get('/trading-bot/early-alpha/signals', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json(getEarlyAlphaSignals(limit));
});

// Compute early alpha score for specific token
app.get('/trading-bot/early-alpha/score/:address', async (req, res) => {
  try {
    const signal = await computeEarlyAlphaScore(req.params.address);
    if (signal) {
      res.json(signal);
    } else {
      res.status(404).json({ error: 'Token not found or could not be scored' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get combined early alpha dashboard data
app.get('/trading-bot/early-alpha/dashboard', (req, res) => {
  const tokenLimit = parseInt(req.query.tokenLimit as string) || 20;
  const pairLimit = parseInt(req.query.pairLimit as string) || 20;

  // Get tokens with highest scores first
  const tokens = getNewTokens(100).sort((a, b) => b.score - a.score).slice(0, tokenLimit);
  const pairs = getLiquidityEvents(pairLimit);
  const smartMoney = getSmartMoneyTrades(10);
  const social = getSocialSignals(10);
  const signals = getEarlyAlphaSignals(10);

  // Find hottest opportunities (tokens with liquidity + smart money activity)
  const hottestOpportunities = tokens
    .filter(t => {
      const hasLiquidity = pairs.some(p =>
        p.token0.toLowerCase() === t.address.toLowerCase() ||
        p.token1.toLowerCase() === t.address.toLowerCase()
      );
      return hasLiquidity && t.score > 30;
    })
    .slice(0, 5);

  res.json({
    status: {
      scanning: isScanning(),
      lastUpdate: Date.now(),
    },
    summary: {
      newTokens: tokens.length,
      newPairs: pairs.length,
      smartMoneyTrades: smartMoney.length,
      socialSignals: social.length,
      hottestOpportunities: hottestOpportunities.length,
    },
    hottest: hottestOpportunities,
    recentTokens: tokens.slice(0, 10),
    recentPairs: pairs.slice(0, 10),
    smartMoneyActivity: smartMoney,
    socialBuzz: social,
    topSignals: signals,
  });
});

// ============================================
// LLM CHAT INTERFACE ENDPOINTS
// ============================================

// Chat status
app.get('/trading-bot/chat/status', (_req, res) => {
  res.json({
    configured: isChatConfigured(),
    model: 'claude-sonnet-4-20250514',
    features: ['quick-queries', 'token-analysis', 'market-context'],
  });
});

// Quick query (no LLM needed for common queries)
app.post('/trading-bot/chat/quick', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }
    const response = await quickQuery(query);
    res.json(response);
  } catch (error: any) {
    console.error('[chat] Quick query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Full LLM chat with context
app.post('/trading-bot/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // First try quick query for common patterns
    const quickResponse = await quickQuery(message);
    if (quickResponse.data || !isChatConfigured()) {
      return res.json(quickResponse);
    }

    // Fall back to full LLM chat
    const response = await chat(message, history as ChatMessage[]);
    res.json(response);
  } catch (error: any) {
    console.error('[chat] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Analyze specific token
app.post('/trading-bot/chat/analyze', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }
    const response = await analyzeToken(address);
    res.json(response);
  } catch (error: any) {
    console.error('[chat] Analyze error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get suggested queries based on current data
app.get('/trading-bot/chat/suggestions', (_req, res) => {
  const tokens = getNewTokens(5);
  const signals = getEarlyAlphaSignals(3);

  const suggestions = [
    'Show me new tokens',
    'What are the hottest opportunities?',
    'Track smart money activity',
    'Check recent liquidity events',
  ];

  // Add dynamic suggestions based on current data
  if (tokens.length > 0) {
    const topToken = tokens.sort((a, b) => b.score - a.score)[0];
    if (topToken.symbol) {
      suggestions.push(`Analyze ${topToken.symbol}`);
    }
  }

  if (signals.length > 0 && signals[0].symbol) {
    suggestions.push(`Tell me about ${signals[0].symbol}`);
  }

  res.json({ suggestions: suggestions.slice(0, 6) });
});

// ============================================
// PATENT VALIDATOR ENDPOINTS
// Pattern-Based Blockchain Validation Architecture
// USPTO 63/906,240
// ============================================

// Initialize validator network
const validatorNetwork = new ValidatorNetwork();
let patternIndexLoaded = false;
let cachedMetaBlockIndex: MetaBlockIndex | null = null;
let cachedAddressCount = 0;
let cachedTransactionCount = 0;
const addressIndex = new Map<string, Set<number>>();  // address → set of block heights
let addressIndexReady = false;
let addressIndexBuildTimeMs = 0;

// Load real ingested blocks from artifacts directory
function loadIngestedBlocks(): FullBlockInput[] {
  const blocksDir = path.join(DEFAULT_DATA_DIR, 'blocks');
  if (!existsSync(blocksDir)) return [];
  const blocks: FullBlockInput[] = [];
  try {
    const chains = readdirSync(blocksDir).filter(d => {
      try { return statSync(path.join(blocksDir, d)).isDirectory(); } catch { return false; }
    });
    for (const chain of chains) {
      const chainDir = path.join(blocksDir, chain);
      const heights = readdirSync(chainDir).filter(d => {
        try { return statSync(path.join(chainDir, d)).isDirectory(); } catch { return false; }
      });
      for (const h of heights) {
        const rawPath = path.join(chainDir, h, 'raw-block.json');
        if (!existsSync(rawPath)) continue;
        try {
          const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
          const header = raw.header || {};
          const txs = raw.transactions || [];
          const totalGas = txs.reduce((s: number, t: any) => s + (t.gasUsed || 0), 0);
          const sizeEstimate = JSON.stringify(raw).length;
          blocks.push({
            sizeBytes: sizeEstimate,
            txCount: txs.length,
            timestamp: header.timestamp || 0,
            blockHeight: header.height || parseInt(h, 10),
            blockHash: header.hash || '',
            difficulty: 0,
            gasUsed: totalGas,
            chain: chain as any,
            stateRoot: header.stateRoot || '',
          });
        } catch { /* skip corrupted */ }
      }
    }
  } catch (e) {
    console.error('[validator] Error scanning artifacts:', e);
  }
  return blocks;
}

// Auto-initialize validator with real ingested data on startup
(async () => {
  try {
    console.log('[validator] Initializing patent validation architecture...');
    const realBlocks = loadIngestedBlocks();
    // Build address index + count in single pass
    const indexStart = performance.now();
    let txTotal = 0;
    const blocksDir = path.join(DEFAULT_DATA_DIR, 'blocks');
    if (existsSync(blocksDir)) {
      for (const chain of readdirSync(blocksDir)) {
        const chainDir = path.join(blocksDir, chain);
        try { if (!statSync(chainDir).isDirectory()) continue; } catch { continue; }
        for (const h of readdirSync(chainDir)) {
          const rawPath = path.join(chainDir, h, 'raw-block.json');
          if (!existsSync(rawPath)) continue;
          try {
            const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
            const txs = raw.transactions || [];
            const height = raw.header?.height || parseInt(h, 10);
            txTotal += txs.length;
            for (const tx of txs) {
              if (tx.sender) {
                const addr = tx.sender.toLowerCase();
                if (!addressIndex.has(addr)) addressIndex.set(addr, new Set());
                addressIndex.get(addr)!.add(height);
              }
              if (tx.receiver) {
                const addr = tx.receiver.toLowerCase();
                if (!addressIndex.has(addr)) addressIndex.set(addr, new Set());
                addressIndex.get(addr)!.add(height);
              }
            }
          } catch { /* skip */ }
        }
      }
    }
    addressIndexBuildTimeMs = performance.now() - indexStart;
    cachedAddressCount = addressIndex.size;
    cachedTransactionCount = txTotal;
    addressIndexReady = true;
    if (realBlocks.length > 0) {
      cachedMetaBlockIndex = generateMetaBlocks(realBlocks, 2);
      validatorNetwork.loadPatternIndex(cachedMetaBlockIndex);
      console.log(`[validator] Pattern index loaded from ${realBlocks.length} ingested blocks: ${cachedMetaBlockIndex.totalMetaBlocks} meta-blocks, ${cachedAddressCount} addresses, ${cachedTransactionCount} txs (${(addressIndexBuildTimeMs / 1000).toFixed(1)}s)`);
    } else {
      console.log('[validator] No ingested blocks found. Pattern index empty — ingest blocks to populate.');
    }

    // Register this server as an archive node
    validatorNetwork.registerNode('server-main', DEVICE_PROFILES.linux_server, 'localhost');
    validatorNetwork.syncNode('server-main');

    patternIndexLoaded = realBlocks.length > 0;
  } catch (e) {
    console.error('[validator] Init error:', e);
  }
})();


// GET /validator/status - Network and index status
app.get('/validator/status', (_req, res) => {
  const netStatus = validatorNetwork.getNetworkStatus();
  const patternIndex = validatorNetwork.getPatternIndex();
  const indexStats = patternIndex ? getIndexStatistics(patternIndex) : null;
  res.json({
    patternIndexLoaded,
    network: netStatus,
    index: indexStats ? { ...indexStats, totalAddresses: cachedAddressCount, totalTransactions: cachedTransactionCount } : { totalPatterns: 0, totalBlocksCovered: 0, totalAddresses: 0, totalTransactions: 0, avgBlocksPerPattern: 0, indexSizeKB: 0, indexSizeMB: 0, coverageByEra: {}, storageReduction: '0%' },
    patent: 'USPTO 63/906,240',
    title: 'Pattern-Based Blockchain Validation Architecture for Universal Computational Device Participation',
  });
});

// POST /validator/validate - Validate a transaction using pattern index
app.post('/validator/validate', (req, res) => {
  const patternIndex = validatorNetwork.getPatternIndex();
  if (!patternIndex) {
    return res.status(503).json({ error: 'Pattern index not loaded' });
  }
  const tx: TransactionValidationInput = req.body;
  const report = validateTransaction(tx, patternIndex);
  res.json(report);
});

// POST /validator/validate-batch - Validate multiple transactions
app.post('/validator/validate-batch', (req, res) => {
  const patternIndex = validatorNetwork.getPatternIndex();
  if (!patternIndex) {
    return res.status(503).json({ error: 'Pattern index not loaded' });
  }
  const { transactions } = req.body;
  const result = validateBatch(transactions, patternIndex);
  res.json(result);
});

// POST /validator/extract-features - Extract 8D features from a block
app.post('/validator/extract-features', (req, res) => {
  const input: BlockFeatureInput = req.body;
  const features = extractEightDimFeatures(input);
  const signature = generatePatternSignature(features);
  res.json({ features, signature });
});

// ---- UNFOLD ENDPOINTS ----

// GET /validator/unfold/status - Address index status
app.get('/validator/unfold/status', (_req, res) => {
  res.json({
    ready: addressIndexReady,
    addresses: cachedAddressCount,
    blocks: addressIndexReady ? new Set([...addressIndex.values()].flatMap(s => [...s])).size : 0,
    transactions: cachedTransactionCount,
    buildTimeMs: addressIndexBuildTimeMs,
  });
});

// GET /validator/unfold/top-addresses - Most active addresses
app.get('/validator/unfold/top-addresses', (_req, res) => {
  const entries = [...addressIndex.entries()]
    .map(([addr, heights]) => ({ address: addr, blockCount: heights.size }))
    .sort((a, b) => b.blockCount - a.blockCount)
    .slice(0, 20);
  res.json({ topAddresses: entries });
});

// GET /validator/unfold/:address - Unfold address from local index
app.get('/validator/unfold/:address', (req, res) => {
  const addr = req.params.address.toLowerCase();
  const heights = addressIndex.get(addr);
  if (!heights || heights.size === 0) {
    return res.json({ address: addr, found: false, blockCount: 0, blocksReturned: 0, truncated: false, transactionCount: 0, summary: { totalValueWei: '0', totalGasUsed: 0, inboundTxCount: 0, outboundTxCount: 0, uniqueCounterparties: 0 }, blocks: [], transactions: [] });
  }
  const sortedHeights = [...heights].sort((a, b) => b - a).slice(0, 50);
  const blocks: any[] = [];
  const transactions: any[] = [];
  const counterparties = new Set<string>();
  let totalGas = 0, inbound = 0, outbound = 0, totalValueWei = BigInt(0);
  for (const h of sortedHeights) {
    // Find raw block
    const chains = ['eth', 'avax', 'sol'];
    for (const chain of chains) {
      const rawPath = path.join(DEFAULT_DATA_DIR, 'blocks', chain, String(h), 'raw-block.json');
      if (!existsSync(rawPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
        const header = raw.header || {};
        const summaryPath = path.join(DEFAULT_DATA_DIR, 'blocks', chain, String(h), 'summary.json');
        const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf-8')) : null;
        const matchingTxs = (raw.transactions || []).filter((tx: any) =>
          tx.sender?.toLowerCase() === addr || tx.receiver?.toLowerCase() === addr
        );
        blocks.push({
          blockHeight: h,
          timestamp: header.timestamp || 0,
          blockHash: header.hash || '',
          totalTxInBlock: (raw.transactions || []).length,
          matchingTxCount: matchingTxs.length,
          patternInfo: summary ? { semanticTags: summary.semanticTags || [], behaviorMetrics: summary.behaviorMetrics || {}, codebookRoot: summary.codebookRoot || '', hotzoneCount: summary.hotzoneCount || 0 } : null,
          proofIntegrity: summary?.commitments ? { foldedCommitment: summary.commitments.foldedCommitment, pqCommitment: summary.commitments.pqCommitment, codebookRoot: summary.codebookRoot, proofHex: summary.proofHex?.slice(0, 32) || null, proofAvailable: !!summary.proofHex, publicInputs: null, verificationStatus: 'commitments_only' as const } : null,
        });
        for (const tx of matchingTxs) {
          const dir = tx.sender?.toLowerCase() === addr ? 'out' : 'in';
          if (dir === 'in') inbound++; else outbound++;
          totalGas += tx.gasUsed || 0;
          totalValueWei += BigInt(tx.amountWei || 0);
          if (tx.sender && tx.sender.toLowerCase() !== addr) counterparties.add(tx.sender.toLowerCase());
          if (tx.receiver && tx.receiver.toLowerCase() !== addr) counterparties.add(tx.receiver.toLowerCase());
          transactions.push({ ...tx, direction: dir, blockHeight: h, blockTimestamp: header.timestamp || 0 });
        }
      } catch { /* skip */ }
      break;
    }
  }
  res.json({
    address: addr, found: true,
    blockCount: heights.size, blocksReturned: blocks.length, truncated: heights.size > 50,
    transactionCount: transactions.length,
    summary: { totalValueWei: totalValueWei.toString(), totalGasUsed: totalGas, inboundTxCount: inbound, outboundTxCount: outbound, uniqueCounterparties: counterparties.size, blockRange: sortedHeights.length > 0 ? `${sortedHeights[sortedHeights.length - 1]}-${sortedHeights[0]}` : '' },
    blocks, transactions,
  });
});

// GET /validator/unfold/:address/compliance - AML compliance check
app.get('/validator/unfold/:address/compliance', (req, res) => {
  const addr = req.params.address.toLowerCase();
  const threshold = Number(req.query.threshold) || 1e18;
  const heights = addressIndex.get(addr);

  if (!heights || heights.size === 0) {
    return res.json({ address: addr, found: false, riskScore: 0, riskLevel: 'low', riskBreakdown: [], alerts: [], flaggedTransactions: [], totalTransactions: 0, counterpartyGraph: { nodes: [], edges: [] }, patternFlags: [], blockAnomalies: [], threshold, analysisTimestamp: new Date().toISOString() });
  }

  const sortedHeights = [...heights].sort((a, b) => b - a).slice(0, 100);
  const transactions: any[] = [];
  const counterparties = new Map<string, { txCount: number; totalValue: number; direction: string }>();
  let totalValueWei = BigInt(0);
  let totalGas = 0;
  let inbound = 0, outbound = 0;
  const alerts: any[] = [];
  const riskFactors: any[] = [];
  const flaggedTxs: any[] = [];
  const blockAnomalies: any[] = [];
  const patternFlags = new Set<string>();

  for (const h of sortedHeights) {
    for (const chain of ['eth', 'avax', 'sol']) {
      const rawPath = path.join(DEFAULT_DATA_DIR, 'blocks', chain, String(h), 'raw-block.json');
      if (!existsSync(rawPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
        const summaryPath = path.join(DEFAULT_DATA_DIR, 'blocks', chain, String(h), 'summary.json');
        const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf-8')) : null;
        const matchingTxs = (raw.transactions || []).filter((tx: any) =>
          tx.sender?.toLowerCase() === addr || tx.receiver?.toLowerCase() === addr
        );
        for (const tx of matchingTxs) {
          const dir = tx.sender?.toLowerCase() === addr ? 'out' : 'in';
          if (dir === 'in') inbound++; else outbound++;
          totalGas += tx.gasUsed || 0;
          const amtWei = BigInt(tx.amountWei || 0);
          totalValueWei += amtWei;
          const cp = dir === 'out' ? tx.receiver?.toLowerCase() : tx.sender?.toLowerCase();
          if (cp) {
            const existing = counterparties.get(cp) || { txCount: 0, totalValue: 0, direction: dir };
            existing.txCount++;
            existing.totalValue += tx.amountEth || 0;
            counterparties.set(cp, existing);
          }
          const flagged = amtWei >= BigInt(Math.floor(threshold));
          const blockTags = summary?.semanticTags || [];
          flaggedTxs.push({ ...tx, direction: dir, blockHeight: h, blockTimestamp: raw.header?.timestamp || 0, flagged, blockTags });

          // Detect patterns
          if (flagged) patternFlags.add('HIGH_VALUE_TX');
          if (tx.amountEth && tx.amountEth % 1 === 0 && tx.amountEth > 0) {
            alerts.push({ type: 'round_number', severity: 'low', description: `Round number transfer: ${tx.amountEth} ETH`, evidence: [tx.hash] });
          }
        }
        if (summary?.semanticTags?.includes('HIGH_VALUE')) {
          blockAnomalies.push({ height: h, score: 0.7 });
        }
      } catch { /* skip */ }
      break;
    }
  }

  // Compute risk factors
  const txCount = flaggedTxs.length;
  const highValuePct = flaggedTxs.filter((t: any) => t.flagged).length / (txCount || 1);
  riskFactors.push({ factor: 'High-value transactions', score: highValuePct, weight: 0.3, detail: `${(highValuePct * 100).toFixed(0)}% of txs above threshold` });

  const cpCount = counterparties.size;
  const cpConcentration = cpCount > 0 ? Math.max(...[...counterparties.values()].map(c => c.txCount)) / txCount : 0;
  riskFactors.push({ factor: 'Counterparty concentration', score: cpConcentration, weight: 0.2, detail: `${cpCount} unique counterparties` });

  const outRatio = txCount > 0 ? outbound / txCount : 0.5;
  const directionSkew = Math.abs(outRatio - 0.5) * 2;
  riskFactors.push({ factor: 'Direction imbalance', score: directionSkew, weight: 0.15, detail: `${inbound} in / ${outbound} out` });

  const volumeScore = Math.min(1, Number(totalValueWei) / (1e18 * 100));
  riskFactors.push({ factor: 'Total volume', score: volumeScore, weight: 0.2, detail: `${(Number(totalValueWei) / 1e18).toFixed(2)} ETH total` });

  const freqScore = Math.min(1, txCount / 500);
  riskFactors.push({ factor: 'Transaction frequency', score: freqScore, weight: 0.15, detail: `${txCount} transactions` });

  // Fan-out detection
  if (outbound > 10 && cpCount > outbound * 0.8) {
    alerts.push({ type: 'fan_out', severity: 'medium', description: `Fan-out pattern: ${outbound} outbound to ${cpCount} unique addresses`, evidence: [] });
    patternFlags.add('FAN_OUT');
  }
  if (inbound > 10 && cpCount > inbound * 0.8) {
    alerts.push({ type: 'fan_in', severity: 'medium', description: `Fan-in pattern: ${inbound} inbound from ${cpCount} unique addresses`, evidence: [] });
    patternFlags.add('FAN_IN');
  }

  const riskScore = riskFactors.reduce((sum: number, f: any) => sum + f.score * f.weight, 0);
  const riskLevel = riskScore > 0.7 ? 'high' : riskScore > 0.4 ? 'medium' : 'low';

  // Build counterparty graph
  const graphNodes = [{ address: addr, txCount, totalValue: Number(totalValueWei) / 1e18, isTarget: true }];
  const graphEdges: any[] = [];
  for (const [cp, data] of [...counterparties.entries()].slice(0, 30)) {
    graphNodes.push({ address: cp, txCount: data.txCount, totalValue: data.totalValue });
    graphEdges.push({ from: data.direction === 'out' ? addr : cp, to: data.direction === 'out' ? cp : addr, value: data.totalValue, count: data.txCount, direction: data.direction });
  }

  res.json({
    address: addr, found: true, riskScore, riskLevel, riskBreakdown: riskFactors, alerts,
    flaggedTransactions: flaggedTxs, totalTransactions: txCount,
    counterpartyGraph: { nodes: graphNodes, edges: graphEdges },
    patternFlags: [...patternFlags], blockAnomalies, threshold,
    analysisTimestamp: new Date().toISOString(),
  });
});

// POST /validator/register-node - Register a validator node
app.post('/validator/register-node', (req, res) => {
  const { nodeId, device, address } = req.body;
  const node = validatorNetwork.registerNode(nodeId, device, address);
  const syncResult = validatorNetwork.syncNode(nodeId);
  res.json({
    node: { nodeId: node.nodeId, tier: node.tier, status: node.status },
    sync: syncResult,
    storageRequirements: classifyDeviceTier(device),
  });
});

// GET /validator/nodes - List all validator nodes
app.get('/validator/nodes', (_req, res) => {
  const nodes = validatorNetwork.getNodes().map(n => ({
    nodeId: n.nodeId,
    tier: n.tier,
    deviceType: n.device.deviceType,
    status: n.status,
    validationsPerformed: n.validationsPerformed,
    avgValidationTimeMs: n.avgValidationTimeMs,
  }));
  res.json({ nodes, total: nodes.length });
});

// GET /validator/meta-blocks - Get meta-block index summary
app.get('/validator/meta-blocks', (_req, res) => {
  if (!cachedMetaBlockIndex) {
    return res.json({
      totalBlocks: 0,
      totalMetaBlocks: 0,
      avgGroupSize: 0,
      compressionRatio: 0,
      indexSizeBytes: 0,
      byEra: {},
    });
  }
  res.json({
    totalBlocks: cachedMetaBlockIndex.totalBlocks,
    totalMetaBlocks: cachedMetaBlockIndex.totalMetaBlocks,
    avgGroupSize: cachedMetaBlockIndex.avgGroupSize,
    compressionRatio: cachedMetaBlockIndex.compressionRatio,
    indexSizeBytes: cachedMetaBlockIndex.indexSizeBytes,
    byEra: cachedMetaBlockIndex.byEra,
  });
});

// POST /validator/meta-blocks/rebuild - Rebuild pattern index from ingested blocks
app.post('/validator/meta-blocks/rebuild', (_req, res) => {
  try {
    const realBlocks = loadIngestedBlocks();
    // Rebuild address index
    const indexStart = performance.now();
    addressIndex.clear();
    let txTotal = 0;
    const blocksDir = path.join(DEFAULT_DATA_DIR, 'blocks');
    if (existsSync(blocksDir)) {
      for (const chain of readdirSync(blocksDir)) {
        const chainDir = path.join(blocksDir, chain);
        try { if (!statSync(chainDir).isDirectory()) continue; } catch { continue; }
        for (const h of readdirSync(chainDir)) {
          const rawPath = path.join(chainDir, h, 'raw-block.json');
          if (!existsSync(rawPath)) continue;
          try {
            const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
            const txs = raw.transactions || [];
            const height = raw.header?.height || parseInt(h, 10);
            txTotal += txs.length;
            for (const tx of txs) {
              if (tx.sender) { const a = tx.sender.toLowerCase(); if (!addressIndex.has(a)) addressIndex.set(a, new Set()); addressIndex.get(a)!.add(height); }
              if (tx.receiver) { const a = tx.receiver.toLowerCase(); if (!addressIndex.has(a)) addressIndex.set(a, new Set()); addressIndex.get(a)!.add(height); }
            }
          } catch { /* skip */ }
        }
      }
    }
    addressIndexBuildTimeMs = performance.now() - indexStart;
    cachedAddressCount = addressIndex.size;
    cachedTransactionCount = txTotal;
    addressIndexReady = true;
    if (realBlocks.length > 0) {
      cachedMetaBlockIndex = generateMetaBlocks(realBlocks, 2);
      validatorNetwork.loadPatternIndex(cachedMetaBlockIndex);
      patternIndexLoaded = true;
    }
    res.json({ rebuilt: true, blocks: realBlocks.length, addresses: cachedAddressCount, transactions: cachedTransactionCount, metaBlocks: cachedMetaBlockIndex?.totalMetaBlocks ?? 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---- INGESTION ENDPOINTS ----

// SSE clients for live ingest events
const ingestClients = new Set<import('express').Response>();
let autoIngestInterval: ReturnType<typeof setInterval> | null = null;
let ingestCancelled = false;

function broadcastIngestEvent(event: Record<string, unknown>) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of ingestClients) {
    try { client.write(data); } catch { ingestClients.delete(client); }
  }
}

// GET /validator/ingest/live - SSE stream for ingestion events
app.get('/validator/ingest/live', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ stage: 'connected' })}\n\n`);
  ingestClients.add(res);
  _req.on('close', () => ingestClients.delete(res));
});

async function ingestBlocks(chain: string, count: number, startBlock?: number) {
  const cfg = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  const chainCfg = cfg.chains?.[chain];
  const rpcUrl = chainCfg?.rpcUrl || BENCHMARK_RPCS[chain]?.urls?.[0];
  if (!rpcUrl) throw new Error(`No RPC URL configured for ${chain}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const latest = await provider.getBlockNumber();
  const start = startBlock ?? latest;
  const codebook = getBenchmarkCodebook();
  const discardRaw = cfg.ingestion?.discardRaw ?? false;
  let ingested = 0;

  for (let i = 0; i < count; i++) {
    if (ingestCancelled) break;
    const height = startBlock ? start + i : start - i;
    broadcastIngestEvent({ stage: 'fetching', chain, height, timestamp: new Date().toISOString(), mode: startBlock ? 'backfill' : 'live' });

    try {
      const rawEthBlock = await provider.send('eth_getBlockByNumber', [toQuantity(height), true]);
      if (!rawEthBlock) continue;
      const rawBlock = ethRpcBlockToRawBlock(chain, rawEthBlock);

      broadcastIngestEvent({ stage: 'vectorizing', chain, height });
      const artifact = computeFoldedBlock(rawBlock, codebook);

      broadcastIngestEvent({ stage: 'folding', chain, height });
      const hotzones = detectHotzones(artifact.pqCode, codebook);
      const tags = deriveRawBlockTags(rawBlock);
      const metrics = computeBehaviorMetrics(rawBlock);

      broadcastIngestEvent({ stage: 'proving', chain, height });

      // Write artifacts
      const blockDir = path.join(DEFAULT_DATA_DIR, 'blocks', chain, String(height));
      mkdirSync(blockDir, { recursive: true });

      if (!discardRaw) {
        writeFileSync(path.join(blockDir, 'raw-block.json'), JSON.stringify(rawBlock));
      }
      writeFileSync(path.join(blockDir, 'summary.json'), JSON.stringify({
        codebookRoot: artifact.codebookRoot,
        commitments: artifact.commitments,
        foldedBlock: { foldedVectors: artifact.foldedVectors },
        semanticTags: tags,
        behaviorMetrics: metrics,
        hotzoneCount: hotzones.length,
      }));
      writeFileSync(path.join(blockDir, 'hotzones.json'), JSON.stringify(hotzones));
      writeFileSync(path.join(blockDir, 'proof.json'), JSON.stringify({
        proofHex: artifact.commitments?.foldedCommitment ?? null,
        pqCode: artifact.pqCode,
      }));

      // Update address index
      for (const tx of rawBlock.transactions) {
        if (tx.sender) {
          const addr = tx.sender.toLowerCase();
          if (!addressIndex.has(addr)) addressIndex.set(addr, new Set());
          addressIndex.get(addr)!.add(height);
        }
        if (tx.receiver) {
          const addr = tx.receiver.toLowerCase();
          if (!addressIndex.has(addr)) addressIndex.set(addr, new Set());
          addressIndex.get(addr)!.add(height);
        }
      }
      cachedTransactionCount += rawBlock.transactions.length;
      cachedAddressCount = addressIndex.size;

      broadcastIngestEvent({ stage: 'stored', chain, height, detail: `${rawBlock.transactions.length} txs` });
      ingested++;
    } catch (e) {
      broadcastIngestEvent({ stage: 'stored', chain, height, detail: `error: ${e}` });
    }
  }
  broadcastIngestEvent({ stage: 'complete', chain, height: 0, detail: `${ingested} blocks ingested` });
  return ingested;
}

// POST /validator/ingest/trigger - Manual ingestion
app.post('/validator/ingest/trigger', async (req, res) => {
  const { chain = 'eth', count = 10, startBlock } = req.body;
  ingestCancelled = false;
  try {
    const ingested = await ingestBlocks(chain, Math.min(count, 5000), startBlock);
    res.json({ ingested });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /validator/ingest/cancel
app.post('/validator/ingest/cancel', (_req, res) => {
  ingestCancelled = true;
  res.json({ cancelled: true });
});

// POST /validator/ingest/auto - Start/stop auto-ingest
app.post('/validator/ingest/auto', (req, res) => {
  const { enabled } = req.body;
  if (enabled && !autoIngestInterval) {
    const cfg = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
    const enabledChains = Object.entries(cfg.chains || {}).filter(([, v]: any) => v.enabled).map(([k]: any) => k);
    if (enabledChains.length === 0) {
      return res.status(400).json({ error: 'No chains enabled in config' });
    }
    // Save autoIngest flag
    const current = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
    current.ingestion = { ...current.ingestion, autoIngest: true };
    writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));

    autoIngestInterval = setInterval(async () => {
      for (const chain of enabledChains) {
        try {
          await ingestBlocks(chain, 1);
        } catch {}
      }
    }, 12_000);
    // Also run immediately
    (async () => { for (const chain of enabledChains) { try { await ingestBlocks(chain, 1); } catch {} } })();
    res.json({ autoIngest: true, chains: enabledChains });
  } else if (!enabled && autoIngestInterval) {
    clearInterval(autoIngestInterval);
    autoIngestInterval = null;
    const current = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
    current.ingestion = { ...current.ingestion, autoIngest: false };
    writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
    res.json({ autoIngest: false });
  } else {
    res.json({ autoIngest: !!autoIngestInterval });
  }
});

// ---- Validator config & watchlist ----

const CONFIG_PATH = path.join(DEFAULT_DATA_DIR, 'validator-config.json');
const WATCHLIST_PATH = path.join(DEFAULT_DATA_DIR, 'watchlist.json');

function readJsonFile(p: string, fallback: any) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : fallback; } catch { return fallback; }
}

const DEFAULT_CONFIG = {
  chains: {
    eth: { enabled: true, rpcUrl: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com' },
    avax: { enabled: false, rpcUrl: process.env.AVAX_RPC_URL || 'https://avalanche.public-rpc.com' },
    sol: { enabled: false, rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com' },
  },
  ingestion: { batchSize: 10, zkProving: false, hotzoneLimit: 16, autoIngest: false, discardRaw: false, unfoldMode: 'local' },
  codebookPath: 'artifacts/codebooks/latest.json',
};

app.get('/validator/config', (_req, res) => {
  res.json(readJsonFile(CONFIG_PATH, DEFAULT_CONFIG));
});

app.post('/validator/config', express.json(), (req, res) => {
  writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.post('/validator/config/test-rpc', express.json(), async (req, res) => {
  const { rpcUrl, chain } = req.body;
  if (!rpcUrl) return res.status(400).json({ success: false, error: 'Missing rpcUrl' });
  try {
    const t0 = performance.now();
    if (chain === 'solana') {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }) });
      const data = await r.json() as any;
      res.json({ success: true, latestBlock: data.result, latency: Math.round(performance.now() - t0), chainId: 'solana' });
    } else {
      const p = new ethers.JsonRpcProvider(rpcUrl);
      const block = await p.getBlockNumber();
      const net = await p.getNetwork();
      res.json({ success: true, latestBlock: block, latency: Math.round(performance.now() - t0), chainId: Number(net.chainId) });
    }
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/validator/watchlist', (_req, res) => {
  res.json(readJsonFile(WATCHLIST_PATH, { entries: {} }));
});

app.post('/validator/watchlist', express.json(), (req, res) => {
  writeFileSync(WATCHLIST_PATH, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.post('/validator/watchlist/add', express.json(), (req, res) => {
  const { address, label, category } = req.body;
  if (!address || !label) return res.status(400).json({ error: 'Missing address or label' });
  const data = readJsonFile(WATCHLIST_PATH, { entries: {} });
  data.entries[address.toLowerCase()] = { label, category: category || 'custom' };
  writeFileSync(WATCHLIST_PATH, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.delete('/validator/watchlist/:address', (req, res) => {
  const data = readJsonFile(WATCHLIST_PATH, { entries: {} });
  delete data.entries[req.params.address.toLowerCase()];
  writeFileSync(WATCHLIST_PATH, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

// GET /validator/benchmark - Run quick benchmark and return results
app.get('/validator/benchmark', async (_req, res) => {
  try {
    const benchBlocks: FullBlockInput[] = [];
    const base = Math.floor(Date.now() / 1000) - 1200;
    for (let i = 0; i < 1000; i++) {
      benchBlocks.push({
        sizeBytes: 50_000 + Math.floor(Math.random() * 450_000),
        txCount: 10 + Math.floor(Math.random() * 490),
        timestamp: base + i * 12,
        blockHeight: 24_000_000 + i,
        blockHash: createHash('sha256').update(`bench-${i}`).digest('hex'),
        difficulty: 0,
        chain: 'eth',
      });
    }

    // Processing speed
    const t0 = performance.now();
    for (const b of benchBlocks) extractEightDimFeatures(b);
    const processingMs = performance.now() - t0;
    const blocksPerSec = Math.round(1000 / (processingMs / 1000));

    // Compression
    const metaIdx = generateMetaBlocks(benchBlocks, 2);
    const compressionRatio = metaIdx.compressionRatio;
    const indexSizeMB = metaIdx.indexSizeBytes / (1024 * 1024);
    const fullSizeMB = 1000 * 0.3;
    const storageReduction = ((1 - indexSizeMB / fullSizeMB) * 100).toFixed(1);

    // Validation
    const pi = buildPatternIndex(metaIdx);
    const txs: TransactionValidationInput[] = benchBlocks.slice(0, 100).map((b, i) => ({
      txHash: `tx-${i}`,
      blockHeight: b.blockHeight,
      blockSize: b.sizeBytes,
      txCount: b.txCount,
      timestamp: b.timestamp,
      txIndex: 0,
      chain: 'eth' as const,
    }));
    const batchRes = validateBatch(txs, pi);

    res.json({
      dataSource: 'Feature extraction only (1000 synthetic blocks)',
      blockCount: 1000,
      blockRange: `${benchBlocks[0].blockHeight}–${benchBlocks[benchBlocks.length - 1].blockHeight}`,
      processingRate: `${blocksPerSec} blocks/sec`,
      compressionRatio: `${compressionRatio.toFixed(1)}:1`,
      storageReduction: `${storageReduction}%`,
      validationAccuracy: `${((batchRes.summary.success + batchRes.summary.patternMatch) / batchRes.summary.total * 100).toFixed(1)}%`,
      avgLookupTimeMs: batchRes.summary.avgValidationTimeMs.toFixed(4),
      patentClaims: {
        '99.7% efficiency': parseFloat(storageReduction) >= 99,
        '125 blocks/sec': blocksPerSec >= 125,
        '100% accuracy': batchRes.summary.failed === 0,
        '<1ms lookup': batchRes.summary.avgValidationTimeMs < 1,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /validator/benchmark/real - Real pipeline benchmark with per-stage timing
app.get('/validator/benchmark/real', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(String(req.query.count ?? '5'), 10) || 5, 1), 20);
    const chain = String(req.query.chain ?? 'eth');
    const rpcConfig = BENCHMARK_RPCS[chain];
    if (!rpcConfig || rpcConfig.kind !== 'evm') {
      return res.status(400).json({ error: `Unsupported chain "${chain}". Available: ${Object.keys(BENCHMARK_RPCS).join(', ')}` });
    }

    // Connect to RPC
    let provider: ethers.JsonRpcProvider | null = null;
    for (const url of rpcConfig.urls) {
      try {
        const p = new ethers.JsonRpcProvider(url);
        await p.getBlockNumber(); // test connectivity
        provider = p;
        break;
      } catch { /* try next */ }
    }
    if (!provider) {
      return res.status(502).json({ error: `All RPC endpoints failed for chain "${chain}"` });
    }

    const latestHeight = await provider.getBlockNumber();
    const codebook = getBenchmarkCodebook();
    const perBlock: Array<{
      chain: string; height: number; txCount: number; totalMs: number;
      stages: Record<string, number>;
    }> = [];
    const allStages: Record<string, number[]> = {};

    for (let i = 0; i < count; i++) {
      const height = latestHeight - i;
      const stages: Record<string, number> = {};

      // Stage: rpcFetch
      let t0 = performance.now();
      const rawEthBlock = await provider.send('eth_getBlockByNumber', [toQuantity(height), true]) as Record<string, any> | null;
      if (!rawEthBlock) {
        continue; // skip null blocks
      }
      const rawBlock: RawBlock = ethRpcBlockToRawBlock(chain, rawEthBlock);
      stages.rpcFetch = performance.now() - t0;

      const txCount = rawBlock.transactions.length;

      // Stage: foldAndCompress
      t0 = performance.now();
      const artifact = computeFoldedBlock(rawBlock, codebook);
      stages.foldAndCompress = performance.now() - t0;

      // Stage: hotzones
      t0 = performance.now();
      const hotzones = detectHotzones(artifact.pqCode, codebook);
      stages.hotzones = performance.now() - t0;

      // Stage: hypergraph
      t0 = performance.now();
      buildHypergraph(hotzones);
      stages.hypergraph = performance.now() - t0;

      // Stage: behaviorMetrics
      t0 = performance.now();
      computeBehaviorMetrics(rawBlock);
      stages.behaviorMetrics = performance.now() - t0;

      // Stage: tags
      t0 = performance.now();
      deriveRawBlockTags(rawBlock);
      stages.tags = performance.now() - t0;

      // Stage: eightDimFeatures
      t0 = performance.now();
      extractEightDimFeatures({
        sizeBytes: JSON.stringify(rawBlock).length,
        txCount,
        timestamp: rawBlock.header.timestamp ?? Math.floor(Date.now() / 1000),
        blockHeight: rawBlock.header.height,
        difficulty: 0,
        chain: chain as 'eth' | 'btc' | 'sol' | 'avax',
      });
      stages.eightDimFeatures = performance.now() - t0;

      const totalMs = Object.values(stages).reduce((a, b) => a + b, 0);
      perBlock.push({ chain, height, txCount, totalMs, stages });

      for (const [stage, ms] of Object.entries(stages)) {
        (allStages[stage] ??= []).push(ms);
      }
    }

    if (perBlock.length === 0) {
      return res.status(502).json({ error: 'Failed to fetch any blocks from RPC' });
    }

    // Aggregate stage stats
    const stageStats: Record<string, { avgMs: number; minMs: number; maxMs: number }> = {};
    for (const [stage, times] of Object.entries(allStages)) {
      stageStats[stage] = {
        avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
        minMs: Math.round(Math.min(...times) * 100) / 100,
        maxMs: Math.round(Math.max(...times) * 100) / 100,
      };
    }

    const totalTimeMs = perBlock.reduce((a, b) => a + b.totalMs, 0);
    const blocksPerSec = Math.round((perBlock.length / (totalTimeMs / 1000)) * 100) / 100;

    // Compute-only rate: total time minus RPC fetch
    const computeOnlyMs = perBlock.reduce((a, b) => a + b.totalMs - (b.stages.rpcFetch ?? 0), 0);
    const computeOnlyRate = computeOnlyMs > 0 ? Math.round((perBlock.length / (computeOnlyMs / 1000)) * 100) / 100 : 0;
    const rpcTotalMs = perBlock.reduce((a, b) => a + (b.stages.rpcFetch ?? 0), 0);
    const rpcPct = totalTimeMs > 0 ? Math.round((rpcTotalMs / totalTimeMs) * 100) : 0;

    const heights = perBlock.map(b => b.height);
    res.json({
      dataSource: `Live ${chain.toUpperCase()} mainnet blocks (full pipeline)`,
      chain,
      blockCount: perBlock.length,
      blockRange: `${Math.min(...heights)}–${Math.max(...heights)}`,
      stages: stageStats,
      blocksPerSec,
      perBlock: perBlock.map(b => ({
        ...b,
        totalMs: Math.round(b.totalMs * 100) / 100,
        stages: Object.fromEntries(Object.entries(b.stages).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      })),
      comparison: {
        endToEnd: `${blocksPerSec} blocks/sec`,
        computeOnly: `${computeOnlyRate} blocks/sec`,
        rpcPct: `${rpcPct}%`,
        avgBlockMs: Math.round(totalTimeMs / perBlock.length * 100) / 100,
        avgComputeMs: Math.round(computeOnlyMs / perBlock.length * 100) / 100,
        avgRpcMs: Math.round(rpcTotalMs / perBlock.length * 100) / 100,
      },
      patentClaims: {
        'Full pipeline benchmarked': true,
        'Per-stage breakdown': true,
        'Live chain data': true,
        'No disk writes': true,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback: serve index.html for non-API routes
app.get('*', (_req, res) => {
  const indexPath = path.join(uiDistPath, 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
app.listen(port, () => {
  console.log(`[api] listening on ${port}, data dir ${DEFAULT_DATA_DIR}`);

  // Resume auto-ingest if it was active before restart
  const startupCfg = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  if (startupCfg.ingestion?.autoIngest && !autoIngestInterval) {
    const enabledChains = Object.entries(startupCfg.chains || {}).filter(([, v]: any) => v.enabled).map(([k]: any) => k);
    if (enabledChains.length > 0) {
      console.log(`[auto-ingest] Resuming auto-ingest for chains: ${enabledChains.join(', ')}`);
      autoIngestInterval = setInterval(async () => {
        for (const chain of enabledChains) {
          try { await ingestBlocks(chain, 1); } catch {}
        }
      }, 12_000);
      // Run immediately on startup
      (async () => { for (const chain of enabledChains) { try { await ingestBlocks(chain, 1); } catch {} } })();
    }
  }
});

export default app;

