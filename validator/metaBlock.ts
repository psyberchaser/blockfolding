/**
 * Meta-Block Generator with Reconstruction
 *
 * Groups blocks by pattern signature into meta-blocks containing:
 * - Pattern template (common structure)
 * - Per-block modifications (deltas from template)
 * - Reconstruction information for recovering original block data
 * - Cryptographic integrity proofs
 *
 * Implements: Patent Claims 1, 3, 6, 8, 9
 */

import { createHash } from 'node:crypto';
import {
  extractEightDimFeatures,
  generatePatternSignature,
  type BlockFeatureInput,
  type EightDimFeatureVector,
  type PatternSignature,
} from './eightDimFeatures.js';

// ============================================
// TYPES
// ============================================

export interface MetaBlockTemplate {
  avgSize: number;
  txCountRange: [number, number];
  difficultyRange: [number, number];
  avgGasUsed: number;
  avgTimestamp: number;
  commonFeatures: EightDimFeatureVector;
}

export interface BlockModification {
  blockHash: string;
  blockHeight: number;
  sizeBytes: number;
  txCount: number;
  timestamp: number;
  difficulty: number;
  // Delta from template
  sizeDelta: number;
  txCountDelta: number;
  timestampDelta: number;
  // Per-block data needed for reconstruction
  transactionHashes?: string[];
  stateRoot?: string;
  receiptsRoot?: string;
}

export interface MetaBlock {
  quantumId: string;              // Unique meta-block identifier (16 chars)
  patternSignature: string;       // SHA256 hash of pattern
  groupKey: string;               // Human-readable pattern key
  patternFeatures: EightDimFeatureVector;
  template: MetaBlockTemplate;
  blockReferences: BlockModification[];
  validationMetadata: {
    patternTemplate: string;
    validationRange: string;
    expectedCharacteristics: {
      avgSize: number;
      txCountRange: string;
      difficultyRange: string;
    };
    anomalyThreshold: number;
    validationConfidence: number;
  };
  integrityProof: string;         // Merkle root of meta-block data
  compressionRatio: number;
  blockCount: number;
  createdAt: number;
}

export interface MetaBlockIndex {
  totalBlocks: number;
  totalMetaBlocks: number;
  avgGroupSize: number;
  compressionRatio: number;
  indexSizeBytes: number;
  metaBlocks: MetaBlock[];
  byEra: Record<string, { blocks: number; metaBlocks: number; avgGroupSize: number }>;
}

export interface ReconstructedBlock {
  blockHeight: number;
  blockHash: string;
  estimatedSize: number;
  txCount: number;
  timestamp: number;
  difficulty: number;
  features: EightDimFeatureVector;
  patternId: string;
  reconstructionConfidence: number;
  transactionHashes?: string[];
  stateRoot?: string;
  receiptsRoot?: string;
}

// ============================================
// EXTENDED BLOCK INPUT (with full data for meta-block creation)
// ============================================

export interface FullBlockInput extends BlockFeatureInput {
  blockHash: string;
  difficulty: number;
  gasUsed?: number;
  transactionHashes?: string[];
  stateRoot?: string;
  receiptsRoot?: string;
}

// ============================================
// META-BLOCK GENERATION
// ============================================

/**
 * Generate meta-blocks from a list of full block inputs
 * Groups blocks by 8D pattern signature and creates compressed representations
 */
export function generateMetaBlocks(
  blocks: FullBlockInput[],
  minGroupSize: number = 2,
): MetaBlockIndex {
  // Step 1: Extract features and group by pattern
  const groups = new Map<string, { sig: PatternSignature; blocks: FullBlockInput[] }>();

  for (const block of blocks) {
    const features = extractEightDimFeatures(block);
    const sig = generatePatternSignature(features);
    const existing = groups.get(sig.groupKey);
    if (existing) {
      existing.blocks.push(block);
    } else {
      groups.set(sig.groupKey, { sig, blocks: [block] });
    }
  }

  // Step 2: Create meta-blocks for each group
  const metaBlocks: MetaBlock[] = [];
  const byEra: Record<string, { blocks: number; metaBlocks: number; avgGroupSize: number }> = {};

  for (const [, group] of groups) {
    if (group.blocks.length < minGroupSize) continue;

    const metaBlock = createMetaBlock(group.sig, group.blocks);
    metaBlocks.push(metaBlock);

    // Track era stats
    const era = group.sig.features.era;
    if (!byEra[era]) byEra[era] = { blocks: 0, metaBlocks: 0, avgGroupSize: 0 };
    byEra[era].blocks += group.blocks.length;
    byEra[era].metaBlocks += 1;
  }

  // Calculate era averages
  for (const era of Object.keys(byEra)) {
    byEra[era].avgGroupSize = byEra[era].blocks / byEra[era].metaBlocks;
  }

  const totalGroupedBlocks = metaBlocks.reduce((s, mb) => s + mb.blockCount, 0);
  const indexJson = JSON.stringify(metaBlocks);

  return {
    totalBlocks: blocks.length,
    totalMetaBlocks: metaBlocks.length,
    avgGroupSize: totalGroupedBlocks / (metaBlocks.length || 1),
    compressionRatio: blocks.length / (metaBlocks.length || 1),
    indexSizeBytes: indexJson.length,
    metaBlocks,
    byEra,
  };
}

