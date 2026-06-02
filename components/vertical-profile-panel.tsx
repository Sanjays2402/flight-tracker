'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

/* ============================================================
   Vertical Profile (side-view) panel
   ---------------------------------------------------------------
   X axis = great-circle distance from the current map center (nm).
   Y axis = altitude (ft, 0-50000).
   Every live aircraft is plotted as a dot, colored by altitude
   band, with a small forward vector indicating projected
   altitude/range change over the next N minutes (using GS, VS and
   track relative to the bearing back to the map center).
   Drag to brush a region; brushed list appears below with
   click-to-fly. Filters: ground, max range, vertical-rate min,
   altitude-band chips. Useful for spotting arrivals stepping down
   onto an airport, climbing departures, or jets cruising at FL360.
   Self-contained SVG, no map overlays, fully responsive.
   ============================================================ */

export interface VPFlight {
  icao: string
  callsign: string
  type: string
  lat: number
  lng: number
  altitudeFt: number
  ground: boolean
  velocityKts: number
  vertRate: number
  track: number
  emergency: boolean
  military: boolean
}

interface Props {
  flights: VPFlight[]
  center: { lat: number; lng: number } | null
  onClose: () => void
  onFly?: (icao: string) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function distNm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dφ = (lat2 - lat1) * RAD
  const dλ = (lng2 - lng1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}

function bearing(lat1: number, lng1: number, lat2: number, lng2: number) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD
  const dλ = (lng2 - lng1) * RAD
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * DEG + 360) % 360
}

function altColor(ft: number): string {
  if (ft <= 0) return '#94a3b8'
  if (ft < 1000) return '#f43f5e'
  if (ft < 5000) return '#fb923c'
  if (ft < 10000) return '#facc15'
  if (ft < 20000) return '#84cc16'
  if (ft < 30000) return '#22d3ee'
  if (ft < 40000) return '#60a5fa'
  return '#a78bfa'
}

const ALT_BANDS: { id: string; label: string; min: number; max: number }[] = [
  { id: 'gnd', label: 'GND', min: -100, max: 500 },
  { id: 'low', label: '<10k', min: 500, max: 10000 },
  { id: 'mid', label: '10-25k', min: 10000, max: 25000 },
  { id: 'high', label: '25-40k', min: 25000, max: 40000 },
  { id: 'fl400', label: '>40k', min: 40000, max: 99999 },
]

