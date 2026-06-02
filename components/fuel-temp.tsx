'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Fuel Temperature Monitor
   -----------------------------------------------------------
   Tracks bulk wing-tank fuel temperature for every airborne
   aircraft against jet fuel freeze-point and waxing limits.
   Inspired by BA38 (LHR 2008) fuel-ice-induced rollback and
   routine ETOPS / polar SAT monitoring procedures.

   For every airborne aircraft above MIN-FL:

   1) Ambient SAT (Static Air Temperature) from ISA with ISA-DEV
      slider offset (deg C); SAT = 15 - 1.98*(altKft) + ISA-DEV
      capped at -56.5 (tropopause) above FL360.
   2) TAT (Total Air Temperature) from Mach number (class-typical
      cruise Mach lookup); TAT = SAT*(1 + 0.2*Kr*M^2) where
      recovery factor Kr ~ 0.95 for probe.
   3) Bulk fuel temperature reconstructed via lumped-mass
      first-order thermal model:
         Tfuel(t) = Tfuel(t-1) + dt/tau * (Tskin - Tfuel(t-1))
      where Tskin = SAT + RECOV*(TAT-SAT)*SKIN-FRAC slider,
      tau = TAU-MIN slider (default 35min, heavy 60min, narrow
      40min, regional 25min, biz 20min, TBP 15min, GA 8min).
      Initial Tfuel = +12C (ramp departure) decayed by hours-
      airborne estimate from class-typical mission profile.
      Because we have no direct ground-time data, we synthesize
      hours-airborne from altitude proxy: ascend pattern -> recent
      departure, cruise -> mid-mission, descent -> late mission.
   4) Fuel grade selection: JET-A (freeze -40C / wax -47C),
      JET-A-1 (freeze -47C / wax -54C), TS-1 (Russian, -50C/-57C),
      JP-8 (military, -47C/-54C). Per-class default mapping with
      GRADE override slider (cycles 4 grades).
   5) Per-aircraft margin = Tfuel - Tfreeze (positive = safe head-
      room, negative = at or below freeze, ice crystals shedding).

   Tier classification:
     OK       margin > 8 C   emerald
     CAUTION  margin > 3 C   sky
     WARNING  margin > 0 C   amber
     FREEZE   margin <= 0 C  rose

   Mitigation recommendation per tier:
     OK       — none
     CAUTION  — monitor TAT, consider lower FL on next step
     WARNING  — descend 4000ft, increase Mach 0.02
     FREEZE   — immediate descent below FL280, max Mach to raise
                TAT, divert if margin not recovered in 10min

   MapLibre overlay:
     - Tier-coloured halo ring sized by |margin| (8-22px)
     - Dashed projection line aircraft -> recommended descent
       waypoint (project descent of 4000ft at class sink rate
       along current track), diamond marker
     - Tier-coloured labels callsign + Tfuel-C + margin

   Side panel: 4-tier counter strip click-to-filter, 3-cell
   MEAN-TFUEL / WORST-MARGIN / FREEZE-COUNT summary, SVG
   temperature ladder diagram (x = ambient FL, y = temp C with
   SAT curve, TAT-class curves, fuel freeze line for active
   grade, every aircraft plotted as tier-coloured dot at its
   (FL, Tfuel) coord), 5 sliders (MIN-FL, MAX-FL, ISA-DEV,
   SKIN-FRAC, TAU-MIN, GRADE), 7-class chip filter row,
   HALO/PROJ/LBL/DIAG toggles, callsign/type/operator/icao
   search, ranked list sorted by tier worst-first then margin
   asc with tier color stripe.

   Registered under Layers > Environment category.
   ft-fueltemp persisted preference.
   ============================================================ */

export interface FuelTempFlight {
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
  flights: FuelTempFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'CAUTION' | 'WARNING' | 'FREEZE'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  CAUTION: '#0ea5e9',
  WARNING: '#f59e0b',
  FREEZE: '#ef4444',
}
const TIER_ORDER: Tier[] = ['FREEZE', 'WARNING', 'CAUTION', 'OK']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

interface ClassSpec {
  mach: number       // typical cruise Mach (used for TAT recovery)
  tauMin: number     // thermal time constant (minutes) — lumped fuel mass / heat-transfer
  sinkFpm: number    // standard descent rate for "drop 4000ft" recommendation
  cruiseFl: number   // mid-mission FL for hours-airborne estimate
  defaultGrade: Grade
}
type Grade = 'JET-A' | 'JET-A-1' | 'TS-1' | 'JP-8'
const GRADE_FREEZE: Record<Grade, number> = { 'JET-A': -40, 'JET-A-1': -47, 'TS-1': -50, 'JP-8': -47 }
const GRADE_WAX: Record<Grade, number> = { 'JET-A': -47, 'JET-A-1': -54, 'TS-1': -57, 'JP-8': -54 }
const GRADE_LIST: Grade[] = ['JET-A', 'JET-A-1', 'TS-1', 'JP-8']

