import { FoldedArtifact, PQCodebook, RawBlock } from './types.js';
import { vectorizeBlock, VectorizeOptions } from './vectorize.js';
import { foldVectors, FoldingOptions } from './fold.js';
import { pqEncode, PQEncodeOptions } from './pq.js';
import { hashFoldedBlock, hashPQCode } from './commit.js';
import { normalizeVectors } from './normalization.js';

export interface ComputeFoldedBlockOptions {
  vectorize?: VectorizeOptions;
  folding?: FoldingOptions;
  pq?: PQEncodeOptions;
}

export function computeFoldedBlock(
  raw: RawBlock,
  codebook: PQCodebook,
  options: ComputeFoldedBlockOptions = {},
): FoldedArtifact {
  const vectorized = vectorizeBlock(raw, options.vectorize);
  const foldedBlock = foldVectors(vectorized, options.folding, {
    blockHeight: raw.header.height,
    txCount: raw.transactions.length,
    timestamp: raw.header.timestamp,
  });
  const normalizedBlock = codebook.normalization
    ? {
        ...foldedBlock,
        foldedVectors: normalizeVectors(foldedBlock.foldedVectors, codebook.normalization),
      }
    : foldedBlock;
  const pqOptions: PQEncodeOptions = {
    ...options.pq,
    errorBound: options.pq?.errorBound ?? codebook.errorBound,
  };
  const pqCode = pqEncode(normalizedBlock, codebook, pqOptions);
  const foldedCommitment = hashFoldedBlock(foldedBlock);
  const pqCommitment = hashPQCode(pqCode);

  return {
    foldedBlock,
    pqCode,
    commitments: {
      foldedCommitment,
      pqCommitment,
    },
  };
}

