'use client'
import { useMemo } from 'react'

interface MiniFlight {
  icao: string
  callsign: string
  registration: string
  type: string
  operator: string
  lng: number
  lat: number
  altitudeFt: number
  track: number
  velocityKts: number
}

export interface HoldingHit {
  icao: string
  callsign: string
  type: string
  operator: string
  altitudeFt: number
  centerLat: number
  centerLng: number
  radiusNm: number
  loops: number
  totalTurnDeg: number
  direction: 'left' | 'right'
  spanSec: number
  score: number
}

// Detect holding patterns / orbits from raw trail history.
// A "hold" = sustained turn in one direction (>= ~360° cumulative)
// with a tight geographic footprint (small bounding radius) over time.
export function detectHolding(
  flights: MiniFlight[],
  trails: Map<string, Array<[number, number, number]>>,
  opts: { minTurnDeg: number; maxRadiusNm: number; minSpanSec: number }
): HoldingHit[] {
  const out: HoldingHit[] = []
  for (const f of flights) {
    const t = trails.get(f.icao)
    if (!t || t.length < 6) continue
    const span = (t[t.length - 1][2] - t[0][2]) / 1000
    if (span < opts.minSpanSec) continue

    // bearings between consecutive samples
    let cum = 0
    let lastBrg: number | null = null
    let lefts = 0, rights = 0
    for (let i = 1; i < t.length; i++) {
      const b = bearing(t[i - 1][0], t[i - 1][1], t[i][0], t[i][1])
      if (lastBrg != null) {
        let d = b - lastBrg
        while (d > 180) d -= 360
        while (d < -180) d += 360
        if (Math.abs(d) > 1 && Math.abs(d) < 60) {
          cum += d
          if (d > 0) rights++; else lefts++
        }
      }
      lastBrg = b
    }
    const totalTurn = Math.abs(cum)
    if (totalTurn < opts.minTurnDeg) continue
    // bounding radius
    const cLat = t.reduce((s, p) => s + p[0], 0) / t.length
    const cLng = t.reduce((s, p) => s + p[1], 0) / t.length
    let maxNm = 0
    for (const p of t) {
      const d = haversineNm(cLat, cLng, p[0], p[1])
      if (d > maxNm) maxNm = d
    }
    if (maxNm > opts.maxRadiusNm) continue

    const loops = totalTurn / 360
    const direction: 'left' | 'right' = cum > 0 ? 'right' : 'left'
    // require dominant direction (>70% of turn samples)
    const total = lefts + rights
    if (total > 0) {
      const dom = direction === 'right' ? rights / total : lefts / total
      if (dom < 0.7) continue
    }
    const score = loops * 100 + Math.max(0, 30 - maxNm) + Math.min(60, span / 10)
    out.push({
      icao: f.icao,
      callsign: f.callsign || f.registration || f.icao,
      type: f.type,
      operator: f.operator,
      altitudeFt: f.altitudeFt,
      centerLat: cLat,
      centerLng: cLng,
      radiusNm: maxNm,
      loops,
      totalTurnDeg: totalTurn,
      direction,
      spanSec: span,
      score,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const dφ = ((lat2 - lat1) * Math.PI) / 180
  const dλ = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export default function HoldingPanel(props: {
  hits: HoldingHit[]
  minTurnDeg: number
  maxRadiusNm: number
  minSpanSec: number
  onChangeTurn: (v: number) => void
  onChangeRadius: (v: number) => void
  onChangeSpan: (v: number) => void
  onSelect: (icao: string) => void
  onClose: () => void
}) {
  const { hits } = props
  const summary = useMemo(() => {
    const lefts = hits.filter(h => h.direction === 'left').length
    const rights = hits.length - lefts
    const avgAlt = hits.length ? Math.round(hits.reduce((s, h) => s + h.altitudeFt, 0) / hits.length) : 0
    return { lefts, rights, avgAlt }
  }, [hits])

  return (
    <div className="absolute top-20 right-4 z-30 w-96 max-h-[calc(100vh-7rem)] bg-slate-950/92 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-gradient-to-r from-amber-500/10 to-transparent">
        <div>
          <div className="text-xs uppercase tracking-widest text-amber-400 font-semibold">Holding Patterns</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Sustained orbits detected from live trails</div>
        </div>
        <button onClick={props.onClose} className="text-slate-500 hover:text-slate-100 text-lg leading-none">✕</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] uppercase text-slate-500">Total</div>
          <div className="text-lg font-bold text-amber-300">{hits.length}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-500">L / R</div>
          <div className="text-lg font-bold text-slate-200">{summary.lefts} / {summary.rights}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-500">Avg Alt</div>
          <div className="text-lg font-bold text-slate-200">{summary.avgAlt ? `${(summary.avgAlt / 1000).toFixed(1)}k` : '—'}</div>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 space-y-2 text-[11px]">
        <Slider label="Min turn" value={props.minTurnDeg} min={180} max={1080} step={30} unit="°" onChange={props.onChangeTurn} />
        <Slider label="Max radius" value={props.maxRadiusNm} min={2} max={30} step={1} unit=" nm" onChange={props.onChangeRadius} />
        <Slider label="Min span" value={props.minSpanSec} min={60} max={600} step={30} unit=" s" onChange={props.onChangeSpan} />
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-900">
        {hits.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-slate-500">
            No holding patterns detected.<br />
            <span className="text-slate-600">Loosen thresholds or wait for trails to build.</span>
          </div>
        )}
        {hits.slice(0, 40).map(h => (
          <button
            key={h.icao}
            onClick={() => props.onSelect(h.icao)}
            className="w-full text-left px-4 py-2.5 hover:bg-slate-900/60 transition flex items-center gap-3"
          >
            <div className={`w-8 h-8 rounded-full border flex items-center justify-center text-base ${h.direction === 'right' ? 'border-amber-500/50 text-amber-300' : 'border-cyan-500/50 text-cyan-300'}`}>
              {h.direction === 'right' ? '↻' : '↺'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-100 truncate">{h.callsign}</span>
                <span className="text-[10px] text-slate-500 font-mono">{h.type || '—'}</span>
              </div>
              <div className="text-[10px] text-slate-400 truncate">{h.operator || '—'}</div>
              <div className="text-[10px] text-slate-500 mt-0.5 flex gap-3">
                <span>{h.loops.toFixed(1)} loops</span>
                <span>r{h.radiusNm.toFixed(1)}nm</span>
                <span>{Math.round(h.altitudeFt).toLocaleString()}ft</span>
                <span>{Math.round(h.spanSec)}s</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex justify-between text-slate-400">
        <span>{props.label}</span>
        <span className="font-mono text-amber-300">{props.value}{props.unit}</span>
      </div>
      <input
        type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={e => props.onChange(Number(e.target.value))}
        className="w-full accent-amber-400"
      />
    </label>
  )
}
