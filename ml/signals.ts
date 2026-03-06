/**
 * Unique Trading Signals
 * 
 * These signals are computed from block fingerprints and provide
 * unique predictive value not available from other data sources.
 */

export interface DriftVelocityResult {
  velocity: number;           // Rate of change in fingerprint space
  direction: number[];        // Unit vector of drift direction (16-dim)
  acceleration: number;       // Second derivative (change in velocity)
  isAccelerating: boolean;
  confidence: number;
}

export interface HotzoneDepartureResult {
  distance: number;           // Distance from nearest historical centroid
  nearestCentroid: number[];  // The closest centroid
  departureSigma: number;     // Standard deviations from typical
  isOutlier: boolean;         // > 2 sigma from any centroid
}

export interface TagAccelerationResult {
  tagVelocities: Record<string, number>;    // Rate of change per tag
  tagAccelerations: Record<string, number>; // Second derivative per tag
  emergingTags: string[];     // Tags with positive acceleration
  decliningTags: string[];    // Tags with negative acceleration
}

export interface CrossChainCorrelation {
  chain1: string;
  chain2: string;
  correlation: number;        // Pearson correlation of recent fingerprints
  lag: number;                // Optimal lag in blocks
  leadChain: string | null;   // Which chain leads the correlation
}

// ============================================
// DRIFT VELOCITY
// ============================================

/**
 * Compute drift velocity between consecutive fingerprints
 * 
 * This measures how fast the blockchain "behavior" is changing.
 * High velocity = rapid behavioral change = potential event incoming.
 */
export function computeDriftVelocity(
  currentFingerprint: number[],
  previousFingerprint: number[],
  olderFingerprint?: number[],
): DriftVelocityResult {
  // Compute velocity as L2 distance normalized by time
  const delta = currentFingerprint.map((v, i) => v - (previousFingerprint[i] ?? 0));
  const velocity = Math.sqrt(delta.reduce((sum, d) => sum + d * d, 0));
  
  // Normalize direction
  const direction = delta.map(d => d / (velocity || 1));
  
  // Compute acceleration if we have older fingerprint
  let acceleration = 0;
  if (olderFingerprint) {
    const prevDelta = previousFingerprint.map((v, i) => v - (olderFingerprint[i] ?? 0));
    const prevVelocity = Math.sqrt(prevDelta.reduce((sum, d) => sum + d * d, 0));
    acceleration = velocity - prevVelocity;
  }
  
  return {
    velocity,
    direction,
    acceleration,
    isAccelerating: acceleration > 0.1,
    confidence: Math.min(1, velocity / 2), // Higher velocity = more confident something is happening
  };
}

/**
 * Compute drift velocity from a sequence of fingerprints
 */
export function computeDriftVelocitySequence(
  fingerprints: number[][],
): DriftVelocityResult[] {
  const results: DriftVelocityResult[] = [];
  
  for (let i = 1; i < fingerprints.length; i++) {
    const current = fingerprints[i];
    const previous = fingerprints[i - 1];
    const older = i > 1 ? fingerprints[i - 2] : undefined;
    
    results.push(computeDriftVelocity(current, previous, older));
  }
  
  return results;
}

// ============================================
// HOTZONE DEPARTURE
// ============================================

/**
 * Compute distance from nearest historical hotzone centroid
 * 
 * This measures how "unusual" the current block's behavior is
 * compared to previously observed behavioral clusters.
 */
export function computeHotzoneDeparture(
  fingerprint: number[],
  historicalCentroids: number[][],
  typicalDistance?: number,
  distanceStd?: number,
): HotzoneDepartureResult {
  if (historicalCentroids.length === 0) {
    return {
      distance: 0,
      nearestCentroid: [],
      departureSigma: 0,
      isOutlier: false,
    };
  }
  
  // Find nearest centroid
  let minDistance = Infinity;
  let nearestCentroid: number[] = [];
  
  for (const centroid of historicalCentroids) {
    const dist = Math.sqrt(
      fingerprint.reduce((sum, v, i) => sum + (v - (centroid[i] ?? 0)) ** 2, 0)
    );
    if (dist < minDistance) {
      minDistance = dist;
      nearestCentroid = centroid;
    }
  }
  
  // Compute sigma if we have historical stats
  const typical = typicalDistance ?? 1;
  const std = distanceStd ?? 0.5;
  const departureSigma = (minDistance - typical) / std;
  
  return {
    distance: minDistance,
    nearestCentroid,
    departureSigma,
    isOutlier: departureSigma > 2,
  };
}

// ============================================
// TAG ACCELERATION
// ============================================

/**
 * Compute tag frequency acceleration
 * 
 * This tracks which behavioral tags are gaining or losing momentum.
 * Emerging tags signal new market conditions.
 */
