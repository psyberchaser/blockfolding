/**
 * Pattern-Based Validation Engine
 *
 * Validates transactions and blocks using only the pattern index (94MB),
 * NOT the full blockchain (258GB+). Enables any computational device to
 * participate in blockchain validation.
 *
 * Validation Process (per patent):
 * 1. Extract 8-dimensional pattern features from transaction's block
 * 2. Query pattern index for matching pattern group
 * 3. Verify transaction belongs to identified pattern
 * 4. If anomalous: Escalate to archive node for complete verification
 * 5. If normal: Approve using pattern-based validation with high confidence
 *
 * Implements: Patent Claims 1, 3, 4, 8, 10, 11, 14, 15
 */

import {
  extractEightDimFeatures,
  generatePatternSignature,
  calculatePatternSimilarity,
  cosineSimilarity,
  type BlockFeatureInput,
  type EightDimFeatureVector,
  type PatternSignature,
} from './eightDimFeatures.js';
import {
  type MetaBlock,
  type MetaBlockIndex,
  reconstructBlockByHeight,
} from './metaBlock.js';

// ============================================
// TYPES
// ============================================

export type ValidationResult = 'SUCCESS' | 'PATTERN_MATCH' | 'ANOMALY_DETECTED' | 'REQUIRES_FULL_NODE' | 'VALIDATION_FAILED';

export interface ValidationReport {
  result: ValidationResult;
  confidence: number;            // 0.0 - 1.0
  validationTimeMs: number;
  patternId: string | null;
  patternMatch: boolean;
  blockHeight: number;
  transactionHash?: string;
  matchedMetaBlock?: string;     // quantumId of matched meta-block
  anomalies: string[];
  reasoning: string[];
  escalateToArchive: boolean;
  deviceType?: string;
}

export interface TransactionValidationInput {
  txHash: string;
  blockHeight: number;
  blockSize: number;
  txCount: number;
  timestamp: number;
  txIndex: number;
  gasUsed?: number;
  value?: number;
  inputDataLength?: number;
  contractCreation?: boolean;
  chain?: 'eth' | 'btc' | 'sol' | 'avax';
  difficulty?: number;
}

export interface PatternIndex {
  metaBlocks: MetaBlock[];
  signatureMap: Map<string, MetaBlock[]>; // groupKey -> meta-blocks
  heightMap: Map<number, MetaBlock>;       // blockHeight -> meta-block
  totalBlocks: number;
  indexSizeBytes: number;
}

export interface ValidatorConfig {
  anomalyThreshold: number;          // Default 0.05 (5%)
  minConfidence: number;             // Minimum confidence to approve
  similarityThreshold: number;       // Minimum similarity for pattern match
  maxEscalationRate: number;         // Max % of validations to escalate
  enableFraudDetection: boolean;     // Check for known fraud patterns
}

const DEFAULT_CONFIG: ValidatorConfig = {
  anomalyThreshold: 0.05,
  minConfidence: 0.7,
  similarityThreshold: 0.8,
  maxEscalationRate: 0.05,
  enableFraudDetection: true,
};

// ============================================
// PATTERN INDEX BUILDER
// ============================================

/**
 * Build an in-memory pattern index from a meta-block index
 * This is what every validator loads (94MB compressed)
 */
export function buildPatternIndex(metaBlockIndex: MetaBlockIndex): PatternIndex {
  const signatureMap = new Map<string, MetaBlock[]>();
  const heightMap = new Map<number, MetaBlock>();

  for (const mb of metaBlockIndex.metaBlocks) {
    // Index by group key
    const existing = signatureMap.get(mb.groupKey);
    if (existing) {
      existing.push(mb);
    } else {
      signatureMap.set(mb.groupKey, [mb]);
    }

    // Index by block height
    for (const ref of mb.blockReferences) {
      heightMap.set(ref.blockHeight, mb);
    }
  }

  const indexJson = JSON.stringify(metaBlockIndex.metaBlocks);

  return {
    metaBlocks: metaBlockIndex.metaBlocks,
    signatureMap,
    heightMap,
    totalBlocks: metaBlockIndex.totalBlocks,
    indexSizeBytes: indexJson.length,
  };
}

// ============================================
// CORE VALIDATION ENGINE
// ============================================

/**
 * Validate a transaction using only the pattern index
 * This is the primary validation function - no full blockchain needed
 */
