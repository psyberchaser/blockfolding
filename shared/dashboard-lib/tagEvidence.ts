import { readFileSync } from 'node:fs';
import {
  LENDING_CONTRACT_ADDRESSES,
  LENDING_CONTRACT_LABELS,
  normalizeAddress,
} from '../contracts/index.js';

const LENDING_SET = new Set(
  LENDING_CONTRACT_ADDRESSES.map((addr: string) => addr.toLowerCase()),
);

export type LendingTransactionEvidence = {
  hash: string;
  protocol: string;
  amountWei: number;
  amountEth: number;
  sender: string;
  receiver: string;
  functionSelector: string | null;
};

export function findLendingTransactions(
  blockPath: string,
  limit = 5,
): LendingTransactionEvidence[] {
  try {
    const raw = JSON.parse(readFileSync(blockPath, 'utf-8'));
    const transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
    const matches: LendingTransactionEvidence[] = [];
    for (const tx of transactions) {
      const sender = normalizeAddress(tx.sender ?? tx.from);
      const receiver = normalizeAddress(tx.receiver ?? tx.to);
      const matchedAddress = sender && LENDING_SET.has(sender)
        ? sender
        : receiver && LENDING_SET.has(receiver)
          ? receiver
          : null;
      if (!matchedAddress) continue;
      const amountWei = Number(tx.amountWei ?? tx.amount ?? tx.value ?? 0);
      matches.push({
        hash: String(tx.hash ?? ''),
        protocol: LENDING_CONTRACT_LABELS[matchedAddress] ?? 'Lending protocol',
        amountWei,
        amountEth: amountWei / 1e18,
        sender: String(tx.sender ?? tx.from ?? ''),
        receiver: String(tx.receiver ?? tx.to ?? ''),
        functionSelector: extractSelector(tx),
      });
      if (matches.length >= limit) break;
    }
    return matches;
  } catch {
    return [];
  }
}

function extractSelector(tx: Record<string, unknown>): string | null {
  if (typeof tx.functionSelector === 'string') {
    return tx.functionSelector.slice(0, 10).toLowerCase();
  }
  if (typeof tx.data === 'string' && tx.data.startsWith('0x') && tx.data.length >= 10) {
    return tx.data.slice(0, 10).toLowerCase();
  }
  return null;
}