export default function VerticalProfilePanel({ flights, center, onClose, onFly }: Props) {
  const [maxRange, setMaxRange] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('ft-vp-rng') || '300'); return Number.isFinite(v) ? v : 300 } catch { return 300 }
  })
  const [showGround, setShowGround] = useState<boolean>(() => {
    try { return localStorage.getItem('ft-vp-grd') === '1' } catch { return false }
  })
  const [vsMin, setVsMin] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('ft-vp-vsmin') || '0'); return Number.isFinite(v) ? v : 0 } catch { return 0 }
  })
  const [projMin, setProjMin] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('ft-vp-prj') || '3'); return Number.isFinite(v) ? v : 3 } catch { return 3 }
  })
  const [enabledBands, setEnabledBands] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('ft-vp-bands')
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {}
    return new Set(ALT_BANDS.map(b => b.id))
  })
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<{ x: number; y: number; f: ScoredFlight } | null>(null)
  const [brush, setBrush] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [brushed, setBrushed] = useState<ScoredFlight[]>([])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const draggingRef = useRef<null | { x0: number; y0: number }>(null)

  useEffect(() => { try { localStorage.setItem('ft-vp-rng', String(maxRange)) } catch {} }, [maxRange])
  useEffect(() => { try { localStorage.setItem('ft-vp-grd', showGround ? '1' : '0') } catch {} }, [showGround])
  useEffect(() => { try { localStorage.setItem('ft-vp-vsmin', String(vsMin)) } catch {} }, [vsMin])
  useEffect(() => { try { localStorage.setItem('ft-vp-prj', String(projMin)) } catch {} }, [projMin])
  useEffect(() => { try { localStorage.setItem('ft-vp-bands', JSON.stringify([...enabledBands])) } catch {} }, [enabledBands])

  // Layout
  const W = 560
  const H = 320
  const PAD = { l: 46, r: 12, t: 12, b: 28 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const altMax = 50000
  const xOf = (nm: number) => PAD.l + (nm / maxRange) * plotW
  const yOf = (ft: number) => PAD.t + plotH - (Math.max(0, Math.min(altMax, ft)) / altMax) * plotH

  interface ScoredFlight extends VPFlight { rng: number; brg: number; closing: number }
  const scored = useMemo<ScoredFlight[]>(() => {
    if (!center) return []
    const q = query.trim().toLowerCase()
    const out: ScoredFlight[] = []
    for (const f of flights) {
      if (!showGround && f.ground) continue
      if (Math.abs(f.vertRate) < vsMin) continue
      const rng = distNm(center.lat, center.lng, f.lat, f.lng)
      if (rng > maxRange) continue
      const ft = Math.max(0, f.altitudeFt)
      const bandOk = ALT_BANDS.some(b => enabledBands.has(b.id) && ft >= b.min && ft < b.max)
      if (!bandOk) continue
      if (q) {
        const hay = `${f.callsign} ${f.icao} ${f.type}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      // closing speed component: positive = closing on center
      const brg = bearing(f.lat, f.lng, center.lat, center.lng) // toward center
      const rel = ((f.track - brg + 540) % 360) - 180 // -180..180; 0 = heading at center
      const closing = f.velocityKts * Math.cos(rel * RAD)
      out.push({ ...f, rng, brg, closing })
    }
    return out
  }, [flights, center, maxRange, showGround, vsMin, enabledBands, query])

  const stats = useMemo(() => {
    let air = 0, gnd = 0, climb = 0, desc = 0, sumAlt = 0
    for (const f of scored) {
      if (f.ground) gnd++; else air++
      if (f.vertRate > 200) climb++
      if (f.vertRate < -200) desc++
      sumAlt += f.altitudeFt
    }
    return { n: scored.length, air, gnd, climb, desc, avg: scored.length ? sumAlt / scored.length : 0 }
  }, [scored])

  function onMouseDown(e: React.MouseEvent) {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    const x = ((e.clientX - r.left) / r.width) * W
    const y = ((e.clientY - r.top) / r.height) * H
    draggingRef.current = { x0: x, y0: y }
    setBrush({ x0: x, y0: y, x1: x, y1: y })
  }
  function onMouseMove(e: React.MouseEvent) {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    const x = ((e.clientX - r.left) / r.width) * W
    const y = ((e.clientY - r.top) / r.height) * H
    if (draggingRef.current) {
      setBrush({ x0: draggingRef.current.x0, y0: draggingRef.current.y0, x1: x, y1: y })
      return
    }
    // hover lookup (nearest)
    let best: ScoredFlight | null = null
    let bd = 18 * 18
    for (const f of scored) {
      const fx = xOf(f.rng); const fy = yOf(f.altitudeFt)
      const d = (fx - x) * (fx - x) + (fy - y) * (fy - y)
      if (d < bd) { bd = d; best = f }
    }
    if (best) setHover({ x, y, f: best })
    else setHover(null)
  }
  function onMouseUp() {
    const b = brush
    draggingRef.current = null
    if (!b) return
    const dx = Math.abs(b.x1 - b.x0), dy = Math.abs(b.y1 - b.y0)
    if (dx < 4 || dy < 4) { setBrush(null); return }
    const xMin = Math.min(b.x0, b.x1), xMax = Math.max(b.x0, b.x1)
    const yMin = Math.min(b.y0, b.y1), yMax = Math.max(b.y0, b.y1)
    const hit = scored.filter(f => {
      const fx = xOf(f.rng); const fy = yOf(f.altitudeFt)
      return fx >= xMin && fx <= xMax && fy >= yMin && fy <= yMax
    })
    setBrushed(hit)
    setBrush(null)
  }
  function onMouseLeave() { setHover(null); draggingRef.current = null; setBrush(null) }

  // Axis ticks
  const xTicks = useMemo(() => {
    const ts: number[] = []
    const step = maxRange <= 50 ? 10 : maxRange <= 150 ? 25 : maxRange <= 400 ? 50 : 100
    for (let v = 0; v <= maxRange + 0.1; v += step) ts.push(v)
    return ts
  }, [maxRange])
  const yTicks = [0, 5000, 10000, 20000, 30000, 40000, 50000]

  function projVector(f: ScoredFlight): { x2: number; y2: number } {
    const m = Math.max(0.5, Math.min(15, projMin))
    const hrs = m / 60
    const dRng = -f.closing * hrs // negative closing = moving away
    const newRng = Math.max(0, f.rng + dRng)
    const newAlt = Math.max(0, Math.min(altMax, f.altitudeFt + f.vertRate * 60 * m))
    return { x2: xOf(newRng), y2: yOf(newAlt) }
  }

  function toggleBand(id: string) {
    setEnabledBands(prev => {
      const nv = new Set(prev)
      if (nv.has(id)) nv.delete(id); else nv.add(id)
      return nv
    })
  }

  return (
    <aside className="absolute z-20 top-20 sm:top-24 left-2 sm:left-3 w-[min(96vw,38rem)] max-h-[calc(100dvh-7rem)] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-100">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800 sticky top-0 bg-slate-950/95 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-widest text-slate-400">Vertical Profile</div>
          <div className="text-sm font-bold truncate">Side view from map center · {stats.n} ac</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-1">×</button>
      </div>

      <div className="px-3 pt-2 pb-1">
        <div className="grid grid-cols-5 gap-1 text-center text-[10px]">
          <div className="bg-slate-900 rounded p-1.5"><div className="text-slate-500 uppercase tracking-widest">Total</div><div className="font-bold text-slate-100">{stats.n}</div></div>
          <div className="bg-slate-900 rounded p-1.5"><div className="text-slate-500 uppercase tracking-widest">Air</div><div className="font-bold text-cyan-300">{stats.air}</div></div>
          <div className="bg-slate-900 rounded p-1.5"><div className="text-slate-500 uppercase tracking-widest">Gnd</div><div className="font-bold text-slate-400">{stats.gnd}</div></div>
          <div className="bg-slate-900 rounded p-1.5"><div className="text-slate-500 uppercase tracking-widest">Clb</div><div className="font-bold text-emerald-300">{stats.climb}</div></div>
          <div className="bg-slate-900 rounded p-1.5"><div className="text-slate-500 uppercase tracking-widest">Des</div><div className="font-bold text-rose-300">{stats.desc}</div></div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto bg-slate-900/70 rounded-xl border border-slate-800 cursor-crosshair select-none"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
        >
          {/* horizontal alt grid */}
          {yTicks.map(t => (
            <g key={`y${t}`}>
              <line x1={PAD.l} x2={W - PAD.r} y1={yOf(t)} y2={yOf(t)} stroke="#1e293b" strokeWidth={1} strokeDasharray="2 4" />
              <text x={PAD.l - 4} y={yOf(t) + 3} fill="#64748b" fontSize="9" textAnchor="end" fontFamily="ui-monospace,monospace">{t === 0 ? 'GND' : `FL${Math.round(t / 100)}`}</text>
            </g>
          ))}
          {/* vertical range grid */}
          {xTicks.map(t => (
            <g key={`x${t}`}>
              <line x1={xOf(t)} x2={xOf(t)} y1={PAD.t} y2={H - PAD.b} stroke="#1e293b" strokeWidth={1} strokeDasharray="2 4" />
              <text x={xOf(t)} y={H - PAD.b + 12} fill="#64748b" fontSize="9" textAnchor="middle" fontFamily="ui-monospace,monospace">{t === 0 ? '0' : `${t}nm`}</text>
            </g>
          ))}
          {/* center axis hint */}
          <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} stroke="#334155" strokeWidth={1.5} />
          <text x={PAD.l + 4} y={PAD.t + 10} fill="#94a3b8" fontSize="9" fontFamily="ui-monospace,monospace">CENTER</text>

          {/* projection vectors first (under dots) */}
          {scored.map(f => {
            const x1 = xOf(f.rng); const y1 = yOf(f.altitudeFt)
            const { x2, y2 } = projVector(f)
            const c = altColor(f.altitudeFt)
            return <line key={`v${f.icao}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1} strokeOpacity={0.45} />
          })}

          {/* dots */}
          {scored.map(f => {
            const cx = xOf(f.rng); const cy = yOf(f.altitudeFt)
            const c = f.emergency ? '#f43f5e' : altColor(f.altitudeFt)
            const r = f.emergency ? 5 : f.military ? 4.2 : 3.4
            return (
              <g key={f.icao}>
                <circle cx={cx} cy={cy} r={r + 1} fill={c} fillOpacity={0.15} />
                <circle
                  cx={cx} cy={cy} r={r} fill={c} stroke="#0f172a" strokeWidth={0.6}
                  onClick={() => onFly?.(f.icao)}
                  style={{ cursor: 'pointer' }}
                />
              </g>
            )
          })}

          {/* brush rect */}
          {brush && (() => {
            const x = Math.min(brush.x0, brush.x1); const y = Math.min(brush.y0, brush.y1)
            const w = Math.abs(brush.x1 - brush.x0); const h = Math.abs(brush.y1 - brush.y0)
            return <rect x={x} y={y} width={w} height={h} fill="#22d3ee22" stroke="#22d3ee" strokeWidth={1} strokeDasharray="3 3" />
          })()}

          {/* hover tooltip */}
          {hover && (() => {
            const fx = xOf(hover.f.rng); const fy = yOf(hover.f.altitudeFt)
            const tx = Math.min(W - 130, fx + 8)
            const ty = Math.max(PAD.t + 4, fy - 50)
            return (
              <g pointerEvents="none">
                <rect x={tx} y={ty} width={124} height={46} rx={4} fill="#020617" stroke="#334155" />
                <text x={tx + 5} y={ty + 12} fill="#e2e8f0" fontSize="10" fontWeight="bold" fontFamily="ui-monospace,monospace">{hover.f.callsign || hover.f.icao}</text>
                <text x={tx + 5} y={ty + 24} fill="#94a3b8" fontSize="9" fontFamily="ui-monospace,monospace">{hover.f.type || '—'} · {hover.f.rng.toFixed(0)}nm</text>
                <text x={tx + 5} y={ty + 35} fill="#94a3b8" fontSize="9" fontFamily="ui-monospace,monospace">{Math.round(hover.f.altitudeFt).toLocaleString()}ft · {Math.round(hover.f.velocityKts)}kt</text>
                <text x={tx + 5} y={ty + 44} fill={hover.f.vertRate > 200 ? '#34d399' : hover.f.vertRate < -200 ? '#fb7185' : '#94a3b8'} fontSize="9" fontFamily="ui-monospace,monospace">VS {hover.f.vertRate > 0 ? '+' : ''}{Math.round(hover.f.vertRate)}fpm</text>
              </g>
            )
          })()}
        </svg>
      </div>

      <div className="px-3 pb-2 space-y-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 uppercase tracking-widest text-[9px] w-14">Range</span>
          <input type="range" min={20} max={1000} step={10} value={maxRange} onChange={e => setMaxRange(Number(e.target.value))} className="flex-1 accent-cyan-400" />
          <span className="font-mono text-cyan-300 w-14 text-right">{maxRange}nm</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 uppercase tracking-widest text-[9px] w-14">Proj</span>
          <input type="range" min={1} max={15} step={1} value={projMin} onChange={e => setProjMin(Number(e.target.value))} className="flex-1 accent-cyan-400" />
          <span className="font-mono text-cyan-300 w-14 text-right">{projMin}min</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 uppercase tracking-widest text-[9px] w-14">VS min</span>
          <input type="range" min={0} max={4000} step={100} value={vsMin} onChange={e => setVsMin(Number(e.target.value))} className="flex-1 accent-cyan-400" />
          <span className="font-mono text-cyan-300 w-14 text-right">{vsMin}fpm</span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {ALT_BANDS.map(b => (
            <button key={b.id} onClick={() => toggleBand(b.id)}
              className={`px-2 py-0.5 rounded-full font-mono text-[10px] border ${enabledBands.has(b.id) ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-transparent border-slate-800 text-slate-500'}`}>
              {b.label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
            <input type="checkbox" checked={showGround} onChange={e => setShowGround(e.target.checked)} className="accent-cyan-400" /> ground
          </label>
        </div>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder="filter callsign / icao / type"
          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs outline-none focus:border-slate-600"
        />
      </div>

      {brushed.length > 0 && (
        <div className="px-3 pb-3 border-t border-slate-800 pt-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Brushed · {brushed.length}</div>
            <button onClick={() => setBrushed([])} className="text-[10px] text-slate-500 hover:text-slate-200">clear</button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {brushed.slice(0, 60).map(f => (
              <button key={f.icao} onClick={() => onFly?.(f.icao)}
                className="w-full text-left px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center gap-2">
                <span className="size-2 rounded-full shrink-0" style={{ background: altColor(f.altitudeFt) }} />
                <span className="font-mono text-xs font-bold text-slate-100 w-20 truncate">{f.callsign || f.icao}</span>
                <span className="font-mono text-[10px] text-slate-400 w-14 truncate">{f.type || '—'}</span>
                <span className="font-mono text-[10px] text-slate-300 ml-auto">{f.rng.toFixed(0)}nm</span>
                <span className="font-mono text-[10px] text-slate-300 w-14 text-right">{Math.round(f.altitudeFt).toLocaleString()}ft</span>
                <span className={`font-mono text-[10px] w-12 text-right ${f.vertRate > 200 ? 'text-emerald-300' : f.vertRate < -200 ? 'text-rose-300' : 'text-slate-500'}`}>{f.vertRate > 0 ? '+' : ''}{Math.round(f.vertRate)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}
