import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface AtlasNode {
  id: number;
  avgDensity: number;
  count: number;
  centroid: number[];
  chains: string[];
  tags: string[];
  firstTimestamp: number;
  lastTimestamp: number;
  timeslices?: { start: number; end: number; count: number }[];
}

export interface AtlasEdge {
  source: number;
  target: number;
  weight: number;
}

export interface AtlasGraph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export function loadAtlasGraph(): AtlasGraph | null {
  try {
    const dataDir = process.env.DATA_DIR ?? path.resolve('..', 'artifacts');
    const atlasPath = path.join(dataDir, 'atlas', 'graph.json');
    const raw = readFileSync(atlasPath, 'utf-8');
    return JSON.parse(raw) as AtlasGraph;
  } catch (error) {
    console.warn('Atlas graph not found. Run `npm run atlas:build` to generate it.', error);
    return null;
  }
}

export function filterAtlas(
  graph: AtlasGraph,
  options: {
    from?: number;
    to?: number;
    tags?: string[];
    limit?: number;
  } = {},
) {
  const fromSeconds = options.from ? Math.floor(options.from / 1000) : 0;
  const toSeconds = options.to ? Math.floor(options.to / 1000) : Number.POSITIVE_INFINITY;
  const tags = (options.tags ?? []).map((tag) => tag.toUpperCase());
  const filteredNodes = graph.nodes
    .filter((node) => node.lastTimestamp >= fromSeconds && node.firstTimestamp <= toSeconds)
    .filter((node) => {
      if (tags.length === 0) return true;
      const nodeTags = node.tags.map((tag) => tag.toUpperCase());
      return tags.some((tag) => nodeTags.includes(tag));
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, options.limit ?? graph.nodes.length);

  const nodeIds = new Set(filteredNodes.map((node) => node.id));
  const filteredEdges = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  return { nodes: filteredNodes, edges: filteredEdges };
}

