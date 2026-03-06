/**
 * Eight-Dimensional Pattern Recognition Engine
 *
 * Patent-spec implementation: Analyzes blockchain data across exactly 8 dimensions:
 * 1. Size Category - Block size in bytes
 * 2. Transaction Count Category - Number of transactions
 * 3. Temporal Hour - Hour of day (0-23)
 * 4. Temporal Day - Day of week (0-6)
 * 5. Blockchain Era - Mining technology evolution period
 * 6. Protocol Version - Blockchain protocol version
 * 7. Difficulty Category - Network difficulty classification
 * 8. Transaction Complexity - Transaction structure sophistication
 *
 * Implements: Patent Claims 1, 2, 4, 7
 */

import { createHash } from 'node:crypto';

// ============================================
// TYPES
// ============================================

export type SizeCategory = 'tiny' | 'small' | 'medium' | 'large' | 'very_large' | 'huge';
export type TxCountCategory = 'coinbase_only' | 'few_tx' | 'some_tx' | 'many_tx' | 'high_volume' | 'extreme_volume';
export type BlockchainEra = 'cpu_mining' | 'gpu_era' | 'asic_early' | 'asic_mature' | 'asic_advanced';
export type DifficultyCategory = 'genesis' | 'early' | 'growth' | 'mature' | 'advanced' | 'modern';
export type TxComplexity = 'simple' | 'moderate' | 'complex';

export interface EightDimFeatureVector {
  sizeCategory: SizeCategory;
  txCountCategory: TxCountCategory;
  temporalHour: number;    // 0-23
  temporalDay: number;     // 0-6 (Sunday=0)
  era: BlockchainEra;
  protocolVersion: number;
  difficultyCategory: DifficultyCategory;
  transactionComplexity: TxComplexity;
}

export interface PatternSignature {
  hash: string;           // SHA256 of feature vector
  groupKey: string;       // Human-readable group key
  features: EightDimFeatureVector;
  numericVector: number[]; // Normalized 8D numeric representation
}

export interface BlockFeatureInput {
  sizeBytes: number;
  txCount: number;
  timestamp: number;       // Unix timestamp in seconds
  blockHeight: number;
  protocolVersion?: number;
  difficulty?: number;     // Network difficulty
  transactions?: {
    type?: string | number;
    inputData?: string;
    gasUsed?: number;
    contractCreation?: boolean;
    isMultiSig?: boolean;
    hasInternalTxs?: boolean;
  }[];
  chain?: 'eth' | 'btc' | 'sol' | 'avax';
}

// ============================================
// DIMENSION WEIGHTS (for similarity scoring)
// ============================================

export const DIMENSION_WEIGHTS = {
  sizeCategory: 0.15,
  txCountCategory: 0.15,
  era: 0.20,
  difficultyCategory: 0.10,
  transactionComplexity: 0.15,
  temporalHour: 0.05,
  temporalDay: 0.05,
  protocolVersion: 0.15,
} as const;

// ============================================
// FEATURE EXTRACTION FUNCTIONS
// ============================================

/**
 * Dimension 1: Block Size Categorization
 * Categorizes total block size into discrete ranges
 */
export function categorizeSizeBytes(sizeBytes: number): SizeCategory {
  if (sizeBytes < 2_000) return 'tiny';
  if (sizeBytes < 18_000) return 'small';
  if (sizeBytes < 50_000) return 'medium';
  if (sizeBytes < 200_000) return 'large';
  if (sizeBytes < 500_000) return 'very_large';
  return 'huge';
}

/**
 * Dimension 2: Transaction Count Categorization
 * Categorizes transaction volume into discrete ranges
 */
export function categorizeTxCount(txCount: number): TxCountCategory {
  if (txCount <= 1) return 'coinbase_only';
  if (txCount <= 4) return 'few_tx';
  if (txCount <= 19) return 'some_tx';
  if (txCount <= 99) return 'many_tx';
  if (txCount <= 499) return 'high_volume';
  return 'extreme_volume';
}

/**
 * Dimension 3: Temporal Hour Extraction
 * Extracts hour of day from block timestamp
 */
export function extractTemporalHour(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return date.getUTCHours();
}

/**
 * Dimension 4: Temporal Day Extraction
 * Extracts day of week from block timestamp
 */
export function extractTemporalDay(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return date.getUTCDay();
}

/**
 * Dimension 5: Blockchain Era Classification
 * Classifies blocks by mining technology evolution period
 * Supports multiple chains with chain-specific era boundaries
 */
