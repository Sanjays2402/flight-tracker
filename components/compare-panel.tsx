'use client'
import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   Compare Panel
   -----------------------------------------------------------
   Side-by-side comparison of up to 4 selected aircraft.
   - Type-to-search across the full live fleet to add a contender
   - Click a slot to inspect / fly-to / drop
   - Spec cards stacked horizontally: callsign, type, operator,
     squawk, registration, country flag, FL, GS/IAS, Mach, VS,
     wind, OAT, category, emergency/military pills, distance
     from a configurable anchor (map center / first slot).
   - Radar/spider chart normalizing 6 axes (alt, speed, mach,
     |vsi|, wind component, range-from-anchor) across the
     compared set so the largest in each axis = full radius.
   - Bar grid for each axis with per-row stripe in the same
     hue as the spider polygon for that aircraft.
   ============================================================ */

export interface CmpFlight {
  icao: string
  callsign: string
  registration?: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ias?: number
  mach?: number
  vertRate?: number
  windDir?: number
  windKts?: number
  oat?: number
  track?: number
  squawk?: string
  category?: string
  emergency?: boolean
  military?: boolean
  ground: boolean
}

interface Props {
  flights: CmpFlight[]
  anchorLat: number
  anchorLng: number
  initialIcaos: string[]
  onClose: () => void
  onFly: (icao: string) => void
  onSelectionChange?: (icaos: string[]) => void
}

const MAX_SLOTS = 4
const SLOT_HUES = [200, 340, 140, 40] // cyan, rose, emerald, amber

function haversineNM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 3440.065
  const RAD = Math.PI / 180
  const dLat = (bLat - aLat) * RAD
  const dLng = (bLng - aLng) * RAD
  const la1 = aLat * RAD, la2 = bLat * RAD
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function fmtFL(altFt: number, ground: boolean) {
  if (ground) return 'GND'
  if (!Number.isFinite(altFt)) return '—'
  return 'FL' + String(Math.round(altFt / 100)).padStart(3, '0')
}

function headComponent(track: number, windDir: number, windKts: number) {
  // windDir is "from" (meteorological). Convert wind to a TO vector relative to track.
  // Headwind component = wind_speed * cos(windDir - track + 180) ; positive = headwind.
  const rel = ((windDir - track + 180) * Math.PI) / 180
  return windKts * Math.cos(rel)
}