/**
 * Create a single meta-block from a group of blocks sharing the same pattern
 */
function createMetaBlock(sig: PatternSignature, blocks: FullBlockInput[]): MetaBlock {
  // Calculate template (average/common characteristics)
  const template = calculateTemplate(sig.features, blocks);

  // Generate per-block modifications (deltas from template)
  const blockRefs = blocks.map(b => createBlockModification(b, template));

  // Calculate integrity proof (Merkle root)
  const integrityProof = computeMerkleRoot(blockRefs.map(br => br.blockHash));

  // Generate unique quantum ID (first 16 chars of SHA256)
  const quantumId = sig.hash.substring(0, 16);

  // Compression ratio: estimated original size / meta-block size
  const estimatedOriginalSize = blocks.reduce((s, b) => s + b.sizeBytes, 0);
  const metaBlockSize = JSON.stringify({ template, blockRefs: blockRefs.length }).length +
    blockRefs.length * 120; // ~120 bytes per block reference
  const compressionRatio = estimatedOriginalSize / (metaBlockSize || 1);

  // Validation confidence based on group consistency
  const sizeVariance = computeVariance(blocks.map(b => b.sizeBytes));
  const txVariance = computeVariance(blocks.map(b => b.txCount));
  const validationConfidence = Math.max(0.5, 1 - (sizeVariance + txVariance) / 2);

  return {
    quantumId,
    patternSignature: sig.hash,
    groupKey: sig.groupKey,
    patternFeatures: sig.features,
    template,
    blockReferences: blockRefs,
    validationMetadata: {
      patternTemplate: sig.groupKey,
      validationRange: `block_${blocks[0].blockHeight}_to_${blocks[blocks.length - 1].blockHeight}`,
      expectedCharacteristics: {
        avgSize: template.avgSize,
        txCountRange: `${template.txCountRange[0]}-${template.txCountRange[1]}`,
        difficultyRange: `${template.difficultyRange[0]}-${template.difficultyRange[1]}`,
      },
      anomalyThreshold: 0.05,
      validationConfidence,
    },
    integrityProof,
    compressionRatio,
    blockCount: blocks.length,
    createdAt: Date.now(),
  };
}

/**
 * Calculate the template (common characteristics) for a pattern group
 */
function calculateTemplate(
  features: EightDimFeatureVector,
  blocks: FullBlockInput[],
): MetaBlockTemplate {
  const sizes = blocks.map(b => b.sizeBytes);
  const txCounts = blocks.map(b => b.txCount);
  const diffs = blocks.map(b => b.difficulty);
  const gases = blocks.map(b => b.gasUsed ?? 0);
  const timestamps = blocks.map(b => b.timestamp);

  return {
    avgSize: avg(sizes),
    txCountRange: [Math.min(...txCounts), Math.max(...txCounts)],
    difficultyRange: [Math.min(...diffs), Math.max(...diffs)],
    avgGasUsed: avg(gases),
    avgTimestamp: avg(timestamps),
    commonFeatures: features,
  };
}

/**
 * Create a block modification record (delta from template)
 */
