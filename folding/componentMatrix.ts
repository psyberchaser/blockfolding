import { readFileSync } from 'node:fs';

export interface ComponentMatrix {
  version: string;
  weights: number[][];
}

export interface ComponentMatrixOptions {
  version?: string;
  path?: string;
}

export function loadComponentMatrix(
  dimension: number,
  components: number,
  options: ComponentMatrixOptions = {},
): ComponentMatrix {
  if (options.path) {
    return loadFromPath(options.path, dimension, components);
  }
  return {
    version: options.version ?? `dct-v1-${components}x${dimension}`,
    weights: buildDeterministicDctMatrix(dimension, components),
  };
}

function loadFromPath(path: string, dimension: number, components: number): ComponentMatrix {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as ComponentMatrix;
  validateMatrix(raw.weights, dimension, components, path);
  return raw;
}

export function buildDeterministicDctMatrix(dimension: number, components: number): number[][] {
  const matrix: number[][] = [];
  for (let k = 0; k < components; k += 1) {
    const row: number[] = [];
    const alpha = k === 0 ? Math.sqrt(1 / dimension) : Math.sqrt(2 / dimension);
    for (let n = 0; n < dimension; n += 1) {
      const value = alpha * Math.cos(((Math.PI * (2 * n + 1) * k) / (2 * dimension)));
      row.push(value);
    }
    matrix.push(row);
  }
  return matrix;
}

export function validateMatrix(
  matrix: number[][],
  dimension: number,
  components: number,
  label = 'component matrix',
): void {
  if (matrix.length !== components) {
    throw new Error(`${label}: expected ${components} rows, found ${matrix.length}`);
  }
  matrix.forEach((row, rowIdx) => {
    if (row.length !== dimension) {
      throw new Error(`${label}: row ${rowIdx} expected length ${dimension}, found ${row.length}`);
    }
  });
}

