'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Speed Limit Compliance Monitor (FAR 91.117 / ICAO Annex 2)
   -----------------------------------------------------------
   Enforces the three classic speed restrictions every IFR/VFR
   pilot operates under:
     91.117(a) — no person may operate an aircraft below 10,000 ft
                 MSL at an indicated airspeed > 250 KIAS.
     91.117(b) — no person may operate an aircraft at or below
                 2,500 ft AGL within 4 NM of the primary airport
                 of a Class C or D airspace at an IAS > 200 KIAS.
     91.117(c) — no person may operate an aircraft in airspace
                 underlying a Class B or in a VFR corridor through
                 Class B at an IAS > 200 KIAS.
   Plus the supplementary cruise-Mach ceiling rule:
     91.117(d) — exception if minimum safe airspeed for any
                 particular operation is greater than the maximum
                 speed prescribed (we mark as ALLOWED).
     ICAO Annex 2 — operators must observe the published Mach
                    number limit (MMO). We use class-typical MMO
                    (HVY 0.88 / NRW 0.82 / RGN 0.78 / BIZ 0.92 /
                    TBP 0.65 / GA 0.40 / FTR 0.95) for over-Mach
                    detection.
   ============================================================ */

export interface SpeedFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  ias?: number
  mach?: number
  track: number
  vertRate: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: SpeedFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'WATCH' | 'OVER' | 'BUST'
