import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { summarizeResiduals } from '../analytics/residuals.js';

interface BlockRow {
  chain: string;
  height: number;
  timestamp: number;
  summaryPath: string;
  tags: string;
}

function main() {
  const dataDir = process.env.DATA_DIR ?? path.resolve('artifacts');
  const indexDbPath = path.join(dataDir, 'index.db');
  const telemetryPath = path.join(dataDir, 'telemetry.db');

  if (!existsSync(indexDbPath)) {
    throw new Error(`index.db not found at ${indexDbPath}`);
  }

  mkdirSync(path.dirname(telemetryPath), { recursive: true });
  const sourceDb = new Database(indexDbPath, { readonly: true, fileMustExist: true });
  const metricsDb = new Database(telemetryPath);
  metricsDb.exec(`
    CREATE TABLE IF NOT EXISTS block_metrics (
      chain TEXT NOT NULL,
      height INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      hotzone_count INTEGER NOT NULL,
      peak_density REAL NOT NULL,
      avg_density REAL NOT NULL,
      tags TEXT NOT NULL,
      dex_gas_share REAL NOT NULL DEFAULT 0,
      nft_gas_share REAL NOT NULL DEFAULT 0,
      lending_volume_wei REAL NOT NULL DEFAULT 0,
      bridge_volume_wei REAL NOT NULL DEFAULT 0,
      high_fee_tx INTEGER NOT NULL DEFAULT 0,
      dex_tx_count INTEGER NOT NULL DEFAULT 0,
      nft_tx_count INTEGER NOT NULL DEFAULT 0,
      lending_tx_count INTEGER NOT NULL DEFAULT 0,
      bridge_tx_count INTEGER NOT NULL DEFAULT 0,
      dominant_flow TEXT,
      top_contracts TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain, height)
    );
  `);
  metricsDb.exec(`
    CREATE TABLE IF NOT EXISTS hotzone_samples (
      chain TEXT NOT NULL,
      height INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      hotzone_id TEXT NOT NULL,
      density REAL NOT NULL,
      radius REAL NOT NULL,
      vector TEXT NOT NULL,
      tags TEXT NOT NULL
    );
  `);
  metricsDb.exec(`
    CREATE TABLE IF NOT EXISTS pq_residual_samples (
      chain TEXT NOT NULL,
      height INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      vector_index INTEGER NOT NULL,
      residual REAL NOT NULL
    );
  `);
  ensureBehaviorColumns(metricsDb);

  const rows = sourceDb
    .prepare(`
    SELECT chain, height, timestamp, summary_path as summaryPath, tags
    FROM block_summaries
    ORDER BY timestamp ASC
  `)
    .all() as BlockRow[];

  const insert = metricsDb.prepare(`
    INSERT OR REPLACE INTO block_metrics (
      chain,
      height,
      timestamp,
      hotzone_count,
      peak_density,
      avg_density,
      tags,
      dex_gas_share,
      nft_gas_share,
      lending_volume_wei,
      bridge_volume_wei,
      high_fee_tx,
      dex_tx_count,
      nft_tx_count,
      lending_tx_count,
      bridge_tx_count,
      dominant_flow,
      top_contracts,
      pq_error_avg,
      pq_error_max,
      pq_error_p95
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  rows.forEach((row) => {
    try {
      const summary = JSON.parse(readFileSync(row.summaryPath, 'utf-8'));
      const hotzones = Array.isArray(summary.hotzones) ? summary.hotzones : [];
      const peakDensity = hotzones.reduce(
        (acc: number, hz: any) => Math.max(acc, Number(hz?.density ?? 0)),
        0,
      );
      const avgDensity =
        hotzones.length > 0
          ? hotzones.reduce((acc: number, hz: any) => acc + Number(hz?.density ?? 0), 0) /
            hotzones.length
          : 0;
      const tags = summary.semanticTags ?? safeParseTags(row.tags);
      const timestampSeconds = normalizeTimestamp(row.timestamp);
      const residualValues = extractResidualValues(summary);
      const residualStats = summarizeResiduals(residualValues);
      const behavior = normalizeBehaviorMetrics(summary.behaviorMetrics);
      insert.run(
        row.chain,
        row.height,
        timestampSeconds,
        hotzones.length,
        peakDensity,
        avgDensity,
        JSON.stringify(Array.from(new Set(tags ?? []))),
        behavior.dexGasShare,
        behavior.nftGasShare,
        behavior.lendingVolumeWei,
        behavior.bridgeVolumeWei,
        behavior.highFeeTxCount,
        behavior.dexTxCount,
        behavior.nftTxCount,
        behavior.lendingTxCount,
        behavior.bridgeTxCount,
        behavior.dominantFlow ?? null,
        JSON.stringify(behavior.topContracts ?? []),
        residualStats.average,
        residualStats.max,
        residualStats.p95,
      );
      const hotzoneStmt = metricsDb.prepare(
        `
        INSERT INTO hotzone_samples (chain, height, timestamp, hotzone_id, density, radius, vector, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      hotzones.forEach((hotzone: any, index: number) => {
        hotzoneStmt.run(
          row.chain,
          row.height,
          timestampSeconds,
          hotzone.id ?? `hotzone-${index}`,
          Number(hotzone.density ?? 0),
          Number(hotzone.radius ?? 0),
          JSON.stringify(hotzone.center ?? []),
          JSON.stringify(hotzone.semanticTags ?? []),
        );
      });
      if (residualValues.length > 0) {
        const residualStmt = metricsDb.prepare(
          `
          INSERT INTO pq_residual_samples (chain, height, timestamp, vector_index, residual)
          VALUES (?, ?, ?, ?, ?)
        `,
        );
        residualValues.forEach((value, index) => {
          residualStmt.run(row.chain, row.height, timestampSeconds, index, Number(value ?? 0));
        });
      }
      inserted += 1;
    } catch (error) {
      console.warn(`Failed to backfill block ${row.chain} #${row.height}:`, error);
    }
  });

  console.log(`Backfilled telemetry for ${inserted} blocks into ${telemetryPath}`);
  sourceDb.close();
  metricsDb.close();
}

