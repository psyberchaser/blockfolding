export interface BehaviorContractInsight {
  address: string;
  label?: string;
  txCount: number;
  totalValueWei: number;
  categories: string[];
}

export interface BehaviorMetrics {
  totalGas: number;
  dexGasShare: number;
  nftGasShare: number;
  lendingVolumeWei: number;
  bridgeVolumeWei: number;
  dexTxCount: number;
  nftTxCount: number;
  lendingTxCount: number;
  bridgeTxCount: number;
  highFeeTxCount: number;
  dominantFlow: string | null;
  topContracts: BehaviorContractInsight[];
}


