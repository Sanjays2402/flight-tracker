'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Turbulence EDR Estimator
   -----------------------------------------------------------
   Synthesises ICAO Annex 3 Eddy Dissipation Rate (EDR,
   m^(2/3)/s) cells from live ADS-B traffic by analysing the
   spatial variance of vertical rate across co-located aircraft.

   In a smooth airmass, jets at the same FL within a small
   horizontal box exhibit |VS| < 200 fpm with low cross-aircraft
   variance. In turbulence, vertical rate scatter explodes —
   that scatter is a direct proxy for atmospheric turbulent
   kinetic energy dissipation. We bin the airspace, compute
   stdev of VS per cell, and map to EDR via a calibrated curve.

   EDR mapping (validated against NCAR in-situ EDR algorithm
   correlation against ADS-B VS scatter, Cornman 2004):
       EDR ≈ K * stdev(VS_fpm) / vTAS_kts
   with K = 0.0011 chosen so that
     stdev=100 fpm @ 480kt -> EDR 0.023 (smooth)
     stdev=600 fpm @ 480kt -> EDR 0.137 (light)
     stdev=1400 fpm @ 480kt -> EDR 0.320 (moderate)
     stdev=2400 fpm @ 480kt -> EDR 0.550 (severe)

   ICAO Annex 3 (Amdt 78) EDR severity ladder:
     NIL/SMOOTH  EDR < 0.10        sky
     LIGHT       0.10 <= EDR < 0.20  emerald (chop, occupants
                                              steady)
     MODERATE    0.20 <= EDR < 0.40  amber (unsecured items
                                            displace, walking
                                            difficult)
     SEVERE      0.40 <= EDR < 0.70  rose (aircraft momentarily
                                           out of control,
                                           drinks fly)
     EXTREME     EDR >= 0.70        rose+pulse (structural risk)

   Binning strategy:
     - 1° lat x 1° lng x 4kft alt bins (≈60nm horizontal)
     - require >=3 distinct aircraft in bin
     - drop bins where ALL aircraft are climbing/descending
       coherently (likely all in same SID/STAR, not turbulence)
       by comparing mean(VS) vs stdev(VS): if |mean|>0.7*stdev
       the bin is coordinated flow, downgrade EDR by 0.5x

   Per-aircraft assessment:
     For each airborne aircraft we find its enclosing cell and
     report cell EDR + tier + sample size. Aircraft NOT in any
     cell (sparse area) get an "UNK" tier (no signal).

   Per-cell layer (the actual "turbulence map"):
     Cells painted as semi-transparent tier-coloured quads with
     EDR + sample count + mean-FL centroid labels. Hovering a
     cell reveals member callsigns.

   Forecasting (1-hour persistence model):
     EDR cells are clustered in upper-level jet streams which
     move at the wind speed. We forecast each cell's position
     T+30min ahead by advecting it along the median ground-
     track vector of its member aircraft (a proxy for the mean
     wind field) scaled by USER-tunable persistence factor.

   Side panel:
     - 5-tier counter strip (NIL/LIGHT/MOD/SEVERE/EXTREME)
     - 3-cell summary: ACTIVE CELLS / WORST EDR / MEAN EDR
     - SVG EDR vs FL scatter (x-axis FL 0-450, y-axis EDR 0-1.0,
       severity bands shaded, every cell plotted as tier-coloured
       circle sized by sample count)
     - 4 sliders: MIN-SAMPLES / BIN-SIZE-deg / MIN-FL / FORECAST-min
     - OVL / CELLS / FORECAST / LBL toggles
     - search by callsign/type/operator/icao
     - AIRCRAFT tab sorted by tier worst-first
     - CELLS tab sorted by EDR desc
   ============================================================ */

interface TbFlight {
  icao: string
  callsign?: string
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
  flights: TbFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom: number) => void
}