const TIER_COLOR: Record<Tier, string> = { OK: '#10b981', WATCH: '#0ea5e9', OVER: '#f59e0b', BUST: '#ef4444' }
const TIER_ORDER: Tier[] = ['BUST', 'OVER', 'WATCH', 'OK']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = { heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR' }
// Class MMO (cruise Mach ceiling) from FCOM tables
const KLASS_MMO: Record<Klass, number> = { heavy: 0.88, narrow: 0.82, regional: 0.78, biz: 0.92, turboprop: 0.65, ga: 0.40, fighter: 0.95 }
// Class Vmo (KIAS structural max) — Boeing/Airbus FCOM
const KLASS_VMO: Record<Klass, number> = { heavy: 350, narrow: 340, regional: 320, biz: 340, turboprop: 250, ga: 180, fighter: 700 }

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7') || /^H/.test(x) || /(EC|AS|R44|R66|S76|S92|UH|AW139)/.test(x)) return 'ga'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}

// ISA temperature and density-ratio model for TAS->IAS approximation
function isaT(altFt: number, isaDev = 0): number {
  const altKft = altFt / 1000
  return Math.max(216.65, 288.15 - 1.98 * altKft) + isaDev
}
function densityRatio(altFt: number, isaDev = 0): number {
  // Sigma = (Tisa/T)^5.2561 * (P/P0); use exponential atmosphere proxy
  const Tisa = 288.15 - 1.98 * altFt / 1000
  const T = Tisa + isaDev
  // pressure ratio
  const delta = altFt < 36089 ? Math.pow(Tisa / 288.15, 5.2561) : 0.2234 * Math.exp(-(altFt - 36089) / 20805)
  return delta * (288.15 / T)
}
function tasToIas(tasKts: number, altFt: number, isaDev = 0): number {
  // CAS ~= TAS * sqrt(sigma) (low-Mach incompressible approx)
  const sigma = densityRatio(altFt, isaDev)
  return tasKts * Math.sqrt(Math.max(0.05, sigma))
}
function machFromTAS(tasKts: number, altFt: number, isaDev = 0): number {
  const T = isaT(altFt, isaDev)
  const a = Math.sqrt(1.4 * 287.05 * T) * 1.94384 // m/s -> kts
  return tasKts / a
}

interface Row {
  f: SpeedFlight
  klass: Klass
  altFt: number
  fl: number
  tasKts: number
  iasKts: number
  machVal: number
  mmo: number
  vmo: number
  // applicable limits
  limit117a: number | null   // 250 if below 10kft else null
  limit117b: boolean         // 200 if within 4nm of large airport AND ≤2500 AGL (we proxy AGL = altFt - airport-not-known so use MSL <2500 below airport)
  limitNearestAp?: { icao: string, dist: number }
  applicableLimit: number    // KIAS active threshold
  applicableLabel: string
  overByKts: number          // signed: positive = over the limit
  overMach: number           // positive = over MMO
  rule: 'A_250' | 'B_200' | 'CRUISE' | 'CLIMB_OUT' | 'GROUND'
  tier: Tier
}

const SRC_RING = 'spd-ring', SRC_LBL = 'spd-lbl', SRC_LINE = 'spd-line'
const LYR_RING = 'spd-ring-l', LYR_LBL = 'spd-lbl-l', LYR_LINE = 'spd-line-l'

// Pre-build a coarse airport index by 1-deg cell for fast nearest lookup
const APS = AIRPORTS.filter(a => !!a.a)

function nearestAirport(lat: number, lng: number, capNm: number): { icao: string, dist: number } | null {
  // brute force; AIRPORTS is ~4-5k. Bound by lat/lng pre-filter (1.5 deg ~ 90nm).
  let best: { icao: string, dist: number } | null = null
  const dLat = capNm / 60 + 0.5
  for (const a of APS) {
    if (Math.abs(a.lat - lat) > dLat) continue
    const cosLat = Math.cos(lat * D2R) || 0.1
    if (Math.abs(a.lon - lng) * cosLat > dLat) continue
    const d = gcDistNm(lat, lng, a.lat, a.lon)
    if (d > capNm) continue
    if (!best || d < best.dist) best = { icao: a.i || a.a, dist: d }
  }
  return best
}

export default function SpeedLimit({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'RULES'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [maxFl, setMaxFl] = useState(450)
  const [bClassNm, setBClassNm] = useState(4)            // 91.117(b) radius
  const [bClassAgl, setBClassAgl] = useState(2500)       // 91.117(b) AGL cap
  const [isaDev, setIsaDev] = useState(0)                // OAT offset for IAS calc
  const [vmoMult, setVmoMult] = useState(100)            // % calibration on Vmo
  const [showRing, setShowRing] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const fl = f.altitudeFt / 100
      if (fl > maxFl) continue
      const klass = classify(f.type, f.category)
      const tas = isFinite(f.velocityKts) ? f.velocityKts : 0
      // Prefer reported IAS if present, else convert from TAS using ISA+dev density
      const iasKts = (typeof f.ias === 'number' && isFinite(f.ias) && f.ias > 0) ? f.ias : tasToIas(tas, f.altitudeFt, isaDev)
      const machVal = (typeof f.mach === 'number' && isFinite(f.mach) && f.mach > 0) ? f.mach : machFromTAS(tas, f.altitudeFt, isaDev)
      const mmo = KLASS_MMO[klass]
      const vmo = KLASS_VMO[klass] * (vmoMult / 100)

      // FAR 91.117(a): below 10000 ft MSL -> 250 KIAS cap
      const a250 = f.altitudeFt < 10000 ? 250 : null
      // FAR 91.117(b): within bClassNm of a primary airport AND AGL <= bClassAgl
      // AGL proxy: use altitude vs the nearest airport elevation — but airports.ts has no elev. Use MSL <= bClassAgl as conservative proxy.
      let limit117b = false
      let nearAp: { icao: string, dist: number } | null = null
      if (f.altitudeFt <= bClassAgl + 200) {
        nearAp = nearestAirport(f.lat, f.lng, bClassNm)
        if (nearAp) limit117b = true
      }

      // Pick active rule
      let applicableLimit = vmo
      let applicableLabel = `Vmo ${vmo.toFixed(0)}`
      let rule: Row['rule'] = 'CRUISE'
      if (limit117b) { applicableLimit = 200; applicableLabel = '91.117(b) 200 KIAS'; rule = 'B_200' }
      else if (a250 != null) { applicableLimit = 250; applicableLabel = '91.117(a) 250 KIAS'; rule = 'A_250' }
      else { applicableLimit = vmo; applicableLabel = `Vmo ${vmo.toFixed(0)} KIAS`; rule = 'CRUISE' }
      // Climb-out exemption: if VS > +1500 fpm and within 5nm of airport, allow up to 250 even with 117(b)
      // (per FAA Letter Interpretation 1990 — pilot may exceed 200 when minimum safe airspeed requires)
      if (rule === 'B_200' && f.vertRate > 1500) { applicableLimit = 250; applicableLabel = '91.117(d) climb-out exempt'; rule = 'CLIMB_OUT' }

      const overByKts = iasKts - applicableLimit
      const overMach = machVal - mmo

      // Tier
      let tier: Tier
      if (overByKts >= 30 || overMach >= 0.04) tier = 'BUST'
      else if (overByKts >= 10 || overMach >= 0.02) tier = 'OVER'
      else if (overByKts >= -10 || overMach >= -0.01) tier = 'WATCH'
      else tier = 'OK'

      out.push({
        f, klass, altFt: f.altitudeFt, fl, tasKts: tas, iasKts, machVal,
        mmo, vmo, limit117a: a250, limit117b,
        limitNearestAp: nearAp || undefined,
        applicableLimit, applicableLabel, overByKts, overMach,
        rule, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.overByKts - a.overByKts
    })
    return out
  }, [flights, maxFl, bClassNm, bClassAgl, isaDev, vmoMult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, WATCH: 0, OVER: 0, BUST: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let n = 0, bust = 0, over = 0, worstKts = -9999, worstCs = '', sumExc = 0, machExc = 0
    for (const r of rows) {
      n++
      if (r.tier === 'BUST') bust++
      if (r.tier === 'OVER' || r.tier === 'BUST') over++
      if (r.overByKts > worstKts) { worstKts = r.overByKts; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.overByKts > 0) sumExc += r.overByKts
      if (r.overMach > 0) machExc++
    }
    return { n, bust, over, worstKts, worstCs, sumExc, machExc }
  }, [rows])

  const ruleRollup = useMemo(() => {
    const m = new Map<string, { rule: string, label: string, count: number, worst: Tier, exceed: number }>()
    for (const r of rows) {
      const k = r.rule
      const e = m.get(k)
      const label = r.rule === 'A_250' ? '91.117(a) <10k MSL @ 250 KIAS'
        : r.rule === 'B_200' ? '91.117(b) ≤2500 AGL within radius @ 200 KIAS'
        : r.rule === 'CLIMB_OUT' ? '91.117(d) climb-out exemption'
        : 'Vmo / MMO cruise ceiling'
      if (e) {
        e.count++
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worst)) e.worst = r.tier
        if (r.overByKts > 0) e.exceed += r.overByKts
      } else {
        m.set(k, { rule: k, label, count: 1, worst: r.tier, exceed: Math.max(0, r.overByKts) })
      }
    }
    return Array.from(m.values()).sort((a, b) => TIER_ORDER.indexOf(a.worst) - TIER_ORDER.indexOf(b.worst) || b.count - a.count)
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.applicableLabel].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, Math.max(0, r.overByKts) / 4) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Project a forward arrow showing speed magnitude — for OVER/BUST aircraft
    const lineFc = { type: 'FeatureCollection' as const, features: showLine ? rows.filter(r => r.tier === 'OVER' || r.tier === 'BUST').map(r => {
      const distNm = Math.max(3, Math.min(40, r.overByKts / 2 + 8))
      const bearingRad = (r.f.track || 0) * D2R
      const dLat = (distNm / 60) * Math.cos(bearingRad)
      const dLng = (distNm / 60) * Math.sin(bearingRad) / Math.cos(r.f.lat * D2R)
      return {
        type: 'Feature' as const,
        properties: { color: TIER_COLOR[r.tier] },
        geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] },
      }
    }) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], text: `${(r.f.callsign || r.f.icao).trim()} ${r.iasKts.toFixed(0)}KIAS ${r.overByKts > 0 ? '+' : ''}${r.overByKts.toFixed(0)}` },
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
        'circle-opacity': 0.15,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_LINE, lineFc, () => map.addLayer({ id: LYR_LINE, type: 'line', source: SRC_LINE, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.6,
        'line-opacity': 0.7,
        'line-dasharray': [2, 2],
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
      for (const lyr of [LYR_LBL, LYR_LINE, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_LINE, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showLine, showLabels])

  // Diagram: x = altitude kft 0..50, y = IAS kts 0..400, with limit envelopes
  const diag = useMemo(() => {
    const W = 360, H = 200, PAD = 32
    const xMax = 50, yMax = 400
    const xs = (altKft: number) => PAD + (altKft / xMax) * (W - PAD - 6)
    const ys = (ias: number) => 6 + (1 - ias / yMax) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Speed Limit · FAR 91.117</span>
        <span className="text-[10px] text-slate-500 ml-auto">{summary.n} tracks</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Bust</div>
          <div className="font-mono text-sm" style={{ color: summary.bust > 0 ? '#ef4444' : '#10b981' }}>{summary.bust}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Over</div>
          <div className="font-mono text-sm" style={{ color: summary.over > 0 ? '#f59e0b' : '#10b981' }}>{summary.over}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstKts >= 0 ? '+' : ''}${summary.worstKts.toFixed(0)}` : '—'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Total Excess</div>
          <div className="font-mono text-[11px]" style={{ color: summary.sumExc > 0 ? '#f59e0b' : '#10b981' }}>{summary.sumExc.toFixed(0)}<span className="text-[9px] text-slate-500"> kt-sum</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mach Bust</div>
          <div className="font-mono text-[11px]" style={{ color: summary.machExc > 0 ? '#ef4444' : '#10b981' }}>{summary.machExc}<span className="text-[9px] text-slate-500"> over MMO</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">IAS · KIAS vs ALT · kft (FAR 91.117 envelope)</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* Vmo cruise ceiling ~340 KIAS band */}
            <line x1={diag.xs(0)} y1={diag.ys(340)} x2={diag.xs(50)} y2={diag.ys(340)} stroke="#0ea5e9" strokeDasharray="4 3" strokeWidth={0.8} />
            <text x={diag.W - 8} y={diag.ys(340) - 2} textAnchor="end" fontSize={8} fill="#0ea5e9" fontFamily="monospace">Vmo ~340</text>
            {/* 250 KIAS line below 10kft (91.117a) */}
            <line x1={diag.xs(0)} y1={diag.ys(250)} x2={diag.xs(10)} y2={diag.ys(250)} stroke="#f59e0b" strokeDasharray="4 3" strokeWidth={1.0} />
            <line x1={diag.xs(10)} y1={diag.ys(250)} x2={diag.xs(10)} y2={diag.ys(340)} stroke="#f59e0b" strokeDasharray="4 3" strokeWidth={1.0} />
            <text x={diag.xs(5)} y={diag.ys(250) - 2} textAnchor="middle" fontSize={8} fill="#f59e0b" fontFamily="monospace">91.117(a) 250 below 10k</text>
            {/* 200 KIAS line below 2.5kft (91.117b) */}
            <line x1={diag.xs(0)} y1={diag.ys(200)} x2={diag.xs(2.5)} y2={diag.ys(200)} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1.0} />
            <line x1={diag.xs(2.5)} y1={diag.ys(200)} x2={diag.xs(2.5)} y2={diag.ys(250)} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1.0} />
            <text x={diag.xs(1.25)} y={diag.ys(200) - 2} textAnchor="middle" fontSize={7} fill="#ef4444" fontFamily="monospace">200 within 4nm</text>
            {/* y axis ticks */}
            {[100, 200, 250, 300, 400].map(v => (
              <text key={v} x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}</text>
            ))}
            {/* x axis ticks */}
            {[10, 20, 30, 40, 50].map(v => (
              <g key={v}>
                <line x1={diag.xs(v)} y1={diag.H - diag.PAD} x2={diag.xs(v)} y2={diag.H - diag.PAD + 3} stroke="#475569" />
                <text x={diag.xs(v)} y={diag.H - diag.PAD + 11} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao}
                cx={diag.xs(Math.max(0, Math.min(diag.xMax, r.altFt / 1000)))}
                cy={diag.ys(Math.max(0, Math.min(diag.yMax, r.iasKts)))}
                r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>B-RADIUS</span><span className="font-mono text-slate-300">{bClassNm}nm</span></div>
            <input type="range" min={2} max={10} step={1} value={bClassNm} onChange={e => setBClassNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>B-AGL</span><span className="font-mono text-slate-300">{bClassAgl}ft</span></div>
            <input type="range" min={1500} max={5000} step={100} value={bClassAgl} onChange={e => setBClassAgl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}°C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>Vmo-MULT</span><span className="font-mono text-slate-300">{vmoMult}%</span></div>
          <input type="range" min={70} max={130} step={5} value={vmoMult} onChange={e => setVmoMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLine} onChange={e => setShowLine(e.target.checked)} className="accent-sky-500" /><span>VEC</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / rule"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'RULES'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} tracks` : `${ruleRollup.length} rules active`}</span>
        <span>{tab === 'AIRCRAFT' ? 'IAS · over · rule' : 'count · worst · excess'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // Excess bar: -60..+60 kts mapped to 0..100%, center=50%
          const span = 60
          const pct = Math.max(0, Math.min(100, ((r.overByKts + span) / (2 * span)) * 100))
          const advice = r.tier === 'OK' ? 'within FAR 91.117 limits'
            : r.tier === 'WATCH' ? 'approaching limit · monitor IAS / mach'
            : r.tier === 'OVER' ? 'reduce speed · FAR 91.117 exceedance'
            : 'speed bust · ATC report · FAR 91.13 careless / 91.117 violation'
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
                  <span title="flight level">F{r.fl.toFixed(0)}</span>
                  <span title="indicated airspeed">IAS {r.iasKts.toFixed(0)}kt</span>
                  <span title="true airspeed">TAS {r.tasKts.toFixed(0)}</span>
                  <span className="ml-auto" title="mach number" style={{ color: r.overMach >= 0 ? TIER_COLOR[r.tier] : '#64748b' }}>M{r.machVal.toFixed(2)}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="excess over active limit (-60..+60 kts)">
                  <div className="absolute inset-y-0" style={{ left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-slate-500" style={{ left: '50%' }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${((10 + span) / (2 * span)) * 100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${((30 + span) / (2 * span)) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="active rule" style={{ color: TIER_COLOR[r.tier] }}>{r.applicableLabel}</span>
                  <span className="ml-auto" title="over by KIAS">{r.overByKts >= 0 ? '+' : ''}{r.overByKts.toFixed(0)}kt</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="MMO">MMO {r.mmo.toFixed(2)}</span>
                  <span title="Vmo">Vmo {r.vmo.toFixed(0)}</span>
                  {r.limitNearestAp && <span title="nearest airport">›{r.limitNearestAp.icao} {r.limitNearestAp.dist.toFixed(1)}nm</span>}
                  <span className="ml-auto" title="vertical rate">VS{r.f.vertRate >= 0 ? '+' : ''}{r.f.vertRate.toFixed(0)}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
        {tab === 'RULES' && ruleRollup.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No rules active.</div>
        )}
        {tab === 'RULES' && ruleRollup.map(r => {
          const pct = Math.min(100, (r.count / Math.max(1, rows.length)) * 100)
          return (
            <div key={r.rule} className="px-3 py-2 border-b border-slate-900 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.worst] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{r.rule}</span>
                  <span className="text-slate-500 truncate">{r.label}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.worst] }}>{r.worst}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="share of fleet on this rule">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: TIER_COLOR[r.worst], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="aircraft on this rule">{r.count} aircraft</span>
                  <span className="ml-auto" title="kt-sum exceedance">{r.exceed.toFixed(0)} kt-sum over</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
