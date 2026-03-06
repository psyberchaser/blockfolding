export type NamedAddress = {
  address: string;
  label: string;
};

export const LENDING_CONTRACTS: NamedAddress[] = [
  { address: '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9', label: 'Aave v2 Lending Pool' },
  { address: '0x8f8ef111b67c04eb1641f5ff19ee54cda062f163', label: 'Aave v3 Portal' },
  { address: '0x3dfd63e61e255587d21d06b5d7cf58050ff48c7a', label: 'Aave v3 Pool' },
  { address: '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac', label: 'Compound v2 cETH' },
  { address: '0x3f0a0ea2f86bae6362cf9799b523ba06647da018', label: 'Compound v3 Comet' },
  { address: '0xbcca60bb61934080951369a648fb03df4f96263c', label: 'Aave USDC Reserve' },
  { address: '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643', label: 'Compound cDAI' },
  { address: '0x35a18000230da775cac24873d00ff85bccded550', label: 'Compound cUSDCv3' },
  { address: '0xee856f36a8dbf2eaf61291f634111a5402ba66a6', label: 'Spark Protocol' },
  { address: '0xded4a5667a5d9d0f2b1fc05a1d55e2c771c06ada', label: 'Maker D3M' },
  { address: '0x9b53e429b0baedd0b67bad43a78cfdb0f9a434cf', label: 'Euler Lending' },
  { address: '0xf403c135812408bfbe8713b5a23a04b3d48aae31', label: 'Cream Finance' },
  { address: '0xefa28233838f42f4ffa7f2a1f5a18241c4cbb2c3', label: 'Maple Finance' },
  { address: '0x68749665ff8d2d112fa859aa293f07a622782f38', label: 'Goldfinch Senior Pool' },
];

export const LENDING_CONTRACT_ADDRESSES = LENDING_CONTRACTS.map(
  (entry) => entry.address,
);

export const LENDING_CONTRACT_LABELS = LENDING_CONTRACTS.reduce<Record<string, string>>(
  (acc, entry) => {
    acc[entry.address.toLowerCase()] = entry.label;
    return acc;
  },
  {},
);

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('0x')) return null;
  return value.toLowerCase();
}


