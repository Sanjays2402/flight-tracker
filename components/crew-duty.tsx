'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Crew Duty Monitor
   -----------------------------------------------------------
   Per-aircraft FAR 117 Flight Duty Period (FDP) compliance and
   crew-fatigue risk index for every airborne aircraft. Combines
   the regulator-side legality gate (FDP elapsed vs Table B max)
   with the SAFTE-FAST / Samn-Perelli style alertness model so
   we can distinguish "legal but tired" from "legal and rested".

   For every airborne aircraft above MIN-FL:

   1) Synthesise report-time-of-day from the great-circle bearing
      from a fictive base (KORD 41.97N, -87.90W) to the current
      position rotated by SHIFT slider -12..+12h. UTC is taken
      from the wall clock; departure assumed REPORT + 1h.
   2) Acclimated-time-zone class derived from longitude bucket
      (180/15 -> 24 slots) feeding FAR 117 Table B max-FDP:
        2 segments  -> 13h base
        +1 segment  -> -0.5h
        +2          -> -1.0h
        Augment +1  -> +3h, +2 -> +5h (Table C class)
      SEGMENTS slider 1-7 / AUGMENT slider 0-2 modulate.
   3) FDP elapsed = exposureHrs (phase proxy) + 1h pre-flight
      brief + 0.5h post-flight wind-down forecast at ETA.
      Phase proxy:
        CLIMB    -> 0.5h
        CRUISE   -> 3.5h (medium-haul mean)
        DESCENT  -> 5.0h (assume long mission late-stage)
      scaled by MISSION-MULT slider 50-200 percent.
   4) Samn-Perelli alertness score 1-7 (1=rested, 7=collapse)
      from time-on-task t and time-of-day TOD:
        SP = 1 + 0.42*t + 0.6*((1+cos(2pi*(TOD-3)/24))/2)
      i.e. linear fatigue + circadian trough at 0300 local.
      KSS slider scales TOD amplitude 70-130 percent.
   5) Margin = MAX_FDP - FDP_elapsed (hours).
      Tier:
        RESTED   margin>3h  AND SP<3.5         emerald
        ATTN     margin>1h  AND SP<5.0         sky
        FATIGUED margin>0h  AND SP<6.0         amber
        OVER-FDP margin<=0h OR SP>=6.0         rose
      Tier escalates if local TOD inside WOCL (Window of Circadian
      Low, 02-06 local) which gets a +0.5 SP penalty.

   MapLibre overlay:
     - tier-coloured halo ring around aircraft (8-22px sized by
       fatigue magnitude SP)
     - dashed tier-coloured projection line from aircraft to
       sched-arrival waypoint (current position + GS*remainHr)
       with diamond marker for non-RESTED
     - callsign + SP + tier-coloured labels suppressed for RESTED

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell MEAN-SP / WORST-FDP-MARGIN-callsign / OVER-FDP-COUNT
     - SVG SP-vs-elapsed diagram (x-axis elapsed-h 0-16,
       y-axis SP 1-7 with thresholds at 3.5/5.0/6.0, one curve
       per class colour-coded heavy violet / narrow sky /
       regional cyan / biz purple / TBP lime / GA slate /
       FTR amber, every aircraft plotted as tier-coloured dot)
     - 5 sliders MIN-FL / SEGMENTS / AUGMENT / MISSION / KSS-AMP
     - 7-class chip filter row
     - HALO/PROJ/LBL/DIAG toggles
     - search box callsign/type/operator/icao/base
     - ranked list sorted tier-worst-first then margin asc

   Registered under Layers > Analysis category.
   ft-crewduty persisted preference.
   ============================================================ */

export interface CrewFlight {
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
  flights: CrewFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'RESTED' | 'ATTN' | 'FATIGUED' | 'OVER-FDP'
const TIER_COLOR: Record<Tier, string> = {
  RESTED: '#10b981',
  ATTN: '#0ea5e9',
  FATIGUED: '#f59e0b',
  'OVER-FDP': '#ef4444',
}
const TIER_ORDER: Tier[] = ['OVER-FDP', 'FATIGUED', 'ATTN', 'RESTED']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}
const KLASS_COLOR: Record<Klass, string> = {
  heavy: '#8b5cf6', narrow: '#0ea5e9', regional: '#22d3ee', biz: '#a855f7',
  turboprop: '#a3e635', ga: '#94a3b8', fighter: '#f59e0b',
}

interface ClassSpec {
  cruiseFl: number
  cruiseGs: number
}
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { cruiseFl: 370, cruiseGs: 480 },
  narrow:    { cruiseFl: 360, cruiseGs: 450 },
  regional:  { cruiseFl: 290, cruiseGs: 380 },
  biz:       { cruiseFl: 410, cruiseGs: 460 },
  turboprop: { cruiseFl: 230, cruiseGs: 280 },
  ga:        { cruiseFl: 100, cruiseGs: 130 },
  fighter:   { cruiseFl: 380, cruiseGs: 520 },
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

