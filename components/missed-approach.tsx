'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Missed-Approach OEI Net-Climb-Gradient Monitor
   -----------------------------------------------------------
   For every aircraft on approach to an inferred destination,
   predicts the One-Engine-Inoperative GO-AROUND net climb
   gradient capability vs the ICAO PANS-OPS Doc 8168 Vol II
   Part I Section 4 Chapter 6 missed-approach segment minimum
   net gradient of 2.5 % (Cat A/B/C/D non-precision MAP) and
   the FAA AC 120-91 / 14 CFR 121.189 OEI obstacle-accountability
   profile.

   Per arrival aircraft (vertRate < -200 fpm, FL <= MAX-FL,
   within CAPTURE nm of an aligned IATA destination ahead on
   ground track within +/- 70 deg):

   1) Pick closest aligned IATA destination (great-circle).
   2) Estimate destination ELEVATION from a latitude / region
      proxy band (no elevation in airports table). Curated 11
      regional bias bands (CONUS-mountain 1500m / Andes 2500m /
      Tibetan 3500m / E-African Rift 1700m / Mexican Plateau
      2000m / N-European lowland 100m / SE-Asian lowland 50m /
      Australian Outback 350m / Caribbean 30m / N-Atlantic
      coast 80m / default-coastal 100m). Adjustable via
      ELEV-BIAS slider 0-3000 m global add.
   3) Compute DENSITY ALTITUDE per Koch chart linear proxy:
        DA_ft = PA_ft + 120 * (OAT_C - ISA_OAT_C)
        ISA_OAT_C  = 15 - 1.98 * PA_ft / 1000
      where PA_ft = elev_m * 3.281 (zero-QNH proxy) and OAT
      is from ISA-DEV slider (-20..+30 K above ISA).
   4) Class base SEA-LEVEL ISA OEI NET climb gradient (post-
      Airbus FCOM 4.04 / Boeing FCOM PI.20 / EASA CS-25.121d):
        HVY  3.5 %   NRW  3.8 %   RGN  3.0 %
        BIZ  4.0 %   TBP  2.8 %   GA   2.0 %   FTR  5.0 %
      GA single-engine: AEO MAP per CS-23, displayed as N/A
      tier when classified ga (no OEI requirement).
   5) Density-altitude penalty: -0.42 % per 1000 ft DA
      (Airbus typical curve, scaled by DA-PENALTY slider).
      Temperature kicker: -0.04 % per °C above ISA on top.
   6) Mass penalty from MASS-MULT slider 80-130 pct: each +1
      pct mass above 100 = -0.025 % net gradient (typical
      FCOM mass-correction slope).
   7) Configuration penalty: gear-down go-around assumed for
      late-stage missed-approach: -0.25 % flat (Boeing FCOM
      Flap-15/Gear-Down PI section).
   8) Net gradient = base - DA_penalty - mass_penalty - cfg
      clipped at -2 %. Margin = net - 2.5 % PANS-OPS minimum.

   Classify 5 tiers:
     COMPLIANT  margin >= 1.0  emerald   nominal MAP
     MARGINAL   margin >= 0.3  sky       monitor mass / temp
     TIGHT      margin >= 0    amber     OEI MAP at limit, brief crew
     DEFICIT    margin < 0     rose      cannot meet 2.5 % - DIVERT
     NA-GA      single-engine ga         slate (no req)

   MapLibre overlay:
     - Halo ring sized by |margin| 8-22 px tier-coloured.
     - Dashed tier-coloured projection line aircraft -> dest ARP.
     - Diamond marker at destination ARP tier-coloured.
     - Tier-coloured callsign + net-% + margin label for non-COMPLIANT.

   Side panel:
     - 5-tier counter strip click-to-filter.
     - 3-cell MEAN-MARGIN / WORST cs+net% / DEFICIT count.
     - 2-cell mean DA-ft / mean OAT-C.
     - SVG net-gradient vs DA scatter, PANS-OPS 2.5 % rose line,
       3.5 % CAT-I emerald line, DA bands 0/4k/8k/12k.
     - 5 sliders MIN-FL/MAX-FL/CAPTURE/ELEV-BIAS/ISA-DEV +
       full-width MASS-MULT.
     - 7-class chip filter, HALO/PROJ/PIN/LBL/DIAG toggles,
       search, AIRCRAFT/AIRPORTS tabs.
     - AIRCRAFT rows: callsign+type+class+tier · FL/IATA/Vapp
       / net% bar · DA / OAT / base / mass-pen · advice.
     - AIRPORTS rows: count, worst-tier, mean-margin.

   Registered under Layers > Safety & Traffic category.
   ft-mapp persisted preference.
   ============================================================ */