function ensureBehaviorColumns(db: Database.Database) {
  const statements = [
    "ALTER TABLE block_metrics ADD COLUMN dex_gas_share REAL NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN nft_gas_share REAL NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN lending_volume_wei REAL NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN bridge_volume_wei REAL NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN high_fee_tx INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN dex_tx_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN nft_tx_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN lending_tx_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN bridge_tx_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN dominant_flow TEXT;",
    "ALTER TABLE block_metrics ADD COLUMN top_contracts TEXT NOT NULL DEFAULT '[]';",
    "ALTER TABLE block_metrics ADD COLUMN pq_error_avg REAL NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN pq_error_max REAL NOT NULL DEFAULT 0;",
    "ALTER TABLE block_metrics ADD COLUMN pq_error_p95 REAL NOT NULL DEFAULT 0;",
  ];
  statements.forEach((sql) => {
    try {
      db.exec(sql);
    } catch {
      // column exists
    }
  });
}

function normalizeBehaviorMetrics(raw: any) {
  return {
    dexGasShare: Number(raw?.dexGasShare ?? 0),
    nftGasShare: Number(raw?.nftGasShare ?? 0),
    lendingVolumeWei: Number(raw?.lendingVolumeWei ?? 0),
    bridgeVolumeWei: Number(raw?.bridgeVolumeWei ?? 0),
    highFeeTxCount: Number(raw?.highFeeTxCount ?? 0),
    dexTxCount: Number(raw?.dexTxCount ?? 0),
    nftTxCount: Number(raw?.nftTxCount ?? 0),
    lendingTxCount: Number(raw?.lendingTxCount ?? 0),
    bridgeTxCount: Number(raw?.bridgeTxCount ?? 0),
    dominantFlow: typeof raw?.dominantFlow === 'string' ? raw.dominantFlow : null,
    topContracts: Array.isArray(raw?.topContracts) ? raw.topContracts : [],
  };
}

function extractResidualValues(summary: any): number[] {
  if (!summary) return [];
  if (Array.isArray(summary.pqResiduals)) {
    return summary.pqResiduals.map((value: unknown) => Number(value ?? 0));
  }
  if (Array.isArray(summary.pqResiduals?.values)) {
    return summary.pqResiduals.values.map((value: unknown) => Number(value ?? 0));
  }
  if (Array.isArray(summary.pqCode?.residuals)) {
    return summary.pqCode.residuals.map((value: unknown) => Number(value ?? 0));
  }
  return [];
}

function safeParseTags(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeTimestamp(value: number | string) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    if (value.startsWith('0x')) {
      return parseInt(value, 16);
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }
  }
  return Math.floor(Date.now() / 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

