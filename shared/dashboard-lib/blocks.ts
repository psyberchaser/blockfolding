import { getDatabase } from './db.js';
import { computeAnomalyScore } from './anomaly.js';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

type BlockSummaryRow = {
  chain: string;
  height: number;
  blockHash: string;
  timestamp: number;
  blockPath: string;
  summaryPath: string;
  hotzonesPath: string;
  proofPath: string;
  tags: string;
};

export interface StoredBlockSummary {
  chain: string;
  height: number;
  blockHash: string;
  timestamp: number;
  blockPath: string;
  summaryPath: string;
  hotzonesPath: string;
  proofPath: string;
  tags: string[];
  anomalyScore?: number;
}

export interface TagStats {
  tag: string;
  count: number;
  latest?: StoredBlockSummary | null;
}

export function getLatestBlockSummary(): StoredBlockSummary | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
    SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
           summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
           tags
    FROM block_summaries
    ORDER BY datetime(created_at) DESC
    LIMIT 1
    `,
    )
    .get() as BlockSummaryRow | undefined;
  if (!row) return null;
  return normalizeRow(row);
}

export function getBlockSummary(
  chain: string,
  height: number,
): StoredBlockSummary | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
    SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
           summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
           tags
    FROM block_summaries
    WHERE chain = ? AND height = ?
    LIMIT 1
    `,
    )
    .get(chain, height) as BlockSummaryRow | undefined;
  if (!row) return null;
  return normalizeRow(row);
}

export function listRecentBlockSummaries(
  limit = 12,
  tagFilter?: string,
  chainFilter?: string,
): StoredBlockSummary[] {
  const db = getDatabase();
  // For single chain, sort by height (always sequential)
  // For all chains, sort by created_at (ingestion time)
  const query = chainFilter
    ? `
    SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
           summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
           tags
    FROM block_summaries
    WHERE chain = ?
    ORDER BY height DESC
    LIMIT ?
    `
    : `
    SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
           summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
           tags
    FROM block_summaries
    ORDER BY datetime(created_at) DESC
    LIMIT ?
    `;
  const rows = (chainFilter
    ? db.prepare(query).all(chainFilter, limit)
    : db.prepare(query).all(limit)) as BlockSummaryRow[];
  let normalized = rows.map((row) => normalizeRow(row));
  if (tagFilter) {
    const lower = tagFilter.toLowerCase();
    normalized = normalized.filter((row) =>
      row.tags?.some((tag) => tag.toLowerCase().includes(lower)),
    );
  }
  // Compute anomaly scores for each block
  return normalized.map((block) => ({
    ...block,
    anomalyScore: computeBlockAnomalyScore(block),
  }));
}