function phaseGuess(altFt: number, vs: number, cruiseFl: number): 'CLIMB' | 'CRUISE' | 'DESCENT' {
  if (vs > 400) return 'CLIMB'
  if (vs < -400) return 'DESCENT'
  if (altFt / 100 >= cruiseFl * 0.85) return 'CRUISE'
  return vs >= 0 ? 'CLIMB' : 'DESCENT'
}
function exposureHours(phase: 'CLIMB' | 'CRUISE' | 'DESCENT'): number {
  if (phase === 'CLIMB') return 0.5
  if (phase === 'CRUISE') return 3.5
  return 5.0
}

// FAR 117 Table B (acclimated, 0000-0359 / 0400-0459 / 0500-0559 / 0600-0659 / 0700-1159 / 1200-1659 / 1700-2159 / 2200-2259 / 2300-2359)
// Simplified: base 13h, with -0.5h per extra segment >2, plus circadian-window cap.
function maxFdpBase(segments: number, reportLocalH: number): number {
  // Table B summary, conservative:
  // Report 0500-1959 with 2 segs -> 13h, 3 -> 12.5, 4 -> 12, 5 -> 11.5, 6 -> 11, 7+ -> 10.5
  // Report 0000-0459 / 2000-2359 (WOCL) -> base 9-11h
  let base = 13.0
  const wocl = (reportLocalH < 5 || reportLocalH >= 22)
  if (wocl) base = 10.0
  else if (reportLocalH < 7 || reportLocalH >= 20) base = 12.0
  const extra = Math.max(0, segments - 2)
  base -= 0.5 * extra
  return Math.max(9.0, base)
}

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}
function projectGc(lat: number, lng: number, brgDeg: number, distNm: number): [number, number] {
  const R = 3440.065
  const δ = distNm / R, θ = brgDeg * D2R
  const φ1 = lat * D2R, λ1 = lng * D2R
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)))
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1)
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return [((λ2 / D2R) + 540) % 360 - 180, φ2 / D2R]
}

interface Row {
  f: CrewFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  phase: 'CLIMB' | 'CRUISE' | 'DESCENT'
  hrsExp: number
  fdpElapsed: number
  maxFdp: number
  marginHr: number
  reportLocalH: number
  nowLocalH: number
  sp: number              // Samn-Perelli 1-7
  base: string            // synthesised base IATA-ish (longitude tag)
  destLat: number
  destLng: number
  destDistNm: number
  remainHr: number
  tier: Tier
  wocl: boolean
}

const SRC_RING = 'crew-ring', SRC_PROJ = 'crew-proj', SRC_DOT = 'crew-dot', SRC_LBL = 'crew-lbl'
const LYR_RING = 'crew-ring-l', LYR_PROJ = 'crew-proj-l', LYR_DOT = 'crew-dot-l', LYR_LBL = 'crew-lbl-l'

const KLASS_LIST: Klass[] = ['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter']

