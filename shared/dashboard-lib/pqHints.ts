const PQ_COMPONENT_HINTS: Record<number, string> = {
  0: 'Base flow / balance drift',
  1: 'DEX swap pressure',
  2: 'Lending utilization',
  3: 'NFT transfer churn',
  4: 'High-fee bursts / gas spikes',
  5: 'Bridge settlement',
  6: 'Arbitrage / MEV bundles',
  7: 'System messages / blobs',
  8: 'Stablecoin flow',
  9: 'DeFi leverage rotation',
  10: 'Validator fee share',
  11: 'DEX depth shock',
  12: 'Cross-chain relay activity',
  13: 'Volatility compression',
  14: 'Liquidity migration',
  15: 'Access-list heavy calls',
};

export function describePQComponent(index: number) {
  return PQ_COMPONENT_HINTS[index] ?? 'Latent behavior component';
}

