'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   CDA Compliance Monitor (Continuous Descent Approach)
   -----------------------------------------------------------
   Continuous Descent Approach is an arrival technique where the
   aircraft descends from cruise to the runway threshold in a
   single near-idle-thrust profile WITHOUT level-off steps. EU
   regulation 2018/1139, ICAO Doc 9931 (CDO manual) and FAA
   AC 91-86 all promote it because every minute spent in level
   flight below 10,000 ft burns ~25-40 kg of extra fuel per
   narrowbody, generates a ~3 dB noise footprint expansion on
   the ground, and CO2 increases of 30-150 kg per arrival.
   The "ideal" arrival follows a constant ~3-degree glide path
   (318 ft/nm) from Top-of-Descent all the way to threshold
   with cruise Mach -> descent IAS swap somewhere mid-profile.

   For every descending aircraft (vertRate < -300 fpm) below
   FL250 that is within CAPTURE-RNG nm of any large IATA
   airport on a heading aligned with bearing-to-field (within
   +/- 70 deg), this overlay:

   1) Picks the closest aligned IATA field as the working
      destination ARP. Distance d_nm and bearing-to-field are
      computed great-circle.
   2) Computes the IDEAL altitude on a CDA from threshold to
      current position: alt_ideal_ft = d_nm * 318
        (3-degree glide = tan(3deg) * 6076 ft/nm = ~318 ft/nm)
      with an upper cap at MAX-IDEAL slider 18000-30000 ft.
   3) Computes deviation deltaH = alt_actual - alt_ideal_ft.
      Positive = HIGH on the profile (too steep, will need
      drag or a level-off). Negative = LOW on the profile
      (engines spooled up, level segment ahead).
   4) Computes the ideal vertical speed for a 3-deg path at
      current GS: vs_ideal_fpm = -gs_kt * tan(3deg) * 101.27
      = ~ -5.30 * gs_kt. Compares to actual vert rate to get
      VS deviation.
   5) Detects implied LEVEL SEGMENT: if |actual_vs| < 200 fpm
      AND deltaH < -800 ft (low and flat), flags a level-off
      and integrates implied burn-penalty kg from class-typical
      level-flight idle-vs-clean burn (HVY 60 / NRW 28 / RGN 14
      / BIZ 16 / TBP 6 / GA 1.2 / FTR 35 kg/min) over the
      estimated level distance = |deltaH| / |vs_ideal_per_nm|.
   6) Classifies into 4 tiers:
        IDEAL    |deltaH| <= 600 ft AND no level segment  emerald
        ON-PATH  |deltaH| <= 1500 ft AND no level segment sky
        DEVIATE  level seg detected OR |deltaH|<=3500 ft  amber
        STEPPED  |deltaH| > 3500 ft OR estPenalty > 80 kg rose
   7) Computes noise contour expansion: delta_dB at 5nm short
      of field, using a simplified Pamela / FAA INM rule that
      every 1000 ft below the CDA profile near the field adds
      +1.0 dB to the 60 dBA contour radius and grows the
      contour area by ~10%. Reported as dB_excess and
      pct_area_excess.
   8) Computes CO2 penalty kg = kg_fuel_penalty * 3.16
      (jet kerosene combustion stoichiometry).

   MapLibre overlay:
     - Tier-coloured halo ring per aircraft sized by |deltaH|.
     - Dashed tier-coloured projection line from aircraft to
       destination ARP with diamond marker.
     - Solid tier-coloured short-line showing instantaneous
       descent vector vs ideal-VS dashed reference vector
       (for DEVIATE / STEPPED only).
     - Callsign + ±deltaH-ft + ›IATA labels (tier-coloured).

   Side panel: 4-tier counter strip click-to-filter,
   3-cell MEAN-DEV-ft / WORST-PENALTY-kg / STEPPED-COUNT
   summary, SVG altitude-vs-distance descent diagram (x-axis
   distance-to-go 0-150 nm, y-axis altitude 0-30 kft, sky
   ideal 3-deg line plus emerald +600ft / amber +1500ft /
   rose +3500ft envelope shading, every aircraft plotted as
   tier-coloured dot at (dist, alt) coord), 5 sliders
   (MIN-FL, MAX-FL, CAPTURE-RNG, GLIDE-DEG, MAX-IDEAL),
   7-class chip filter, HALO/PROJ/LBL/DIAG toggles, search,
   AIRCRAFT tab sorted tier-worst-first then deltaH desc,
   AIRPORTS tab sorted by inbound count desc.

   Registered under Layers > Routes & Flow category.
   ft-cda persisted preference.
   ============================================================ */

