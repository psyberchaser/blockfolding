import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = path.join(SCRIPT_DIR, 'ingestBlocks.js');
const ATLAS_SCRIPT = path.join(SCRIPT_DIR, 'buildAtlas.js');

interface WatchOptions {
  chains: string[];
  batchSize: number;
  intervalMs: number;
  maxFailures: number;
  env: Record<string, string>;
  atlasIntervalMs: number;
}

function parseEnvList(value?: string | null) {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseEnvNumber(value?: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(
    `[watch-ingest] Starting watcher (chains=${options.chains.join(',')} batch=${options.batchSize} interval=${options.intervalMs}ms)`,
  );
  let failureCount = 0;
  let lastAtlasBuild = 0;

  while (true) {
    const start = Date.now();
    try {
      await runIngest(ingestCommand(options), options.env);
      failureCount = 0;
      if (shouldBuildAtlas(lastAtlasBuild, options.atlasIntervalMs)) {
        await runAtlasBuild(options.env);
        lastAtlasBuild = Date.now();
      }
    } catch (error) {
      failureCount += 1;
      // eslint-disable-next-line no-console
      console.error(`[watch-ingest] Ingest failed (${failureCount}/${options.maxFailures}):`, error);
      if (failureCount >= options.maxFailures) {
        // eslint-disable-next-line no-console
        console.error('[watch-ingest] Max failures reached, exiting.');
        process.exit(1);
      }
    }
    const elapsed = Date.now() - start;
    const delay = Math.max(0, options.intervalMs - elapsed);
    if (delay > 0) {
      // eslint-disable-next-line no-console
      console.log(`[watch-ingest] Sleeping ${delay}ms before next batch.`);
      await sleep(delay);
    }
  }
}

function parseArgs(argv: string[]): WatchOptions {
  const envDefaults = {
    chains: parseEnvList(process.env.STREAM_CHAINS),
    batchSize: parseEnvNumber(process.env.STREAM_BATCH_SIZE),
    intervalMs: parseEnvNumber(process.env.STREAM_INTERVAL_MS),
    maxFailures: parseEnvNumber(process.env.STREAM_MAX_FAILURES),
    atlasIntervalMs: parseEnvNumber(process.env.STREAM_ATLAS_INTERVAL_MS),
  };
  const options: WatchOptions = {
    chains: envDefaults.chains ?? ['eth', 'avax', 'sol'],
    batchSize: envDefaults.batchSize ?? 25,
    intervalMs: envDefaults.intervalMs ?? 60_000,
    maxFailures: envDefaults.maxFailures ?? 5,
    env: {},
    atlasIntervalMs:
      process.env.STREAM_DISABLE_ATLAS === '1'
        ? 0
        : envDefaults.atlasIntervalMs ?? 15 * 60_000,
  };
  argv.forEach((token) => {
    if (token.startsWith('--chains=')) {
      options.chains = token
        .slice('--chains='.length)
        .split(',')
        .map((chain) => chain.trim())
        .filter(Boolean);
    } else if (token.startsWith('--batch=')) {
      options.batchSize = Number.parseInt(token.slice('--batch='.length), 10);
    } else if (token.startsWith('--interval=')) {
      options.intervalMs = Number.parseInt(token.slice('--interval='.length), 10);
    } else if (token.startsWith('--max-failures=')) {
      options.maxFailures = Number.parseInt(token.slice('--max-failures='.length), 10);
    } else if (token.startsWith('--atlas-interval=')) {
      options.atlasIntervalMs = Number.parseInt(token.slice('--atlas-interval='.length), 10);
    } else if (token.startsWith('--env=')) {
      token
        .slice('--env='.length)
        .split(',')
        .forEach((entry) => {
          const [key, value] = entry.split('=');
          if (key && value) {
            options.env[key] = value;
          }
        });
    }
  });
  return options;
}

function ingestCommand(options: WatchOptions) {
  return ['node', INGEST_SCRIPT, `--chains=${options.chains.join(',')}`, `--count=${options.batchSize}`];
}

function runIngest(args: string[], env: Record<string, string>) {
  return spawnAndWait('[watch-ingest] Ingest', args, env);
}

async function runAtlasBuild(env: Record<string, string>) {
  if (env.ATLAS_DISABLED === '1') {
    // eslint-disable-next-line no-console
    console.log('[watch-ingest] Skipping atlas build (ATLAS_DISABLED=1).');
    return;
  }
  await spawnAndWait('[watch-ingest] Atlas', ['node', ATLAS_SCRIPT], env);
}

function spawnAndWait(label: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // eslint-disable-next-line no-console
    console.log(`${label}: ${args.join(' ')}`);
    const child = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.once('error', (error) => rejectPromise(error));
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${label} exited with code ${code}`));
      }
    });
  });
}

function shouldBuildAtlas(lastBuild: number, intervalMs: number) {
  if (intervalMs <= 0) {
    return false;
  }
  if (lastBuild === 0) {
    return true;
  }
  return Date.now() - lastBuild >= intervalMs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}

