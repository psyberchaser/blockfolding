import { useMemo } from 'react'

interface RadarHexProps {
  labels: string[]
  values: number[] // 0-1 normalized
  size?: number
  color?: string
  bgColor?: string
}

export default function RadarHex({ labels, values, size = 220, color = '#00e5ff', bgColor = '#0a1628' }: RadarHexProps) {
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.38
  const n = labels.length

  const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2

  const rings = [0.25, 0.5, 0.75, 1.0]

  const axisPoints = useMemo(() =>
    Array.from({ length: n }, (_, i) => {
      const a = angleFor(i)
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), labelX: cx + (r + 18) * Math.cos(a), labelY: cy + (r + 18) * Math.sin(a) }
    }), [n, cx, cy, r])

  const dataPoints = useMemo(() =>
    values.map((v, i) => {
      const a = angleFor(i)
      const vClamped = Math.max(0, Math.min(1, v))
      return `${cx + r * vClamped * Math.cos(a)},${cy + r * vClamped * Math.sin(a)}`
    }).join(' '), [values, cx, cy, r, n])

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="mx-auto">
      {/* Background rings */}
      {rings.map(pct => {
        const pts = Array.from({ length: n }, (_, i) => {
          const a = angleFor(i)
          return `${cx + r * pct * Math.cos(a)},${cy + r * pct * Math.sin(a)}`
        }).join(' ')
        return <polygon key={pct} points={pts} fill="none" stroke="#1a3050" strokeWidth={0.5} />
      })}

      {/* Axis lines */}
      {axisPoints.map((p, i) => (
        <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#1a3050" strokeWidth={0.5} />
      ))}

      {/* Data polygon */}
      <polygon points={dataPoints} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1.5} />

      {/* Data dots */}
      {values.map((v, i) => {
        const a = angleFor(i)
        const vClamped = Math.max(0, Math.min(1, v))
        return <circle key={i} cx={cx + r * vClamped * Math.cos(a)} cy={cy + r * vClamped * Math.sin(a)} r={3} fill={color} />
      })}

      {/* Labels */}
      {axisPoints.map((p, i) => (
        <text key={i} x={p.labelX} y={p.labelY} textAnchor="middle" dominantBaseline="middle" fill="#7a98b8" fontSize={9} fontFamily="monospace">
          {labels[i]}
        </text>
      ))}
    </svg>
  )
}
