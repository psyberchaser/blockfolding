export interface Hotzone {
  id: string;
  center: number[];
  density: number;
  radius: number;
  semanticTags: string[];
}

export interface Hypergraph {
  nodes: Hotzone[];
  hyperedges: {
    nodes: number[];
    weight: number;
  }[];
}