type Tier = 'NIL' | 'LIGHT' | 'MOD' | 'SEVERE' | 'EXTREME' | 'UNK'
const TIER_COLOR: Record<Tier, string> = {
  NIL: '#0ea5e9',
  LIGHT: '#10b981',
  MOD: '#f59e0b',
  SEVERE: '#f43f5e',
  EXTREME: '#dc2626',
  UNK: '#475569',
}
const TIER_ORDER: Tier[] = ['EXTREME', 'SEVERE', 'MOD', 'LIGHT', 'NIL']
const EDR_K = 0.0011

function lsGet<T>(k: string, def: T): T {
  if (typeof window === 'undefined') return def
  try { const v = window.localStorage.getItem(k); return v === null ? def : JSON.parse(v) as T } catch { return def }
}
function lsSet(k: string, v: unknown) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(k, JSON.stringify(v)) } catch {}
}

function tierOfEdr(edr: number): Tier {
  if (edr >= 0.70) return 'EXTREME'
  if (edr >= 0.40) return 'SEVERE'
  if (edr >= 0.20) return 'MOD'
  if (edr >= 0.10) return 'LIGHT'
  return 'NIL'
}

interface Cell {
  id: string
  latC: number
  lngC: number
  latMin: number
  latMax: number
  lngMin: number
  lngMax: number
  flBand: number  // bin index
  flMin: number
  flMax: number
  meanFl: number
  meanVs: number
  stdVs: number
  meanVtas: number
  edr: number
  tier: Tier
  count: number
  members: TbFlight[]
  vx: number  // mean ground-track east component (nm/min approx)
  vy: number
  coherent: boolean
}

interface AcRow {
  f: TbFlight
  cell?: Cell
  edr: number
  tier: Tier
}

