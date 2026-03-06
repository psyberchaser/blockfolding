import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve('..', 'artifacts');
const MEMPOOL_DIR = path.join(DATA_DIR, 'mempool');

export interface MempoolSnapshot {
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

export function readLatestMempoolSnapshots(): MempoolSnapshot[] {
  try {
    if (!existsSync(MEMPOOL_DIR)) {
      return [];
    }
    const files = readdirSync(MEMPOOL_DIR).filter((file) => file.endsWith('.json'));
    return files
      .map((file) => JSON.parse(readFileSync(path.join(MEMPOOL_DIR, file), 'utf-8')) as Partial<MempoolSnapshot>)
      .map((snapshot) => normalizeSnapshot(snapshot))
      .sort((a, b) => b.fetchedAt - a.fetchedAt);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[mempool] Unable to read snapshots', error);
    return [];
  }
}

function normalizeSnapshot(raw: Partial<MempoolSnapshot>): MempoolSnapshot {
  return {
    chain: raw.chain ?? 'unknown',
    fetchedAt: raw.fetchedAt ?? Math.floor(Date.now() / 1000),
    pseudoHeight: raw.pseudoHeight ?? 0,
    txCount: raw.txCount ?? 0,
    avgGasPriceGwei: raw.avgGasPriceGwei ?? 0,
    maxGasPriceGwei: raw.maxGasPriceGwei ?? 0,
    totalValueEth: raw.totalValueEth ?? 0,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    anomalyScore: Number.isFinite(raw.anomalyScore) ? Number(raw.anomalyScore) : 0,
    highlights:
      Array.isArray(raw.highlights) && raw.highlights.length > 0 ? raw.highlights : ['Normal'],
    deltaTx: Number.isFinite(raw.deltaTx) ? Number(raw.deltaTx) : 0,
    deltaGas: Number.isFinite(raw.deltaGas) ? Number(raw.deltaGas) : 0,
    deltaValue: Number.isFinite(raw.deltaValue) ? Number(raw.deltaValue) : 0,
  };
}

