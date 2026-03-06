import { getMetricsDatabase } from './db.js';

export type MetricsInterval = 'hour' | 'day';

export interface TimeseriesPoint {
  timestamp: number;
  blockCount: number;
  avgHotzones: number;
  avgPeakDensity: number;
  tagCounts: Record<string, number>;
  avgDexGasShare: number;
  avgNftGasShare: number;
  avgLendingVolumeWei: number;
  avgBridgeVolumeWei: number;
  avgHighFeeTx: number;
}

const TAGS_OF_INTEREST = ['AML_ALERT', 'DEX_ACTIVITY', 'NFT_ACTIVITY', 'LENDING_ACTIVITY', 'HIGH_FEE'];

export function queryTimeseries(options: {
  from: number;
  to: number;
  interval: MetricsInterval;
  chains?: string[];
  tags?: string[];
}) {
  const db = getMetricsDatabase();
  const selectedTags =
    options.tags && options.tags.length > 0
      ? Array.from(new Set(options.tags.map((tag) => tag.toUpperCase())))
      : TAGS_OF_INTEREST;
  const stmt = db.prepare(
    `
    SELECT chain,
           height,
           timestamp,
           hotzone_count as hotzoneCount,
           peak_density as peakDensity,
           avg_density as avgDensity,
           tags,
           dex_gas_share as dexGasShare,
           nft_gas_share as nftGasShare,
           lending_volume_wei as lendingVolumeWei,
           bridge_volume_wei as bridgeVolumeWei,
           high_fee_tx as highFeeTx
    FROM block_metrics
    WHERE timestamp BETWEEN ? AND ?
      ${options.chains && options.chains.length > 0 ? `AND chain IN (${options.chains.map(() => '?').join(',')})` : ''}
    ORDER BY timestamp ASC
  `,
  );
  const params: (string | number)[] = [Math.floor(options.from / 1000), Math.floor(options.to / 1000)];
  if (options.chains && options.chains.length > 0) {
    params.push(...options.chains);
  }
  const rows = stmt.all(...params) as {
    chain: string;
    height: number;
    timestamp: number;
    hotzoneCount: number;
    peakDensity: number;
    avgDensity: number;
    tags: string;
    dexGasShare: number;
    nftGasShare: number;
    lendingVolumeWei: number;
    bridgeVolumeWei: number;
    highFeeTx: number;
  }[];

  const bucketSize = options.interval === 'hour' ? 3600 * 1000 : 86400 * 1000;
  const buckets = new Map<
    number,
    {
      blockCount: number;
      hotzoneSum: number;
      peakDensitySum: number;
      tagCounts: Record<string, number>;
      dexGasShareSum: number;
      nftGasShareSum: number;
      lendingVolumeSum: number;
      bridgeVolumeSum: number;
      highFeeTxSum: number;
    }
  >();

  rows.forEach((row) => {
    const timestampMs = row.timestamp * 1000;
    const bucket = Math.floor(timestampMs / bucketSize) * bucketSize;
    const entry =
      buckets.get(bucket) ??
      {
        blockCount: 0,
        hotzoneSum: 0,
        peakDensitySum: 0,
        tagCounts: Object.fromEntries(selectedTags.map((tag) => [tag, 0])) as Record<string, number>,
        dexGasShareSum: 0,
        nftGasShareSum: 0,
        lendingVolumeSum: 0,
        bridgeVolumeSum: 0,
        highFeeTxSum: 0,
      };
    entry.blockCount += 1;
    entry.hotzoneSum += row.hotzoneCount;
    entry.peakDensitySum += row.peakDensity;
    try {
      const parsed = JSON.parse(row.tags) as string[];
      selectedTags.forEach((tag) => {
        if (parsed.some((entryTag) => entryTag.toUpperCase().includes(tag))) {
          entry.tagCounts[tag] += 1;
        }
      });
    } catch {
      // ignore malformed tag payloads
    }
    entry.dexGasShareSum += Number(row.dexGasShare ?? 0);
    entry.nftGasShareSum += Number(row.nftGasShare ?? 0);
    entry.lendingVolumeSum += Number(row.lendingVolumeWei ?? 0);
    entry.bridgeVolumeSum += Number(row.bridgeVolumeWei ?? 0);
    entry.highFeeTxSum += Number(row.highFeeTx ?? 0);
    buckets.set(bucket, entry);
  });

  const timeseries: TimeseriesPoint[] = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, entry]) => ({
      timestamp,
      blockCount: entry.blockCount,
      avgHotzones: entry.blockCount > 0 ? entry.hotzoneSum / entry.blockCount : 0,
      avgPeakDensity: entry.blockCount > 0 ? entry.peakDensitySum / entry.blockCount : 0,
      tagCounts: entry.tagCounts,
      avgDexGasShare: entry.blockCount > 0 ? entry.dexGasShareSum / entry.blockCount : 0,
      avgNftGasShare: entry.blockCount > 0 ? entry.nftGasShareSum / entry.blockCount : 0,
      avgLendingVolumeWei: entry.blockCount > 0 ? entry.lendingVolumeSum / entry.blockCount : 0,
      avgBridgeVolumeWei: entry.blockCount > 0 ? entry.bridgeVolumeSum / entry.blockCount : 0,
      avgHighFeeTx: entry.blockCount > 0 ? entry.highFeeTxSum / entry.blockCount : 0,
    }));

  const availableChains = Array.from(new Set(rows.map((row) => row.chain)));
  const summary = buildSummary(timeseries, selectedTags);

  return {
    points: timeseries,
    tags: selectedTags,
    metadata: { chains: availableChains },
    summary,
  };
}

function buildSummary(points: TimeseriesPoint[], tags: string[]) {
  if (points.length === 0) {
    return { peakBlock: null, tagPeaks: {} as Record<string, null> };
  }
  const peakBlock = points.reduce(
    (acc, point) =>
      point.blockCount > acc.value ? { timestamp: point.timestamp, value: point.blockCount } : acc,
    { timestamp: points[0].timestamp, value: points[0].blockCount },
  );
  const tagPeaks: Record<
    string,
    { timestamp: number; value: number }
  > = {};
  tags.forEach((tag) => {
    let best = { timestamp: points[0].timestamp, value: 0 };
    points.forEach((point) => {
      const value = point.tagCounts[tag] ?? 0;
      if (value > best.value) {
        best = { timestamp: point.timestamp, value };
      }
    });
    tagPeaks[tag] = best;
  });
  const dominantFlow = points.reduce(
    (acc, point) => {
      const candidate = point.avgDexGasShare + point.avgNftGasShare;
      if (candidate > acc.score) {
        return { score: candidate, timestamp: point.timestamp };
      }
      return acc;
    },
    { score: 0, timestamp: points[0].timestamp },
  );
  return {
    peakBlock,
    tagPeaks,
    dominantFlowSpike: dominantFlow,
  };
}

