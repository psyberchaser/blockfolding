import { FoldedArtifact, PQCodebook, RawBlock } from '../folding/types.js';
import { pqDecode } from '../folding/pq.js';
import { buildPublicInputs, FoldedProof, ZkProvingParams, ZkPublicInputs } from './publicInputs.js';

export interface CircuitWitness {
  transactions: RawBlock['transactions'];
  executionTraces: RawBlock['executionTraces'];
  witnessData: RawBlock['witnessData'];
  foldedVectors: number[][];
  pqIndices: number[][];
  pqVectors: number[][];
  blockHash: string;
  txRoot: string;
  stateRoot: string;
  headerRlp?: string;
}

export interface ZkBackend {
  prove(input: { witness: CircuitWitness; publicInputs: ZkPublicInputs; params: ZkProvingParams }): Promise<Uint8Array>;
  verify(input: { proof: FoldedProof; params: ZkProvingParams }): Promise<boolean>;
}

export function buildCircuitWitness(raw: RawBlock, artifact: FoldedArtifact, codebook: PQCodebook): CircuitWitness {
  const pqVectors = pqDecode(artifact.pqCode, codebook);
  return {
    transactions: raw.transactions,
    executionTraces: raw.executionTraces,
    witnessData: raw.witnessData,
    foldedVectors: artifact.foldedBlock.foldedVectors,
    pqIndices: artifact.pqCode.indices,
    pqVectors,
    blockHash: raw.header.hash ?? '',
    txRoot: raw.header.txRoot ?? '',
    stateRoot: raw.header.stateRoot ?? '',
    headerRlp: raw.header.headerRlp,
  };
}

export async function proveFoldedBlock(
  raw: RawBlock,
  artifact: FoldedArtifact,
  codebook: PQCodebook,
  params: ZkProvingParams,
  backend: ZkBackend,
): Promise<FoldedProof> {
  const witness = buildCircuitWitness(raw, artifact, codebook);
  const publicInputs = buildPublicInputs({
    prevStateRoot: raw.header.parentHash ?? '',
    newStateRoot: raw.header.stateRoot ?? '',
    blockHeight: raw.header.height,
    txMerkleRoot: raw.header.txRoot ?? '',
    commitments: artifact.commitments,
    codebookRoot: params.codebookRoot,
  });

  const proofBytes = await backend.prove({ witness, publicInputs, params });

  return {
    proofBytes,
    publicInputs,
  };
}

export async function verifyFoldedBlock(
  proof: FoldedProof,
  params: ZkProvingParams,
  backend: Pick<ZkBackend, 'verify'>,
): Promise<boolean> {
  return backend.verify({ proof, params });
}
