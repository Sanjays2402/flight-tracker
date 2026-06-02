'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Reserve Fuel Monitor
   -----------------------------------------------------------
   Per-aircraft IFR / VFR fuel-reserve compliance check against
   FAR 91.167 (IFR 45min final reserve + alternate), 91.151
   (VFR day 30min / night 45min), and 121.639 (domestic Part 121
   destination + alternate + 45min hold). The aircraft community
   knows this as "BINGO fuel" — the legal floor below which you
   must declare MINIMUM FUEL (NORDO-equivalent advisory) or, if
   committed-to-land-without-delay, EMERGENCY (Mayday Fuel).

   For every airborne aircraft above MIN-FL:

   1) Synthesise hours-airborne from altitude+phase proxy:
        CLIMB        -> 0.1 + 0.6*(altFt / (cruiseFl*100))
        CRUISE       -> 3.0h baseline (medium-haul mean)
        DESCENT      -> 4.5h (assume long mission late-stage)
      Multiplied by MISSION-MULT slider 50-200%.
   2) Class-typical block endurance (hours of useful fuel at
      block-out, conservative ops-spec figures):
        HVY 14.0h    NRW 6.0h    RGN 3.5h    BIZ 8.0h
        TBP 4.0h     GA  4.5h    FTR 2.5h
      Multiplied by ENDUR-MULT slider 70-130%.
   3) Class-typical cruise burn (kg/h, lerp by class):
        HVY 6500    NRW 2500    RGN 1100    BIZ 1100
        TBP 480     GA  120     FTR 4500
      Phase modifier: CLIMB *1.45 / CRUISE *1.0 / DESCENT *0.55.
   4) Find nearest large_airport from AIRPORTS catalogue within
      capture cone (DEST-RNG slider 100-1500nm) along ground
      track (+/- 60 deg heading match). Distance + ETA at GS.
   5) Required reserve (minutes):
        IFR-PART121  -> 45min hold @ FF + 5%-trip-contingency
                        + ~25min alternate (typical 200nm)
        IFR-PART91   -> 45min hold @ FF
        VFR-DAY      -> 30min @ FF
        VFR-NIGHT    -> 45min @ FF
      Rule selected per class default (HVY/NRW/RGN -> 121,
      BIZ -> 91-IFR, TBP/GA -> 91-VFR-Day, FTR -> 91-IFR)
      overridable via RULE slider 0..3.
   6) Fuel remaining = (blockHrs - hrsExp) * cruiseBurn (kg).
      Time remaining at current burn = remainKg / burnNow (min).
      Bingo fuel = required reserve + trip-fuel-to-destination.
      Margin minutes = endurance - eta - reserve.

   Tier classification:
     OK       margin > 30 min   emerald  (comfortable)
     TIGHT    margin > 10 min   sky      (monitor)
     MIN-FUEL margin > 0 min    amber    (declare MIN FUEL)
     BINGO    margin <= 0 min   rose     (Mayday Fuel)

   Mitigation advice per tier:
     OK       — none
     TIGHT    — request direct routing, monitor winds
     MIN-FUEL — declare "MIN FUEL" to ATC, no priority but no delay
     BINGO    — declare "MAYDAY FUEL", request priority handling,
                consider closer alternate, immediate divert

   MapLibre overlay:
     - Tier-coloured halo ring sized by |margin| (8-22px)
     - Dashed tier-coloured projection line aircraft -> destination
       (great-circle) with diamond marker, only TIGHT/MIN/BINGO
     - Tier-coloured labels callsign + remain-min + dest-IATA

   Side panel: 4-tier counter strip click-to-filter, 3-cell
   FLEET-MEAN-MARGIN / BINGO-COUNT / WORST-CALLSIGN summary,
   SVG margin-vs-ETA diagram (x = ETA minutes, y = margin
   minutes, with rose/amber/sky/emerald threshold horizontals,
   every aircraft plotted as tier-coloured dot), 5 sliders
   (MIN-FL, DEST-RNG, MISSION-MULT, ENDUR-MULT, RULE),
   7-class chip filter, HALO/PROJ/LBL/DIAG toggles, search,
   ranked list sorted tier-worst-first then margin asc.

   Registered under Layers > Safety & Traffic category.
   ft-reserve persisted preference.
   ============================================================ */

