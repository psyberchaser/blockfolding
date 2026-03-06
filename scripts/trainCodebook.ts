import { createReadStream, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname, basename } from 'node:path';
import type { FoldedBlock, NormalizationStats, PQCodebook } from '../folding/types.js';
import {
  createDeterministicCodebook,
  saveCodebookToFile,
} from '../folding/codebook.js';
import { createSeededRandom } from '../utils/random.js';
import { hashCodebookRoot } from '../folding/commit.js';
import { computeNormalizationStats, normalizeVectors } from '../folding/normalization.js';
import { pqEncode } from '../folding/pq.js';
import { summarizeResiduals } from '../analytics/residuals.js';

const MAX_RESIDUAL_SAMPLES = 100_000;

interface TrainOptions {
  input: string;
  output: string;
  numSubspaces: number;
  subvectorDim: number;
  numCentroids: number;
  iterations: number;
  seed: string;
}

interface TrainingMetadata extends Record<string, unknown> {
  totalVectors: number;
  usableVectors: number;
  numBlocks: number;
  chains: Record<string, number>;
  params: Omit<TrainOptions, 'input' | 'output'>;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { vectors, metadata } = await loadVectors(options);
  if (vectors.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('No vectors found in training corpus. Falling back to seeded codebook.');
    const fallback = createDeterministicCodebook({
      numSubspaces: options.numSubspaces,
      subvectorDim: options.subvectorDim,
      numCentroids: options.numCentroids,
      seed: options.seed,
    });
    saveCodebookToFile(options.output, fallback, metadata);
    const fallbackRoot = hashCodebookRoot(fallback);
    updateManifest(options.output, fallbackRoot, metadata);
    // eslint-disable-next-line no-console
    console.log(`Saved fallback codebook to ${options.output}`);
    return;
  }

  const codebook = trainCodebookFromVectors(vectors, options);
  const normalization = computeNormalizationStats(
    vectors,
    options.numSubspaces * options.subvectorDim,
  );
  const codebookWithNormalization: PQCodebook = {
    ...codebook,
    normalization,
  };
  const residualStats = measureResidualStats(codebookWithNormalization, vectors);
  const errorBound = Math.max(0.01, residualStats.p95 || 0.25);
  const enrichedCodebook: PQCodebook = {
    ...codebookWithNormalization,
    errorBound,
  };
  const enrichedMetadata = {
    ...metadata,
    normalization,
    errorBound,
    residualStats,
  };
  saveCodebookToFile(options.output, enrichedCodebook, enrichedMetadata);
  const root = hashCodebookRoot(enrichedCodebook);
  updateManifest(options.output, root, enrichedMetadata);
  // eslint-disable-next-line no-console
  console.log(
    `Saved trained codebook (${options.numSubspaces}x${options.subvectorDim} · ${options.numCentroids}) to ${options.output} (root ${root.slice(
      0,
      12,
    )}...)`,
  );
}

function parseArgs(argv: string[]): TrainOptions {
  const options: TrainOptions = {
    input: 'artifacts/training/foldedVectors.jsonl',
    output: 'artifacts/codebooks/latest.json',
    numSubspaces: 4,
    subvectorDim: 4,
    numCentroids: 64,
    iterations: 25,
    seed: 'trained-codebook',
  };

  argv.forEach((token) => {
    if (token.startsWith('--input=')) {
      options.input = token.slice('--input='.length);
    } else if (token.startsWith('--output=')) {
      options.output = token.slice('--output='.length);
    } else if (token.startsWith('--subspaces=')) {
      options.numSubspaces = Number.parseInt(token.slice('--subspaces='.length), 10);
    } else if (token.startsWith('--subvector-dim=')) {
      options.subvectorDim = Number.parseInt(token.slice('--subvector-dim='.length), 10);
    } else if (token.startsWith('--centroids=')) {
      options.numCentroids = Number.parseInt(token.slice('--centroids='.length), 10);
    } else if (token.startsWith('--iterations=')) {
      options.iterations = Number.parseInt(token.slice('--iterations='.length), 10);
    } else if (token.startsWith('--seed=')) {
      options.seed = token.slice('--seed='.length);
    }
  });

  options.input = resolve(options.input);
  options.output = resolve(options.output);
  mkdirp(dirname(options.output));

  return options;
}