export function computeTagAcceleration(
  recentTagCounts: Record<string, number>[],
): TagAccelerationResult {
  if (recentTagCounts.length < 2) {
    return {
      tagVelocities: {},
      tagAccelerations: {},
      emergingTags: [],
      decliningTags: [],
    };
  }
  
  // Get all unique tags
  const allTags = new Set<string>();
  recentTagCounts.forEach(counts => Object.keys(counts).forEach(t => allTags.add(t)));
  
  const tagVelocities: Record<string, number> = {};
  const tagAccelerations: Record<string, number> = {};
  const emergingTags: string[] = [];
  const decliningTags: string[] = [];
  
  for (const tag of allTags) {
    const counts = recentTagCounts.map(c => c[tag] ?? 0);
    
    // Compute velocity (first derivative)
    const velocities: number[] = [];
    for (let i = 1; i < counts.length; i++) {
      velocities.push(counts[i] - counts[i - 1]);
    }
    const avgVelocity = velocities.reduce((a, b) => a + b, 0) / velocities.length;
    tagVelocities[tag] = avgVelocity;
    
    // Compute acceleration (second derivative)
    if (velocities.length > 1) {
      const accelerations: number[] = [];
      for (let i = 1; i < velocities.length; i++) {
        accelerations.push(velocities[i] - velocities[i - 1]);
      }
      const avgAcceleration = accelerations.reduce((a, b) => a + b, 0) / accelerations.length;
      tagAccelerations[tag] = avgAcceleration;
      
      // Classify
      if (avgAcceleration > 0.5 && avgVelocity > 0) {
        emergingTags.push(tag);
      } else if (avgAcceleration < -0.5 && avgVelocity < 0) {
        decliningTags.push(tag);
      }
    }
  }
  
  return {
    tagVelocities,
    tagAccelerations,
    emergingTags,
    decliningTags,
  };
}

// ============================================
// CROSS-CHAIN CORRELATION
// ============================================

/**
 * Compute correlation between fingerprints from different chains
 * 
 * This identifies when chains are moving in sync or when one
 * chain's behavior predicts another's.
 */
export function computeCrossChainCorrelation(
  chain1Fingerprints: number[][],
  chain2Fingerprints: number[][],
  chain1Name: string,
  chain2Name: string,
  maxLag: number = 5,
): CrossChainCorrelation {
  const n = Math.min(chain1Fingerprints.length, chain2Fingerprints.length);
  
  if (n < 3) {
    return {
      chain1: chain1Name,
      chain2: chain2Name,
      correlation: 0,
      lag: 0,
      leadChain: null,
    };
  }
  
  // Reduce fingerprints to scalar (L2 norm)
  const series1 = chain1Fingerprints.slice(0, n).map(fp => 
    Math.sqrt(fp.reduce((sum, v) => sum + v * v, 0))
  );
  const series2 = chain2Fingerprints.slice(0, n).map(fp => 
    Math.sqrt(fp.reduce((sum, v) => sum + v * v, 0))
  );
  
  // Compute correlation at different lags
  let bestCorr = 0;
  let bestLag = 0;
  
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const corr = computePearsonCorrelation(series1, series2, lag);
    if (Math.abs(corr) > Math.abs(bestCorr)) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  
  return {
    chain1: chain1Name,
    chain2: chain2Name,
    correlation: bestCorr,
    lag: bestLag,
    leadChain: bestLag > 0 ? chain1Name : bestLag < 0 ? chain2Name : null,
  };
}

/**
 * Pearson correlation with lag
 */
function computePearsonCorrelation(x: number[], y: number[], lag: number): number {
  const n = x.length - Math.abs(lag);
  if (n < 2) return 0;
  
  let xs: number[], ys: number[];
  if (lag >= 0) {
    xs = x.slice(0, n);
    ys = y.slice(lag, lag + n);
  } else {
    xs = x.slice(-lag, -lag + n);
    ys = y.slice(0, n);
  }
  
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  
  const denom = Math.sqrt(denX * denY);
  return denom > 0 ? num / denom : 0;
}

// ============================================
// COMBINED SIGNAL AGGREGATOR
// ============================================

export interface CombinedSignals {
  anomalyScore: number;
  driftVelocity: DriftVelocityResult;
  hotzoneDeparture: HotzoneDepartureResult;
  tagAcceleration: TagAccelerationResult;
  crossChainCorrelations: CrossChainCorrelation[];
  overallSentiment: 'bullish' | 'bearish' | 'neutral' | 'volatile';
  confidence: number;
}

/**
 * Aggregate all signals into a combined assessment
 */
export function aggregateSignals(
  anomalyScore: number,
  driftVelocity: DriftVelocityResult,
  hotzoneDeparture: HotzoneDepartureResult,
  tagAcceleration: TagAccelerationResult,
  crossChainCorrelations: CrossChainCorrelation[],
): CombinedSignals {
  // Determine overall sentiment
  let sentiment: 'bullish' | 'bearish' | 'neutral' | 'volatile' = 'neutral';
  
  const hasHighVolatility = driftVelocity.velocity > 1.5 || hotzoneDeparture.isOutlier;
  const hasDexEmergence = tagAcceleration.emergingTags.includes('DEX_ACTIVITY');
  const hasNftDecline = tagAcceleration.decliningTags.includes('NFT_ACTIVITY');
  
  if (hasHighVolatility) {
    sentiment = 'volatile';
  } else if (hasDexEmergence && !hasNftDecline) {
    sentiment = 'bullish';
  } else if (hasNftDecline && !hasDexEmergence) {
    sentiment = 'bearish';
  }
  
  // Compute overall confidence
  const confidence = (
    driftVelocity.confidence * 0.3 +
    (hotzoneDeparture.distance > 0 ? 0.3 : 0.1) +
    (tagAcceleration.emergingTags.length > 0 ? 0.2 : 0.1) +
    (crossChainCorrelations.some(c => Math.abs(c.correlation) > 0.5) ? 0.2 : 0.1)
  );
  
  return {
    anomalyScore,
    driftVelocity,
    hotzoneDeparture,
    tagAcceleration,
    crossChainCorrelations,
    overallSentiment: sentiment,
    confidence: Math.min(1, confidence),
  };
}