const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { mach: 0.84, tauMin: 60, sinkFpm: 1800, cruiseFl: 370, defaultGrade: 'JET-A-1' },
  narrow:    { mach: 0.78, tauMin: 40, sinkFpm: 1800, cruiseFl: 360, defaultGrade: 'JET-A' },
  regional:  { mach: 0.74, tauMin: 25, sinkFpm: 1500, cruiseFl: 290, defaultGrade: 'JET-A' },
  biz:       { mach: 0.80, tauMin: 22, sinkFpm: 2000, cruiseFl: 410, defaultGrade: 'JET-A-1' },
  turboprop: { mach: 0.50, tauMin: 15, sinkFpm: 1200, cruiseFl: 230, defaultGrade: 'JET-A' },
  ga:        { mach: 0.28, tauMin: 8,  sinkFpm: 800,  cruiseFl: 100, defaultGrade: 'JET-A' },
  fighter:   { mach: 0.90, tauMin: 14, sinkFpm: 4000, cruiseFl: 380, defaultGrade: 'JP-8' },
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
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'turboprop'
  return 'narrow'
}

function isaSat(altFt: number, isaDev: number): number {
  const altKm = altFt * 0.0003048
  if (altKm <= 11) return 15 - 6.5 * altKm + isaDev
  return -56.5 + isaDev
}

function tatC(satC: number, mach: number, kr: number): number {
  // TAT(K) = SAT(K) * (1 + 0.2*kr*M^2). Convert via K.
  const satK = satC + 273.15
  const tatK = satK * (1 + 0.2 * kr * mach * mach)
  return tatK - 273.15
}

function phaseGuess(altFt: number, vs: number, cruiseFl: number): 'CLIMB' | 'CRUISE' | 'DESCENT' {
  if (vs > 400) return 'CLIMB'
  if (vs < -400) return 'DESCENT'
  if (altFt / 100 >= cruiseFl * 0.85) return 'CRUISE'
  return vs >= 0 ? 'CLIMB' : 'DESCENT'
}

// Synthesize "hours airborne" from phase, used as exposure time for steady-state approach.
// We don't have flight history so we estimate: CLIMB ~ 0.3h, CRUISE ~ 3h, DESCENT ~ 4.5h.
function exposureHours(phase: 'CLIMB' | 'CRUISE' | 'DESCENT', altFt: number, cruiseFl: number): number {
  if (phase === 'CLIMB') {
    // proportional to how close we are to cruise
    const f = Math.max(0, Math.min(1, altFt / (cruiseFl * 100)))
    return 0.1 + 0.6 * f
  }
  if (phase === 'CRUISE') return 3.0
  // DESCENT — long-haul recovery: assume long mission
  return 4.5
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
  f: FuelTempFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  sat: number
  tat: number
  tskin: number
  tFuel: number
  tFreeze: number
  tWax: number
  marginC: number      // tFuel - tFreeze
  grade: Grade
  phase: 'CLIMB' | 'CRUISE' | 'DESCENT'
  hrsExp: number
  recDescentFt: number
  recDescentMin: number
  recDescentNm: number
  recLat: number
  recLng: number
  tier: Tier
}

const SRC_RING = 'fueltemp-ring', SRC_PROJ = 'fueltemp-proj', SRC_DOT = 'fueltemp-dot', SRC_LBL = 'fueltemp-lbl'
const LYR_RING = 'fueltemp-ring-l', LYR_PROJ = 'fueltemp-proj-l', LYR_DOT = 'fueltemp-dot-l', LYR_LBL = 'fueltemp-lbl-l'

