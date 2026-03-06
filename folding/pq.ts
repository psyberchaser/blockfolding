import { FoldedBlock, PQCode, PQCodebook } from './types.js';

export interface PQEncodeOptions {
  errorBound?: number;
  strict?: boolean;
}

const DEFAULT_OPTIONS: Required<PQEncodeOptions> = {
  errorBound: 0.25,
  strict: false,
};

export function pqEncode(
  folded: FoldedBlock,
  codebook: PQCodebook,
  options: PQEncodeOptions = {},
): PQCode {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const indices = folded.foldedVectors.map((vector) => encodeVector(vector, codebook));

  const residuals = computeResiduals(folded.foldedVectors, indices, codebook);
  if (opts.errorBound > 0) {
    enforceErrorBound(residuals, opts.errorBound, opts.strict);
  }

  return { indices, residuals };
}

export function pqDecode(code: PQCode, codebook: PQCodebook): number[][] {
  return code.indices.map((subspaceIndices) => reconstructVector(subspaceIndices, codebook));
}

function encodeVector(vector: number[], codebook: PQCodebook): number[] {
  const subvectors = splitIntoSubvectors(vector, codebook.subvectorDim);
  return subvectors.map((subvector, subspaceIdx) => {
    const centroidIndex = findClosestCentroid(subvector, codebook.centroids[subspaceIdx]);
    return centroidIndex;
  });
}

function enforceErrorBound(residuals: number[], errorBound: number, strict: boolean): void {
  residuals.forEach((error) => {
    if (error > errorBound) {
      const message = `PQ encode error ${error.toFixed(6)} exceeds bound ${errorBound}`;
      if (strict) {
        throw new Error(message);
      } else {
        // eslint-disable-next-line no-console
        console.warn(message);
      }
    }
  });
}

function padVector(vector: number[], length: number): number[] {
  if (vector.length >= length) {
    return vector.slice(0, length);
  }
  return [...vector, ...new Array(length - vector.length).fill(0)];
}

function reconstructVector(subspaceIndices: number[], codebook: PQCodebook): number[] {
  const parts: number[][] = subspaceIndices.map((centroidIndex, subspaceIdx) => {
    const centroids = codebook.centroids[subspaceIdx];
    return centroids?.[centroidIndex] ?? new Array(codebook.subvectorDim).fill(0);
  });
  return parts.flat();
}

function splitIntoSubvectors(vector: number[], subvectorDim: number): number[][] {
  const parts: number[][] = [];
  for (let i = 0; i < vector.length; i += subvectorDim) {
    const slice = vector.slice(i, i + subvectorDim);
    if (slice.length < subvectorDim) {
      slice.push(...new Array(subvectorDim - slice.length).fill(0));
    }
    parts.push(slice);
  }
  return parts;
}

function findClosestCentroid(subvector: number[], centroids: number[][]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  centroids.forEach((centroid, index) => {
    const distance = computeError(subvector, centroid);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function computeError(vectorA: number[], vectorB: number[]): number {
  let sum = 0;
  for (let i = 0; i < vectorA.length; i += 1) {
    const diff = (vectorA[i] ?? 0) - (vectorB[i] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function computeResiduals(
  originalVectors: number[][],
  codeIndices: number[][],
  codebook: PQCodebook,
): number[] {
  return originalVectors.map((vector, index) => {
    const reconstructed = reconstructVector(codeIndices[index], codebook);
    return computeError(padVector(vector, reconstructed.length), reconstructed);
  });
}

