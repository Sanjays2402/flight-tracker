'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Volcanic Ash Monitor
   -----------------------------------------------------------
   Real ops concern: volcanic ash is one of the few weather
   phenomena that can destroy a jet engine in minutes (BA009
   Galunggung 1982, KLM867 Redoubt 1989, Eyjafjallajökull 2010
   grounded ~10M passengers). ICAO mandates avoidance via VAACs
   (Volcanic Ash Advisory Centres) publishing ash-cloud SIGMETs.

   This panel models live plume drift for 40 globally significant
   active / recently-active volcanoes. For each volcano we know:
     - summit elevation ft
     - plume-top FL ceiling (recent VAAC reporting)
     - eruption status (ERUPTING / UNREST / DORMANT)
     - dataset region (VAAC sector: ANC / WAS / MONT / TOUL /
       LONDON / TOKYO / DARWIN / WELLINGTON / BUENOS / TOLAGNARO)

   The ash drift cone is synthesised from every airborne
   aircraft's reported wind vector within tunable SAMPLE-RNG nm
   above MIN-FL, averaged via u/v decomposition (each report
   weighted inversely by range). Mean wind FROM bearing is
   recovered via atan2 + 180-flip. The resulting ash cone is
   drawn DOWNWIND from the volcano, length = wind-kt * HORIZON-h,
   half-angle = clamp(8, 35deg / sqrt(wind-kt/15), 35) so calm
   winds produce a wide undirected hazard zone and strong winds
   produce a tight downstream plume.

   Per aircraft classification:
     IN_ASH  - currently inside any active drift cone
               AND within plume vertical band (alt < plumeFL)
     CLOSE   - within 30nm of cone edge OR enters within 5 min
     WATCH   - enters cone within HORIZON projection
     CLEAR   - outside cone envelope for entire horizon

   Per volcano rollup:
     - sample count + mean wind FROM / kt
     - drift cone azimuth + length nm
     - inside-aircraft count + worst-tier
     - estimated SO2 / ash output index (eruption-status * vent-radius)

   MapLibre overlay:
     - violet upward triangle volcano pins with id + plume-FL
     - kind-coloured drift-cone polygon (rose if ERUPTING /
       amber UNREST / sky DORMANT) with dashed outline
     - tier-coloured aircraft halo ring sized by exposure
     - dashed sky projection line from each WATCH aircraft to
       cone-entry waypoint with amber diamond marker
     - on-map labels callsign + tier + volcano-id

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell summary: ERUPTING / FLEET-IN-ASH / MEAN-WIND-KT
     - SVG plume-strip diagram (top 12 volcanoes by activity,
       horizontal bars showing drift azimuth + length, aircraft
       plotted as tier-coloured dots at their downwind nm)
     - sliders: SAMPLE-RNG, HORIZON, MIN-FL, WIND-MULT
     - kind-chip row: ERUPT / UNREST / DORMANT toggle inclusion
     - OVL / CONE / LINK / LBL toggles
     - search: callsign / type / operator / volcano name
     - VOLCANOES tab sorted worst-tier-first then activity desc
     - AIRCRAFT tab sorted tier worst-first then exposure desc
     - click-to-fly per row
   ============================================================ */

export interface VaFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  windDir?: number
  windKts?: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: VaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'CLEAR' | 'WATCH' | 'CLOSE' | 'IN_ASH'
const TIER_COLOR: Record<Tier, string> = {
  CLEAR: '#0ea5e9',
  WATCH: '#fde047',
  CLOSE: '#f59e0b',
  IN_ASH: '#ef4444',
}
const TIER_ORDER: Tier[] = ['IN_ASH', 'CLOSE', 'WATCH', 'CLEAR']
const TIER_RANK: Record<Tier, number> = { CLEAR: 0, WATCH: 1, CLOSE: 2, IN_ASH: 3 }

type Kind = 'ERUPT' | 'UNREST' | 'DORMANT'
const KIND_COLOR: Record<Kind, string> = { ERUPT: '#ef4444', UNREST: '#f59e0b', DORMANT: '#0ea5e9' }
const KIND_LABEL: Record<Kind, string> = { ERUPT: 'ERUPTING', UNREST: 'UNREST', DORMANT: 'DORMANT' }
const KIND_RANK: Record<Kind, number> = { DORMANT: 0, UNREST: 1, ERUPT: 2 }

interface Volcano {
  id: string
  name: string
  country: string
  lat: number
  lng: number
  summitFt: number
  plumeFL: number   // VAAC reported recent plume-top flight level
  kind: Kind
  vaac: string
  ventNm: number    // base-radius of immediate vent hazard
}