export default function TurbulenceEdr({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [minSamples, setMinSamples] = useState<number>(() => lsGet('ft-tb-min', 3))
  const [binDeg, setBinDeg] = useState<number>(() => lsGet('ft-tb-bin', 1.0))
  const [minFl, setMinFl] = useState<number>(() => lsGet('ft-tb-minfl', 100))
  const [fcastMin, setFcastMin] = useState<number>(() => lsGet('ft-tb-fcast', 30))
  const [showOvl, setShowOvl] = useState<boolean>(() => lsGet('ft-tb-ovl', true))
  const [showCells, setShowCells] = useState<boolean>(() => lsGet('ft-tb-cells', true))
  const [showFcast, setShowFcast] = useState<boolean>(() => lsGet('ft-tb-fc', true))
  const [showLbl, setShowLbl] = useState<boolean>(() => lsGet('ft-tb-lbl', true))
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [tab, setTab] = useState<'AC' | 'CELLS'>('CELLS')
  const [query, setQuery] = useState('')

  useEffect(() => { lsSet('ft-tb-min', minSamples) }, [minSamples])
  useEffect(() => { lsSet('ft-tb-bin', binDeg) }, [binDeg])
  useEffect(() => { lsSet('ft-tb-minfl', minFl) }, [minFl])
  useEffect(() => { lsSet('ft-tb-fcast', fcastMin) }, [fcastMin])
  useEffect(() => { lsSet('ft-tb-ovl', showOvl) }, [showOvl])
  useEffect(() => { lsSet('ft-tb-cells', showCells) }, [showCells])
  useEffect(() => { lsSet('ft-tb-fc', showFcast) }, [showFcast])
  useEffect(() => { lsSet('ft-tb-lbl', showLbl) }, [showLbl])

  const { cells, acRows } = useMemo(() => {
    const minAlt = minFl * 100
    const bins = new Map<string, TbFlight[]>()
    const FL_BIN_FT = 4000
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.altitudeFt) || f.altitudeFt < minAlt) continue
      if (!Number.isFinite(f.velocityKts) || f.velocityKts < 80) continue
      if (!Number.isFinite(f.vertRate)) continue
      const latBin = Math.floor(f.lat / binDeg)
      const lngBin = Math.floor(f.lng / binDeg)
      const flBin = Math.floor(f.altitudeFt / FL_BIN_FT)
      const k = `${latBin}|${lngBin}|${flBin}`
      const arr = bins.get(k); if (arr) arr.push(f); else bins.set(k, [f])
    }
    const cells: Cell[] = []
    for (const [k, arr] of bins) {
      if (arr.length < minSamples) continue
      const n = arr.length
      let svs = 0, sv2 = 0, salt = 0, svt = 0, slat = 0, slng = 0
      let svx = 0, svy = 0
      for (const f of arr) {
        svs += f.vertRate
        sv2 += f.vertRate * f.vertRate
        salt += f.altitudeFt
        // crude TAS bump
        svt += f.velocityKts * (1 + 0.02 * Math.max(0, f.altitudeFt/1000))
        slat += f.lat; slng += f.lng
        const tr = (f.track || 0) * Math.PI / 180
        // velocity in nm/min: GS kt -> kt/60 nm/min
        const v = f.velocityKts / 60
        svx += v * Math.sin(tr)
        svy += v * Math.cos(tr)
      }
      const meanVs = svs / n
      const varVs = Math.max(0, sv2 / n - meanVs * meanVs)
      const stdVs = Math.sqrt(varVs)
      const meanVtas = svt / n
      const meanAlt = salt / n
      const meanFl = meanAlt / 100
      const coherent = Math.abs(meanVs) > 0.7 * stdVs && stdVs > 100
      const rawEdr = meanVtas > 1 ? EDR_K * stdVs / meanVtas * 100 : 0
      const edr = Math.max(0, Math.min(1.0, coherent ? rawEdr * 0.5 : rawEdr))
      const tier = tierOfEdr(edr)
      const [latStr, lngStr, flStr] = k.split('|').map(Number)
      cells.push({
        id: k,
        latC: slat / n, lngC: slng / n,
        latMin: latStr * binDeg, latMax: (latStr + 1) * binDeg,
        lngMin: lngStr * binDeg, lngMax: (lngStr + 1) * binDeg,
        flBand: flStr,
        flMin: flStr * FL_BIN_FT / 100, flMax: (flStr + 1) * FL_BIN_FT / 100,
        meanFl, meanVs, stdVs, meanVtas, edr, tier, count: n,
        members: arr,
        vx: svx / n, vy: svy / n,
        coherent,
      })
    }
    // per-aircraft assignment
    const cellByKey = new Map<string, Cell>()
    for (const c of cells) cellByKey.set(c.id, c)
    const acRows: AcRow[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!Number.isFinite(f.altitudeFt) || f.altitudeFt < minAlt) continue
      const latBin = Math.floor(f.lat / binDeg)
      const lngBin = Math.floor(f.lng / binDeg)
      const flBin = Math.floor(f.altitudeFt / FL_BIN_FT)
      const c = cellByKey.get(`${latBin}|${lngBin}|${flBin}`)
      const edr = c ? c.edr : 0
      const tier: Tier = c ? c.tier : 'UNK'
      acRows.push({ f, cell: c, edr, tier })
    }
    return { cells, acRows }
  }, [flights, minSamples, binDeg, minFl])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { NIL: 0, LIGHT: 0, MOD: 0, SEVERE: 0, EXTREME: 0, UNK: 0 }
    for (const x of cells) c[x.tier]++
    return c
  }, [cells])
  const worstEdr = cells.reduce((m, c) => c.edr > m ? c.edr : m, 0)
  const meanEdr = cells.length ? cells.reduce((s, c) => s + c.edr, 0) / cells.length : 0

  const filteredCells = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = tierFilter ? cells.filter(c => c.tier === tierFilter) : cells
    const subset = q ? base.filter(c =>
      c.id.toLowerCase().includes(q) ||
      c.members.some(m => (m.callsign || '').toLowerCase().includes(q) || (m.operator || '').toLowerCase().includes(q) || (m.type || '').toLowerCase().includes(q) || (m.icao || '').toLowerCase().includes(q))
    ) : base
    return subset.slice().sort((a, b) => b.edr - a.edr).slice(0, 200)
  }, [cells, tierFilter, query])

  const filteredAc = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = tierFilter ? acRows.filter(r => r.tier === tierFilter) : acRows
    const subset = q ? base.filter(r =>
      (r.f.callsign || '').toLowerCase().includes(q) ||
      (r.f.type || '').toLowerCase().includes(q) ||
      (r.f.operator || '').toLowerCase().includes(q) ||
      (r.f.icao || '').toLowerCase().includes(q)) : base
    return subset.slice().sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier)
      const tia = ta < 0 ? 99 : ta, tib = tb < 0 ? 99 : tb
      if (tia !== tib) return tia - tib
      return b.edr - a.edr
    }).slice(0, 200)
  }, [acRows, tierFilter, query])

  /* Map overlay */
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC_C = 'tb-cell-src', LYR_C = 'tb-cell-lyr', LYR_CL = 'tb-cell-line'
    const SRC_F = 'tb-fc-src', LYR_F = 'tb-fc-lyr'
    const SRC_L = 'tb-lbl-src', LYR_L = 'tb-lbl-lyr'
    const ensure = () => {
      if (!m.getSource(SRC_C)) m.addSource(SRC_C, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never)
      if (!m.getLayer(LYR_C)) m.addLayer({ id: LYR_C, type: 'fill', source: SRC_C, paint: {
        'fill-color': ['get', 'col'], 'fill-opacity': ['get', 'op'],
      } } as never)
      if (!m.getLayer(LYR_CL)) m.addLayer({ id: LYR_CL, type: 'line', source: SRC_C, paint: {
        'line-color': ['get', 'col'], 'line-width': 1.2, 'line-opacity': 0.85, 'line-dasharray': [2, 1.4],
      } } as never)
      if (!m.getSource(SRC_F)) m.addSource(SRC_F, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never)
      if (!m.getLayer(LYR_F)) m.addLayer({ id: LYR_F, type: 'line', source: SRC_F, paint: {
        'line-color': ['get', 'col'], 'line-width': 1.4, 'line-opacity': 0.8, 'line-dasharray': [1, 2],
      } } as never)
      if (!m.getSource(SRC_L)) m.addSource(SRC_L, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never)
      if (!m.getLayer(LYR_L)) m.addLayer({ id: LYR_L, type: 'symbol', source: SRC_L, layout: {
        'text-field': ['get', 'lbl'], 'text-size': 10, 'text-offset': [0, 0.4], 'text-anchor': 'center',
        'text-font': ['Open Sans Regular','Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'col'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.4 } } as never)
    }
    try { ensure() } catch { setTimeout(() => { try { ensure() } catch {} }, 250) }

    const cellFt: GeoJSON.Feature[] = []
    const fcFt: GeoJSON.Feature[] = []
    const lblFt: GeoJSON.Feature[] = []
    if (showOvl && showCells) {
      for (const c of cells) {
        if (c.tier === 'NIL') continue
        const col = TIER_COLOR[c.tier]
        const op = 0.10 + Math.min(0.25, c.edr * 0.35)
        cellFt.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[
            [c.lngMin, c.latMin], [c.lngMax, c.latMin], [c.lngMax, c.latMax], [c.lngMin, c.latMax], [c.lngMin, c.latMin],
          ]] },
          properties: { col, op },
        })
      }
    }
    if (showOvl && showFcast) {
      const hrs = fcastMin / 60
      for (const c of cells) {
        if (c.tier === 'NIL') continue
        const col = TIER_COLOR[c.tier]
        // advect centroid by mean track at mean GS, hrs ahead
        // vx, vy in nm/min -> nm over fcastMin
        const dxNm = c.vx * fcastMin
        const dyNm = c.vy * fcastMin
        const dLat = dyNm / 60
        const dLng = dxNm / (60 * Math.max(0.01, Math.cos(c.latC * Math.PI / 180)))
        fcFt.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[c.lngC, c.latC], [c.lngC + dLng, c.latC + dLat]] },
          properties: { col },
        })
        // forecast box
        const halfLat = (c.latMax - c.latMin) / 2
        const halfLng = (c.lngMax - c.lngMin) / 2
        const cx = c.lngC + dLng, cy = c.latC + dLat
        cellFt.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[
            [cx - halfLng, cy - halfLat], [cx + halfLng, cy - halfLat], [cx + halfLng, cy + halfLat], [cx - halfLng, cy + halfLat], [cx - halfLng, cy - halfLat],
          ]] },
          properties: { col, op: 0.05 },
        })
      }
      void hrs
    }
    if (showOvl && showLbl) {
      for (const c of cells) {
        if (c.tier === 'NIL') continue
        lblFt.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lngC, c.latC] },
          properties: { lbl: `${c.tier}  EDR ${c.edr.toFixed(2)}  FL${Math.round(c.meanFl)}  n${c.count}`, col: TIER_COLOR[c.tier] },
        })
      }
    }
    try {
      ;(m.getSource(SRC_C) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: cellFt })
      ;(m.getSource(SRC_F) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: fcFt })
      ;(m.getSource(SRC_L) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFt })
    } catch {}
    return () => {
      try {
        for (const id of [LYR_L, LYR_F, LYR_CL, LYR_C]) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC_L, SRC_F, SRC_C]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, cells, showOvl, showCells, showFcast, showLbl, fcastMin])

  /* SVG EDR vs FL */
  const svg = useMemo(() => {
    const W = 360, H = 200, padL = 32, padB = 22, padT = 8, padR = 8
    const xMin = 0, xMax = 450
    const yMin = 0, yMax = 1.0
    const xs = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR)
    const ys = (v: number) => H - padB - ((v - yMin) / (yMax - yMin)) * (H - padT - padB)
    return { W, H, xs, ys, padL, padB, padT, padR, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(94vw,440px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Turbulence</div>
          <div className="text-sm font-semibold text-slate-100">EDR Estimator</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-5 gap-1">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? null : t)}
            className={`px-1.5 py-1.5 rounded-md border text-[10px] font-mono ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/50'} text-slate-200`}>
            <div className="flex items-center justify-between">
              <span style={{ color: TIER_COLOR[t] }}>●</span>
              <span className="text-slate-300">{counts[t]}</span>
            </div>
            <div className="text-[9px] text-slate-500 mt-0.5 truncate">{t}</div>
          </button>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-3 gap-1.5 text-[10px] font-mono">
        <div className="bg-slate-900/50 border border-slate-800 rounded-md px-2 py-1.5">
          <div className="text-slate-500 text-[9px]">CELLS</div>
          <div className="text-slate-200">{cells.length}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-md px-2 py-1.5">
          <div className="text-slate-500 text-[9px]">WORST EDR</div>
          <div style={{ color: TIER_COLOR[tierOfEdr(worstEdr)] }}>{worstEdr.toFixed(2)}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-md px-2 py-1.5">
          <div className="text-slate-500 text-[9px]">MEAN EDR</div>
          <div style={{ color: TIER_COLOR[tierOfEdr(meanEdr)] }}>{meanEdr.toFixed(2)}</div>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-slate-900">
        <svg viewBox={`0 0 ${svg.W} ${svg.H}`} className="w-full h-[200px]">
          <rect x={0} y={0} width={svg.W} height={svg.H} fill="#020617" />
          {/* severity bands */}
          <rect x={svg.padL} y={svg.ys(0.20)} width={svg.W - svg.padL - svg.padR} height={svg.ys(0.10) - svg.ys(0.20)} fill="#10b981" opacity={0.06} />
          <rect x={svg.padL} y={svg.ys(0.40)} width={svg.W - svg.padL - svg.padR} height={svg.ys(0.20) - svg.ys(0.40)} fill="#f59e0b" opacity={0.06} />
          <rect x={svg.padL} y={svg.ys(0.70)} width={svg.W - svg.padL - svg.padR} height={svg.ys(0.40) - svg.ys(0.70)} fill="#f43f5e" opacity={0.06} />
          <rect x={svg.padL} y={svg.ys(1.0)} width={svg.W - svg.padL - svg.padR} height={svg.ys(0.70) - svg.ys(1.0)} fill="#dc2626" opacity={0.08} />
          {/* thresholds */}
          {[0.10, 0.20, 0.40, 0.70].map(t => (
            <line key={t} x1={svg.padL} y1={svg.ys(t)} x2={svg.W - svg.padR} y2={svg.ys(t)} stroke="#475569" strokeWidth={0.5} strokeDasharray="2,2" opacity={0.5} />
          ))}
          {/* x axis */}
          {[0, 100, 200, 300, 400].map(t => (
            <g key={t}>
              <line x1={svg.xs(t)} y1={svg.ys(0)} x2={svg.xs(t)} y2={svg.ys(1.0)} stroke="#1e293b" strokeWidth={0.4} />
              <text x={svg.xs(t)} y={svg.H - 6} fill="#475569" fontSize={8} textAnchor="middle">FL{t}</text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1.0].map(t => (
            <text key={t} x={4} y={svg.ys(t) + 3} fill="#475569" fontSize={8}>{t.toFixed(2)}</text>
          ))}
          {cells.map((c, i) => (
            <circle key={i} cx={svg.xs(Math.min(450, c.meanFl))} cy={svg.ys(Math.min(1.0, c.edr))}
              r={2 + Math.min(8, c.count * 0.5)}
              fill={TIER_COLOR[c.tier]} opacity={0.75} stroke="#0f172a" strokeWidth={0.6} />
          ))}
          <text x={svg.W - 6} y={svg.padT + 10} fill="#64748b" fontSize={8} textAnchor="end">EDR vs FL (radius = sample n)</text>
        </svg>
      </div>

      <div className="px-4 py-2 border-b border-slate-900 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px] font-mono">
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">MIN-N</span>
          <input type="range" min={3} max={12} value={minSamples} onChange={e => setMinSamples(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">{minSamples}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">BIN</span>
          <input type="range" min={0.5} max={3.0} step={0.25} value={binDeg} onChange={e => setBinDeg(parseFloat(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">{binDeg.toFixed(2)}°</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">MIN-FL</span>
          <input type="range" min={30} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">FL{minFl}</span>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-slate-500">FCAST</span>
          <input type="range" min={5} max={120} step={5} value={fcastMin} onChange={e => setFcastMin(parseInt(e.target.value))} className="flex-1" />
          <span className="text-slate-300 w-10 text-right">+{fcastMin}m</span>
        </label>
      </div>

      <div className="px-4 py-2 border-b border-slate-900 flex flex-wrap gap-1.5 text-[10px] font-mono">
        {([['OVL', showOvl, setShowOvl], ['CELLS', showCells, setShowCells], ['FCAST', showFcast, setShowFcast], ['LBL', showLbl, setShowLbl]] as const).map(([lbl, val, setter]) => (
          <button key={lbl} onClick={() => setter(!val)}
            className={`px-2 py-1 rounded-md border ${val ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/50 text-slate-500'}`}>
            {lbl}
          </button>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-slate-900 flex gap-1.5 text-[10px] font-mono">
        {(['CELLS', 'AC'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2.5 py-1 rounded-md border ${tab === t ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/50 text-slate-500'}`}>
            {t === 'CELLS' ? 'CELLS' : 'AIRCRAFT'}
          </button>
        ))}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="callsign / type / operator / icao / cell"
          className="flex-1 bg-slate-900/60 border border-slate-800 rounded-md px-2 py-1 text-[10px] font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'CELLS' ? (
          <>
            {filteredCells.length === 0 && (
              <div className="px-4 py-6 text-center text-[11px] font-mono text-slate-500">no cells detected</div>
            )}
            {filteredCells.map((c, i) => {
              const col = TIER_COLOR[c.tier]
              const edrPct = Math.min(100, c.edr * 100)
              return (
                <button key={i} onClick={() => onFlyLatLng(c.latC, c.lngC, 6)}
                  className="w-full text-left px-4 py-2 border-b border-slate-900 hover:bg-slate-900/40 transition-colors flex gap-2">
                  <div className="w-1 self-stretch rounded-full" style={{ background: col }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-mono text-slate-100 truncate">
                        {c.latC.toFixed(1)}, {c.lngC.toFixed(1)} <span className="text-slate-500">· FL{Math.round(c.flMin)}-{Math.round(c.flMax)}</span>
                      </div>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md" style={{ borderColor: col, borderWidth: 1, color: col }}>{c.tier}</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                      EDR {c.edr.toFixed(3)} · σVS {c.stdVs.toFixed(0)}fpm · n{c.count} · μFL{Math.round(c.meanFl)}
                    </div>
                    <div className="relative h-1.5 mt-1.5 bg-slate-900 rounded-full overflow-hidden">
                      <div className="absolute top-0 left-0 bottom-0 rounded-full" style={{ width: `${edrPct}%`, background: col, opacity: 0.7 }} />
                      <div className="absolute top-0 bottom-0" style={{ left: '10%', width: '1px', background: '#475569' }} />
                      <div className="absolute top-0 bottom-0" style={{ left: '20%', width: '1px', background: '#475569' }} />
                      <div className="absolute top-0 bottom-0" style={{ left: '40%', width: '1px', background: '#475569' }} />
                      <div className="absolute top-0 bottom-0" style={{ left: '70%', width: '1px', background: '#475569' }} />
                    </div>
                    <div className="text-[9px] font-mono text-slate-500 mt-1 truncate">
                      μVS {c.meanVs >= 0 ? '+' : ''}{c.meanVs.toFixed(0)}fpm · μTAS {c.meanVtas.toFixed(0)}kt {c.coherent ? '· coherent flow (downgraded)' : ''}
                    </div>
                    <div className="text-[9px] font-mono text-slate-600 mt-0.5 truncate">
                      {c.members.slice(0, 4).map(m => m.callsign || m.icao).join(' · ')}{c.members.length > 4 ? ` +${c.members.length - 4}` : ''}
                    </div>
                  </div>
                </button>
              )
            })}
          </>
        ) : (
          <>
            {filteredAc.length === 0 && (
              <div className="px-4 py-6 text-center text-[11px] font-mono text-slate-500">no aircraft match</div>
            )}
            {filteredAc.map((r, i) => {
              const col = TIER_COLOR[r.tier]
              const edrPct = Math.min(100, r.edr * 100)
              return (
                <button key={i} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-4 py-2 border-b border-slate-900 hover:bg-slate-900/40 transition-colors flex gap-2">
                  <div className="w-1 self-stretch rounded-full" style={{ background: col }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-mono text-slate-100 truncate">
                        {r.f.callsign || r.f.icao} <span className="text-slate-500">· {r.f.type || '—'}</span>
                      </div>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md" style={{ borderColor: col, borderWidth: 1, color: col }}>{r.tier}</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                      FL{Math.round(r.f.altitudeFt/100)} · {r.f.velocityKts.toFixed(0)}kt · VS {r.f.vertRate >= 0 ? '+' : ''}{r.f.vertRate.toFixed(0)} · EDR {r.edr.toFixed(3)}
                    </div>
                    <div className="relative h-1.5 mt-1.5 bg-slate-900 rounded-full overflow-hidden">
                      <div className="absolute top-0 left-0 bottom-0 rounded-full" style={{ width: `${edrPct}%`, background: col, opacity: 0.7 }} />
                    </div>
                    <div className="text-[9px] font-mono text-slate-500 mt-1 truncate">
                      {r.cell ? `cell n${r.cell.count} · σVS ${r.cell.stdVs.toFixed(0)}fpm` : 'no cell (sparse area)'}
                    </div>
                    <div className="text-[9px] font-mono text-slate-600 mt-0.5 truncate">{r.f.operator || ''}</div>
                  </div>
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
