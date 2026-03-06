import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

interface HotzoneSample {
  chain: string;
  height: number;
  timestamp: number;
  hotzoneId: string;
  density: number;
  radius: number;
  vector: number[];
  tags: string[];
}

interface Cluster {
  id: number;
  centroid: number[];
  count: number;
  densitySum: number;
  chains: Set<string>;
  tags: Map<string, number>;
  firstTimestamp: number;
  lastTimestamp: number;
  timeslices: Map<number, number>;
}

const SIMILARITY_THRESHOLD = 0.92;
const DENSITY_RATIO_THRESHOLD = 0.5;
const SLICE_SECONDS = Number(process.env.ATLAS_SLICE_SECONDS ?? 86_400);

function main() {
  const dataDir = process.env.DATA_DIR ?? path.resolve('artifacts');
  const telemetryPath = path.join(dataDir, 'telemetry.db');
  const outputDir = path.join(dataDir, 'atlas');
  const outputPath = path.join(outputDir, 'graph.json');

  let db;
  try {
    db = new Database(telemetryPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    // Database doesn't exist yet - write empty atlas and exit gracefully
    console.log('[atlas] No telemetry database found, writing empty atlas');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify({ nodes: [], edges: [], meta: { generatedAt: Date.now(), sliceSeconds: SLICE_SECONDS } }, null, 2));
    return;
  }
  const rows = db
    .prepare(`
      SELECT chain, height, timestamp, hotzone_id as hotzoneId, density, radius, vector, tags
      FROM hotzone_samples
      ORDER BY timestamp ASC
    `)
    .all() as {
      chain: string;
      height: number;
      timestamp: number;
      hotzoneId: string;
      density: number;
      radius: number;
      vector: string;
      tags: string;
    }[];

  const samples: HotzoneSample[] = rows
    .map((row) => ({
      chain: row.chain,
      height: row.height,
      timestamp: row.timestamp,
      hotzoneId: row.hotzoneId,
      density: row.density,
      radius: row.radius,
      vector: safeParseArray(row.vector),
      tags: safeParseArray(row.tags),
    }))
    .filter((sample) => sample.vector.length > 0);

  const clusters: Cluster[] = [];
  let nextClusterId = 1;
  const blockClusterMap = new Map<string, Set<number>>();

for (const sample of samples) {
  const existingCluster = assignCluster(sample, clusters);
  if (existingCluster) {
    updateCluster(existingCluster, sample);
    addBlockMembership(blockClusterMap, sample.chain, sample.height, existingCluster.id);
  } else {
    const newCluster: Cluster = {
      id: nextClusterId++,
      centroid: [...sample.vector],
      count: 1,
      densitySum: sample.density,
      chains: new Set([sample.chain]),
      tags: buildTagMap(sample.tags),
      firstTimestamp: sample.timestamp,
      lastTimestamp: sample.timestamp,
      timeslices: new Map<number, number>(),
    };
    recordTimeslice(newCluster, sample.timestamp);
    clusters.push(newCluster);
    addBlockMembership(blockClusterMap, sample.chain, sample.height, newCluster.id);
  }
}

  const edges = buildEdges(blockClusterMap);
const nodes = clusters.map((cluster) => ({
  id: cluster.id,
  avgDensity: cluster.densitySum / cluster.count,
  count: cluster.count,
  centroid: cluster.centroid,
  chains: Array.from(cluster.chains),
  tags: topTags(cluster.tags),
  firstTimestamp: cluster.firstTimestamp,
  lastTimestamp: cluster.lastTimestamp,
  timeslices: Array.from(cluster.timeslices.entries()).map(([start, sliceCount]) => ({
    start,
    end: start + SLICE_SECONDS,
    count: sliceCount,
  })),
}));

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify({ nodes, edges }, null, 2), 'utf-8');
  console.log(`Atlas built with ${nodes.length} nodes and ${edges.length} edges → ${outputPath}`);
  db.close();
}

function assignCluster(sample: HotzoneSample, clusters: Cluster[]): Cluster | null {
  let bestCluster: Cluster | null = null;
  let bestScore = -Infinity;
  clusters.forEach((cluster) => {
    const score = cosineSimilarity(sample.vector, cluster.centroid);
    if (score > bestScore) {
      bestScore = score;
      bestCluster = cluster;
    }
  });
  if (!bestCluster || bestScore < SIMILARITY_THRESHOLD) {
    return null;
  }
  const selectedCluster = bestCluster as Cluster;
  const clusterAvgDensity = selectedCluster.densitySum / selectedCluster.count;
  const ratio =
    Math.min(clusterAvgDensity, sample.density) / Math.max(clusterAvgDensity, sample.density);
  if (ratio < DENSITY_RATIO_THRESHOLD) {
    return null;
  }
  return selectedCluster;
}

function updateCluster(cluster: Cluster, sample: HotzoneSample) {
  const prevCount = cluster.count;
  const newCount = prevCount + 1;
  cluster.centroid = cluster.centroid.map(
    (value, index) => value + (sample.vector[index] - value) / newCount,
  );
  cluster.count = newCount;
  cluster.densitySum += sample.density;
  cluster.chains.add(sample.chain);
  cluster.firstTimestamp = Math.min(cluster.firstTimestamp, sample.timestamp);
  cluster.lastTimestamp = Math.max(cluster.lastTimestamp, sample.timestamp);
  sample.tags.forEach((tag) => cluster.tags.set(tag, (cluster.tags.get(tag) ?? 0) + 1));
  recordTimeslice(cluster, sample.timestamp);
}

function recordTimeslice(cluster: Cluster, timestamp: number) {
  const sliceKey = Math.floor(timestamp / SLICE_SECONDS) * SLICE_SECONDS;
  cluster.timeslices.set(sliceKey, (cluster.timeslices.get(sliceKey) ?? 0) + 1);
}

function addBlockMembership(map: Map<string, Set<number>>, chain: string, height: number, clusterId: number) {
  const key = `${chain}-${height}`;
  const set = map.get(key) ?? new Set<number>();
  set.add(clusterId);
  map.set(key, set);
}

function buildEdges(blockClusterMap: Map<string, Set<number>>) {
  const edgeWeights = new Map<string, number>();
  blockClusterMap.forEach((clusterSet) => {
    const ids = Array.from(clusterSet);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const key = `${a}-${b}`;
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
      }
    }
  });
  return Array.from(edgeWeights.entries()).map(([key, weight]) => {
    const [source, target] = key.split('-').map((value) => Number(value));
    return { source, target, weight };
  });
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-9);
}

function safeParseArray(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildTagMap(tags: string[]) {
  const map = new Map<string, number>();
  tags.forEach((tag) => map.set(tag, (map.get(tag) ?? 0) + 1));
  return map;
}

function topTags(map: Map<string, number>, limit = 5) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

