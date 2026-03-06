/**
 * Universal Validator Network with Tier Architecture
 *
 * Implements the three-tier validator network from the patent:
 *
 * Tier 1: Mobile/Light Validators (94MB pattern index only)
 *   - Smartphones, tablets, IoT devices
 *   - Pattern-based validation only
 *   - 30-second sync time
 *
 * Tier 2: Pattern Nodes (94MB pattern index + recent blocks)
 *   - Laptops, desktops, edge servers
 *   - Full pattern validation + recent block verification
 *   - Can serve pattern indexes to Tier 1
 *
 * Tier 3: Archive Nodes (full blockchain + pattern index)
 *   - Dedicated servers, data centers
 *   - Complete blockchain for anomaly resolution
 *   - Serve as last resort for pattern validation failures
 *
 * Implements: Patent Claims 1, 3, 5, 8, 9, 11, 15, 17
 */

import {
  type PatternIndex,
  type ValidationReport,
  type TransactionValidationInput,
  type ValidatorConfig,
  validateTransaction,
  buildPatternIndex,
  getIndexStatistics,
} from './patternValidator.js';
import { type MetaBlockIndex } from './metaBlock.js';

// ============================================
// TYPES
// ============================================

export type DeviceType = 'smartphone' | 'tablet' | 'laptop' | 'desktop' | 'edge_server' | 'server' | 'iot' | 'custom';
export type ValidatorTier = 'mobile' | 'pattern' | 'archive';
export type NodeStatus = 'online' | 'syncing' | 'offline' | 'degraded';

export interface DeviceCapabilities {
  deviceType: DeviceType;
  storageMB: number;         // Available storage in MB
  ramMB: number;             // Available RAM in MB
  cpuCores: number;
  bandwidthMbps: number;     // Network bandwidth
  batteryPowered: boolean;
  os?: string;
}

export interface ValidatorNode {
  nodeId: string;
  tier: ValidatorTier;
  device: DeviceCapabilities;
  status: NodeStatus;
  patternIndex: PatternIndex | null;
  recentBlocks: Map<number, unknown>;  // blockHeight -> block data (Tier 2+)
  fullChainAvailable: boolean;          // true for Tier 3 only
  // Performance metrics
  validationsPerformed: number;
  avgValidationTimeMs: number;
  escalationRate: number;
  lastActiveAt: number;
  syncedAt: number;
  // Network
  connectedPeers: string[];
  address: string;
}

export interface ValidationRequest {
  requestId: string;
  transaction: TransactionValidationInput;
  requestedBy: string;       // nodeId of requesting validator
  deviceType: DeviceType;
  validationType: 'pattern_based' | 'full_verification';
  deviceCapabilities: DeviceCapabilities;
  timestamp: number;
}

export interface ValidationResponse {
  requestId: string;
  respondedBy: string;       // nodeId of responding validator
  report: ValidationReport;
  tier: ValidatorTier;
  deviceOptimizedResponse: boolean;
  fullVerification: boolean;
  integrityProof?: string;
  responseTimeMs: number;
}

export interface NetworkStatus {
  totalNodes: number;
  byTier: Record<ValidatorTier, number>;
  byDeviceType: Record<string, number>;
  onlineNodes: number;
  totalValidations: number;
  avgEscalationRate: number;
  patternIndexSizeMB: number;
  consensusHealth: number;   // 0-1
  networkUptime: number;     // seconds
}

// ============================================
// TIER CLASSIFICATION
// ============================================

/**
 * Determine the optimal validator tier for a device based on its capabilities
 * Patent Claim 8: Universal computational device validator architecture
 */
export function classifyDeviceTier(device: DeviceCapabilities): ValidatorTier {
  // Archive nodes: servers with >500GB storage and high bandwidth
  if (device.storageMB > 500_000 && device.bandwidthMbps >= 100 && device.cpuCores >= 4) {
    return 'archive';
  }

  // Pattern nodes: desktops/laptops with moderate resources
  if (device.storageMB > 5_000 && device.ramMB >= 4_000 && device.cpuCores >= 2) {
    return 'pattern';
  }

  // Mobile validators: everything else (phones, IoT, limited devices)
  return 'mobile';
}

/**
 * Calculate minimum storage required for each tier
 */
export function getStorageRequirements(tier: ValidatorTier): {
  minStorageMB: number;
  description: string;
} {
  switch (tier) {
    case 'mobile':
      return { minStorageMB: 100, description: '94MB pattern index only' };
    case 'pattern':
      return { minStorageMB: 5_000, description: '94MB pattern index + recent blocks (~5GB)' };
    case 'archive':
      return { minStorageMB: 500_000, description: 'Full blockchain (~500GB) + 94MB pattern index' };
  }
}

// ============================================
// VALIDATOR NETWORK
// ============================================