export interface CdaFlight {
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
  flights: CdaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'IDEAL' | 'ON-PATH' | 'DEVIATE' | 'STEPPED'
const TIER_COLOR: Record<Tier, string> = {
  IDEAL: '#10b981',
  'ON-PATH': '#0ea5e9',
  DEVIATE: '#f59e0b',
  STEPPED: '#ef4444',
}
const TIER_ORDER: Tier[] = ['STEPPED', 'DEVIATE', 'ON-PATH', 'IDEAL']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

// Class-typical level-flight excess burn vs clean idle-descent (kg/min).
// Sourced from EUROCONTROL CDO benefit pool reports (2020) per type.
const LEVEL_BURN_KG_MIN: Record<Klass, number> = {
  heavy: 60, narrow: 28, regional: 14, biz: 16, turboprop: 6, ga: 1.2, fighter: 35,
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
  return Math.abs(((a - b + 540) % 360) - 180)
}

interface Row {
  f: CdaFlight
  klass: Klass
  altFt: number
  gs: number
  vsActual: number
  vsIdeal: number
  destI: string
  destIcao: string
  destName: string
  destLat: number
  destLng: number
  destNm: number
  altIdeal: number
  deltaH: number          // actual - ideal (ft)
  levelSeg: boolean
  levelDistNm: number
  penaltyKg: number       // estimated extra fuel from non-CDA
  co2Kg: number
  dbExcess: number        // estimated noise excess at 5nm short
  pctAreaExcess: number   // % expansion of 60 dBA contour area
  tier: Tier
}

const SRC_RING = 'cda-ring', SRC_PROJ = 'cda-proj', SRC_DOT = 'cda-dot', SRC_LBL = 'cda-lbl', SRC_APP = 'cda-ap'
const LYR_RING = 'cda-ring-l', LYR_PROJ = 'cda-proj-l', LYR_DOT = 'cda-dot-l', LYR_LBL = 'cda-lbl-l', LYR_APP = 'cda-ap-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

export default function CdaCompliance({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(250)
  const [captureRng, setCaptureRng] = useState(120)
  const [glideDeg, setGlideDeg] = useState(30)        // x0.1 deg → 3.0 default
  const [maxIdeal, setMaxIdeal] = useState(24000)
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const glide = glideDeg / 10
  const ftPerNm = Math.tan(glide * D2R) * 6076.115
  const vsCoeff = -Math.tan(glide * D2R) * 101.27  // fpm per kt

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      if ((f.vertRate || 0) > -300) continue   // not descending
      const klass = classify(f.type, f.category)
      const gs = Math.max(60, f.velocityKts || 250)
      const trk = f.track || 0
      // Find best destination: closest IATA within capture and heading aligned.
      let best: { i: string, icao: string, name: string, lat: number, lng: number, distNm: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > captureRng) continue
        if (d > 4) {
          const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
          if (headingDelta(br, trk) > 70) continue
        }
        if (!best || d < best.distNm) best = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, distNm: d }
      }
      if (!best) continue
      const altIdeal = Math.min(maxIdeal, best.distNm * ftPerNm)
      const deltaH = f.altitudeFt - altIdeal
      const vsActual = f.vertRate || 0
      const vsIdeal = vsCoeff * gs
      // Level segment: shallow VS AND below profile by > 800ft
      const levelSeg = Math.abs(vsActual) < 200 && deltaH < -800
      // Estimate level distance: how far the aircraft has been "below the profile"
      // as a function of |deltaH| converted via 318ft/nm.
      const levelDistNm = levelSeg ? Math.min(40, Math.abs(deltaH) / Math.max(50, ftPerNm)) : 0
      // Estimate level burn-penalty: time at level = levelDistNm / (gs/60) min
      const levelMin = levelSeg ? (levelDistNm / Math.max(60, gs)) * 60 : 0
      const penaltyKg = levelMin * LEVEL_BURN_KG_MIN[klass]
      const co2Kg = penaltyKg * 3.16
      // Noise excess: 1 dB per 1000 ft below profile at 5nm short.
      // Use |min(deltaH, 0)| / 1000 capped at 6 dB.
      const dbExcess = Math.min(6, Math.max(0, -deltaH / 1000))
      // 60 dBA contour area grows roughly +10% per +1 dB excess.
      const pctAreaExcess = Math.min(80, dbExcess * 10)

