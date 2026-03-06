/**
 * Pattern-Based Blockchain Validation Architecture
 * for Universal Computational Device Participation
 *
 * USPTO Provisional Patent Application 63/906,240
 *
 * This module exports the complete patent implementation:
 * - Eight-Dimensional Pattern Recognition Engine
 * - Meta-Block Generator with Reconstruction
 * - Pattern-Based Validation Engine
 * - Universal Validator Network with Tier Architecture
 */

// 8D Feature Extraction (Patent Claims 1, 2, 7)
export {
  extractEightDimFeatures,
  generatePatternSignature,
  calculatePatternSimilarity,
  cosineSimilarity,
  groupBlocksByPattern,
  featureVectorToNumeric,
  categorizeSizeBytes,
  categorizeTxCount,
  classifyEra,
  classifyDifficulty,
  assessComplexity,
  extractTemporalHour,
  extractTemporalDay,
  extractProtocolVersion,
  DIMENSION_WEIGHTS,
  type EightDimFeatureVector,
  type PatternSignature,
  type BlockFeatureInput,
  type SizeCategory,
  type TxCountCategory,
  type BlockchainEra,
  type DifficultyCategory,
  type TxComplexity,
} from './eightDimFeatures.js';

// Meta-Block Generation (Patent Claims 1, 3, 6)
export {
  generateMetaBlocks,
  reconstructBlock,
  reconstructBlockByHeight,
  validateBlockAgainstPattern,
  computeMerkleRoot,
  type MetaBlock,
  type MetaBlockIndex,
  type MetaBlockTemplate,
  type BlockModification,
  type ReconstructedBlock,
  type FullBlockInput,
} from './metaBlock.js';

// Pattern-Based Validation (Patent Claims 1, 4, 10, 14, 15)
export {
  buildPatternIndex,
  validateTransaction,
  validateBatch,
  detectFraudPatterns,
  getIndexStatistics,
  type PatternIndex,
  type ValidationReport,
  type TransactionValidationInput,
  type ValidatorConfig,
  type ValidationResult,
} from './patternValidator.js';

// Validator Network (Patent Claims 5, 8, 9, 11, 17)
export {
  ValidatorNetwork,
  classifyDeviceTier,
  getStorageRequirements,
  createValidationRequest,
  DEVICE_PROFILES,
  type DeviceType,
  type ValidatorTier,
  type ValidatorNode,
  type DeviceCapabilities,
  type ValidationRequest,
  type ValidationResponse,
  type NetworkStatus,
} from './network.js';
