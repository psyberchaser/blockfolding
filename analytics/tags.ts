import { RawBlock } from '../folding/types.js';
import {
  LENDING_CONTRACT_ADDRESSES,
  normalizeAddress as normalizeSharedAddress,
} from '../shared/contracts/index.js';

const NFT_FUNCTIONS = new Set([
  '0x42842e0e', // ERC721 safeTransferFrom
  '0xb88d4fde', // ERC1155 safeTransferFrom
  '0xf242432a', // ERC1155 safeBatchTransferFrom
  '0x23b872dd', // transferFrom (marketplaces, P2P)
  '0x2e3dd94e', // Seaport fulfillBasicOrder
  '0xfb0f3ee1', // Seaport fulfillAvailableAdvancedOrders
  '0x3593564c', // Seaport fulfillAdvancedOrder
  '0x8a8c523c', // Seaport fulfillBasicOrder_fulfillmentComponentData
]);

const DEX_FUNCTIONS = new Set([
  '0x38ed1739', // swapExactTokensForTokens
  '0x18cbafe5', // swapExactTokensForETH
  '0x7ff36ab5', // swapExactETHForTokens
  '0x5c11d795', // swapExactTokensForETHSupportingFeeOnTransferTokens
  '0x414bf389', // exactInput (Uniswap v3)
  '0xe8e33700', // exactInputSingle
  '0x12aa3caf', // 1inch swap
  '0x4a25d94a', // 0x swap
  '0x7c025200', // 1inch UniswapV3 swap
  '0x5ae401dc', // multicall (Uniswap router)
]);

const NFT_CONTRACTS = makeAddressSet([
  '0x00000000006c3852cbef3e08e8df289169ede581', // Seaport 1.1
  '0x00000000000001ad428e4906ae43d8f9852d0dd6', // Seaport 1.5
  '0x000000000000ad05ccc4f10045630fb830b95127', // Blur Exchange
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc', // Seaport conduit
  '0xf42aa99f011a1fa7cda90e5e98b277e306bca83e', // LooksRare
  '0x74312363e45dcaba76c59ec49a7aa8a65a67eed3', // X2Y2
  '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405', // Foundation
  '0xabefbc9fd2f806065b4f3c237d4b59d9a97bcac7', // Zora
  '0x0000000000a39bb272e79075ade125fd351887ac', // Blur Pool
]);

const DEX_CONTRACTS = makeAddressSet([
  '0x7a250d5630b4cf539739df2c5dacab8edb538fda', // Uniswap V2 router
  '0xe592427a0aece92de3ede1f18e0157c05861564', // Uniswap V3 router
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap universal router
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', // SushiSwap router
  '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer vault
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x exchange proxy
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch router
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57', // ParaSwap
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41', // CowSwap settlement
  '0xe66b31678d6c16e9ebf358268a790b763c133750', // Kyber router
  '0x881d40237659c251811cec9c364ef91dc08d300c', // MetaMask swap router
]);

const BRIDGE_CONTRACTS = makeAddressSet([
  '0xa3a7b6f88361f48403514059f1f16c8e78d60eec', // Optimism L1 bridge
  '0x4c6f947ae67f572afa4ae0730947de7c874f95ef', // Arbitrum Inbox
  '0x8731d54e9d02c286767d56ac03e8037c07e01e98', // Stargate router
  '0xb8901acb165ed027e32754e0ff56e7072c39aa8c', // Arbitrum gateway router
  '0x96c3b64d8c8da76a60a074c6f83b9e3c5c195fd0', // Hop bridge
]);

const LENDING_CONTRACTS = makeAddressSet(LENDING_CONTRACT_ADDRESSES);

const ASSET_ALIASES: Record<string, string> = {
  LEGACY: 'LEGACY_FLOW',
  '0X0': 'LEGACY_FLOW',
  ACCESS_LIST: 'ACCESS_LIST_FLOW',
  '0X1': 'ACCESS_LIST_FLOW',
  DYNAMIC_FEE: 'EIP1559_FLOW',
  '0X2': 'EIP1559_FLOW',
  BLOB: 'BLOB_CARRY_FLOW',
  '0X3': 'BLOB_CARRY_FLOW',
  SYSTEM: 'SYSTEM_MESSAGE_FLOW',
  '0X4': 'SYSTEM_MESSAGE_FLOW',
};

export interface TransactionCategories {
  dex: boolean;
  nft: boolean;
  lending: boolean;
  bridge: boolean;
  highFee: boolean;
  largeValue: boolean;
}

export interface TransactionAnalysis {
  tags: string[];
  categories: TransactionCategories;
}

export function deriveRawBlockTags(raw: RawBlock): string[] {
  const tags = new Set<string>();
  raw.transactions.forEach((tx) => {
    const analysis = analyzeTransaction(tx);
    analysis.tags.forEach((tag) => tags.add(tag));
  });

  if (raw.transactions.length > 400) {
    tags.add('HIGH_THROUGHPUT');
  }

  return Array.from(tags);
}

