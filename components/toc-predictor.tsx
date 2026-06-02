'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Top of Climb (TOC) Predictor
   -----------------------------------------------------------
   Companion to the existing Top of Descent (TOD) predictor.
   Where TOD watches every cruising/descending aircraft and
   projects where it must begin a 3 deg descent to land, this
   panel watches every CLIMBING aircraft and projects where it
   will level off at a sensible cruise FL given its instantaneous
   climb performance, then grades that climb against the
   class-expected gradient ladder.

   For every airborne aircraft with vertRate >= +400 fpm and
   altitudeFt < FL400 we compute:

   1) Target cruise FL via class+leg-distance ladder
        heavy / narrow / biz : FL370 base, +20 if night, capped FL410
        regional / turboprop : FL280 / FL230
        ga                   : FL120
        fighter              : FL380
        — user TARGET-FL slider overrides per pick when set
        — auto-round to next ODD/EVEN-east/west FL based on track
          (RVSM: tracks 000-179 take odd FLs, 180-359 take even)

   2) Climb gradient — three flavours:
        gradFtPerNm = vertRate / max(60, GS) * 60         (real)
        gradFtPerMin = vertRate                            (raw)
        gradPercent = vertRate / (GS * 101.27)             (slope %)
      Class-expected gradient ladder (sea-level / typical climb):
        heavy    1800 fpm  -> drops with alt to 800 at FL350
        narrow   2400 fpm  -> 1200 @ FL350
        regional 1800 fpm  -> 900  @ FL280
        biz      3000 fpm  -> 1500 @ FL410
        turboprop 1500 fpm -> 700  @ FL230
        ga       700 fpm   -> 300  @ FL100
        fighter  6000 fpm  -> 3000 @ FL400
      Expected fpm at current altitude = ladder lerp; ratio
      = actual / expected gives the climb performance grade.

   3) Time-to-cruise = max(0, (targetFt - altFt) / vertRate)
      Distance-to-TOC nm  = GS * timeMin / 60
      TOC waypoint = project(lat,lng, track, distNm)

   4) Step-climb readiness: scan +2k/+4k/+6k steps above
      current alt where ladder still yields >=300 fpm.

   Tier classification (climb performance vs expected):
      WEAK    ratio<0.55 rose  — sluggish climb, possibly heavy,
                              hot/high, or capped by ATC
      STD     ratio<0.85 amber — slightly below book
      NORMAL  ratio<1.20 sky   — on the schedule
      STRONG  ratio>=1.20 emerald — empty, light, or unrestricted

   MapLibre overlay:
     - Tier-coloured halo ring sized by climb intensity (8-22px)
     - Dashed projection line aircraft → TOC waypoint with
       diamond marker
     - Tier-coloured callsign + ratio% + ETA T+m labels
   Side panel: 4-tier counter strip, 3-cell summary, SVG
   gradient diagram, sliders, ranked list with class-pill,
   gradient bars, click-to-fly.

   Registered under Layers > Analysis category. ft-toc
   persisted preference.
   ============================================================ */

export interface TocFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: TocFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'WEAK' | 'STD' | 'NORMAL' | 'STRONG'
const TIER_COLOR: Record<Tier, string> = {
  WEAK: '#ef4444',
  STD: '#f97316',
  NORMAL: '#0ea5e9',
  STRONG: '#10b981',
}
const TIER_ORDER: Tier[] = ['WEAK', 'STD', 'NORMAL', 'STRONG']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

interface ClimbCurve {
  base: number     // fpm at sea level
  ceiling: number  // ft service ceiling
  ceilFpm: number  // fpm near ceiling
  targetFl: number // typical cruise FL
}
const CLIMB: Record<Klass, ClimbCurve> = {
  heavy:     { base: 1800, ceiling: 41000, ceilFpm:  800, targetFl: 370 },
  narrow:    { base: 2400, ceiling: 39000, ceilFpm: 1200, targetFl: 360 },
  regional:  { base: 1800, ceiling: 31000, ceilFpm:  900, targetFl: 280 },
  biz:       { base: 3000, ceiling: 45000, ceilFpm: 1500, targetFl: 410 },
  turboprop: { base: 1500, ceiling: 25000, ceilFpm:  700, targetFl: 230 },
  ga:        { base:  700, ceiling: 12000, ceilFpm:  300, targetFl: 100 },
  fighter:   { base: 6000, ceiling: 50000, ceilFpm: 3000, targetFl: 380 },
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(B19|B20|B30|B35|B40|B45|B55|B58|B95|B96|B99|EMB|E11|PA31|PA42|PC9|KODI)/.test(x)) return 'turboprop'
  return 'narrow'
}