export function validateTransaction(
  tx: TransactionValidationInput,
  index: PatternIndex,
  config: Partial<ValidatorConfig> = {},
): ValidationReport {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = performance.now();
  const anomalies: string[] = [];
  const reasoning: string[] = [];

  // Step 1: Extract 8D features from the transaction's block
  const blockInput: BlockFeatureInput = {
    sizeBytes: tx.blockSize,
    txCount: tx.txCount,
    timestamp: tx.timestamp,
    blockHeight: tx.blockHeight,
    chain: tx.chain,
    difficulty: tx.difficulty,
  };
  const features = extractEightDimFeatures(blockInput);
  const sig = generatePatternSignature(features);
  reasoning.push(`Extracted 8D features: ${sig.groupKey}`);

  // Step 2: Query pattern index for matching pattern group
  const exactMatch = index.heightMap.get(tx.blockHeight);
  const patternMatches = index.signatureMap.get(sig.groupKey) ?? [];
  reasoning.push(`Pattern lookup: ${exactMatch ? 'exact height match' : `${patternMatches.length} pattern matches`}`);

  // Step 3: Validate against matched pattern(s)
  let bestMatch: MetaBlock | null = null;
  let bestSimilarity = 0;

  if (exactMatch) {
    bestMatch = exactMatch;
    bestSimilarity = 1.0;
    reasoning.push(`Direct block match in meta-block ${exactMatch.quantumId}`);
  } else if (patternMatches.length > 0) {
    // Find best matching meta-block by similarity
    for (const mb of patternMatches) {
      const sim = calculatePatternSimilarity(features, mb.patternFeatures);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = mb;
      }
    }
    reasoning.push(`Best pattern match: ${bestMatch?.quantumId} (similarity: ${bestSimilarity.toFixed(3)})`);
  } else {
    // No exact match - try fuzzy matching across all meta-blocks
    for (const mb of index.metaBlocks) {
      const sim = calculatePatternSimilarity(features, mb.patternFeatures);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = mb;
      }
    }
    if (bestMatch) {
      reasoning.push(`Fuzzy match: ${bestMatch.quantumId} (similarity: ${bestSimilarity.toFixed(3)})`);
    }
  }

  // Step 4: Anomaly detection
  if (bestMatch) {
    const template = bestMatch.template;

    // Size anomaly check
    const sizeDeviation = Math.abs(tx.blockSize - template.avgSize) / (template.avgSize || 1);
    if (sizeDeviation > 2.0) {
      anomalies.push(`size_deviation:${sizeDeviation.toFixed(2)}`);
      reasoning.push(`Block size ${tx.blockSize} deviates ${(sizeDeviation * 100).toFixed(0)}% from pattern avg ${template.avgSize}`);
    }

    // Transaction count anomaly
    if (tx.txCount < template.txCountRange[0] * 0.5 || tx.txCount > template.txCountRange[1] * 2.0) {
      anomalies.push(`tx_count_anomaly:${tx.txCount}`);
      reasoning.push(`Tx count ${tx.txCount} outside expected range [${template.txCountRange.join('-')}]`);
    }

    // Temporal anomaly
    const blockDate = new Date(tx.timestamp * 1000);
    const hour = blockDate.getUTCHours();
    if (Math.abs(hour - features.temporalHour) > 6) {
      anomalies.push(`temporal_anomaly:hour_${hour}`);
    }

    // Fraud detection
    if (cfg.enableFraudDetection) {
      if (tx.gasUsed && tx.gasUsed > 30_000_000) {
        anomalies.push('high_gas_usage');
        reasoning.push(`Unusually high gas: ${tx.gasUsed}`);
      }
      if (tx.inputDataLength && tx.inputDataLength > 100_000) {
        anomalies.push('large_input_data');
        reasoning.push(`Large input data: ${tx.inputDataLength} bytes`);
      }
    }
  }

  // Step 5: Determine validation result
  const validationTimeMs = performance.now() - startTime;
  let result: ValidationResult;
  let confidence: number;
  let escalateToArchive = false;

  if (bestMatch && bestSimilarity >= cfg.similarityThreshold && anomalies.length === 0) {
    // Pattern matches, no anomalies - validated
    result = exactMatch ? 'SUCCESS' : 'PATTERN_MATCH';
    confidence = bestSimilarity * bestMatch.validationMetadata.validationConfidence;
    reasoning.push(`Validation passed with confidence ${confidence.toFixed(3)}`);
  } else if (bestMatch && anomalies.length > 0) {
    // Pattern matches but anomalies detected
    result = 'ANOMALY_DETECTED';
    confidence = Math.max(0.1, bestSimilarity - anomalies.length * 0.15);
    escalateToArchive = true;
    reasoning.push(`Anomalies detected: ${anomalies.join(', ')} - escalating to archive node`);
  } else if (bestSimilarity < cfg.similarityThreshold) {
    // No good pattern match
    result = 'REQUIRES_FULL_NODE';
    confidence = bestSimilarity;
    escalateToArchive = true;
    reasoning.push(`No sufficient pattern match (best: ${bestSimilarity.toFixed(3)}) - requires full node verification`);
  } else {
    result = 'VALIDATION_FAILED';
    confidence = 0;
    escalateToArchive = true;
    reasoning.push('Validation failed - no pattern match found');
  }

  return {
    result,
    confidence,
    validationTimeMs,
    patternId: bestMatch?.quantumId ?? null,
    patternMatch: bestSimilarity >= cfg.similarityThreshold,
    blockHeight: tx.blockHeight,
    transactionHash: tx.txHash,
    matchedMetaBlock: bestMatch?.quantumId,
    anomalies,
    reasoning,
    escalateToArchive,
  };
}

// ============================================
// BATCH VALIDATION
// ============================================

