'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Cabin Pressurization Monitor
   -----------------------------------------------------------
   For every airborne aircraft above FL100 reconstructs the
   pressurized-cabin environment by combining ADS-B altitude
   with a class-tunable max-Δp schedule (B787 9.4psi / A320
   8.6psi / E-jet 7.5psi / G650 9.7psi / Q400 5.5psi etc),
   then derives the FAA AIM 8-1-2 Time of Useful Consciousness
   ladder for a hypothetical sudden depressurization to ambient
   and the FAR 121.333 emergency-descent profile required to
   reach 10,000ft cabin altitude.

   For every airborne aircraft within MIN-FL..MAX-FL band:

   1) Ambient pressure altitude → ISA pressure psi via
        P(h) = 14.696·(1 − 6.8755856e-6·h)^5.2559   (h ≤ 36k)
        P(h) = 3.2828·exp(−4.806e-5·(h − 36089))    (h > 36k)
   2) Pressurized cabin pressure = min(P_sea, P_amb + Δp_max·DP-FRAC)
      where DP-FRAC slider models partial-schedule pressurization
      (0.50 = climbing toward max, 1.00 = full design Δp)
   3) Cabin altitude = inverse ISA solve of cabin pressure
   4) TUC at sudden depress (cabin → ambient): interpolated
      FAA ladder
        FL150 ∞ / FL180 30min / FL220 10min / FL250 4min
        FL280 3min / FL300 90s / FL350 45s / FL400 18s
        FL450 12s / FL500 9s
   5) Emergency descent: target_alt=10000ft, sink rate by class
      heavy/narrow/biz 7000fpm idle+spoilers, regional 5000,
      turboprop 3500, GA 2500, fighter 12000;
      time = max(0,(altFt-10000)/sink), nm = GS*t/60
      Waypoint = great-circle project along track.
   6) Pax O2 reserve adequacy: required = 1.5x descent time min
      (FAA cap ~22min pulse-on-demand), reported as margin %.

   Tier classification (current pressurized cabin altitude):
     SAFE     cabin<6000ft  emerald
     NOMINAL  cabin<8000ft  sky
     HIGH     cabin<10000ft amber
     CRITICAL cabin≥10000ft rose

   MapLibre overlay:
     - Tier-coloured halo ring sized by cabin altitude (8-22px)
     - Dashed projection line aircraft → 10kft drop-off waypoint
       with diamond marker
     - Tier-coloured callsign + cab-alt + TUC labels
   Side panel: 4-tier counter strip, 3-cell summary, SVG ISA
   pressure ladder diagram, sliders, ranked list with class-
   pill, cabin-alt bars, click-to-fly.

   Registered under Layers > Safety & Traffic category.
   ft-cabin persisted preference.
   ============================================================ */

