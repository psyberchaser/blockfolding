import 'dotenv/config';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { deriveRawBlockTags } from '../analytics/tags.js';
import type { RawBlock } from '../folding/types.js';

interface ChainConfig {
  id: string;
  label: string;
  rpcUrls: string[];
}

const CHAINS: ChainConfig[] = [
  {
    id: 'eth',
    label: 'Ethereum Mainnet',
    rpcUrls: buildRpcList(process.env.ETH_RPC_URL, [
      'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
      'https://eth-mainnet.public.blastapi.io',
    ]),
  },
  {
    id: 'avax',
    label: 'Avalanche C-Chain',
    rpcUrls: buildRpcList(process.env.AVAX_RPC_URL, [
      'https://avalanche.public-rpc.com',
      'https://rpc.ankr.com/avalanche',
      'https://avax.meowrpc.com',
    ]),
  },
];

interface WatchOptions {
  chains: ChainConfig[];
  intervalMs: number;
}

interface MempoolSnapshot {
  chain: string;
  fetchedAt: number;
  pseudoHeight: number;
  txCount: number;
  avgGasPriceGwei: number;
  maxGasPriceGwei: number;
  totalValueEth: number;
  tags: string[];
  anomalyScore: number;
  highlights: string[];
  deltaTx: number;
  deltaGas: number;
  deltaValue: number;
}

interface PredictionSignal {
  chain: string;
  tags: string[];
  confidence: number;
  etaSeconds: number;
  reasons: string[];
  generatedAt: number;
}

const MEMPOOL_DIR = path.resolve('artifacts', 'mempool');
const HISTORY_DIR = path.join(MEMPOOL_DIR, 'history');
const PREDICTIONS_DIR = path.join(MEMPOOL_DIR, 'predictions');
mkdirSync(MEMPOOL_DIR, { recursive: true });
mkdirSync(HISTORY_DIR, { recursive: true });
mkdirSync(PREDICTIONS_DIR, { recursive: true });

async function main() {
  const options = buildOptions();
  const providers: Record<string, JsonRpcProvider | null> = {};
  const history: Record<string, MempoolSnapshot[]> = {};

  // eslint-disable-next-line no-console
  console.log(
    `[mempool-watch] Starting (chains=${options.chains.map((c) => c.id).join(',')} interval=${
      options.intervalMs
    }ms)`,
  );

  while (true) {
    await Promise.all(
      options.chains.map(async (chain) => {
        if (!providers[chain.id]) {
          providers[chain.id] = await connectProvider(chain);
        }
        const provider = providers[chain.id];
        if (!provider) return;
        try {
          const snapshot = await captureSnapshot(chain, provider, history[chain.id] ?? []);
          if (snapshot) {
            history[chain.id] = updateHistory(history[chain.id] ?? [], snapshot);
            writeSnapshot(snapshot);
            appendHistorySnapshot(snapshot);
            const prediction = generatePrediction(snapshot, history[chain.id] ?? []);
            writePrediction(prediction);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`[mempool-watch] ${chain.id} capture failed:`, formatError(error));
          providers[chain.id] = null;
        }
      }),
    );
    await sleep(options.intervalMs);
  }
}

async function captureSnapshot(
  chain: ChainConfig,
  provider: JsonRpcProvider,
  history: MempoolSnapshot[],
) {
  const latest = await provider.getBlockNumber();
  const pending = await provider.send('eth_getBlockByNumber', ['pending', true]);
  if (!pending) return null;
  const transactions: Record<string, any>[] = Array.isArray(pending.transactions)
    ? pending.transactions
    : [];

  const pseudoHeight =
    pending.number && typeof pending.number === 'string'
      ? parseInt(pending.number, 16)
      : latest + 1;
  const timestampSeconds =
    pending.timestamp && typeof pending.timestamp === 'string'
      ? parseInt(pending.timestamp, 16)
      : Math.floor(Date.now() / 1000);

  const rawBlock: RawBlock = {
    header: {
      height: pseudoHeight,
      hash: pending.hash ?? '0xpending',
      parentHash: pending.parentHash ?? '0x0',
      stateRoot: pending.stateRoot ?? '0x0',
      txRoot: pending.transactionsRoot ?? '0x0',
      receiptsRoot: pending.receiptsRoot ?? '0x0',
      timestamp: timestampSeconds,
    },
    transactions,
    executionTraces: [],
    witnessData: {},
  };

  const tags = deriveRawBlockTags(rawBlock);

  const gasStats = computeGasStats(transactions);
  const valueStats = computeValueStats(transactions);

  const snapshot: MempoolSnapshot = {
    chain: chain.id,
    fetchedAt: Math.floor(Date.now() / 1000),
    pseudoHeight,
    txCount: transactions.length,
    avgGasPriceGwei: gasStats.avgGwei,
    maxGasPriceGwei: gasStats.maxGwei,
    totalValueEth: valueStats.totalEth,
    tags,
    ...deriveInsights({
      chainId: chain.id,
      txCount: transactions.length,
      avgGasPriceGwei: gasStats.avgGwei,
      totalValueEth: valueStats.totalEth,
      tags,
      history,
    }),
  };

  // eslint-disable-next-line no-console
  console.log(
    `[mempool-watch] ${chain.id} tx=${snapshot.txCount} avgGas=${snapshot.avgGasPriceGwei} gwei score=${snapshot.anomalyScore} tags=${snapshot.tags.slice(0, 3).join(',')}`,
  );

  return snapshot;
}

