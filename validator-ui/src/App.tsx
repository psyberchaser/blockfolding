import React, { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import clsx from 'clsx'
import { Panel } from './components/Panel'
import { Metric, MetricInline } from './components/Metric'
import { StatusIndicator, StatusBar } from './components/StatusIndicator'
import { LineChart } from './components/LineChart'
import { Tooltip, TooltipContent } from './components/Tooltip'
import { RiskBadge, ProofBadge } from './components/RiskBadge'
import { ConfigPanel } from './components/ConfigPanel'
import { HudSelect } from './components/HudSelect'
import RadarHex from './components/RadarHex'
import type {
  ValidatorStatus,
  ValidatorNode,
  MetaBlockInfo,
  RealBenchmarkResult,
  FeatureResult,
  ValidationResult,
  LogEntry,
  UnfoldStatus,
  UnfoldResult,
  OnDemandResult,
  ComplianceResult,
  IngestionEvent,
  PatternDetail,
} from './types'

type Tab = 'overview' | 'benchmark' | 'features' | 'validate' | 'network' | 'meta-blocks' | 'unfold' | 'compliance' | 'ingest' | 'settings'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'benchmark', label: 'Benchmark' },
  { key: 'features', label: '8D Features' },
  { key: 'validate', label: 'Validate' },
  { key: 'network', label: 'Network' },
  { key: 'meta-blocks', label: 'Meta-Blocks' },
  { key: 'unfold', label: 'Unfold' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'ingest', label: 'Ingest' },
  { key: 'settings', label: 'Settings' },
]