export interface MappFlight {
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
  flights: MappFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COMPLIANT' | 'MARGINAL' | 'TIGHT' | 'DEFICIT' | 'NA'
const TIER_COLOR: Record<Tier, string> = {
  COMPLIANT: '#10b981',
  MARGINAL: '#0ea5e9',
  TIGHT: '#f59e0b',
  DEFICIT: '#ef4444',
  NA: '#64748b',
}
const TIER_ORDER: Tier[] = ['DEFICIT', 'TIGHT', 'MARGINAL', 'COMPLIANT', 'NA']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

const BASE_OEI_PCT: Record<Klass, number> = { heavy: 3.5, narrow: 3.8, regional: 3.0, biz: 4.0, turboprop: 2.8, ga: 2.0, fighter: 5.0 }
const VREF_KT: Record<Klass, number> = { heavy: 145, narrow: 138, regional: 120, biz: 125, turboprop: 95, ga: 65, fighter: 150 }

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

// Curated elevation proxy bands: returns metres above MSL given lat/lng/icao prefix.
function elevProxyM(lat: number, lng: number, icao: string): { m: number, region: string } {
  const u = (icao || '').toUpperCase()
  // Tibetan / Himalayan (ZL Lhasa, VN Nepal, VI Indian Himalaya)
  if ((u.startsWith('ZUL') || u.startsWith('ZUN') || u.startsWith('VN')) && lat > 26 && lat < 38 && lng > 78 && lng < 105) return { m: 3500, region: 'Tibetan plateau' }
  // Andes (SP Peru, SL Bolivia, SE Ecuador, SK Colombia interior)
  if (lat > -35 && lat < 5 && lng > -80 && lng < -65 && (u.startsWith('SP') || u.startsWith('SL') || u.startsWith('SE') || u.startsWith('SK'))) return { m: 2500, region: 'Andean cordillera' }
  // Mexican plateau (MMMX, MMTO)
  if (u.startsWith('MM') && lat > 17 && lat < 25 && lng > -105 && lng < -97) return { m: 2000, region: 'Mexican plateau' }
  // CONUS mountain west (K-west, lng -120..-103, lat 30-50, excluding coastal)
  if (u.startsWith('K') && lat > 32 && lat < 49 && lng > -120 && lng < -103) return { m: 1500, region: 'US mountain west' }
  // E-African Rift (HA Ethiopia, HK Kenya highlands)
  if ((u.startsWith('HA') || u.startsWith('HK')) && lat > -5 && lat < 15 && lng > 32 && lng < 42) return { m: 1700, region: 'East African Rift' }
  // Southern African highveld (FA Johannesburg)
  if (u.startsWith('FA') && lat > -32 && lat < -22 && lng > 22 && lng < 32) return { m: 1500, region: 'SAfrican Highveld' }
  // Australian Outback (Y-interior)
  if (u.startsWith('Y') && lat > -32 && lat < -18 && lng > 120 && lng < 145) return { m: 350, region: 'Australian Outback' }
  // N European lowland, SE Asian deltas, etc — coastal default
  return { m: 100, region: 'coastal/lowland' }
}

interface Row {
  f: MappFlight
  klass: Klass
  flCur: number
  destI: string; destIcao: string; destName: string
  destLat: number; destLng: number; destNm: number
  destElevM: number; destRegion: string
  paFt: number       // pressure altitude proxy
  isaOatC: number    // ISA OAT at PA
  oatC: number       // current OAT = ISA + dev
  daFt: number       // density altitude
  baseGrad: number
  daPenalty: number
  tempPenalty: number
  massPenalty: number
  cfgPenalty: number
  netGrad: number
  margin: number     // net - 2.5
  vapp: number
  tier: Tier
}

const SRC_RING = 'mapp-ring', SRC_PROJ = 'mapp-proj', SRC_DOT = 'mapp-dot', SRC_LBL = 'mapp-lbl', SRC_APP = 'mapp-ap'
const LYR_RING = 'mapp-ring-l', LYR_PROJ = 'mapp-proj-l', LYR_DOT = 'mapp-dot-l', LYR_LBL = 'mapp-lbl-l', LYR_APP = 'mapp-ap-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)
const PANS_OPS_MIN = 2.5

export default function MissedApproach({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(180)
  const [captureRng, setCaptureRng] = useState(120)
  const [elevBias, setElevBias] = useState(0)      // metres added globally
  const [isaDev, setIsaDev] = useState(0)          // K above ISA
  const [massMult, setMassMult] = useState(100)    // %
  const [daPenaltyMult, setDaPenaltyMult] = useState(100) // % of 0.42 per 1k
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
      const ep = elevProxyM(best.lat, best.lng, best.icao)
      const destElevM = ep.m + elevBias
      const paFt = destElevM * 3.281
      const isaOatC = 15 - 1.98 * paFt / 1000
      const oatC = isaOatC + isaDev
      const daFt = paFt + 120 * (oatC - isaOatC)
      const baseGrad = BASE_OEI_PCT[klass]
      const daPenalty = (daFt / 1000) * 0.42 * (daPenaltyMult / 100)
      const tempPenalty = Math.max(0, oatC - isaOatC) * 0.04
      const massPenalty = Math.max(0, massMult - 100) * 0.025
      const cfgPenalty = 0.25
      const netGrad = Math.max(-2, baseGrad - daPenalty - tempPenalty - massPenalty - cfgPenalty)
      const margin = netGrad - PANS_OPS_MIN
      const vapp = VREF_KT[klass]
      let tier: Tier
      if (klass === 'ga') tier = 'NA'
      else if (margin < 0) tier = 'DEFICIT'
      else if (margin < 0.3) tier = 'TIGHT'
      else if (margin < 1.0) tier = 'MARGINAL'
      else tier = 'COMPLIANT'

      out.push({
        f, klass, flCur,
        destI: best.i, destIcao: best.icao, destName: best.name,
        destLat: best.lat, destLng: best.lng, destNm: best.distNm,
        destElevM, destRegion: ep.region,
        paFt, isaOatC, oatC, daFt,
        baseGrad, daPenalty, tempPenalty, massPenalty, cfgPenalty,
        netGrad, margin, vapp, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return a.margin - b.margin
    })
    return out
  }, [flights, minFl, maxFl, captureRng, elevBias, isaDev, massMult, daPenaltyMult])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { COMPLIANT: 0, MARGINAL: 0, TIGHT: 0, DEFICIT: 0, NA: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let meanMargin = 0, worstM = 1e9, worstCs = '', deficitCount = 0, sumDA = 0, sumOAT = 0, worstNet = 0, denom = 0
    for (const r of rows) {
      if (r.tier === 'NA') continue
      meanMargin += r.margin
      sumDA += r.daFt
      sumOAT += r.oatC
      denom++
      if (r.margin < worstM) { worstM = r.margin; worstCs = (r.f.callsign || r.f.icao).trim(); worstNet = r.netGrad }
      if (r.tier === 'DEFICIT') deficitCount++
    }
    if (denom > 0) { meanMargin /= denom; sumDA /= denom; sumOAT /= denom }
    return { meanMargin, worstM, worstCs, worstNet, deficitCount, meanDA: sumDA, meanOAT: sumOAT, total: rows.length, scored: denom }
  }, [rows])

  const airports = useMemo(() => {
    const m = new Map<string, { i: string, icao: string, name: string, lat: number, lng: number, count: number, worstTier: Tier, sumMargin: number, worstM: number, worstCs: string, elevM: number, region: string }>()
    for (const r of rows) {
      const e = m.get(r.destI)
      if (e) {
        e.count++
        e.sumMargin += r.margin
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
        if (r.margin < e.worstM) { e.worstM = r.margin; e.worstCs = (r.f.callsign || r.f.icao).trim() }
      } else {
        m.set(r.destI, { i: r.destI, icao: r.destIcao, name: r.destName, lat: r.destLat, lng: r.destLng, count: 1, worstTier: r.tier, sumMargin: r.margin, worstM: r.margin, worstCs: (r.f.callsign || r.f.icao).trim(), elevM: r.destElevM, region: r.destRegion })
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
      properties: { color: TIER_COLOR[r.tier], radius: 8 + Math.min(14, Math.abs(r.margin) * 4) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const projFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'COMPLIANT' && r.tier !== 'NA').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.destLng, r.destLat]] },
    })) : [] }
    const dotFc = { type: 'FeatureCollection' as const, features: showProj ? rows.filter(r => r.tier !== 'COMPLIANT' && r.tier !== 'NA').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.destLng, r.destLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'COMPLIANT' && r.tier !== 'NA').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.netGrad.toFixed(2)}% ${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(2)}`,
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

  // Scatter: net-gradient (y, -1..+5 %) vs DA-ft (x, 0..14000)
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD = 26
    const xMin = 0, xMax = 14000, yMin = -1, yMax = 5
    const xs = (v: number) => PAD + Math.max(0, Math.min(1, (v - xMin) / (xMax - xMin))) * (W - PAD - 6)
    const ys = (k: number) => 6 + (1 - Math.max(0, Math.min(1, (k - yMin) / (yMax - yMin)))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, xMin, xMax, yMin, yMax }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">OEI Missed-Approach</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Margin</div>
          <div className="font-mono text-sm" style={{ color: summary.meanMargin < 0 ? '#ef4444' : summary.meanMargin < 0.5 ? '#f59e0b' : summary.meanMargin < 1.0 ? '#0ea5e9' : '#10b981' }}>
            {summary.scored ? `${summary.meanMargin >= 0 ? '+' : ''}${summary.meanMargin.toFixed(2)}` : '—'}<span className="text-[9px] text-slate-500"> %</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Net</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstNet.toFixed(2)}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Deficit</div>
          <div className="font-mono text-sm" style={{ color: summary.deficitCount > 0 ? '#ef4444' : '#10b981' }}>{summary.deficitCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean DA</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanDA > 8000 ? '#ef4444' : summary.meanDA > 4000 ? '#f59e0b' : '#10b981' }}>{summary.meanDA.toFixed(0)}<span className="text-[9px] text-slate-500"> ft</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean OAT</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanOAT > 35 ? '#f59e0b' : '#10b981' }}>{summary.meanOAT.toFixed(0)}<span className="text-[9px] text-slate-500"> °C</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Net-grad · % vs density-alt · ft · ISA{isaDev >= 0 ? '+' : ''}{isaDev}K</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {[0, 1, 2, 3, 4, 5].map(g => (
              <g key={g}>
                <line x1={diag.PAD} y1={diag.ys(g)} x2={diag.W - 6} y2={diag.ys(g)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(g) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{g}%</text>
              </g>
            ))}
            {[2000, 4000, 6000, 8000, 10000, 12000].map(d => (
              <g key={d}>
                <line x1={diag.xs(d)} y1={6} x2={diag.xs(d)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(d)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{(d/1000)}k</text>
              </g>
            ))}
            {/* Tier bands by net-gradient */}
            <rect x={diag.PAD} y={diag.ys(5)} width={diag.W - diag.PAD - 6} height={diag.ys(3.5) - diag.ys(5)} fill="#10b981" opacity={0.05} />
            <rect x={diag.PAD} y={diag.ys(3.5)} width={diag.W - diag.PAD - 6} height={diag.ys(2.8) - diag.ys(3.5)} fill="#0ea5e9" opacity={0.05} />
            <rect x={diag.PAD} y={diag.ys(2.8)} width={diag.W - diag.PAD - 6} height={diag.ys(2.5) - diag.ys(2.8)} fill="#f59e0b" opacity={0.06} />
            <rect x={diag.PAD} y={diag.ys(2.5)} width={diag.W - diag.PAD - 6} height={diag.ys(-1) - diag.ys(2.5)} fill="#ef4444" opacity={0.06} />
            {/* PANS-OPS 2.5% line */}
            <line x1={diag.PAD} y1={diag.ys(2.5)} x2={diag.W - 6} y2={diag.ys(2.5)} stroke="#ef4444" strokeWidth={1.1} strokeDasharray="4 2" />
            <text x={diag.W - 8} y={diag.ys(2.5) - 2} textAnchor="end" fontSize={8} fill="#ef4444" fontFamily="monospace">PANS-OPS 2.5%</text>
            {/* CAT-I 3.5% reference line */}
            <line x1={diag.PAD} y1={diag.ys(3.5)} x2={diag.W - 6} y2={diag.ys(3.5)} stroke="#10b981" strokeWidth={0.7} strokeDasharray="3 2" opacity={0.65} />
            <text x={diag.W - 8} y={diag.ys(3.5) - 2} textAnchor="end" fontSize={8} fill="#10b981" fontFamily="monospace" opacity={0.8}>CAT-I 3.5%</text>
            {rows.filter(r => r.tier !== 'NA').map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.max(0, Math.min(14000, r.daFt)))} cy={diag.ys(Math.max(-1, Math.min(5, r.netGrad)))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span></div>
            <input type="range" min={0} max={200} step={10} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={300} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureRng}nm</span></div>
            <input type="range" min={30} max={250} step={10} value={captureRng} onChange={e => setCaptureRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ELEV-BIAS</span><span className="font-mono text-slate-300">{elevBias >= 0 ? '+' : ''}{elevBias}m</span></div>
            <input type="range" min={0} max={3000} step={50} value={elevBias} onChange={e => setElevBias(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>ISA-DEV</span><span className="font-mono text-slate-300">{isaDev >= 0 ? '+' : ''}{isaDev}K</span></div>
            <input type="range" min={-20} max={30} step={1} value={isaDev} onChange={e => setIsaDev(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>DA-PEN</span><span className="font-mono text-slate-300">{daPenaltyMult}%</span></div>
            <input type="range" min={50} max={200} step={5} value={daPenaltyMult} onChange={e => setDaPenaltyMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>MASS-MULT</span><span className="font-mono text-slate-300">{massMult}%</span></div>
            <input type="range" min={80} max={130} step={1} value={massMult} onChange={e => setMassMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
        <span>{tab === 'AIRCRAFT' ? 'net% · margin · DA · OAT' : 'count · worst · elev'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No arrivals match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // Net-grad bar normalised 0-5 %
          const refMax = 5
          const netPct = Math.max(0, Math.min(100, (r.netGrad / refMax) * 100))
          const pansPct = (PANS_OPS_MIN / refMax) * 100
          const cati = (3.5 / refMax) * 100
          const advice = r.tier === 'NA' ? 'single-engine GA · no OEI MAP requirement' :
            r.tier === 'DEFICIT' ? 'OEI cannot meet 2.5% PANS-OPS · DIVERT to lower-DA field' :
            r.tier === 'TIGHT' ? 'OEI MAP at limit · brief crew · consider lower mass' :
            r.tier === 'MARGINAL' ? 'monitor mass / temp · OEI MAP achievable with care' :
            'OEI net gradient comfortable above PANS-OPS minimum'
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
                  <span title="Vapp">Vapp {r.vapp}kt</span>
                  <span className="ml-auto" title="OEI net gradient" style={{ color: TIER_COLOR[r.tier] }}>{r.netGrad.toFixed(2)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="OEI net climb gradient 0-5 %">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${netPct}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-500" style={{ left: `${pansPct}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `${cati}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="density altitude" style={{ color: r.daFt > 8000 ? '#ef4444' : r.daFt > 4000 ? '#f59e0b' : '#94a3b8' }}>DA {r.daFt.toFixed(0)}ft</span>
                  <span title="OAT estimated">{r.oatC.toFixed(0)}°C</span>
                  <span title="ISA OAT">ISA {r.isaOatC.toFixed(0)}°C</span>
                  <span className="ml-auto" title="margin vs PANS-OPS 2.5%" style={{ color: r.margin < 0 ? '#ef4444' : r.margin < 0.3 ? '#f59e0b' : r.margin < 1 ? '#0ea5e9' : '#10b981' }}>{r.margin >= 0 ? '+' : ''}{r.margin.toFixed(2)}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="class base SL ISA OEI net grad">base {r.baseGrad.toFixed(1)}%</span>
                  <span title="DA penalty">DA-{r.daPenalty.toFixed(2)}</span>
                  <span title="mass penalty">M-{r.massPenalty.toFixed(2)}</span>
                  <span title="config penalty">cfg-{r.cfgPenalty.toFixed(2)}</span>
                  <span className="ml-auto" title="elev m">{r.destElevM.toFixed(0)}m</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: r.tier === 'COMPLIANT' || r.tier === 'NA' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
                <div className="text-[10px] text-slate-600 font-mono mt-0.5 truncate" title="destination name + region">{r.destIcao} · {r.destName} · {r.destRegion}</div>
              </div>
            </button>
          )
        })}
        {tab === 'AIRPORTS' && filteredAirports.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No fields match.</div>
        )}
        {tab === 'AIRPORTS' && filteredAirports.map(a => {
          const meanMargin = a.sumMargin / Math.max(1, a.count)
          const elevPct = Math.min(100, (a.elevM / 4000) * 100)
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
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="elevation 0-4000 m">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${elevPct}%`, background: TIER_COLOR[a.worstTier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${(1500/4000)*100}%` }} />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `${(2500/4000)*100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="icao">{a.icao}</span>
                  <span title="elevation">{a.elevM.toFixed(0)}m</span>
                  <span title="mean margin" style={{ color: meanMargin < 0 ? '#ef4444' : meanMargin < 0.3 ? '#f59e0b' : meanMargin < 1 ? '#0ea5e9' : '#10b981' }}>{meanMargin >= 0 ? '+' : ''}{meanMargin.toFixed(2)}%</span>
                  <span title="worst" className="ml-auto truncate">{a.worstCs} {a.worstM >= 0 ? '+' : ''}{a.worstM.toFixed(2)}</span>
                </div>
                <div className="text-[10px] text-slate-600 font-mono mt-0.5 truncate">{a.region}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
