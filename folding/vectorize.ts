import { RawBlock, VectorizedBlock, TxVector, StateVector, WitnessVector } from './types.js';

export interface VectorizeOptions {
  txDim?: number;
  stateDim?: number;
  witnessDim?: number;
  maxAmount?: number;
  maxFee?: number;
  maxGas?: number;
  timestampScale?: number;
}

const DEFAULT_OPTIONS: Required<VectorizeOptions> = {
  txDim: 16,
  stateDim: 12,
  witnessDim: 8,
  maxAmount: 10 ** 9,
  maxFee: 10 ** 6,
  maxGas: 50_000_000,
  timestampScale: 86_400,
};

export function vectorizeBlock(raw: RawBlock, options: VectorizeOptions = {}): VectorizedBlock {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    txVectors: raw.transactions.map((tx, index) => vectorizeTransaction(tx, index, raw, opts)),
    stateVectors: raw.executionTraces.map((trace, index) => vectorizeState(trace, index, raw, opts)),
    witnessVectors: vectorizeWitness(raw.witnessData, raw, opts),
  };
}

function vectorizeTransaction(
  tx: Record<string, unknown>,
  index: number,
  raw: RawBlock,
  opts: Required<VectorizeOptions>,
): TxVector {
  const vec: number[] = new Array(opts.txDim).fill(0);

  vec[0] = normalizeNumber(tx['amount'], opts.maxAmount);
  vec[1] = normalizeNumber(tx['fee'] ?? tx['gasPrice'], opts.maxFee);
  vec[2] = normalizeNumber(tx['gasUsed'] ?? tx['gas'], opts.maxGas);
  vec[3] = normalizeIndex(index, raw.transactions.length);
  vec[4] = normalizeNumber(raw.header.height, 10 ** 7);
  vec[5] = normalizeTimestamp(raw.header.timestamp, opts.timestampScale);
  vec[6] = hashBucket(tx['contractType'] ?? tx['type'], 64);
  vec[7] = hashBucket(tx['asset'] ?? tx['token'], 256);
  vec[8] = normalizeNumber(tx['nonce'], 10 ** 6);
  vec[9] = 'status' in tx ? (tx['status'] === 'success' ? 1 : 0) : 0.5;
  vec[10] = normalizeNumber(tx['slot'] ?? tx['l2Slot'], 10 ** 5);
  vec[11] = normalizeNumber(tx['chainId'] ?? 0, 10 ** 3);
  vec[12] = normalizeNumber(tx['priorityFee'] ?? 0, opts.maxFee);
  vec[13] = hashBucket(tx['functionSelector'] ?? tx['method'], 1024);
  vec[14] = hashBucket(tx['sender'] ?? tx['from'], 10_000);
  vec[15] = hashBucket(tx['receiver'] ?? tx['to'], 10_000);

  return vec;
}

function vectorizeState(
  trace: Record<string, unknown>,
  index: number,
  raw: RawBlock,
  opts: Required<VectorizeOptions>,
): StateVector {
  const vec: number[] = new Array(opts.stateDim).fill(0);
  vec[0] = normalizeIndex(index, raw.executionTraces.length);
  vec[1] = normalizeNumber(trace['balanceDelta'], opts.maxAmount);
  vec[2] = normalizeNumber(trace['storageWrites'], 1024);
  vec[3] = normalizeNumber(trace['storageReads'], 1024);
  vec[4] = normalizeNumber(trace['logEvents'], 512);
  vec[5] = hashBucket(trace['contract'], 50_000);
  vec[6] = hashBucket(trace['asset'] ?? trace['token'], 10_000);
  vec[7] = hashBucket(trace['traceType'] ?? trace['op'], 128);
  vec[8] = normalizeNumber(trace['gasConsumed'], opts.maxGas);
  vec[9] = normalizeTimestamp(raw.header.timestamp, opts.timestampScale);
  vec[10] = normalizeNumber(trace['slotIndex'], 10 ** 5);
  vec[11] = normalizeBoolean(trace['reverted']);
  return vec;
}

function vectorizeWitness(
  witnessData: Record<string, unknown>,
  raw: RawBlock,
  opts: Required<VectorizeOptions>,
): WitnessVector[] {
  const payloads = Array.isArray(witnessData?.bundles)
    ? (witnessData.bundles as Record<string, unknown>[])
    : [witnessData];

  return payloads.map((bundle, index) => {
    const vec: number[] = new Array(opts.witnessDim).fill(0);
    vec[0] = normalizeIndex(index, payloads.length);
    vec[1] = normalizeNumber(bundle['constraintCount'], 10 ** 6);
    vec[2] = normalizeNumber(bundle['degree'], 4096);
    vec[3] = normalizeNumber(bundle['gateCount'], 10 ** 6);
    vec[4] = normalizeNumber(bundle['quotientDegree'], 8192);
    vec[5] = hashBucket(bundle['proverLabel'] ?? bundle['system'], 256);
    vec[6] = hashBucket(bundle['circuitType'], 128);
    vec[7] = normalizeTimestamp(raw.header.timestamp, opts.timestampScale);
    return vec;
  });
}

function normalizeNumber(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || max === 0) {
    return 0;
  }
  return clamp(value / max, -1, 1);
}

function normalizeIndex(index: number, total: number): number {
  if (total <= 1) return 0;
  return clamp(index / (total - 1), 0, 1);
}

function normalizeTimestamp(timestamp: number | undefined, scale: number): number {
  if (!timestamp) return 0;
  return (timestamp % (scale * 10)) / (scale * 10);
}

function normalizeBoolean(value: unknown): number {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return 0.5;
}

function hashBucket(value: unknown, buckets: number): number {
  if (value === undefined || value === null) {
    return 0;
  }

  const str = String(value);
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return (hash % buckets) / (buckets - 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

