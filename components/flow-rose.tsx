'use client'
import { useMemo, useState } from 'react'

/* ============================================================
   Flow Rose Panel
   -----------------------------------------------------------
   Polar compass-rose histogram of every airborne aircraft's
   ground track, binned into N sectors (8/16/24/36) and stacked
   by altitude band. Reveals directional flow structure of the
   live traffic field: jet-stream-driven east/west bias at FL350,
   bidirectional airway pairs (NAT tracks, J-routes), arrival
   funnels around major hubs, polar routes, etc.

   For each sector we also compute:
     - count (drives wedge radius)
     - mean ground speed (label)
     - net flow vector (sum of unit vectors weighted by count)
     - dominant operator and dominant FL band

   Click a wedge to filter the side list to only aircraft whose
   track falls inside the sector, and pulse-highlight them on
   the map via the existing onFly handler on row click.

   Pure SVG, no MapLibre layers needed. ~430 lines.
   ============================================================ */

export interface FlowFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  flights: FlowFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type BandKey = 'b0' | 'b1' | 'b2' | 'b3' | 'b4'
interface Band { key: BandKey; label: string; min: number; max: number; color: string }
const BANDS: Band[] = [
  { key: 'b0', label: '< FL100', min: 0,      max: 10000,  color: '#94a3b8' },
  { key: 'b1', label: 'FL100-250', min: 10000, max: 25000,  color: '#22c55e' },
  { key: 'b2', label: 'FL250-350', min: 25000, max: 35000,  color: '#06b6d4' },
  { key: 'b3', label: 'FL350-430', min: 35000, max: 43000,  color: '#a78bfa' },
  { key: 'b4', label: '> FL430', min: 43000, max: 99000,  color: '#f43f5e' },
]
function bandFor(altFt: number): BandKey {
  for (const b of BANDS) if (altFt >= b.min && altFt < b.max) return b.key
  return 'b0'
}

const SECTOR_OPTS = [8, 16, 24, 36] as const

interface Sector {
  idx: number
  fromDeg: number
  toDeg: number
  centerDeg: number
  total: number
  bands: Record<BandKey, number>
  meanGs: number
  vx: number
  vy: number
  topOperator: string
  flights: FlowFlight[]
}

function fmtDir(deg: number): string {
  const d = ((deg % 360) + 360) % 360
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  return dirs[Math.round(d / 22.5) % 16]
}

