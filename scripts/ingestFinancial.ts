import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { computeFoldedBlock } from '../folding/compute.js';
import { detectHotzones } from '../analytics/hotzones.js';
import { buildHypergraph } from '../analytics/hypergraph.js';
import { deriveRawBlockTags } from '../analytics/tags.js';
import { hashCodebookRoot } from '../folding/commit.js';
import { createHalo2Backend } from '../zk/halo2Backend.js';
import { proveFoldedBlock, type ZkBackend } from '../zk/witnessBuilder.js';
import type { RawBlock, PQCodebook } from '../folding/types.js';
import { financialAdapters, AdapterName } from '../financial/adapters/index.js';
import { loadCodebookFromFile } from '../folding/codebook.js';

interface CliOptions {
  adapter: AdapterName;
  input: string;
  height?: number;
  timestamp?: number;
  codebookPath?: string;
  tags: string[];
}

interface Halo2Context {
  backend: ZkBackend;
  provingKeyPath: string;
  verificationKeyPath: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adapter = financialAdapters[options.adapter];
  if (!adapter) {
    throw new Error(`Unknown adapter "${options.adapter}"`);
  }

  const inputData = JSON.parse(readFileSync(options.input, 'utf-8'));
  const rawBlock = adapter.toRawBlock(inputData, {
    height: options.height,
    timestamp: options.timestamp,
  });

  const codebook = loadActiveCodebook(options.codebookPath);
  const codebookRoot = hashCodebookRoot(codebook);
  const halo2 = createHalo2Context();
  const summary = await computeSummary(rawBlock, options.adapter, codebook, codebookRoot, options.tags, halo2);
  const paths = writeArtifacts(adapter.source, rawBlock.header.height, rawBlock);
  saveSummary(paths.summaryPath, summary);
  saveHotzones(paths.hotzonesPath, summary.hotzones, summary.hypergraph);
  saveProof(paths.proofPath, summary.proofHex);
  appendTrainingVectors(adapter.source, rawBlock.header.height, summary.foldedBlock.foldedVectors);
  insertRecord(
    initDatabase(),
    {
      chain: adapter.source,
      height: rawBlock.header.height,
      blockHash: summary.commitments.foldedCommitment,
      timestamp: rawBlock.header.timestamp ?? Date.now() / 1000,
      blockPath: paths.blockPath,
      summaryPath: paths.summaryPath,
      hotzonesPath: paths.hotzonesPath,
      proofPath: paths.proofPath,
      tags: summary.semanticTags,
    },
  );
  // eslint-disable-next-line no-console
  console.log(`[financial] Stored ${adapter.source} block ${rawBlock.header.height} (commit=${summary.commitments.foldedCommitment.slice(0, 12)}...)`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    adapter: 'equities',
    input: '',
    tags: [],
  };
  argv.forEach((token) => {
    if (token.startsWith('--adapter=')) {
      options.adapter = token.slice('--adapter='.length) as AdapterName;
    } else if (token.startsWith('--input=')) {
      options.input = resolve(token.slice('--input='.length));
    } else if (token.startsWith('--height=')) {
      options.height = Number.parseInt(token.slice('--height='.length), 10);
    } else if (token.startsWith('--timestamp=')) {
      options.timestamp = Number.parseInt(token.slice('--timestamp='.length), 10);
    } else if (token.startsWith('--codebook=')) {
      options.codebookPath = resolve(token.slice('--codebook='.length));
    } else if (token.startsWith('--tags=')) {
      options.tags = token
        .slice('--tags='.length)
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    }
  });
  if (!options.input) {
    throw new Error('--input=<file> is required');
  }
  return options;
}

function loadActiveCodebook(path?: string): PQCodebook {
  const candidate = path ?? process.env.CODEBOOK_PATH ?? resolve('artifacts', 'codebooks', 'latest.json');
  if (!existsSync(candidate)) {
    throw new Error(`Codebook file not found at ${candidate}. Run npm run codebook:train first.`);
  }
  // eslint-disable-next-line no-console
  console.log(`[financial] Loading codebook ${candidate}`);
  const artifact = loadCodebookFromFile(candidate);
  return artifact;
}