export function classifyEra(blockHeight: number, chain: string = 'eth'): BlockchainEra {
  if (chain === 'btc') {
    if (blockHeight < 32_256) return 'cpu_mining';
    if (blockHeight < 210_000) return 'gpu_era';
    if (blockHeight < 420_000) return 'asic_early';
    if (blockHeight < 630_000) return 'asic_mature';
    return 'asic_advanced';
  }
  // Ethereum / EVM chains
  if (blockHeight < 200_000) return 'cpu_mining';
  if (blockHeight < 4_370_000) return 'gpu_era';         // Pre-Byzantium
  if (blockHeight < 12_965_000) return 'asic_early';      // Pre-London
  if (blockHeight < 15_537_394) return 'asic_mature';     // Pre-Merge
  return 'asic_advanced';                                  // Post-Merge (PoS)
}

/**
 * Dimension 6: Protocol Version Analysis
 * Extracts blockchain protocol version; defaults based on block height
 */
export function extractProtocolVersion(input: BlockFeatureInput): number {
  if (input.protocolVersion !== undefined) return input.protocolVersion;
  // Infer from block height for Ethereum
  const h = input.blockHeight;
  if (h < 1_150_000) return 1;   // Frontier
  if (h < 4_370_000) return 2;   // Homestead
  if (h < 7_280_000) return 3;   // Byzantium
  if (h < 12_965_000) return 4;  // Constantinople/Istanbul
  if (h < 15_537_394) return 5;  // London
  return 6;                       // Merge / Shanghai / Dencun
}

/**
 * Dimension 7: Difficulty Category Determination
 * Classifies network difficulty into discrete ranges
 */
export function classifyDifficulty(difficulty: number): DifficultyCategory {
  if (difficulty < 10) return 'genesis';
  if (difficulty < 1_000) return 'early';
  if (difficulty < 100_000) return 'growth';
  if (difficulty < 10_000_000) return 'mature';
  if (difficulty < 100_000_000) return 'advanced';
  return 'modern';
}

/**
 * Dimension 8: Transaction Complexity Assessment
 * Analyzes transaction structure sophistication
 */
export function assessComplexity(transactions?: BlockFeatureInput['transactions']): TxComplexity {
  if (!transactions || transactions.length === 0) return 'simple';

  let complexCount = 0;
  let moderateCount = 0;

  for (const tx of transactions) {
    const inputLen = tx.inputData?.length ?? 0;
    if (tx.contractCreation || tx.isMultiSig || inputLen > 500 || tx.hasInternalTxs) {
      complexCount++;
    } else if (inputLen > 10 || (tx.gasUsed && tx.gasUsed > 50_000)) {
      moderateCount++;
    }
  }

  const complexRatio = complexCount / transactions.length;
  const moderateRatio = moderateCount / transactions.length;

  if (complexRatio > 0.3) return 'complex';
  if (complexRatio > 0.1 || moderateRatio > 0.3) return 'moderate';
  return 'simple';
}

// ============================================
// MAIN EXTRACTION FUNCTION
// ============================================

/**
 * Extract complete 8-dimensional feature vector from block data
 * This is the primary entry point per the patent specification
 */
export function extractEightDimFeatures(input: BlockFeatureInput): EightDimFeatureVector {
  const chain = input.chain ?? 'eth';
  const difficulty = input.difficulty ?? inferDifficulty(input.blockHeight, chain);

  return {
    sizeCategory: categorizeSizeBytes(input.sizeBytes),
    txCountCategory: categorizeTxCount(input.txCount),
    temporalHour: extractTemporalHour(input.timestamp),
    temporalDay: extractTemporalDay(input.timestamp),
    era: classifyEra(input.blockHeight, chain),
    protocolVersion: extractProtocolVersion(input),
    difficultyCategory: classifyDifficulty(difficulty),
    transactionComplexity: assessComplexity(input.transactions),
  };
}

/**
 * Infer difficulty from block height when not provided
 */
function inferDifficulty(blockHeight: number, chain: string): number {
  if (chain === 'btc') {
    if (blockHeight < 32_256) return 1;
    if (blockHeight < 210_000) return 50_000;
    if (blockHeight < 420_000) return 50_000_000;
    if (blockHeight < 630_000) return 5_000_000_000;
    return 50_000_000_000;
  }
  // Ethereum
  if (blockHeight < 200_000) return 100;
  if (blockHeight < 4_370_000) return 1_000_000;
  if (blockHeight < 12_965_000) return 10_000_000_000;
  if (blockHeight < 15_537_394) return 100_000_000_000;
  return 0; // Post-merge: no PoW difficulty
}

// ============================================
// PATTERN SIGNATURE GENERATION
// ============================================

