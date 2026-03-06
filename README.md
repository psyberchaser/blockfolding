# Blockfolding

Pattern-based block compression and validator architecture.
USPTO Patent Application 63/906,240

## Prerequisites

- Node.js 22+
- npm
- An Ethereum RPC endpoint (Infura, Alchemy, or public)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and add your RPC URL

# 3. Build TypeScript
npm run build

# 4. Start the API server (port 8080)
node dist/api/server.js

# 5. In a separate terminal, start the validator UI (port 3000)
cd validator-ui && npm install && npx vite --port 3000
```

Open http://localhost:3000 to access the dashboard.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run ingest` | Ingest blocks from RPC |
| `npm run ingest:watch` | Live ingestion (follows chain head) |
| `npm run codebook:train` | Train a PQ codebook from ingested blocks |
| `npm run pipeline` | Run the full folding pipeline |
| `npm run metrics:backfill` | Backfill telemetry metrics from existing blocks |
| `npm run atlas:build` | Build the block atlas graph |
| `npm test` | Run tests |

## Docker

```bash
docker build -t blockfolding .
docker run -p 8080:8080 -v $(pwd)/artifacts:/app/artifacts blockfolding
```

## Project Structure

```
api/            Express server (block ingestion, signals, validation endpoints)
folding/        Core block folding algorithm (vectorize, fold, PQ encode)
analytics/      Block analysis (hotzones, hypergraph, semantic tags, anomaly scoring)
validator/      Patent validation architecture (8D features, meta-blocks, pattern matching)
validator-ui/   React 19 + Vite + Tailwind dashboard
ml/             Signal computation (drift, entropy, predictions, early alpha)
scripts/        CLI tools for ingestion, codebook training, pipeline
shared/         Shared utilities (DB helpers, dashboard lib)
zk/             Zero-knowledge proving (Halo2 backend, witness builder)
halo2/          Rust Halo2 ZK circuits (optional, uses mock backend if not built)
artifacts/      Runtime data directory (codebooks, databases, block artifacts)
```

## Architecture

1. **Ingestion** - Fetches blocks from EVM RPC, converts to normalized `RawBlock` format
2. **Vectorization** - Extracts 16-dim transaction vectors, 12-dim state vectors, 8-dim witness vectors
3. **Folding** - PCA-like compression to 16-dim folded output per block
4. **Product Quantization** - Encodes folded vectors into compact PQ codes with codebook
5. **Hotzones** - Kernel density estimation identifies behavioral clusters (top 16)
6. **Semantic Tags** - Derives behavioral labels (HIGH_VALUE, DEX_ACTIVITY, MEV, etc.)
7. **Validation** - 8D feature extraction enables pattern-based block validation on any device
8. **Meta-blocks** - Groups of ~90 blocks compressed into pattern signatures for storage reduction

## Optional: Halo2 ZK Proving

```bash
# Requires Rust nightly
npm run halo2:build
# Set HALO2_VERIFIER_BIN in .env
```

Without Halo2, the system uses a mock ZK backend for development.
