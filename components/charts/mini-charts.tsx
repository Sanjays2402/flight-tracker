'use client'
// [BATCH-C] Tiny inline SVG sparkline + histogram primitives (no deps).
import { useMemo } from 'react'

interface SparkProps {
  data: number[]
  width?: number
  height?: number
  color?: string
  fill?: string
  label?: string
  unit?: string
  baseline?: number  // optional zero-line (for vert rate)
}

export function Sparkline({ data, width = 200, height = 50, color = '#38bdf8', fill, label, unit, baseline }: SparkProps) {
  const { path, area, min, max, last } = useMemo(() => {
    if (!data || data.length < 2) return { path: '', area: '', min: 0, max: 0, last: 0 }
    const lo = Math.min(...data, baseline ?? Infinity)
    const hi = Math.max(...data, baseline ?? -Infinity)
    const span = Math.max(1, hi - lo)
    const step = width / Math.max(1, data.length - 1)
    const pts = data.map((v, i) => [i * step, height - ((v - lo) / span) * (height - 4) - 2] as const)
    const p = pts.map((pt, i) => (i === 0 ? `M${pt[0].toFixed(1)},${pt[1].toFixed(1)}` : `L${pt[0].toFixed(1)},${pt[1].toFixed(1)}`)).join(' ')
    const a = `${p} L${pts[pts.length-1][0].toFixed(1)},${height} L0,${height} Z`
    return { path: p, area: a, min: lo, max: hi, last: data[data.length-1] }
  }, [data, width, height, baseline])

  if (!path) {
    return <div className="text-[10px] text-slate-600 italic px-1 py-2">{label ? `${label}: ` : ''}collecting data…</div>
  }

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
      {label && (
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">{label}</span>
          <span className="text-[10px] font-mono text-slate-300">{Math.round(last)}{unit || ''}</span>
        </div>
      )}
      <svg width={width} height={height} className="block w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {fill && <path d={area} fill={fill} opacity={0.25} />}
        <path d={path} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-between text-[9px] text-slate-600 font-mono mt-0.5">
        <span>min {Math.round(min)}</span><span>max {Math.round(max)}</span>
      </div>
    </div>
  )
}

interface HistProps {
  values: number[]
  bins: number
  width?: number
  height?: number
  color?: string
  label?: string
  formatter?: (v: number) => string
}

export function Histogram({ values, bins, width = 240, height = 60, color = '#38bdf8', label, formatter }: HistProps) {
  const { rects, lo, hi, maxC } = useMemo(() => {
    if (!values || values.length === 0) return { rects: [] as Array<{x:number;w:number;h:number;y:number;c:number}>, lo: 0, hi: 0, maxC: 0 }
    const mn = Math.min(...values)
    const mx = Math.max(...values)
    const span = Math.max(1e-6, mx - mn)
    const counts = new Array(bins).fill(0)
    for (const v of values) {
      const i = Math.min(bins-1, Math.floor(((v - mn) / span) * bins))
      counts[i]++
    }
    const mc = Math.max(1, ...counts)
    const bw = width / bins
    const r = counts.map((c, i) => {
      const h = (c / mc) * (height - 2)
      return { x: i * bw, w: Math.max(1, bw - 1), h, y: height - h, c }
    })
    return { rects: r, lo: mn, hi: mx, maxC: mc }
  }, [values, bins, width, height])

  if (rects.length === 0) {
    return <div className="text-[10px] text-slate-600 italic px-1 py-2">{label}: no data</div>
  }

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
      {label && (
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">{label}</span>
          <span className="text-[10px] font-mono text-slate-500">n={values.length}</span>
        </div>
      )}
      <svg width={width} height={height} className="block w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={color} opacity={0.4 + 0.6 * (r.c / maxC)} />
        ))}
      </svg>
      <div className="flex justify-between text-[9px] text-slate-600 font-mono mt-0.5">
        <span>{formatter ? formatter(lo) : Math.round(lo)}</span>
        <span>{formatter ? formatter(hi) : Math.round(hi)}</span>
      </div>
    </div>
  )
}

// Horizontal progress bar with optional segments.
export function ProgressBar({ pct, label, value, color = '#38bdf8' }: { pct: number; label?: string; value?: string; color?: string }) {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
      {(label || value) && (
        <div className="flex items-baseline justify-between mb-1">
          {label && <span className="text-[9px] uppercase tracking-widest text-slate-500">{label}</span>}
          {value && <span className="text-[10px] font-mono text-slate-300">{value}</span>}
        </div>
      )}
      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full transition-all duration-500 rounded-full" style={{ width: `${p}%`, background: color }} />
      </div>
      <div className="text-[9px] font-mono text-slate-500 mt-1 text-right">{p.toFixed(1)}%</div>
    </div>
  )
}

// Top-N bar list (for stats).
export function TopBars({ items, color = '#38bdf8', max }: { items: Array<{key: string; count: number}>; color?: string; max?: number }) {
  if (items.length === 0) return <div className="text-[10px] text-slate-600 italic py-1">no data</div>
  const m = max ?? items[0].count
  return (
    <div className="space-y-1">
      {items.map((it) => (
        <div key={it.key} className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-300 truncate w-20 shrink-0">{it.key}</span>
          <div className="flex-1 h-2 bg-slate-800 rounded">
            <div className="h-full rounded" style={{ width: `${(it.count / m) * 100}%`, background: color }} />
          </div>
          <span className="text-[10px] font-mono text-slate-400 w-8 text-right tabular-nums">{it.count}</span>
        </div>
      ))}
    </div>
  )
}