/**
 * Generate a cryptographic pattern signature from a feature vector
 * Uses SHA256 as specified in the patent
 */
export function generatePatternSignature(features: EightDimFeatureVector): PatternSignature {
  // Create canonical string representation
  const groupKey = [
    features.sizeCategory,
    features.txCountCategory,
    features.era,
    features.difficultyCategory,
    features.transactionComplexity,
    Math.floor(features.temporalHour / 6).toString(), // 6-hour buckets
    features.temporalDay.toString(),
    features.protocolVersion.toString(),
  ].join('|');

  // SHA256 cryptographic hash
  const hash = createHash('sha256').update(groupKey).digest('hex');

  // Numeric vector for similarity computations
  const numericVector = featureVectorToNumeric(features);

  return { hash, groupKey, features, numericVector };
}

/**
 * Convert categorical features to normalized numeric vector [0,1]
 */
export function featureVectorToNumeric(f: EightDimFeatureVector): number[] {
  const sizeMap: Record<SizeCategory, number> = {
    tiny: 0, small: 0.2, medium: 0.4, large: 0.6, very_large: 0.8, huge: 1.0,
  };
  const txMap: Record<TxCountCategory, number> = {
    coinbase_only: 0, few_tx: 0.2, some_tx: 0.4, many_tx: 0.6, high_volume: 0.8, extreme_volume: 1.0,
  };
  const eraMap: Record<BlockchainEra, number> = {
    cpu_mining: 0, gpu_era: 0.25, asic_early: 0.5, asic_mature: 0.75, asic_advanced: 1.0,
  };
  const diffMap: Record<DifficultyCategory, number> = {
    genesis: 0, early: 0.2, growth: 0.4, mature: 0.6, advanced: 0.8, modern: 1.0,
  };
  const complexMap: Record<TxComplexity, number> = {
    simple: 0, moderate: 0.5, complex: 1.0,
  };

  return [
    sizeMap[f.sizeCategory],
    txMap[f.txCountCategory],
    f.temporalHour / 23,
    f.temporalDay / 6,
    eraMap[f.era],
    Math.min(f.protocolVersion / 6, 1.0),
    diffMap[f.difficultyCategory],
    complexMap[f.transactionComplexity],
  ];
}

// ============================================
// PATTERN SIMILARITY
// ============================================

/**
 * Calculate weighted similarity between two pattern signatures
 * Returns a score between 0.0 (completely different) and 1.0 (identical)
 */
export function calculatePatternSimilarity(a: EightDimFeatureVector, b: EightDimFeatureVector): number {
  let score = 0;
  const w = DIMENSION_WEIGHTS;

  if (a.sizeCategory === b.sizeCategory) score += w.sizeCategory;
  if (a.txCountCategory === b.txCountCategory) score += w.txCountCategory;
  if (a.era === b.era) score += w.era;
  if (a.difficultyCategory === b.difficultyCategory) score += w.difficultyCategory;
  if (a.transactionComplexity === b.transactionComplexity) score += w.transactionComplexity;
  // Temporal: partial credit for nearby hours/days
  const hourDiff = Math.abs(a.temporalHour - b.temporalHour);
  score += w.temporalHour * Math.max(0, 1 - hourDiff / 12);
  const dayDiff = Math.abs(a.temporalDay - b.temporalDay);
  score += w.temporalDay * Math.max(0, 1 - dayDiff / 3);
  if (a.protocolVersion === b.protocolVersion) score += w.protocolVersion;

  return score;
}

/**
 * Calculate cosine similarity between numeric feature vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================
// BATCH PROCESSING
// ============================================

/**
 * Process multiple blocks and group by pattern signature
 * Returns groups of blocks with identical 8D feature signatures
 */
export function groupBlocksByPattern(
  blocks: BlockFeatureInput[],
  minGroupSize: number = 2,
): Map<string, { signature: PatternSignature; blocks: BlockFeatureInput[] }> {
  const groups = new Map<string, { signature: PatternSignature; blocks: BlockFeatureInput[] }>();

  for (const block of blocks) {
    const features = extractEightDimFeatures(block);
    const sig = generatePatternSignature(features);

    const existing = groups.get(sig.groupKey);
    if (existing) {
      existing.blocks.push(block);
    } else {
      groups.set(sig.groupKey, { signature: sig, blocks: [block] });
    }
  }

  // Filter by minimum group size
  if (minGroupSize > 1) {
    for (const [key, group] of groups) {
      if (group.blocks.length < minGroupSize) {
        groups.delete(key);
      }
    }
  }

  return groups;
}
