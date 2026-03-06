import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve('..', 'artifacts');
const PREDICTIONS_DIR = path.join(DATA_DIR, 'mempool', 'predictions');

export interface PredictionSignal {
  chain: string;
  tags: string[];
  confidence: number;
  etaSeconds: number;
  reasons: string[];
  generatedAt: number;
}

export function readLatestPredictions(): PredictionSignal[] {
  if (!existsSync(PREDICTIONS_DIR)) return [];
  return readdirSync(PREDICTIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) =>
      JSON.parse(readFileSync(path.join(PREDICTIONS_DIR, file), 'utf-8')) as PredictionSignal,
    )
    .sort((a, b) => b.generatedAt - a.generatedAt);
}










