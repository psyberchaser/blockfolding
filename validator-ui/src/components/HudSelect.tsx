import { useState, useRef, useEffect } from 'react'
import clsx from 'clsx'

interface HudSelectProps {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  className?: string
  name?: string
}

export function HudSelect({ value, onChange, options, className, name }: HudSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selected = options.find(o => o.value === value)

  return (
    <div ref={ref} className={clsx('relative', className)}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full hud-input flex items-center justify-between gap-2 text-left"
      >
        <span>{selected?.label ?? value}</span>
        <span className="text-hud-text-dim text-[8px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute z-50 top-[calc(100%+4px)] left-0 right-0 border border-hud-line bg-hud-bg shadow-lg shadow-black/40">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-[11px] font-mono transition-colors',
                opt.value === value
                  ? 'text-hud-cyan bg-hud-cyan/10'
                  : 'text-hud-text hover:text-hud-text-bright hover:bg-hud-line/30'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
