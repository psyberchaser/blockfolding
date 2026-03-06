import { RawBlock } from '../folding/types.js';
import { BehaviorMetrics, BehaviorContractInsight } from '../shared/behavior.js';
import { LENDING_CONTRACT_LABELS, normalizeAddress } from '../shared/contracts/index.js';
import { analyzeTransaction } from './tags.js';

interface ContractAccumulator {
  address: string;
  label?: string;
  txCount: number;
  totalValueWei: number;
  categories: Set<string>;
}

export function computeBehaviorMetrics(raw: RawBlock): BehaviorMetrics {
  let totalGas = 0;
  let dexGas = 0;
  let nftGas = 0;
  let lendingVolumeWei = 0;
  let bridgeVolumeWei = 0;
  let dexTxCount = 0;
  let nftTxCount = 0;
  let lendingTxCount = 0;
  let bridgeTxCount = 0;
  let highFeeTxCount = 0;

  const contracts = new Map<string, ContractAccumulator>();

  raw.transactions.forEach((tx) => {
    const gas = resolveNumeric(tx['gasUsed'] ?? tx['gas'] ?? tx['gasLimit']) || 0;
    const valueWei = resolveNumeric(tx['amountWei'] ?? tx['amount'] ?? tx['value']) || 0;
    totalGas += gas;

    const analysis = analyzeTransaction(tx);
    if (analysis.categories.dex) {
      dexGas += gas;
      dexTxCount += 1;
    }
    if (analysis.categories.nft) {
      nftGas += gas;
      nftTxCount += 1;
    }
    if (analysis.categories.lending) {
      lendingVolumeWei += valueWei;
      lendingTxCount += 1;
    }
    if (analysis.categories.bridge) {
      bridgeVolumeWei += valueWei;
      bridgeTxCount += 1;
    }
    if (analysis.categories.highFee) {
      highFeeTxCount += 1;
    }

    const receiver = normalizeAddress(tx['receiver'] ?? tx['to']);
    if (receiver) {
      const existing =
        contracts.get(receiver) ??
        {
          address: receiver,
          label: LENDING_CONTRACT_LABELS[receiver] ?? undefined,
          txCount: 0,
          totalValueWei: 0,
          categories: new Set<string>(),
        };
      existing.txCount += 1;
      existing.totalValueWei += Math.max(0, valueWei);
      if (analysis.categories.dex) existing.categories.add('DEX_ACTIVITY');
      if (analysis.categories.lending) existing.categories.add('LENDING_ACTIVITY');
      if (analysis.categories.nft) existing.categories.add('NFT_ACTIVITY');
      if (analysis.categories.bridge) existing.categories.add('BRIDGE_ACTIVITY');
      contracts.set(receiver, existing);
    }
  });

  const topContracts: BehaviorContractInsight[] = Array.from(contracts.values())
    .sort(
      (a, b) =>
        b.txCount - a.txCount ||
        b.totalValueWei - a.totalValueWei ||
        a.address.localeCompare(b.address),
    )
    .slice(0, 3)
    .map((entry) => ({
      address: entry.address,
      label: entry.label,
      txCount: entry.txCount,
      totalValueWei: entry.totalValueWei,
      categories: Array.from(entry.categories),
    }));

  const dominantFlow = determineDominantFlow({
    dexShare: totalGas > 0 ? dexGas / totalGas : 0,
    nftShare: totalGas > 0 ? nftGas / totalGas : 0,
    lendingVolumeWei,
    bridgeVolumeWei,
    highFeeShare: raw.transactions.length > 0 ? highFeeTxCount / raw.transactions.length : 0,
  });

  return {
    totalGas,
    dexGasShare: totalGas > 0 ? dexGas / totalGas : 0,
    nftGasShare: totalGas > 0 ? nftGas / totalGas : 0,
    lendingVolumeWei,
    bridgeVolumeWei,
    dexTxCount,
    nftTxCount,
    lendingTxCount,
    bridgeTxCount,
    highFeeTxCount,
    dominantFlow,
    topContracts,
  };
}

function resolveNumeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) {
      return Number.parseInt(value, 16);
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function determineDominantFlow(options: {
  dexShare: number;
  nftShare: number;
  lendingVolumeWei: number;
  bridgeVolumeWei: number;
  highFeeShare: number;
}): string | null {
  const contributions: { label: string; weight: number }[] = [
    { label: 'DEX_ACTIVITY', weight: options.dexShare },
    { label: 'NFT_ACTIVITY', weight: options.nftShare },
    { label: 'LENDING_ACTIVITY', weight: logContribution(options.lendingVolumeWei) },
    { label: 'BRIDGE_ACTIVITY', weight: logContribution(options.bridgeVolumeWei) },
    { label: 'HIGH_FEE', weight: options.highFeeShare },
  ];
  const candidate = contributions
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)[0];
  return candidate ? candidate.label : null;
}

function logContribution(value: number) {
  if (value <= 0) return 0;
  return Math.log10(value + 1);
}


