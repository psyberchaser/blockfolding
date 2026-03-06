import { FoldedBlock, FoldedBlockMetadata, VectorizedBlock } from './types.js';
import {
  ComponentMatrixOptions,
  loadComponentMatrix,
  validateMatrix,
} from './componentMatrix.js';

export interface FoldingOptions {
  numComponents?: number;
  foldDim?: number;
  epsilon?: number;
  componentMatrix?: number[][];
  componentMatrixOptions?: ComponentMatrixOptions;
}

const DEFAULT_OPTIONS: Required<Omit<FoldingOptions, 'componentMatrix' | 'componentMatrixOptions'>> = {
  numComponents: 4,
  foldDim: 16,
  epsilon: 1e-6,
};

export function foldVectors(
  vectorized: VectorizedBlock,
  options: FoldingOptions = {},
  metadata: Partial<FoldedBlockMetadata> = {},
): FoldedBlock {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const allVectors = [...vectorized.txVectors, ...vectorized.stateVectors, ...vectorized.witnessVectors];

  if (allVectors.length === 0) {
    throw new Error('No vectors provided for folding');
  }

  const canonical = allVectors.map((vec) => resizeVector(vec, opts.foldDim));
  const baseStats = computeStats(canonical);
  const componentMatrix = ensureComponentMatrix(
    opts.componentMatrix,
    opts.foldDim,
    opts.numComponents,
    opts.componentMatrixOptions,
  );
  const components = applyComponentMatrix(canonical, componentMatrix.weights, opts.epsilon);

  const foldedMetadata: FoldedBlockMetadata = {
    blockHeight: metadata.blockHeight ?? 0,
    txCount: metadata.txCount ?? vectorized.txVectors.length,
    timestamp: metadata.timestamp,
    notes: metadata.notes,
  };

  return {
    foldedVectors: [baseStats.mean, baseStats.variance, ...components],
    metadata: foldedMetadata,
  };
}

function ensureComponentMatrix(
  matrix: number[][] | undefined,
  dim: number,
  components: number,
  options?: ComponentMatrixOptions,
) {
  if (matrix) {
    validateMatrix(matrix, dim, components, 'custom component matrix');
    return { version: options?.version ?? 'custom', weights: matrix };
  }
  return loadComponentMatrix(dim, components, options);
}

function resizeVector(vec: number[], dimension: number): number[] {
  const result = new Array(dimension).fill(0);
  for (let i = 0; i < dimension; i += 1) {
    result[i] = vec[i] ?? 0;
  }
  return result;
}

function computeStats(vectors: number[][]) {
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  const variance = new Array(dim).fill(0);

  vectors.forEach((vec) => {
    for (let i = 0; i < dim; i += 1) {
      mean[i] += vec[i];
    }
  });

  for (let i = 0; i < dim; i += 1) {
    mean[i] /= vectors.length;
  }

  vectors.forEach((vec) => {
    for (let i = 0; i < dim; i += 1) {
      const diff = vec[i] - mean[i];
      variance[i] += diff * diff;
    }
  });

  for (let i = 0; i < dim; i += 1) {
    variance[i] = Math.sqrt(variance[i] / (vectors.length - 1 || 1));
  }

  return { mean, variance };
}

function applyComponentMatrix(vectors: number[][], matrix: number[][], epsilon: number): number[][] {
  const dim = vectors[0].length;
  return matrix.map((weights) => {
    const component = new Array(dim).fill(0);
    vectors.forEach((vec) => {
      for (let i = 0; i < dim; i += 1) {
        component[i] += vec[i] * weights[i];
      }
    });
    const averaged = component.map((value) => value / vectors.length);
    return normalizeVector(averaged, epsilon);
  });
}

function normalizeVector(vec: number[], epsilon: number): number[] {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) + epsilon;
  return vec.map((value) => value / norm);
}