export default function FuelTemp({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(180)
  const [maxFl, setMaxFl] = useState(500)
  const [isaDev, setIsaDev] = useState(0)          // deg C
  const [skinFrac, setSkinFrac] = useState(40)     // % of (TAT-SAT) added to skin
  const [tauMult, setTauMult] = useState(100)      // % of class default tau
  const [gradeIdx, setGradeIdx] = useState(0)      // 0 = AUTO, 1..4 = grades
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const sf = Math.max(0, Math.min(1, skinFrac / 100))
    const tm = Math.max(0.3, tauMult / 100)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const grade: Grade = gradeIdx === 0 ? spec.defaultGrade : GRADE_LIST[gradeIdx - 1]
      const tFreeze = GRADE_FREEZE[grade]
      const tWax = GRADE_WAX[grade]
      const gs = Math.max(0, f.velocityKts || 0)
      const trk = f.track || 0
      const sat = isaSat(f.altitudeFt, isaDev)
      const tat = tatC(sat, spec.mach, 0.95)
      const tskin = sat + (tat - sat) * sf
      // Lumped-mass: solve Tfuel(t) for t = hrsExp*60 minutes with initial T0=12C, asymptote=tskin, tau=spec.tauMin*tm.
      const phase = phaseGuess(f.altitudeFt, f.vertRate || 0, spec.cruiseFl)
      const hrsExp = exposureHours(phase, f.altitudeFt, spec.cruiseFl)
      const tau = Math.max(1, spec.tauMin * tm)
      const T0 = 12 // ramp departure C
      const tMin = hrsExp * 60
      const tFuel = tskin + (T0 - tskin) * Math.exp(-tMin / tau)
      const marginC = tFuel - tFreeze
      let tier: Tier
      if (marginC > 8) tier = 'OK'
      else if (marginC > 3) tier = 'CAUTION'
      else if (marginC > 0) tier = 'WARNING'
      else tier = 'FREEZE'
      // Recommended descent: 4000ft drop typical mitigation, projected forward along track
      const recDescentFt = Math.min(4000, Math.max(0, f.altitudeFt - 10000))
      const recDescentMin = recDescentFt > 0 ? recDescentFt / spec.sinkFpm : 0
      const recDescentNm = (gs * recDescentMin) / 60
      const recPt = projectGc(f.lat, f.lng, trk, recDescentNm)
      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk,
        sat, tat, tskin, tFuel, tFreeze, tWax, marginC, grade,
        phase, hrsExp,
        recDescentFt, recDescentMin, recDescentNm,
        recLat: recPt.lat, recLng: recPt.lng, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.marginC - b.marginC
    })
    return out
  }, [flights, minFl, maxFl, isaDev, skinFrac, tauMult, gradeIdx])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, CAUTION: 0, WARNING: 0, FREEZE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanT = 0, worstMargin = Infinity, worstCs = '', freezeCount = 0
    for (const r of rows) {
      meanT += r.tFuel
      if (r.marginC < worstMargin) { worstMargin = r.marginC; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'FREEZE') freezeCount++
    }
    if (total > 0) meanT /= total
    if (!isFinite(worstMargin)) worstMargin = 0
    return { total, meanT, worstMargin, worstCs, freezeCount }
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

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, Math.abs(r.marginC) / 1.5) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier === 'WARNING' || r.tier === 'FREEZE').filter(r => r.recDescentNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.recLng, r.recLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier === 'WARNING' || r.tier === 'FREEZE').filter(r => r.recDescentNm > 0.5).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.recLng, r.recLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} Tf${r.tFuel.toFixed(0)}C ${r.marginC >= 0 ? '+' : ''}${r.marginC.toFixed(0)}`,
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
        'line-opacity': 0.75,
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

  // Diagram: x = ambient FL 0..500, y = temp C from -80..+20.
  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 24
    const xMaxFl = 500
    const yMinC = -80, yMaxC = 20
    const xs = (fl: number) => PAD + (fl / xMaxFl) * (W - PAD - 6)
    const ys = (c: number) => {
      const cc = Math.max(yMinC, Math.min(yMaxC, c))
      return 6 + (1 - (cc - yMinC) / (yMaxC - yMinC)) * (H - PAD - 8)
    }
    const classes: Klass[] = ['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter']
    const classColor: Record<Klass, string> = { heavy: '#8b5cf6', narrow: '#0ea5e9', regional: '#22d3ee', biz: '#a855f7', turboprop: '#84cc16', ga: '#94a3b8', fighter: '#f59e0b' }
    return { W, H, PAD, xs, ys, classes, classColor, xMaxFl, yMinC, yMaxC }
  }, [])

  const activeGrade: Grade = gradeIdx === 0 ? 'JET-A' : GRADE_LIST[gradeIdx - 1]
  const activeFreeze = GRADE_FREEZE[activeGrade]
  const activeWax = GRADE_WAX[activeGrade]

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Fuel Temperature</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Tfuel</div>
          <div className="font-mono text-sm" style={{ color: summary.meanT <= activeFreeze + 3 ? '#ef4444' : summary.meanT <= activeFreeze + 8 ? '#f59e0b' : '#0ea5e9' }}>
            {summary.meanT.toFixed(0)}<span className="text-[9px] text-slate-500"> °C</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Margin</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMargin >= 0 ? '+' : ''}${summary.worstMargin.toFixed(0)}°` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Freeze</div>
          <div className="font-mono text-sm" style={{ color: summary.freezeCount > 0 ? '#ef4444' : '#10b981' }}>{summary.freezeCount}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Temperature · °C vs ambient FL · grade {activeGrade}</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y gridlines */}
            {[-80, -56, -40, -20, 0, 20].map(v => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {/* x gridlines */}
            {[100, 200, 300, 400, 500].map(fl => (
              <g key={fl}>
                <line x1={diag.xs(fl)} y1={6} x2={diag.xs(fl)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(fl)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">F{fl}</text>
              </g>
            ))}
            {/* freeze + wax lines */}
            <line x1={diag.PAD} y1={diag.ys(activeFreeze)} x2={diag.W - 6} y2={diag.ys(activeFreeze)} stroke="#ef4444" strokeWidth={1.2} strokeDasharray="4 2" opacity={0.7} />
            <text x={diag.W - 8} y={diag.ys(activeFreeze) - 2} textAnchor="end" fontSize={8} fill="#ef4444" fontFamily="monospace">freeze {activeFreeze}°</text>
            <line x1={diag.PAD} y1={diag.ys(activeWax)} x2={diag.W - 6} y2={diag.ys(activeWax)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
            <text x={diag.W - 8} y={diag.ys(activeWax) - 2} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">wax {activeWax}°</text>
            {/* SAT curve (ISA + dev) */}
            {(() => {
              const pts: string[] = []
              for (let fl = 0; fl <= 500; fl += 20) pts.push(`${diag.xs(fl)},${diag.ys(isaSat(fl * 100, isaDev))}`)
              return <polyline points={pts.join(' ')} fill="none" stroke="#94a3b8" strokeWidth={1.2} opacity={0.85} />
            })()}
            <text x={diag.xs(360) + 4} y={diag.ys(isaSat(36000, isaDev)) - 2} fontSize={8} fill="#94a3b8" fontFamily="monospace">SAT</text>
            {/* TAT curves per class */}
            {diag.classes.map(k => {
              const dim = klassFilter !== 'ALL' && klassFilter !== k
              const spec = SPEC[k]
              const pts: string[] = []
              for (let fl = 0; fl <= 500; fl += 20) {
                const sat = isaSat(fl * 100, isaDev)
                const tat = tatC(sat, spec.mach, 0.95)
                pts.push(`${diag.xs(fl)},${diag.ys(tat)}`)
              }
              return <polyline key={k} points={pts.join(' ')} fill="none" stroke={diag.classColor[k]} strokeWidth={1} opacity={dim ? 0.15 : 0.55} strokeDasharray="3 2" />
            })}
            {/* aircraft dots at (FL, Tfuel) */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.altFt / 100)} cy={diag.ys(r.tFuel)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
            {/* legend */}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}°C</span></div>
            <input type="range" min={-30} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SKIN-FRAC</span><span className="font-mono text-slate-300">{skinFrac}%</span></div>
            <input type="range" min={0} max={100} step={5} value={skinFrac} onChange={e => setSkinFrac(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>TAU-MULT</span><span className="font-mono text-slate-300">{tauMult}%</span></div>
            <input type="range" min={30} max={200} step={10} value={tauMult} onChange={e => setTauMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>GRADE</span><span className="font-mono text-slate-300">{gradeIdx === 0 ? 'AUTO' : GRADE_LIST[gradeIdx - 1]}</span></div>
            <input type="range" min={0} max={4} step={1} value={gradeIdx} onChange={e => setGradeIdx(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>Tfuel · margin · grade · descent</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          // margin bar: -10..+20 -> 0..100%
          const mPct = Math.max(0, Math.min(100, ((r.marginC + 10) / 30) * 100))
          const advice = r.tier === 'OK' ? 'monitor' : r.tier === 'CAUTION' ? 'monitor TAT, plan lower FL' : r.tier === 'WARNING' ? 'descend 4kft, +0.02M' : 'descend now, max Mach'
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
                  <span title="flight level">F{Math.round(r.altFt / 100)}</span>
                  <span title="static air temp">SAT {r.sat.toFixed(0)}°</span>
                  <span title="total air temp">TAT {r.tat.toFixed(0)}°</span>
                  <span className="ml-auto" title="bulk fuel temp" style={{ color: TIER_COLOR[r.tier] }}>Tf {r.tFuel.toFixed(0)}°</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="margin to freeze (-10..+20°C)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${mPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${((0 + 10) / 30) * 100}%` }} title="freeze (margin 0)" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${((3 + 10) / 30) * 100}%` }} title="warning / caution" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${((8 + 10) / 30) * 100}%` }} title="caution / ok" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="grade">{r.grade}</span>
                  <span title="freeze pt">FP {r.tFreeze}°</span>
                  <span style={{ color: TIER_COLOR[r.tier] }}>Δ {r.marginC >= 0 ? '+' : ''}{r.marginC.toFixed(1)}°</span>
                  <span className="ml-auto" title="phase">{r.phase}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="exposure hours synthesised from phase">exp {r.hrsExp.toFixed(1)}h</span>
                  <span title="recommended descent">DES {r.recDescentFt.toFixed(0)}ft/{r.recDescentNm.toFixed(0)}nm</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto" title="wax point">wax {r.tWax}°</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