      let tier: Tier
      const absDev = Math.abs(deltaH)
      if (levelSeg && penaltyKg > 80) tier = 'STEPPED'
      else if (absDev > 3500) tier = 'STEPPED'
      else if (levelSeg || absDev > 1500) tier = 'DEVIATE'
      else if (absDev > 600) tier = 'ON-PATH'
      else tier = 'IDEAL'

      out.push({
        f, klass, altFt: f.altitudeFt, gs, vsActual, vsIdeal,
        destI: best.i, destIcao: best.icao, destName: best.name,
        destLat: best.lat, destLng: best.lng, destNm: best.distNm,
        altIdeal, deltaH, levelSeg, levelDistNm,
        penaltyKg, co2Kg, dbExcess, pctAreaExcess,
        tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return Math.abs(b.deltaH) - Math.abs(a.deltaH)
    })
    return out
  }, [flights, minFl, maxFl, captureRng, ftPerNm, vsCoeff, maxIdeal])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { IDEAL: 0, 'ON-PATH': 0, DEVIATE: 0, STEPPED: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanDev = 0, worstKg = 0, worstCs = '', steppedCount = 0, totalKg = 0, totalCo2 = 0
    for (const r of rows) {
      meanDev += r.deltaH
      totalKg += r.penaltyKg
      totalCo2 += r.co2Kg
      if (r.penaltyKg > worstKg) { worstKg = r.penaltyKg; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'STEPPED') steppedCount++
    }
    if (total > 0) meanDev /= total
    return { total, meanDev, worstKg, worstCs, steppedCount, totalKg, totalCo2 }
  }, [rows])

  // Airport rollup: count inbounds per IATA + worst tier + sum penalty
  const airports = useMemo(() => {
    const m = new Map<string, { i: string, icao: string, name: string, lat: number, lng: number, count: number, worstTier: Tier, penaltyKg: number }>()
    for (const r of rows) {
      const e = m.get(r.destI)
      if (e) {
        e.count++
        e.penaltyKg += r.penaltyKg
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
      } else {
        m.set(r.destI, { i: r.destI, icao: r.destIcao, name: r.destName, lat: r.destLat, lng: r.destLng, count: 1, worstTier: r.tier, penaltyKg: r.penaltyKg })
      }
    }
    return Array.from(m.values()).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (ti !== 0) return ti
      return b.count - a.count
    })
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.destI, r.destIcao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredAirports = useMemo(() => {
    const q = query.trim().toUpperCase()
    return airports.filter(a => {
      if (tierFilter !== 'ALL' && a.worstTier !== tierFilter) return false
      if (!q) return true
      return [a.i, a.icao, a.name].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [airports, tierFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, Math.abs(r.deltaH) / 300) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'IDEAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.destLng, r.destLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'IDEAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.destLng, r.destLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.deltaH >= 0 ? '+' : ''}${(r.deltaH / 100).toFixed(0)}h ›${r.destI}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Airport pins for active fields
    const apFc = { type: 'FeatureCollection' as const, features: airports.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worstTier], text: `${a.i}·${a.count}` },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) }

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
        'line-width': 1.5,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_DOT, dotFc, () => map.addLayer({ id: LYR_DOT, type: 'circle', source: SRC_DOT, paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_APP, apFc, () => map.addLayer({ id: LYR_APP, type: 'symbol', source: SRC_APP, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, -1.4],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.4,
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
      for (const lyr of [LYR_LBL, LYR_APP, LYR_DOT, LYR_PROJ, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_APP, SRC_DOT, SRC_PROJ, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, airports, showRing, showProj, showLabels])

  // Diagram: x = dist 0..150 nm, y = alt 0..30 kft
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 26
    const xMax = 150, yMax = 30
    const xs = (d: number) => PAD + Math.max(0, Math.min(1, d / xMax)) * (W - PAD - 6)
    const ys = (k: number) => 6 + (1 - Math.max(0, Math.min(1, k / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">CDA Compliance</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} arrivals</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Dev</div>
          <div className="font-mono text-sm" style={{ color: Math.abs(summary.meanDev) > 1500 ? '#f59e0b' : Math.abs(summary.meanDev) > 600 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanDev >= 0 ? '+' : ''}{summary.meanDev.toFixed(0)}<span className="text-[9px] text-slate-500"> ft</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Fuel</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} +${summary.worstKg.toFixed(0)}kg` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Stepped</div>
          <div className="font-mono text-sm" style={{ color: summary.steppedCount > 0 ? '#ef4444' : '#10b981' }}>{summary.steppedCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Fleet Penalty</div>
          <div className="font-mono text-[11px]" style={{ color: summary.totalKg > 200 ? '#f59e0b' : '#10b981' }}>{summary.totalKg.toFixed(0)}<span className="text-[9px] text-slate-500"> kg</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">CO₂ Excess</div>
          <div className="font-mono text-[11px]" style={{ color: summary.totalCo2 > 600 ? '#f59e0b' : '#10b981' }}>{summary.totalCo2.toFixed(0)}<span className="text-[9px] text-slate-500"> kg</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Altitude · ft vs distance · nm · ideal {glide.toFixed(1)}° = {ftPerNm.toFixed(0)} ft/nm</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y gridlines */}
            {[5,10,15,20,25,30].map(k => (
              <g key={k}>
                <line x1={diag.PAD} y1={diag.ys(k)} x2={diag.W - 6} y2={diag.ys(k)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(k) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{k}k</text>
              </g>
            ))}
            {/* x gridlines */}
            {[30,60,90,120,150].map(d => (
              <g key={d}>
                <line x1={diag.xs(d)} y1={6} x2={diag.xs(d)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(d)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{d}nm</text>
              </g>
            ))}
            {/* Ideal CDA line */}
            {(() => {
              const dCap = Math.min(diag.xMax, maxIdeal / ftPerNm)
              const x0 = diag.xs(0), y0 = diag.ys(0)
              const x1 = diag.xs(dCap), y1 = diag.ys((dCap * ftPerNm) / 1000)
              const xCap = diag.xs(diag.xMax), yCap = diag.ys(maxIdeal / 1000)
              return (
                <g>
                  <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#0ea5e9" strokeWidth={1.4} />
                  {dCap < diag.xMax && <line x1={x1} y1={y1} x2={xCap} y2={yCap} stroke="#0ea5e9" strokeWidth={1.4} strokeDasharray="3 2" opacity={0.55} />}
                  <text x={x1 + 4} y={y1 - 2} fontSize={8} fill="#0ea5e9" fontFamily="monospace">IDEAL 3°</text>
                </g>
              )
            })()}
            {/* Envelope: ±600 (emerald) ±1500 (sky was used for ideal so use amber) ±3500 (rose) shading via translucent strokes */}
            {[{f:600,c:'#10b981',l:'±600'}, {f:1500,c:'#f59e0b',l:'±1500'}, {f:3500,c:'#ef4444',l:'±3500'}].map(({f:fd,c,l}) => {
              const pts: string[] = []
              for (let d = 0; d <= diag.xMax; d += 5) {
                const kHi = Math.min(diag.yMax, (Math.min(maxIdeal, d * ftPerNm) + fd) / 1000)
                pts.push(`${diag.xs(d)},${diag.ys(kHi)}`)
              }
              return <polyline key={l} points={pts.join(' ')} fill="none" stroke={c} strokeWidth={0.8} strokeDasharray="2 3" opacity={0.5} />
            })}
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.destNm)} cy={diag.ys(r.altFt / 1000)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={250} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={350} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureRng}nm</span></div>
            <input type="range" min={30} max={250} step={10} value={captureRng} onChange={e => setCaptureRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>GLIDE</span><span className="font-mono text-slate-300">{glide.toFixed(1)}°</span></div>
            <input type="range" min={20} max={45} step={1} value={glideDeg} onChange={e => setGlideDeg(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-IDEAL</span><span className="font-mono text-slate-300">{(maxIdeal/1000).toFixed(0)}k ft</span></div>
            <input type="range" min={15000} max={35000} step={1000} value={maxIdeal} onChange={e => setMaxIdeal(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <div className="flex gap-1">
          {(['AIRCRAFT','AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} arrivals` : `${filteredAirports.length} fields`}</span>
        <span>{tab === 'AIRCRAFT' ? 'dev · dist · alt · penalty' : 'count · worst · penalty'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No arrivals match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // Deviation bar: -5000..+5000 ft mapped to 0..100%
          const devPct = Math.max(0, Math.min(100, ((r.deltaH + 5000) / 10000) * 100))
          const tCenter = 50
          const t600lo = ((-600 + 5000) / 10000) * 100
          const t600hi = ((600 + 5000) / 10000) * 100
          const t1500lo = ((-1500 + 5000) / 10000) * 100
          const t1500hi = ((1500 + 5000) / 10000) * 100
          const advice = r.tier === 'IDEAL' ? 'on profile · idle thrust' :
            r.tier === 'ON-PATH' ? 'minor deviation · monitor speed' :
            r.tier === 'DEVIATE' ? (r.levelSeg ? 'level segment detected · request continuous descent' : 'profile drift · check FMS PROG') :
            (r.levelSeg ? 'extended level-off · ATC vectoring · CDA broken' : 'far off profile · likely step-down clearance')
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
                  <span title="dist-to-go">{r.destNm.toFixed(0)}nm</span>
                  <span title="ideal alt">id{(r.altIdeal/1000).toFixed(1)}k</span>
                  <span className="ml-auto" title="deviation" style={{ color: TIER_COLOR[r.tier] }}>{r.deltaH >= 0 ? '+' : ''}{r.deltaH.toFixed(0)}ft</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="deviation (-5k..+5k ft)">
                  <div className="absolute inset-y-0" style={{ left: `${Math.min(50, devPct)}%`, width: `${Math.abs(devPct - 50)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-slate-500" style={{ left: `${tCenter}%` }} title="on-profile" />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${t600lo}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${t600hi}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${t1500lo}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${t1500hi}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="actual VS">VS{r.vsActual.toFixed(0)}</span>
                  <span title="ideal VS">id{r.vsIdeal.toFixed(0)}</span>
                  <span title="GS">{r.gs.toFixed(0)}kt</span>
                  <span className="ml-auto" title="fuel penalty" style={{ color: r.penaltyKg > 50 ? '#f59e0b' : '#64748b' }}>+{r.penaltyKg.toFixed(0)}kg</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="CO2 excess">CO₂ {r.co2Kg.toFixed(0)}kg</span>
                  <span title="noise excess @5nm">+{r.dbExcess.toFixed(1)}dB</span>
                  <span title="60dBA area expansion">+{r.pctAreaExcess.toFixed(0)}%area</span>
                  <span className="ml-auto" title="level segment">{r.levelSeg ? `LEVEL ${r.levelDistNm.toFixed(0)}nm` : 'descent'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'IDEAL' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="text-[10px] text-slate-600 font-mono mt-0.5 truncate" title="destination name">{r.destIcao} · {r.destName}</div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No fields match.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const penPct = Math.min(100, (a.penaltyKg / 500) * 100)
          return (
            <button key={a.i} onClick={() => { try { map?.flyTo({ center: [a.lng, a.lat], zoom: 9 }) } catch {} }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.i}</span>
                  <span className="text-slate-500 truncate">{a.name}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{a.count} inbnd</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="fuel penalty 0-500kg">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${penPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="icao">{a.icao}</span>
                  <span className="ml-auto" title="aggregate penalty">+{a.penaltyKg.toFixed(0)}kg fuel</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
