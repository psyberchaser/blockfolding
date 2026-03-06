import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname, basename, join } from 'node:path';
import { computeFoldedBlock, createDeterministicCodebook, hashCodebookRoot } from '../folding/index.js';
import { detectHotzones } from '../analytics/hotzones.js';
import { buildHypergraph } from '../analytics/hypergraph.js';
import { generateMockBlock } from '../fixtures/mockBlock.js';
import { createMockBackend } from '../zk/mockBackend.js';
import { createHalo2Backend } from '../zk/halo2Backend.js';
import { proveFoldedBlock } from '../zk/witnessBuilder.js';
import type { ZkProvingParams } from '../zk/publicInputs.js';

interface PipelineCliOptions {
  txCount: number;
  tracesPerTx: number;
  witnessBundles: number;
  blockSeed: string;
  codebookSeed: string;
  pqError: number;
  pqStrict: boolean;
  codebookSubspaces: number;
  codebookSubvectorDim: number;
  codebookCentroids: number;
  outputPath: string;
  summaryPath: string;
  hotzoneCsvPath: string;
  backend: 'mock' | 'halo2';
  halo2Prover?: string;
  halo2Verifier?: string;
  halo2Workspace?: string;
  halo2Timeout?: number;
  blockFile?: string;
}

const DEFAULT_CLI_OPTS: PipelineCliOptions = buildDefaultCliOptions();

async function main() {
  const cli = parseCliOptions(process.argv.slice(2));
  const rawBlock = cli.blockFile
    ? loadBlockFromFile(cli.blockFile)
    : generateMockBlock({
        txCount: cli.txCount,
        tracesPerTx: cli.tracesPerTx,
        witnessBundles: cli.witnessBundles,
        seed: cli.blockSeed,
      });
  const codebook = createDeterministicCodebook({
    numSubspaces: cli.codebookSubspaces,
    subvectorDim: cli.codebookSubvectorDim,
    numCentroids: cli.codebookCentroids,
    seed: cli.codebookSeed,
  });

  const artifact = computeFoldedBlock(rawBlock, codebook, {
    pq: { errorBound: cli.pqError, strict: cli.pqStrict },
  });
  const backend = buildBackend(cli);
  const codebookRoot = hashCodebookRoot(codebook);
  const provingKeyPath =
    cli.backend === 'halo2' ? resolve(process.cwd(), 'artifacts/halo2-proving.json') : 'mock.zkey';
  const verificationKeyPath =
    cli.backend === 'halo2'
      ? resolve(process.cwd(), 'artifacts/halo2-verifier.json')
      : 'mock.vkey';

  const params: ZkProvingParams = {
    provingKeyPath,
    verificationKeyPath,
    curve: 'bn254',
    backend: cli.backend,
    codebookRoot,
  };

  const proof = await proveFoldedBlock(rawBlock, artifact, codebook, params, backend);
  const hotzones = detectHotzones(artifact.pqCode, codebook, {
    maxZones: 18,
  });
  const hypergraph = buildHypergraph(hotzones, {
    densityThreshold: 5e-5,
    maxEdgeSize: 4,
  });

  const output = {
    blockHeight: rawBlock.header.height,
    txCount: rawBlock.transactions.length,
    cliOptions: cli,
    commitments: artifact.commitments,
    proof: {
      publicInputs: proof.publicInputs,
      proofLength: proof.proofBytes.length,
    },
    foldedBlock: artifact.foldedBlock,
    pqCode: artifact.pqCode,
    hotzones,
    hypergraph,
  };

  writeJson(cli.outputPath, output);
  writeJson(cli.summaryPath, buildSummary(output));
  writeHotzoneCsv(cli.hotzoneCsvPath, hotzones);

  logSummary({
    blockHeight: rawBlock.header.height,
    txCount: rawBlock.transactions.length,
    hotzoneCount: hotzones.length,
    outputPath: cli.outputPath,
    summaryPath: cli.summaryPath,
    csvPath: cli.hotzoneCsvPath,
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Pipeline failed:', error);
  process.exitCode = 1;
});

function parseCliOptions(argv: string[]): PipelineCliOptions {
  const opts = { ...DEFAULT_CLI_OPTS };
  let summaryOverridden = false;
  let csvOverridden = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inlineValue] = arg.split('=');
    const key = flag.slice(2);
    const value = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined && (value === undefined || value.startsWith('--'))) {
      throw new Error(`Missing value for flag ${flag}`);
    }
    if (inlineValue === undefined) {
      i += 1;
    }
    if (key === 'summary') summaryOverridden = true;
    if (key === 'hotzones-csv') csvOverridden = true;
    applyCliOption(opts, key, value as string);
  }
  if (!summaryOverridden) {
    opts.summaryPath = deriveSiblingPath(opts.outputPath, '-summary.json');
  }
  if (!csvOverridden) {
    opts.hotzoneCsvPath = deriveSiblingPath(opts.outputPath, '-hotzones.csv');
  }
  if (opts.backend === 'halo2') {
    opts.halo2Prover ??= resolve(process.cwd(), 'halo2/target/release/prover');
    opts.halo2Verifier ??= resolve(process.cwd(), 'halo2/target/release/verifier');
    opts.halo2Workspace ??= resolve(process.cwd(), 'artifacts/halo2-workspace');
    opts.halo2Timeout ??= 600_000;
  }
  return opts;
}