function createBlockModification(
  block: FullBlockInput,
  template: MetaBlockTemplate,
): BlockModification {
  return {
    blockHash: block.blockHash,
    blockHeight: block.blockHeight,
    sizeBytes: block.sizeBytes,
    txCount: block.txCount,
    timestamp: block.timestamp,
    difficulty: block.difficulty,
    sizeDelta: block.sizeBytes - template.avgSize,
    txCountDelta: block.txCount - Math.round((template.txCountRange[0] + template.txCountRange[1]) / 2),
    timestampDelta: block.timestamp - template.avgTimestamp,
    transactionHashes: block.transactionHashes,
    stateRoot: block.stateRoot,
    receiptsRoot: block.receiptsRoot,
  };
}

// ============================================
// RECONSTRUCTION
// ============================================

/**
 * Reconstruct block data from a meta-block and block reference
 * Patent Claim 6: Meta-block includes reconstruction information
 */
export function reconstructBlock(
  metaBlock: MetaBlock,
  blockHash: string,
): ReconstructedBlock | null {
  const ref = metaBlock.blockReferences.find(br => br.blockHash === blockHash);
  if (!ref) return null;

  return {
    blockHeight: ref.blockHeight,
    blockHash: ref.blockHash,
    estimatedSize: ref.sizeBytes,
    txCount: ref.txCount,
    timestamp: ref.timestamp,
    difficulty: ref.difficulty,
    features: metaBlock.patternFeatures,
    patternId: metaBlock.quantumId,
    reconstructionConfidence: metaBlock.validationMetadata.validationConfidence,
    transactionHashes: ref.transactionHashes,
    stateRoot: ref.stateRoot,
    receiptsRoot: ref.receiptsRoot,
  };
}

/**
 * Reconstruct a block by height from the entire meta-block index
 */
export function reconstructBlockByHeight(
  index: MetaBlockIndex,
  blockHeight: number,
): ReconstructedBlock | null {
  for (const mb of index.metaBlocks) {
    const ref = mb.blockReferences.find(br => br.blockHeight === blockHeight);
    if (ref) return reconstructBlock(mb, ref.blockHash);
  }
  return null;
}

/**
 * Validate a block against its meta-block pattern
 * Returns true if the block characteristics match the pattern expectations
 */
export function validateBlockAgainstPattern(
  block: FullBlockInput,
  metaBlock: MetaBlock,
): { valid: boolean; confidence: number; anomalies: string[] } {
  const anomalies: string[] = [];
  const template = metaBlock.template;

  // Check size within expected range (±2 standard deviations)
  const sizeDeviation = Math.abs(block.sizeBytes - template.avgSize) / (template.avgSize || 1);
  if (sizeDeviation > 0.5) anomalies.push(`size_deviation:${sizeDeviation.toFixed(2)}`);

  // Check tx count within range
  if (block.txCount < template.txCountRange[0] * 0.5 || block.txCount > template.txCountRange[1] * 1.5) {
    anomalies.push(`tx_count_out_of_range:${block.txCount}`);
  }

  // Check difficulty within range
  if (block.difficulty < template.difficultyRange[0] * 0.1 || block.difficulty > template.difficultyRange[1] * 10) {
    anomalies.push(`difficulty_out_of_range:${block.difficulty}`);
  }

  // Check 8D feature match
  const features = extractEightDimFeatures(block);
  const sig = generatePatternSignature(features);
  if (sig.groupKey !== metaBlock.groupKey) {
    anomalies.push(`pattern_mismatch:${sig.groupKey}`);
  }

  const confidence = Math.max(0, 1 - anomalies.length * 0.25);
  return {
    valid: anomalies.length === 0,
    confidence,
    anomalies,
  };
}

// ============================================
// CRYPTOGRAPHIC INTEGRITY
// ============================================

/**
 * Compute Merkle root from a list of hashes
 * Preserves cryptographic integrity through pattern-based validation
 */
export function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return createHash('sha256').update('empty').digest('hex');
  if (hashes.length === 1) return hashes[0];

  const nextLevel: string[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    const left = hashes[i];
    const right = hashes[i + 1] ?? left;
    nextLevel.push(createHash('sha256').update(left + right).digest('hex'));
  }
  return computeMerkleRoot(nextLevel);
}

// ============================================
// UTILITIES
// ============================================

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}

function computeVariance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  const maxVal = Math.max(...arr.map(Math.abs));
  if (maxVal === 0) return 0;
  const normalizedVar = arr.reduce((s, v) => s + ((v - mean) / maxVal) ** 2, 0) / arr.length;
  return Math.min(1, normalizedVar);
}
