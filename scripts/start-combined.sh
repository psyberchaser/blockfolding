#!/bin/sh
# Start API server, ingestion, and mempool watcher in one container

echo "[start] Starting combined API + Ingestion + Mempool..."

# Start ingestion in background (with delay to let API bind port first)
(sleep 10 && echo "[start] Starting ingestion..." && node dist/scripts/watchIngest.js) &

# Start mempool watcher in background (with delay)
(sleep 15 && echo "[start] Starting mempool watcher..." && node dist/scripts/mempoolWatch.js) &

# Start API server in foreground
echo "[start] Starting API server..."
exec node dist/api/server.js
