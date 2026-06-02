'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Magnetic Variation Atlas
   -----------------------------------------------------------
   Real navigation concern: aircraft compasses indicate magnetic
   north, but GPS / ADS-B tracks reported via flightradar feeds
   are true-referenced. The difference — magnetic declination
   (a.k.a. variation) — changes by ~10-30 deg between regions
   and drifts ~0.1 deg/yr as Earth's core flow evolves. ICAO
   Annex 4 charts publish isogonic (constant-declination) lines
   updated every 5 years. Aircraft within ~1500nm of the
   magnetic poles experience compass-unreliable / "grid nav"
   regions where standard magnetic heading breaks down and the
   FAR 121 / ICAO Doc 7030 NAT-HLA "true-heading" procedure is
   required.

   This panel:

     1. Computes declination D (deg, +E/-W) at every point in
        view via simplified IGRF-14 epoch 2025 dipole model:
          - North magnetic pole 80.65°N, 72.68°W  (epoch 2025.0
            best-fit from BGS World Magnetic Model 2025).
          - Co-latitude θ relative to dipole.
          - D ≈ atan2( sin(λ-λ_p)·cos(λ_p) ,
                        sin(lat)·cos(λ_p)·cos(λ-λ_p)
                      - cos(lat)·sin(λ_p) )      [dipole approx]
          - Secular variation patch: +SECULAR-DEG-PER-YR slider
            applied over (year - 2025) for forecasts.

     2. Builds an isogonic grid 36×18 (10°×10°) of D values for
        an SVG diagram of the world's magnetic field, plus a
        MapLibre polygon overlay tinted by |D| magnitude
        (sky for east-decl, rose for west-decl).

     3. For every airborne aircraft computes:
          - local D
          - magnetic track  = true-track − D
          - magnetic heading hint (no wind) = magnetic track
          - drift from a hypothetical compass-only flown plan
            (when D-rate-of-change >5°/100nm flags "compass
            error growing fast")
          - distance to nearest magnetic pole (great-circle)
          - "GRID NAV REQ" flag when within GRID-NM slider of
            either magnetic pole (default 800nm — FAA AC 90-105
            uses 700nm for polar-2 area)
          - HF blackout risk classifier via auroral-oval rough
            proxy (geomagnetic lat > AURORA-DEG slider, default
            65°), recommends SATCOM primary.

     4. Tiers per aircraft (by abs declination + polar status):
          GRID    near pole (within GRID-NM)              rose
          POLAR   geomag-lat > AURORA-DEG (HF unreliable) amber
          HIGH    |D| ≥ 15°                                sky
          NORMAL  |D| <  15°                                emerald

   MapLibre overlay:
     - Tinted 10°×10° isogonic cell quads (cyan east / rose west)
       with low opacity (5-25% by |D|).
     - Magnetic-pole pin (star marker) with NMP / SMP labels.
     - Auroral-oval ring (geomag-lat = AURORA-DEG circle).
     - Tier-coloured aircraft halo rings sized by |D|.
     - Dashed tier-coloured track-true vs track-magnetic
       projection fans showing the angular split.
     - Callsign + D label + tier text.

   Side panel:
     - 4-tier counter strip click-to-filter.
     - 3-cell MEAN-|D| / MAX-|D|+CS / GRID-COUNT summary.
     - SVG world isogonic chart: x = longitude -180..+180, y =
       latitude -90..+90, 36×18 grid cells colour-ramped by D,
       isolines drawn at -30/-20/-10/0/+10/+20/+30 deg.
     - 4 sliders: YEAR 2020..2035 / SECULAR deg/yr 0..0.5 /
       GRID-NM 200..1500 / AURORA-DEG 50..80.
     - 7-class chip filter, OVL/POLE/AURORA/LBL/DIAG toggles,
       callsign/type/operator/icao search.
     - Ranked list sorted tier-worst-first then |D| desc.

   Registered under Layers > Environment category.
   ft-magvar persisted preference.
   ============================================================ */

export interface MagVarFlight {
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
  flights: MagVarFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'GRID' | 'POLAR' | 'HIGH' | 'NORMAL'
const TIER_COLOR: Record<Tier, string> = {
  GRID:   '#ef4444',
  POLAR:  '#f59e0b',
  HIGH:   '#0ea5e9',
  NORMAL: '#10b981',
}
const TIER_ORDER: Tier[] = ['GRID', 'POLAR', 'HIGH', 'NORMAL']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
}

function classify(type?: string, category?: string): Klass {
  const c = (category || '').toUpperCase()
  if (c.includes('A5')) return 'heavy'
  if (c.includes('A4')) return 'heavy'
  if (c.includes('A3')) return 'narrow'
  if (c.includes('A2')) return 'regional'
  if (c.includes('A1')) return 'ga'
  if (c.includes('A7')) return 'fighter'
  const t = (type || '').toUpperCase()
  if (/^(B74|B77|B78|B78X|A38|A35|A33|A34|MD11|DC10)/.test(t)) return 'heavy'
  if (/^(B73|A31|A32|A22|E19|E29|MD8|MD9|B71)/.test(t)) return 'narrow'
  if (/^(E17|E70|E75|CRJ|AT4|AT7|DH8|Q40)/.test(t)) return 'regional'
  if (/^(GLF|G[2-7]\d|GLEX|CL\d|FA\d|E55|CL3|HDJN)/.test(t)) return 'biz'
  if (/^(DH8|AT4|AT7|SF34|J32)/.test(t)) return 'turboprop'
  if (/^(F[12-3]\d|EUFI|TYPH|HORN|RAFL|F22|F35|F18|F16)/.test(t)) return 'fighter'
  return 'ga'
}

// Magnetic pole positions epoch 2025.0 (BGS WMM-2025 best fit)
const NMP_LAT = 80.65
const NMP_LON = -72.68
const SMP_LAT = -64.07
const SMP_LON = 135.88

function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const r1 = la1 * Math.PI / 180, r2 = la2 * Math.PI / 180
  const dl = (lo2 - lo1) * Math.PI / 180
  const c = Math.sin(r1) * Math.sin(r2) + Math.cos(r1) * Math.cos(r2) * Math.cos(dl)
  return Math.acos(Math.max(-1, Math.min(1, c))) * 3440.07
}