function expectedFpm(klass: Klass, altFt: number): number {
  const c = CLIMB[klass]
  if (altFt >= c.ceiling) return Math.max(50, c.ceilFpm * 0.3)
  const frac = Math.max(0, Math.min(1, altFt / c.ceiling))
  // smooth lerp base -> ceilFpm
  return c.base + (c.ceilFpm - c.base) * frac
}

function targetCruiseFl(klass: Klass, track: number, override: number): number {
  if (override > 0) return override
  const baseFl = CLIMB[klass].targetFl
  // RVSM semi-circular: tracks 000-179 odd FLs, 180-359 even FLs
  const odd = (track >= 0 && track < 180)
  // round baseFl to nearest matching FL (in 10s, where parity = (Fl/10) mod 2)
  let fl = baseFl
  const parityNeeded = odd ? 1 : 0
  while (((fl / 10) % 2) !== parityNeeded) fl += 10
  return fl
}

function projectGc(lat: number, lng: number, brgDeg: number, distNm: number): { lat: number, lng: number } {
  const R = 3440.065
  const d = distNm / R
  const br = brgDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const sφ2 = Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(br)
  const φ2 = Math.asin(sφ2)
  const y = Math.sin(br) * Math.sin(d) * Math.cos(φ1)
  const x = Math.cos(d) - Math.sin(φ1) * sφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI + 540) % 360) - 180 }
}

interface Row {
  f: TocFlight
  klass: Klass
  altFt: number
  gs: number
  vs: number
  trk: number
  targetFt: number
  remainFt: number
  fpmExp: number
  ratio: number
  timeMin: number
  distNm: number
  tocLat: number
  tocLng: number
  gradFtPerNm: number
  gradPercent: number
  stepFlOk: number   // highest FL above current where exp fpm >= 300
  tier: Tier
}

const SRC_RING = 'toc-ring', SRC_PROJ = 'toc-proj', SRC_DOT = 'toc-dot', SRC_LBL = 'toc-lbl'
const LYR_RING = 'toc-ring-l', LYR_PROJ = 'toc-proj-l', LYR_DOT = 'toc-dot-l', LYR_LBL = 'toc-lbl-l'