export interface ReserveFlight {
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
  flights: ReserveFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'OK' | 'TIGHT' | 'MIN-FUEL' | 'BINGO'
const TIER_COLOR: Record<Tier, string> = {
  OK: '#10b981',
  TIGHT: '#0ea5e9',
  'MIN-FUEL': '#f59e0b',
  BINGO: '#ef4444',
}
const TIER_ORDER: Tier[] = ['BINGO', 'MIN-FUEL', 'TIGHT', 'OK']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

type Rule = 'PART-121' | 'PART-91-IFR' | 'VFR-DAY' | 'VFR-NIGHT'
const RULE_LIST: Rule[] = ['PART-121', 'PART-91-IFR', 'VFR-DAY', 'VFR-NIGHT']
const RULE_MIN: Record<Rule, number> = {
  // base reserve minutes at cruise burn before alternate
  'PART-121': 45 + 25,    // 45 hold + ~25min alt
  'PART-91-IFR': 45,
  'VFR-DAY': 30,
  'VFR-NIGHT': 45,
}

interface ClassSpec {
  blockHr: number
  burnKgH: number
  cruiseFl: number
  rule: Rule
  cruiseGs: number  // typical cruise GS (kt)
}
const SPEC: Record<Klass, ClassSpec> = {
  heavy:     { blockHr: 14.0, burnKgH: 6500, cruiseFl: 370, rule: 'PART-121',    cruiseGs: 480 },
  narrow:    { blockHr: 6.0,  burnKgH: 2500, cruiseFl: 360, rule: 'PART-121',    cruiseGs: 450 },
  regional:  { blockHr: 3.5,  burnKgH: 1100, cruiseFl: 290, rule: 'PART-121',    cruiseGs: 380 },
  biz:       { blockHr: 8.0,  burnKgH: 1100, cruiseFl: 410, rule: 'PART-91-IFR', cruiseGs: 460 },
  turboprop: { blockHr: 4.0,  burnKgH: 480,  cruiseFl: 230, rule: 'VFR-DAY',     cruiseGs: 280 },
  ga:        { blockHr: 4.5,  burnKgH: 120,  cruiseFl: 100, rule: 'VFR-DAY',     cruiseGs: 130 },
  fighter:   { blockHr: 2.5,  burnKgH: 4500, cruiseFl: 380, rule: 'PART-91-IFR', cruiseGs: 520 },
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

function exposureHours(phase: 'CLIMB' | 'CRUISE' | 'DESCENT', altFt: number, cruiseFl: number): number {
  if (phase === 'CLIMB') {
    const f = Math.max(0, Math.min(1, altFt / (cruiseFl * 100)))
    return 0.1 + 0.6 * f
  }
  if (phase === 'CRUISE') return 3.0
  return 4.5
}

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b + 540) % 360) - 180)
  return d
}

interface Row {
  f: ReserveFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  rule: Rule
  phase: 'CLIMB' | 'CRUISE' | 'DESCENT'
  hrsExp: number
  remainHr: number       // hours of usable fuel left
  burnKgH: number        // current burn rate (phase-modified)
  remainKg: number
  remainMin: number      // total minutes of fuel at current burn
  destI: string          // IATA
  destIcao: string
  destName: string
  destLat: number
  destLng: number
  destNm: number
  etaMin: number
  reserveMin: number
  marginMin: number
  tier: Tier
}

const SRC_RING = 'reserve-ring', SRC_PROJ = 'reserve-proj', SRC_DOT = 'reserve-dot', SRC_LBL = 'reserve-lbl'
const LYR_RING = 'reserve-ring-l', LYR_PROJ = 'reserve-proj-l', LYR_DOT = 'reserve-dot-l', LYR_LBL = 'reserve-lbl-l'

// Pre-filter AIRPORTS to large airports with IATA (the dataset already has these).
const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