function applyCliOption(opts: PipelineCliOptions, key: string, rawValue: string) {
  const value = rawValue.trim();
  switch (key) {
    case 'tx-count':
      opts.txCount = parsePositiveInt(value, key);
      break;
    case 'traces-per-tx':
      opts.tracesPerTx = parsePositiveInt(value, key);
      break;
    case 'witness-bundles':
      opts.witnessBundles = parsePositiveInt(value, key);
      break;
    case 'block-seed':
      opts.blockSeed = value;
      break;
    case 'codebook-seed':
      opts.codebookSeed = value;
      break;
    case 'pq-error':
      opts.pqError = parseFloat(value);
      break;
    case 'pq-strict':
      opts.pqStrict = value === 'true';
      break;
    case 'codebook-subspaces':
      opts.codebookSubspaces = parsePositiveInt(value, key);
      break;
    case 'codebook-subvector-dim':
      opts.codebookSubvectorDim = parsePositiveInt(value, key);
      break;
    case 'codebook-centroids':
      opts.codebookCentroids = parsePositiveInt(value, key);
      break;
    case 'output':
      opts.outputPath = resolve(process.cwd(), value);
      break;
    case 'summary':
      opts.summaryPath = resolve(process.cwd(), value);
      break;
    case 'hotzones-csv':
      opts.hotzoneCsvPath = resolve(process.cwd(), value);
      break;
    case 'backend':
      if (value !== 'mock' && value !== 'halo2') {
        throw new Error(`Unsupported backend "${value}". Expected "mock" or "halo2".`);
      }
      opts.backend = value;
      break;
    case 'halo2-prover':
      opts.halo2Prover = value;
      break;
    case 'halo2-verifier':
      opts.halo2Verifier = value;
      break;
    case 'halo2-workspace':
      opts.halo2Workspace = resolve(process.cwd(), value);
      break;
    case 'halo2-timeout':
      opts.halo2Timeout = parsePositiveInt(value, key);
      break;
    case 'block-file':
      opts.blockFile = resolve(process.cwd(), value);
      break;
    default:
      // eslint-disable-next-line no-console
      console.warn(`Unrecognized flag --${key}, ignoring.`);
  }
}

function parsePositiveInt(value: string, key: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Flag --${key} requires a positive integer (received "${value}")`);
  }
  return parsed;
}

function logSummary(summary: { blockHeight: number; txCount: number; hotzoneCount: number; outputPath: string; summaryPath: string; csvPath: string }) {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Pipeline complete:',
      `height=${summary.blockHeight}`,
      `txs=${summary.txCount}`,
      `hotzones=${summary.hotzoneCount}`,
      `output=${summary.outputPath}`,
      `summary=${summary.summaryPath}`,
      `csv=${summary.csvPath}`,
    ].join(' '),
  );
}

function buildDefaultCliOptions(): PipelineCliOptions {
  const outputPath = resolve(process.cwd(), 'artifacts/pipeline-output.json');
  const summaryPath = deriveSiblingPath(outputPath, '-summary.json');
  const csvPath = deriveSiblingPath(outputPath, '-hotzones.csv');
  return {
    txCount: 24,
    tracesPerTx: 2,
    witnessBundles: 3,
    blockSeed: 'pipeline-demo-block',
    codebookSeed: 'pipeline-demo-codebook',
    pqError: 1.5,
    pqStrict: true,
    codebookSubspaces: 4,
    codebookSubvectorDim: 4,
    codebookCentroids: 64,
    outputPath,
    summaryPath,
    hotzoneCsvPath: csvPath,
    backend: 'mock',
  };
}

function deriveSiblingPath(basePath: string, suffix: string): string {
  const dir = dirname(basePath);
  const ext = extname(basePath);
  const name = basename(basePath, ext);
  return join(dir, `${name}${suffix}`);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function buildSummary(output: {
  blockHeight: number;
  txCount: number;
  commitments: { foldedCommitment: string; pqCommitment: string };
  hotzones: { id: string; density: number; semanticTags: string[] }[];
}): Record<string, unknown> {
  const densest = [...output.hotzones].sort((a, b) => b.density - a.density)[0];
  return {
    blockHeight: output.blockHeight,
    txCount: output.txCount,
    foldedCommitment: output.commitments.foldedCommitment,
    pqCommitment: output.commitments.pqCommitment,
    hotzoneCount: output.hotzones.length,
    densestHotzone: densest
      ? {
          id: densest.id,
          density: densest.density,
          tags: densest.semanticTags,
        }
      : null,
  };
}

function writeHotzoneCsv(path: string, hotzones: { id: string; density: number; radius: number; semanticTags: string[]; center: number[] }[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const rows = [
    ['id', 'density', 'radius', 'tags', 'center'].join(','),
    ...hotzones.map((hz) =>
      [
        hz.id,
        hz.density.toFixed(6),
        hz.radius.toFixed(6),
        `"${hz.semanticTags.join('|')}"`,
        `"${hz.center.map((value) => value.toFixed(6)).join('|')}"`,
      ].join(','),
    ),
  ];
  writeFileSync(path, rows.join('\n'), 'utf-8');
}

function loadBlockFromFile(path: string) {
  const abs = resolve(process.cwd(), path);
  const content = readFileSync(abs, 'utf-8');
  return JSON.parse(content);
}

function buildBackend(cli: PipelineCliOptions) {
  if (cli.backend === 'halo2') {
    if (!cli.halo2Prover || !cli.halo2Verifier) {
      throw new Error('Halo2 backend selected but --halo2-prover or --halo2-verifier is missing');
    }
    return createHalo2Backend({
      proverCommand: cli.halo2Prover,
      verifierCommand: cli.halo2Verifier,
      workspaceDir: cli.halo2Workspace,
      timeoutMs: cli.halo2Timeout,
    });
  }
  return createMockBackend();
}

