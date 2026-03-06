import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { computeFoldedBlock } from '../folding/compute.js';
import { loadCodebookFromFile } from '../folding/codebook.js';
import type { RawBlock } from '../folding/types.js';

interface CliOptions {
  rawPath: string;
  codebookPath: string;
  outputPath?: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(options.rawPath, 'utf-8')) as RawBlock;
  const codebook = loadCodebookFromFile(options.codebookPath);
  const artifact = computeFoldedBlock(raw, codebook);
  const payload = {
    foldedVectors: artifact.foldedBlock.foldedVectors,
    pqIndices: artifact.pqCode.indices,
    pqResiduals: artifact.pqCode.residuals ?? [],
    commitments: artifact.commitments,
  };
  if (options.outputPath) {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, JSON.stringify(payload, null, 2), 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`Saved PQ encoding to ${options.outputPath}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
  }
}

function parseArgs(argv: string[]): CliOptions {
  let rawPath = '';
  let codebookPath = '';
  let outputPath: string | undefined;
  argv.forEach((token) => {
    if (token.startsWith('--raw=')) {
      rawPath = token.slice('--raw='.length);
    } else if (token.startsWith('--codebook=')) {
      codebookPath = token.slice('--codebook='.length);
    } else if (token.startsWith('--out=')) {
      outputPath = token.slice('--out='.length);
    }
  });
  if (!rawPath || !codebookPath) {
    throw new Error('Usage: node scripts/pqEncode.js --raw=path/to/raw-block.json --codebook=path/to/codebook.json [--out=path]');
  }
  return {
    rawPath: resolve(rawPath),
    codebookPath: resolve(codebookPath),
    outputPath: outputPath ? resolve(outputPath) : undefined,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}

