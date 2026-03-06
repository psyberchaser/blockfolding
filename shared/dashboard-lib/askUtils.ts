import type { StoredBlockSummary } from './blocks.js';

export const KEYWORD_MAP: { regex: RegExp; tags: string[] }[] = [
  { regex: /nft/i, tags: ['NFT_ACTIVITY'] },
  { regex: /dex|swap|amm/i, tags: ['DEX_ACTIVITY'] },
  { regex: /bridge/i, tags: ['BRIDGE_ACTIVITY'] },
   { regex: /avax|avalanche/i, tags: ['BRIDGE_ACTIVITY'] },
  { regex: /liquidity/i, tags: ['LIQUIDITY_THIN', 'LIQUIDITY_DEEP'] },
  { regex: /volatil/i, tags: ['VOL_HIGH', 'VOL_LOW'] },
  { regex: /aml|fraud|compliance/i, tags: ['AML_ALERT', 'AML_RULE'] },
  { regex: /lending|loan/i, tags: ['LENDING_ACTIVITY'] },
  { regex: /high fee|gas/i, tags: ['HIGH_FEE'] },
  { regex: /large value|whale/i, tags: ['LARGE_VALUE'] },
   { regex: /hotzone|density|fingerprint|cluster/i, tags: ['DEX_ACTIVITY'] },
   { regex: /arbitrage|mev/i, tags: ['DEX_ACTIVITY', 'HIGH_FEE'] },
  { regex: /equit/i, tags: ['ASSET_EQUITY'] },
  { regex: /fx|forex|currency/i, tags: ['ASSET_FX'] },
];

export function inferTags(question: string): string[] {
  const tags = new Set<string>();
  KEYWORD_MAP.forEach(({ regex, tags: mapped }) => {
    if (regex.test(question)) {
      mapped.forEach((tag) => tags.add(tag));
    }
  });
  const words = question
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  words.forEach((word) => {
    if (word.length < 3) return;
    if (word === 'TECH' || word === 'TECHNOLOGY') tags.add('SECTOR_TECH');
    if (word === 'FINANCE' || word === 'BANK') tags.add('SECTOR_FINANCE');
    if (word === 'EMERGING' || word === 'EMERGING_MARKETS') tags.add('SECTOR_EMERGING_MARKETS');
    if (word.includes('SAFE')) tags.add('RISK_LOW');
    if (word.includes('ALERT')) tags.add('AML_ALERT');
  });
  return Array.from(tags);
}

export function dedupeBlocks(blocks: StoredBlockSummary[], limit: number): StoredBlockSummary[] {
  const seen = new Set<string>();
  const out: StoredBlockSummary[] = [];
  for (const block of blocks) {
    const key = `${block.chain}:${block.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
    if (out.length >= limit) break;
  }
  return out;
}

export function buildSummary(
  question: string,
  tags: string[],
  sample: StoredBlockSummary[],
): string {
  const tagList = tags.join(', ');
  const sampleText =
    sample.length === 0
      ? ''
      : ` Example: ${sample
          .map((block) => `${block.chain} #${block.height} (tags: ${block.tags.slice(0, 3).join(', ')})`)
          .join('; ')}.`;
  return `Question "${question}" matched tags [${tagList}].${sampleText}`;
}


