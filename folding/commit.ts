import { blake3 } from '@noble/hashes/blake3';
import { FoldedBlock, PQCode, PQCodebook } from './types.js';

export function hashFoldedBlock(block: FoldedBlock): string {
  const payload = JSON.stringify(block.foldedVectors);
  return toHex(blake3(Buffer.from(payload)));
}

export function hashPQCode(code: PQCode): string {
  const payload = JSON.stringify(code.indices);
  return toHex(blake3(Buffer.from(payload)));
}

export function hashCodebookRoot(
  input: number[][][] | PQCodebook,
): string {
  const payload = Array.isArray(input)
    ? JSON.stringify({ centroids: input })
    : JSON.stringify({
        centroids: input.centroids,
        normalization: input.normalization,
        errorBound: input.errorBound,
      });
  return toHex(blake3(Buffer.from(payload)));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