async function loadVectors(options: TrainOptions): Promise<{
  vectors: number[][];
  metadata: TrainingMetadata;
}> {
  const rl = createInterface({
    input: createReadStream(options.input, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const vectors: number[][] = [];
  const requiredDim = options.numSubspaces * options.subvectorDim;
  const chains: Record<string, number> = {};
  const blockSet = new Set<string>();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry.chain === 'string' && entry.height !== undefined) {
        const key = `${entry.chain}:${entry.height}`;
        blockSet.add(key);
        chains[entry.chain] = (chains[entry.chain] ?? 0) + 1;
      }
      const list = Array.isArray(entry.vectors) ? entry.vectors : [];
      list.forEach((vector: unknown) => {
        if (Array.isArray(vector) && vector.length >= requiredDim) {
          vectors.push(vector.map((value) => Number(value) || 0));
        }
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Failed to parse training line:', error);
    }
  }

  const metadata: TrainingMetadata = {
    totalVectors: vectors.length,
    usableVectors: vectors.length,
    numBlocks: blockSet.size,
    chains,
    params: {
      numSubspaces: options.numSubspaces,
      subvectorDim: options.subvectorDim,
      numCentroids: options.numCentroids,
      iterations: options.iterations,
      seed: options.seed,
    },
  };

  return { vectors, metadata };
}

function trainCodebookFromVectors(vectors: number[][], options: TrainOptions): PQCodebook {
  const requiredDim = options.numSubspaces * options.subvectorDim;
  const filtered = vectors.filter((vector) => vector.length >= requiredDim);
  if (filtered.length === 0) {
    return createDeterministicCodebook({
      numSubspaces: options.numSubspaces,
      subvectorDim: options.subvectorDim,
      numCentroids: options.numCentroids,
      seed: options.seed,
    });
  }

  const subspaceData: number[][][] = Array.from({ length: options.numSubspaces }, () => []);
  filtered.forEach((vector) => {
    for (let subspace = 0; subspace < options.numSubspaces; subspace += 1) {
      const start = subspace * options.subvectorDim;
      const slice = vector.slice(start, start + options.subvectorDim);
      if (slice.length === options.subvectorDim) {
        subspaceData[subspace].push(slice);
      }
    }
  });

  const centroids = subspaceData.map((data, subspaceIdx) =>
    kmeans(
      data,
      options.numCentroids,
      options.subvectorDim,
      options.iterations,
      `${options.seed}-${subspaceIdx}`,
    ),
  );

  return {
    centroids,
    subvectorDim: options.subvectorDim,
    numCentroids: options.numCentroids,
    numSubspaces: options.numSubspaces,
  };
}

function measureResidualStats(codebook: PQCodebook, vectors: number[][]) {
  if (!vectors.length) {
    return summarizeResiduals([]);
  }
  const sampleSize = Math.min(MAX_RESIDUAL_SAMPLES, vectors.length);
  const sample = vectors.slice(0, sampleSize);
  const normalized = normalizeVectors(sample, codebook.normalization);
  const block: FoldedBlock = {
    foldedVectors: normalized,
    metadata: {
      blockHeight: 0,
      txCount: sampleSize,
    },
  };
  const pqResult = pqEncode(block, codebook, { errorBound: 0, strict: false });
  return summarizeResiduals(pqResult.residuals ?? []);
}

function kmeans(
  data: number[][],
  k: number,
  dim: number,
  iterations: number,
  seed: string,
): number[][] {
  if (data.length === 0) {
    return Array.from({ length: k }, () => Array.from({ length: dim }, () => 0));
  }

  const rand = createSeededRandom(seed);
  let centroids = initializeCentroids(data, k, rand);

  for (let iter = 0; iter < iterations; iter += 1) {
    const accumulators = Array.from({ length: k }, () => ({
      sum: Array.from({ length: dim }, () => 0),
      count: 0,
    }));

    data.forEach((vector) => {
      const idx = nearestCentroid(vector, centroids);
      const acc = accumulators[idx];
      acc.count += 1;
      for (let d = 0; d < dim; d += 1) {
        acc.sum[d] += vector[d];
      }
    });

    centroids = centroids.map((centroid, idx) => {
      const acc = accumulators[idx];
      if (acc.count === 0) {
        return centroid;
      }
      return acc.sum.map((value) => value / acc.count);
    });
  }

  return centroids;
}

function initializeCentroids(data: number[][], k: number, rand: () => number): number[][] {
  const centroids: number[][] = [];
  const stride = Math.max(1, Math.floor(data.length / k));
  for (let i = 0; i < k; i += 1) {
    const idx = (i * stride) % data.length;
    centroids.push([...data[idx]]);
  }

  if (data.length < k) {
    for (let i = data.length; i < k; i += 1) {
      centroids[i] = data[0].map(() => rand() * 0.01);
    }
  }

  return centroids;
}

function nearestCentroid(vector: number[], centroids: number[][]): number {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  centroids.forEach((centroid, idx) => {
    const dist = squaredDistance(vector, centroid);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  });
  return bestIdx;
}

function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

function mkdirp(path: string) {
  mkdirSync(path, { recursive: true });
}

function updateManifest(outputPath: string, root: string, metadata: TrainingMetadata) {
  const manifestPath = resolve(dirname(outputPath), 'manifest.json');
  const entry = {
    root,
    file: basename(outputPath),
    createdAt: new Date().toISOString(),
    metadata,
  };
  let manifest: typeof entry[] = [];
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof entry[];
    } catch {
      manifest = [];
    }
  }
  manifest.unshift(entry);
  writeFileSync(manifestPath, JSON.stringify(manifest.slice(0, 25), null, 2), 'utf-8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}

