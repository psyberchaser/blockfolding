import type { MempoolSnapshot } from './mempool.js';
import type { PredictionSignal } from './predictions.js';

export interface HeartbeatEventPayload {
  digest: string | null;
  chain: string | null;
  height: number | null;
  timestamp: number | null;
  serverTime: number | null;
  mempool: MempoolSnapshot[];
  predictions: PredictionSignal[];
}

export const HEARTBEAT_EVENT = 'heartbeat:update';

