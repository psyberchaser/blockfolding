import { blake3 } from '@noble/hashes/blake3';
import { CircuitWitness, ZkBackend } from './witnessBuilder.js';
import { FoldedProof, ZkProvingParams, ZkPublicInputs } from './publicInputs.js';

export function createMockBackend(): ZkBackend {
  return {
    prove: async ({ witness, publicInputs }: { witness: CircuitWitness; publicInputs: ZkPublicInputs }) => {
      const payload = JSON.stringify({ witness, publicInputs });
      return blake3(Buffer.from(payload));
    },
    verify: async ({ proof }: { proof: FoldedProof; params: ZkProvingParams }) => {
      return proof.proofBytes.length > 0;
    },
  };
}