export default function ComparePanel({ flights, anchorLat, anchorLng, initialIcaos, onClose, onFly, onSelectionChange }: Props) {
  const [slots, setSlots] = useState<string[]>(() => initialIcaos.slice(0, MAX_SLOTS))
  const [search, setSearch] = useState('')
  const [anchorMode, setAnchorMode] = useState<'center' | 'first'>('center')
  const [showSpider, setShowSpider] = useState(true)

  useEffect(() => { onSelectionChange?.(slots) }, [slots, onSelectionChange])

  const byIcao = useMemo(() => {
    const m = new Map<string, CmpFlight>()
    for (const f of flights) m.set(f.icao, f)
    return m
  }, [flights])

  const picked: Array<CmpFlight | null> = useMemo(() => {
    const out: Array<CmpFlight | null> = []
    for (let i = 0; i < MAX_SLOTS; i++) {
      const ic = slots[i]
      out.push(ic ? (byIcao.get(ic) ?? null) : null)
    }
    return out
  }, [slots, byIcao])

  // anchor (for range axis)
  const anchor = useMemo(() => {
    if (anchorMode === 'first') {
      const f = picked.find(p => p) as CmpFlight | undefined
      if (f) return { lat: f.lat, lng: f.lng }
    }
    return { lat: anchorLat, lng: anchorLng }
  }, [anchorMode, picked, anchorLat, anchorLng])

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return [] as CmpFlight[]
    return flights
      .filter(f => {
        const blob = `${f.callsign} ${f.icao} ${f.registration ?? ''} ${f.type ?? ''} ${f.operator ?? ''}`.toLowerCase()
        return blob.includes(q)
      })
      .filter(f => !slots.includes(f.icao))
      .slice(0, 12)
  }, [search, flights, slots])

  function addIcao(ic: string) {
    setSlots(prev => {
      const next = [...prev]
      const free = next.findIndex(x => !x)
      if (free === -1) next[next.length - 1] = ic
      else next[free] = ic
      return next
    })
    setSearch('')
  }
  function dropAt(i: number) {
    setSlots(prev => prev.filter((_, j) => j !== i))
  }

  // axes for spider chart
  const axes = useMemo(() => {
    const pickedF = picked.filter((p): p is CmpFlight => !!p)
    const altMax = Math.max(45000, ...pickedF.map(f => f.altitudeFt || 0))
    const gsMax = Math.max(500, ...pickedF.map(f => f.velocityKts || 0))
    const machMax = Math.max(0.9, ...pickedF.map(f => f.mach || 0))
    const vsMax = Math.max(2000, ...pickedF.map(f => Math.abs(f.vertRate || 0)))
    const windMax = Math.max(60, ...pickedF.map(f => f.windKts || 0))
    const rngMax = Math.max(50, ...pickedF.map(f => haversineNM(anchor.lat, anchor.lng, f.lat, f.lng)))
    return [
      { key: 'alt', label: 'ALT', max: altMax, unit: 'ft', get: (f: CmpFlight) => f.altitudeFt || 0 },
      { key: 'gs', label: 'GS', max: gsMax, unit: 'kt', get: (f: CmpFlight) => f.velocityKts || 0 },
      { key: 'mach', label: 'MACH', max: machMax, unit: '', get: (f: CmpFlight) => f.mach || 0 },
      { key: 'vs', label: '|VS|', max: vsMax, unit: 'fpm', get: (f: CmpFlight) => Math.abs(f.vertRate || 0) },
      { key: 'wind', label: 'WIND', max: windMax, unit: 'kt', get: (f: CmpFlight) => f.windKts || 0 },
      { key: 'rng', label: 'RNG', max: rngMax, unit: 'nm', get: (f: CmpFlight) => haversineNM(anchor.lat, anchor.lng, f.lat, f.lng) },
    ]
  }, [picked, anchor])

  // spider geometry
  const RAD = 95
  const CX = 130
  const CY = 130
  const N = axes.length
  function axisPoint(i: number, t: number) {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / N
    const r = RAD * Math.max(0, Math.min(1, t))
    return [CX + Math.cos(ang) * r, CY + Math.sin(ang) * r] as const
  }

  return (
    <div className="absolute top-4 right-4 z-[40] w-[360px] max-h-[88vh] flex flex-col bg-zinc-950/95 border border-zinc-800 rounded-xl shadow-2xl backdrop-blur text-zinc-100 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-cyan-400" />
          <span className="text-[11px] tracking-[0.2em] font-mono text-cyan-300">COMPARE</span>
          <span className="text-[10px] text-zinc-500">{slots.filter(Boolean).length}/{MAX_SLOTS}</span>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-white text-xs px-2 py-0.5 rounded hover:bg-zinc-800">CLOSE</button>
      </div>

      <div className="p-3 border-b border-zinc-800 space-y-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Add aircraft (callsign / icao / type / op)…"
          className="w-full px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-[12px] placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50"
        />
        {candidates.length > 0 && (
          <div className="max-h-[140px] overflow-auto rounded border border-zinc-800 divide-y divide-zinc-800/70">
            {candidates.map(c => (
              <button key={c.icao} onClick={() => addIcao(c.icao)} className="w-full text-left px-2 py-1 hover:bg-zinc-800/60 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] font-mono text-cyan-300 truncate">{c.callsign || c.icao}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{c.type || '—'} · {c.operator || '—'}</div>
                </div>
                <div className="text-[10px] font-mono text-zinc-400">{fmtFL(c.altitudeFt, c.ground)}</div>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-zinc-500">ANCHOR</span>
          <button onClick={() => setAnchorMode('center')} className={`px-2 py-0.5 rounded font-mono ${anchorMode === 'center' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'bg-zinc-900 text-zinc-400 border border-zinc-800'}`}>CENTER</button>
          <button onClick={() => setAnchorMode('first')} className={`px-2 py-0.5 rounded font-mono ${anchorMode === 'first' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'bg-zinc-900 text-zinc-400 border border-zinc-800'}`}>FIRST</button>
          <div className="flex-1" />
          <button onClick={() => setShowSpider(s => !s)} className={`px-2 py-0.5 rounded font-mono ${showSpider ? 'bg-zinc-800 text-zinc-200 border border-zinc-700' : 'bg-zinc-900 text-zinc-500 border border-zinc-800'}`}>SPIDER</button>
          <button onClick={() => setSlots([])} className="px-2 py-0.5 rounded font-mono bg-zinc-900 text-zinc-500 border border-zinc-800 hover:text-rose-300 hover:border-rose-700">CLR</button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* slot cards */}
        <div className="p-3 space-y-2">
          {picked.map((f, i) => {
            const hue = SLOT_HUES[i % SLOT_HUES.length]
            if (!f) {
              return (
                <div key={`empty-${i}`} className="px-3 py-2 border border-dashed border-zinc-800 rounded text-[11px] text-zinc-600 text-center">
                  slot {i + 1} — search above to add
                </div>
              )
            }
            const rng = haversineNM(anchor.lat, anchor.lng, f.lat, f.lng)
            const hw = (f.track != null && f.windDir != null && f.windKts != null) ? headComponent(f.track, f.windDir, f.windKts) : null
            return (
              <div key={f.icao} className="border rounded-md overflow-hidden" style={{ borderColor: `hsla(${hue}, 70%, 55%, 0.45)`, background: `hsla(${hue}, 60%, 20%, 0.18)` }}>
                <div className="flex items-center justify-between px-2 py-1.5 border-b" style={{ borderColor: `hsla(${hue}, 70%, 55%, 0.30)` }}>
                  <button onClick={() => onFly(f.icao)} className="flex items-center gap-2 min-w-0 text-left">
                    <span className="w-1.5 h-4 rounded" style={{ background: `hsl(${hue}, 75%, 55%)` }} />
                    <span className="font-mono text-[12px]" style={{ color: `hsl(${hue}, 80%, 70%)` }}>{f.callsign || f.icao}</span>
                    <span className="text-[10px] text-zinc-400 truncate">{f.type || '—'}</span>
                    {f.emergency && <span className="text-[9px] px-1 py-px rounded bg-rose-600/40 text-rose-200 font-mono">EMRG</span>}
                    {f.military && <span className="text-[9px] px-1 py-px rounded bg-amber-600/30 text-amber-200 font-mono">MIL</span>}
                  </button>
                  <button onClick={() => dropAt(i)} className="text-[10px] text-zinc-500 hover:text-rose-300 px-1">×</button>
                </div>
                <div className="grid grid-cols-3 gap-px bg-zinc-900/50 text-[10px] font-mono">
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">ALT</div><div className="text-zinc-100">{fmtFL(f.altitudeFt, f.ground)}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">GS</div><div className="text-zinc-100">{Math.round(f.velocityKts)}<span className="text-zinc-500"> kt</span></div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">MACH</div><div className="text-zinc-100">{f.mach ? f.mach.toFixed(2) : '—'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">VS</div><div className="text-zinc-100">{f.vertRate != null ? (f.vertRate > 0 ? '+' : '') + Math.round(f.vertRate) : '—'}<span className="text-zinc-500"> fpm</span></div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">TRK</div><div className="text-zinc-100">{f.track != null ? Math.round(f.track) + '°' : '—'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">SQK</div><div className="text-zinc-100">{f.squawk || '—'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">WIND</div><div className="text-zinc-100">{f.windKts ? `${Math.round(f.windDir ?? 0)}°/${Math.round(f.windKts)}` : '—'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">H/W</div><div className={hw == null ? 'text-zinc-500' : hw > 0 ? 'text-rose-300' : 'text-emerald-300'}>{hw == null ? '—' : (hw > 0 ? 'H' : 'T') + Math.round(Math.abs(hw)) + 'kt'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">OAT</div><div className="text-zinc-100">{f.oat != null ? Math.round(f.oat) + '°C' : '—'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50 col-span-2"><div className="text-zinc-500">OPERATOR</div><div className="text-zinc-100 truncate">{f.operator || '—'}</div></div>
                  <div className="px-2 py-1 bg-zinc-950/50"><div className="text-zinc-500">RNG</div><div className="text-zinc-100">{rng.toFixed(1)}<span className="text-zinc-500"> nm</span></div></div>
                </div>
              </div>
            )
          })}
        </div>

        {/* spider chart */}
        {showSpider && picked.some(p => p) && (
          <div className="p-3 border-t border-zinc-800">
            <div className="text-[10px] tracking-[0.2em] font-mono text-zinc-500 mb-1">SPIDER · normalized to max in set</div>
            <div className="flex justify-center">
              <svg width={260} height={260} viewBox="0 0 260 260">
                {[0.25, 0.5, 0.75, 1].map((t, ri) => {
                  const pts = Array.from({ length: N }, (_, i) => axisPoint(i, t).join(',')).join(' ')
                  return <polygon key={ri} points={pts} fill="none" stroke="rgba(120,130,140,0.18)" strokeWidth={1} strokeDasharray={ri === 3 ? '' : '2 3'} />
                })}
                {axes.map((ax, i) => {
                  const [x, y] = axisPoint(i, 1.0)
                  const [lx, ly] = axisPoint(i, 1.18)
                  return (
                    <g key={ax.key}>
                      <line x1={CX} y1={CY} x2={x} y2={y} stroke="rgba(120,130,140,0.18)" strokeWidth={1} />
                      <text x={lx} y={ly} fontSize={9} fill="rgba(200,210,220,0.7)" fontFamily="ui-monospace, SFMono-Regular, monospace" textAnchor="middle" dominantBaseline="middle">{ax.label}</text>
                    </g>
                  )
                })}
                {picked.map((f, si) => {
                  if (!f) return null
                  const hue = SLOT_HUES[si % SLOT_HUES.length]
                  const pts = axes.map((ax, i) => {
                    const t = ax.max > 0 ? ax.get(f) / ax.max : 0
                    return axisPoint(i, t).join(',')
                  }).join(' ')
                  return (
                    <g key={f.icao}>
                      <polygon points={pts} fill={`hsla(${hue}, 75%, 55%, 0.16)`} stroke={`hsl(${hue}, 80%, 60%)`} strokeWidth={1.5} />
                      {axes.map((ax, i) => {
                        const t = ax.max > 0 ? ax.get(f) / ax.max : 0
                        const [px, py] = axisPoint(i, t)
                        return <circle key={i} cx={px} cy={py} r={2.5} fill={`hsl(${hue}, 80%, 65%)`} />
                      })}
                    </g>
                  )
                })}
                <circle cx={CX} cy={CY} r={2} fill="rgba(200,210,220,0.6)" />
              </svg>
            </div>

            {/* per-axis bar grid */}
            <div className="mt-2 space-y-1">
              {axes.map(ax => (
                <div key={ax.key} className="flex items-center gap-2 text-[10px] font-mono">
                  <div className="w-10 text-zinc-500">{ax.label}</div>
                  <div className="flex-1 space-y-px">
                    {picked.map((f, si) => {
                      if (!f) return null
                      const hue = SLOT_HUES[si % SLOT_HUES.length]
                      const v = ax.get(f)
                      const t = ax.max > 0 ? v / ax.max : 0
                      return (
                        <div key={f.icao} className="relative h-3 bg-zinc-900 rounded overflow-hidden">
                          <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, t * 100)}%`, background: `hsla(${hue}, 75%, 55%, 0.55)` }} />
                          <div className="absolute inset-0 px-1 flex items-center justify-between">
                            <span className="text-zinc-300 truncate">{f.callsign || f.icao}</span>
                            <span className="text-zinc-200">{ax.key === 'mach' ? v.toFixed(2) : Math.round(v)}<span className="text-zinc-500">{ax.unit ? ' ' + ax.unit : ''}</span></span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