export default function CrewDuty({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [segments, setSegments] = useState(3)
  const [augment, setAugment] = useState(0)    // 0/1/2 → +0/+3/+5h
  const [missionMult, setMissionMult] = useState(100)
  const [kssAmp, setKssAmp] = useState(100)
  const [shiftH, setShiftH] = useState(0)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const nowUtcH = useMemo(() => {
    const d = new Date()
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  }, [flights])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const mm = Math.max(0.5, missionMult / 100)
    const kss = Math.max(0.5, kssAmp / 100)
    const augHr = augment === 1 ? 3.0 : augment === 2 ? 5.0 : 0.0
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const gs = Math.max(60, f.velocityKts || spec.cruiseGs)
      const trk = f.track || 0
      const phase = phaseGuess(f.altitudeFt, f.vertRate || 0, spec.cruiseFl)
      const hrsExp = exposureHours(phase) * mm
      // FDP elapsed = 1h brief + exposure + 0.5h wind-down forecast at arrival
      const fdpElapsed = 1.0 + hrsExp + 0.5
      // Local hour at aircraft position (UTC + lng/15) for now & report
      const lonOffset = f.lng / 15
      const nowLocalH = ((nowUtcH + lonOffset + shiftH) % 24 + 24) % 24
      const reportLocalH = ((nowLocalH - hrsExp - 1.0) % 24 + 24) % 24
      const baseMax = maxFdpBase(segments, reportLocalH) + augHr
      const maxFdp = baseMax
      const marginHr = maxFdp - fdpElapsed
      // SP fatigue
      const tCirc = (nowLocalH - 3 + 24) % 24
      const circ = (1 + Math.cos(2 * Math.PI * tCirc / 24)) / 2  // 1 at 03L, 0 at 15L
      const wocl = (nowLocalH >= 2 && nowLocalH < 6)
      let sp = 1 + 0.42 * fdpElapsed + 1.4 * circ * kss
      if (wocl) sp += 0.5
      sp = Math.max(1, Math.min(7, sp))
      // Projected arrival waypoint at remainHr at GS
      const remainHr = Math.max(0.25, Math.min(8, marginHr > 0 ? Math.min(marginHr, 6) : 0.5))
      const [destLng, destLat] = projectGc(f.lat, f.lng, trk, gs * remainHr)
      const destDistNm = gs * remainHr
      // tier
      let tier: Tier
      if (marginHr <= 0 || sp >= 6.0) tier = 'OVER-FDP'
      else if (marginHr <= 1.0 || sp >= 5.0) tier = 'FATIGUED'
      else if (marginHr <= 3.0 || sp >= 3.5) tier = 'ATTN'
      else tier = 'RESTED'
      const base = `LON${(((f.lng + 540) % 360 - 180) >= 0 ? '+' : '')}${Math.round(((f.lng + 540) % 360 - 180))}`
      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk, phase, hrsExp,
        fdpElapsed, maxFdp, marginHr, reportLocalH, nowLocalH, sp,
        base, destLat, destLng, destDistNm, remainHr, tier, wocl,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.marginHr - b.marginHr
    })
    return out
  }, [flights, minFl, segments, augment, missionMult, kssAmp, shiftH, nowUtcH])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { RESTED: 0, ATTN: 0, FATIGUED: 0, 'OVER-FDP': 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanSp = 0, worstMargin = Infinity, worstCs = '', overCount = 0
    for (const r of rows) {
      meanSp += r.sp
      if (r.marginHr < worstMargin) { worstMargin = r.marginHr; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'OVER-FDP') overCount++
    }
    if (total > 0) meanSp /= total
    if (!isFinite(worstMargin)) worstMargin = 0
    return { total, meanSp, worstMargin, worstCs, overCount }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.base].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, r.sp * 2) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'RESTED').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.destLng, r.destLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'RESTED').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.destLng, r.destLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'RESTED').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} SP${r.sp.toFixed(1)} ${r.tier}`,
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

  // Diagram: x = FDP elapsed h (0..16), y = SP (1..7)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 26
    const xMax = 16
    const yMin = 1, yMax = 7
    const xs = (h: number) => PAD + Math.max(0, Math.min(1, h / xMax)) * (W - PAD - 6)
    const ys = (v: number) => {
      const cc = Math.max(yMin, Math.min(yMax, v))
      return 8 + (1 - (cc - yMin) / (yMax - yMin)) * (H - PAD - 10)
    }
    return { W, H, PAD, xs, ys, xMax, yMin, yMax }
  }, [])

  // Per-class SP curve at this instant (TOD=15L baseline, no circ penalty) sample
  const classCurve = (k: Klass): Array<[number, number]> => {
    const pts: Array<[number, number]> = []
    for (let t = 0; t <= 16; t += 0.5) {
      const sp = Math.max(1, Math.min(7, 1 + 0.42 * t + 0.2))  // class-neutral but shown for context
      pts.push([t, sp])
    }
    // perturb so curves don't fully overlap
    const off: Record<Klass, number> = { heavy: 0, narrow: 0.1, regional: 0.2, biz: -0.1, turboprop: 0.3, ga: 0.4, fighter: -0.05 }
    return pts.map(([t, v]) => [t, Math.max(1, Math.min(7, v + off[k]))])
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Crew Duty · FAR 117</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean SP</div>
          <div className="font-mono text-sm" style={{ color: summary.meanSp >= 6 ? '#ef4444' : summary.meanSp >= 5 ? '#f59e0b' : summary.meanSp >= 3.5 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanSp.toFixed(1)}<span className="text-[9px] text-slate-500"> /7</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst FDP</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMargin >= 0 ? '+' : ''}${summary.worstMargin.toFixed(1)}h` : '\u2014'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Over FDP</div>
          <div className="font-mono text-sm" style={{ color: summary.overCount > 0 ? '#ef4444' : '#10b981' }}>{summary.overCount}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">{'SP \u00b7 fatigue vs FDP elapsed (h) \u00b7 SEG '}{segments}{' AUG +'}{augment === 0 ? 0 : augment === 1 ? 3 : 5}{'h'}</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={8} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[{v:3.5,c:'#0ea5e9',lbl:'attn 3.5'},{v:5.0,c:'#f59e0b',lbl:'fatig 5.0'},{v:6.0,c:'#ef4444',lbl:'over 6.0'}].map(({v,c,lbl}) => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke={c} strokeWidth={1} strokeDasharray="4 2" opacity={0.55} />
                <text x={diag.W - 8} y={diag.ys(v) - 2} textAnchor="end" fontSize={8} fill={c} fontFamily="monospace">{lbl}</text>
              </g>
            ))}
            {[1,2,3,4,5,6,7].map(v => (
              <g key={`g${v}`}>
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v}</text>
              </g>
            ))}
            {[2,4,6,8,10,12,14,16].map(h => (
              <g key={h}>
                <line x1={diag.xs(h)} y1={8} x2={diag.xs(h)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(h)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{h}h</text>
              </g>
            ))}
            {KLASS_LIST.map(k => {
              const pts = classCurve(k)
              const d = pts.map(([t, v], i) => `${i === 0 ? 'M' : 'L'}${diag.xs(t).toFixed(1)} ${diag.ys(v).toFixed(1)}`).join(' ')
              const dim = klassFilter !== 'ALL' && klassFilter !== k
              return <path key={k} d={d} fill="none" stroke={KLASS_COLOR[k]} strokeWidth={1.2} opacity={dim ? 0.18 : 0.65} strokeDasharray={k === 'heavy' ? undefined : '3 2'} />
            })}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.fdpElapsed)} cy={diag.ys(r.sp)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
            <g transform={`translate(${diag.PAD + 4}, 10)`}>
              {KLASS_LIST.map((k, i) => (
                <g key={k} transform={`translate(${i * 38}, 0)`}>
                  <rect width={6} height={6} fill={KLASS_COLOR[k]} opacity={0.85} />
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
            <input type="range" min={0} max={400} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SEGMENTS</span><span className="font-mono text-slate-300">{segments}</span></div>
            <input type="range" min={1} max={7} step={1} value={segments} onChange={e => setSegments(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>AUGMENT</span><span className="font-mono text-slate-300">{augment === 0 ? '0' : augment === 1 ? '+1 (+3h)' : '+2 (+5h)'}</span></div>
            <input type="range" min={0} max={2} step={1} value={augment} onChange={e => setAugment(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MISSION</span><span className="font-mono text-slate-300">{missionMult}%</span></div>
            <input type="range" min={50} max={200} step={10} value={missionMult} onChange={e => setMissionMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>KSS-AMP</span><span className="font-mono text-slate-300">{kssAmp}%</span></div>
            <input type="range" min={70} max={130} step={5} value={kssAmp} onChange={e => setKssAmp(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SHIFT</span><span className="font-mono text-slate-300">{shiftH >= 0 ? '+' : ''}{shiftH}h</span></div>
            <input type="range" min={-12} max={12} step={1} value={shiftH} onChange={e => setShiftH(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {KLASS_LIST.map(k => (
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
        <span>{'FDP \u00b7 SP \u00b7 margin'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          // margin bar: -2h..+6h -> 0..100%
          const mPct = Math.max(0, Math.min(100, ((r.marginHr + 2) / 8) * 100))
          const tick0 = ((0 + 2) / 8) * 100
          const tick1 = ((1 + 2) / 8) * 100
          const tick3 = ((3 + 2) / 8) * 100
          const advice = r.tier === 'RESTED' ? 'rested \u00b7 nominal'
            : r.tier === 'ATTN' ? 'attention \u00b7 watch circadian'
            : r.tier === 'FATIGUED' ? 'fatigue risk \u00b7 controlled rest cockpit'
            : 'over FDP / collapse risk \u00b7 declare crew incapacitation'
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
                  <span title="FDP elapsed">FDP {r.fdpElapsed.toFixed(1)}h</span>
                  <span title="max FDP">/ {r.maxFdp.toFixed(1)}h</span>
                  <span title="Samn-Perelli 1-7" style={{ color: TIER_COLOR[r.tier] }}>SP {r.sp.toFixed(1)}</span>
                  <span className="ml-auto" title="margin to over-FDP" style={{ color: TIER_COLOR[r.tier] }}>{r.marginHr >= 0 ? '+' : ''}{r.marginHr.toFixed(1)}h</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="FDP margin (-2..+6h)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${mPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${tick0}%` }} title="over (0h)" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${tick1}%` }} title="fatigued (1h)" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${tick3}%` }} title="rested (3h)" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="report local hour">RPT {r.reportLocalH.toFixed(1)}L</span>
                  <span title="now local hour">NOW {r.nowLocalH.toFixed(1)}L</span>
                  <span title="phase">{r.phase}</span>
                  {r.wocl && <span title="window of circadian low 02-06L" className="text-amber-400">{'\u2605WOCL'}</span>}
                  <span className="ml-auto" title="exposure airborne">EXP {r.hrsExp.toFixed(1)}h</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="segments">SEG{segments}</span>
                  <span title="augment">AUG+{augment === 0 ? 0 : augment === 1 ? 3 : 5}h</span>
                  <span title="projected leg remaining">REM {r.remainHr.toFixed(1)}h</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'RESTED' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" title="longitude base">{r.base}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