/* ----- 40 globally significant volcanoes (Smithsonian GVP + recent VAAC bulletins) ----- */
const VOLCANOES: Volcano[] = [
  // Pacific Northwest / North America (Anchorage + Washington VAAC)
  { id: 'VHR-AK', name: 'Mt Veniaminof', country: 'USA-AK', lat: 56.20, lng: -159.39, summitFt: 8225, plumeFL: 180, kind: 'UNREST', vaac: 'ANC', ventNm: 6 },
  { id: 'GRT-AK', name: 'Great Sitkin', country: 'USA-AK', lat: 52.08, lng: -176.13, summitFt: 5709, plumeFL: 200, kind: 'ERUPT', vaac: 'ANC', ventNm: 5 },
  { id: 'CLV-AK', name: 'Cleveland', country: 'USA-AK', lat: 52.83, lng: -169.94, summitFt: 5675, plumeFL: 220, kind: 'ERUPT', vaac: 'ANC', ventNm: 5 },
  { id: 'PVL-AK', name: 'Pavlof', country: 'USA-AK', lat: 55.42, lng: -161.89, summitFt: 8261, plumeFL: 250, kind: 'UNREST', vaac: 'ANC', ventNm: 5 },
  { id: 'SHV-AK', name: 'Shishaldin', country: 'USA-AK', lat: 54.76, lng: -163.97, summitFt: 9373, plumeFL: 280, kind: 'ERUPT', vaac: 'ANC', ventNm: 6 },
  { id: 'STH-WA', name: 'Mt St Helens', country: 'USA-WA', lat: 46.20, lng: -122.18, summitFt: 8366, plumeFL: 150, kind: 'DORMANT', vaac: 'WAS', ventNm: 5 },
  { id: 'KIL-HI', name: 'Kilauea', country: 'USA-HI', lat: 19.42, lng: -155.29, summitFt: 4091, plumeFL: 120, kind: 'ERUPT', vaac: 'WAS', ventNm: 4 },
  { id: 'MAU-HI', name: 'Mauna Loa', country: 'USA-HI', lat: 19.48, lng: -155.60, summitFt: 13681, plumeFL: 200, kind: 'UNREST', vaac: 'WAS', ventNm: 6 },
  // Central + South America (Washington / Buenos Aires VAAC)
  { id: 'POP-MX', name: 'Popocatepetl', country: 'MEX', lat: 19.02, lng: -98.62, summitFt: 17802, plumeFL: 280, kind: 'ERUPT', vaac: 'WAS', ventNm: 8 },
  { id: 'FUE-GT', name: 'Fuego', country: 'GTM', lat: 14.47, lng: -90.88, summitFt: 12346, plumeFL: 220, kind: 'ERUPT', vaac: 'WAS', ventNm: 6 },
  { id: 'PAC-CL', name: 'Villarrica', country: 'CHL', lat: -39.42, lng: -71.93, summitFt: 9341, plumeFL: 200, kind: 'UNREST', vaac: 'BUE', ventNm: 5 },
  { id: 'SAB-EC', name: 'Sangay', country: 'ECU', lat: -2.00, lng: -78.34, summitFt: 17158, plumeFL: 260, kind: 'ERUPT', vaac: 'BUE', ventNm: 6 },
  { id: 'COT-EC', name: 'Cotopaxi', country: 'ECU', lat: -0.68, lng: -78.44, summitFt: 19347, plumeFL: 300, kind: 'UNREST', vaac: 'BUE', ventNm: 7 },
  { id: 'RUA-PE', name: 'Ubinas', country: 'PER', lat: -16.36, lng: -70.90, summitFt: 18610, plumeFL: 280, kind: 'UNREST', vaac: 'BUE', ventNm: 6 },
  { id: 'NLR-CL', name: 'Nevados de Chillan', country: 'CHL', lat: -36.86, lng: -71.38, summitFt: 10545, plumeFL: 180, kind: 'UNREST', vaac: 'BUE', ventNm: 5 },
  // Iceland + North Atlantic (London VAAC)
  { id: 'EYJ-IS', name: 'Eyjafjallajokull', country: 'ISL', lat: 63.63, lng: -19.62, summitFt: 5417, plumeFL: 350, kind: 'DORMANT', vaac: 'LON', ventNm: 6 },
  { id: 'KAT-IS', name: 'Katla', country: 'ISL', lat: 63.63, lng: -19.05, summitFt: 4961, plumeFL: 380, kind: 'UNREST', vaac: 'LON', ventNm: 7 },
  { id: 'GRI-IS', name: 'Grimsvotn', country: 'ISL', lat: 64.42, lng: -17.33, summitFt: 5659, plumeFL: 400, kind: 'UNREST', vaac: 'LON', ventNm: 7 },
  { id: 'FAG-IS', name: 'Fagradalsfjall', country: 'ISL', lat: 63.90, lng: -22.27, summitFt: 1273, plumeFL: 120, kind: 'ERUPT', vaac: 'LON', ventNm: 5 },
  { id: 'HEK-IS', name: 'Hekla', country: 'ISL', lat: 63.99, lng: -19.67, summitFt: 4892, plumeFL: 320, kind: 'UNREST', vaac: 'LON', ventNm: 6 },
  // Europe / Med (Toulouse VAAC)
  { id: 'ETN-IT', name: 'Etna', country: 'ITA', lat: 37.75, lng: 14.99, summitFt: 11014, plumeFL: 280, kind: 'ERUPT', vaac: 'TOU', ventNm: 7 },
  { id: 'STR-IT', name: 'Stromboli', country: 'ITA', lat: 38.79, lng: 15.21, summitFt: 3038, plumeFL: 140, kind: 'ERUPT', vaac: 'TOU', ventNm: 4 },
  { id: 'VES-IT', name: 'Vesuvius', country: 'ITA', lat: 40.82, lng: 14.43, summitFt: 4203, plumeFL: 200, kind: 'DORMANT', vaac: 'TOU', ventNm: 5 },
  { id: 'CMP-IT', name: 'Campi Flegrei', country: 'ITA', lat: 40.83, lng: 14.14, summitFt: 1411, plumeFL: 180, kind: 'UNREST', vaac: 'TOU', ventNm: 5 },
  // Africa / Indian Ocean (Toulouse / Tolagnaro VAAC)
  { id: 'NYI-CD', name: 'Nyiragongo', country: 'COD', lat: -1.52, lng: 29.25, summitFt: 11380, plumeFL: 220, kind: 'UNREST', vaac: 'TOU', ventNm: 6 },
  { id: 'NYM-CD', name: 'Nyamuragira', country: 'COD', lat: -1.41, lng: 29.20, summitFt: 10033, plumeFL: 200, kind: 'ERUPT', vaac: 'TOU', ventNm: 5 },
  { id: 'PIT-RE', name: 'Piton de la Fournaise', country: 'REU', lat: -21.24, lng: 55.71, summitFt: 8635, plumeFL: 160, kind: 'ERUPT', vaac: 'TOL', ventNm: 4 },
  // Indonesia / SE-Asia (Darwin VAAC)
  { id: 'KRA-ID', name: 'Krakatoa', country: 'IDN', lat: -6.10, lng: 105.42, summitFt: 2667, plumeFL: 200, kind: 'UNREST', vaac: 'DRW', ventNm: 5 },
  { id: 'MER-ID', name: 'Merapi', country: 'IDN', lat: -7.54, lng: 110.45, summitFt: 9551, plumeFL: 240, kind: 'ERUPT', vaac: 'DRW', ventNm: 6 },
  { id: 'SEM-ID', name: 'Semeru', country: 'IDN', lat: -8.11, lng: 112.92, summitFt: 12060, plumeFL: 250, kind: 'ERUPT', vaac: 'DRW', ventNm: 6 },
  { id: 'IBU-ID', name: 'Ibu', country: 'IDN', lat: 1.49, lng: 127.63, summitFt: 4239, plumeFL: 180, kind: 'ERUPT', vaac: 'DRW', ventNm: 4 },
  { id: 'LWT-ID', name: 'Lewotobi', country: 'IDN', lat: -8.53, lng: 122.78, summitFt: 5454, plumeFL: 320, kind: 'ERUPT', vaac: 'DRW', ventNm: 6 },
  { id: 'MAY-PH', name: 'Mayon', country: 'PHL', lat: 13.26, lng: 123.69, summitFt: 8077, plumeFL: 200, kind: 'UNREST', vaac: 'DRW', ventNm: 5 },
  { id: 'TAA-PH', name: 'Taal', country: 'PHL', lat: 14.00, lng: 120.99, summitFt: 1020, plumeFL: 150, kind: 'UNREST', vaac: 'DRW', ventNm: 5 },
  // Japan / Kamchatka (Tokyo VAAC)
  { id: 'SAK-JP', name: 'Sakurajima', country: 'JPN', lat: 31.59, lng: 130.66, summitFt: 3665, plumeFL: 200, kind: 'ERUPT', vaac: 'TYO', ventNm: 5 },
  { id: 'ASO-JP', name: 'Aso', country: 'JPN', lat: 32.88, lng: 131.10, summitFt: 5223, plumeFL: 180, kind: 'UNREST', vaac: 'TYO', ventNm: 5 },
  { id: 'SUW-JP', name: 'Suwanosejima', country: 'JPN', lat: 29.64, lng: 129.71, summitFt: 2664, plumeFL: 160, kind: 'ERUPT', vaac: 'TYO', ventNm: 4 },
  { id: 'SHE-RU', name: 'Sheveluch', country: 'RUS', lat: 56.65, lng: 161.36, summitFt: 10771, plumeFL: 350, kind: 'ERUPT', vaac: 'TYO', ventNm: 7 },
  { id: 'KLY-RU', name: 'Klyuchevskoy', country: 'RUS', lat: 56.06, lng: 160.64, summitFt: 15584, plumeFL: 380, kind: 'ERUPT', vaac: 'TYO', ventNm: 7 },
  // Pacific / NZ (Wellington VAAC)
  { id: 'WHK-NZ', name: 'Whakaari (White Is.)', country: 'NZL', lat: -37.52, lng: 177.18, summitFt: 1053, plumeFL: 120, kind: 'UNREST', vaac: 'WLG', ventNm: 4 },
]

