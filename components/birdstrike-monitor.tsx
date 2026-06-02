'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Bird Strike Risk Monitor / Wildlife Hazard Overlay
   -----------------------------------------------------------
   Real aviation hazard. Bird strikes cost ~$1.2B/yr and have
   downed airliners (US Airways 1549 Hudson 2009 - Canada Geese
   at 2800ft; Ethiopian 302 takeoff bird ingestion suspected;
   Eastern 375 Lockheed Electra Boston 1960 starlings = 62 fatal;
   AWACS Elmendorf 1995 = 24 fatal Canada Geese). FAA/ICAO
   require wildlife hazard mgmt at certificated airports
   (Part 139 / Annex 14).

   This panel scores every airborne aircraft below FL150 by:

   1) Migratory flyway proximity. 8 global flyways encoded as
      polyline corridors (Pacific Americas / Central Americas /
      Mississippi Americas / Atlantic Americas / East Atlantic /
      Black Sea-Mediterranean / East Asian-Australasian /
      West Pacific) sampled every 200nm. For each aircraft we
      find nearest sample, compute lateral nm to flyway axis,
      and apply Gaussian decay with sigma 60nm.

   2) Seasonal activity. Northern Hemisphere spring (Mar-May)
      and autumn (Aug-Nov) peaks 1.0x; summer/winter base 0.35x.
      Southern Hemisphere mirrored. Selected via aircraft lat.

   3) Altitude band PDF. Birds are densest at low altitude:
      SFC-500ft   p=1.00 (gulls, pigeons, raptors)
      500-3000ft  p=0.85 (waterfowl approach corridor)
      3000-7000ft p=0.55 (migrating geese, ducks)
      7000-15000  p=0.30 (high-altitude migrants - Bar-headed)
      >FL150      p=0.05 (rare, mostly vulture/condor)
      FAA strike DB: 71% of strikes <500ft AGL.

   4) Phase of flight modifier. Takeoff+initial climb 1.35x,
      approach+landing 1.25x, cruise 0.60x (FAA: 38% takeoff,
      36% approach, 18% en-route).

   5) Airport-vicinity boost. Within 5nm of an AIRPORTS pin
      with cat='large' or 'medium' apply 1.50x; within 12nm
      1.20x. Big hubs are bird magnets (landfills, wetlands).

   6) Class-tuned engine exposure. Bigger fan = more ingest
      tolerance. Heavy/narrow fan-blade certified to ingest
      4lb birds (CFR 33.76 medium-flock standard); GA/turboprop
      far less robust per-engine.
        heavy   factor 0.60 (4xfan jet typical)
        narrow  factor 0.80 (2xfan, single-engine-after-strike)
        regional 0.90
        biz     0.85
        turboprop 1.15 (props chop but ingestion catastrophic)
        ga      1.30 (single-engine windshield/prop)
        fighter 1.10 (high closure rate)
        heli    1.40 (rotor exposure)

   Risk = base_risk * flyway_proximity * seasonal *
          alt_pdf * phase_mod * ap_boost * class_factor

   Tiers (rose/orange/amber/sky):
     SEVERE >= 0.60   active high-risk corridor at low alt
     HIGH   >= 0.35
     ELEV   >= 0.15
     LOW    <  0.15

   Per-airport rollup: counts inbound + departing aircraft
   within 15nm and aggregates max risk tier per hub.

   MapLibre overlay: tier-colored aircraft halo rings sized by
   risk, flyway corridor polylines (8 global corridors as
   amber dashed lines + 30nm soft band shading), violet airport
   pins with IATA + tier dot, and callsign + risk-% labels.

   Side panel: 4-tier counter strip click-to-filter, 3-cell
   FLEET MAX / HOTSPOT / AT-RISK summary, SVG global flyway
   strip showing all 8 corridors color-coded by activity with
   aircraft dots, FLYWAY-SIG / SEASON-MULT / MIN-FL / MAX-FL
   sliders, FLYWAYS / HALOS / LBL / AIRPORTS toggles, search,
   AIRCRAFT tab sorted tier-worst then risk desc with stripe,
   AIRPORTS tab sorted by worst-tier then traffic count.
   ============================================================ */