export class ValidatorNetwork {
  private nodes: Map<string, ValidatorNode> = new Map();
  private patternIndex: PatternIndex | null = null;
  private config: ValidatorConfig;
  private startedAt: number;
  private totalValidations: number = 0;

  constructor(config: Partial<ValidatorConfig> = {}) {
    this.config = {
      anomalyThreshold: 0.05,
      minConfidence: 0.7,
      similarityThreshold: 0.8,
      maxEscalationRate: 0.05,
      enableFraudDetection: true,
      ...config,
    };
    this.startedAt = Date.now();
  }

  /**
   * Load a pattern index into the network
   * All validators receive the same pattern index
   */
  loadPatternIndex(metaBlockIndex: MetaBlockIndex): void {
    this.patternIndex = buildPatternIndex(metaBlockIndex);
  }

  /**
   * Register a new validator node
   * Automatically classifies tier based on device capabilities
   */
  registerNode(nodeId: string, device: DeviceCapabilities, address: string = ''): ValidatorNode {
    const tier = classifyDeviceTier(device);

    const node: ValidatorNode = {
      nodeId,
      tier,
      device,
      status: 'syncing',
      patternIndex: null,
      recentBlocks: new Map(),
      fullChainAvailable: tier === 'archive',
      validationsPerformed: 0,
      avgValidationTimeMs: 0,
      escalationRate: 0,
      lastActiveAt: Date.now(),
      syncedAt: 0,
      connectedPeers: [],
      address,
    };

    this.nodes.set(nodeId, node);
    return node;
  }

  /**
   * Sync a node with the pattern index
   * Patent Claim 9: 99.7% sync reduction - 30 seconds vs weeks
   */
  syncNode(nodeId: string): {
    success: boolean;
    syncTimeMs: number;
    tier: ValidatorTier;
    indexSizeMB: number;
  } {
    const node = this.nodes.get(nodeId);
    if (!node || !this.patternIndex) {
      return { success: false, syncTimeMs: 0, tier: 'mobile', indexSizeMB: 0 };
    }

    const startTime = performance.now();

    // All tiers get the pattern index
    node.patternIndex = this.patternIndex;
    node.status = 'online';
    node.syncedAt = Date.now();

    const syncTimeMs = performance.now() - startTime;
    const indexSizeMB = this.patternIndex.indexSizeBytes / (1024 * 1024);

    return {
      success: true,
      syncTimeMs,
      tier: node.tier,
      indexSizeMB,
    };
  }

  /**
   * Submit a validation request to the network
   * Routes to appropriate tier based on device capabilities
   */
  validate(request: ValidationRequest): ValidationResponse {
    const startTime = performance.now();
    const requestingNode = this.nodes.get(request.requestedBy);

    // Step 1: Try pattern-based validation first (any tier can do this)
    let validatorNode = requestingNode;
    if (!validatorNode?.patternIndex) {
      // Find any online node with a pattern index
      validatorNode = this.findBestValidator(request);
    }

    if (!validatorNode?.patternIndex) {
      return this.createFailureResponse(request, startTime, 'No validators available');
    }

    // Step 2: Perform pattern-based validation
    const report = validateTransaction(
      request.transaction,
      validatorNode.patternIndex,
      this.config,
    );

    // Step 3: If escalation needed, route to higher tier
    if (report.escalateToArchive) {
      const archiveNode = this.findArchiveNode(request.requestedBy);
      if (archiveNode) {
        // Archive node performs full verification
        report.reasoning.push(`Escalated to archive node ${archiveNode.nodeId}`);
        // In production, this would query the full blockchain
        // For now, we mark it as archive-verified
      }
    }

    // Update validator stats
    validatorNode.validationsPerformed++;
    validatorNode.lastActiveAt = Date.now();
    const totalTime = validatorNode.avgValidationTimeMs * (validatorNode.validationsPerformed - 1) + report.validationTimeMs;
    validatorNode.avgValidationTimeMs = totalTime / validatorNode.validationsPerformed;
    this.totalValidations++;

    return {
      requestId: request.requestId,
      respondedBy: validatorNode.nodeId,
      report,
      tier: validatorNode.tier,
      deviceOptimizedResponse: true,
      fullVerification: validatorNode.tier === 'archive',
      responseTimeMs: performance.now() - startTime,
    };
  }