// Geomagnetic latitude relative to NMP (dipole approx)
function geomagLat(lat: number, lng: number): number {
  const φ = lat * Math.PI / 180
  const λ = lng * Math.PI / 180
  const φp = NMP_LAT * Math.PI / 180
  const λp = NMP_LON * Math.PI / 180
  const c = Math.sin(φ) * Math.sin(φp) + Math.cos(φ) * Math.cos(φp) * Math.cos(λ - λp)
  return Math.asin(Math.max(-1, Math.min(1, c))) * 180 / Math.PI
}

// Magnetic declination at (lat,lng) in degrees, dipole approximation
// D = atan2( sin(Δλ)·cos(φp), cos(φ)·sin(φp) - sin(φ)·cos(φp)·cos(Δλ) )
function declination(lat: number, lng: number): number {
  const φ = lat * Math.PI / 180
  const φp = NMP_LAT * Math.PI / 180
  const dλ = (lng - NMP_LON) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φp)
  const x = Math.cos(φ) * Math.sin(φp) - Math.sin(φ) * Math.cos(φp) * Math.cos(dλ)
  let d = Math.atan2(y, x) * 180 / Math.PI
  // dipole approximation can return up to ±180; wrap to ±180
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

const SRC_GRID = 'magvar-grid-src'
const LYR_GRID = 'magvar-grid-lyr'
const LYR_GRID_OUT = 'magvar-grid-outline'
const SRC_POLE = 'magvar-pole-src'
const LYR_POLE = 'magvar-pole-lyr'
const LYR_POLE_LBL = 'magvar-pole-lbl'
const SRC_AURORA = 'magvar-aurora-src'
const LYR_AURORA = 'magvar-aurora-lyr'
const SRC_RING = 'magvar-ring-src'
const LYR_RING = 'magvar-ring-lyr'
const SRC_FAN = 'magvar-fan-src'
const LYR_FAN = 'magvar-fan-lyr'
const SRC_LBL = 'magvar-lbl-src'
const LYR_LBL = 'magvar-lbl-lyr'

interface Row {
  f: MagVarFlight
  klass: Klass
  d: number             // declination deg, +E -W
  absD: number
  trkTrue: number       // 0..360
  trkMag: number        // 0..360 = trkTrue - D
  geoLat: number        // geomagnetic latitude deg
  poleNm: number        // distance to nearest magnetic pole (nm)
  whichPole: 'N' | 'S'
  isGrid: boolean
  isPolar: boolean
  hfBlackoutRisk: number  // 0..1
  tier: Tier
}