export interface BsFlight {
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

export interface BsAirport {
  iata?: string
  icao?: string
  name: string
  city?: string
  lat: number
  lng: number
  cat?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: BsFlight[]
  airports?: BsAirport[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'LOW' | 'ELEV' | 'HIGH' | 'SEVERE'
const TIER_COLOR: Record<Tier, string> = {
  LOW: '#0ea5e9',
  ELEV: '#fbbf24',
  HIGH: '#f97316',
  SEVERE: '#ef4444',
}
const TIER_ORDER: Tier[] = ['SEVERE', 'HIGH', 'ELEV', 'LOW']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter' | 'heli'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR', heli: 'HEL',
}
const KLASS_FACTOR: Record<Klass, number> = {
  heavy: 0.60, narrow: 0.80, regional: 0.90, biz: 0.85, turboprop: 1.15, ga: 1.30, fighter: 1.10, heli: 1.40,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (/^H/.test(x) || /(EC13|EC35|EC45|AS35|AS50|AS65|R44|R66|S76|S92|UH|AW139|AW169|AW189|B06|B07|B412|H125|H135|H145|H160)/.test(x)) return 'heli'
  if (c.includes('A7')) return 'heli'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96|A30|B76|C5|C17)/.test(x)) return 'heavy'
  if (/^(A31|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|E19|E29|CRJ9|CS|BCS)/.test(x)) return 'narrow'
  if (/^(CRJ|E14|E15|E17|E70|E75|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'regional'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'biz'
  if (/^(F16|F15|F18|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU|JAS)/.test(x)) return 'fighter'
  if (/^(C72|C82|C17[2-9]|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'ga'
  if (/^(B19|B20|B30|B35|B40|B45|B55|B58|B95|B96|B99|EMB|E11|PA31|PA42|PC9|KODI)/.test(x)) return 'turboprop'
  return 'narrow'
}

/* Global migratory flyways - polyline corridors */
interface Flyway { id: string; name: string; color: string; pts: Array<[number, number]> }
const FLYWAYS: Flyway[] = [
  { id: 'PAC-AM', name: 'Pacific Americas', color: '#0ea5e9', pts: [
    [-149.5, 61.2], [-135.5, 57.0], [-122.7, 47.5], [-118.4, 34.0], [-110.9, 25.5], [-99.1, 19.4], [-84.0, 9.9], [-77.5, -12.0], [-70.6, -33.4], [-69.2, -52.1] ] },
  { id: 'CEN-AM', name: 'Central Americas', color: '#a78bfa', pts: [
    [-106.6, 62.1], [-104.6, 50.5], [-104.6, 41.1], [-100.3, 32.7], [-99.1, 19.4], [-79.5, 9.0], [-66.9, -10.0], [-65.4, -34.6] ] },
  { id: 'MISS-AM', name: 'Mississippi Americas', color: '#22d3ee', pts: [
    [-95.0, 71.2], [-94.5, 56.5], [-90.2, 44.5], [-90.0, 35.0], [-90.0, 29.9], [-80.2, 25.8], [-66.9, 10.5], [-58.5, -1.4], [-46.6, -23.5], [-58.4, -34.6] ] },
  { id: 'ATL-AM', name: 'Atlantic Americas', color: '#f59e0b', pts: [
    [-63.6, 62.0], [-65.0, 53.0], [-71.0, 42.3], [-74.0, 40.7], [-77.0, 38.9], [-80.0, 25.8], [-66.9, 10.5], [-43.2, -22.9], [-58.4, -34.6] ] },
  { id: 'EU-W', name: 'East Atlantic', color: '#34d399', pts: [
    [-21.9, 64.1], [-3.2, 55.9], [4.9, 52.4], [2.3, 48.9], [-3.7, 40.4], [-9.1, 38.7], [-7.5, 33.6], [-2.2, 15.6], [9.0, 7.4], [18.4, -33.9] ] },
  { id: 'BSEA-MED', name: 'Black Sea / Mediterranean', color: '#fbbf24', pts: [
    [37.6, 64.7], [37.6, 55.7], [30.5, 50.4], [28.9, 41.0], [29.0, 36.1], [31.2, 30.0], [35.2, 24.0], [32.6, 15.6], [38.7, 9.0], [31.0, -29.9] ] },
  { id: 'EAA', name: 'East Asian / Australasian', color: '#ec4899', pts: [
    [142.0, 70.0], [126.7, 50.0], [125.7, 39.0], [121.5, 31.2], [120.0, 22.6], [114.2, 22.3], [106.7, 10.8], [106.8, -6.2], [130.8, -12.5], [144.9, -37.8], [174.8, -41.3] ] },
  { id: 'WPAC', name: 'West Pacific', color: '#06b6d4', pts: [
    [157.0, 71.3], [165.0, 60.0], [173.0, 50.0], [141.3, 43.0], [139.7, 35.7], [129.6, 30.6], [121.6, 25.0], [125.6, 10.3], [134.5, 7.5], [151.2, -33.9] ] },
]

/* ---------- Math helpers ---------- */
function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI / 180
  const φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function nearestFlywayNm(lat: number, lng: number): { fw: Flyway, nm: number } {
  let best: Flyway = FLYWAYS[0], bestNm = Infinity
  for (const f of FLYWAYS) {
    for (let i = 0; i < f.pts.length - 1; i++) {
      const [lo1, la1] = f.pts[i]
      const [lo2, la2] = f.pts[i + 1]
      // sample segment in 6 substeps for cheap arc-aware nearest
      for (let s = 0; s <= 6; s++) {
        const t = s / 6
        const la = la1 + (la2 - la1) * t
        const lo = lo1 + (lo2 - lo1) * t
        const d = distNm(lat, lng, la, lo)
        if (d < bestNm) { bestNm = d; best = f }
      }
    }
  }
  return { fw: best, nm: bestNm }
}

function seasonalMul(lat: number, month: number): number {
  // month 0..11 (UTC). Spring Mar-May (2..4), Autumn Aug-Nov (7..10) peaks NH.
  const northern = lat >= 0
  const m = month
  const isSpringNH = m >= 2 && m <= 4
  const isFallNH = m >= 7 && m <= 10
  let peak = (northern ? (isSpringNH || isFallNH) : (!isSpringNH && !isFallNH))
  // shoulders
  let peakStrong = northern
    ? (m === 3 || m === 4 || m === 8 || m === 9)
    : (m === 9 || m === 10 || m === 2 || m === 3)
  if (peakStrong) return 1.00
  if (peak) return 0.75
  return 0.35
}

function altPdf(altFt: number): number {
  if (altFt < 500) return 1.00
  if (altFt < 3000) return 0.85
  if (altFt < 7000) return 0.55
  if (altFt < 15000) return 0.30
  return 0.05
}

function phaseMul(vertRate: number, altFt: number): number {
  if (altFt < 3000 && vertRate > 400) return 1.35   // initial climb
  if (altFt < 5000 && vertRate < -400) return 1.25  // approach
  if (Math.abs(vertRate) < 250) return 0.60         // cruise
  return 0.95
}

const SRC_HALO = 'bs-halo', SRC_FW = 'bs-fw', SRC_FWB = 'bs-fwb', SRC_AP = 'bs-ap', SRC_LBL = 'bs-lbl'
const LYR_HALO = 'bs-halo-l', LYR_FW = 'bs-fw-l', LYR_FWB = 'bs-fwb-l', LYR_AP = 'bs-ap-l', LYR_APLBL = 'bs-aplbl-l', LYR_LBL = 'bs-lbl-l'

interface Row {
  f: BsFlight
  klass: Klass
  flyway: Flyway
  fwNm: number
  fwMul: number
  seasonMul: number
  altMul: number
  phaseMul: number
  apBoost: number
  apIata?: string
  risk: number
  tier: Tier
}

interface ApRow {
  ap: BsAirport
  trafficCount: number
  worstTier: Tier
  meanRisk: number
}

export default function BirdStrikeMonitor({ map, flights, airports = [], onClose, onFly, onFlyLatLng }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(0)
  const [maxFl, setMaxFl] = useState(150)
  const [fwSig, setFwSig] = useState(60)
  const [seasonOverride, setSeasonOverride] = useState(100) // 0..150 percent multiplier
  const [showHalo, setShowHalo] = useState(true)
  const [showFws, setShowFws] = useState(true)
  const [showAps, setShowAps] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [tab, setTab] = useState<'AC' | 'AP'>('AC')
  const [query, setQuery] = useState('')

  const month = new Date().getUTCMonth()
  const apFiltered = useMemo(() => airports.filter(a => a.cat === 'large' || a.cat === 'medium').slice(0, 600), [airports])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const { fw, nm } = nearestFlywayNm(f.lat, f.lng)
      const fwMul = Math.exp(-(nm / fwSig) * (nm / fwSig))
      const sm = seasonalMul(f.lat, month) * (seasonOverride / 100)
      const am = altPdf(f.altitudeFt)
      const pm = phaseMul(f.vertRate || 0, f.altitudeFt)
      // airport vicinity boost
      let apBoost = 1.0
      let apIata: string | undefined
      for (const a of apFiltered) {
        const d = distNm(f.lat, f.lng, a.lat, a.lng)
        if (d <= 5 && apBoost < 1.5) { apBoost = 1.5; apIata = a.iata || a.icao }
        else if (d <= 12 && apBoost < 1.2) { apBoost = 1.2; apIata = a.iata || a.icao }
      }
      const base = 0.85
      const risk = Math.min(1, base * fwMul * sm * am * pm * apBoost * KLASS_FACTOR[klass])
      let tier: Tier
      if (risk >= 0.60) tier = 'SEVERE'
      else if (risk >= 0.35) tier = 'HIGH'
      else if (risk >= 0.15) tier = 'ELEV'
      else tier = 'LOW'
      out.push({ f, klass, flyway: fw, fwNm: nm, fwMul, seasonMul: sm, altMul: am, phaseMul: pm, apBoost, apIata, risk, tier })
    }
    return out
  }, [flights, minFl, maxFl, fwSig, seasonOverride, apFiltered, month])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { LOW: 0, ELEV: 0, HIGH: 0, SEVERE: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const apRows: ApRow[] = useMemo(() => {
    const out: ApRow[] = []
    for (const a of apFiltered) {
      let cnt = 0, sum = 0, worst: Tier = 'LOW'
      for (const r of rows) {
        const d = distNm(r.f.lat, r.f.lng, a.lat, a.lng)
        if (d > 15) continue
        cnt++; sum += r.risk
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(worst)) worst = r.tier
      }
      if (cnt === 0) continue
      out.push({ ap: a, trafficCount: cnt, worstTier: worst, meanRisk: sum / cnt })
    }
    return out.sort((a, b) => {
      const t = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (t !== 0) return t
      return b.trafficCount - a.trafficCount
    }).slice(0, 80)
  }, [rows, apFiltered])

  const summary = useMemo(() => {
    let max = 0, atRisk = 0
    let hotspotIata = '—'; let hotspotTier: Tier = 'LOW'
    for (const r of rows) {
      if (r.risk > max) max = r.risk
      if (r.tier === 'SEVERE' || r.tier === 'HIGH') atRisk++
    }
    if (apRows[0]) { hotspotIata = apRows[0].ap.iata || apRows[0].ap.icao || '—'; hotspotTier = apRows[0].worstTier }
    return { max, atRisk, hotspotIata, hotspotTier }
  }, [rows, apRows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return (r.f.callsign || '').toLowerCase().includes(q)
        || r.f.icao.toLowerCase().includes(q)
        || (r.f.type || '').toLowerCase().includes(q)
        || (r.f.operator || '').toLowerCase().includes(q)
        || r.flyway.id.toLowerCase().includes(q)
    }).sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.risk - a.risk
    })
  }, [rows, tierFilter, klassFilter, query])

  /* ---------- MapLibre overlay ---------- */
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        for (const s of [SRC_HALO, SRC_FW, SRC_FWB, SRC_AP, SRC_LBL]) if (!map.getSource(s)) map.addSource(s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_FWB)) map.addLayer({
          id: LYR_FWB, type: 'line', source: SRC_FWB,
          paint: { 'line-color': ['get', 'color'], 'line-width': 22, 'line-opacity': 0.07, 'line-blur': 12 },
        })
        if (!map.getLayer(LYR_FW)) map.addLayer({
          id: LYR_FW, type: 'line', source: SRC_FW,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.7, 'line-dasharray': [3, 3] },
        })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC_HALO,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'risk'], 0.1, 8, 1.0, 22],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.10,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': 0.85,
          },
        })
        if (!map.getLayer(LYR_AP)) map.addLayer({
          id: LYR_AP, type: 'circle', source: SRC_AP,
          paint: {
            'circle-radius': 5,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1.2,
          },
        })
        if (!map.getLayer(LYR_APLBL)) map.addLayer({
          id: LYR_APLBL, type: 'symbol', source: SRC_AP,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.0],
            'text-anchor': 'top',
            'text-allow-overlap': false,
          },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 },
        })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, -1.8],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1220', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)
  }, [map])

  useEffect(() => {
    if (!map) return
    const haloFeats: any[] = []
    const fwFeats: any[] = []
    const fwbFeats: any[] = []
    const apFeats: any[] = []
    const lblFeats: any[] = []
    if (showFws) {
      for (const f of FLYWAYS) {
        const coords = f.pts.map(p => [p[0], p[1]])
        fwFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: f.color } })
        fwbFeats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: f.color } })
      }
    }
    for (const r of filtered) {
      if (r.tier === 'LOW') continue
      if (showHalo) haloFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier], risk: r.risk },
      })
      if (showLabels) lblFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
        properties: { color: TIER_COLOR[r.tier], label: `${(r.f.callsign || r.f.icao).trim()} \u2022 ${(r.risk * 100).toFixed(0)}% \u2022 ${r.flyway.id}` },
      })
    }
    if (showAps) {
      for (const a of apRows) {
        if (a.worstTier === 'LOW') continue
        apFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.ap.lng, a.ap.lat] },
          properties: { color: TIER_COLOR[a.worstTier], label: `${a.ap.iata || a.ap.icao || ''} \u00b7 ${a.trafficCount}` },
        })
      }
    }
    try {
      ;(map.getSource(SRC_HALO) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: haloFeats })
      ;(map.getSource(SRC_FW) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: fwFeats })
      ;(map.getSource(SRC_FWB) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: fwbFeats })
      ;(map.getSource(SRC_AP) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: apFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, filtered, apRows, showHalo, showFws, showAps, showLabels])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_APLBL, LYR_AP, LYR_HALO, LYR_FW, LYR_FWB]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_AP, SRC_HALO, SRC_FW, SRC_FWB]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  /* ---------- Flyway strip SVG ---------- */
  const strip = useMemo(() => {
    const W = 348, H = 140, padL = 28, padR = 8, padT = 8, padB = 18
    const rowH = (H - padT - padB) / FLYWAYS.length
    return { W, H, padL, padR, padT, padB, rowH }
  }, [])

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  return (
    <div className="fixed top-16 right-3 z-40 w-[380px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9670;</span>
          <span className="text-sm font-semibold tracking-wide">BIRD STRIKE</span>
          <span className="text-[10px] text-slate-500">flyway &middot; phase &middot; season</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['SEVERE', 'HIGH', 'ELEV', 'LOW'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">FLEET MAX</div>
          <div className="text-sm font-mono" style={{ color: summary.max >= 0.60 ? TIER_COLOR.SEVERE : summary.max >= 0.35 ? TIER_COLOR.HIGH : summary.max >= 0.15 ? TIER_COLOR.ELEV : TIER_COLOR.LOW }}>{(summary.max * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">HOTSPOT</div>
          <div className="text-sm font-mono" style={{ color: TIER_COLOR[summary.hotspotTier] }}>{summary.hotspotIata}</div>
        </div>
        <div className="rounded bg-slate-900/40 border border-slate-800 px-2 py-1 text-center">
          <div className="text-[9px] tracking-wider text-slate-500">AT RISK</div>
          <div className="text-sm font-mono text-slate-200">{summary.atRisk}</div>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/30">
        <div className="text-[10px] text-slate-500 tracking-wider flex items-center justify-between mb-1">
          <span>FLYWAYS &middot; rows = corridors, dots = aircraft</span>
          <span className="font-mono text-slate-400">{MONTHS[month]} UTC</span>
        </div>
        <svg width={strip.W} height={strip.H} className="block">
          <rect x={0} y={0} width={strip.W} height={strip.H} fill="#0b1220" />
          {FLYWAYS.map((f, i) => {
            const y = strip.padT + i * strip.rowH + strip.rowH / 2
            const cnt = filtered.filter(r => r.flyway.id === f.id).length
            return (
              <g key={f.id}>
                <line x1={strip.padL} x2={strip.W - strip.padR} y1={y} y2={y} stroke={f.color} strokeWidth={0.8} strokeDasharray="3 3" opacity={0.55} />
                <text x={2} y={y + 3} fill={f.color} fontSize={8} fontFamily="ui-monospace, monospace">{f.id}</text>
                <text x={strip.W - strip.padR} y={y + 3} fill="#475569" fontSize={8} textAnchor="end" fontFamily="ui-monospace, monospace">{cnt}</text>
              </g>
            )
          })}
          {filtered.map(r => {
            const fi = FLYWAYS.findIndex(f => f.id === r.flyway.id)
            if (fi < 0) return null
            const y = strip.padT + fi * strip.rowH + strip.rowH / 2
            // x position by flyway proximity (closer = leftward)
            const xRange = strip.W - strip.padR - strip.padL - 18
            const xpos = strip.padL + 14 + Math.min(1, r.fwNm / 400) * xRange
            return (
              <circle key={r.f.icao} cx={xpos} cy={y} r={r.tier === 'LOW' ? 1.8 : 2.6}
                fill={TIER_COLOR[r.tier]} stroke="#0b1220" strokeWidth={0.6} opacity={r.tier === 'LOW' ? 0.5 : 1} />
            )
          })}
          {/* x scale legend */}
          <text x={strip.padL + 4} y={strip.H - 4} fill="#475569" fontSize={7} fontFamily="ui-monospace, monospace">0nm</text>
          <text x={strip.W - strip.padR - 20} y={strip.H - 4} fill="#475569" fontSize={7} fontFamily="ui-monospace, monospace">400nm</text>
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>FLYWAY SIGMA</span><span className="font-mono text-slate-300">{fwSig} nm</span>
          </div>
          <input type="range" min={20} max={200} step={5} value={fwSig} onChange={e => setFwSig(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SEASON MULT</span><span className="font-mono text-slate-300">{seasonOverride}%</span>
          </div>
          <input type="range" min={0} max={150} step={5} value={seasonOverride} onChange={e => setSeasonOverride(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>MIN-FL</span><span className="font-mono text-slate-300">{minFl}</span>
            </div>
            <input type="range" min={0} max={150} step={5} value={minFl} onChange={e => setMinFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
              <span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span>
            </div>
            <input type="range" min={10} max={250} step={5} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKlassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${klassFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['heavy', 'narrow', 'regional', 'biz', 'turboprop', 'ga', 'fighter', 'heli'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${klassFilter === k ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{KLASS_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showFws} onChange={e => setShowFws(e.target.checked)} className="accent-sky-500" /><span>FLYWAYS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showAps} onChange={e => setShowAps(e.target.checked)} className="accent-sky-500" /><span>AIRPORTS</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / flyway-id"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1 border-b border-slate-800 flex gap-1 text-[10px]">
        {(['AC', 'AP'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-sky-100' : 'border border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t === 'AC' ? `AIRCRAFT (${filtered.length})` : `AIRPORTS (${apRows.length})`}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AC' && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AC' && filtered.map(r => (
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
                <span style={{ color: r.flyway.color }}>{r.flyway.id}</span>
                <span>{r.fwNm.toFixed(0)}nm</span>
                <span>FL{Math.round(r.f.altitudeFt / 100)}</span>
                <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{(r.risk * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, r.risk * 100)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: '60%' }} title="SEVERE threshold" />
                <div className="absolute inset-y-0 w-0.5 bg-orange-400" style={{ left: '35%' }} title="HIGH threshold" />
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span title="seasonal multiplier">SEA &times;{r.seasonMul.toFixed(2)}</span>
                <span title="altitude-band PDF">ALT &times;{r.altMul.toFixed(2)}</span>
                <span title="phase-of-flight multiplier">PH &times;{r.phaseMul.toFixed(2)}</span>
                <span title="airport vicinity boost" className="ml-auto">{r.apIata ? `${r.apIata} \u00d7${r.apBoost.toFixed(2)}` : `AP \u00d71.00`}</span>
              </div>
            </div>
          </button>
        ))}
        {tab === 'AP' && apRows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airport hotspots.</div>
        )}
        {tab === 'AP' && apRows.map(a => (
          <button key={`${a.ap.iata || a.ap.icao || a.ap.name}-${a.ap.lat}`} onClick={() => onFlyLatLng(a.ap.lat, a.ap.lng, 9)}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[a.worstTier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold">{a.ap.iata || a.ap.icao || '\u2014'}</span>
                <span className="text-slate-500 truncate">{a.ap.name}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[a.worstTier] }}>{a.worstTier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span>{a.trafficCount} ac</span>
                <span>mean {(a.meanRisk * 100).toFixed(0)}%</span>
                <span className="ml-auto text-slate-500">{a.ap.city || ''}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