export default function ReserveFuel({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [destRng, setDestRng] = useState(800)        // nm capture
  const [missionMult, setMissionMult] = useState(100) // % of exposure hours
  const [endurMult, setEndurMult] = useState(100)    // % of class blockHr
  const [ruleIdx, setRuleIdx] = useState(0)          // 0=AUTO, 1..4 forced rule
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const mm = Math.max(0.5, missionMult / 100)
    const em = Math.max(0.5, endurMult / 100)
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classify(f.type, f.category)
      const spec = SPEC[klass]
      const rule: Rule = ruleIdx === 0 ? spec.rule : RULE_LIST[ruleIdx - 1]
      const gs = Math.max(60, f.velocityKts || spec.cruiseGs)
      const trk = f.track || 0
      const phase = phaseGuess(f.altitudeFt, f.vertRate || 0, spec.cruiseFl)
      const hrsExp = exposureHours(phase, f.altitudeFt, spec.cruiseFl) * mm
      const blockHr = spec.blockHr * em
      const remainHr = Math.max(0.05, blockHr - hrsExp)
      const burnMod = phase === 'CLIMB' ? 1.45 : phase === 'DESCENT' ? 0.55 : 1.0
      const burnKgH = spec.burnKgH * burnMod
      const remainKg = remainHr * spec.burnKgH  // expressed at cruise reference burn
      const remainMin = (remainKg / burnKgH) * 60
      // Find best destination: nearest IATA airport within DEST-RNG along track (+/- 60deg)
      let best: { i: string, icao: string, name: string, lat: number, lng: number, distNm: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > destRng) continue
        if (d > 6) {
          const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
          if (headingDelta(br, trk) > 60) continue
        }
        if (!best || d < best.distNm) best = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, distNm: d }
      }
      if (!best) continue
      const etaMin = (best.distNm / gs) * 60
      const reserveMin = RULE_MIN[rule]
      const marginMin = remainMin - etaMin - reserveMin
      let tier: Tier
      if (marginMin > 30) tier = 'OK'
      else if (marginMin > 10) tier = 'TIGHT'
      else if (marginMin > 0) tier = 'MIN-FUEL'
      else tier = 'BINGO'
      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk, rule, phase, hrsExp,
        remainHr, burnKgH, remainKg, remainMin,
        destI: best.i, destIcao: best.icao, destName: best.name,
        destLat: best.lat, destLng: best.lng, destNm: best.distNm,
        etaMin, reserveMin, marginMin, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.marginMin - b.marginMin
    })
    return out
  }, [flights, minFl, destRng, missionMult, endurMult, ruleIdx])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { OK: 0, TIGHT: 0, 'MIN-FUEL': 0, BINGO: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanMargin = 0, worstMargin = Infinity, worstCs = '', bingoCount = 0
    for (const r of rows) {
      meanMargin += r.marginMin
      if (r.marginMin < worstMargin) { worstMargin = r.marginMin; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'BINGO') bingoCount++
    }
    if (total > 0) meanMargin /= total
    if (!isFinite(worstMargin)) worstMargin = 0
    return { total, meanMargin, worstMargin, worstCs, bingoCount }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.destI, r.destIcao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, Math.abs(r.marginMin) / 4) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.destLng, r.destLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'OK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.destLng, r.destLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.marginMin >= 0 ? '+' : ''}${r.marginMin.toFixed(0)}min ›${r.destI}`,
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

  // Diagram: x = ETA min 0..360, y = margin min -60..+180.
  const diag = useMemo(() => {
    const W = 360, H = 160, PAD = 24
    const xMax = 360
    const yMin = -60, yMax = 180
    const xs = (m: number) => PAD + Math.max(0, Math.min(1, m / xMax)) * (W - PAD - 6)
    const ys = (m: number) => {
      const cc = Math.max(yMin, Math.min(yMax, m))
      return 6 + (1 - (cc - yMin) / (yMax - yMin)) * (H - PAD - 8)
    }
    return { W, H, PAD, xs, ys, xMax, yMin, yMax }
  }, [])

  const activeRule: Rule = ruleIdx === 0 ? 'PART-121' : RULE_LIST[ruleIdx - 1]
  const activeReserveMin = RULE_MIN[activeRule]

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Reserve Fuel</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMargin <= 0 ? '#ef4444' : summary.meanMargin <= 10 ? '#f59e0b' : summary.meanMargin <= 30 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanMargin >= 0 ? '+' : ''}{summary.meanMargin.toFixed(0)}<span className="text-[9px] text-slate-500"> min</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMargin >= 0 ? '+' : ''}${summary.worstMargin.toFixed(0)}m` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Bingo</div>
          <div className="font-mono text-sm" style={{ color: summary.bingoCount > 0 ? '#ef4444' : '#10b981' }}>{summary.bingoCount}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Margin · min vs ETA · rule {activeRule} ({activeReserveMin}min)</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y gridlines + tier threshold horizontals */}
            {[{v:0,c:'#ef4444',lbl:'bingo 0'},{v:10,c:'#f59e0b',lbl:'min 10'},{v:30,c:'#0ea5e9',lbl:'tight 30'}].map(({v,c,lbl}) => (
              <g key={v}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke={c} strokeWidth={1} strokeDasharray="4 2" opacity={0.55} />
                <text x={diag.W - 8} y={diag.ys(v) - 2} textAnchor="end" fontSize={8} fill={c} fontFamily="monospace">{lbl}</text>
              </g>
            ))}
            {[-60,0,60,120,180].map(v => (
              <g key={`g${v}`}>
                <line x1={diag.PAD} y1={diag.ys(v)} x2={diag.W - 6} y2={diag.ys(v)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(v) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{v >= 0 ? '+' : ''}{v}</text>
              </g>
            ))}
            {/* x gridlines */}
            {[60,120,180,240,300,360].map(m => (
              <g key={m}>
                <line x1={diag.xs(m)} y1={6} x2={diag.xs(m)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(m)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{m}m</text>
              </g>
            ))}
            {/* aircraft dots at (etaMin, marginMin) */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.etaMin)} cy={diag.ys(r.marginMin)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>DEST-RNG</span><span className="font-mono text-slate-300">{destRng}nm</span></div>
            <input type="range" min={100} max={1500} step={50} value={destRng} onChange={e => setDestRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MISSION</span><span className="font-mono text-slate-300">{missionMult}%</span></div>
            <input type="range" min={50} max={200} step={10} value={missionMult} onChange={e => setMissionMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ENDUR</span><span className="font-mono text-slate-300">{endurMult}%</span></div>
            <input type="range" min={70} max={130} step={5} value={endurMult} onChange={e => setEndurMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>RULE</span><span className="font-mono text-slate-300">{ruleIdx === 0 ? 'AUTO' : RULE_LIST[ruleIdx - 1]} ({activeReserveMin}m)</span></div>
            <input type="range" min={0} max={4} step={1} value={ruleIdx} onChange={e => setRuleIdx(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>margin · ETA · reserve · rule</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          // margin bar: -60..+180 -> 0..100%
          const mPct = Math.max(0, Math.min(100, ((r.marginMin + 60) / 240) * 100))
          const tick0 = ((0 + 60) / 240) * 100
          const tick10 = ((10 + 60) / 240) * 100
          const tick30 = ((30 + 60) / 240) * 100
          const advice = r.tier === 'OK' ? 'comfortable' : r.tier === 'TIGHT' ? 'request direct, watch winds' : r.tier === 'MIN-FUEL' ? 'declare MIN FUEL to ATC' : 'declare MAYDAY FUEL · divert'
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
                  <span title="destination">›{r.destI}</span>
                  <span title="distance">{r.destNm.toFixed(0)}nm</span>
                  <span title="ETA">{r.etaMin.toFixed(0)}min</span>
                  <span className="ml-auto" title="margin to bingo" style={{ color: TIER_COLOR[r.tier] }}>{r.marginMin >= 0 ? '+' : ''}{r.marginMin.toFixed(0)}min</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="margin (-60..+180min)">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${mPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${tick0}%` }} title="bingo (margin 0)" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${tick10}%` }} title="min fuel (10)" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${tick30}%` }} title="tight / ok (30)" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="endurance remaining">REM {r.remainMin.toFixed(0)}m</span>
                  <span title="reserve required">RES {r.reserveMin}m</span>
                  <span title="phase burn">FF {r.burnKgH.toFixed(0)}kg/h</span>
                  <span className="ml-auto" title="phase">{r.phase}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="rule">{r.rule}</span>
                  <span title="exposure">EXP {r.hrsExp.toFixed(1)}h</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'OK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" title="destination name">{r.destIcao} · {r.destName}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
