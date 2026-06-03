'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Brake Energy & Tire-Speed Landing Limit Monitor
   -----------------------------------------------------------
   For every aircraft on approach to an inferred destination
   airport, this overlay predicts the LANDING energy state of
   the braking system using ICAO / FAA AC 25-32 / EASA CS-25
   Subpart B brake-energy methodology and the per-tire speed
   limit (typically Vref + tailwind component ≤ tire LSR rating
   - 195 / 204 / 225 kt for common bias-ply / radial mains).

   Per arrival aircraft (vertRate < -200 fpm, FL <= MAX-FL,
   within CAPTURE nm of an aligned IATA destination ahead on
   ground track within +/- 70 deg):

   1) Pick closest aligned IATA destination (great-circle).
   2) Infer landing MASS from class typical land-weight (per
      Airbus / Boeing AOM landing-weight tables):
        HVY (B77x/A35x/B78x) 200000 kg
        NRW (A32x/B73x)       65000 kg
        RGN (E190/CRJ/ATR)    24000 kg
        BIZ (G650/GLEX)       30000 kg
        TBP                    5500 kg
        GA                     1500 kg
        FTR                   12000 kg
      Scaled by MASS-MULT slider 60-130 pct for heavy /
      light arrival assumption.
   3) Compute Vref proxy = class typical Vref:
        HVY 145 / NRW 138 / RGN 120 / BIZ 125 / TBP 95 /
        GA 65 / FTR 150 kt. Plus tailwind component from
        TAILWND slider -15..+25 kt (positive = tail).
        Vapp = Vref + tailwind.
   4) Compute touchdown GROUND speed Vtd_mps =
        max(40, Vapp - HEADWIND-approx)*0.5144 (1kt=0.5144m/s)
   5) Compute kinetic energy at touchdown:
        KE = 0.5 * m * Vtd^2  (Joules)
      Per-brake energy assuming class-typical brake count:
        HVY 8 brakes / NRW 4 / RGN 4 / BIZ 4 / TBP 2 / GA 2 /
        FTR 4. Per-brake KE = KE / nBrakes (MJ).
   6) Compare per-brake energy to class brake-rating thresholds
      from AC 25-32 / brake-mfr cert envelopes:
        HVY  NORMAL <50 MJ / HOT 50-75 / FUSE-PLUG 75-115 /
             RTO-CERT 115-160 / OVER-LIMIT >160
        NRW  NORMAL <25 / HOT 25-45 / FUSE 45-72 / RTO 72-95
        RGN  NORMAL <15 / HOT 15-25 / FUSE 25-38 / RTO 38-52
        BIZ  NORMAL <14 / HOT 14-22 / FUSE 22-32 / RTO 32-45
        TBP  NORMAL <6  / HOT 6-10  / FUSE 10-15 / RTO 15-22
        GA   NORMAL <3  / HOT 3-5   / FUSE 5-8   / RTO 8-12
        FTR  NORMAL <30 / HOT 30-50 / FUSE 50-75 / RTO 75-110
   7) Tire-speed check: tire LSR rating by class (HVY/NRW 225,
      RGN/BIZ 210, TBP 195, GA 160, FTR 250 kt). Margin =
      LSR - Vapp. If margin < 0 -> tire BUST risk.
   8) Brake temp delta prediction: ΔT_K ≈ KE_per_brake_MJ *
      class K-coef (HVY 1.6 / NRW 2.1 / RGN 2.6 / BIZ 2.8 /
      TBP 3.4 / GA 4.0 / FTR 1.4) deg-C per MJ, plus ambient
      35°C baseline. Predicted brake temp Tb_C = 35 + ΔT.
      Above 300°C triggers fuse-plug melt warning per AMM.
   9) Turnaround penalty: if Tb > 250°C, required cool-down
      minutes = (Tb - 250) * 0.6 min/C (rough Boeing brake
      cool chart proxy) capped 90 min.
   10) Classify 5 tiers:
        NORMAL   below HOT thresh AND tire margin > 15 emerald
        HOT      in HOT band                       sky
        FUSE     in FUSE band OR tire margin <10   amber
        RTO      in RTO band OR tire margin <0     rose
        OVER     above RTO max                     rose-deep

   MapLibre overlay:
     - Halo ring per aircraft sized by KE/MAX-RTO ratio (8-22px).
     - Dashed tier-coloured projection line to destination ARP.
     - Tier-coloured airport pin with IATA · count.
     - Callsign + KE-MJ + tier labels for non-NORMAL.

   Side panel:
     - 5-tier counter strip click-to-filter.
     - 3-cell MEAN-KE / WORST callsign+MJ / OVER-COUNT summary.
     - 2-cell TIRE-BUST / FUSE-PLUG counts.
     - SVG KE-vs-Vapp scatter (x=Vapp 0-180 kt, y=KE-per-brake
       0-200 MJ, sky HOT / amber FUSE / rose RTO / rose-deep
       OVER bands shaded with dashed thresholds, every aircraft
       plotted as tier-coloured dot).
     - 5 sliders: MIN-FL/MAX-FL/CAPTURE/MASS-MULT/TAILWND.
     - 7-class chip filter, HALO/PROJ/PIN/LBL/DIAG toggles,
       search, AIRCRAFT/AIRPORTS tabs.
     - AIRCRAFT rows: callsign+type+class+tier · FL/IATA/Vapp/
       KE-per-brake bar · brake-temp / cool-min / tire-margin /
       advice / ICAO+name footer.
     - AIRPORTS rows: count, worst-tier, mean-temp footer.

   Registered under Layers > Safety & Traffic category.
   ft-brake persisted preference.
   ============================================================ */