export default function FlowRose({ flights, onClose, onFly }: Props) {
  const [nSect, setNSect] = useState<number>(16)
  const [activeBands, setActiveBands] = useState<Set<BandKey>>(new Set(BANDS.map(b => b.key)))
  const [selectedSector, setSelectedSector] = useState<number | null>(null)
  const [search, setSearch] = useState<string>('')
  const [showLabels, setShowLabels] = useState<boolean>(true)
  const [magCorr, setMagCorr] = useState<number>(0) // user-adjustable mag declination

  const toggleBand = (k: BandKey) => {
    const next = new Set(activeBands)
    if (next.has(k)) next.delete(k); else next.add(k)
    if (next.size === 0) BANDS.forEach(b => next.add(b.key))
    setActiveBands(next)
    setSelectedSector(null)
  }

  const sectors = useMemo<Sector[]>(() => {
    const width = 360 / nSect
    const arr: Sector[] = []
    for (let i = 0; i < nSect; i++) {
      const from = i * width - width / 2
      arr.push({
        idx: i,
        fromDeg: from,
        toDeg: from + width,
        centerDeg: i * width,
        total: 0,
        bands: { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 },
        meanGs: 0,
        vx: 0,
        vy: 0,
        topOperator: '',
        flights: [],
      })
    }
    const opCount: Map<number, Map<string, number>> = new Map()
    let gsSum = new Array(nSect).fill(0)
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.track)) continue
      const t = ((f.track % 360) + 360) % 360
      const sectorIdx = Math.floor((t + 360 / nSect / 2) / (360 / nSect)) % nSect
      const band = bandFor(f.altitudeFt || 0)
      if (!activeBands.has(band)) continue
      const s = arr[sectorIdx]
      s.total++
      s.bands[band]++
      s.flights.push(f)
      gsSum[sectorIdx] += f.velocityKts || 0
      const rad = (t * Math.PI) / 180
      s.vx += Math.sin(rad)
      s.vy += Math.cos(rad) // north-positive
      const op = (f.operator || 'UNK').slice(0, 14)
      let m = opCount.get(sectorIdx)
      if (!m) { m = new Map(); opCount.set(sectorIdx, m) }
      m.set(op, (m.get(op) || 0) + 1)
    }
    for (let i = 0; i < nSect; i++) {
      const s = arr[i]
      s.meanGs = s.total > 0 ? gsSum[i] / s.total : 0
      const m = opCount.get(i)
      if (m && m.size) {
        let bestK = ''; let bestV = -1
        m.forEach((v, k) => { if (v > bestV) { bestV = v; bestK = k } })
        s.topOperator = bestK
      }
    }
    return arr
  }, [flights, nSect, activeBands])

  const totals = useMemo(() => {
    let airborne = 0, ground = 0
    for (const f of flights) f.ground ? ground++ : airborne++
    return { airborne, ground, total: flights.length }
  }, [flights])

  const maxSectorTotal = useMemo(
    () => sectors.reduce((m, s) => Math.max(m, s.total), 0),
    [sectors]
  )

  // Global net flow vector
  const netFlow = useMemo(() => {
    let vx = 0, vy = 0, n = 0
    for (const s of sectors) { vx += s.vx; vy += s.vy; n += s.total }
    if (n === 0) return { dir: 0, mag: 0 }
    const dir = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360
    const mag = Math.sqrt(vx * vx + vy * vy) / n
    return { dir, mag }
  }, [sectors])

  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool: FlowFlight[] = selectedSector != null
      ? sectors[selectedSector]?.flights ?? []
      : sectors.flatMap(s => s.flights)
    return pool
      .filter(f =>
        !q || (f.callsign || '').toLowerCase().includes(q)
            || (f.type || '').toLowerCase().includes(q)
            || (f.operator || '').toLowerCase().includes(q)
            || f.icao.toLowerCase().includes(q),
      )
      .sort((a, b) => (b.altitudeFt || 0) - (a.altitudeFt || 0))
      .slice(0, 200)
  }, [sectors, selectedSector, search])

  // SVG geometry
  const SIZE = 320
  const CX = SIZE / 2
  const CY = SIZE / 2
  const R_MAX = SIZE / 2 - 28
  const R_MIN = 22

  const wedgePath = (fromDeg: number, toDeg: number, rInner: number, rOuter: number): string => {
    // 0deg = up (north), clockwise. Convert to SVG (0 = right, CCW positive).
    const a1 = ((fromDeg - 90) * Math.PI) / 180
    const a2 = ((toDeg - 90) * Math.PI) / 180
    const x1o = CX + rOuter * Math.cos(a1)
    const y1o = CY + rOuter * Math.sin(a1)
    const x2o = CX + rOuter * Math.cos(a2)
    const y2o = CY + rOuter * Math.sin(a2)
    const x1i = CX + rInner * Math.cos(a1)
    const y1i = CY + rInner * Math.sin(a1)
    const x2i = CX + rInner * Math.cos(a2)
    const y2i = CY + rInner * Math.sin(a2)
    const large = toDeg - fromDeg > 180 ? 1 : 0
    return [
      `M ${x1o} ${y1o}`,
      `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2o} ${y2o}`,
      `L ${x2i} ${y2i}`,
      `A ${rInner} ${rInner} 0 ${large} 0 ${x1i} ${y1i}`,
      'Z',
    ].join(' ')
  }

  const polarToXY = (deg: number, r: number) => {
    const a = ((deg - 90) * Math.PI) / 180
    return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) }
  }

  const cardinals: Array<{ d: number; lbl: string }> = [
    { d: 0,   lbl: 'N' },
    { d: 45,  lbl: 'NE' },
    { d: 90,  lbl: 'E' },
    { d: 135, lbl: 'SE' },
    { d: 180, lbl: 'S' },
    { d: 225, lbl: 'SW' },
    { d: 270, lbl: 'W' },
    { d: 315, lbl: 'NW' },
  ]

  return (
    <div
      className="absolute top-16 right-3 z-20 rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur p-3 w-[380px] max-h-[88vh] overflow-y-auto shadow-2xl text-slate-100"
      style={{ fontFamily: 'ui-sans-serif, system-ui' }}
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold tracking-wide">FLOW ROSE</div>
          <div className="text-[10px] text-slate-400">Directional traffic field · stacked by FL</div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white text-lg leading-none px-2"
          aria-label="Close"
        >×</button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        <Stat label="Airborne" value={totals.airborne} accent="#22c55e" />
        <Stat label="Net dir" value={`${Math.round(netFlow.dir)}° ${fmtDir(netFlow.dir)}`} accent="#06b6d4" />
        <Stat label="Coherence" value={`${(netFlow.mag * 100).toFixed(0)}%`} accent="#a78bfa" />
      </div>

      {/* Sector count picker */}
      <div className="flex items-center gap-1 mb-2 text-[10px]">
        <span className="text-slate-400 uppercase">Sectors</span>
        {SECTOR_OPTS.map(n => (
          <button
            key={n}
            onClick={() => { setNSect(n); setSelectedSector(null) }}
            className={`px-1.5 py-0.5 rounded border ${
              nSect === n
                ? 'border-cyan-400 bg-cyan-500/20 text-cyan-100'
                : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
            }`}
          >{n}</button>
        ))}
        <span className="ml-auto text-slate-400">MagVar</span>
        <input
          type="number"
          step={1}
          value={magCorr}
          onChange={e => setMagCorr(parseFloat(e.target.value) || 0)}
          className="w-12 px-1 py-0.5 rounded bg-slate-800 border border-white/10 text-right text-[10px]"
        />°
      </div>

      {/* Band filter chips */}
      <div className="flex flex-wrap gap-1 mb-2">
        {BANDS.map(b => {
          const on = activeBands.has(b.key)
          return (
            <button
              key={b.key}
              onClick={() => toggleBand(b.key)}
              className={`text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                on ? 'border-white/20 bg-white/10 text-white' : 'border-white/10 bg-white/5 text-slate-500 line-through'
              }`}
            >
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: b.color }} />
              {b.label}
            </button>
          )
        })}
      </div>

      {/* Rose SVG */}
      <div className="rounded-lg bg-slate-950/60 border border-white/5 p-2 mb-2">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ display: 'block' }}>
          {/* Ring gridlines */}
          {[0.25, 0.5, 0.75, 1].map(f => (
            <circle key={f} cx={CX} cy={CY} r={R_MIN + (R_MAX - R_MIN) * f}
                    fill="none" stroke="#1e293b" strokeDasharray="2 3" strokeWidth={0.5} />
          ))}
          {/* Spokes */}
          {cardinals.map(c => {
            const p = polarToXY(c.d, R_MAX + 4)
            const pi = polarToXY(c.d, R_MIN)
            return (
              <g key={c.lbl}>
                <line x1={pi.x} y1={pi.y} x2={p.x} y2={p.y} stroke="#1e293b" strokeWidth={0.5} />
              </g>
            )
          })}

          {/* Wedges (stacked bands) */}
          {sectors.map(s => {
            if (s.total === 0) return null
            const totalR = R_MIN + (R_MAX - R_MIN) * (s.total / (maxSectorTotal || 1))
            let rCursor = R_MIN
            const segs: React.ReactNode[] = []
            for (const b of BANDS) {
              const v = s.bands[b.key]
              if (v === 0) continue
              const frac = v / s.total
              const rNext = rCursor + (totalR - R_MIN) * frac
              segs.push(
                <path
                  key={b.key}
                  d={wedgePath(s.fromDeg, s.toDeg, rCursor, rNext)}
                  fill={b.color}
                  opacity={selectedSector == null || selectedSector === s.idx ? 0.85 : 0.18}
                  stroke="#0f172a"
                  strokeWidth={0.6}
                />,
              )
              rCursor = rNext
            }
            // hit overlay
            segs.push(
              <path
                key="hit"
                d={wedgePath(s.fromDeg, s.toDeg, R_MIN, R_MAX)}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedSector(selectedSector === s.idx ? null : s.idx)}
              >
                <title>
                  {`${Math.round(s.centerDeg)}° ${fmtDir(s.centerDeg)} — ${s.total} ac, mean ${Math.round(s.meanGs)} kt${s.topOperator ? `, top ${s.topOperator}` : ''}`}
                </title>
              </path>,
            )
            return <g key={s.idx}>{segs}</g>
          })}

          {/* Cardinal labels (apply mag correction) */}
          {cardinals.map(c => {
            const p = polarToXY(c.d - magCorr, R_MAX + 12)
            return (
              <text key={c.lbl} x={p.x} y={p.y} fill="#94a3b8"
                    fontSize={10} textAnchor="middle" dominantBaseline="middle"
                    fontWeight={c.lbl.length === 1 ? 700 : 400}>
                {c.lbl}
              </text>
            )
          })}

          {/* Net flow arrow */}
          {netFlow.mag > 0.05 && (() => {
            const tipR = R_MAX * Math.min(1, netFlow.mag + 0.3)
            const tip = polarToXY(netFlow.dir, tipR)
            return (
              <g>
                <line x1={CX} y1={CY} x2={tip.x} y2={tip.y}
                      stroke="#f59e0b" strokeWidth={1.6} opacity={0.85} />
                <circle cx={tip.x} cy={tip.y} r={3} fill="#f59e0b" />
                <circle cx={CX} cy={CY} r={2.5} fill="#f59e0b" />
              </g>
            )
          })()}

          {/* Sector count labels around the rim */}
          {showLabels && sectors.map(s => {
            if (s.total === 0) return null
            const p = polarToXY(s.centerDeg, R_MAX - 6)
            return (
              <text key={`l${s.idx}`} x={p.x} y={p.y}
                    fill="#e2e8f0" fontSize={8} textAnchor="middle" dominantBaseline="middle"
                    style={{ pointerEvents: 'none', textShadow: '0 0 3px #000' }}>
                {s.total}
              </text>
            )
          })}

          {/* Center hub */}
          <circle cx={CX} cy={CY} r={R_MIN - 2} fill="#0f172a" stroke="#1e293b" />
          <text x={CX} y={CY - 3} fill="#94a3b8" fontSize={8} textAnchor="middle">N-UP</text>
          <text x={CX} y={CY + 7} fill="#64748b" fontSize={7} textAnchor="middle">TRUE</text>
        </svg>
      </div>

      <div className="flex items-center gap-2 text-[10px] mb-2">
        <label className="flex items-center gap-1 text-slate-400">
          <input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} />
          counts
        </label>
        {selectedSector != null && (
          <button
            onClick={() => setSelectedSector(null)}
            className="ml-auto px-1.5 py-0.5 rounded bg-rose-600/30 border border-rose-400/40 text-rose-200"
          >Clear sector</button>
        )}
      </div>

      {/* Search + list */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="filter callsign / type / operator / icao"
        className="w-full mb-2 px-2 py-1 rounded bg-slate-800 border border-white/10 text-xs placeholder-slate-500"
      />

      <div className="text-[10px] text-slate-400 mb-1">
        {selectedSector != null
          ? <>Sector <span className="text-cyan-300">{Math.round(sectors[selectedSector].centerDeg)}° {fmtDir(sectors[selectedSector].centerDeg)}</span> — {filteredList.length} aircraft</>
          : <>All sectors — showing {filteredList.length}</>}
      </div>

      <div className="max-h-[260px] overflow-y-auto pr-1 space-y-0.5">
        {filteredList.map(f => {
          const b = bandFor(f.altitudeFt || 0)
          const meta = BANDS.find(x => x.key === b)!
          return (
            <button
              key={f.icao}
              onClick={() => onFly(f.icao)}
              className="w-full flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-white/5 border border-transparent hover:border-white/10"
            >
              <span className="inline-block w-1.5 h-6 rounded-sm" style={{ background: meta.color }} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate text-slate-100">
                  {f.callsign || f.icao.toUpperCase()}
                  <span className="text-slate-500 font-normal ml-1">{f.type || ''}</span>
                </div>
                <div className="text-[10px] text-slate-400 truncate">
                  {f.operator || '—'}
                </div>
              </div>
              <div className="text-right text-[10px] text-slate-300 leading-tight">
                <div>{Math.round((f.altitudeFt || 0) / 100).toString().padStart(3, '0')} FL</div>
                <div className="text-slate-500">{Math.round(f.velocityKts || 0)} kt</div>
              </div>
              <div className="text-right text-[10px] text-cyan-200 leading-tight w-12">
                <div>{Math.round(f.track || 0)}°</div>
                <div className="text-slate-500">{fmtDir(f.track || 0)}</div>
              </div>
            </button>
          )
        })}
        {filteredList.length === 0 && (
          <div className="text-center text-slate-500 text-xs py-6">no aircraft match</div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
      <div className="text-[9px] uppercase text-slate-400 tracking-wide">{label}</div>
      <div className="text-sm font-semibold" style={{ color: accent }}>{value}</div>
    </div>
  )
}