export default function TocPredictor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minVs, setMinVs] = useState(400)
  const [maxFl, setMaxFl] = useState(400)
  const [overrideFl, setOverrideFl] = useState(0) // 0 = AUTO
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.vertRate)) continue
      if (f.vertRate < minVs) continue
      if (f.altitudeFt > maxFl * 100) continue
      const klass = classify(f.type, f.category)
      const gs = Math.max(0, f.velocityKts || 0)
      const trk = f.track || 0
      const targetFt = targetCruiseFl(klass, trk, overrideFl) * 100
      const remainFt = Math.max(0, targetFt - f.altitudeFt)
      const fpmExp = expectedFpm(klass, f.altitudeFt)
      const ratio = fpmExp > 0 ? f.vertRate / fpmExp : 1
      const timeMin = f.vertRate > 0 ? remainFt / f.vertRate : 0
      const distNm = Math.max(0, (gs * timeMin) / 60)
      const toc = projectGc(f.lat, f.lng, trk, distNm)
      const gradFtPerNm = gs > 60 ? f.vertRate / gs * 60 : 0
      const gradPercent = gs > 60 ? (f.vertRate / (gs * 101.27)) * 100 : 0
      // step climb scan: highest +Δ where expected fpm still >=300
      let stepFlOk = Math.round(f.altitudeFt / 100)
      for (const dFL of [20, 40, 60]) {
        const candFt = f.altitudeFt + dFL * 100
        if (expectedFpm(klass, candFt) >= 300 && candFt < CLIMB[klass].ceiling) stepFlOk = Math.round(candFt / 100)
      }
      let tier: Tier
      if (ratio < 0.55) tier = 'WEAK'
      else if (ratio < 0.85) tier = 'STD'
      else if (ratio < 1.20) tier = 'NORMAL'
      else tier = 'STRONG'
      out.push({
        f, klass, altFt: f.altitudeFt, gs, vs: f.vertRate, trk,
        targetFt, remainFt, fpmExp, ratio, timeMin, distNm,
        tocLat: toc.lat, tocLng: toc.lng, gradFtPerNm, gradPercent, stepFlOk, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.timeMin - b.timeMin
    })
    return out
  }, [flights, minVs, maxFl, overrideFl])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { WEAK: 0, STD: 0, NORMAL: 0, STRONG: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanRatio = 0, meanVs = 0, soonest = Infinity, soonestCs = ''
    for (const r of rows) {
      meanRatio += r.ratio
      meanVs += r.vs
      if (r.timeMin > 0 && r.timeMin < soonest) { soonest = r.timeMin; soonestCs = (r.f.callsign || r.f.icao).trim() }
    }
    if (total > 0) { meanRatio /= total; meanVs /= total }
    return { total, meanRatio, meanVs, soonest, soonestCs }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  // Map overlay
  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, Math.abs(r.ratio - 1) * 14) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.distNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.tocLng, r.tocLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.distNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.tocLng, r.tocLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${(r.ratio * 100).toFixed(0)}% T+${r.timeMin.toFixed(0)}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PROJ, projFc, () => map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.6,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_DOT, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_DOT, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showProj, showLabels])

  // SVG diagram: x = altitude FL, y = fpm, plot expected-curves per class + aircraft dots
  const diag = useMemo(() => {
    const W = 360, H = 150, PAD = 24
    const xMax = 450 // FL
    const yMax = 4000 // fpm
    const xs = (fl: number) => PAD + (fl / xMax) * (W - PAD - 6)
    const ys = (fpm: number) => H - PAD - (Math.min(yMax, fpm) / yMax) * (H - PAD - 8)
    const classes: Klass[] = ['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter']
    const classColor: Record<Klass, string> = { heavy: '#8b5cf6', narrow: '#0ea5e9', regional: '#22d3ee', biz: '#a855f7', turboprop: '#84cc16', ga: '#94a3b8', fighter: '#f59e0b' }
    return { W, H, PAD, xs, ys, classes, classColor }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Top of Climb</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} climbing</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[10px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Ratio</div>
          <div className="font-mono text-sm" style={{ color: summary.meanRatio < 0.85 ? '#f97316' : summary.meanRatio > 1.20 ? '#10b981' : '#0ea5e9' }}>
            {(summary.meanRatio * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean VS</div>
          <div className="font-mono text-sm text-slate-200">{summary.meanVs.toFixed(0)}<span className="text-[9px] text-slate-500"> fpm</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Next TOC</div>
          <div className="font-mono text-[11px] text-slate-200 truncate">{isFinite(summary.soonest) ? `${summary.soonestCs} ${summary.soonest.toFixed(0)}m` : '—'}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Climb gradient ladder · fpm vs FL</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            {/* axes */}
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y grid: 1k/2k/3k fpm */}
            {[1000, 2000, 3000].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v / 1000}k</text>
              </g>
            ))}
            {/* x grid */}
            {[100, 200, 300, 400].map(fl => (
              <g key={fl}>
                <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* class curves */}
            {diag.classes.map(k => {
              const dim = klassFilter !== 'ALL' && klassFilter !== k
              const pts: string[] = []
              for (let fl = 0; fl <= xMaxFl(); fl += 20) {
                const fpm = expectedFpm(k, fl * 100)
                pts.push(`${diag.xs(fl)},${diag.ys(fpm)}`)
              }
              return <polyline key={k} points={pts.join(' ')} fill="none" stroke={diag.classColor[k]} strokeWidth={1.2} opacity={dim ? 0.18 : 0.85} />
            })}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.altFt / 100)} cy={diag.ys(r.vs)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-VS</span><span className="font-mono text-slate-300">{minVs}fpm</span></div>
            <input type="range" min={100} max={3000} step={100} value={minVs} onChange={e => setMinVs(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={100} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TARGET</span><span className="font-mono text-slate-300">{overrideFl === 0 ? 'AUTO' : 'F' + overrideFl}</span></div>
            <input type="range" min={0} max={450} step={10} value={overrideFl} onChange={e => setOverrideFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRing} onChange={e => setShowRing(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showProj} onChange={e => setShowProj(e.target.checked)} className="accent-sky-500" /><span>PROJ</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} climbing</span>
        <span>ratio · ETA · TOC</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const ratioPct = Math.max(0, Math.min(200, r.ratio * 100))
          const tFl = Math.round(r.targetFt / 100)
          const curFl = Math.round(r.altFt / 100)
          return (
            <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold truncate">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="current → target FL">F{curFl}→F{tFl}</span>
                  <span title="vertical speed">{r.vs >= 0 ? '↑' : '↓'}{Math.abs(r.vs).toFixed(0)}fpm</span>
                  <span title="ground speed">{r.gs.toFixed(0)}kt</span>
                  <span className="ml-auto">{r.timeMin.toFixed(1)}m</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, ratioPct / 2)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '27.5%' }} title="WEAK / STD" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: '42.5%' }} title="STD / NORMAL" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: '60%' }} title="NORMAL / STRONG" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="expected fpm at current alt">exp {r.fpmExp.toFixed(0)}fpm</span>
                  <span title="climb gradient ft/nm">{r.gradFtPerNm.toFixed(0)}ft/nm</span>
                  <span title="climb percent">{r.gradPercent.toFixed(1)}%</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{(r.ratio * 100).toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="distance to TOC">TOC {r.distNm.toFixed(0)}nm</span>
                  <span title="highest reachable step FL with >=300fpm">step F{r.stepFlOk}</span>
                  <span className="ml-auto truncate">{r.f.operator || '\u2014'}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function xMaxFl(): number { return 450 }