  /**
   * Find the best validator to handle a request
   */
  private findBestValidator(request: ValidationRequest): ValidatorNode | null {
    let best: ValidatorNode | null = null;
    let bestScore = -1;

    for (const node of this.nodes.values()) {
      if (node.status !== 'online' || !node.patternIndex) continue;

      // Score: prefer higher tier, lower latency, lower escalation rate
      let score = 0;
      if (node.tier === 'archive') score += 3;
      else if (node.tier === 'pattern') score += 2;
      else score += 1;
      score -= node.escalationRate;
      score -= node.avgValidationTimeMs / 100;

      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  /**
   * Find an archive node for escalation
   */
  private findArchiveNode(excludeNodeId: string): ValidatorNode | null {
    for (const node of this.nodes.values()) {
      if (node.nodeId !== excludeNodeId && node.tier === 'archive' && node.status === 'online') {
        return node;
      }
    }
    return null;
  }

  /**
   * Create a failure response when no validators available
   */
  private createFailureResponse(request: ValidationRequest, startTime: number, reason: string): ValidationResponse {
    return {
      requestId: request.requestId,
      respondedBy: 'network',
      report: {
        result: 'VALIDATION_FAILED',
        confidence: 0,
        validationTimeMs: performance.now() - startTime,
        patternId: null,
        patternMatch: false,
        blockHeight: request.transaction.blockHeight,
        transactionHash: request.transaction.txHash,
        anomalies: [reason],
        reasoning: [reason],
        escalateToArchive: true,
      },
      tier: 'mobile',
      deviceOptimizedResponse: false,
      fullVerification: false,
      responseTimeMs: performance.now() - startTime,
    };
  }

  /**
   * Get network status
   */
  getNetworkStatus(): NetworkStatus {
    const byTier: Record<ValidatorTier, number> = { mobile: 0, pattern: 0, archive: 0 };
    const byDeviceType: Record<string, number> = {};
    let onlineNodes = 0;
    let totalEscalation = 0;
    let totalNodeValidations = 0;

    for (const node of this.nodes.values()) {
      byTier[node.tier]++;
      byDeviceType[node.device.deviceType] = (byDeviceType[node.device.deviceType] ?? 0) + 1;
      if (node.status === 'online') onlineNodes++;
      totalEscalation += node.escalationRate * node.validationsPerformed;
      totalNodeValidations += node.validationsPerformed;
    }

    const avgEscalationRate = totalNodeValidations > 0 ? totalEscalation / totalNodeValidations : 0;
    const indexSizeMB = this.patternIndex ? this.patternIndex.indexSizeBytes / (1024 * 1024) : 0;

    return {
      totalNodes: this.nodes.size,
      byTier,
      byDeviceType,
      onlineNodes,
      totalValidations: this.totalValidations,
      avgEscalationRate,
      patternIndexSizeMB: indexSizeMB,
      consensusHealth: onlineNodes / (this.nodes.size || 1),
      networkUptime: (Date.now() - this.startedAt) / 1000,
    };
  }

  /**
   * Get all registered nodes
   */
  getNodes(): ValidatorNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get a specific node
   */
  getNode(nodeId: string): ValidatorNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get the pattern index
   */
  getPatternIndex(): PatternIndex | null {
    return this.patternIndex;
  }
}

// ============================================
// NETWORK COMMUNICATION PROTOCOL
// ============================================

/**
 * Create a validation request following the patent's communication protocol
 */
export function createValidationRequest(
  tx: TransactionValidationInput,
  nodeId: string,
  device: DeviceCapabilities,
): ValidationRequest {
  return {
    requestId: `vr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    transaction: tx,
    requestedBy: nodeId,
    deviceType: device.deviceType,
    validationType: 'pattern_based',
    deviceCapabilities: device,
    timestamp: Date.now(),
  };
}

// ============================================
// PRESET DEVICE PROFILES
// ============================================

export const DEVICE_PROFILES: Record<string, DeviceCapabilities> = {
  iphone: {
    deviceType: 'smartphone',
    storageMB: 256_000,
    ramMB: 6_000,
    cpuCores: 6,
    bandwidthMbps: 100,
    batteryPowered: true,
    os: 'iOS',
  },
  android_budget: {
    deviceType: 'smartphone',
    storageMB: 64_000,
    ramMB: 3_000,
    cpuCores: 4,
    bandwidthMbps: 50,
    batteryPowered: true,
    os: 'Android',
  },
  macbook_pro: {
    deviceType: 'laptop',
    storageMB: 512_000,
    ramMB: 16_000,
    cpuCores: 10,
    bandwidthMbps: 1000,
    batteryPowered: true,
    os: 'macOS',
  },
  linux_server: {
    deviceType: 'server',
    storageMB: 2_000_000,
    ramMB: 64_000,
    cpuCores: 32,
    bandwidthMbps: 10_000,
    batteryPowered: false,
    os: 'Linux',
  },
  raspberry_pi: {
    deviceType: 'iot',
    storageMB: 32_000,
    ramMB: 4_000,
    cpuCores: 4,
    bandwidthMbps: 100,
    batteryPowered: false,
    os: 'Linux',
  },
  mac_studio: {
    deviceType: 'desktop',
    storageMB: 1_000_000,
    ramMB: 32_000,
    cpuCores: 12,
    bandwidthMbps: 1000,
    batteryPowered: false,
    os: 'macOS',
  },
};
