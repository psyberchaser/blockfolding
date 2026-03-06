import { Commitments, PQCode, PQCodebook } from '../folding/types.js';
import { hashCodebookRoot, hashPQCode } from '../folding/commit.js';

export interface ZkPublicInputs {
  prevStateRoot: string;
  newStateRoot: string;
  blockHeight: number;
  txMerkleRoot: string;
  foldedCommitment: string;
  pqCommitment: string;
  codebookRoot: string;
}

export interface FoldedProof {
  proofBytes: Uint8Array;
  publicInputs: ZkPublicInputs;
}

export interface ZkProvingParams {
  provingKeyPath: string;
  verificationKeyPath: string;
  curve: 'bn254' | 'bls12-381' | 'pallas' | 'vesta' | 'grumpkin';
  backend: 'halo2' | 'plonky2' | 'groth16' | 'marlin' | 'mock';
  codebookRoot: string;
}

export function buildPublicInputs(args: {
  prevStateRoot: string;
  newStateRoot: string;
  blockHeight: number;
  txMerkleRoot: string;
  commitments: Commitments;
  codebookRoot: string;
}): ZkPublicInputs {
  return {
    prevStateRoot: args.prevStateRoot,
    newStateRoot: args.newStateRoot,
    blockHeight: args.blockHeight,
    txMerkleRoot: args.txMerkleRoot,
    foldedCommitment: args.commitments.foldedCommitment,
    pqCommitment: args.commitments.pqCommitment,
    codebookRoot: args.codebookRoot,
  };
}

export function buildCodebookCommitment(codebook: PQCodebook): string {
  return hashCodebookRoot(codebook);
}

export function buildPQCommitments(pqCode: PQCode): string {
  return hashPQCode(pqCode);
}

