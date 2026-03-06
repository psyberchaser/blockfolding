export type NumericVector = number[];

export type TxVector = NumericVector;
export type StateVector = NumericVector;
export type WitnessVector = NumericVector;

export interface RawBlockHeader {
  height: number;
  hash?: string;
  parentHash?: string;
  stateRoot?: string;
  txRoot?: string;
  receiptsRoot?: string;
  prevStateRoot?: string;
  newStateRoot?: string;
  txMerkleRoot?: string;
  timestamp?: number;
  headerRlp?: string;
}

export interface RawBlock {
  header: RawBlockHeader;
  transactions: Record<string, unknown>[];
  executionTraces: Record<string, unknown>[];
  witnessData: Record<string, unknown>;
}

export interface VectorizedBlock {
  txVectors: TxVector[];
  stateVectors: StateVector[];
  witnessVectors: WitnessVector[];
}

export interface FoldedBlockMetadata {
  blockHeight: number;
  txCount: number;
  timestamp?: number;
  notes?: string;
}

export interface FoldedBlock {
  foldedVectors: NumericVector[];
  metadata: FoldedBlockMetadata;
}

export interface NormalizationStats {
  mean: number[];
  stdDev: number[];
}

export interface PQCodebook {
  centroids: number[][][];
  subvectorDim: number;
  numCentroids: number;
  numSubspaces: number;
  normalization?: NormalizationStats;
  errorBound?: number;
}

export interface PQCode {
  indices: number[][];
  residuals?: number[];
}

export interface Commitments {
  foldedCommitment: string;
  pqCommitment: string;
}

export interface FoldedArtifact {
  foldedBlock: FoldedBlock;
  pqCode: PQCode;
  commitments: Commitments;
}

