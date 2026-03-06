export interface EightDimFeatures {
  sizeCategory: string
  txCountCategory: string
  temporalHour: number
  temporalDay: number
  era: string
  protocolVersion: number
  difficultyCategory: string
  transactionComplexity: string
}

export interface PatternSignature {
  hash: string
  groupKey: string
  numericVector: number[]
  features: EightDimFeatures
}

export interface FeatureResult {
  features: EightDimFeatures
  signature: PatternSignature
}

export interface ValidationResult {
  result: 'SUCCESS' | 'PATTERN_MATCH' | 'ANOMALY_DETECTED' | 'REQUIRES_FULL_NODE' | 'VALIDATION_FAILED'
  confidence: number
  validationTimeMs: number
  patternId: string
  patternMatch: boolean
  blockHeight: number
  transactionHash: string
  matchedMetaBlock: string
  anomalies: string[]
  reasoning: string[]
  escalateToArchive: boolean
}

export interface ValidatorNode {
  nodeId: string
  tier: 'mobile' | 'pattern' | 'archive'
  deviceType: string
  status: string
  validationsPerformed: number
  avgValidationTimeMs: number
}

export interface ValidatorStatus {
  patternIndexLoaded: boolean
  network: {
    totalNodes: number
    byTier: { mobile: number; pattern: number; archive: number }
    onlineNodes: number
    totalValidations: number
    avgEscalationRate: number
    patternIndexSizeMB: number
    consensusHealth: number
    networkUptime: number
  }
  index: {
    totalPatterns: number
    totalBlocksCovered: number
    totalAddresses: number
    totalTransactions: number
    avgBlocksPerPattern: number
    indexSizeKB: number
    indexSizeMB: number
    coverageByEra: Record<string, number>
    storageReduction: string
  }
  patent: string
  title: string
}

export interface MetaBlockInfo {
  totalBlocks: number
  totalMetaBlocks: number
  avgGroupSize: number
  compressionRatio: number
  indexSizeBytes: number
  byEra: Record<string, { blocks: number; metaBlocks: number; avgGroupSize: number }>
  patterns?: PatternDetail[]
}

export interface ProofSample {
  blockHeight: number
  foldedVectorDims: number
  pqCodeIndices: number
  pqResidualStats: { count: number; average: number; max: number; p95: number } | null
  commitments: {
    foldedCommitment: string | null
    pqCommitment: string | null
    codebookRoot: string | null
  }
  proofHex: string | null
  semanticTags: string[]
  hotzoneCount: number
}

export interface BenchmarkResult {
  dataSource: string
  blockRange: string
  blockCount: number
  processingRate: string
  compressionRatio: string
  storageReduction: string
  validationAccuracy: string
  avgLookupTimeMs: string
  patentClaims: Record<string, boolean>
  proofSample: ProofSample | null
}

export interface LogEntry {
  timestamp: string
  source: string
  message: string
  level: 'info' | 'success' | 'warning' | 'error'
}

export interface UnfoldStatus {
  ready: boolean
  addresses: number
  blocks: number
  transactions: number
  buildTimeMs: number
}

export interface UnfoldTransaction {
  blockHeight: number
  blockTimestamp: number
  hash: string
  sender: string
  receiver: string
  amountWei: number
  amountEth: number
  fee: number
  gasUsed: number
  gasPrice: number
  status: string
  functionSelector: string
  contractType: string
  dataSize: number
  nonce: string
  direction: 'in' | 'out'
}

export interface ProofIntegrity {
  foldedCommitment: string | null
  pqCommitment: string | null
  codebookRoot: string | null
  proofHex: string | null
  proofHexFull?: string | null
  proofAvailable: boolean
  publicInputs: {
    prevStateRoot?: string
    newStateRoot?: string
    blockHeight?: number
    txMerkleRoot?: string
    foldedCommitment?: string
    pqCommitment?: string
    codebookRoot?: string
  } | null
  verificationStatus: 'verified' | 'commitments_only'
}

export interface UnfoldBlock {
  blockHeight: number
  timestamp: number
  blockHash: string
  totalTxInBlock: number
  matchingTxCount: number
  patternInfo: {
    semanticTags: string[]
    behaviorMetrics: Record<string, unknown>
    codebookRoot: string
    hotzoneCount: number
  } | null
  proofIntegrity?: ProofIntegrity | null
}

