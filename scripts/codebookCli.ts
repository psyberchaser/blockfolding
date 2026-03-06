import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createDeterministicCodebook, DeterministicCodebookParams, assertCodebookConsistency, loadCodebookFromFile, saveCodebookToFile } from '../folding/codebook.js';
import { hashCodebookRoot } from '../folding/commit.js';
import type { PQCodebook } from '../folding/types.js';

interface GenerateArgs extends DeterministicCodebookParams {
  action: 'generate';
  output: string;
  version: string;
  description?: string;
}

interface InfoArgs {
  action: 'info';
  file: string;
}

type CliArgs = GenerateArgs | InfoArgs;

interface CodebookArtifact {
  version: string;
  description?: string;
  createdAt: string;
  codebookRoot: string;
  parameters: {
    numSubspaces: number;
    subvectorDim: number;
    numCentroids: number;
    seed: string;
    scale: number;
  };
  codebook: PQCodebook;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === 'generate') {
    const artifact = generateCodebook(args);
    writeArtifact(args.output, artifact);
    // eslint-disable-next-line no-console
    console.log(
      `✅ Codebook ${artifact.version} saved to ${args.output}\nroot=${artifact.codebookRoot}`,
    );
  } else {
    const artifact = readArtifact(args.file);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(artifact, null, 2));
  }
}

function generateCodebook(args: GenerateArgs): CodebookArtifact {
  const seed = args.seed ?? 'codebook-seed';
  const scale = args.scale ?? 1;
  const codebook = createDeterministicCodebook({
    numSubspaces: args.numSubspaces,
    subvectorDim: args.subvectorDim,
    numCentroids: args.numCentroids,
    seed,
    scale,
  });
  assertCodebookConsistency(codebook);
  const codebookRoot = hashCodebookRoot(codebook);
  return {
    version: args.version,
    description: args.description,
    createdAt: new Date().toISOString(),
    codebookRoot,
    parameters: {
      numSubspaces: args.numSubspaces,
      subvectorDim: args.subvectorDim,
      numCentroids: args.numCentroids,
      seed,
      scale,
    },
    codebook,
  };
}

function writeArtifact(path: string, artifact: CodebookArtifact) {
  const abs = resolve(process.cwd(), path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(artifact, null, 2), 'utf-8');
}

function readArtifact(path: string): CodebookArtifact {
  const abs = resolve(process.cwd(), path);
  const data = readFileSync(abs, 'utf-8');
  return JSON.parse(data) as CodebookArtifact;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.split('=');
    if (inline !== undefined) {
      args[key.slice(2)] = inline;
    } else {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for flag ${key}`);
      }
      args[key.slice(2)] = value;
      i += 1;
    }
  }

  const action = args.action ?? 'generate';
  if (action === 'info') {
    if (!args.file) {
      throw new Error('info action requires --file=<path>');
    }
    return { action: 'info', file: args.file };
  }

  const required = ['output', 'version', 'num-subspaces', 'subvector-dim', 'num-centroids'];
  required.forEach((flag) => {
    if (!(flag in args)) {
      throw new Error(`Missing required flag --${flag}`);
    }
  });

  return {
    action: 'generate',
    output: args.output,
    version: args.version,
    description: args.description,
    numSubspaces: parsePositiveInt(args['num-subspaces'], 'num-subspaces'),
    subvectorDim: parsePositiveInt(args['subvector-dim'], 'subvector-dim'),
    numCentroids: parsePositiveInt(args['num-centroids'], 'num-centroids'),
    seed: args.seed ?? 'codebook-seed',
    scale: args.scale ? Number.parseFloat(args.scale) : 1,
  };
}

function parsePositiveInt(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Flag --${key} requires a positive integer (received "${value}")`);
  }
  return parsed;
}

main();