export function analyzeTransaction(tx: Record<string, unknown>): TransactionAnalysis {
  const tags = new Set<string>();
  const categories: TransactionCategories = {
    dex: false,
    nft: false,
    lending: false,
    bridge: false,
    highFee: false,
    largeValue: false,
  };

  const selector = extractSelector(tx);
  if (selector) {
    if (NFT_FUNCTIONS.has(selector)) {
      tags.add('NFT_ACTIVITY');
      categories.nft = true;
    }
    if (DEX_FUNCTIONS.has(selector)) {
      tags.add('DEX_ACTIVITY');
      categories.dex = true;
    }
  }

  const receiver = normalizeAddress(tx['receiver'] ?? tx['to']);
  const sender = normalizeAddress(tx['sender'] ?? tx['from']);
  if ((receiver && NFT_CONTRACTS.has(receiver)) || (sender && NFT_CONTRACTS.has(sender))) {
    tags.add('NFT_ACTIVITY');
    categories.nft = true;
  }
  if ((receiver && DEX_CONTRACTS.has(receiver)) || (sender && DEX_CONTRACTS.has(sender))) {
    tags.add('DEX_ACTIVITY');
    categories.dex = true;
  }
  if ((receiver && BRIDGE_CONTRACTS.has(receiver)) || (sender && BRIDGE_CONTRACTS.has(sender))) {
    tags.add('BRIDGE_ACTIVITY');
    categories.bridge = true;
  }
  if ((receiver && LENDING_CONTRACTS.has(receiver)) || (sender && LENDING_CONTRACTS.has(sender))) {
    tags.add('LENDING_ACTIVITY');
    categories.lending = true;
  }

  const gasPrice = Number(tx['gasPrice'] ?? 0);
  if (gasPrice > 50_000_000_000) {
    tags.add('HIGH_FEE');
    categories.highFee = true;
  }
  const amountWei = Number(tx['amountWei'] ?? tx['amount'] ?? 0);
  if (amountWei > 1e21) {
    tags.add('LARGE_VALUE');
    categories.largeValue = true;
  }

  // semantic metadata from adapters / extended fields
  addStringTag(tx['sector'], 'SECTOR', tags);
  addStringTag(tx['venue'], 'VENUE', tags);
  addStringTag(tx['pair'], 'PAIR', tags);
  addStringTag(tx['currency'], 'CURRENCY', tags);
  addStringTag(tx['jurisdiction'], 'JURISDICTION', tags);
  addStringTag(tx['alertType'], 'AML_ALERT', tags);
  addStringTag(tx['triggeredRule'], 'AML_RULE', tags);
  const assetClass = tx['assetClass'] ?? tx['contractType'];
  addAssetTag(assetClass, tags);
  addSideTag(tx['side'], tags);
  addRiskTags(tx['riskScore'], tags);
  addLiquidityTags(tx['liquidityScore'], tags);
  addSpreadTags(tx['spreadPips'], tags);

  return {
    tags: Array.from(tags),
    categories,
  };
}

function extractSelector(tx: Record<string, unknown>): string | null {
  if (typeof tx['functionSelector'] === 'string') {
    return tx['functionSelector'].slice(0, 10).toLowerCase();
  }
  if (typeof tx['data'] === 'string' && tx['data'].startsWith('0x') && tx['data'].length >= 10) {
    return tx['data'].slice(0, 10).toLowerCase();
  }
  if (typeof tx['input'] === 'string' && tx['input'].startsWith('0x') && tx['input'].length >= 10) {
    return tx['input'].slice(0, 10).toLowerCase();
  }
  return null;
}

const normalizeAddress = normalizeSharedAddress;

function makeAddressSet(addresses: string[]): Set<string> {
  return new Set(addresses.map((addr) => addr.toLowerCase()));
}

function addStringTag(value: unknown, prefix: string, tags: Set<string>) {
  if (typeof value !== 'string' || value.length === 0) return;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (normalized.length === 0) return;
  tags.add(`${prefix}_${normalized}`);
}

function addAssetTag(value: unknown, tags: Set<string>) {
  if (typeof value !== 'string' || value.length === 0) return;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (normalized.length === 0) return;
  const alias = ASSET_ALIASES[normalized];
  if (alias) {
    tags.add(`ASSET_${alias}`);
    return;
  }
  tags.add(`ASSET_${normalized}`);
}

function addSideTag(value: unknown, tags: Set<string>) {
  if (typeof value !== 'string') return;
  const upper = value.toUpperCase();
  if (upper === 'BUY' || upper === 'SELL') {
    tags.add(`SIDE_${upper}`);
  }
}

function addRiskTags(score: unknown, tags: Set<string>) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return;
  if (numeric >= 80) {
    tags.add('RISK_CRITICAL');
  } else if (numeric >= 50) {
    tags.add('RISK_HIGH');
  } else if (numeric >= 20) {
    tags.add('RISK_MEDIUM');
  } else {
    tags.add('RISK_LOW');
  }
}

function addLiquidityTags(score: unknown, tags: Set<string>) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return;
  if (numeric <= 0.3) {
    tags.add('LIQUIDITY_THIN');
  } else if (numeric >= 0.7) {
    tags.add('LIQUIDITY_DEEP');
  } else {
    tags.add('LIQUIDITY_BALANCED');
  }
}

function addSpreadTags(spread: unknown, tags: Set<string>) {
  const numeric = Number(spread);
  if (!Number.isFinite(numeric)) return;
  if (numeric >= 5) {
    tags.add('SPREAD_WIDE');
  } else if (numeric <= 1) {
    tags.add('SPREAD_TIGHT');
  }
}

