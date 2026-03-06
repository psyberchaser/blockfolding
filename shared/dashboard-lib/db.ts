import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Use createRequire for CommonJS modules in ESM context
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let metricsDb: any = null;

// Dynamic require to avoid build errors when better-sqlite3 isn't available (e.g., Vercel)
try {
  Database = require('better-sqlite3');
} catch {
  // better-sqlite3 not available - dashboard will use API instead
}

export function getDatabase() {
  if (db) return db;
  if (!Database) {
    throw new Error('SQLite not available. Use DATA_API_URL to fetch from API instead.');
  }
  const dataDir = process.env.DATA_DIR ?? path.resolve('..', 'artifacts');
  const dbPath = path.join(dataDir, 'index.db');
  
  // Ensure directory exists
  mkdirSync(path.dirname(dbPath), { recursive: true });
  
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return db;
}

export function getMetricsDatabase() {
  if (metricsDb) return metricsDb;
  if (!Database) {
    throw new Error('SQLite not available. Use DATA_API_URL to fetch from API instead.');
  }
  const dataDir = process.env.DATA_DIR ?? path.resolve('..', 'artifacts');
  const dbPath = path.join(dataDir, 'telemetry.db');
  
  // Ensure directory exists
  mkdirSync(path.dirname(dbPath), { recursive: true });
  
  if (!existsSync(dbPath)) {
    metricsDb = new Database(':memory:');
    metricsDb.exec(`
      CREATE TABLE IF NOT EXISTS block_metrics (
        chain TEXT NOT NULL,
        height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        hotzone_count INTEGER NOT NULL,
        peak_density REAL NOT NULL,
        avg_density REAL NOT NULL,
        tags TEXT NOT NULL
      );
    `);
    return metricsDb;
  }
  metricsDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  return metricsDb;
}