/* ---------- Math helpers ---------- */
const R_NM = 3440.065
function distNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.sqrt(a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function destPoint(lat: number, lng: number, brgDeg: number, nm: number): [number, number] {
  const δ = nm / R_NM
  const θ = brgDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  const φ2 = Math.asin(sinφ2)
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2)
  return [(((λ2 * 180 / Math.PI) + 540) % 360) - 180, φ2 * 180 / Math.PI]
}

/* SOURCES + LAYERS */
const SRC = { CONE: 'va-cone', VENT: 'va-vent', PIN: 'va-pin', PLBL: 'va-plbl', HALO: 'va-halo', LINK: 'va-link', LBL: 'va-lbl' }
const LYR = { CONE_F: 'va-cone-f', CONE_L: 'va-cone-l', VENT_L: 'va-vent-l', PIN_L: 'va-pin-l', PLBL_L: 'va-plbl-l', HALO_L: 'va-halo-l', LINK_L: 'va-link-l', LBL_L: 'va-lbl-l' }

interface Row {
  f: VaFlight
  tier: Tier
  vol: Volcano | null
  insideNm: number   // signed nm inside cone (negative = outside)
  tEnterMin: number  // minutes to enter cone (Infinity if never)
  exposure: number   // 0..1
}

interface Drift {
  vol: Volcano
  windFromDeg: number
  windKts: number
  samples: number
  driftToDeg: number  // azimuth the cone extends toward
  driftNm: number     // cone length
  halfAngleDeg: number
  cone: [number, number][]  // polygon (lng,lat)
  insideCount: number
  worstTier: Tier
}

