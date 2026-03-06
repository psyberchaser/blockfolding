import { Hotzone, Hypergraph } from './types.js';

export interface HypergraphOptions {
  densityThreshold?: number;
  maxEdgeSize?: number;
}

const DEFAULT_OPTIONS: Required<HypergraphOptions> = {
  densityThreshold: 5e-5,
  maxEdgeSize: 4,
};

export function buildHypergraph(hotzones: Hotzone[], options: HypergraphOptions = {}): Hypergraph {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const hyperedges: Hypergraph['hyperedges'] = [];

  for (let i = 0; i < hotzones.length; i += 1) {
    for (let j = i + 1; j < hotzones.length; j += 1) {
      const weight = computeWeight(hotzones[i], hotzones[j]);
      if (weight >= opts.densityThreshold) {
        hyperedges.push({ nodes: [i, j], weight });
      }
    }
  }

  // Optionally add triples for densely connected clusters
  if (opts.maxEdgeSize >= 3) {
    for (let i = 0; i < hotzones.length; i += 1) {
      for (let j = i + 1; j < hotzones.length; j += 1) {
        for (let k = j + 1; k < hotzones.length; k += 1) {
          const weight = (computeWeight(hotzones[i], hotzones[j]) +
            computeWeight(hotzones[j], hotzones[k]) +
            computeWeight(hotzones[i], hotzones[k])) / 3;
          if (weight >= opts.densityThreshold * 1.5) {
            hyperedges.push({ nodes: [i, j, k], weight });
          }
        }
      }
    }
  }

  if (opts.maxEdgeSize >= 4) {
    for (let a = 0; a < hotzones.length; a += 1) {
      for (let b = a + 1; b < hotzones.length; b += 1) {
        for (let c = b + 1; c < hotzones.length; c += 1) {
          for (let d = c + 1; d < hotzones.length; d += 1) {
            const weight =
              (computeWeight(hotzones[a], hotzones[b]) +
                computeWeight(hotzones[a], hotzones[c]) +
                computeWeight(hotzones[a], hotzones[d]) +
                computeWeight(hotzones[b], hotzones[c]) +
                computeWeight(hotzones[b], hotzones[d]) +
                computeWeight(hotzones[c], hotzones[d])) /
              6;
            if (weight >= opts.densityThreshold * 2) {
              hyperedges.push({ nodes: [a, b, c, d], weight });
            }
          }
        }
      }
    }
  }

  return { nodes: hotzones, hyperedges };
}

function computeWeight(a: Hotzone, b: Hotzone): number {
  const centerDistance = distance(a.center, b.center);
  const combinedRadius = a.radius + b.radius;
  const overlap = Math.max(0, combinedRadius - centerDistance);
  if (overlap === 0) {
    return 0;
  }
  return overlap * Math.sqrt(a.density * b.density);
}

function distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