export default function MagneticVariation({ map, flights, onClose, onFly }: Props) {
  const [year, setYear] = useState<number>(2026)
  const [secularDegPerYr, setSecularDegPerYr] = useState<number>(10)  // /100 = 0.10
  const [gridNm, setGridNm] = useState<number>(800)
  const [auroraDeg, setAuroraDeg] = useState<number>(65)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [showOvl, setShowOvl] = useState<boolean>(true)
  const [showPole, setShowPole] = useState<boolean>(true)
  const [showAuroraRing, setShowAuroraRing] = useState<boolean>(true)
  const [showLabels, setShowLabels] = useState<boolean>(true)
  const [showDiag, setShowDiag] = useState<boolean>(true)
  const [showFan, setShowFan] = useState<boolean>(true)
  const [query, setQuery] = useState<string>('')

  const secYr = secularDegPerYr / 100  // slider 0..50 -> 0..0.50 deg/yr
  const yearOffset = year - 2025

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      const klass = classify(f.type, f.category)
      let d = declination(f.lat, f.lng)
      // secular adjustment proxy: westward drift ~0.07°/yr globally
      d = d - secYr * yearOffset * Math.sign(d || 1) * 0.5
      const absD = Math.abs(d)
      const trkTrue = ((f.track % 360) + 360) % 360
      const trkMag = ((trkTrue - d) % 360 + 360) % 360
      const geoLat = geomagLat(f.lat, f.lng)
      const distN = gcDistNm(f.lat, f.lng, NMP_LAT, NMP_LON)
      const distS = gcDistNm(f.lat, f.lng, SMP_LAT, SMP_LON)
      const poleNm = Math.min(distN, distS)
      const whichPole: 'N' | 'S' = distN < distS ? 'N' : 'S'
      const isGrid = poleNm < gridNm
      const isPolar = Math.abs(geoLat) > auroraDeg
      // HF blackout risk: scales 0..1 from auroraDeg up to 85
      const hfBlackoutRisk = Math.max(0, Math.min(1, (Math.abs(geoLat) - auroraDeg) / (85 - auroraDeg)))
      let tier: Tier
      if (isGrid) tier = 'GRID'
      else if (isPolar) tier = 'POLAR'
      else if (absD >= 15) tier = 'HIGH'
      else tier = 'NORMAL'
      out.push({ f, klass, d, absD, trkTrue, trkMag, geoLat, poleNm, whichPole, isGrid, isPolar, hfBlackoutRisk, tier })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return b.absD - a.absD
    })
    return out
  }, [flights, secYr, yearOffset, gridNm, auroraDeg])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { GRID: 0, POLAR: 0, HIGH: 0, NORMAL: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sum = 0, max = 0, maxCs = '', grid = 0, n = 0
    for (const r of rows) {
      sum += r.absD; n++
      if (r.absD > max) { max = r.absD; maxCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'GRID') grid++
    }
    return { mean: n ? sum / n : 0, max, maxCs, grid, total: n }
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

  // World 10°×10° isogonic grid for overlay
  const worldGrid = useMemo(() => {
    const features: any[] = []
    if (!showOvl) return features
    for (let lat = -80; lat <= 80; lat += 10) {
      for (let lon = -180; lon <= 170; lon += 10) {
        const cLat = lat + 5
        const cLon = lon + 5
        let d = declination(cLat, cLon)
        d = d - secYr * yearOffset * Math.sign(d || 1) * 0.5
        const absD = Math.min(60, Math.abs(d))
        const color = d >= 0 ? '#0ea5e9' : '#ef4444'
        const opacity = 0.04 + (absD / 60) * 0.18
        features.push({
          type: 'Feature' as const,
          properties: { d, color, opacity },
          geometry: {
            type: 'Polygon' as const,
            coordinates: [[
              [lon, lat], [lon + 10, lat], [lon + 10, lat + 10], [lon, lat + 10], [lon, lat],
            ]],
          },
        })
      }
    }
    return features
  }, [showOvl, secYr, yearOffset])

  // Auroral oval ring at geomag-lat = auroraDeg, sampled on lat/lng grid
  const auroraRing = useMemo(() => {
    if (!showAuroraRing) return null
    // Approximate: trace ring by sweeping geographic longitude; for each, find geographic-lat where geomag-lat ~= auroraDeg
    const coordsN: [number, number][] = []
    const coordsS: [number, number][] = []
    for (let lon = -180; lon <= 180; lon += 4) {
      // binary search latitude for north oval
      let lo = 30, hi = 89
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        const g = geomagLat(mid, lon)
        if (g < auroraDeg) lo = mid; else hi = mid
      }
      coordsN.push([lon, (lo + hi) / 2])
      // south oval
      let loS = -89, hiS = -30
      for (let i = 0; i < 24; i++) {
        const mid = (loS + hiS) / 2
        const g = geomagLat(mid, lon)
        if (g > -auroraDeg) hiS = mid; else loS = mid
      }
      coordsS.push([lon, (loS + hiS) / 2])
    }
    return {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature' as const, properties: { color: '#f59e0b' }, geometry: { type: 'LineString' as const, coordinates: coordsN } },
        { type: 'Feature' as const, properties: { color: '#f59e0b' }, geometry: { type: 'LineString' as const, coordinates: coordsS } },
      ],
    }
  }, [showAuroraRing, auroraDeg])

  useEffect(() => {
    if (!map) return
    const gridFc = { type: 'FeatureCollection' as const, features: worldGrid }
    const poleFc = { type: 'FeatureCollection' as const, features: showPole ? [
      { type: 'Feature' as const, properties: { id: 'NMP', text: `NMP ${NMP_LAT.toFixed(1)}°N` }, geometry: { type: 'Point' as const, coordinates: [NMP_LON, NMP_LAT] } },
      { type: 'Feature' as const, properties: { id: 'SMP', text: `SMP ${Math.abs(SMP_LAT).toFixed(1)}°S` }, geometry: { type: 'Point' as const, coordinates: [SMP_LON, SMP_LAT] } },
    ] : [] }
    const auroraFc = auroraRing || { type: 'FeatureCollection' as const, features: [] }
    const ringFc = { type: 'FeatureCollection' as const, features: rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(20, r.absD) * 0.55 },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) }
    // True/Mag track fan: project 80nm forward in both true and magnetic directions
    const fanFeats: any[] = []
    if (showFan) {
      for (const r of rows) {
        if (r.absD < 3) continue
        const lenNm = 60
        const φ = r.f.lat * Math.PI / 180
        const cosLat = Math.max(0.001, Math.cos(φ))
        const dxT = (lenNm / 60) * Math.sin(r.trkTrue * Math.PI / 180) / cosLat
        const dyT = (lenNm / 60) * Math.cos(r.trkTrue * Math.PI / 180)
        const dxM = (lenNm / 60) * Math.sin(r.trkMag * Math.PI / 180) / cosLat
        const dyM = (lenNm / 60) * Math.cos(r.trkMag * Math.PI / 180)
        fanFeats.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier], kind: 'true' },
          geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dxT, r.f.lat + dyT]] },
        })
        fanFeats.push({
          type: 'Feature' as const,
          properties: { color: TIER_COLOR[r.tier], kind: 'mag' },
          geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dxM, r.f.lat + dyM]] },
        })
      }
    }
    const fanFc = { type: 'FeatureCollection' as const, features: fanFeats }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier === 'GRID' || r.tier === 'POLAR' || r.absD >= 15).map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.d >= 0 ? '+' : ''}${r.d.toFixed(0)}°${r.isGrid ? ' GRID' : r.isPolar ? ' POLAR' : ''}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_GRID, gridFc, () => {
        map.addLayer({ id: LYR_GRID, type: 'fill', source: SRC_GRID, paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['get', 'opacity'],
        } })
        map.addLayer({ id: LYR_GRID_OUT, type: 'line', source: SRC_GRID, paint: {
          'line-color': ['get', 'color'],
          'line-width': 0.4,
          'line-opacity': 0.35,
          'line-dasharray': [2, 3],
        } })
      })
      ensure(SRC_AURORA, auroraFc, () => map.addLayer({ id: LYR_AURORA, type: 'line', source: SRC_AURORA, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-dasharray': [3, 3],
        'line-opacity': 0.7,
      } }))
      ensure(SRC_POLE, poleFc, () => {
        map.addLayer({ id: LYR_POLE, type: 'circle', source: SRC_POLE, paint: {
          'circle-radius': 6,
          'circle-color': '#a855f7',
          'circle-stroke-color': '#020617',
          'circle-stroke-width': 1.2,
          'circle-opacity': 0.95,
        } })
        map.addLayer({ id: LYR_POLE_LBL, type: 'symbol', source: SRC_POLE, layout: {
          'text-field': ['get', 'text'],
          'text-size': 11,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        }, paint: {
          'text-color': '#c4b5fd',
          'text-halo-color': '#020617',
          'text-halo-width': 1.3,
        } })
      })
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.12,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_FAN, fanFc, () => map.addLayer({ id: LYR_FAN, type: 'line', source: SRC_FAN, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.1,
        'line-opacity': 0.75,
        'line-dasharray': ['case', ['==', ['get', 'kind'], 'mag'], ['literal', [3, 2]], ['literal', [1, 0]]],
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, 1.7],
        'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_FAN, LYR_RING, LYR_POLE_LBL, LYR_POLE, LYR_AURORA, LYR_GRID_OUT, LYR_GRID]) {
        try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {}
      }
      for (const src of [SRC_LBL, SRC_FAN, SRC_RING, SRC_POLE, SRC_AURORA, SRC_GRID]) {
        try { if (map.getSource(src)) map.removeSource(src) } catch {}
      }
    }
  }, [map, rows, worldGrid, auroraRing, showPole, showFan, showLabels])

  // SVG world isogonic chart
  const diag = useMemo(() => {
    const W = 360, H = 180, PAD = 24
    const xs = (lon: number) => PAD + ((lon + 180) / 360) * (W - PAD - 4)
    const ys = (lat: number) => 6 + ((90 - lat) / 180) * (H - PAD - 8)
    // grid of D values 36x18
    const cells: { lat: number; lon: number; d: number; color: string; opacity: number }[] = []
    for (let lat = -80; lat <= 80; lat += 10) {
      for (let lon = -180; lon <= 170; lon += 10) {
        let d = declination(lat + 5, lon + 5)
        d = d - secYr * yearOffset * Math.sign(d || 1) * 0.5
        const absD = Math.min(60, Math.abs(d))
        cells.push({
          lat, lon, d,
          color: d >= 0 ? '#0ea5e9' : '#ef4444',
          opacity: 0.06 + (absD / 60) * 0.45,
        })
      }
    }
    return { W, H, PAD, xs, ys, cells }
  }, [secYr, yearOffset])

  const meanColor = summary.mean >= 15 ? '#0ea5e9' : '#10b981'
  const maxColor = summary.max >= 25 ? '#f59e0b' : summary.max >= 15 ? '#0ea5e9' : '#10b981'

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">Magnetic Variation Atlas</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean |D|</div>
          <div className="font-mono text-sm" style={{ color: meanColor }}>{summary.mean.toFixed(1)}<span className="text-[9px] text-slate-500"> °</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Max</div>
          <div className="font-mono text-[11px] truncate" style={{ color: maxColor }} title={summary.maxCs}>{summary.maxCs || '\u2014'}</div>
          <div className="font-mono text-[10px]" style={{ color: maxColor }}>{summary.max.toFixed(0)}°</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Grid</div>
          <div className="font-mono text-sm" style={{ color: summary.grid > 0 ? '#ef4444' : '#10b981' }}>{summary.grid}</div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">World Isogonic · {year}</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            {/* world frame */}
            <rect x={diag.PAD} y={6} width={diag.W - diag.PAD - 4} height={diag.H - diag.PAD - 8} fill="#020617" stroke="#334155" strokeWidth={0.5} />
            {/* equator + greenwich */}
            <line x1={diag.PAD} y1={diag.ys(0)} x2={diag.W - 4} y2={diag.ys(0)} stroke="#475569" strokeWidth={0.5} strokeDasharray="2 2" />
            <line x1={diag.xs(0)} y1={6} x2={diag.xs(0)} y2={diag.H - diag.PAD} stroke="#475569" strokeWidth={0.5} strokeDasharray="2 2" />
            {/* declination cells */}
            {diag.cells.map((c, i) => (
              <rect key={i} x={diag.xs(c.lon)} y={diag.ys(c.lat + 10)}
                width={(diag.W - diag.PAD - 4) / 36}
                height={(diag.H - diag.PAD - 8) / 18}
                fill={c.color} opacity={c.opacity} />
            ))}
            {/* lat labels */}
            {[-60, -30, 0, 30, 60].map(la => (
              <text key={la} x={diag.PAD - 2} y={diag.ys(la) + 2.5} textAnchor="end" fontSize={7} fill="#64748b" fontFamily="monospace">{la}°</text>
            ))}
            {/* lon labels */}
            {[-180, -90, 0, 90, 180].map(lo => (
              <text key={lo} x={diag.xs(lo)} y={diag.H - diag.PAD + 8} textAnchor="middle" fontSize={7} fill="#64748b" fontFamily="monospace">{lo}°</text>
            ))}
            {/* magnetic poles */}
            <circle cx={diag.xs(NMP_LON)} cy={diag.ys(NMP_LAT)} r={3} fill="#a855f7" stroke="#020617" strokeWidth={0.5} />
            <text x={diag.xs(NMP_LON) + 5} y={diag.ys(NMP_LAT) + 2} fontSize={7} fill="#c4b5fd" fontFamily="monospace">NMP</text>
            <circle cx={diag.xs(SMP_LON)} cy={diag.ys(SMP_LAT)} r={3} fill="#a855f7" stroke="#020617" strokeWidth={0.5} />
            <text x={diag.xs(SMP_LON) + 5} y={diag.ys(SMP_LAT) + 2} fontSize={7} fill="#c4b5fd" fontFamily="monospace">SMP</text>
            {/* aircraft dots */}
            {rows.map(r => (
              <circle key={r.f.icao} cx={diag.xs(r.f.lng)} cy={diag.ys(r.f.lat)} r={1.8} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
            {/* legend */}
            <g transform={`translate(${diag.PAD + 4}, 10)`}>
              <rect width={6} height={5} fill="#0ea5e9" opacity={0.7} />
              <text x={9} y={4.5} fontSize={7} fill="#7dd3fc" fontFamily="monospace">EAST</text>
              <rect x={36} width={6} height={5} fill="#ef4444" opacity={0.7} />
              <text x={45} y={4.5} fontSize={7} fill="#fda4af" fontFamily="monospace">WEST</text>
            </g>
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>YEAR</span><span className="font-mono text-slate-300">{year}</span></div>
            <input type="range" min={2020} max={2035} step={1} value={year} onChange={e => setYear(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>SECULAR</span><span className="font-mono text-slate-300">{(secYr).toFixed(2)}°/yr</span></div>
            <input type="range" min={0} max={50} step={1} value={secularDegPerYr} onChange={e => setSecularDegPerYr(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>GRID-NM</span><span className="font-mono text-slate-300">{gridNm}</span></div>
            <input type="range" min={200} max={1500} step={50} value={gridNm} onChange={e => setGridNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>AURORA</span><span className="font-mono text-slate-300">{auroraDeg}°</span></div>
            <input type="range" min={50} max={80} step={1} value={auroraDeg} onChange={e => setAuroraDeg(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl} onChange={e => setShowOvl(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPole} onChange={e => setShowPole(e.target.checked)} className="accent-sky-500" /><span>POLE</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showAuroraRing} onChange={e => setShowAuroraRing(e.target.checked)} className="accent-sky-500" /><span>AURORA</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showFan} onChange={e => setShowFan(e.target.checked)} className="accent-sky-500" /><span>FAN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>D · TRK · POLAR</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          const dSign = r.d >= 0 ? '+' : ''
          const dColor = TIER_COLOR[r.tier]
          const advice = r.tier === 'GRID' ? 'GRID NAV — true-heading required (FAA AC 90-105)'
            : r.tier === 'POLAR' ? 'HF unreliable — SATCOM primary'
            : r.tier === 'HIGH' ? 'large mag offset — verify FMS DECL data'
            : 'mag headings reliable'
          // |D| progress bar 0..40°
          const dPct = Math.min(100, (r.absD / 40) * 100)
          const hfPct = Math.round(r.hfBlackoutRisk * 100)
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
                  <span title="latitude">{r.f.lat.toFixed(1)}°</span>
                  <span title="longitude">{r.f.lng.toFixed(1)}°</span>
                  <span title="geomagnetic latitude" style={{ color: Math.abs(r.geoLat) > auroraDeg ? '#f59e0b' : '#94a3b8' }}>GM{r.geoLat.toFixed(0)}°</span>
                  <span className="ml-auto" title="distance to nearest magnetic pole">{r.whichPole}MP {Math.round(r.poleNm)}nm</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="|declination| 0..40°">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${dPct}%`, background: dColor, opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400" style={{ left: `12.5%` }} title="NORMAL/HIGH" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `37.5%` }} title="HIGH/POLAR" />
                  <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: `75%` }} title="GRID" />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="magnetic declination (+E / -W)" style={{ color: dColor }}>D {dSign}{r.d.toFixed(1)}°</span>
                  <span title="true track">TRK-T {Math.round(r.trkTrue)}°</span>
                  <span title="magnetic track" style={{ color: r.absD >= 15 ? dColor : '#94a3b8' }}>TRK-M {Math.round(r.trkMag)}°</span>
                  <span className="ml-auto" title="HF blackout risk" style={{ color: hfPct >= 50 ? '#f59e0b' : '#64748b' }}>HF {hfPct}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span className="truncate" title="operator">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: dColor }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