const TAB_INFO: Record<Tab, string> = {
  overview: 'System health, fold index stats, and pattern coverage at a glance.',
  benchmark: 'Real-time benchmarks against ingested ETH mainnet blocks — processing speed, compression, and validation accuracy.',
  features: 'Extract the 8-dimensional feature vector from any block — size, tx count, temporal, era, protocol, difficulty, and complexity.',
  validate: 'Pattern-match a transaction against the fold index. If the pattern is recognized, validation is instant without a full node.',
  network: 'Three-tier validator network — mobile nodes (pattern index only), pattern nodes (fold artifacts), and archive nodes (full chain).',
  'meta-blocks': 'Blocks grouped by 8D pattern signature into compressed meta-blocks. Each pattern is a template + per-block deltas.',
  unfold: 'Reverse lookup — enter any address to reconstruct its transaction history from folded block data with ZK proof integrity.',
  compliance: 'AML risk assessment — transaction pattern detection, known entity labeling, counterparty network analysis, and risk scoring.',
  ingest: 'Fetch new blocks from chain RPCs, run the full fold pipeline (vectorize, fold, PQ, hotzones, ZK prove), and store.',
  settings: 'Configure RPC endpoints, enable chains, adjust ingestion parameters, and manage auto-ingest.',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [status, setStatus] = useState<ValidatorStatus | null>(null)
  const [nodes, setNodes] = useState<ValidatorNode[]>([])
  const [metaBlockInfo, setMetaBlockInfo] = useState<MetaBlockInfo | null>(null)
  const [realBenchmark, setRealBenchmark] = useState<RealBenchmarkResult | null>(null)
  const [realBenchmarkRunning, setRealBenchmarkRunning] = useState(false)
  const [realBenchmarkChain, setRealBenchmarkChain] = useState('eth')
  const [realBenchmarkCount, setRealBenchmarkCount] = useState(5)
  const [featureResult, setFeatureResult] = useState<FeatureResult | null>(null)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [validationHistory, setValidationHistory] = useState<number[]>([])
  const [unfoldStatus, setUnfoldStatus] = useState<UnfoldStatus | null>(null)
  const [unfoldResult, setUnfoldResult] = useState<UnfoldResult | null>(null)
  const [unfoldLoading, setUnfoldLoading] = useState(false)
  const [topAddresses, setTopAddresses] = useState<{ address: string; blockCount: number }[]>([])
  const [onDemandResult, setOnDemandResult] = useState<OnDemandResult | null>(null)
  const [onDemandLoading, setOnDemandLoading] = useState(false)
  const [onDemandProgress, setOnDemandProgress] = useState('')
  const [unfoldChain, setUnfoldChain] = useState('eth')
  const [complianceChain, setComplianceChain] = useState('eth')
  const [ingestChain, setIngestChain] = useState('eth')
  const [complianceResult, setComplianceResult] = useState<ComplianceResult | null>(null)
  const [complianceLoading, setComplianceLoading] = useState(false)
  const [ingestEvents, setIngestEvents] = useState<IngestionEvent[]>([])
  const [ingestRunning, setIngestRunning] = useState(false)
  const ingestAbortRef = useRef<AbortController | null>(null)
  const [expandedProofs, setExpandedProofs] = useState<Set<number>>(new Set())
  const [expandedTxs, setExpandedTxs] = useState<Set<string>>(new Set())
  const [autoIngestActive, setAutoIngestActive] = useState(false)
  const [blocksStoredCount, setBlocksStoredCount] = useState(0)
  const [feedTab, setFeedTab] = useState<'live' | 'backfill'>('live')
  const [backfillStartBlock, setBackfillStartBlock] = useState('')
  const feedTopRef = useRef<HTMLDivElement>(null)
  const miniLogEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll feeds to top when new events arrive (latest on top)
  useEffect(() => {
    feedTopRef.current?.scrollIntoView({ behavior: 'smooth' })
    miniLogEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [ingestEvents])

  const addLog = useCallback((source: string, message: string, level: LogEntry['level'] = 'info') => {
    setLogs(prev => [{
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      source, message, level,
    }, ...prev].slice(0, 50))
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/validator/status')
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
      }
    } catch (_e) { /* offline */ }
  }, [])

  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch('/validator/nodes')
      if (res.ok) {
        const data = await res.json()
        setNodes(data.nodes ?? data)
      }
    } catch (_e) { /* offline */ }
  }, [])

  const fetchMetaBlocks = useCallback(async () => {
    try {
      const res = await fetch('/validator/meta-blocks')
      if (res.ok) setMetaBlockInfo(await res.json())
    } catch (_e) { /* offline */ }
  }, [])

  const fetchUnfoldStatus = useCallback(async () => {
    try {
      const res = await fetch('/validator/unfold/status')
      if (res.ok) setUnfoldStatus(await res.json())
    } catch (_e) { /* offline */ }
  }, [])

  const fetchTopAddresses = useCallback(async () => {
    try {
      const res = await fetch('/validator/unfold/top-addresses')
      if (res.ok) {
        const data = await res.json()
        setTopAddresses(data.topAddresses ?? [])
      }
    } catch (_e) { /* offline */ }
  }, [])

  const unfoldAddress = async (address: string) => {
    if (!address) return
    setUnfoldLoading(true)
    setUnfoldResult(null)
    setOnDemandResult(null)
    addLog('unfold', `Unfolding transactions for ${address.slice(0, 10)}...`)
    try {
      const res = await fetch(`/validator/unfold/${address}`)
      if (res.ok) {
        const data = await res.json()
        setUnfoldResult(data)
        if (data.found) {
          addLog('unfold', `Found ${data.transactionCount} transactions across ${data.blockCount} blocks`, 'success')
        } else {
          addLog('unfold', `Address not found in indexed blocks — use "Fetch from Chain" for on-demand`, 'warning')
        }
      } else {
        addLog('unfold', 'Unfold failed: ' + res.statusText, 'error')
      }
    } catch (e) {
      addLog('unfold', `Error: ${e}`, 'error')
    }
    setUnfoldLoading(false)
  }

  const unfoldOnDemand = async (address: string, chain: string) => {
    if (!address) return
    setOnDemandLoading(true)
    setOnDemandResult(null)
    setOnDemandProgress(`Discovering blocks on ${chain.toUpperCase()}...`)
    addLog('unfold', `On-demand: discovering ${address.slice(0, 10)}... on ${chain}`)
    try {
      const res = await fetch('/validator/unfold/on-demand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, chain }),
      })
      if (res.ok) {
        const data = await res.json()
        setOnDemandResult(data)
        setUnfoldResult(data)
        if (data.found) {
          addLog('unfold', `Layer ${data.layer}: ${data.transactionCount} tx across ${data.blockCount} blocks (${data.ingestionTimeMs}ms)`, 'success')
        } else {
          addLog('unfold', `No transactions found for address on ${chain}`, 'warning')
        }
      } else {
        addLog('unfold', 'On-demand failed: ' + res.statusText, 'error')
      }
    } catch (e) {
      addLog('unfold', `Error: ${e}`, 'error')
    }
    setOnDemandLoading(false)
    setOnDemandProgress('')
  }

  const [complianceThreshold, setComplianceThreshold] = useState(1)

  const fetchCompliance = async (address: string) => {
    if (!address) return
    setComplianceLoading(true)
    setComplianceResult(null)
    addLog('compliance', `Running AML compliance check on ${address.slice(0, 10)}...`)
    try {
      const thresholdWei = complianceThreshold * 1e18
      const res = await fetch(`/validator/unfold/${address}/compliance?threshold=${thresholdWei}`)
      if (res.ok) {
        const data = await res.json()
        setComplianceResult(data)
        if (data.found) {
          addLog('compliance', `Risk: ${data.riskLevel} (${(data.riskScore * 100).toFixed(0)}%), ${data.alerts?.length || 0} alerts, ${data.flaggedTransactions.length} flagged`, data.riskLevel === 'high' ? 'warning' : 'success')
        } else {
          addLog('compliance', 'Address not found in index', 'warning')
        }
      }
    } catch (e) {
      addLog('compliance', `Error: ${e}`, 'error')
    }
    setComplianceLoading(false)
  }

  const exportComplianceReport = () => {
    if (!complianceResult) return
    const r = complianceResult
    const lines = [
      `BLOCKFOLD COMPLIANCE REPORT`,
      `Generated: ${r.analysisTimestamp || new Date().toISOString()}`,
      `${'='.repeat(60)}`,
      ``,
      `SUBJECT ADDRESS: ${r.address}`,
      `RISK LEVEL: ${r.riskLevel.toUpperCase()}`,
      `RISK SCORE: ${(r.riskScore * 100).toFixed(1)}%`,
      `THRESHOLD: ${(r.threshold / 1e18).toFixed(2)} ${complianceChain.toUpperCase()}`,
      ``,
      `--- RISK BREAKDOWN ---`,
      ...(r.riskBreakdown || []).map((f: any) => `  ${f.factor}: ${(f.score * 100).toFixed(1)}% (weight: ${(f.weight * 100).toFixed(0)}%) — ${f.detail}`),
      ``,
      `--- ALERTS (${(r.alerts || []).length}) ---`,
      ...(r.alerts || []).map((a: any) => `  [${a.severity.toUpperCase()}] ${a.type}: ${a.description}\n    Evidence: ${a.evidence.join(', ')}`),
      ``,
      `--- FLAGGED TRANSACTIONS (${r.flaggedTransactions.length}) ---`,
      ...r.flaggedTransactions.slice(0, 20).map((tx: any) => `  Block #${tx.blockHeight} | ${tx.hash?.slice(0, 18)}... | ${tx.direction.toUpperCase()} | ${(Number(tx.amountWei || 0) / 1e18).toFixed(4)} ETH${tx.entityLabel ? ` | ${tx.entityLabel}` : ''}`),
      ``,
      `--- COUNTERPARTY NETWORK (${r.counterpartyGraph.nodes.length} nodes, ${r.counterpartyGraph.edges.length} edges) ---`,
      ...r.counterpartyGraph.edges.slice(0, 20).map((e: any) => `  ${e.to.slice(0, 18)}... | ${e.count} txs | ${(e.value / 1e18).toFixed(4)} ETH | ${e.direction}${e.entityLabel ? ` | ${e.entityLabel}` : ''}`),
      ``,
      `--- PATTERN FLAGS ---`,
      `  ${r.patternFlags.join(', ') || 'None'}`,
      ``,
      `${'='.repeat(60)}`,
      `Patent: USPTO 63/906,240 | BLOCKFOLD Pattern-Based Validation`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `compliance-report-${r.address.slice(0, 10)}-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Persistent SSE connection for ingest events (captures both manual and auto-ingest)
  useEffect(() => {
    const evtSource = new EventSource('/validator/ingest/live')
    evtSource.onmessage = (e) => {
      try {
        const event: IngestionEvent = JSON.parse(e.data)
        if (event.stage === 'connected') {
          addLog('ingest', 'SSE connected to ingestion stream', 'info')
          return
        }
        setIngestEvents(prev => [event, ...prev].slice(0, 200))
        if (event.stage === 'stored') setBlocksStoredCount(prev => prev + 1)
      } catch {}
    }
    evtSource.onerror = () => {
      addLog('ingest', 'SSE connection lost, reconnecting...', 'warning')
    }
    return () => evtSource.close()
  }, [])

  const triggerIngest = async (chain: string, count: number, startBlock?: number) => {
    const abort = new AbortController()
    ingestAbortRef.current = abort
    setIngestRunning(true)
    const isBackfill = startBlock != null && startBlock > 0
    if (isBackfill) setFeedTab('backfill')
    addLog('ingest', `${isBackfill ? 'Backfilling' : 'Ingesting'} ${count} blocks from ${chain}${isBackfill ? ` starting at #${startBlock}` : ''}...`)

    try {
      const body: Record<string, unknown> = { chain, count }
      if (isBackfill) body.startBlock = startBlock
      const res = await fetch('/validator/ingest/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
      if (res.ok) {
        const data = await res.json()
        addLog('ingest', `Done: ${data.ingested} blocks ${isBackfill ? 'backfilled' : 'ingested'}`, 'success')
      }
    } catch (e) {
      if (abort.signal.aborted) {
        addLog('ingest', 'Ingestion cancelled by user', 'warning')
      } else {
        addLog('ingest', `Error: ${e}`, 'error')
      }
    }

    ingestAbortRef.current = null
    setIngestRunning(false)
  }

  const cancelIngest = () => {
    ingestAbortRef.current?.abort()
    fetch('/validator/ingest/cancel', { method: 'POST' }).catch(() => {})
  }

  const checkAutoIngest = useCallback(() => {
    fetch('/validator/config').then(r => r.json()).then(cfg => {
      setAutoIngestActive(!!cfg?.ingestion?.autoIngest)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchNodes()
    fetchMetaBlocks()
    fetchUnfoldStatus()
    checkAutoIngest()
    const interval = setInterval(() => {
      fetchStatus()
      fetchNodes()
      fetchUnfoldStatus()
      checkAutoIngest()
    }, 5000)
    return () => clearInterval(interval)
  }, [fetchStatus, fetchNodes, fetchMetaBlocks, fetchUnfoldStatus, checkAutoIngest])

  const runRealBenchmark = async () => {
    setRealBenchmarkRunning(true)
    setRealBenchmark(null)
    addLog('benchmark', `Running real pipeline on ${realBenchmarkCount} ${realBenchmarkChain} blocks...`, 'info')
    try {
      const res = await fetch(`/validator/benchmark/real?count=${realBenchmarkCount}&chain=${realBenchmarkChain}`)
      if (res.ok) {
        const data = await res.json()
        setRealBenchmark(data)
        addLog('benchmark', `Complete: ${data.blocksPerSec.toFixed(2)} blocks/sec across ${data.blockCount} blocks`, 'success')
      } else {
        addLog('benchmark', 'Benchmark failed: ' + res.statusText, 'error')
      }
    } catch (e) {
      addLog('benchmark', `Error: ${e}`, 'error')
    }
    setRealBenchmarkRunning(false)
  }

  const extractFeatures = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const body = {
      sizeBytes: Number(form.get('sizeBytes')),
      txCount: Number(form.get('txCount')),
      timestamp: Math.floor(Date.now() / 1000),
      blockHeight: Number(form.get('blockHeight')),
      chain: 'eth',
    }
    addLog('features', `Extracting 8D features for block #${body.blockHeight}...`)
    try {
      const res = await fetch('/validator/extract-features', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json()
        setFeatureResult(data)
        addLog('features', `Pattern: ${data.signature.hash.slice(0, 12)}...`, 'success')
      }
    } catch (e) {
      addLog('features', `Error: ${e}`, 'error')
    }
  }

  const validateTx = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const body = {
      txHash: form.get('txHash') as string || `0x${Math.random().toString(16).slice(2)}`,
      blockHeight: Number(form.get('vBlockHeight')),
      blockSize: Number(form.get('vBlockSize')),
      txCount: Number(form.get('vTxCount')),
      timestamp: Math.floor(Date.now() / 1000),
      txIndex: 0,
      chain: 'eth',
    }
    addLog('validator', `Validating tx ${body.txHash.slice(0, 10)}...`)
    try {
      const res = await fetch('/validator/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json()
        setValidationResult(data)
        setValidationHistory(prev => [...prev, data.confidence].slice(-30))
        const color = data.result === 'SUCCESS' || data.result === 'PATTERN_MATCH' ? 'success' : 'warning'
        addLog('validator', `${data.result} (${(data.confidence * 100).toFixed(1)}% confidence, ${data.validationTimeMs.toFixed(3)}ms)`, color as LogEntry['level'])
      }
    } catch (e) {
      addLog('validator', `Error: ${e}`, 'error')
    }
  }

  const registerDemoNodes = async () => {
    const devices = [
      { nodeId: 'iphone-15-pro', device: { deviceType: 'iPhone 15 Pro', storageMB: 256000, ramMB: 8192, cpuCores: 6, bandwidthMbps: 100, batteryPowered: true, os: 'iOS' }, address: '192.168.1.10' },
      { nodeId: 'pixel-8', device: { deviceType: 'Pixel 8', storageMB: 128000, ramMB: 8192, cpuCores: 8, bandwidthMbps: 50, batteryPowered: true, os: 'Android' }, address: '192.168.1.11' },
      { nodeId: 'macbook-pro-m3', device: { deviceType: 'MacBook Pro M3', storageMB: 1000000, ramMB: 36864, cpuCores: 12, bandwidthMbps: 1000, batteryPowered: true, os: 'macOS' }, address: '192.168.1.12' },
      { nodeId: 'rpi-5', device: { deviceType: 'Raspberry Pi 5', storageMB: 64000, ramMB: 8192, cpuCores: 4, bandwidthMbps: 100, batteryPowered: false, os: 'Linux' }, address: '192.168.1.13' },
      { nodeId: 'aws-c5-xl', device: { deviceType: 'AWS c5.xlarge', storageMB: 2000000, ramMB: 8192, cpuCores: 4, bandwidthMbps: 10000, batteryPowered: false, os: 'Linux' }, address: '10.0.0.5' },
    ]
    addLog('network', 'Registering 5 demo validator nodes...')
    for (const d of devices) {
      try {
        await fetch('/validator/register-node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(d),
        })
      } catch (_e) { /* skip */ }
    }
    addLog('network', '5 nodes registered', 'success')
    fetchNodes()
  }

  const tierColor = (tier: string) => {
    switch (tier) {
      case 'mobile': return 'text-hud-cyan'
      case 'pattern': return 'text-hud-purple'
      case 'archive': return 'text-hud-success'
      default: return 'text-hud-text'
    }
  }

  const statusToIndicator = (s: string): 'active' | 'warning' | 'error' | 'inactive' => {
    if (s === 'synced' || s === 'active' || s === 'online') return 'active'
    if (s === 'syncing') return 'warning'
    return 'inactive'
  }

  return (
    <div className="min-h-screen p-4 max-w-[1920px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h1 className="text-[16px] font-light text-hud-text-bright tracking-wider">BLOCKFOLD</h1>
          <span className="text-[9px] text-hud-text-dim border border-hud-line px-2 py-0.5">PATTERN VALIDATOR</span>
          <span className="text-[9px] text-hud-purple border border-hud-purple/30 px-2 py-0.5">USPTO 63/906,240</span>
        </div>
        <div className="flex items-center gap-4">
          <StatusBar items={[
            { label: 'INDEX', value: status?.patternIndexLoaded ? 'LOADED' : 'OFFLINE', status: status?.patternIndexLoaded ? 'active' : 'error' },
            { label: 'NODES', value: status?.network?.totalNodes ?? 0, status: (status?.network?.totalNodes ?? 0) > 0 ? 'active' : 'inactive' },
            { label: 'HEALTH', value: `${((status?.network?.consensusHealth ?? 0) * 100).toFixed(0)}%`, status: (status?.network?.consensusHealth ?? 0) > 0.8 ? 'active' : 'warning' },
          ]} />
          <span className="text-[9px] text-hud-text-dim">{new Date().toLocaleTimeString('en-US', { hour12: false })}</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-4 border-b border-hud-line pb-2">
        <div className="flex gap-1 shrink-0">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                'hud-button text-[9px] py-1.5 px-3',
                tab === t.key && 'bg-hud-primary text-hud-bg'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto pl-4 text-[8px] text-hud-text-dim text-right max-w-[280px] leading-snug shrink-0 line-clamp-2">
          {TAB_INFO[tab]}
        </div>
      </div>

      {autoIngestActive && (
        <div className="flex items-center gap-3 px-4 py-2 border border-hud-success/30 bg-hud-success/5 rounded text-[10px]">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-hud-success opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-hud-success" />
          </span>
          <span className="text-hud-success font-medium uppercase tracking-wider">Auto-Ingest Active</span>
          <span className="text-hud-text-dim">Polling for new blocks every ~12s across enabled chains</span>
          <button
            className="ml-auto text-hud-text-dim hover:text-hud-error text-[9px] uppercase tracking-wider"
            onClick={() => { fetch('/validator/ingest/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).then(() => setAutoIngestActive(false)) }}
          >Stop</button>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {/* ===== OVERVIEW TAB ===== */}
          {tab === 'overview' && (
            <div className="space-y-4">
              {/* Stats row */}
              <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                <Panel title="Fold Index" className="col-span-4 md:col-span-2">
                  <StatusIndicator
                    status={status?.patternIndexLoaded ? 'active' : 'error'}
                    label={status?.patternIndexLoaded ? 'LOADED' : 'OFFLINE'}
                    pulse={status?.patternIndexLoaded}
                  />
                  <Metric label="Blocks Folded" value={(status?.index?.totalBlocksCovered ?? 0).toLocaleString()} size="lg" className="mt-2" />
                  <MetricInline label="Addresses" value={(status?.index?.totalAddresses ?? 0).toLocaleString()} className="mt-1" />
                  <MetricInline label="Transactions" value={(status?.index?.totalTransactions ?? 0).toLocaleString()} className="mt-1" />
                </Panel>

                <Panel title="Storage" className="col-span-4 md:col-span-2">
                  <Metric label="Index Size" value={`${(status?.index?.indexSizeMB ?? 0).toFixed(1)} MB`} size="lg" />
                  <Metric label="Reduction" value={status?.index?.storageReduction ?? '...'} size="md" color="success" className="mt-2" />
                  <button onClick={() => setTab('meta-blocks')} className="mt-1 flex items-center gap-1 hover:text-hud-cyan transition-colors">
                    <MetricInline label="Patterns" value={status?.index?.totalPatterns ?? '...'} />
                    <span className="text-[7px] text-hud-text-dim">▶</span>
                  </button>
                  <button onClick={async () => { await fetch('/validator/meta-blocks/rebuild', { method: 'POST' }); fetchStatus(); }} className="hud-button w-full mt-2 text-[8px] py-1">Rebuild Index</button>
                </Panel>

                <Panel title="Network" className="col-span-4 md:col-span-2">
                  <Metric label="Total Nodes" value={status?.network?.totalNodes ?? 0} size="lg" />
                  <div className="flex gap-3 mt-2">
                    <MetricInline label="Mobile" value={status?.network?.byTier.mobile ?? 0} />
                    <MetricInline label="Pattern" value={status?.network?.byTier.pattern ?? 0} />
                    <MetricInline label="Archive" value={status?.network?.byTier.archive ?? 0} />
                  </div>
                </Panel>

                <Panel title="Validations" className="col-span-4 md:col-span-2">
                  <Metric label="Total" value={status?.network?.totalValidations ?? 0} size="lg" />
                  <Metric label="Consensus" value={`${((status?.network?.consensusHealth ?? 0) * 100).toFixed(1)}%`} size="md" color={(status?.network?.consensusHealth ?? 0) > 0.8 ? 'success' : 'warning'} className="mt-2" />
                </Panel>

                <Panel title="Patent Claims" className="col-span-4 md:col-span-4">
                  {realBenchmark ? (
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(realBenchmark.patentClaims).map(([key, pass]) => (
                        <ClaimBadge key={key} label={key} pass={pass as boolean} />
                      ))}
                    </div>
                  ) : (
                    <div className="text-hud-text-dim text-xs">Run benchmark to verify claims</div>
                  )}
                </Panel>
              </div>

              {/* Pattern breakdown */}
              {metaBlockInfo && (
                <Panel title="Pattern Breakdown" titleRight={<button onClick={() => setTab('meta-blocks')} className="text-[9px] text-hud-text-dim hover:text-hud-cyan transition-colors">View All ▶</button>}>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {metaBlockInfo.byEra && Object.entries(metaBlockInfo.byEra).slice(0, 6).map(([era, info]) => (
                      <div key={era} className="border border-hud-line/30 rounded p-2">
                        <div className="text-[10px] text-hud-purple font-medium mb-1">{era}</div>
                        <div className="text-[14px] text-hud-text-bright">{info.metaBlocks}</div>
                        <div className="text-[8px] text-hud-text-dim">{info.blocks.toLocaleString()} blocks</div>
                        <div className="w-full h-1 bg-hud-bg mt-1 rounded">
                          <div className="h-full bg-hud-purple/60 rounded" style={{ width: `${(info.blocks / metaBlockInfo.totalBlocks) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {/* Architecture diagram + activity */}
              <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                <Panel title="Three-Tier Architecture" titleRight="USPTO Claim 5" className="col-span-4 md:col-span-8 lg:col-span-7">
                  <ThreeTierDiagram nodes={nodes} />
                </Panel>

                <Panel title="Activity Feed" className="col-span-4 lg:col-span-5">
                  <div className="space-y-1 max-h-[300px] overflow-y-auto">
                    {logs.length === 0 && <div className="text-hud-text-dim text-xs">No activity yet</div>}
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-2 text-[10px]">
                        <span className="text-hud-text-dim shrink-0">{log.timestamp}</span>
                        <span className={clsx('shrink-0', {
                          'text-hud-cyan': log.source === 'features',
                          'text-hud-purple': log.source === 'validator',
                          'text-hud-success': log.source === 'benchmark',
                          'text-hud-warning': log.source === 'network',
                        })}>[{log.source}]</span>
                        <span className={clsx({
                          'text-hud-text': log.level === 'info',
                          'text-hud-success': log.level === 'success',
                          'text-hud-warning': log.level === 'warning',
                          'text-hud-error': log.level === 'error',
                        })}>{log.message}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>

              {/* Validation confidence chart */}
              {validationHistory.length > 1 && (
                <Panel title="Validation Confidence History" className="h-[200px]">
                  <LineChart
                    series={[{ label: 'Confidence', data: validationHistory }]}
                    variant="cyan"
                    formatValue={(v) => `${(v * 100).toFixed(0)}%`}
                    height={140}
                  />
                </Panel>
              )}
            </div>
          )}

          {/* ===== BENCHMARK TAB ===== */}
          {tab === 'benchmark' && (
            <div className="space-y-4">
              <div className="flex items-center gap-4 flex-wrap">
                <button onClick={runRealBenchmark} disabled={realBenchmarkRunning} className="hud-button">
                  {realBenchmarkRunning ? 'Running Pipeline...' : 'Run Real Pipeline'}
                </button>
                <select value={realBenchmarkChain} onChange={e => setRealBenchmarkChain(e.target.value)} className="hud-select text-xs">
                  <option value="eth">Ethereum</option>
                  <option value="avax">Avalanche</option>
                </select>
                <select value={realBenchmarkCount} onChange={e => setRealBenchmarkCount(Number(e.target.value))} className="hud-select text-xs">
                  {[3, 5, 10, 20].map(n => <option key={n} value={n}>{n} blocks</option>)}
                </select>
                <span className="text-[9px] text-hud-text-dim">Fetches live blocks from chain RPC, runs full compute pipeline</span>
              </div>

              {realBenchmarkRunning && (
                <Panel title="Running Real Pipeline..." className="animate-pulse">
                  <div className="text-hud-cyan text-xs">Fetching blocks from {realBenchmarkChain} RPC and running vectorize &rarr; fold &rarr; PQ &rarr; hotzones &rarr; hypergraph &rarr; metrics...</div>
                </Panel>
              )}

              {realBenchmark && (
                <>
                  <div className="hud-panel p-3 flex items-center gap-4 border-l-2 border-hud-success">
                    <StatusIndicator status="active" />
                    <div>
                      <span className="text-[10px] text-hud-success font-medium">Real Pipeline ({realBenchmark.chain.toUpperCase()})</span>
                      <span className="text-[9px] text-hud-text-dim ml-3">Blocks {realBenchmark.blockRange} ({realBenchmark.blockCount} blocks)</span>
                    </div>
                  </div>

                  {/* Stage breakdown */}
                  <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                    <Panel title="Pipeline Throughput" className="col-span-4 md:col-span-4">
                      <Metric label="End-to-End" value={`${realBenchmark.blocksPerSec.toFixed(2)} blocks/sec`} size="lg" />
                      <div className="mt-3 space-y-1">
                        <MetricInline label="Compute Only" value={realBenchmark.comparison.computeOnly} />
                        <MetricInline label="End-to-End" value={realBenchmark.comparison.endToEnd} />
                        <MetricInline label="RPC Bottleneck" value={realBenchmark.comparison.rpcPct} />
                      </div>
                    </Panel>

                    <Panel title="Stage Breakdown (avg ms)" className="col-span-4 md:col-span-8">
                      <div className="space-y-2">
                        {Object.entries(realBenchmark.stages).map(([stage, timing]: [string, { avgMs: number; minMs: number; maxMs: number }]) => {
                          const maxMs = Math.max(...Object.values(realBenchmark.stages).map((s: { avgMs: number }) => s.avgMs))
                          const pct = maxMs > 0 ? (timing.avgMs / maxMs) * 100 : 0
                          return (
                            <div key={stage} className="flex items-center gap-2">
                              <span className="text-[9px] text-hud-text w-28 shrink-0 text-right">{stage}</span>
                              <div className="flex-1 h-4 bg-hud-bg rounded overflow-hidden">
                                <div className={`h-full ${stage === 'rpcFetch' ? 'bg-hud-warning' : 'bg-hud-cyan'}`} style={{ width: `${Math.max(pct, 1)}%` }} />
                              </div>
                              <span className="text-[10px] text-hud-text-bright w-20 shrink-0">{timing.avgMs.toFixed(1)}ms</span>
                            </div>
                          )
                        })}
                      </div>
                    </Panel>
                  </div>

                  {/* Per-block table */}
                  <Panel title="Per-Block Results">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="text-hud-text-dim border-b border-hud-border">
                            <th className="text-left p-1">Block</th>
                            <th className="text-right p-1">Txs</th>
                            <th className="text-right p-1">Total (ms)</th>
                            <th className="text-right p-1">RPC</th>
                            <th className="text-right p-1">Fold</th>
                            <th className="text-right p-1">Hotzones</th>
                            <th className="text-right p-1">Tags</th>
                          </tr>
                        </thead>
                        <tbody>
                          {realBenchmark.perBlock.map(b => (
                            <tr key={b.height} className="border-b border-hud-border/30 hover:bg-hud-panel-alt/30">
                              <td className="p-1 text-hud-cyan">#{b.height.toLocaleString()}</td>
                              <td className="p-1 text-right">{b.txCount}</td>
                              <td className="p-1 text-right text-hud-text-bright">{b.totalMs.toFixed(0)}</td>
                              <td className="p-1 text-right text-hud-warning">{(b.stages.rpcFetch ?? 0).toFixed(0)}</td>
                              <td className="p-1 text-right">{(b.stages.foldAndCompress ?? 0).toFixed(0)}</td>
                              <td className="p-1 text-right">{(b.stages.hotzones ?? 0).toFixed(0)}</td>
                              <td className="p-1 text-right">{(b.stages.tags ?? 0).toFixed(0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>

                  {/* Time comparison */}
                  <Panel title="Bottleneck Analysis" titleRight="Compute vs RPC">
                    <div className="grid grid-cols-3 gap-4">
                      <div className="text-center">
                        <div className="text-[20px] text-hud-cyan font-bold">{realBenchmark.comparison.avgComputeMs.toFixed(1)}ms</div>
                        <div className="text-[9px] text-hud-text-dim">Avg Compute / Block</div>
                      </div>
                      <div className="text-center">
                        <div className="text-[20px] text-hud-warning font-bold">{realBenchmark.comparison.avgRpcMs.toFixed(0)}ms</div>
                        <div className="text-[9px] text-hud-text-dim">Avg RPC Fetch / Block</div>
                      </div>
                      <div className="text-center">
                        <div className="text-[20px] text-hud-success font-bold">{realBenchmark.comparison.rpcPct}</div>
                        <div className="text-[9px] text-hud-text-dim">RPC as % of Total</div>
                      </div>
                    </div>
                  </Panel>
                </>
              )}

              <Panel title="Patent Claims Summary" titleRight="USPTO 63/906,240">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { num: 1, desc: 'Pattern-based blockchain validation using 8D features' },
                    { num: 2, desc: 'Eight-dimensional feature recognition with weighted similarity' },
                    { num: 3, desc: 'Meta-block compression with reconstruction capability' },
                    { num: 4, desc: 'Validation engine operating on pattern index only' },
                    { num: 5, desc: 'Three-tier validator network (mobile/pattern/archive)' },
                    { num: 6, desc: 'Storage reduction via meta-block templates' },
                    { num: 7, desc: 'Pattern signature generation via SHA256' },
                    { num: 8, desc: 'Device capability classification and auto-tiering' },
                    { num: 9, desc: 'Validation request routing with escalation' },
                    { num: 10, desc: 'Sub-millisecond pattern lookups' },
                  ].map(claim => (
                    <Tooltip key={claim.num} content={<TooltipContent title={`Claim ${claim.num}`} description={claim.desc} />}>
                      <div className="hud-panel p-2 flex items-center gap-2 cursor-default">
                        <span className="text-[10px] text-hud-purple font-medium">C{claim.num}</span>
                        <span className="text-[9px] text-hud-text truncate">{claim.desc.slice(0, 40)}...</span>
                      </div>
                    </Tooltip>
                  ))}
                </div>
              </Panel>
            </div>
          )}

          {/* ===== 8D FEATURES TAB ===== */}
          {tab === 'features' && (
            <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
              <Panel title="8D Feature Extractor" titleRight="Patent Claim 2" className="col-span-4 md:col-span-5">
                <form onSubmit={extractFeatures} className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="hud-label block mb-1">Block Height</label>
                      <input name="blockHeight" defaultValue="24288271" className="hud-input w-full" />
                    </div>
                    <div>
                      <label className="hud-label block mb-1">Size (bytes)</label>
                      <input name="sizeBytes" defaultValue="358400" className="hud-input w-full" />
                    </div>
                    <div>
                      <label className="hud-label block mb-1">Tx Count</label>
                      <input name="txCount" defaultValue="539" className="hud-input w-full" />
                    </div>
                  </div>
                  <button type="submit" className="hud-button">Extract Features</button>
                </form>

                {featureResult && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4 space-y-3">
                    <div className="grid grid-cols-4 gap-2">
                      {Object.entries(featureResult.features).map(([key, val]) => (
                        <div key={key} className="hud-panel p-2">
                          <span className="hud-label block">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                          <span className="hud-value-sm text-hud-cyan">{String(val)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="hud-panel p-2">
                      <span className="hud-label block mb-1">Pattern Signature</span>
                      <span className="text-[10px] text-hud-purple break-all">{featureResult.signature.hash}</span>
                    </div>
                    <div className="hud-panel p-2">
                      <span className="hud-label block mb-1">Group Key</span>
                      <span className="text-[10px] text-hud-text break-all">{featureResult.signature.groupKey}</span>
                    </div>
                  </motion.div>
                )}
              </Panel>

              {/* Hexagonal Radar Chart */}
              <Panel title="8D Feature Radar" className="col-span-4 md:col-span-7">
                <div className="flex items-center justify-center">
                  <RadarHex
                    labels={['Size', 'TxCount', 'Hour', 'Day', 'Era', 'Protocol', 'Difficulty', 'Complexity']}
                    values={featureResult
                      ? featureResult.signature.numericVector.map((v, i) => {
                          const maxVals = [5, 5, 23, 6, 7, 10, 5, 5]
                          return Math.min(1, v / (maxVals[i] || 1))
                        })
                      : [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]}
                    size={280}
                  />
                </div>
                {!featureResult && (
                  <div className="text-center text-[9px] text-hud-text-dim mt-2">Extract features to see radar visualization</div>
                )}
              </Panel>

              {/* Feature Dimensions Reference */}
              <Panel title="Feature Dimensions" className="col-span-4 md:col-span-12">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {[
                    { dim: 1, name: 'Size Category', desc: 'tiny / small / medium / large / huge', weight: 0.15 },
                    { dim: 2, name: 'Tx Count', desc: 'empty / low / medium / high / extreme', weight: 0.15 },
                    { dim: 3, name: 'Temporal Hour', desc: 'Hour of day (0-23)', weight: 0.05 },
                    { dim: 4, name: 'Temporal Day', desc: 'Day of week (0-6)', weight: 0.05 },
                    { dim: 5, name: 'Blockchain Era', desc: 'genesis through modern', weight: 0.20 },
                    { dim: 6, name: 'Protocol Version', desc: 'Chain milestone derived', weight: 0.15 },
                    { dim: 7, name: 'Difficulty', desc: 'Size/tx relationship', weight: 0.10 },
                    { dim: 8, name: 'Tx Complexity', desc: 'simple to extreme', weight: 0.15 },
                  ].map(d => (
                    <div key={d.dim} className="hud-panel p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-hud-cyan text-[11px] font-medium">D{d.dim} {d.name}</span>
                        <span className="text-[9px] text-hud-warning">{(d.weight * 100).toFixed(0)}%</span>
                      </div>
                      <span className="text-[9px] text-hud-text-dim">{d.desc}</span>
                      <div className="w-full h-1.5 bg-hud-bg mt-1 rounded">
                        <div className="h-full bg-hud-cyan rounded" style={{ width: `${d.weight * 500}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          )}

          {/* ===== VALIDATE TAB ===== */}
          {tab === 'validate' && (
            <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
              <Panel title="Transaction Validator" titleRight="Patent Claim 4" className="col-span-4 md:col-span-6">
                <form onSubmit={validateTx} className="space-y-3">
                  <div>
                    <label className="hud-label block mb-1">Transaction Hash (optional)</label>
                    <input name="txHash" placeholder="0x... (leave empty for random)" className="hud-input w-full" />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="hud-label block mb-1">Block Height</label>
                      <input name="vBlockHeight" defaultValue="24288271" className="hud-input w-full" />
                    </div>
                    <div>
                      <label className="hud-label block mb-1">Block Size</label>
                      <input name="vBlockSize" defaultValue="358400" className="hud-input w-full" />
                    </div>
                    <div>
                      <label className="hud-label block mb-1">Tx Count</label>
                      <input name="vTxCount" defaultValue="539" className="hud-input w-full" />
                    </div>
                  </div>
                  <button type="submit" className="hud-button">Validate Transaction</button>
                </form>

                {validationResult && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <StatusIndicator
                        status={validationResult.result === 'SUCCESS' || validationResult.result === 'PATTERN_MATCH' ? 'active' : validationResult.result === 'ANOMALY_DETECTED' ? 'warning' : 'error'}
                        pulse
                      />
                      <span className={clsx('text-[14px] font-medium', {
                        'text-hud-success': validationResult.result === 'SUCCESS' || validationResult.result === 'PATTERN_MATCH',
                        'text-hud-warning': validationResult.result === 'ANOMALY_DETECTED',
                        'text-hud-error': validationResult.result === 'VALIDATION_FAILED' || validationResult.result === 'REQUIRES_FULL_NODE',
                      })}>{validationResult.result}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="hud-panel p-2">
                        <span className="hud-label block">Confidence</span>
                        <span className="hud-value-md text-hud-cyan">{(validationResult.confidence * 100).toFixed(1)}%</span>
                      </div>
                      <div className="hud-panel p-2">
                        <span className="hud-label block">Time</span>
                        <span className="hud-value-md text-hud-success">{validationResult.validationTimeMs.toFixed(3)}ms</span>
                      </div>
                      <div className="hud-panel p-2">
                        <span className="hud-label block">Escalation</span>
                        <span className={clsx('hud-value-md', validationResult.escalateToArchive ? 'text-hud-warning' : 'text-hud-text-dim')}>
                          {validationResult.escalateToArchive ? 'REQUIRED' : 'NONE'}
                        </span>
                      </div>
                    </div>
                    {validationResult.reasoning.length > 0 && (
                      <div className="hud-panel p-2">
                        <span className="hud-label block mb-1">Reasoning</span>
                        {validationResult.reasoning.map((r, i) => (
                          <div key={i} className="text-[10px] text-hud-text">{r}</div>
                        ))}
                      </div>
                    )}
                    {validationResult.anomalies.length > 0 && (
                      <div className="hud-panel p-2 border-hud-warning/30">
                        <span className="hud-label block mb-1 text-hud-warning">Anomalies</span>
                        {validationResult.anomalies.map((a, i) => (
                          <div key={i} className="text-[10px] text-hud-warning">{a}</div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </Panel>

              <Panel title="Validation Process" className="col-span-4 md:col-span-6">
                <div className="space-y-3">
                  {[
                    { step: 1, name: 'Extract Features', desc: 'Compute 8D feature vector from block metadata' },
                    { step: 2, name: 'Query Index', desc: 'Search pattern index by height and signature' },
                    { step: 3, name: 'Pattern Match', desc: 'Calculate similarity against stored patterns' },
                    { step: 4, name: 'Anomaly Detection', desc: 'Check for deviations from expected patterns' },
                    { step: 5, name: 'Result & Escalation', desc: 'Return verdict or escalate to higher tier' },
                  ].map(s => (
                    <div key={s.step} className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full border border-hud-cyan flex items-center justify-center shrink-0">
                        <span className="text-[10px] text-hud-cyan">{s.step}</span>
                      </div>
                      <div>
                        <span className="text-[11px] text-hud-text-bright block">{s.name}</span>
                        <span className="text-[9px] text-hud-text-dim">{s.desc}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {validationHistory.length > 1 && (
                  <div className="mt-4 h-[120px]">
                    <span className="hud-label block mb-1">Confidence History</span>
                    <LineChart
                      series={[{ label: 'Confidence', data: validationHistory }]}
                      variant="green"
                      formatValue={(v) => `${(v * 100).toFixed(0)}%`}
                      height={100}
                    />
                  </div>
                )}
              </Panel>
            </div>
          )}

          {/* ===== NETWORK TAB ===== */}
          {tab === 'network' && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <button onClick={registerDemoNodes} className="hud-button">Register Demo Nodes</button>
                <span className="text-[9px] text-hud-text-dim">Adds 5 device profiles (iPhone, Pixel, MacBook, RPi, AWS)</span>
              </div>

              <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                <Panel title="Registered Nodes" className="col-span-4 md:col-span-8 lg:col-span-8">
                  {nodes.length === 0 ? (
                    <div className="text-hud-text-dim text-xs">No nodes registered. Click "Register Demo Nodes" to add sample devices.</div>
                  ) : (
                    <div className="space-y-1">
                      <div className="grid grid-cols-6 gap-2 text-[9px] text-hud-text-dim border-b border-hud-line pb-1 mb-1">
                        <span>NODE</span><span>DEVICE</span><span>TIER</span><span>STATUS</span><span>VALIDATIONS</span><span>AVG TIME</span>
                      </div>
                      {nodes.map(node => (
                        <div key={node.nodeId} className="grid grid-cols-6 gap-2 text-[10px] items-center">
                          <span className="text-hud-text-bright truncate">{node.nodeId}</span>
                          <span className="text-hud-text truncate">{node.deviceType}</span>
                          <span className={tierColor(node.tier)}>{node.tier.toUpperCase()}</span>
                          <StatusIndicator status={statusToIndicator(node.status)} label={node.status} />
                          <span className="text-hud-text">{node.validationsPerformed}</span>
                          <span className="text-hud-cyan">{node.avgValidationTimeMs.toFixed(2)}ms</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel title="Tier Distribution" className="col-span-4 lg:col-span-4">
                  <div className="space-y-4">
                    {(['mobile', 'pattern', 'archive'] as const).map(tier => {
                      const count = nodes.filter(n => n.tier === tier).length
                      const pct = nodes.length > 0 ? (count / nodes.length) * 100 : 0
                      return (
                        <div key={tier}>
                          <div className="flex justify-between items-center mb-1">
                            <span className={clsx('text-[11px] font-medium', tierColor(tier))}>{tier.toUpperCase()}</span>
                            <span className="text-[10px] text-hud-text">{count} nodes</span>
                          </div>
                          <div className="w-full h-2 bg-hud-bg">
                            <motion.div
                              className={clsx('h-full', {
                                'bg-hud-cyan': tier === 'mobile',
                                'bg-hud-purple': tier === 'pattern',
                                'bg-hud-success': tier === 'archive',
                              })}
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.5 }}
                            />
                          </div>
                          <span className="text-[9px] text-hud-text-dim">
                            {tier === 'mobile' && '94MB index, battery devices'}
                            {tier === 'pattern' && 'Index + recent blocks, 5GB+ storage'}
                            {tier === 'archive' && 'Full chain, 500GB+, high bandwidth'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </Panel>
              </div>

              <Panel title="Three-Tier Architecture" titleRight="Patent Claim 5, 8, 9">
                <ThreeTierDiagram nodes={nodes} />
              </Panel>
            </div>
          )}

          {/* ===== META-BLOCKS TAB ===== */}
          {tab === 'meta-blocks' && (
            <div className="space-y-4">
              <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                <Panel title="Meta-Block Index" titleRight={<div className="flex items-center gap-3"><span className="text-[9px] text-hud-text-dim">Patent Claim 3, 6</span><button onClick={async () => { const r = await fetch('/validator/meta-blocks/rebuild', { method: 'POST' }); if (r.ok) fetchMetaBlocks(); }} className="hud-button text-[8px] py-0.5 px-2">Rebuild Index</button></div>} className="col-span-4 md:col-span-6">
                  {metaBlockInfo ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <Metric label="Total Blocks" value={metaBlockInfo.totalBlocks.toLocaleString()} size="lg" />
                        <Metric label="Meta-Blocks" value={metaBlockInfo.totalMetaBlocks.toLocaleString()} size="lg" />
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <Metric label="Avg Group Size" value={metaBlockInfo.avgGroupSize.toFixed(1)} size="md" />
                        <Metric label="Compression" value={`${metaBlockInfo.compressionRatio}:1`} size="md" color="success" />
                        <Metric label="Index Size" value={formatBytes(metaBlockInfo.indexSizeBytes)} size="md" />
                      </div>
                    </div>
                  ) : (
                    <div className="text-hud-text-dim text-xs">Loading meta-block info...</div>
                  )}
                </Panel>

                <Panel title="Era Breakdown" className="col-span-4 md:col-span-6">
                  {metaBlockInfo?.byEra ? (
                    <div className="space-y-2">
                      {Object.entries(metaBlockInfo.byEra).map(([era, info]) => {
                        const pct = (info.blocks / metaBlockInfo.totalBlocks) * 100
                        return (
                          <div key={era}>
                            <div className="flex justify-between items-center mb-0.5">
                              <span className="text-[10px] text-hud-text-bright">{era}</span>
                              <span className="text-[9px] text-hud-text-dim">{info.blocks} blocks ({pct.toFixed(1)}%) / {info.metaBlocks} meta-blocks</span>
                            </div>
                            <div className="w-full h-1.5 bg-hud-bg">
                              <motion.div
                                className="h-full bg-hud-purple"
                                initial={{ width: 0 }}
                                animate={{ width: `${pct}%` }}
                                transition={{ duration: 0.5 }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="text-hud-text-dim text-xs">Loading...</div>
                  )}
                </Panel>
              </div>

              <Panel title="How Meta-Blocks Work" titleRight="Patent Claims 3, 6">
                <div className="grid grid-cols-5 gap-4 text-center">
                  {[
                    { step: '1', label: 'Raw Blocks', desc: 'Full blockchain data', icon: 'B' },
                    { step: '2', label: '8D Features', desc: 'Extract feature vectors', icon: 'F' },
                    { step: '3', label: 'Pattern Group', desc: 'Group by signature', icon: 'G' },
                    { step: '4', label: 'Template + Delta', desc: 'Avg template + block deltas', icon: 'T' },
                    { step: '5', label: 'Meta-Block', desc: 'Compressed representation', icon: 'M' },
                  ].map((s, i) => (
                    <div key={s.step} className="flex flex-col items-center">
                      <div className="w-10 h-10 rounded-full border border-hud-purple flex items-center justify-center mb-2">
                        <span className="text-hud-purple text-[14px] font-light">{s.icon}</span>
                      </div>
                      <span className="text-[10px] text-hud-text-bright">{s.label}</span>
                      <span className="text-[8px] text-hud-text-dim mt-0.5">{s.desc}</span>
                      {i < 4 && <span className="text-hud-text-dim text-[10px] mt-1 hidden md:block">→</span>}
                    </div>
                  ))}
                </div>
              </Panel>

              {/* Pattern Detail Table */}
              {metaBlockInfo?.patterns && metaBlockInfo.patterns.length > 0 && (
                <Panel title="Pattern Registry" titleRight={`${metaBlockInfo.patterns.length} patterns`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[9px]">
                      <thead>
                        <tr className="text-hud-text-dim border-b border-hud-line">
                          <th className="text-left py-1.5 px-2">ID</th>
                          <th className="text-left py-1.5 px-2">ERA</th>
                          <th className="text-left py-1.5 px-2">SIZE</th>
                          <th className="text-left py-1.5 px-2">TX COMPLEXITY</th>
                          <th className="text-right py-1.5 px-2">BLOCKS</th>
                          <th className="text-right py-1.5 px-2">AVG SIZE</th>
                          <th className="text-right py-1.5 px-2">TX RANGE</th>
                          <th className="text-right py-1.5 px-2">COMPRESSION</th>
                          <th className="text-right py-1.5 px-2">CONFIDENCE</th>
                          <th className="text-left py-1.5 px-2">INTEGRITY</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metaBlockInfo.patterns.map((p: PatternDetail) => (
                          <tr key={p.quantumId} className="border-b border-hud-line/30 hover:bg-hud-bg/50">
                            <td className="py-1.5 px-2 font-mono text-hud-purple">{p.quantumId}</td>
                            <td className="py-1.5 px-2">
                              <span className="text-[8px] px-1.5 py-0.5 border border-hud-purple/30 text-hud-purple bg-hud-purple/5">{p.era}</span>
                            </td>
                            <td className="py-1.5 px-2 text-hud-text">{p.features?.sizeCategory}</td>
                            <td className="py-1.5 px-2 text-hud-text">{p.features?.transactionComplexity}</td>
                            <td className="py-1.5 px-2 text-right text-hud-text-bright font-medium">{p.blockCount.toLocaleString()}</td>
                            <td className="py-1.5 px-2 text-right text-hud-text">{(p.avgSize / 1024).toFixed(0)} KB</td>
                            <td className="py-1.5 px-2 text-right text-hud-text">{p.txCountRange[0]}–{p.txCountRange[1]}</td>
                            <td className="py-1.5 px-2 text-right text-hud-success">{p.compressionRatio}:1</td>
                            <td className="py-1.5 px-2 text-right">
                              <span className={p.confidence >= 0.9 ? 'text-hud-success' : p.confidence >= 0.7 ? 'text-hud-warning' : 'text-hud-error'}>{(p.confidence * 100).toFixed(1)}%</span>
                            </td>
                            <td className="py-1.5 px-2 font-mono text-hud-text-dim text-[7px]">{p.integrityProof}...</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}
            </div>
          )}

          {/* ===== UNFOLD TAB ===== */}
          {tab === 'unfold' && (
            <div className="space-y-4">
              {/* Status bar */}
              <div className="hud-panel p-3 flex items-center gap-4 border-l-2 border-hud-purple">
                <StatusIndicator status={unfoldStatus?.ready ? 'active' : 'warning'} />
                <div>
                  {unfoldStatus?.ready ? (
                    <>
                      <span className="text-[10px] text-hud-purple font-medium">Address Index Ready</span>
                      <span className="text-[9px] text-hud-text-dim ml-3">
                        {unfoldStatus.addresses.toLocaleString()} addresses / {unfoldStatus.transactions.toLocaleString()} transactions / {unfoldStatus.blocks.toLocaleString()} blocks
                        <span className="ml-2 text-hud-text-dim">(built in {(unfoldStatus.buildTimeMs / 1000).toFixed(1)}s)</span>
                      </span>
                    </>
                  ) : (
                    <span className="text-[10px] text-hud-text-dim animate-pulse">Building address index from raw blocks...</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                {/* Search panel */}
                <Panel title="Address Lookup" titleRight="Multi-chain Unfold" className="col-span-4 md:col-span-6">
                  <form onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); unfoldAddress(form.get('address') as string) }} className="space-y-3">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="hud-label block mb-1">Address</label>
                        <input name="address" placeholder="0x... or Solana address" className="hud-input w-full font-mono" />
                      </div>
                      <div className="w-24">
                        <label className="hud-label block mb-1">Chain</label>
                        <HudSelect value={unfoldChain} onChange={setUnfoldChain} options={[{ value: 'eth', label: 'ETH' }, { value: 'avax', label: 'AVAX' }, { value: 'sol', label: 'SOL' }]} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" disabled={unfoldLoading || !unfoldStatus?.ready} className="hud-button">
                        {unfoldLoading ? 'Unfolding...' : 'Unfold (Index)'}
                      </button>
                      <button type="button" disabled={onDemandLoading} onClick={(e) => {
                        const form = (e.target as HTMLElement).closest('form')
                        if (form) { const fd = new FormData(form); unfoldOnDemand(fd.get('address') as string, unfoldChain) }
                      }} className="hud-button">
                        {onDemandLoading ? 'Fetching...' : 'Fetch from Chain'}
                      </button>
                      {topAddresses.length === 0 && (
                        <button type="button" onClick={fetchTopAddresses} className="hud-button">
                          Show Active
                        </button>
                      )}
                    </div>
                  </form>

                  {onDemandProgress && (
                    <div className="mt-2 text-[10px] text-hud-cyan animate-pulse-glow">{onDemandProgress}</div>
                  )}

                  {onDemandResult && (
                    <div className="mt-2 hud-panel p-2 text-[9px] space-y-1">
                      <div className="flex gap-4">
                        <span className="text-hud-text-dim">Layer: <span className="text-hud-text-bright">{onDemandResult.layer}</span></span>
                        <span className="text-hud-text-dim">Discovered: <span className="text-hud-cyan">{onDemandResult.discoveredBlocks}</span></span>
                        <span className="text-hud-text-dim">Already Indexed: <span className="text-hud-text">{onDemandResult.alreadyIndexed}</span></span>
                        <span className="text-hud-text-dim">Newly Ingested: <span className="text-hud-success">{onDemandResult.newlyIngested}</span></span>
                        <span className="text-hud-text-dim">Time: <span className="text-hud-text">{onDemandResult.ingestionTimeMs}ms</span></span>
                      </div>
                      {onDemandResult.errors.length > 0 && (
                        <div className="text-hud-warning">{onDemandResult.errors.length} errors (hover to see)</div>
                      )}
                    </div>
                  )}

                  {topAddresses.length > 0 && (
                    <div className="mt-3">
                      <span className="hud-label block mb-2">Most Active Addresses</span>
                      <div className="space-y-1 max-h-[200px] overflow-y-auto">
                        {topAddresses.slice(0, 15).map(a => (
                          <button key={a.address} onClick={() => unfoldAddress(a.address)} className="w-full text-left hud-panel p-1.5 flex justify-between items-center hover:border-hud-purple transition-colors cursor-pointer">
                            <span className="text-[10px] text-hud-cyan font-mono">{a.address}</span>
                            <span className="text-[9px] text-hud-text-dim">{a.blockCount} blocks</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </Panel>

                {/* Unfold pipeline */}
                <Panel title="Unfold Pipeline" className="col-span-4 md:col-span-6">
                  <div className="space-y-3">
                    <span className="hud-label block">Two-Layer Lookup</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      {[
                        { icon: '1', label: 'Layer 1', desc: 'Instant index lookup' },
                        { icon: '2', label: 'Layer 2', desc: 'On-demand fetch' },
                        { icon: 'F', label: 'Fold', desc: 'Vectorize + PQ' },
                        { icon: 'P', label: 'Prove', desc: 'ZK proof' },
                        { icon: 'R', label: 'Result', desc: 'Unfold with proof' },
                      ].map((s, i) => (
                        <div key={s.icon} className="flex items-center gap-2">
                          <div className="flex flex-col items-center">
                            <div className="w-9 h-9 rounded-full border border-hud-cyan flex items-center justify-center mb-1">
                              <span className="text-hud-cyan text-[13px] font-light">{s.icon}</span>
                            </div>
                            <span className="text-[9px] text-hud-text-bright">{s.label}</span>
                            <span className="text-[8px] text-hud-text-dim">{s.desc}</span>
                          </div>
                          {i < 4 && <span className="text-hud-text-dim text-[10px] mb-4">→</span>}
                        </div>
                      ))}
                    </div>
                    <div className="text-[9px] text-hud-text-dim mt-2 space-y-1">
                      <p><span className="text-hud-cyan">Layer 1:</span> Address in index → unfold instantly from folded blocks</p>
                      <p><span className="text-hud-purple">Layer 2:</span> Not found → discover blocks from chain → fetch → fold → prove → unfold</p>
                      <p>Every block includes ZK proof commitments for integrity verification</p>
                    </div>
                  </div>
                </Panel>
              </div>

              {/* Loading states */}
              {(unfoldLoading || onDemandLoading) && (
                <Panel title={onDemandLoading ? 'On-Demand Ingestion...' : 'Unfolding...'} className="animate-pulse">
                  <div className="text-hud-cyan text-xs">{onDemandProgress || 'Querying address index and loading raw blocks...'}</div>
                  <div className="progress-bar mt-2"><div className="progress-bar-fill animate-pulse-glow" style={{ width: '60%' }} /></div>
                </Panel>
              )}

              {unfoldResult && !unfoldResult.found && !onDemandLoading && (
                <Panel title="Not Found">
                  <div className="text-hud-text-dim text-xs">{unfoldResult.message}</div>
                  <div className="mt-2 text-[9px] text-hud-text-dim">Click "Fetch from Chain" to discover blocks from the {unfoldChain.toUpperCase()} network</div>
                </Panel>
              )}

              {unfoldResult && unfoldResult.found && (
                <>
                  <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                    <Panel title="Address Summary" titleRight={`${unfoldResult.address.slice(0, 8)}...${unfoldResult.address.slice(-6)}`} className="col-span-4 md:col-span-12">
                      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                        <Metric label="Total Transactions" value={String(unfoldResult.transactionCount)} size="lg" />
                        <Metric label="Blocks Appeared In" value={String(unfoldResult.blockCount)} size="lg" />
                        <Metric label="Inbound" value={String(unfoldResult.summary.inboundTxCount)} size="md" color="success" />
                        <Metric label="Outbound" value={String(unfoldResult.summary.outboundTxCount)} size="md" color="warning" />
                        <Metric label="Counterparties" value={String(unfoldResult.summary.uniqueCounterparties)} size="md" />
                        <Metric label="Total Gas Used" value={unfoldResult.summary.totalGasUsed.toLocaleString()} size="sm" />
                      </div>
                      {unfoldResult.summary.blockRange && (
                        <div className="mt-2 text-[9px] text-hud-text-dim">
                          Block range: {unfoldResult.summary.blockRange}
                          {unfoldResult.truncated && <span className="text-hud-warning ml-2">(showing first 100 blocks, {unfoldResult.blockCount} total)</span>}
                        </div>
                      )}
                    </Panel>
                  </div>

                  {/* Blocks with proof integrity */}
                  <Panel title="Blocks & Proof Integrity" titleRight={`${unfoldResult.blocks.length} blocks`}>
                    <div className="space-y-2 max-h-[350px] overflow-y-auto">
                      {unfoldResult.blocks.map(block => (
                        <div key={block.blockHeight} className="hud-panel p-2">
                          <div className="flex items-center gap-4 cursor-pointer" onClick={() => setExpandedProofs(prev => {
                            const next = new Set(prev)
                            next.has(block.blockHeight) ? next.delete(block.blockHeight) : next.add(block.blockHeight)
                            return next
                          })}>
                            <span className="text-[10px] text-hud-cyan font-mono w-24">#{block.blockHeight}</span>
                            <span className="text-[9px] text-hud-text-dim w-16">{block.matchingTxCount} tx</span>
                            <span className="text-[9px] text-hud-text-dim w-20">of {block.totalTxInBlock} total</span>
                            {block.proofIntegrity && (
                              <ProofBadge status={block.proofIntegrity.verificationStatus} />
                            )}
                            {block.patternInfo && (
                              <div className="flex gap-1 flex-wrap flex-1">
                                {block.patternInfo.semanticTags.slice(0, 3).map(tag => (
                                  <span key={tag} className="text-[7px] px-1 py-0.5 rounded bg-hud-panel text-hud-purple border border-hud-purple/20">{tag}</span>
                                ))}
                              </div>
                            )}
                            <span className="text-[8px] text-hud-text-dim">{expandedProofs.has(block.blockHeight) ? '▼' : '▶'}</span>
                          </div>
                          {expandedProofs.has(block.blockHeight) && block.proofIntegrity && (
                            <div className="mt-2 pl-4 border-l border-hud-line space-y-1 text-[8px]">
                              <div><span className="text-hud-text-dim">Folded Commitment:</span> <span className="text-hud-cyan font-mono">{block.proofIntegrity.foldedCommitment?.slice(0, 32)}...</span></div>
                              <div><span className="text-hud-text-dim">PQ Commitment:</span> <span className="text-hud-cyan font-mono">{block.proofIntegrity.pqCommitment?.slice(0, 32)}...</span></div>
                              <div><span className="text-hud-text-dim">Codebook Root:</span> <span className="text-hud-cyan font-mono">{block.proofIntegrity.codebookRoot?.slice(0, 32)}...</span></div>
                              {block.proofIntegrity.proofAvailable && (
                                <div><span className="text-hud-text-dim">Proof:</span> <span className="text-hud-success font-mono">{block.proofIntegrity.proofHex?.slice(0, 40)}...</span></div>
                              )}
                              {block.proofIntegrity.publicInputs && (
                                <div className="mt-1 space-y-0.5">
                                  <div className="text-hud-text-dim">Public Inputs:</div>
                                  {block.proofIntegrity.publicInputs.prevStateRoot && <div className="pl-2 text-hud-text">prevState: {block.proofIntegrity.publicInputs.prevStateRoot.slice(0, 24)}...</div>}
                                  {block.proofIntegrity.publicInputs.newStateRoot && <div className="pl-2 text-hud-text">newState: {block.proofIntegrity.publicInputs.newStateRoot.slice(0, 24)}...</div>}
                                  {block.proofIntegrity.publicInputs.txMerkleRoot && <div className="pl-2 text-hud-text">txMerkle: {block.proofIntegrity.publicInputs.txMerkleRoot.slice(0, 24)}...</div>}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Panel>

                  {/* Transaction table */}
                  <Panel title="Transactions" titleRight={`${unfoldResult.transactionCount} total`}>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[9px]">
                        <thead>
                          <tr className="text-hud-text-dim border-b border-hud-line">
                            <th className="text-left py-1 px-2">BLOCK</th>
                            <th className="text-left py-1 px-2">TX HASH</th>
                            <th className="text-left py-1 px-2">DIR</th>
                            <th className="text-left py-1 px-2">COUNTERPARTY</th>
                            <th className="text-right py-1 px-2">VALUE (ETH)</th>
                            <th className="text-right py-1 px-2">GAS</th>
                            <th className="text-left py-1 px-2">FN</th>
                            <th className="text-left py-1 px-2">STATUS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unfoldResult.transactions.slice(0, 200).map((tx, i) => {
                            const txKey = `${tx.hash}-${i}`;
                            const isExpanded = expandedTxs.has(txKey);
                            return (
                              <React.Fragment key={txKey}>
                                <tr
                                  className="border-b border-hud-line/30 hover:bg-hud-panel-alt/50 cursor-pointer"
                                  onClick={() => setExpandedTxs(prev => { const next = new Set(prev); next.has(txKey) ? next.delete(txKey) : next.add(txKey); return next })}
                                >
                                  <td className="py-1 px-2 text-hud-cyan font-mono">{tx.blockHeight}</td>
                                  <td className="py-1 px-2 text-hud-text font-mono"><a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="hover:text-hud-cyan transition-colors" title={tx.hash} onClick={e => e.stopPropagation()}>{tx.hash.slice(0, 18)}...</a> <span className="text-[7px] text-hud-text-dim">{isExpanded ? '▼' : '▶'}</span></td>
                                  <td className="py-1 px-2">
                                    <span className={tx.direction === 'in' ? 'text-hud-success' : 'text-hud-warning'}>
                                      {tx.direction === 'in' ? 'IN' : 'OUT'}
                                    </span>
                                  </td>
                                  <td className="py-1 px-2 font-mono">{(() => { const cp = tx.direction === 'out' ? tx.receiver : tx.sender; return <a href={`https://etherscan.io/address/${cp}`} target="_blank" rel="noopener noreferrer" className="text-hud-text hover:text-hud-cyan transition-colors" title={cp} onClick={e => e.stopPropagation()}>{cp.slice(0, 18)}...</a> })()}</td>
                                  <td className="py-1 px-2 text-right text-hud-text">{tx.amountEth > 0 ? tx.amountEth.toFixed(6) : '0'}</td>
                                  <td className="py-1 px-2 text-right text-hud-text-dim">{tx.gasUsed.toLocaleString()}</td>
                                  <td className="py-1 px-2 text-hud-purple font-mono">{tx.functionSelector || '—'}</td>
                                  <td className="py-1 px-2">
                                    <span className={tx.status === 'success' ? 'text-hud-success' : 'text-hud-error'}>{tx.status}</span>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr className="bg-hud-panel-alt/30">
                                    <td colSpan={8} className="py-2 px-4">
                                      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[9px]">
                                        <div><span className="text-hud-text-dim">Tx Hash:</span> <a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="text-hud-cyan font-mono hover:underline">{tx.hash}</a></div>
                                        <div><span className="text-hud-text-dim">Block:</span> <a href={`https://etherscan.io/block/${tx.blockHeight}`} target="_blank" rel="noopener noreferrer" className="text-hud-text font-mono hover:text-hud-cyan">{tx.blockHeight}</a></div>
                                        <div><span className="text-hud-text-dim">From:</span> <a href={`https://etherscan.io/address/${tx.sender}`} target="_blank" rel="noopener noreferrer" className="text-hud-text font-mono hover:text-hud-cyan">{tx.sender}</a></div>
                                        <div><span className="text-hud-text-dim">To:</span> <a href={`https://etherscan.io/address/${tx.receiver}`} target="_blank" rel="noopener noreferrer" className="text-hud-text font-mono hover:text-hud-cyan">{tx.receiver}</a></div>
                                        <div><span className="text-hud-text-dim">Value:</span> <span className="text-hud-text">{tx.amountEth.toFixed(6)} ETH</span> <span className="text-hud-text-dim">({tx.amountWei?.toLocaleString?.() ?? '0'} wei)</span></div>
                                        <div><span className="text-hud-text-dim">Gas Used:</span> <span className="text-hud-text">{tx.gasUsed.toLocaleString()}</span></div>
                                        <div><span className="text-hud-text-dim">Gas Price:</span> <span className="text-hud-text">{tx.gasPrice?.toLocaleString?.() ?? '—'} wei</span></div>
                                        <div><span className="text-hud-text-dim">Fee:</span> <span className="text-hud-text">{tx.fee ? (tx.fee / 1e18).toFixed(8) + ' ETH' : '—'}</span></div>
                                        <div><span className="text-hud-text-dim">Nonce:</span> <span className="text-hud-text font-mono">{tx.nonce ?? '—'}</span></div>
                                        <div><span className="text-hud-text-dim">Function:</span> <span className="text-hud-purple font-mono">{tx.functionSelector || 'native transfer'}</span></div>
                                        <div><span className="text-hud-text-dim">Contract Type:</span> <span className="text-hud-text">{tx.contractType || '—'}</span></div>
                                        <div><span className="text-hud-text-dim">Data Size:</span> <span className="text-hud-text">{tx.dataSize ?? 0} bytes</span></div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {unfoldResult.transactionCount > 200 && (
                      <div className="text-[8px] text-hud-text-dim mt-2">Showing first 200 of {unfoldResult.transactionCount} transactions</div>
                    )}
                  </Panel>
                </>
              )}
            </div>
          )}

          {/* ===== COMPLIANCE TAB ===== */}
          {tab === 'compliance' && (
            <div className="space-y-4">
              <Panel title="AML Compliance Check" titleRight="Pattern-Based Risk Assessment">
                <form onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); fetchCompliance(form.get('address') as string) }} className="flex gap-3 items-end">
                  <div className="flex-1">
                    <Tooltip position="bottom" content={<TooltipContent title="Address" description="Enter a wallet address or contract address to analyze. The system searches all ingested blocks for matching transactions and builds a full risk profile." />}>
                      <label className="hud-label block mb-1">Address</label>
                    </Tooltip>
                    <input name="address" placeholder="0x..." className="hud-input w-full font-mono" />
                  </div>
                  <div className="w-28">
                    <Tooltip position="bottom" content={<TooltipContent title="Threshold" description={`${complianceChain.toUpperCase()} value above which transactions are flagged as high-value. Feeds into the risk score. Set lower for stricter monitoring, higher for large transfers only.`} items={[{ label: 'Default', value: `1 ${complianceChain.toUpperCase()}` }, { label: 'Strict', value: `0.1 ${complianceChain.toUpperCase()}` }, { label: 'Large only', value: `10 ${complianceChain.toUpperCase()}` }]} />}>
                      <label className="hud-label block mb-1">Threshold ({complianceChain.toUpperCase()})</label>
                    </Tooltip>
                    <input type="number" step="any" min="0.01" value={complianceThreshold} onChange={e => setComplianceThreshold(Number(e.target.value) || 1)} className="hud-input w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                  </div>
                  <div className="w-24">
                    <Tooltip position="bottom" content={<TooltipContent title="Chain" description="Select which blockchain to query. Searches the address index for the selected chain." />}>
                      <label className="hud-label block mb-1">Chain</label>
                    </Tooltip>
                    <HudSelect value={complianceChain} onChange={setComplianceChain} name="chain" options={[{ value: 'eth', label: 'ETH' }, { value: 'avax', label: 'AVAX' }, { value: 'sol', label: 'SOL' }]} />
                  </div>
                  <button type="submit" disabled={complianceLoading} className="hud-button">
                    {complianceLoading ? 'Analyzing...' : 'Run Check'}
                  </button>
                </form>
              </Panel>

              {complianceResult && complianceResult.found && (
                <>
                  {/* Row 1: Risk Score + Risk Breakdown */}
                  <div className="grid grid-cols-4 md:grid-cols-12 gap-4">
                    <Panel title="Risk Assessment" titleRight={<button onClick={exportComplianceReport} className="hud-button text-[8px] py-0.5 px-2">Export Report</button>} className="col-span-4">
                      <div className="flex items-center gap-4 mb-2">
                        <RiskBadge score={complianceResult.riskScore} level={complianceResult.riskLevel} />
                      </div>
                      {(() => {
                        const targetNode = complianceResult.counterpartyGraph.nodes.find((n: any) => n.isTarget)
                        return targetNode?.entityLabel ? (
                          <div className="text-[8px] px-2 py-1 border border-hud-purple/40 text-hud-purple bg-hud-purple/5 mb-3 inline-block">{targetNode.entityLabel}</div>
                        ) : null
                      })()}
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <MetricInline label="Total Transactions" value={complianceResult.totalTransactions} />
                        <MetricInline label="Flagged" value={complianceResult.flaggedTransactions.length} />
                        <MetricInline label="Counterparties" value={complianceResult.counterpartyGraph.nodes.length - 1} />
                        <MetricInline label="Alerts" value={(complianceResult.alerts || []).length} />
                      </div>
                      {(complianceResult.riskBreakdown || []).length > 0 && (
                        <div className="border-t border-hud-line/30 pt-2 space-y-1.5">
                          <div className="text-[7px] text-hud-text-dim uppercase tracking-wider mb-1">Score Derivation</div>
                          {(complianceResult.riskBreakdown || []).map((f: any) => {
                            const contribution = f.score * f.weight
                            return (
                              <div key={f.factor} className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full shrink-0" style={{
                                  background: f.score >= 0.6 ? 'var(--color-hud-error)' : f.score >= 0.3 ? 'var(--color-hud-warning)' : 'var(--color-hud-success)',
                                  opacity: 0.8,
                                }} />
                                <span className="text-[8px] text-hud-text flex-1">{f.factor}</span>
                                <span className="text-[8px] text-hud-text-dim">{(f.score * 100).toFixed(0)}%</span>
                                <span className="text-[7px] text-hud-text-dim">×{(f.weight * 100).toFixed(0)}%</span>
                                <span className={clsx('text-[8px] font-medium w-8 text-right', {
                                  'text-hud-error': contribution >= 0.12,
                                  'text-hud-warning': contribution >= 0.05 && contribution < 0.12,
                                  'text-hud-success': contribution < 0.05,
                                })}>+{(contribution * 100).toFixed(0)}</span>
                              </div>
                            )
                          })}
                          <div className="flex items-center gap-2 pt-1 border-t border-hud-line/20">
                            <span className="text-[8px] text-hud-text-bright flex-1">Composite Score</span>
                            <span className={clsx('text-[10px] font-medium', {
                              'text-hud-error': complianceResult.riskScore >= 0.6,
                              'text-hud-warning': complianceResult.riskScore >= 0.3,
                              'text-hud-success': complianceResult.riskScore < 0.3,
                            })}>{(complianceResult.riskScore * 100).toFixed(0)}%</span>
                          </div>
                        </div>
                      )}
                      {complianceResult.analysisTimestamp && (
                        <div className="text-[7px] text-hud-text-dim mt-2 pt-2 border-t border-hud-line/30">
                          Analyzed: {new Date(complianceResult.analysisTimestamp).toLocaleString()}
                        </div>
                      )}
                    </Panel>

                    <Panel title="Risk Breakdown" className="col-span-4 md:col-span-8">
                      <div className="space-y-2">
                        {(complianceResult.riskBreakdown || []).map((factor: any) => (
                          <div key={factor.factor}>
                            <div className="flex justify-between items-center mb-0.5">
                              <span className="text-[9px] text-hud-text-bright">{factor.factor}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[8px] text-hud-text-dim">w:{(factor.weight * 100).toFixed(0)}%</span>
                                <span className={clsx('text-[10px] font-medium', {
                                  'text-hud-error': factor.score >= 0.6,
                                  'text-hud-warning': factor.score >= 0.3 && factor.score < 0.6,
                                  'text-hud-success': factor.score < 0.3,
                                })}>{(factor.score * 100).toFixed(0)}%</span>
                              </div>
                            </div>
                            <div className="w-full h-1.5 bg-hud-bg rounded overflow-hidden">
                              <motion.div
                                className={clsx('h-full rounded', {
                                  'bg-hud-error': factor.score >= 0.6,
                                  'bg-hud-warning': factor.score >= 0.3 && factor.score < 0.6,
                                  'bg-hud-success': factor.score < 0.3,
                                })}
                                initial={{ width: 0 }}
                                animate={{ width: `${factor.score * 100}%` }}
                                transition={{ duration: 0.5 }}
                              />
                            </div>
                            <div className="text-[7px] text-hud-text-dim mt-0.5">{factor.detail}</div>
                          </div>
                        ))}
                      </div>
                    </Panel>

                  </div>

                  {/* Row 2: Transaction Alerts */}
                  <div className="grid grid-cols-4 md:grid-cols-12 gap-4">
                    <Panel title="Transaction Alerts" titleRight={`${(complianceResult.alerts || []).length} detected`} className="col-span-4 md:col-span-12">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {(complianceResult.alerts || []).length === 0 && <div className="text-[9px] text-hud-text-dim">No suspicious patterns detected</div>}
                        {(complianceResult.alerts || []).map((alert: any, i: number) => (
                          <div key={i} className={clsx('p-2 border-l-2', {
                            'border-l-hud-error bg-hud-error/5': alert.severity === 'high',
                            'border-l-hud-warning bg-hud-warning/5': alert.severity === 'medium',
                            'border-l-hud-cyan bg-hud-cyan/5': alert.severity === 'low',
                          })}>
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className={clsx('text-[7px] px-1.5 py-0.5 uppercase font-medium border', {
                                'text-hud-error border-hud-error/40': alert.severity === 'high',
                                'text-hud-warning border-hud-warning/40': alert.severity === 'medium',
                                'text-hud-cyan border-hud-cyan/40': alert.severity === 'low',
                              })}>{alert.severity}</span>
                              <span className="text-[8px] text-hud-text-bright uppercase">{alert.type.replace(/_/g, ' ')}</span>
                            </div>
                            <div className="text-[8px] text-hud-text mt-0.5">{alert.description}</div>
                            <div className="text-[7px] text-hud-text-dim mt-0.5">{alert.evidence.slice(0, 3).join(' | ')}</div>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>

                  {/* Row 3: Pattern Flags + Block Anomalies */}
                  <div className="grid grid-cols-4 md:grid-cols-12 gap-4">
                    <Panel title="Semantic Pattern Flags" className="col-span-4 md:col-span-6">
                      <div className="flex flex-wrap gap-2">
                        {complianceResult.patternFlags.map(flag => (
                          <span key={flag} className={clsx('text-[9px] px-2 py-1 border', {
                            'border-hud-error/40 text-hud-error bg-hud-error/5': flag.includes('AML'),
                            'border-hud-warning/40 text-hud-warning bg-hud-warning/5': flag.includes('HIGH') || flag.includes('VOL'),
                            'border-hud-cyan/40 text-hud-cyan bg-hud-cyan/5': flag.includes('BRIDGE') || flag.includes('DEX'),
                            'border-hud-purple/40 text-hud-purple bg-hud-purple/5': !flag.includes('AML') && !flag.includes('HIGH') && !flag.includes('VOL') && !flag.includes('BRIDGE') && !flag.includes('DEX'),
                          })}>
                            {flag}
                          </span>
                        ))}
                        {complianceResult.patternFlags.length === 0 && <span className="text-[9px] text-hud-text-dim">No pattern flags detected</span>}
                      </div>
                    </Panel>

                    <Panel title="Block Anomaly Scores" className="col-span-4 md:col-span-6">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {complianceResult.blockAnomalies.slice(0, 10).map(ba => (
                          <div key={ba.height} className="flex justify-between text-[9px]">
                            <span className="text-hud-cyan font-mono">#{ba.height}</span>
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1 bg-hud-bg rounded overflow-hidden">
                                <div className={clsx('h-full rounded', ba.score > 0.5 ? 'bg-hud-warning' : 'bg-hud-text-dim/40')} style={{ width: `${ba.score * 100}%` }} />
                              </div>
                              <span className={ba.score > 0.5 ? 'text-hud-warning' : 'text-hud-text-dim'}>{(ba.score * 100).toFixed(1)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  </div>

                  {/* Flagged Transactions */}
                  {complianceResult.flaggedTransactions.length > 0 && (
                    <Panel title="Flagged Transactions" titleRight={`${complianceResult.flaggedTransactions.length} above ${(complianceResult.threshold / 1e18).toFixed(2)} ETH`}>
                      <div className="overflow-x-auto">
                        <table className="w-full text-[9px]">
                          <thead>
                            <tr className="text-hud-text-dim border-b border-hud-line">
                              <th className="text-left py-1 px-2">BLOCK</th>
                              <th className="text-left py-1 px-2">TX HASH</th>
                              <th className="text-left py-1 px-2">DIR</th>
                              <th className="text-left py-1 px-2">COUNTERPARTY</th>
                              <th className="text-right py-1 px-2">VALUE (ETH)</th>
                              <th className="text-left py-1 px-2">ENTITY</th>
                              <th className="text-left py-1 px-2">TAGS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {complianceResult.flaggedTransactions.slice(0, 50).map((tx: any, i: number) => (
                              <tr key={`${tx.hash}-${i}`} className="border-b border-hud-line/30 hover:bg-hud-bg/50">
                                <td className="py-1 px-2 text-hud-cyan font-mono">{tx.blockHeight}</td>
                                <td className="py-1 px-2 text-hud-text font-mono"><a href={`https://etherscan.io/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" className="hover:text-hud-cyan transition-colors" title={tx.hash}>{tx.hash}</a></td>
                                <td className="py-1 px-2"><span className={tx.direction === 'in' ? 'text-hud-success' : 'text-hud-warning'}>{tx.direction === 'in' ? 'IN' : 'OUT'}</span></td>
                                <td className="py-1 px-2 font-mono">{(() => { const cp = tx.direction === 'out' ? tx.receiver : tx.sender; return <a href={`https://etherscan.io/address/${cp}`} target="_blank" rel="noopener noreferrer" className="text-hud-text hover:text-hud-cyan transition-colors" title={cp}>{cp}</a> })()}</td>
                                <td className="py-1 px-2 text-right text-hud-error font-medium">{(Number(tx.amountWei) / 1e18).toFixed(4)}</td>
                                <td className="py-1 px-2">
                                  {tx.entityLabel ? (
                                    <span className={clsx('text-[7px] px-1.5 py-0.5 border', {
                                      'border-hud-error/40 text-hud-error': tx.entityLabel.toLowerCase().includes('tornado'),
                                      'border-hud-warning/40 text-hud-warning': tx.entityLabel.toLowerCase().includes('bridge'),
                                      'border-hud-cyan/40 text-hud-cyan': tx.entityLabel.toLowerCase().includes('swap') || tx.entityLabel.toLowerCase().includes('router') || tx.entityLabel.toLowerCase().includes('inch'),
                                      'border-hud-purple/40 text-hud-purple': !tx.entityLabel.toLowerCase().includes('tornado') && !tx.entityLabel.toLowerCase().includes('bridge') && !tx.entityLabel.toLowerCase().includes('swap') && !tx.entityLabel.toLowerCase().includes('router') && !tx.entityLabel.toLowerCase().includes('inch'),
                                    })}>{tx.entityLabel}</span>
                                  ) : <span className="text-hud-text-dim">—</span>}
                                </td>
                                <td className="py-1 px-2">
                                  <div className="flex gap-1 flex-wrap">
                                    {(tx.blockTags || []).slice(0, 2).map((t: string) => <span key={t} className="text-[7px] text-hud-warning">{t}</span>)}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  )}

                  {/* Counterparty Network */}
                  <Panel title="Counterparty Network" titleRight={`${complianceResult.counterpartyGraph.nodes.length} nodes / ${complianceResult.counterpartyGraph.edges.length} edges`}>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[9px]">
                        <thead>
                          <tr className="text-hud-text-dim border-b border-hud-line">
                            <th className="text-left py-1 px-2">ADDRESS</th>
                            <th className="text-left py-1 px-2">ENTITY</th>
                            <th className="text-right py-1 px-2">TX COUNT</th>
                            <th className="text-right py-1 px-2">TOTAL VALUE</th>
                            <th className="text-left py-1 px-2">DIRECTION</th>
                          </tr>
                        </thead>
                        <tbody>
                          {complianceResult.counterpartyGraph.edges.slice(0, 30).map((edge: any, i: number) => (
                            <tr key={i} className={clsx('border-b border-hud-line/30', edge.entityLabel && edge.entityLabel.toLowerCase().includes('tornado') && 'bg-hud-error/5')}>
                              <td className="py-1 px-2 text-hud-cyan font-mono"><a href={`https://etherscan.io/address/${edge.to}`} target="_blank" rel="noopener noreferrer" className="hover:text-hud-text-bright transition-colors" title={edge.to}>{edge.to}</a></td>
                              <td className="py-1 px-2">
                                {edge.entityLabel ? (
                                  <span className={clsx('text-[7px] px-1.5 py-0.5 border', {
                                    'border-hud-error/40 text-hud-error': edge.entityLabel.toLowerCase().includes('tornado'),
                                    'border-hud-warning/40 text-hud-warning': edge.entityLabel.toLowerCase().includes('bridge'),
                                    'border-hud-cyan/40 text-hud-cyan': edge.entityLabel.toLowerCase().includes('swap') || edge.entityLabel.toLowerCase().includes('router') || edge.entityLabel.toLowerCase().includes('inch'),
                                    'border-hud-purple/40 text-hud-purple': !edge.entityLabel.toLowerCase().includes('tornado') && !edge.entityLabel.toLowerCase().includes('bridge') && !edge.entityLabel.toLowerCase().includes('swap') && !edge.entityLabel.toLowerCase().includes('router') && !edge.entityLabel.toLowerCase().includes('inch'),
                                  })}>{edge.entityLabel}</span>
                                ) : <span className="text-hud-text-dim">—</span>}
                              </td>
                              <td className="py-1 px-2 text-right text-hud-text">{edge.count}</td>
                              <td className="py-1 px-2 text-right text-hud-text">{(edge.value / 1e18).toFixed(4)} ETH</td>
                              <td className="py-1 px-2 text-hud-text-dim">{edge.direction}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                </>
              )}

              {complianceResult && !complianceResult.found && (
                <Panel title="Not Found">
                  <div className="text-hud-text-dim text-xs">Address not found in index. Use the Unfold tab to fetch blocks first, or enable auto-ingest to grow the index.</div>
                </Panel>
              )}
            </div>
          )}

          {/* ===== INGEST TAB ===== */}
          {tab === 'ingest' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Panel title="Backfill" titleRight="Historical">
                  <form onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); triggerIngest(ingestChain, Number(form.get('count') || 100), Number(backfillStartBlock) || undefined) }} className="flex gap-3 items-end flex-wrap">
                    <div className="w-24">
                      <label className="hud-label block mb-1">Chain</label>
                      <HudSelect value={ingestChain} onChange={setIngestChain} options={[{ value: 'eth', label: 'ETH' }, { value: 'avax', label: 'AVAX' }, { value: 'sol', label: 'SOL' }]} />
                    </div>
                    <div className="w-40">
                      <label className="hud-label block mb-1">Start Block</label>
                      <input value={backfillStartBlock} onChange={e => setBackfillStartBlock(e.target.value)} type="number" placeholder="e.g. 22000000" className="hud-input w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                    </div>
                    <div className="w-24">
                      <label className="hud-label block mb-1">Count</label>
                      <input name="count" type="number" defaultValue={100} min={1} max={10000} className="hud-input w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                    </div>
                    {ingestRunning ? (
                      <button type="button" onClick={cancelIngest} className="hud-button text-hud-error border-hud-error/40">
                        Cancel
                      </button>
                    ) : (
                      <button type="submit" className="hud-button">
                        Backfill
                      </button>
                    )}
                  </form>
                  <div className="text-[8px] text-hud-text-dim mt-2">Ingests from start block downward. Leave blank to ingest latest blocks forward.</div>
                </Panel>
                <Panel title="Live Ingest" titleRight={autoIngestActive ? 'Active' : 'Inactive'}>
                  <div className="flex items-center gap-4">
                    <div className="text-[10px] text-hud-text">
                      {autoIngestActive
                        ? <span className="text-hud-success">Auto-ingest is running — following chain tip every ~12s</span>
                        : <span className="text-hud-text-dim">Auto-ingest is off. Enable in Settings to follow the chain tip.</span>
                      }
                    </div>
                    <div className="text-[10px] text-hud-text ml-auto">
                      Session: <span className="text-hud-cyan font-mono">{blocksStoredCount}</span> blocks
                    </div>
                  </div>
                </Panel>
              </div>

              <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
                <Panel title="" className="col-span-4 md:col-span-8">
                  <div className="space-y-1">
                    {/* Sub-tabs */}
                    <div className="flex gap-0 border-b border-hud-line mb-2">
                      {(['live', 'backfill'] as const).map(t => {
                        const count = ingestEvents.filter(e => (e.mode || 'live') === t).length
                        return (
                          <button key={t} onClick={() => setFeedTab(t)} className={clsx(
                            'px-4 py-1.5 text-[10px] uppercase tracking-wider font-mono border-b-2 transition-colors',
                            feedTab === t ? 'text-hud-cyan border-hud-cyan' : 'text-hud-text-dim border-transparent hover:text-hud-text'
                          )}>
                            {t === 'live' ? 'Live Feed' : 'Backfill'} {count > 0 && <span className="text-hud-text-dim ml-1">({count})</span>}
                          </button>
                        )
                      })}
                    </div>

                    {/* Filtered feed */}
                    {(() => {
                      const filtered = ingestEvents.filter(e => (e.mode || 'live') === feedTab)
                      // Live: newest on top (ascending blocks, latest event first)
                      // Backfill: newest on top (descending blocks, latest event first)
                      return (
                        <div className="max-h-[400px] overflow-y-auto space-y-1">
                          <div ref={feedTopRef} />
                          {filtered.length === 0 && (
                            <div className="text-[9px] text-hud-text-dim">
                              {feedTab === 'live' ? 'No live events yet. Enable Auto-Ingest in Settings.' : 'No backfill events yet. Set a start block and click Backfill.'}
                            </div>
                          )}
                          {filtered.map((evt, i) => (
                            <div key={i} className={clsx('pipeline-stage', {
                              'pipeline-stage--active': evt.stage === 'fetching' || evt.stage === 'vectorizing' || evt.stage === 'folding' || evt.stage === 'quantizing' || evt.stage === 'proving',
                              'pipeline-stage--done': evt.stage === 'stored' || evt.stage === 'complete',
                            })}>
                              <span className={clsx('w-24 shrink-0 uppercase font-medium', {
                                'text-hud-cyan': evt.stage === 'fetching' || evt.stage === 'discovering',
                                'text-hud-purple': evt.stage === 'vectorizing' || evt.stage === 'folding',
                                'text-hud-warning': evt.stage === 'quantizing',
                                'text-hud-blue': evt.stage === 'proving',
                                'text-hud-success': evt.stage === 'stored' || evt.stage === 'complete',
                              })}>{evt.stage}</span>
                              {evt.timestamp && (evt.stage === 'stored' || evt.stage === 'complete') && <span className="text-hud-text-dim ml-1 text-[8px]">{evt.timestamp}</span>}
                              <span className="text-hud-text-dim ml-2">{evt.chain.toUpperCase()}</span>
                              {evt.height > 0 && <span className="text-hud-cyan font-mono">{evt.chain === 'sol' ? 'Slot' : '#'}{evt.height}</span>}
                              {evt.detail && <span className="text-hud-text">{evt.detail}</span>}
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                </Panel>

                <Panel title="Pipeline Monitor" className="col-span-4">
                  <div className="flex flex-col gap-3 h-[420px]">
                    {/* Horizontal pipeline strip */}
                    {(() => {
                      const stages = ['fetch', 'vectorize', 'fold', 'pq', 'prove', 'store'] as const
                      const stageLabels: Record<string, string> = { fetch: 'FETCH', vectorize: 'VEC', fold: 'FOLD', pq: 'PQ+HOT', prove: 'ZK', store: 'STORE' }
                      const stageMap: Record<string, string> = { fetching: 'fetch', vectorizing: 'vectorize', folding: 'fold', quantizing: 'pq', proving: 'prove', stored: 'store' }
                      const latestEvt = ingestEvents[0]
                      const activeStage = latestEvt ? (stageMap[latestEvt.stage] || '') : ''
                      const doneStage = latestEvt?.stage === 'stored' || latestEvt?.stage === 'complete'
                      return (
                        <div className="flex items-center gap-0.5">
                          {stages.map((s, i) => {
                            const stageIdx = stages.indexOf(activeStage as typeof stages[number])
                            const isActive = !doneStage && s === activeStage
                            const isDone = doneStage || (!doneStage && stageIdx >= 0 && i < stageIdx)
                            return (
                              <div key={s} className="flex items-center gap-0.5 flex-1">
                                <div className={clsx(
                                  'flex-1 h-5 flex items-center justify-center text-[7px] font-mono uppercase tracking-wider transition-all duration-300',
                                  isActive && 'bg-hud-cyan/20 text-hud-cyan border border-hud-cyan/50 animate-pulse',
                                  isDone && 'bg-hud-success/10 text-hud-success border border-hud-success/30',
                                  !isActive && !isDone && 'bg-hud-line/20 text-hud-text-dim border border-hud-line/30',
                                )}>
                                  {stageLabels[s]}
                                </div>
                                {i < stages.length - 1 && <span className={clsx('text-[8px] shrink-0', isDone ? 'text-hud-success/50' : 'text-hud-line/50')}>›</span>}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}

                    {/* Throughput stats */}
                    {(() => {
                      const stored = ingestEvents.filter(e => e.stage === 'stored')
                      const times = stored.filter(e => e.timestamp).map(e => e.timestamp!)
                      let rate = '—'
                      if (times.length >= 2) {
                        const parse = (t: string) => { const p = t.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2] }
                        const elapsed = Math.abs(parse(times[0]) - parse(times[times.length - 1]))
                        if (elapsed > 0) rate = (stored.length / elapsed).toFixed(2)
                      }
                      const uniqueBlocks = new Set(stored.map(e => `${e.chain}:${e.height}`))
                      const chains = new Set(stored.map(e => e.chain.toUpperCase()))
                      return (
                        <div className="grid grid-cols-3 gap-2">
                          <div className="text-center">
                            <div className="text-[8px] text-hud-text-dim uppercase">Throughput</div>
                            <div className="text-sm font-mono text-hud-cyan">{rate === '—' ? '—' : rate}</div>
                            <div className="text-[7px] text-hud-text-dim">blocks/sec</div>
                          </div>
                          <div className="text-center">
                            <div className="text-[8px] text-hud-text-dim uppercase">Session</div>
                            <div className="text-sm font-mono text-hud-success">{blocksStoredCount}</div>
                            <div className="text-[7px] text-hud-text-dim">blocks stored</div>
                          </div>
                          <div className="text-center">
                            <div className="text-[8px] text-hud-text-dim uppercase">Chains</div>
                            <div className="text-sm font-mono text-hud-purple">{chains.size || '—'}</div>
                            <div className="text-[7px] text-hud-text-dim">{chains.size > 0 ? [...chains].join(', ') : 'none'}</div>
                          </div>
                        </div>
                      )
                    })()}

                    {/* Mini block log */}
                    <div>
                      <div className="text-[7px] text-hud-text-dim uppercase mb-1">Recent Blocks</div>
                      <div className="space-y-0.5 flex-1 overflow-y-auto pt-0.5">
                        {ingestEvents.filter(e => e.stage === 'stored').length === 0 && (
                          <div className="text-[8px] text-hud-text-dim italic">Waiting for blocks...</div>
                        )}
                        {ingestEvents.filter(e => e.stage === 'stored').slice(0, 25).map((evt, i) => (
                          <div key={i} className="flex items-center gap-2 text-[8px] font-mono">
                            <span className="text-hud-success">●</span>
                            <span className="text-hud-text-dim w-10">{evt.chain.toUpperCase()}</span>
                            <span className="text-hud-cyan">{evt.chain === 'sol' ? `Slot ${evt.height}` : `#${evt.height}`}</span>
                            <span className="text-hud-text-dim ml-auto">{evt.timestamp}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </Panel>
              </div>

              <Panel title="Index Stats">
                <div className="grid grid-cols-4 gap-4">
                  <Metric label="Indexed Blocks" value={unfoldStatus?.blocks.toLocaleString() ?? '...'} size="md" />
                  <Metric label="Addresses" value={unfoldStatus?.addresses.toLocaleString() ?? '...'} size="md" />
                  <Metric label="Transactions" value={unfoldStatus?.transactions.toLocaleString() ?? '...'} size="md" />
                  <Metric label="Index Ready" value={unfoldStatus?.ready ? 'YES' : 'NO'} size="md" color={unfoldStatus?.ready ? 'success' : 'warning'} />
                </div>
              </Panel>
            </div>
          )}

          {/* ===== SETTINGS TAB ===== */}
          {tab === 'settings' && <ConfigPanel onAutoIngestChange={setAutoIngestActive} />}
        </motion.div>
      </AnimatePresence>

      {/* Footer */}
      <div className="mt-6 pt-3 border-t border-hud-line flex justify-between items-center">
        <span className="text-[8px] text-hud-text-dim">PATTERN-BASED BLOCKCHAIN VALIDATION ARCHITECTURE</span>
        <span className="text-[8px] text-hud-text-dim">USPTO PROVISIONAL 63/906,240</span>
      </div>
    </div>
  )
}

function ClaimBadge({ label, pass }: { label: string; pass: boolean }) {
  return (
    <div className={clsx(
      'flex items-center gap-2 text-[10px] px-2 py-1 border',
      pass ? 'border-hud-success/40 text-hud-success' : 'border-hud-error/40 text-hud-error'
    )}>
      <span>{pass ? 'PASS' : 'FAIL'}</span>
      <span className="text-hud-text-dim">{label}</span>
    </div>
  )
}

function ThreeTierDiagram({ nodes }: { nodes: ValidatorNode[] }) {
  const mobile = nodes.filter(n => n.tier === 'mobile')
  const pattern = nodes.filter(n => n.tier === 'pattern')
  const archive = nodes.filter(n => n.tier === 'archive')

  return (
    <div className="grid grid-cols-3 gap-4">
      <TierColumn
        name="Mobile Validators"
        tier="mobile"
        color="cyan"
        storage="94 MB"
        desc="Pattern index only"
        nodes={mobile}
      />
      <TierColumn
        name="Pattern Nodes"
        tier="pattern"
        color="purple"
        storage="~5 GB"
        desc="Index + recent blocks"
        nodes={pattern}
      />
      <TierColumn
        name="Archive Nodes"
        tier="archive"
        color="green"
        storage="500+ GB"
        desc="Full blockchain"
        nodes={archive}
      />
    </div>
  )
}

const tierStyles = {
  cyan: { text: 'text-hud-cyan', border: 'border-hud-cyan/30', bg: 'bg-hud-cyan/10' },
  purple: { text: 'text-hud-purple', border: 'border-hud-purple/30', bg: 'bg-hud-purple/10' },
  green: { text: 'text-hud-success', border: 'border-hud-success/30', bg: 'bg-hud-success/10' },
} as const

function TierColumn({ name, tier, color, storage, desc, nodes }: {
  name: string; tier: string; color: keyof typeof tierStyles; storage: string; desc: string; nodes: ValidatorNode[]
}) {
  const styles = tierStyles[color]

  return (
    <div className={clsx('hud-panel p-3 border', styles.border)}>
      <div className="text-center mb-3">
        <div className={clsx('text-[11px] font-medium', styles.text)}>{name}</div>
        <div className="text-[9px] text-hud-text-dim mt-0.5">{desc}</div>
        <div className={clsx('text-[10px] mt-1 px-2 py-0.5 inline-block', styles.bg, styles.text)}>{storage}</div>
      </div>
      <div className="space-y-1">
        {nodes.length === 0 ? (
          <div className="text-[9px] text-hud-text-dim text-center py-2">No {tier} nodes</div>
        ) : nodes.map(n => (
          <div key={n.nodeId} className="flex items-center gap-1.5 text-[9px]">
            <StatusIndicator status={n.status === 'synced' || n.status === 'online' ? 'active' : 'warning'} />
            <span className="text-hud-text truncate">{n.nodeId}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