export interface CabinFlight {
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
  flights: CabinFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'SAFE' | 'NOMINAL' | 'HIGH' | 'CRITICAL'
const TIER_COLOR: Record<Tier, string> = {
  SAFE: '#10b981',
  NOMINAL: '#0ea5e9',
  HIGH: '#f59e0b',
  CRITICAL: '#ef4444',
}
const TIER_ORDER: Tier[] = ['CRITICAL', 'HIGH', 'NOMINAL', 'SAFE']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

interface PressSpec {
  dpMax: number        // psi — design max differential pressure
  sinkFpm: number      // emergency descent fpm (idle+spoilers/boards)
  o2MaxMin: number     // pax O2 reserve minutes (pulse-on-demand)
  cruiseFl: number     // typical cruise FL for cabin-target curve
  cabinTarget: number  // ft — design cabin alt at cruise
}
const SPEC: Record<Klass, PressSpec> = {
  heavy:     { dpMax: 9.4, sinkFpm: 7000, o2MaxMin: 22, cruiseFl: 370, cabinTarget: 6000  },
  narrow:    { dpMax: 8.6, sinkFpm: 7000, o2MaxMin: 22, cruiseFl: 360, cabinTarget: 8000  },
  regional:  { dpMax: 7.5, sinkFpm: 5000, o2MaxMin: 15, cruiseFl: 290, cabinTarget: 8000  },
  biz:       { dpMax: 9.7, sinkFpm: 7000, o2MaxMin: 22, cruiseFl: 410, cabinTarget: 4500  },
  turboprop: { dpMax: 5.5, sinkFpm: 3500, o2MaxMin: 15, cruiseFl: 230, cabinTarget: 8000  },
  ga:        { dpMax: 5.0, sinkFpm: 2500, o2MaxMin: 12, cruiseFl: 200, cabinTarget: 8000  },
  fighter:   { dpMax: 5.0, sinkFpm: 12000,o2MaxMin: 30, cruiseFl: 380, cabinTarget: 17000 },
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

// ISA pressure (psi) from pressure altitude (ft)
function isaPsi(altFt: number): number {
  if (altFt <= 36089) {
    return 14.696 * Math.pow(1 - 6.8755856e-6 * altFt, 5.2559)
  }
  const p36 = 3.2828 // psi at 36089ft
  return p36 * Math.exp(-4.80637e-5 * (altFt - 36089))
}
// Inverse ISA: ft from psi
function isaFt(psi: number): number {
  if (psi >= 3.2828) {
    // h = (1 - (psi/14.696)^(1/5.2559)) / 6.8755856e-6
    return (1 - Math.pow(psi / 14.696, 1 / 5.2559)) / 6.8755856e-6
  }
  return 36089 + Math.log(3.2828 / psi) / 4.80637e-5
}

// TUC (seconds) — interpolation across FAA AIM ladder
const TUC_TABLE: [number, number][] = [
  [15000, 99999],
  [18000, 1800],
  [22000, 600],
  [25000, 240],
  [28000, 180],
  [30000, 90],
  [35000, 45],
  [40000, 18],
  [45000, 12],
  [50000, 9],
]
function tucSec(cabinAltFt: number): number {
  if (cabinAltFt <= TUC_TABLE[0][0]) return TUC_TABLE[0][1]
  for (let i = 0; i < TUC_TABLE.length - 1; i++) {
    const [a1, t1] = TUC_TABLE[i]
    const [a2, t2] = TUC_TABLE[i + 1]
    if (cabinAltFt <= a2) {
      const f = (cabinAltFt - a1) / (a2 - a1)
      // interpolate in log
      return Math.exp(Math.log(Math.max(1, t1)) + (Math.log(Math.max(1, t2)) - Math.log(Math.max(1, t1))) * f)
    }
  }
  return TUC_TABLE[TUC_TABLE.length - 1][1]
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
  f: CabinFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  ambPsi: number
  cabPsi: number
  dpNow: number
  dpMax: number
  cabinFt: number
  tucS: number          // TUC at sudden depress to ambient
  descentMin: number    // emergency descent time to 10kft
  descentNm: number
  o2NeedMin: number
  o2MarginPct: number   // (o2max - need)/o2max
  dropLat: number
  dropLng: number
  tier: Tier
}

const SRC_RING = 'cabin-ring', SRC_PROJ = 'cabin-proj', SRC_DOT = 'cabin-dot', SRC_LBL = 'cabin-lbl'
const LYR_RING = 'cabin-ring-l', LYR_PROJ = 'cabin-proj-l', LYR_DOT = 'cabin-dot-l', LYR_LBL = 'cabin-lbl-l'

export default function CabinPressure({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(100)
  const [maxFl, setMaxFl] = useState(500)
  const [dpFrac, setDpFrac] = useState(100)   // percent of design Δp engaged
  const [o2Factor, setO2Factor] = useState(150) // % of descent-time required for O2 reserve
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const dpf = Math.max(0, Math.min(1, dpFrac / 100))
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const gs = Math.max(0, f.velocityKts || 0)
      const trk = f.track || 0
      const ambPsi = isaPsi(f.altitudeFt)
      const cabPsiCap = Math.min(14.696, ambPsi + spec.dpMax * dpf)
      // Smooth cabin schedule: target cabinTarget at cruiseFl, sea level at 0; pick max of design and schedule.
      const schedAlt = Math.max(0, spec.cabinTarget * Math.min(1, f.altitudeFt / (spec.cruiseFl * 100)))
      const cabinPsiSched = isaPsi(schedAlt)
      const cabPsi = Math.min(14.696, Math.max(cabPsiCap, cabinPsiSched))
      const dpNow = Math.max(0, cabPsi - ambPsi)
      const cabinFt = Math.max(0, isaFt(cabPsi))
      const tucS = tucSec(f.altitudeFt) // TUC if depress to ambient = current alt
      const descentMin = f.altitudeFt > 10000 ? (f.altitudeFt - 10000) / spec.sinkFpm : 0
      const descentNm = (gs * descentMin) / 60
      const drop = projectGc(f.lat, f.lng, trk, descentNm)
      const o2NeedMin = descentMin * (o2Factor / 100)
      const o2MarginPct = spec.o2MaxMin > 0 ? Math.max(-100, Math.min(100, ((spec.o2MaxMin - o2NeedMin) / spec.o2MaxMin) * 100)) : 0
      let tier: Tier
      if (cabinFt < 6000) tier = 'SAFE'
      else if (cabinFt < 8000) tier = 'NOMINAL'
      else if (cabinFt < 10000) tier = 'HIGH'
      else tier = 'CRITICAL'
      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk,
        ambPsi, cabPsi, dpNow, dpMax: spec.dpMax,
        cabinFt, tucS, descentMin, descentNm,
        o2NeedMin, o2MarginPct,
        dropLat: drop.lat, dropLng: drop.lng, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.cabinFt - a.cabinFt
    })
    return out
  }, [flights, minFl, maxFl, dpFrac, o2Factor])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { SAFE: 0, NOMINAL: 0, HIGH: 0, CRITICAL: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanCabin = 0, meanDp = 0, worstFt = 0, worstCs = ''
    for (const r of rows) {
      meanCabin += r.cabinFt
      meanDp += r.dpNow
      if (r.cabinFt > worstFt) { worstFt = r.cabinFt; worstCs = (r.f.callsign || r.f.icao).trim() }
    }
    if (total > 0) { meanCabin /= total; meanDp /= total }
    return { total, meanCabin, meanDp, worstFt, worstCs }
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
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, r.cabinFt / 1200) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.descentNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.dropLng, r.dropLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.descentNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.dropLng, r.dropLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} CAB${(r.cabinFt / 1000).toFixed(1)}k TUC${r.tucS < 60 ? r.tucS.toFixed(0) + 's' : (r.tucS / 60).toFixed(0) + 'm'}`,
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

  // SVG diagram: x = ambient FL, y = cabin altitude (kft). Plot class cabin curves + aircraft dots.
  const diag = useMemo(() => {
    const W = 360, H = 150, PAD = 24
    const xMaxFl = 500
    const yMaxKft = 16
    const xs = (fl: number) => PAD + (fl / xMaxFl) * (W - PAD - 6)
    const ys = (kft: number) => H - PAD - (Math.min(yMaxKft, kft) / yMaxKft) * (H - PAD - 8)
    const classes: Klass[] = ['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter']
    const classColor: Record<Klass, string> = { heavy: '#8b5cf6', narrow: '#0ea5e9', regional: '#22d3ee', biz: '#a855f7', turboprop: '#84cc16', ga: '#94a3b8', fighter: '#f59e0b' }
    return { W, H, PAD, xs, ys, classes, classColor, xMaxFl, yMaxKft }
  }, [])

  // Curve for given class: cabin alt vs ambient FL given dpFrac
  const cabinCurve = (k: Klass, dpf: number): { fl: number, kft: number }[] => {
    const spec = SPEC[k]
    const pts: { fl: number, kft: number }[] = []
    for (let fl = 0; fl <= diag.xMaxFl; fl += 20) {
      const altFt = fl * 100
      const ambPsi = isaPsi(altFt)
      const cabPsiCap = Math.min(14.696, ambPsi + spec.dpMax * dpf)
      const schedAlt = Math.max(0, spec.cabinTarget * Math.min(1, altFt / (spec.cruiseFl * 100)))
      const cabinPsiSched = isaPsi(schedAlt)
      const cabPsi = Math.min(14.696, Math.max(cabPsiCap, cabinPsiSched))
      const cabinFt = Math.max(0, isaFt(cabPsi))
      pts.push({ fl, kft: cabinFt / 1000 })
    }
    return pts
  }
  const dpf = Math.max(0, Math.min(1, dpFrac / 100))

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Cabin Pressure</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} pressurized</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Cabin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanCabin >= 10000 ? '#ef4444' : summary.meanCabin >= 8000 ? '#f59e0b' : '#0ea5e9' }}>
            {(summary.meanCabin / 1000).toFixed(1)}k<span className="text-[9px] text-slate-500"> ft</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Δp</div>
          <div className="font-mono text-sm text-slate-200">{summary.meanDp.toFixed(1)}<span className="text-[9px] text-slate-500"> psi</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Cabin</div>
          <div className="font-mono text-[11px] text-slate-200 truncate">{summary.worstCs ? `${summary.worstCs} ${(summary.worstFt / 1000).toFixed(1)}k` : '—'}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Cabin altitude · cabin-kft vs ambient FL</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y grid: 4 / 8 / 10 / 12 kft (with FAA 10k threshold highlighted) */}
            {[4, 8, 10, 12].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)}
                  stroke={v === 10 ? '#ef4444' : '#1e293b'} strokeDasharray={v === 10 ? '4 2' : '2 3'} opacity={v === 10 ? 0.5 : 1} />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}k</text>
              </g>
            ))}
            {/* x grid */}
            {[100, 200, 300, 400, 500].map(fl => (
              <g key={fl}>
                <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* class curves */}
            {diag.classes.map(k => {
              const dim = klassFilter !== 'ALL' && klassFilter !== k
              const pts = cabinCurve(k, dpf)
              const path = pts.map(p => `${diag.xs(p.fl)},${diag.ys(p.kft)}`).join(' ')
              return <polyline key={k} points={path} fill="none" stroke={diag.classColor[k]} strokeWidth={1.2} opacity={dim ? 0.18 : 0.85} />
            })}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.altFt / 100)} cy={diag.ys(r.cabinFt / 1000)} r={2.4} fill={TIER_COLOR[r.tier]} opacity={0.9} />
            ))}
            {/* legend strip */}
            <g transform={`translate(${diag.PAD + 4},10)`}>
              {diag.classes.map((k, i) => (
                <g key={k} transform={`translate(${i * 44},0)`}>
                  <rect x={0} y={0} width={6} height={6} fill={diag.classColor[k]} opacity={0.8} />
                  <text x={9} y={6} fontSize={8} fill="#94a3b8" fontFamily="monospace">{KLASS_LABEL[k]}</text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={500} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={550} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DP-FRAC</span><span className="font-mono text-slate-300">{dpFrac}%</span></div>
            <input type="range" min={50} max={100} step={5} value={dpFrac} onChange={e => setDpFrac(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>O2-FACTOR</span><span className="font-mono text-slate-300">{o2Factor}%</span></div>
            <input type="range" min={100} max={300} step={10} value={o2Factor} onChange={e => setO2Factor(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <span>{filtered.length} shown / {rows.length} pressurized</span>
        <span>cabin · Δp · TUC · descent</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const cabPct = Math.max(0, Math.min(100, (r.cabinFt / 14000) * 100))
          const tucLbl = r.tucS >= 1800 ? '∞' : r.tucS < 60 ? `${r.tucS.toFixed(0)}s` : `${(r.tucS / 60).toFixed(1)}m`
          const dpPct = Math.max(0, Math.min(100, (r.dpNow / r.dpMax) * 100))
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
                  <span title="ambient flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="cabin altitude">CAB {(r.cabinFt / 1000).toFixed(1)}k</span>
                  <span title="differential pressure">Δp {r.dpNow.toFixed(1)}/{r.dpMax.toFixed(1)}psi</span>
                  <span className="ml-auto" title="TUC at sudden depress to ambient" style={{ color: r.tucS < 60 ? '#ef4444' : r.tucS < 180 ? '#f59e0b' : '#94a3b8' }}>TUC {tucLbl}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="cabin altitude 0-14kft">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${cabPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${(6 / 14) * 100}%` }} title="SAFE / NOMINAL" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(8 / 14) * 100}%` }} title="NOMINAL / HIGH" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(10 / 14) * 100}%` }} title="HIGH / CRITICAL" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="Δp usage">Δp {dpPct.toFixed(0)}%</span>
                  <span title="emergency descent to 10kft">DES {r.descentMin.toFixed(1)}m/{r.descentNm.toFixed(0)}nm</span>
                  <span className="ml-auto" title="O2 reserve margin" style={{ color: r.o2MarginPct < 0 ? '#ef4444' : r.o2MarginPct < 25 ? '#f59e0b' : '#10b981' }}>O2 {r.o2MarginPct >= 0 ? '+' : ''}{r.o2MarginPct.toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="cabin pressure psi">{r.cabPsi.toFixed(1)}psi</span>
                  <span title="ambient psi">amb {r.ambPsi.toFixed(2)}psi</span>
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