function computeGasStats(transactions: Record<string, any>[]) {
  if (transactions.length === 0) {
    return { avgGwei: 0, maxGwei: 0 };
  }
  let total = 0n;
  let max = 0n;
  transactions.forEach((tx) => {
    const gasPriceHex = typeof tx.gasPrice === 'string' ? tx.gasPrice : '0x0';
    const gasPrice = hexToBigInt(gasPriceHex);
    total += gasPrice;
    if (gasPrice > max) {
      max = gasPrice;
    }
  });
  const avg = total / BigInt(transactions.length);
  return {
    avgGwei: Number(avg / 1_000_000_000n),
    maxGwei: Number(max / 1_000_000_000n),
  };
}

function computeValueStats(transactions: Record<string, any>[]) {
  if (transactions.length === 0) {
    return { totalEth: 0 };
  }
  let total = 0n;
  transactions.forEach((tx) => {
    const valueHex = typeof tx.value === 'string' ? tx.value : '0x0';
    total += hexToBigInt(valueHex);
  });
  return {
    totalEth: Number(total) / 1e18,
  };
}

function writeSnapshot(snapshot: MempoolSnapshot) {
  const outPath = path.join(MEMPOOL_DIR, `${snapshot.chain}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
}

function deriveInsights(args: {
  chainId: string;
  txCount: number;
  avgGasPriceGwei: number;
  totalValueEth: number;
  tags: string[];
  history: MempoolSnapshot[];
}) {
  const previous = args.history[0];
  const deltaTx = previous ? args.txCount - previous.txCount : 0;
  const deltaGas = previous ? args.avgGasPriceGwei - previous.avgGasPriceGwei : 0;
  const deltaValue = previous ? args.totalValueEth - previous.totalValueEth : 0;

  const txScore = Math.min(args.txCount / 150, 1);
  const gasScore = Math.min(args.avgGasPriceGwei / 80, 1);
  const valueScore = Math.min(args.totalValueEth / 1500, 1);
  const tagScore = args.tags.some((tag) => tag.includes('HIGH') || tag.includes('BRIDGE')) ? 0.2 : 0;
  const anomalyScore = Number(
    Math.min(
      txScore * 0.3 + gasScore * 0.3 + valueScore * 0.2 + tagScore + trendScore(deltaGas, deltaTx),
      1,
    ).toFixed(2),
  );

  const highlights: string[] = [];
  if (args.avgGasPriceGwei > 60) highlights.push('High gas');
  if (args.txCount > 200) highlights.push('Heavy throughput');
  if (args.tags.some((tag) => tag.includes('BRIDGE'))) highlights.push('Bridge activity');
  if (args.tags.some((tag) => tag.includes('DEX'))) highlights.push('DEX flow');
  if (highlights.length === 0) highlights.push('Normal');

  return { anomalyScore, highlights, deltaTx, deltaGas, deltaValue };
}

function trendScore(deltaGas: number, deltaTx: number) {
  const gasTrend = deltaGas > 0 ? Math.min(deltaGas / 30, 0.15) : 0;
  const txTrend = deltaTx > 0 ? Math.min(deltaTx / 50, 0.15) : 0;
  return gasTrend + txTrend;
}

function updateHistory(history: MempoolSnapshot[], snapshot: MempoolSnapshot) {
  const next = [snapshot, ...history].slice(0, 12);
  return next;
}

function appendHistorySnapshot(snapshot: MempoolSnapshot) {
  const filePath = path.join(HISTORY_DIR, `${snapshot.chain}.jsonl`);
  const line = JSON.stringify(snapshot);
  recordLine(filePath, line);
}

function recordLine(filePath: string, line: string) {
  try {
    appendFileSync(filePath, `${line}\n`);
  } catch (error) {
    appendFileSync(filePath, `${line}\n`);
  }
}

function generatePrediction(snapshot: MempoolSnapshot, history: MempoolSnapshot[]): PredictionSignal {
  const tags = new Set<string>();
  const reasons: string[] = [];

  if (snapshot.avgGasPriceGwei > 60 || snapshot.deltaGas > 8) {
    tags.add('HIGH_FEE');
    reasons.push('Gas spike');
  }
  if (snapshot.tags.some((tag) => tag.includes('DEX'))) {
    tags.add('DEX_ACTIVITY');
    reasons.push('DEX pending volume');
  }
  if (snapshot.tags.some((tag) => tag.includes('LENDING'))) {
    tags.add('LENDING_ACTIVITY');
    reasons.push('Lending flow');
  }
  if (snapshot.tags.some((tag) => tag.includes('BRIDGE'))) {
    tags.add('BRIDGE_ACTIVITY');
    reasons.push('Bridge usage');
  }
  if (snapshot.tags.some((tag) => tag.includes('NFT'))) {
    tags.add('NFT_ACTIVITY');
    reasons.push('NFT transfers');
  }
  if (tags.size === 0) {
    tags.add('MIXED_ACTIVITY');
    reasons.push('Steady state');
  }

  const confidence = clamp(
    0.2 + snapshot.anomalyScore * 0.6 + Math.max(0, snapshot.deltaGas) * 0.01,
    0,
    1,
  );
  const etaSeconds = estimateEtaSeconds(snapshot, history);

  return {
    chain: snapshot.chain,
    tags: Array.from(tags),
    confidence: Number(confidence.toFixed(2)),
    etaSeconds,
    reasons,
    generatedAt: snapshot.fetchedAt,
  };
}

function estimateEtaSeconds(snapshot: MempoolSnapshot, history: MempoolSnapshot[]) {
  const previous = history[0];
  const cadence =
    previous && snapshot.fetchedAt !== previous.fetchedAt
      ? Math.max(2, Math.min(20, snapshot.fetchedAt - previous.fetchedAt))
      : 10;
  const pressure = clamp(snapshot.anomalyScore, 0, 1);
  const eta = cadence * (1 - pressure * 0.5);
  return Math.max(3, Math.round(eta));
}

function writePrediction(prediction: PredictionSignal) {
  const outPath = path.join(PREDICTIONS_DIR, `${prediction.chain}.json`);
  writeFileSync(outPath, JSON.stringify(prediction, null, 2));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function connectProvider(chain: ChainConfig) {
  const errors: string[] = [];
  for (const url of chain.rpcUrls) {
    try {
      const provider = new JsonRpcProvider(url);
      await provider.getBlockNumber();
      // eslint-disable-next-line no-console
      console.log(`[mempool-watch] Connected ${chain.id} -> ${url}`);
      return provider;
    } catch (error) {
      const message = formatError(error);
      errors.push(`${url}: ${message}`);
      // eslint-disable-next-line no-console
      console.warn(`[mempool-watch] ${chain.id} RPC failed (${url}): ${message}`);
    }
  }
  throw new Error(`[mempool-watch] Unable to connect ${chain.id}. ${errors.join(' | ')}`);
}

function buildOptions(): WatchOptions {
  const chainIds =
    process.env.MEMPOOL_CHAINS?.split(',')
      .map((c) => c.trim())
      .filter(Boolean) ?? CHAINS.map((c) => c.id);
  const chains = CHAINS.filter((chain) => chainIds.includes(chain.id));
  const intervalMs =
    Number.parseInt(process.env.MEMPOOL_INTERVAL_MS ?? '5000', 10) || 5000;
  return { chains, intervalMs };
}

function buildRpcList(primary: string | undefined, fallbacks: string[]): string[] {
  return [primary, ...fallbacks].filter((url): url is string => Boolean(url && url.trim().length > 0));
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function hexToBigInt(value: string): bigint {
  if (!value) return 0n;
  return BigInt(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}