export interface UnfoldResult {
  address: string
  found: boolean
  blockCount: number
  blocksReturned: number
  truncated: boolean
  transactionCount: number
  summary: {
    totalValueWei: string
    totalGasUsed: number
    inboundTxCount: number
    outboundTxCount: number
    uniqueCounterparties: number
    blockRange?: string
  }
  blocks: UnfoldBlock[]
  transactions: UnfoldTransaction[]
  message?: string
}

export interface OnDemandResult extends UnfoldResult {
  chain: string
  layer: 1 | 2
  discoveredBlocks: number
  alreadyIndexed: number
  newlyIngested: number
  ingestionTimeMs: number
  errors: string[]
}

export interface RiskFactor {
  factor: string
  score: number
  weight: number
  detail: string
}

export interface TransactionAlert {
  type: 'structuring' | 'round_number' | 'rapid_succession' | 'fan_out' | 'fan_in' | 'high_concentration' | 'mixer_interaction' | 'bridge_hop'
  severity: 'high' | 'medium' | 'low'
  description: string
  evidence: string[]
}

export interface ComplianceResult {
  address: string
  found: boolean
  riskScore: number
  riskLevel: 'low' | 'medium' | 'high'
  riskBreakdown: RiskFactor[]
  alerts: TransactionAlert[]
  flaggedTransactions: Array<UnfoldTransaction & { flagged: boolean; blockTags: string[]; entityLabel?: string }>
  totalTransactions: number
  counterpartyGraph: {
    nodes: Array<{ address: string; txCount: number; totalValue: number; isTarget?: boolean; entityLabel?: string }>
    edges: Array<{ from: string; to: string; value: number; count: number; direction: string; entityLabel?: string }>
  }
  patternFlags: string[]
  blockAnomalies: Array<{ height: number; score: number }>
  threshold: number
  analysisTimestamp: string
}

export interface PatternDetail {
  quantumId: string
  groupKey: string
  blockCount: number
  era: string
  compressionRatio: number
  confidence: number
  blockRange: string
  avgSize: number
  txCountRange: [number, number]
  integrityProof: string
  features: {
    sizeCategory: string
    txCountCategory: string
    temporalHour: number
    temporalDay: number
    era: string
    protocolVersion: number
    difficultyCategory: string
    transactionComplexity: string
  }
}

export interface IngestionEvent {
  stage: 'connected' | 'discovering' | 'fetching' | 'vectorizing' | 'folding' | 'quantizing' | 'proving' | 'stored' | 'complete'
  chain: string
  height: number
  detail?: string
  timestamp?: string
  mode?: 'live' | 'backfill'
}

export interface WatchlistEntry {
  label: string
  category: 'exchange' | 'dex' | 'bridge' | 'mixer' | 'defi' | 'sanctions' | 'internal' | 'custom'
}

export interface ValidatorConfig {
  chains: Record<string, { enabled: boolean; rpcUrl: string }>
  ingestion: { batchSize: number; zkProving: boolean; hotzoneLimit: number; autoIngest?: boolean; discardRaw?: boolean; unfoldMode?: 'local' | 'rpc' }
  codebookPath: string
  watchlist?: Record<string, WatchlistEntry>
}

export interface RpcTestResult {
  success: boolean
  latestBlock?: number
  latency?: number
  chainId?: number | string
  error?: string
}

export interface StageTiming {
  avgMs: number
  minMs: number
  maxMs: number
}

export interface BlockTimingEntry {
  chain: string
  height: number
  txCount: number
  totalMs: number
  stages: Record<string, number>
}

export interface RealBenchmarkResult {
  dataSource: string
  chain: string
  blockCount: number
  blockRange: string
  stages: Record<string, StageTiming>
  blocksPerSec: number
  perBlock: BlockTimingEntry[]
  comparison: { endToEnd: string; computeOnly: string; rpcPct: string; avgBlockMs: number; avgComputeMs: number; avgRpcMs: number }
  patentClaims: Record<string, boolean>
}