function createHalo2Context(): Halo2Context {
  const proverCommand = process.env.HALO2_PROVER_BIN ?? resolve('halo2', 'target', 'release', 'prover');
  const verifierCommand = process.env.HALO2_VERIFIER_BIN ?? resolve('halo2', 'target', 'release', 'verifier');
  const provingKeyPath = process.env.HALO2_PK_PATH ?? resolve('artifacts', 'halo2-proving.json');
  const verificationKeyPath = process.env.HALO2_VK_PATH ?? resolve('artifacts', 'halo2-verifier.json');
  const workspaceDir = process.env.HALO2_WORKSPACE ?? resolve('artifacts', 'halo2-workspace');
  const timeoutMs = process.env.HALO2_TIMEOUT_MS
    ? Number.parseInt(process.env.HALO2_TIMEOUT_MS, 10)
    : 600_000;

  mkdirSync(dirname(provingKeyPath), { recursive: true });
  mkdirSync(dirname(verificationKeyPath), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const backend = createHalo2Backend({
    proverCommand,
    verifierCommand,
    workspaceDir,
    timeoutMs,
  });

  return {
    backend,
    provingKeyPath,
    verificationKeyPath,
  };
}

async function computeSummary(
  rawBlock: RawBlock,
  source: string,
  codebook: PQCodebook,
  codebookRoot: string,
  extraTags: string[],
  halo2: Halo2Context,
) {
  const artifact = computeFoldedBlock(rawBlock, codebook);
  const rawTags = deriveRawBlockTags(rawBlock);
  const hotzoneCap = Number.isFinite(Number(process.env.HOTZONE_LIMIT))
    ? Number(process.env.HOTZONE_LIMIT)
    : 18;
  const hotzones = detectHotzones(artifact.pqCode, codebook, {
    maxZones: hotzoneCap,
    contextTags: [...rawTags, ...extraTags],
  });
  const hypergraph = buildHypergraph(hotzones, {
    densityThreshold: 5e-5,
    maxEdgeSize: 4,
  });
  const semanticTags = Array.from(new Set([...rawTags, ...extraTags, source.toUpperCase()]));
  const params = {
    provingKeyPath: halo2.provingKeyPath,
    verificationKeyPath: halo2.verificationKeyPath,
    curve: 'bn254' as const,
    backend: 'halo2' as const,
    codebookRoot,
  };
  const proof = await proveFoldedBlock(rawBlock, artifact, codebook, params, halo2.backend);
  return {
    codebookRoot,
    commitments: artifact.commitments,
    foldedBlock: artifact.foldedBlock,
    pqCode: artifact.pqCode,
    hotzones,
    hypergraph,
    rawTags,
    semanticTags,
    publicInputs: proof.publicInputs,
    proofHex: Buffer.from(proof.proofBytes).toString('hex'),
  };
}

function writeArtifacts(source: string, height: number, rawBlock: RawBlock) {
  const dir = resolve('artifacts', 'blocks', source, `${height}`);
  mkdirSync(dir, { recursive: true });
  const blockPath = join(dir, 'raw-block.json');
  const summaryPath = join(dir, 'summary.json');
  const hotzonesPath = join(dir, 'hotzones.json');
  const proofPath = join(dir, 'proof.json');
  writeFileSync(blockPath, JSON.stringify(rawBlock, null, 2), 'utf-8');
  return { blockPath, summaryPath, hotzonesPath, proofPath };
}

function saveSummary(path: string, summary: Record<string, unknown>) {
  writeFileSync(path, JSON.stringify(summary, null, 2), 'utf-8');
}

function saveHotzones(path: string, hotzones: unknown, hypergraph: unknown) {
  writeFileSync(path, JSON.stringify({ hotzones, hypergraph }, null, 2), 'utf-8');
}

function saveProof(path: string, proofHex: string) {
  writeFileSync(path, JSON.stringify({ proofHex }, null, 2), 'utf-8');
}

function appendTrainingVectors(source: string, height: number, vectors: number[][]) {
  const trainingDir = resolve('artifacts', 'training');
  mkdirSync(trainingDir, { recursive: true });
  const filePath = join(trainingDir, 'foldedVectors.jsonl');
  const entry = JSON.stringify({ chain: source, height, vectors });
  appendFileSync(filePath, `${entry}\n`, 'utf-8');
}

function initDatabase() {
  const dbPath = resolve('artifacts', 'index.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_summaries (
      chain TEXT NOT NULL,
      height INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      block_path TEXT NOT NULL,
      summary_path TEXT NOT NULL,
      hotzones_path TEXT NOT NULL,
      proof_path TEXT NOT NULL,
      tags TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain, height)
    );
  `);
  return db;
}

function insertRecord(
  db: Database.Database,
  record: {
    chain: string;
    height: number;
    blockHash: string;
    timestamp: number;
    blockPath: string;
    summaryPath: string;
    hotzonesPath: string;
    proofPath: string;
    tags?: string[];
  },
) {
  const stmt = db.prepare(
    `
    INSERT INTO block_summaries (chain, height, block_hash, timestamp, block_path, summary_path, hotzones_path, proof_path, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );
  stmt.run(
    record.chain,
    record.height,
    record.blockHash,
    record.timestamp,
    record.blockPath,
    record.summaryPath,
    record.hotzonesPath,
    record.proofPath,
    JSON.stringify(record.tags ?? []),
  );
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Financial ingest failed:', error);
    process.exitCode = 1;
  });
}