/**
 * Validate a batch of transactions
 * Returns aggregate statistics and individual results
 */
export function validateBatch(
  transactions: TransactionValidationInput[],
  index: PatternIndex,
  config: Partial<ValidatorConfig> = {},
): {
  results: ValidationReport[];
  summary: {
    total: number;
    success: number;
    patternMatch: number;
    anomaly: number;
    requiresFullNode: number;
    failed: number;
    avgConfidence: number;
    avgValidationTimeMs: number;
    escalationRate: number;
  };
} {
  const results = transactions.map(tx => validateTransaction(tx, index, config));

  const success = results.filter(r => r.result === 'SUCCESS').length;
  const patternMatch = results.filter(r => r.result === 'PATTERN_MATCH').length;
  const anomaly = results.filter(r => r.result === 'ANOMALY_DETECTED').length;
  const requiresFullNode = results.filter(r => r.result === 'REQUIRES_FULL_NODE').length;
  const failed = results.filter(r => r.result === 'VALIDATION_FAILED').length;
  const avgConfidence = results.reduce((s, r) => s + r.confidence, 0) / (results.length || 1);
  const avgTime = results.reduce((s, r) => s + r.validationTimeMs, 0) / (results.length || 1);
  const escalated = results.filter(r => r.escalateToArchive).length;

  return {
    results,
    summary: {
      total: results.length,
      success,
      patternMatch,
      anomaly,
      requiresFullNode,
      failed,
      avgConfidence,
      avgValidationTimeMs: avgTime,
      escalationRate: escalated / (results.length || 1),
    },
  };
}

// ============================================
// ANALYTICS & FRAUD DETECTION
// ============================================

/**
 * Detect potential fraud patterns in a transaction
 * Patent Claim 14: Cryptocurrency exchange fraud detection
 */
export function detectFraudPatterns(
  tx: TransactionValidationInput,
  index: PatternIndex,
): { isSuspicious: boolean; reasons: string[]; riskScore: number } {
  const reasons: string[] = [];
  let riskScore = 0;

  // Check if block pattern is unusual
  const blockInput: BlockFeatureInput = {
    sizeBytes: tx.blockSize,
    txCount: tx.txCount,
    timestamp: tx.timestamp,
    blockHeight: tx.blockHeight,
    chain: tx.chain,
  };
  const features = extractEightDimFeatures(blockInput);
  const sig = generatePatternSignature(features);

  const patternMatches = index.signatureMap.get(sig.groupKey);
  if (!patternMatches || patternMatches.length === 0) {
    reasons.push('Block pattern not found in known patterns');
    riskScore += 0.3;
  }

  // High gas usage
  if (tx.gasUsed && tx.gasUsed > 25_000_000) {
    reasons.push(`Extremely high gas usage: ${tx.gasUsed}`);
    riskScore += 0.2;
  }

  // Contract creation in unusual pattern
  if (tx.contractCreation && features.transactionComplexity === 'simple') {
    reasons.push('Contract creation in otherwise simple block');
    riskScore += 0.15;
  }

  // Very large transaction value
  if (tx.value && tx.value > 1_000_000) {
    reasons.push(`Large value transfer: ${tx.value}`);
    riskScore += 0.1;
  }

  // Unusual timing
  if (features.temporalHour >= 2 && features.temporalHour <= 5) {
    reasons.push(`Transaction during low-activity hours (${features.temporalHour}:00 UTC)`);
    riskScore += 0.05;
  }

  return {
    isSuspicious: riskScore > 0.3,
    reasons,
    riskScore: Math.min(1, riskScore),
  };
}

// ============================================
// INDEX STATISTICS
// ============================================

/**
 * Get statistics about the pattern index
 */
export function getIndexStatistics(index: PatternIndex): {
  totalPatterns: number;
  totalBlocksCovered: number;
  avgBlocksPerPattern: number;
  indexSizeKB: number;
  indexSizeMB: number;
  coverageByEra: Record<string, number>;
  storageReduction: string;
} {
  const totalPatterns = index.metaBlocks.length;
  const totalBlocksCovered = index.totalBlocks;
  const avgBlocksPerPattern = totalBlocksCovered / (totalPatterns || 1);

  // Estimate full blockchain size vs pattern index size
  const estimatedFullChainBytes = totalBlocksCovered * 300_000; // ~300KB avg block
  const indexSizeKB = index.indexSizeBytes / 1024;
  const indexSizeMB = indexSizeKB / 1024;
  const reduction = ((1 - index.indexSizeBytes / estimatedFullChainBytes) * 100).toFixed(1);

  const coverageByEra: Record<string, number> = {};
  for (const mb of index.metaBlocks) {
    const era = mb.patternFeatures.era;
    coverageByEra[era] = (coverageByEra[era] ?? 0) + mb.blockCount;
  }

  return {
    totalPatterns,
    totalBlocksCovered,
    avgBlocksPerPattern,
    indexSizeKB,
    indexSizeMB,
    coverageByEra,
    storageReduction: `${reduction}%`,
  };
}
