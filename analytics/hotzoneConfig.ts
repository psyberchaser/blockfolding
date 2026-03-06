import type { HotzoneOptions } from './hotzones.js';

const BASE_OPTIONS: HotzoneOptions = {
  bandwidth: 0.15,
  threshold: 0.02,
  maxZones: 16,
};

const CHAIN_OVERRIDES: Record<string, HotzoneOptions> = {
  eth: {
    bandwidth: 0.12,
    threshold: 0.015,
    maxZones: 18,
  },
  avax: {
    bandwidth: 0.18,
    threshold: 0.02,
    maxZones: 20,
  },
};

export function resolveHotzoneOptions(chain: string, overrides: HotzoneOptions = {}): HotzoneOptions {
  const chainOptions = CHAIN_OVERRIDES[chain] ?? {};
  return {
    ...BASE_OPTIONS,
    ...chainOptions,
    ...overrides,
    contextTags: overrides.contextTags ?? [],
  };
}