export function searchBlockSummaries(
  query: string,
  limit = 20,
): StoredBlockSummary[] {
  if (!query.trim()) return [];
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
           summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
           tags
    FROM block_summaries
    ORDER BY datetime(created_at) DESC
    LIMIT 200
    `,
    )
    .all() as BlockSummaryRow[];
  const normalized = rows.map((row) => normalizeRow(row));
  const lower = query.toLowerCase();
  const slugged = lower.replace(/[\s\-]+/g, '_');
  const compact = lower.replace(/[\s\-_]+/g, '');
  return normalized
    .filter((row) => {
      if (row.chain.toLowerCase().includes(lower)) return true;
      if (row.blockHash.toLowerCase().includes(lower)) return true;
      if (row.height.toString().includes(lower)) return true;
      if (
        row.tags?.some((tag) => {
          const tagLower = tag.toLowerCase();
          const tagCompact = tagLower.replace(/_/g, '');
          return (
            tagLower.includes(lower) ||
            tagLower.includes(slugged) ||
            tagCompact.includes(compact)
          );
        })
      )
        return true;
      return false;
    })
    .slice(0, limit);
}

function normalizeRow(row: BlockSummaryRow): StoredBlockSummary {
  const parseTags = (() => {
    try {
      return Array.isArray(JSON.parse(row.tags))
        ? (JSON.parse(row.tags) as string[])
        : [];
    } catch {
      return [];
    }
  })();
  const baseDir = process.env.DATA_DIR ?? path.resolve('..', 'artifacts');
  return {
    chain: row.chain,
    height: Number(row.height),
    blockHash: row.blockHash,
    timestamp: Number(row.timestamp),
    blockPath: path.join(baseDir, relativeFromArtifacts(row.blockPath)),
    summaryPath: path.join(baseDir, relativeFromArtifacts(row.summaryPath)),
    hotzonesPath: path.join(baseDir, relativeFromArtifacts(row.hotzonesPath)),
    proofPath: path.join(baseDir, relativeFromArtifacts(row.proofPath)),
    tags: parseTags,
  };
}

function relativeFromArtifacts(target: string) {
  // Handle paths that already include DATA_DIR (e.g., /data/blocks/...)
  const dataDir = process.env.DATA_DIR;
  if (dataDir && target.startsWith(dataDir)) {
    return path.relative(dataDir, target);
  }
  // Handle local dev paths
  const artifactsDir = path.resolve('..', 'artifacts');
  if (target.startsWith(artifactsDir)) {
    return path.relative(artifactsDir, target);
  }
  return target;
}

function computeBlockAnomalyScore(block: StoredBlockSummary): number {
  try {
    // Try to read hotzones for more accurate scoring
    if (existsSync(block.hotzonesPath)) {
      const hotzonesData = JSON.parse(readFileSync(block.hotzonesPath, 'utf-8'));
      // Hotzones file has structure { hotzones: [...], hypergraph: ... }
      const hotzones = hotzonesData.hotzones ?? hotzonesData;
      const result = computeAnomalyScore({ hotzones, tagVector: block.tags });
      return result.score;
    }
    // Fallback: compute from tags only
    const result = computeAnomalyScore({ tagVector: block.tags });
    return result.score;
  } catch {
    return 0;
  }
}

export function getTagStats(tag: string): TagStats {
  const db = getDatabase();
  const pattern = `%\"${tag}\"%`;
  const countRow = db
    .prepare('SELECT COUNT(*) as count FROM block_summaries WHERE tags LIKE ?')
    .get(pattern) as { count?: number } | undefined;
  const latestRow = db
    .prepare(
      `
    SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
           summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
           tags
    FROM block_summaries
    WHERE tags LIKE ?
    ORDER BY height DESC
    LIMIT 1
    `,
    )
    .get(pattern) as BlockSummaryRow | undefined;
  return {
    tag,
    count: countRow?.count ?? 0,
    latest: latestRow ? normalizeRow(latestRow) : null,
  };
}

export function searchBlocksByTag(tag: string, source?: string, limit = 20): StoredBlockSummary[] {
  const db = getDatabase();
  const normalized = tag.toUpperCase();
  const pattern = `%\"${normalized}\"%`;
  const query = source
    ? `
      SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
             summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
             tags
      FROM block_summaries
      WHERE tags LIKE ? AND chain = ?
      ORDER BY height DESC
      LIMIT ?
    `
    : `
      SELECT chain, height, block_hash as blockHash, timestamp, block_path as blockPath,
             summary_path as summaryPath, hotzones_path as hotzonesPath, proof_path as proofPath,
             tags
      FROM block_summaries
      WHERE tags LIKE ?
      ORDER BY height DESC
      LIMIT ?
    `;
  const rows = (source
    ? db.prepare(query).all(pattern, source, limit)
    : db.prepare(query).all(pattern, limit)) as BlockSummaryRow[];
  return rows.map((row) => normalizeRow(row));
}

export function listSources(): string[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT DISTINCT chain FROM block_summaries ORDER BY chain ASC')
    .all() as { chain: string }[];
  return rows.map((row) => row.chain);
}


