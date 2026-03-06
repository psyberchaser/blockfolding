import { useState, useEffect, useRef } from 'react'
import { Panel } from './Panel'
import clsx from 'clsx'
import { HudSelect } from './HudSelect'
import type { ValidatorConfig, RpcTestResult, WatchlistEntry } from '../types'

const CATEGORIES: WatchlistEntry['category'][] = ['exchange', 'dex', 'bridge', 'mixer', 'defi', 'sanctions', 'internal', 'custom']
const CATEGORY_COLORS: Record<string, string> = {
  exchange: 'border-hud-purple/40 text-hud-purple',
  dex: 'border-hud-cyan/40 text-hud-cyan',
  bridge: 'border-hud-warning/40 text-hud-warning',
  mixer: 'border-hud-error/40 text-hud-error',
  defi: 'border-hud-success/40 text-hud-success',
  sanctions: 'border-red-500/60 text-red-400 bg-red-500/10',
  internal: 'border-blue-400/40 text-blue-400',
  custom: 'border-hud-text-dim/40 text-hud-text-dim',
}

export function ConfigPanel({ onAutoIngestChange }: { onAutoIngestChange?: (active: boolean) => void }) {
  const [config, setConfig] = useState<ValidatorConfig | null>(null)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, RpcTestResult>>({})
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Watchlist state
  const [watchlist, setWatchlist] = useState<Record<string, WatchlistEntry>>({})
  const [wlAddress, setWlAddress] = useState('')
  const [wlLabel, setWlLabel] = useState('')
  const [wlCategory, setWlCategory] = useState<WatchlistEntry['category']>('custom')
  const [wlSaving, setWlSaving] = useState(false)
  const [wlImporting, setWlImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/validator/config').then(r => r.json()).then(setConfig).catch(() => {})
    fetch('/validator/watchlist').then(r => r.json()).then(d => setWatchlist(d.entries || {})).catch(() => {})
  }, [])

  const updateChain = (chainId: string, field: string, value: string | boolean) => {
    if (!config) return
    setConfig({
      ...config,
      chains: {
        ...config.chains,
        [chainId]: { ...config.chains[chainId], [field]: value },
      },
    })
    setDirty(true)
  }

  const updateIngestion = (fields: Record<string, number | boolean | string>) => {
    if (!config) return
    setConfig({
      ...config,
      ingestion: { ...config.ingestion, ...fields },
    })
    setDirty(true)
  }

  const testRpc = async (chainId: string) => {
    if (!config) return
    const rpcUrl = config.chains[chainId]?.rpcUrl
    if (!rpcUrl) return
    setTesting(prev => ({ ...prev, [chainId]: true }))
    try {
      const res = await fetch('/validator/config/test-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rpcUrl, chain: chainId === 'sol' ? 'solana' : 'evm' }),
      })
      const data = await res.json()
      setTestResults(prev => ({ ...prev, [chainId]: data }))
    } catch (e) {
      setTestResults(prev => ({ ...prev, [chainId]: { success: false, error: String(e) } }))
    }
    setTesting(prev => ({ ...prev, [chainId]: false }))
  }

  const toggleAutoIngest = async (enabled: boolean) => {
    try {
      await fetch('/validator/ingest/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      onAutoIngestChange?.(enabled)
    } catch {}
  }

  const saveConfig = async () => {
    if (!config) return
    setSaving(true)
    try {
      await fetch('/validator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      setDirty(false)
    } catch {}
    setSaving(false)
  }

  // Watchlist CRUD
  const addWatchlistEntry = async () => {
    if (!wlAddress || !wlLabel) return
    setWlSaving(true)
    try {
      await fetch('/validator/watchlist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: wlAddress, label: wlLabel, category: wlCategory }),
      })
      setWatchlist(prev => ({ ...prev, [wlAddress.toLowerCase()]: { label: wlLabel, category: wlCategory } }))
      setWlAddress('')
      setWlLabel('')
      setWlCategory('custom')
    } catch {}
    setWlSaving(false)
  }

  const removeWatchlistEntry = async (address: string) => {
    try {
      await fetch(`/validator/watchlist/${encodeURIComponent(address)}`, { method: 'DELETE' })
      setWatchlist(prev => {
        const next = { ...prev }
        delete next[address]
        return next
      })
    } catch {}
  }

  const importWatchlistCSV = async (file: File) => {
    setWlImporting(true)
    try {
      const text = await file.text()
      const lines = text.split('\n').filter(l => l.trim())
      const entries: Record<string, WatchlistEntry> = { ...watchlist }
      for (const line of lines) {
        // CSV format: address,label,category
        const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''))
        if (parts.length >= 2 && parts[0].startsWith('0x')) {
          entries[parts[0].toLowerCase()] = {
            label: parts[1],
            category: (parts[2] as WatchlistEntry['category']) || 'custom',
          }
        }
      }
      await fetch('/validator/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      })
      setWatchlist(entries)
    } catch {}
    setWlImporting(false)
  }

  const exportWatchlistCSV = () => {
    const rows = Object.entries(watchlist).map(([addr, e]) => `${addr},${e.label},${e.category}`)
    const csv = 'address,label,category\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'watchlist.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!config) return <Panel title="Configuration"><div className="text-hud-text-dim text-xs">Loading...</div></Panel>

  const chainLabels: Record<string, string> = { eth: 'Ethereum', avax: 'Avalanche', sol: 'Solana' }
  const watchlistEntries = Object.entries(watchlist)

  return (
    <div className="space-y-4">
      <Panel title="RPC Endpoints" titleRight="Chain Connections">
        <div className="space-y-4">
          {Object.entries(config.chains).map(([id, chain]) => (
            <div key={id} className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 shrink-0 w-36">
                  <button
                    type="button"
                    onClick={() => updateChain(id, 'enabled', !chain.enabled)}
                    className={`w-8 h-4 rounded-full relative transition-colors ${chain.enabled ? 'bg-cyan-500' : 'bg-hud-border'}`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${chain.enabled ? 'left-4' : 'left-0.5'}`} />
                  </button>
                  <span className="text-[10px] text-hud-text-bright uppercase tracking-wider">{chainLabels[id] || id}</span>
                </div>
                <input
                  value={chain.rpcUrl}
                  onChange={e => updateChain(id, 'rpcUrl', e.target.value)}
                  placeholder={`${id.toUpperCase()} RPC URL`}
                  className="hud-input flex-1 min-w-0"
                  disabled={!chain.enabled}
                />
                <button
                  onClick={() => testRpc(id)}
                  disabled={!chain.enabled || !chain.rpcUrl || testing[id]}
                  className="hud-button text-[8px] py-1 px-3 shrink-0"
                >
                  {testing[id] ? 'Testing...' : 'Test'}
                </button>
              </div>
              {testResults[id] && (
                <div className={clsx('text-[9px] pl-[9.75rem]', testResults[id].success ? 'text-hud-success' : 'text-hud-error')}>
                  {testResults[id].success
                    ? `Block #${testResults[id].latestBlock?.toLocaleString()} | ${testResults[id].latency}ms | Chain ID: ${testResults[id].chainId}`
                    : `Error: ${testResults[id].error}`
                  }
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Ingestion Settings">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="hud-label block mb-1">Batch Size</label>
            <input
              type="number"
              value={config.ingestion.batchSize}
              onChange={e => updateIngestion({ batchSize: Number(e.target.value) })}
              className="hud-input w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              min={1}
              max={100}
            />
          </div>
          <div>
            <label className="hud-label block mb-1">Hotzone Limit</label>
            <input
              type="number"
              value={config.ingestion.hotzoneLimit}
              onChange={e => updateIngestion({ hotzoneLimit: Number(e.target.value) })}
              className="hud-input w-full [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              min={1}
              max={50}
            />
          </div>
          <div>
            <label className="hud-label block mb-1">ZK Proving</label>
            <button
              type="button"
              onClick={() => updateIngestion({ zkProving: !config.ingestion.zkProving })}
              className={`mt-1.5 w-10 h-5 rounded-full relative transition-colors ${config.ingestion.zkProving ? 'bg-cyan-500' : 'bg-hud-border'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${config.ingestion.zkProving ? 'left-5' : 'left-0.5'}`} />
            </button>
            <span className="text-[10px] text-hud-text block mt-1">{config.ingestion.zkProving ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div>
            <label className="hud-label block mb-1">Auto-Ingest</label>
            <button
              type="button"
              onClick={() => { const next = !(config.ingestion.autoIngest ?? false); updateIngestion({ autoIngest: next }); toggleAutoIngest(next) }}
              className={`mt-1.5 w-10 h-5 rounded-full relative transition-colors ${config.ingestion.autoIngest ? 'bg-cyan-500' : 'bg-hud-border'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${config.ingestion.autoIngest ? 'left-5' : 'left-0.5'}`} />
            </button>
            <span className="text-[10px] text-hud-text block mt-1">{config.ingestion.autoIngest ? 'Running' : 'Off'}</span>
            <span className="text-[8px] text-hud-text-dim block">Polls every ~12s for new blocks</span>
          </div>
          <div>
            <label className="hud-label block mb-1">Keep Raw Blocks</label>
            <button
              type="button"
              onClick={() => { const discard = !(config.ingestion.discardRaw ?? false); updateIngestion(discard ? { discardRaw: true, unfoldMode: 'rpc' } : { discardRaw: false }); }}
              className={`mt-1.5 w-10 h-5 rounded-full relative transition-colors ${!(config.ingestion.discardRaw ?? false) ? 'bg-cyan-500' : 'bg-hud-border'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${!(config.ingestion.discardRaw ?? false) ? 'left-5' : 'left-0.5'}`} />
            </button>
            <span className="text-[10px] text-hud-text block mt-1">{config.ingestion.discardRaw ? 'Discarding after fold' : 'Keeping raw-block.json'}</span>
            <span className="text-[8px] text-hud-text-dim block">{config.ingestion.discardRaw ? 'Saves ~12x storage, unfold requires RPC' : 'Enables local unfold + address index'}</span>
          </div>
          <div>
            <label className="hud-label block mb-1">Unfold Mode</label>
            <HudSelect
              value={config.ingestion.discardRaw ? 'rpc' : (config.ingestion.unfoldMode ?? 'local')}
              onChange={v => updateIngestion({ unfoldMode: v })}
              options={config.ingestion.discardRaw
                ? [{ value: 'rpc', label: 'RPC (required)' }]
                : [
                    { value: 'local', label: 'Local (recommended)' },
                    { value: 'rpc', label: 'RPC' },
                  ]}
            />
            <span className="text-[8px] text-hud-text-dim block mt-1">
              {config.ingestion.discardRaw
                ? 'Raw blocks discarded — unfold requires live RPC'
                : (config.ingestion.unfoldMode ?? 'local') === 'local'
                  ? 'Stores compact txs in fold — unfold works offline'
                  : 'Lean storage — unfold requires live RPC node'}
            </span>
          </div>
        </div>
      </Panel>

      {/* Entity Watchlist */}
      <Panel title="Entity Watchlist" titleRight={`${watchlistEntries.length} entries`}>
        <div className="space-y-3">
          <div className="text-[8px] text-hud-text-dim">
            Add known addresses for compliance labeling. Import Chainalysis, Elliptic, or internal sanctions lists via CSV.
          </div>

          {/* Add entry form */}
          <div className="flex gap-2 items-end">
            <div className="flex-1 min-w-0">
              <label className="hud-label block mb-1">Address</label>
              <input
                value={wlAddress}
                onChange={e => setWlAddress(e.target.value)}
                placeholder="0x..."
                className="hud-input w-full font-mono"
              />
            </div>
            <div className="w-40">
              <label className="hud-label block mb-1">Label</label>
              <input
                value={wlLabel}
                onChange={e => setWlLabel(e.target.value)}
                placeholder="e.g. DBS Treasury"
                className="hud-input w-full"
              />
            </div>
            <div className="w-28">
              <label className="hud-label block mb-1">Category</label>
              <HudSelect
                value={wlCategory}
                onChange={v => setWlCategory(v as WatchlistEntry['category'])}
                options={CATEGORIES.map(c => ({ value: c, label: c.toUpperCase() }))}
              />
            </div>
            <button
              onClick={addWatchlistEntry}
              disabled={!wlAddress || !wlLabel || wlSaving}
              className="hud-button text-[8px] py-1.5 px-3 shrink-0"
            >
              {wlSaving ? 'Adding...' : 'Add'}
            </button>
          </div>

          {/* Import/Export */}
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={e => { if (e.target.files?.[0]) importWatchlistCSV(e.target.files[0]); e.target.value = '' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={wlImporting}
              className="hud-button text-[8px] py-1 px-3"
            >
              {wlImporting ? 'Importing...' : 'Import CSV'}
            </button>
            {watchlistEntries.length > 0 && (
              <button onClick={exportWatchlistCSV} className="hud-button text-[8px] py-1 px-3">
                Export CSV
              </button>
            )}
            <span className="text-[8px] text-hud-text-dim self-center ml-1">Format: address,label,category</span>
          </div>

          {/* Entries table */}
          {watchlistEntries.length > 0 && (
            <div className="overflow-x-auto max-h-60 overflow-y-auto">
              <table className="w-full text-[9px]">
                <thead>
                  <tr className="text-hud-text-dim border-b border-hud-line sticky top-0 bg-hud-bg">
                    <th className="text-left py-1 px-2">ADDRESS</th>
                    <th className="text-left py-1 px-2">LABEL</th>
                    <th className="text-left py-1 px-2">CATEGORY</th>
                    <th className="text-right py-1 px-2 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {watchlistEntries.map(([addr, entry]) => (
                    <tr key={addr} className="border-b border-hud-line/30 hover:bg-hud-line/10">
                      <td className="py-1 px-2 text-hud-cyan font-mono">{addr.slice(0, 22)}...</td>
                      <td className="py-1 px-2 text-hud-text-bright">{entry.label}</td>
                      <td className="py-1 px-2">
                        <span className={clsx('text-[7px] px-1.5 py-0.5 border', CATEGORY_COLORS[entry.category] || CATEGORY_COLORS.custom)}>
                          {entry.category}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right">
                        <button
                          onClick={() => removeWatchlistEntry(addr)}
                          className="text-hud-error/60 hover:text-hud-error text-[8px]"
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Codebook">
        <div className="text-[10px] text-hud-text">
          <span className="hud-label">Path:</span>
          <span className="ml-2 text-hud-cyan font-mono">{config.codebookPath || 'artifacts/codebooks/latest.json (default)'}</span>
        </div>
      </Panel>

      {dirty && (
        <div className="flex justify-end">
          <button onClick={saveConfig} disabled={saving} className="hud-button">
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      )}
    </div>
  )
}