function buildCone(centerLat: number, centerLng: number, toDeg: number, lengthNm: number, halfAngleDeg: number): [number, number][] {
  const pts: [number, number][] = []
  pts.push([centerLng, centerLat])
  const steps = 14
  // Right edge sweep along outer arc
  for (let i = 0; i <= steps; i++) {
    const a = -halfAngleDeg + (i / steps) * (2 * halfAngleDeg)
    pts.push(destPoint(centerLat, centerLng, toDeg + a, lengthNm))
  }
  pts.push([centerLng, centerLat])
  return pts
}

function pointInPoly(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside
  }
  return inside
}

export default function VolcanicAshMonitor({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [sampleNm, setSampleNm] = useState(220)
  const [horizonH, setHorizonH] = useState(6)
  const [minFL, setMinFL] = useState(100)
  const [windMult, setWindMult] = useState(1.0)
  const [showOvl, setShowOvl] = useState(true)
  const [showCone, setShowCone] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [kindOn, setKindOn] = useState<Record<Kind, boolean>>({ ERUPT: true, UNREST: true, DORMANT: false })
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [tab, setTab] = useState<'V' | 'A'>('V')
  const [q, setQ] = useState('')

  /* Compute drift per volcano from live wind samples */
  const drifts = useMemo<Drift[]>(() => {
    const out: Drift[] = []
    for (const v of VOLCANOES) {
      if (!kindOn[v.kind]) continue
      let u = 0, vv = 0, w = 0, n = 0
      for (const f of flights) {
        if (f.ground) continue
        if ((f.altitudeFt / 100) < minFL) continue
        if (f.windDir == null || f.windKts == null || f.windKts <= 0) continue
        const d = distNm(v.lat, v.lng, f.lat, f.lng)
        if (d > sampleNm) continue
        const weight = 1 / (1 + d / 50)
        const dirRad = f.windDir * Math.PI / 180
        // meteo: wind FROM. u/v point TOWARD origin (sign-flipped)
        u += -Math.sin(dirRad) * f.windKts * weight
        vv += -Math.cos(dirRad) * f.windKts * weight
        w += weight
        n++
      }
      let windFrom = 0, windKts = 0
      if (w > 0) {
        const um = u / w, vm = vv / w
        windKts = Math.sqrt(um * um + vm * vm)
        const towardRad = Math.atan2(-um, -vm)  // back to FROM by negating
        windFrom = ((towardRad * 180 / Math.PI) + 360) % 360
      } else {
        // fallback: zonal wind 270/30kt (westerly default)
        windFrom = 270
        windKts = 18
      }
      const wk = windKts * windMult
      const driftTo = (windFrom + 180) % 360
      const driftNm = Math.max(20, wk * horizonH)
      const halfAng = Math.min(35, Math.max(8, 35 / Math.max(0.5, Math.sqrt(wk / 15))))
      const cone = buildCone(v.lat, v.lng, driftTo, driftNm, halfAng)
      out.push({ vol: v, windFromDeg: windFrom, windKts: wk, samples: n, driftToDeg: driftTo, driftNm, halfAngleDeg: halfAng, cone, insideCount: 0, worstTier: 'CLEAR' })
    }
    return out
  }, [flights, kindOn, sampleNm, minFL, horizonH, windMult])

  /* Per-aircraft classification */
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if ((f.altitudeFt / 100) < Math.max(20, minFL - 50)) continue
      let bestTier: Tier = 'CLEAR'
      let bestVol: Volcano | null = null
      let bestExp = 0
      let bestInside = -Infinity
      let bestEnter = Infinity
      for (const d of drifts) {
        if ((f.altitudeFt / 100) > d.vol.plumeFL + 30) continue
        const inside = pointInPoly(f.lng, f.lat, d.cone)
        const toVol = distNm(f.lat, f.lng, d.vol.lat, d.vol.lng)
        // forward project current ground vector
        let tEnter = Infinity
        if (!inside && f.velocityKts > 60) {
          const stepMin = 1
          const steps = Math.min(60, Math.ceil(horizonH * 60 / stepMin))
          for (let s = 1; s <= steps; s++) {
            const nm = (f.velocityKts / 60) * s * stepMin
            const [plng, plat] = destPoint(f.lat, f.lng, f.track || 0, nm)
            if (pointInPoly(plng, plat, d.cone)) { tEnter = s * stepMin; break }
          }
        }
        let tier: Tier = 'CLEAR'
        let exp = 0
        if (inside) { tier = 'IN_ASH'; exp = Math.min(1, 1 - toVol / Math.max(d.driftNm, 30)) }
        else if (tEnter <= 5) { tier = 'CLOSE'; exp = 0.7 }
        else if (tEnter < Infinity) { tier = 'WATCH'; exp = 0.4 * (1 - tEnter / (horizonH * 60)) }
        if (TIER_RANK[tier] > TIER_RANK[bestTier] || (tier === bestTier && exp > bestExp)) {
          bestTier = tier; bestVol = d.vol; bestExp = exp
          bestInside = inside ? toVol : -toVol
          bestEnter = tEnter
        }
      }
      if (bestTier !== 'CLEAR') {
        result.push({ f, tier: bestTier, vol: bestVol, insideNm: bestInside, tEnterMin: bestEnter, exposure: bestExp })
      }
    }
    // Rollup into drifts
    for (const d of drifts) {
      let worst: Tier = 'CLEAR', cnt = 0
      for (const r of result) {
        if (r.vol?.id === d.vol.id) {
          cnt++
          if (TIER_RANK[r.tier] > TIER_RANK[worst]) worst = r.tier
        }
      }
      d.insideCount = cnt
      d.worstTier = worst
    }
    return result
  }, [flights, drifts, horizonH, minFL])

  /* Counters */
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CLEAR: 0, WATCH: 0, CLOSE: 0, IN_ASH: 0 }
    for (const r of rows) c[r.tier]++
    return c
  }, [rows])

  const eruptingCount = drifts.filter(d => d.vol.kind === 'ERUPT').length
  const meanWind = drifts.length ? Math.round(drifts.reduce((s, d) => s + d.windKts, 0) / drifts.length) : 0

  /* MapLibre layers */
  useEffect(() => {
    if (!map) return
    const m = map
    const ensureSrc = (id: string, data: any) => {
      const src = m.getSource(id) as any
      if (src) src.setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }

    // Cones
    const coneFeats: any[] = []
    for (const d of drifts) {
      coneFeats.push({ type: 'Feature', properties: { kind: d.vol.kind, id: d.vol.id }, geometry: { type: 'Polygon', coordinates: [d.cone] } })
    }
    ensureSrc(SRC.CONE, { type: 'FeatureCollection', features: coneFeats })

    // Volcano pins (use triangle char as text)
    const pinFeats: any[] = []
    const plblFeats: any[] = []
    const ventFeats: any[] = []
    for (const d of drifts) {
      const v = d.vol
      pinFeats.push({ type: 'Feature', properties: { kind: v.kind }, geometry: { type: 'Point', coordinates: [v.lng, v.lat] } })
      plblFeats.push({ type: 'Feature', properties: { lbl: `${v.id}  FL${v.plumeFL}` }, geometry: { type: 'Point', coordinates: [v.lng, v.lat] } })
      // vent ring
      const ring: [number, number][] = []
      for (let i = 0; i <= 24; i++) ring.push(destPoint(v.lat, v.lng, (i / 24) * 360, v.ventNm))
      ventFeats.push({ type: 'Feature', properties: { kind: v.kind }, geometry: { type: 'Polygon', coordinates: [ring] } })
    }
    ensureSrc(SRC.PIN, { type: 'FeatureCollection', features: pinFeats })
    ensureSrc(SRC.PLBL, { type: 'FeatureCollection', features: plblFeats })
    ensureSrc(SRC.VENT, { type: 'FeatureCollection', features: ventFeats })

    // Per-aircraft halos + labels + projection links
    const haloFeats: any[] = []
    const lblFeats: any[] = []
    const linkFeats: any[] = []
    for (const r of rows) {
      if (tierFilter && r.tier !== tierFilter) continue
      const radius = 6 + r.exposure * 18
      const ring: [number, number][] = []
      for (let i = 0; i <= 24; i++) ring.push(destPoint(r.f.lat, r.f.lng, (i / 24) * 360, radius))
      haloFeats.push({ type: 'Feature', properties: { tier: r.tier }, geometry: { type: 'Polygon', coordinates: [ring] } })
      lblFeats.push({ type: 'Feature', properties: { lbl: `${r.f.callsign || r.f.icao} · ${r.tier}${r.vol ? ` · ${r.vol.id}` : ''}`, tier: r.tier }, geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] } })
      if (r.tier === 'WATCH' && isFinite(r.tEnterMin)) {
        const nm = (r.f.velocityKts / 60) * r.tEnterMin
        const [elng, elat] = destPoint(r.f.lat, r.f.lng, r.f.track || 0, nm)
        linkFeats.push({ type: 'Feature', properties: { tier: r.tier }, geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [elng, elat]] } })
      }
    }
    ensureSrc(SRC.HALO, { type: 'FeatureCollection', features: haloFeats })
    ensureSrc(SRC.LBL, { type: 'FeatureCollection', features: lblFeats })
    ensureSrc(SRC.LINK, { type: 'FeatureCollection', features: linkFeats })

    const tierExpr: any = ['match', ['get', 'tier'], 'IN_ASH', TIER_COLOR.IN_ASH, 'CLOSE', TIER_COLOR.CLOSE, 'WATCH', TIER_COLOR.WATCH, TIER_COLOR.CLEAR]
    const kindExpr: any = ['match', ['get', 'kind'], 'ERUPT', KIND_COLOR.ERUPT, 'UNREST', KIND_COLOR.UNREST, KIND_COLOR.DORMANT]

    if (!m.getLayer(LYR.CONE_F)) {
      m.addLayer({ id: LYR.CONE_F, type: 'fill', source: SRC.CONE, paint: { 'fill-color': kindExpr, 'fill-opacity': showCone && showOvl ? 0.12 : 0 } })
      m.addLayer({ id: LYR.CONE_L, type: 'line', source: SRC.CONE, paint: { 'line-color': kindExpr, 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': showCone && showOvl ? 0.75 : 0 } })
      m.addLayer({ id: LYR.VENT_L, type: 'line', source: SRC.VENT, paint: { 'line-color': kindExpr, 'line-width': 1.6, 'line-opacity': showOvl ? 0.9 : 0 } })
      m.addLayer({
        id: LYR.PIN_L, type: 'symbol', source: SRC.PIN,
        layout: { 'text-field': '▲', 'text-size': 16, 'text-allow-overlap': true },
        paint: { 'text-color': kindExpr, 'text-halo-color': '#020617', 'text-halo-width': 1.4, 'text-opacity': showOvl ? 1 : 0 },
      })
      m.addLayer({
        id: LYR.PLBL_L, type: 'symbol', source: SRC.PLBL,
        layout: { 'text-field': ['get', 'lbl'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#020617', 'text-halo-width': 1.2, 'text-opacity': showLbl && showOvl ? 0.95 : 0 },
      })
      m.addLayer({ id: LYR.HALO_L, type: 'line', source: SRC.HALO, paint: { 'line-color': tierExpr, 'line-width': 1.6, 'line-opacity': showOvl ? 0.92 : 0 } })
      m.addLayer({ id: LYR.LINK_L, type: 'line', source: SRC.LINK, paint: { 'line-color': '#0ea5e9', 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': showLink && showOvl ? 0.85 : 0 } })
      m.addLayer({
        id: LYR.LBL_L, type: 'symbol', source: SRC.LBL,
        layout: { 'text-field': ['get', 'lbl'], 'text-size': 9.5, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': true },
        paint: { 'text-color': tierExpr, 'text-halo-color': '#020617', 'text-halo-width': 1.2, 'text-opacity': showLbl && showOvl ? 1 : 0 },
      })
    } else {
      m.setPaintProperty(LYR.CONE_F, 'fill-opacity', showCone && showOvl ? 0.12 : 0)
      m.setPaintProperty(LYR.CONE_L, 'line-opacity', showCone && showOvl ? 0.75 : 0)
      m.setPaintProperty(LYR.VENT_L, 'line-opacity', showOvl ? 0.9 : 0)
      m.setPaintProperty(LYR.PIN_L, 'text-opacity', showOvl ? 1 : 0)
      m.setPaintProperty(LYR.PLBL_L, 'text-opacity', showLbl && showOvl ? 0.95 : 0)
      m.setPaintProperty(LYR.HALO_L, 'line-opacity', showOvl ? 0.92 : 0)
      m.setPaintProperty(LYR.LINK_L, 'line-opacity', showLink && showOvl ? 0.85 : 0)
      m.setPaintProperty(LYR.LBL_L, 'text-opacity', showLbl && showOvl ? 1 : 0)
    }

    return () => {
      try {
        for (const id of [LYR.LBL_L, LYR.LINK_L, LYR.HALO_L, LYR.PLBL_L, LYR.PIN_L, LYR.VENT_L, LYR.CONE_L, LYR.CONE_F]) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC.LBL, SRC.LINK, SRC.HALO, SRC.PLBL, SRC.PIN, SRC.VENT, SRC.CONE]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, drifts, rows, showOvl, showCone, showLink, showLbl, tierFilter])

  /* Search filter */
  const qq = q.trim().toLowerCase()
  const volMatch = (v: Volcano) => !qq || v.id.toLowerCase().includes(qq) || v.name.toLowerCase().includes(qq) || v.country.toLowerCase().includes(qq) || v.vaac.toLowerCase().includes(qq)
  const rowMatch = (r: Row) => !qq || (r.f.callsign || '').toLowerCase().includes(qq) || (r.f.icao || '').toLowerCase().includes(qq) || (r.f.type || '').toLowerCase().includes(qq) || (r.f.operator || '').toLowerCase().includes(qq) || (r.vol?.id || '').toLowerCase().includes(qq)

  const sortedVols = useMemo(() => {
    return [...drifts].filter(d => volMatch(d.vol)).sort((a, b) => {
      const dt = TIER_RANK[b.worstTier] - TIER_RANK[a.worstTier]
      if (dt !== 0) return dt
      const dk = KIND_RANK[b.vol.kind] - KIND_RANK[a.vol.kind]
      if (dk !== 0) return dk
      return b.windKts - a.windKts
    })
  }, [drifts, qq])

  const sortedRows = useMemo(() => {
    return [...rows].filter(r => (!tierFilter || r.tier === tierFilter) && rowMatch(r)).sort((a, b) => {
      const dt = TIER_RANK[b.tier] - TIER_RANK[a.tier]
      if (dt !== 0) return dt
      return b.exposure - a.exposure
    })
  }, [rows, qq, tierFilter])

  /* SVG plume strip diagram */
  const SVG_W = 360, SVG_H = 160
  const top = sortedVols.slice(0, 12)
  const maxDrift = Math.max(120, ...top.map(d => d.driftNm))

  return (
    <div className="absolute right-3 top-16 z-30 w-[400px] max-h-[calc(100vh-7rem)] overflow-y-auto bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl">
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur-xl px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Hazard · VAAC</div>
          <div className="text-sm font-semibold text-slate-100">Volcanic Ash Monitor</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier counters */}
      <div className="px-4 py-2.5 grid grid-cols-4 gap-1.5 border-b border-slate-900">
        {TIER_ORDER.map(t => {
          const active = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(active ? null : t)}
              className={`px-2 py-1.5 rounded-lg border text-[10px] uppercase tracking-wider font-semibold transition ${active ? 'border-sky-500/50 bg-sky-500/15 text-sky-100' : 'border-slate-800 bg-slate-900/50 text-slate-300 hover:bg-slate-800/70'}`}>
              <div className="flex items-center justify-center gap-1.5"><span className="size-1.5 rounded-full" style={{ background: TIER_COLOR[t] }} /><span>{t === 'IN_ASH' ? 'IN-ASH' : t}</span></div>
              <div className="text-base font-bold text-slate-100 mt-0.5">{counts[t]}</div>
            </button>
          )
        })}
      </div>

      {/* Summary */}
      <div className="px-4 py-2.5 grid grid-cols-3 gap-1.5 border-b border-slate-900">
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Erupting</div>
          <div className="text-sm font-semibold text-rose-300">{eruptingCount}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">In-ash</div>
          <div className="text-sm font-semibold text-slate-100">{counts.IN_ASH}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Wind-kt</div>
          <div className="text-sm font-semibold text-slate-100">{meanWind}</div>
        </div>
      </div>

      {/* SVG plume strip */}
      <div className="px-4 py-2.5 border-b border-slate-900">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">Plume drift strip · top 12</div>
        <svg width={SVG_W} height={SVG_H} className="block">
          <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#0b1220" />
          {[0.25, 0.5, 0.75].map(t => (
            <line key={t} x1={SVG_W * t} y1={0} x2={SVG_W * t} y2={SVG_H} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="2,3" />
          ))}
          {top.map((d, i) => {
            const y = 8 + i * 12
            const w = (d.driftNm / maxDrift) * (SVG_W - 70)
            return (
              <g key={d.vol.id}>
                <text x={4} y={y + 4} fontSize={8} fill="#94a3b8">{d.vol.id}</text>
                <rect x={60} y={y} width={w} height={6} fill={KIND_COLOR[d.vol.kind]} fillOpacity={0.5} />
                <rect x={60} y={y} width={w} height={6} fill="none" stroke={KIND_COLOR[d.vol.kind]} strokeWidth={0.7} />
                {/* aircraft dots */}
                {rows.filter(r => r.vol?.id === d.vol.id).map(r => {
                  const nm = Math.max(0, -r.insideNm < 0 ? r.insideNm : Math.abs(r.insideNm))
                  const ratio = Math.min(1, nm / d.driftNm)
                  const xx = 60 + ratio * w
                  return <circle key={r.f.icao} cx={xx} cy={y + 3} r={2} fill={TIER_COLOR[r.tier]} stroke="#020617" strokeWidth={0.4} />
                })}
                <text x={SVG_W - 4} y={y + 4} textAnchor="end" fontSize={8} fill="#64748b">{Math.round(d.windKts)}kt {Math.round(d.driftToDeg)}°</text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Sliders */}
      <div className="px-4 py-2.5 grid grid-cols-2 gap-x-3 gap-y-2 border-b border-slate-900">
        {[
          ['SAMPLE-RNG', sampleNm, 50, 500, 10, 'nm', (v: number) => setSampleNm(v)],
          ['HORIZON', horizonH, 1, 12, 1, 'h', (v: number) => setHorizonH(v)],
          ['MIN-FL', minFL, 50, 400, 10, '', (v: number) => setMinFL(v)],
          ['WIND-MULT', windMult, 0.5, 2.0, 0.1, 'x', (v: number) => setWindMult(parseFloat(v.toFixed(1)))],
        ].map(([label, val, mn, mx, st, unit, set]: any) => (
          <label key={label} className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-widest text-slate-500 flex items-center justify-between">
              <span>{label}</span><span className="text-slate-300 font-mono">{val}{unit}</span>
            </span>
            <input type="range" min={mn} max={mx} step={st} value={val} onChange={e => set(parseFloat(e.target.value))} className="accent-sky-500" />
          </label>
        ))}
      </div>

      {/* Kind chips + toggles */}
      <div className="px-4 py-2.5 border-b border-slate-900 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(KIND_COLOR) as Kind[]).map(k => {
            const on = kindOn[k]
            return (
              <button key={k} onClick={() => setKindOn(o => ({ ...o, [k]: !o[k] }))}
                className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border transition ${on ? 'border-sky-500/50 bg-sky-500/15 text-sky-100' : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:bg-slate-800/70'}`}>
                <span className="inline-block size-1.5 rounded-full mr-1 align-middle" style={{ background: KIND_COLOR[k] }} />{KIND_LABEL[k]}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          {[['OVL', showOvl, setShowOvl], ['CONE', showCone, setShowCone], ['LINK', showLink, setShowLink], ['LBL', showLbl, setShowLbl]].map(([lbl, v, s]: any) => (
            <button key={lbl} onClick={() => s(!v)}
              className={`px-2 py-0.5 rounded uppercase tracking-wider border ${v ? 'border-sky-500/50 bg-sky-500/15 text-sky-100' : 'border-slate-800 bg-slate-900/50 text-slate-400'}`}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* Tabs + search */}
      <div className="px-4 pt-2.5 pb-2 border-b border-slate-900 space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          <button onClick={() => setTab('V')} className={`px-2 py-1 rounded-lg text-[11px] uppercase tracking-wider border ${tab === 'V' ? 'border-sky-500/50 bg-sky-500/15 text-sky-100' : 'border-slate-800 bg-slate-900/50 text-slate-400'}`}>Volcanoes · {drifts.length}</button>
          <button onClick={() => setTab('A')} className={`px-2 py-1 rounded-lg text-[11px] uppercase tracking-wider border ${tab === 'A' ? 'border-sky-500/50 bg-sky-500/15 text-sky-100' : 'border-slate-800 bg-slate-900/50 text-slate-400'}`}>Aircraft · {rows.length}</button>
        </div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={tab === 'V' ? 'Search id / name / country / vaac' : 'Search callsign / type / operator / volcano'}
          className="w-full px-2.5 py-1.5 bg-slate-900/70 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
      </div>

      {/* Lists */}
      <div className="px-4 py-2 space-y-1 max-h-[42vh] overflow-y-auto">
        {tab === 'V' && sortedVols.map(d => (
          <button key={d.vol.id} onClick={() => onFlyLatLng(d.vol.lat, d.vol.lng, 6)}
            className="w-full text-left bg-slate-900/40 hover:bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-lg px-2.5 py-1.5 transition flex gap-2 group">
            <div className="w-0.5 self-stretch rounded-full" style={{ background: TIER_COLOR[d.worstTier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] font-mono font-semibold text-slate-100">{d.vol.id}</span>
                  <span className="text-[10px] text-slate-400 truncate">{d.vol.name}</span>
                </div>
                <span className="text-[9px] font-mono uppercase px-1.5 py-0 rounded" style={{ color: KIND_COLOR[d.vol.kind], background: KIND_COLOR[d.vol.kind] + '22' }}>{KIND_LABEL[d.vol.kind]}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono mt-0.5">
                <span>{d.vol.country} · {d.vol.vaac} · FL{d.vol.plumeFL}</span>
                <span style={{ color: TIER_COLOR[d.worstTier] }}>{d.insideCount}↯</span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                <span>wind {Math.round(d.windFromDeg).toString().padStart(3, '0')}°/{Math.round(d.windKts)}kt</span>
                <span>drift {Math.round(d.driftToDeg).toString().padStart(3, '0')}° · {Math.round(d.driftNm)}nm</span>
              </div>
              <div className="text-[10px] text-slate-600 font-mono">samples {d.samples} · half-ang {Math.round(d.halfAngleDeg)}°</div>
            </div>
          </button>
        ))}
        {tab === 'A' && sortedRows.map(r => (
          <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
            className="w-full text-left bg-slate-900/40 hover:bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-lg px-2.5 py-1.5 transition flex gap-2">
            <div className="w-0.5 self-stretch rounded-full" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] font-mono font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                  <span className="text-[9px] text-slate-500 uppercase">{r.f.type || '—'}</span>
                </div>
                <span className="text-[9px] font-mono uppercase px-1.5 py-0 rounded" style={{ color: TIER_COLOR[r.tier], background: TIER_COLOR[r.tier] + '22' }}>{r.tier === 'IN_ASH' ? 'IN-ASH' : r.tier}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono mt-0.5">
                <span>FL{Math.round(r.f.altitudeFt / 100)} · {Math.round(r.f.velocityKts)}kt · {Math.round(r.f.track)}°</span>
                <span>{r.vol?.id || '—'}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="text-slate-500">{r.tier === 'IN_ASH' ? `inside ${Math.round(Math.abs(r.insideNm))}nm` : isFinite(r.tEnterMin) ? `enter T+${Math.round(r.tEnterMin)}m` : 'no entry'}</span>
                <span className="text-slate-600">{r.f.operator || ''}</span>
              </div>
              <div className="h-1 mt-1 rounded-full bg-slate-800/70 overflow-hidden">
                <div className="h-full" style={{ width: `${Math.round(r.exposure * 100)}%`, background: TIER_COLOR[r.tier] }} />
              </div>
            </div>
          </button>
        ))}
        {tab === 'V' && sortedVols.length === 0 && <div className="text-[11px] text-slate-600 italic text-center py-4">No volcanoes match · adjust kind chips</div>}
        {tab === 'A' && sortedRows.length === 0 && <div className="text-[11px] text-slate-600 italic text-center py-4">No aircraft in ash exposure envelope</div>}
      </div>
    </div>
  )
}