export interface BrakeFlight {
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
  flights: BrakeFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'NORMAL' | 'HOT' | 'FUSE' | 'RTO' | 'OVER'
const TIER_COLOR: Record<Tier, string> = {
  NORMAL: '#10b981',
  HOT: '#0ea5e9',
  FUSE: '#f59e0b',
  RTO: '#ef4444',
  OVER: '#dc2626',
}
const TIER_ORDER: Tier[] = ['OVER', 'RTO', 'FUSE', 'HOT', 'NORMAL']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

const MASS_KG: Record<Klass, number> = { heavy: 200000, narrow: 65000, regional: 24000, biz: 30000, turboprop: 5500, ga: 1500, fighter: 12000 }
const VREF_KT: Record<Klass, number> = { heavy: 145, narrow: 138, regional: 120, biz: 125, turboprop: 95, ga: 65, fighter: 150 }
const N_BRAKES: Record<Klass, number> = { heavy: 8, narrow: 4, regional: 4, biz: 4, turboprop: 2, ga: 2, fighter: 4 }
const TIRE_LSR_KT: Record<Klass, number> = { heavy: 225, narrow: 225, regional: 210, biz: 210, turboprop: 195, ga: 160, fighter: 250 }
const T_COEF_C_PER_MJ: Record<Klass, number> = { heavy: 1.6, narrow: 2.1, regional: 2.6, biz: 2.8, turboprop: 3.4, ga: 4.0, fighter: 1.4 }
// Per-brake thresholds in MJ: [hotLo, fuseLo, rtoLo, overLo]
const THRESH: Record<Klass, [number, number, number, number]> = {
  heavy:    [50, 75, 115, 160],
  narrow:   [25, 45, 72, 95],
  regional: [15, 25, 38, 52],
  biz:      [14, 22, 32, 45],
  turboprop:[6, 10, 15, 22],
  ga:       [3, 5, 8, 12],
  fighter:  [30, 50, 75, 110],
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
  f: BrakeFlight
  klass: Klass
  flCur: number
  destI: string; destIcao: string; destName: string
  destLat: number; destLng: number; destNm: number
  massKg: number
  vref: number
  vapp: number
  vtdMps: number
  keTotalMJ: number
  kePerBrakeMJ: number
  tireMargin: number   // LSR - Vapp (kt). Negative = bust.
  brakeTempC: number
  coolMin: number
  fusePlug: boolean
  tier: Tier
  thresh: [number, number, number, number]
  nBrakes: number
}

const SRC_RING = 'brk-ring', SRC_PROJ = 'brk-proj', SRC_DOT = 'brk-dot', SRC_LBL = 'brk-lbl', SRC_APP = 'brk-ap'
const LYR_RING = 'brk-ring-l', LYR_PROJ = 'brk-proj-l', LYR_DOT = 'brk-dot-l', LYR_LBL = 'brk-lbl-l', LYR_APP = 'brk-ap-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

export default function BrakeEnergy({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(250)
  const [captureRng, setCaptureRng] = useState(140)
  const [massMult, setMassMult] = useState(100)   // %
  const [tailwnd, setTailwnd] = useState(5)       // kt
  const [showRing, setShowRing] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      if ((f.vertRate || 0) > -200) continue
      const klass = classify(f.type, f.category)
      const trk = f.track || 0
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
      const massKg = MASS_KG[klass] * (massMult / 100)
      const vref = VREF_KT[klass]
      const vapp = vref + tailwnd
      // Touchdown ground speed ≈ Vapp - small headwind margin (use 8 kt nominal headwind component already in Vref)
      const vtdMps = Math.max(40, vapp - 5) * 0.5144
      const keJ = 0.5 * massKg * vtdMps * vtdMps
      const keMJ = keJ / 1e6
      const nBrakes = N_BRAKES[klass]
      const kePerBrakeMJ = keMJ / nBrakes
      const tireMargin = TIRE_LSR_KT[klass] - vapp
      const dT = kePerBrakeMJ * T_COEF_C_PER_MJ[klass]
      const brakeTempC = 35 + dT
      const coolMin = brakeTempC > 250 ? Math.min(90, (brakeTempC - 250) * 0.6) : 0
      const fusePlug = brakeTempC > 300
      const th = THRESH[klass]
      let tier: Tier
      if (kePerBrakeMJ >= th[3] || tireMargin < -5) tier = 'OVER'
      else if (kePerBrakeMJ >= th[2] || tireMargin < 0) tier = 'RTO'
      else if (kePerBrakeMJ >= th[1] || tireMargin < 10) tier = 'FUSE'
      else if (kePerBrakeMJ >= th[0] || tireMargin < 15) tier = 'HOT'
      else tier = 'NORMAL'

      out.push({
        f, klass, flCur,
        destI: best.i, destIcao: best.icao, destName: best.name,
        destLat: best.lat, destLng: best.lng, destNm: best.distNm,
        massKg, vref, vapp, vtdMps, keTotalMJ: keMJ, kePerBrakeMJ,
        tireMargin, brakeTempC, coolMin, fusePlug, tier,
        thresh: th, nBrakes,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.kePerBrakeMJ - a.kePerBrakeMJ
    })
    return out
  }, [flights, minFl, maxFl, captureRng, massMult, tailwnd])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { NORMAL: 0, HOT: 0, FUSE: 0, RTO: 0, OVER: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanKE = 0, worstMJ = 0, worstCs = '', overCount = 0, tireBust = 0, fuseCount = 0, sumTemp = 0
    for (const r of rows) {
      meanKE += r.kePerBrakeMJ
      sumTemp += r.brakeTempC
      if (r.kePerBrakeMJ > worstMJ) { worstMJ = r.kePerBrakeMJ; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'OVER') overCount++
      if (r.tireMargin < 0) tireBust++
      if (r.fusePlug) fuseCount++
    }
    if (rows.length) { meanKE /= rows.length; sumTemp /= rows.length }
    return { meanKE, worstMJ, worstCs, overCount, tireBust, fuseCount, meanTemp: sumTemp, total: rows.length }
  }, [rows])

  const airports = useMemo(() => {
    const m = new Map<string, { i: string, icao: string, name: string, lat: number, lng: number, count: number, worstTier: Tier, sumTemp: number, worstMJ: number, worstCs: string }>()
    for (const r of rows) {
      const e = m.get(r.destI)
      if (e) {
        e.count++
        e.sumTemp += r.brakeTempC
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
        if (r.kePerBrakeMJ > e.worstMJ) { e.worstMJ = r.kePerBrakeMJ; e.worstCs = (r.f.callsign || r.f.icao).trim() }
      } else {
        m.set(r.destI, { i: r.destI, icao: r.destIcao, name: r.destName, lat: r.destLat, lng: r.destLng, count: 1, worstTier: r.tier, sumTemp: r.brakeTempC, worstMJ: r.kePerBrakeMJ, worstCs: (r.f.callsign || r.f.icao).trim() })
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
    const refMaxMJ = 200
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, (r.kePerBrakeMJ / refMaxMJ) * 14) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'NORMAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.destLng, r.destLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'NORMAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.destLng, r.destLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'NORMAL').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.kePerBrakeMJ.toFixed(0)}MJ ${r.tier}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const apFc = { type: 'FeatureCollection' as const, features: showPin ? airports.map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worstTier], text: `›${a.i}·${a.count}` },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
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
  }, [map, rows, airports, showRing, showProj, showPin, showLabels])

  // Scatter diagram: KE-per-brake (y, 0-200 MJ) vs Vapp (x, 0-200 kt)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 26
    const xMax = 200, yMax = 200
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, v / xMax)) * (W - PAD - 6)
    const ys = (k: number) => 6 + (1 - Math.max(0, Math.min(1, k / yMax))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMax, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Brake Energy</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} arrivals</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean KE</div>
          <div className="font-mono text-sm" style={{ color: summary.meanKE > 60 ? '#f59e0b' : summary.meanKE > 30 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanKE.toFixed(0)}<span className="text-[9px] text-slate-500"> MJ</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Brake</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstMJ.toFixed(0)}MJ` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Over-Limit</div>
          <div className="font-mono text-sm" style={{ color: summary.overCount > 0 ? '#dc2626' : '#10b981' }}>{summary.overCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Tire Bust</div>
          <div className="font-mono text-[11px]" style={{ color: summary.tireBust > 0 ? '#ef4444' : '#10b981' }}>{summary.tireBust}<span className="text-[9px] text-slate-500"> ac</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Fuse-Plug Risk</div>
          <div className="font-mono text-[11px]" style={{ color: summary.fuseCount > 0 ? '#f59e0b' : '#10b981' }}>{summary.fuseCount}<span className="text-[9px] text-slate-500"> ac</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">KE-per-brake · MJ vs Vapp · kt · tail {tailwnd >= 0 ? '+' : ''}{tailwnd}kt</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* y gridlines */}
            {[40, 80, 120, 160, 200].map(k => (
              <g key={k}>
                <line x1={diag.PAD} y1={diag.ys(k)} x2={diag.W - 6} y2={diag.ys(k)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(k) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{k}</text>
              </g>
            ))}
            {/* x gridlines */}
            {[50, 100, 150, 200].map(d => (
              <g key={d}>
                <line x1={diag.xs(d)} y1={6} x2={diag.xs(d)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(d)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{d}kt</text>
              </g>
            ))}
            {/* Tier threshold bands (use HVY scale for reference shading) */}
            {[
              { lo: 0, hi: 25, c: '#10b981', label: '' },
              { lo: 25, hi: 50, c: '#0ea5e9', label: 'HOT' },
              { lo: 50, hi: 80, c: '#f59e0b', label: 'FUSE' },
              { lo: 80, hi: 120, c: '#ef4444', label: 'RTO' },
              { lo: 120, hi: 200, c: '#dc2626', label: 'OVER' },
            ].map((b, i) => (
              <g key={i}>
                <rect x={diag.PAD} y={diag.ys(b.hi)} width={diag.W - diag.PAD - 6} height={Math.max(0, diag.ys(b.lo) - diag.ys(b.hi))} fill={b.c} opacity={0.05} />
                {b.label && <text x={diag.W - 8} y={diag.ys((b.lo + b.hi) / 2) + 3} textAnchor="end" fontSize={8} fill={b.c} fontFamily="monospace" opacity={0.85}>{b.label}</text>}
              </g>
            ))}
            {[25, 50, 80, 120].map(t => (
              <line key={t} x1={diag.PAD} y1={diag.ys(t)} x2={diag.W - 6} y2={diag.ys(t)} stroke={t === 25 ? '#0ea5e9' : t === 50 ? '#f59e0b' : t === 80 ? '#ef4444' : '#dc2626'} strokeWidth={0.8} strokeDasharray="3 2" opacity={0.65} />
            ))}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.vapp)} cy={diag.ys(r.kePerBrakeMJ)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>MASS-MULT</span><span className="font-mono text-slate-300">{massMult}%</span></div>
            <input type="range" min={60} max={130} step={5} value={massMult} onChange={e => setMassMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>TAILWND</span><span className="font-mono text-slate-300">{tailwnd >= 0 ? '+' : ''}{tailwnd}kt</span></div>
            <input type="range" min={-15} max={25} step={1} value={tailwnd} onChange={e => setTailwnd(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
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
        <span>{tab === 'AIRCRAFT' ? 'KE · Vapp · Tb · tier' : 'count · worst · meanTb'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No arrivals match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          const refMax = r.thresh[3] * 1.5
          const kePct = Math.min(100, (r.kePerBrakeMJ / refMax) * 100)
          const hotPct = (r.thresh[0] / refMax) * 100
          const fusePct = (r.thresh[1] / refMax) * 100
          const rtoPct = (r.thresh[2] / refMax) * 100
          const overPct = (r.thresh[3] / refMax) * 100
          const advice = r.tier === 'OVER' ? 'over brake-energy limit · DIVERT or accept brake fire risk' :
            r.tier === 'RTO' ? 'RTO-certified band · fuse-plug likely · vacate then 60min cool' :
            r.tier === 'FUSE' ? 'fuse-plug temp band · plan max cool · check tire pressure' :
            r.tier === 'HOT' ? 'elevated brake temp · standard cool ok' :
            'within normal brake-energy envelope'
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
                  <span title="flight level">F{Math.round(r.flCur)}</span>
                  <span title="destination">›{r.destI}</span>
                  <span title="dist-to-go">{r.destNm.toFixed(0)}nm</span>
                  <span title="Vapp">Vapp {r.vapp.toFixed(0)}kt</span>
                  <span className="ml-auto" title="KE per brake" style={{ color: TIER_COLOR[r.tier] }}>{r.kePerBrakeMJ.toFixed(1)}MJ/brk</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="KE per brake vs class thresholds">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${kePct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${hotPct}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${fusePct}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${rtoPct}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-red-600" style={{ left: `${overPct}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="brake temp predicted" style={{ color: r.brakeTempC > 300 ? '#ef4444' : r.brakeTempC > 250 ? '#f59e0b' : '#94a3b8' }}>Tb {r.brakeTempC.toFixed(0)}°C</span>
                  <span title="cool time" style={{ color: r.coolMin > 30 ? '#f59e0b' : '#64748b' }}>{r.coolMin > 0 ? `${r.coolMin.toFixed(0)}min cool` : 'no cool'}</span>
                  <span title="tire margin LSR-Vapp" style={{ color: r.tireMargin < 0 ? '#ef4444' : r.tireMargin < 10 ? '#f59e0b' : '#64748b' }}>tire {r.tireMargin >= 0 ? '+' : ''}{r.tireMargin.toFixed(0)}kt</span>
                  <span className="ml-auto" title="brakes">{r.nBrakes}×brk</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="mass">{(r.massKg / 1000).toFixed(0)}t</span>
                  <span title="Vref">Vref {r.vref}</span>
                  <span title="total KE">KE {r.keTotalMJ.toFixed(0)}MJ</span>
                  <span className="ml-auto" title="fuse plug">{r.fusePlug ? 'FUSE-MELT' : 'no melt'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'NORMAL' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
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
          const meanTemp = a.sumTemp / Math.max(1, a.count)
          const tempPct = Math.min(100, (meanTemp / 400) * 100)
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
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean predicted brake temp 0-400°C">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${tempPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(250/400)*100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(300/400)*100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="icao">{a.icao}</span>
                  <span title="mean brake temp">Tb {meanTemp.toFixed(0)}°C</span>
                  <span title="worst aircraft" className="ml-auto truncate">{a.worstCs} {a.worstMJ.toFixed(0)}MJ</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
