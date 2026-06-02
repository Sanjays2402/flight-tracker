'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   SUA Monitor — Special Use Airspace intrusion + entry forecast
   -----------------------------------------------------------
   A real flight-tracker feature: a hand-curated dataset of US
   Special Use Airspace (Prohibited / Restricted / Warning /
   Military Operations Areas / Class-B cores) painted on the
   map, with live point-in-polygon for every airborne aircraft.

   For each aircraft we compute:
     - INSIDE  : is the body currently inside an active SUA whose
                 altitude band brackets the current pressure alt?
     - INBOUND : projecting the current great-circle ground vector
                 N minutes forward, does the path enter an SUA?
                 If so, time-to-enter (and exit) seconds.
     - NEAR    : nearest SUA edge in nm if neither of the above.

   Severity tiers:
     CRITICAL = currently inside a P-/R-/W- (live)
     WARN     = inbound, will enter within 2 minutes
     WATCH    = inbound within horizon (default 10 min)
     CLEAR    = no projected entry within horizon

   MapLibre overlay:
     - All SUAs painted with type-coded translucent fill + outline
     - Aircraft inside SUA: rose halo ring + "INSIDE <id>" label
     - Inbound aircraft: dashed sky projection line to first entry
       point, amber dot at the entry, optional violet dot at exit
     - Each polygon: type+id label at centroid

   Side panel:
     - 4-cell severity counter strip (click to filter list)
     - Type chip row (P / R / W / MOA / CLB) with per-type counts
     - HORIZON slider (1-30 min) — how far ahead to project
     - OVL / LINES / LABELS toggles
     - callsign / icao / sua-id search
     - Ranked threat list (CRITICAL > WARN > WATCH > CLEAR) with
       per-row severity stripe, callsign+type, SUA id+kind, T-MM:SS
       enter / exit / range readout, click-to-fly per row.
     - Bottom: SUA catalog tab to click any zone and frame on map.
   ============================================================ */

export interface SuaFlight {
  icao: string
  callsign: string
  type?: string
  operator?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  track: number
  ground: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: SuaFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type SuaKind = 'P' | 'R' | 'W' | 'MOA' | 'CLB'

interface Sua {
  id: string
  name: string
  kind: SuaKind
  floorFt: number       // 0 = SFC
  ceilingFt: number     // 60000 = unlimited proxy
  // ring stored as [lat, lng] pairs (closed)
  ring: Array<[number, number]>
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function rect(lat0: number, lng0: number, dLat: number, dLng: number): Array<[number, number]> {
  return [
    [lat0 - dLat, lng0 - dLng],
    [lat0 - dLat, lng0 + dLng],
    [lat0 + dLat, lng0 + dLng],
    [lat0 + dLat, lng0 - dLng],
    [lat0 - dLat, lng0 - dLng],
  ]
}

function circle(lat0: number, lng0: number, rNm: number, n = 36): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const cosLat = Math.cos(lat0 * RAD) || 1e-6
  for (let i = 0; i <= n; i++) {
    const θ = (i / n) * 2 * Math.PI
    const dN = rNm * Math.cos(θ) / 60
    const dE = rNm * Math.sin(θ) / (60 * cosLat)
    out.push([lat0 + dN, lng0 + dE])
  }
  return out
}

// Curated SUA dataset. Floor/ceiling in feet MSL (60000 = "unlimited" proxy).
// IDs and rough centroids/sizes drawn from FAA charts; geometry intentionally
// simplified to bounding shapes so we can keep this self-contained.
const SUAS: Sua[] = [
  // Prohibited
  { id: 'P-40',  name: 'Camp David',           kind: 'P', floorFt: 0, ceilingFt: 60000, ring: circle(39.648, -77.466, 3.0) },
  { id: 'P-49',  name: 'Crawford TX',          kind: 'P', floorFt: 0, ceilingFt: 60000, ring: circle(31.535, -97.408, 3.0) },
  { id: 'P-56A', name: 'Washington DC',        kind: 'P', floorFt: 0, ceilingFt: 18000, ring: circle(38.895, -77.036, 1.0) },
  { id: 'P-56B', name: 'Naval Observatory',    kind: 'P', floorFt: 0, ceilingFt: 18000, ring: circle(38.921, -77.067, 0.5) },
  { id: 'P-67',  name: 'Bush Library KBN',     kind: 'P', floorFt: 0, ceilingFt: 60000, ring: circle(30.629, -96.342, 2.0) },
  // Restricted (samples)
  { id: 'R-2508',  name: 'China Lake Complex', kind: 'R', floorFt: 0,     ceilingFt: 60000, ring: rect(35.6, -117.3, 1.4, 1.8) },
  { id: 'R-2515',  name: 'Edwards AFB',        kind: 'R', floorFt: 0,     ceilingFt: 50000, ring: rect(34.95, -117.85, 0.6, 0.9) },
  { id: 'R-4806', name: 'Nevada Test Site',    kind: 'R', floorFt: 0,     ceilingFt: 60000, ring: rect(37.1, -116.05, 1.0, 1.2) },
  { id: 'R-3004A',name: 'Fort Benning',        kind: 'R', floorFt: 0,     ceilingFt: 23000, ring: rect(32.35, -84.78, 0.45, 0.55) },
  { id: 'R-5402', name: 'Fort Sill',           kind: 'R', floorFt: 0,     ceilingFt: 30000, ring: rect(34.65, -98.41, 0.55, 0.65) },
  { id: 'R-2305', name: 'White Sands',         kind: 'R', floorFt: 0,     ceilingFt: 60000, ring: rect(33.0, -106.3, 1.1, 0.8) },
  { id: 'R-6601', name: 'Eglin AFB',           kind: 'R', floorFt: 0,     ceilingFt: 50000, ring: rect(30.55, -86.55, 0.5, 0.9) },
  // Warning (offshore)
  { id: 'W-72',   name: 'Atlantic VA',         kind: 'W', floorFt: 0,     ceilingFt: 60000, ring: rect(36.8, -75.0, 0.9, 0.7) },
  { id: 'W-122',  name: 'Atlantic NJ',         kind: 'W', floorFt: 0,     ceilingFt: 60000, ring: rect(39.0, -73.7, 0.8, 0.7) },
  { id: 'W-291',  name: 'Atlantic NC',         kind: 'W', floorFt: 0,     ceilingFt: 60000, ring: rect(35.2, -74.6, 0.9, 0.8) },
  { id: 'W-470',  name: 'Gulf of Mexico',      kind: 'W', floorFt: 0,     ceilingFt: 60000, ring: rect(28.8, -88.9, 1.2, 1.4) },
  { id: 'W-537',  name: 'Pacific CA',          kind: 'W', floorFt: 0,     ceilingFt: 60000, ring: rect(34.4, -120.7, 0.9, 0.9) },
  // MOA (samples)
  { id: 'MOA-Smoky', name: 'Smoky MOA',        kind: 'MOA', floorFt: 8000,  ceilingFt: 17999, ring: rect(38.95, -98.5, 0.6, 0.9) },
  { id: 'MOA-Buckeye',name: 'Buckeye MOA',     kind: 'MOA', floorFt: 8000,  ceilingFt: 17999, ring: rect(33.7, -112.9, 0.5, 0.8) },
  { id: 'MOA-Sells', name: 'Sells MOA',        kind: 'MOA', floorFt: 500,   ceilingFt: 17999, ring: rect(31.95, -111.95, 0.6, 0.8) },
  { id: 'MOA-Snoopy',name: 'Snoopy MOA',       kind: 'MOA', floorFt: 7000,  ceilingFt: 17999, ring: rect(34.2, -104.0, 0.7, 0.9) },
  { id: 'MOA-PineHill',name: 'Pine Hill MOA',  kind: 'MOA', floorFt: 7000,  ceilingFt: 17999, ring: rect(43.6, -75.1, 0.45, 0.6) },
  { id: 'MOA-Powder',name: 'Powder River',     kind: 'MOA', floorFt: 12000, ceilingFt: 17999, ring: rect(45.5, -106.0, 1.5, 2.0) },
  // Class B cores (simplified inner rings)
  { id: 'CLB-KJFK', name: 'New York Class B',     kind: 'CLB', floorFt: 0, ceilingFt: 7000, ring: circle(40.639, -73.779, 9) },
  { id: 'CLB-KLAX', name: 'Los Angeles Class B',  kind: 'CLB', floorFt: 0, ceilingFt: 10000, ring: circle(33.943, -118.408, 8) },
  { id: 'CLB-KORD', name: 'Chicago Class B',      kind: 'CLB', floorFt: 0, ceilingFt: 10000, ring: circle(41.979, -87.905, 10) },
  { id: 'CLB-KATL', name: 'Atlanta Class B',      kind: 'CLB', floorFt: 0, ceilingFt: 12500, ring: circle(33.637, -84.428, 10) },
  { id: 'CLB-KDFW', name: 'Dallas-FW Class B',    kind: 'CLB', floorFt: 0, ceilingFt: 11000, ring: circle(32.897, -97.038, 11) },
  { id: 'CLB-KSFO', name: 'San Francisco Class B',kind: 'CLB', floorFt: 0, ceilingFt: 10000, ring: circle(37.619, -122.375, 8) },
  { id: 'CLB-KSEA', name: 'Seattle Class B',      kind: 'CLB', floorFt: 0, ceilingFt: 10000, ring: circle(47.449, -122.309, 8) },
  { id: 'CLB-KBOS', name: 'Boston Class B',       kind: 'CLB', floorFt: 0, ceilingFt: 7000,  ring: circle(42.362, -71.008, 7) },
  { id: 'CLB-KMIA', name: 'Miami Class B',        kind: 'CLB', floorFt: 0, ceilingFt: 7000,  ring: circle(25.796, -80.290, 7) },
  { id: 'CLB-EGLL', name: 'London Class B (sim)', kind: 'CLB', floorFt: 0, ceilingFt: 9500,  ring: circle(51.471, -0.460, 9) },
  { id: 'CLB-LFPG', name: 'Paris Class B (sim)',  kind: 'CLB', floorFt: 0, ceilingFt: 9500,  ring: circle(49.012, 2.55,   9) },
]

const KIND_LABEL: Record<SuaKind, string> = { P: 'PROH', R: 'REST', W: 'WARN', MOA: 'MOA', CLB: 'CL-B' }
const KIND_COLOR: Record<SuaKind, string> = {
  P:   '#f43f5e', // rose
  R:   '#f97316', // orange
  W:   '#eab308', // yellow
  MOA: '#a855f7', // violet
  CLB: '#0ea5e9', // sky
}

type Tier = 'CRITICAL' | 'WARN' | 'WATCH' | 'CLEAR'
const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#f43f5e',
  WARN:     '#f97316',
  WATCH:    '#eab308',
  CLEAR:    '#64748b',
}

function pointInRing(lat: number, lng: number, ring: Array<[number, number]>): boolean {
  // ray cast on (x=lng, y=lat). Caller must pre-bbox.
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1]
    const yj = ring[j][0], xj = ring[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function bboxRing(ring: Array<[number, number]>) {
  let lat0 = Infinity, lat1 = -Infinity, lng0 = Infinity, lng1 = -Infinity
  for (const [la, ln] of ring) {
    if (la < lat0) lat0 = la
    if (la > lat1) lat1 = la
    if (ln < lng0) lng0 = ln
    if (ln > lng1) lng1 = ln
  }
  return { lat0, lat1, lng0, lng1 }
}

function centroidRing(ring: Array<[number, number]>): [number, number] {
  let la = 0, ln = 0, n = ring.length - 1
  for (let i = 0; i < n; i++) { la += ring[i][0]; ln += ring[i][1] }
  return [la / n, ln / n]
}

function distToSegmentNm(lat: number, lng: number, a: [number, number], b: [number, number]) {
  // Local-tangent approx, fine at the scales we use.
  const cosLat = Math.cos(lat * RAD) || 1e-6
  const ax = (a[1] - lng) * 60 * cosLat, ay = (a[0] - lat) * 60
  const bx = (b[1] - lng) * 60 * cosLat, by = (b[0] - lat) * 60
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.sqrt(ax * ax + ay * ay)
  let t = -(ax * dx + ay * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const px = ax + t * dx, py = ay + t * dy
  return Math.sqrt(px * px + py * py)
}

function distToRingNm(lat: number, lng: number, ring: Array<[number, number]>): number {
  let best = Infinity
  for (let i = 1; i < ring.length; i++) {
    const d = distToSegmentNm(lat, lng, ring[i - 1], ring[i])
    if (d < best) best = d
  }
  return best
}

function dest(lat: number, lng: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM
  const φ1 = lat * RAD, λ1 = lng * RAD, θ = brg * RAD
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
                             Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [((λ2 * DEG + 540) % 360) - 180, φ2 * DEG]
}

interface Encounter {
  flight: SuaFlight
  tier: Tier
  insideSua: Sua | null
  entrySua: Sua | null
  tEnterSec: number | null   // sec to first entry
  tExitSec: number | null    // sec to exit (after entering or while inside)
  entryLat: number | null
  entryLng: number | null
  exitLat: number | null
  exitLng: number | null
  nearestSua: Sua | null
  nearestNm: number
}

const SRC_POLY = 'sua-poly-src'
const LYR_POLY_FILL = 'sua-poly-fill'
const LYR_POLY_LINE = 'sua-poly-line'
const SRC_POLY_LBL = 'sua-poly-lbl-src'
const LYR_POLY_LBL = 'sua-poly-lbl'
const SRC_HALO = 'sua-halo-src'
const LYR_HALO = 'sua-halo-lyr'
const LYR_HALO_LBL = 'sua-halo-lbl'
const SRC_LINE = 'sua-line-src'
const LYR_LINE = 'sua-line-lyr'
const SRC_PTS = 'sua-pts-src'
const LYR_PTS = 'sua-pts-lyr'

function fmtT(s: number | null) {
  if (s == null || !isFinite(s) || s < 0) return '—'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}

export default function SuaMonitor({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [horizonMin, setHorizonMin] = useState<number>(10)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [kindFilter, setKindFilter] = useState<Record<SuaKind, boolean>>({ P: true, R: true, W: true, MOA: true, CLB: true })
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const [showLines, setShowLines] = useState<boolean>(true)
  const [showLabels, setShowLabels] = useState<boolean>(true)
  const [query, setQuery] = useState<string>('')
  const [tab, setTab] = useState<'THREATS' | 'CATALOG'>('THREATS')
  const installedRef = useRef<boolean>(false)

  // Per-SUA precomputed bbox + centroid
  const suaIndex = useMemo(() => SUAS.map(s => ({
    sua: s, bb: bboxRing(s.ring), c: centroidRing(s.ring)
  })), [])

  const activeSuas = useMemo(() => suaIndex.filter(s => kindFilter[s.sua.kind]), [suaIndex, kindFilter])

  const encounters = useMemo<Encounter[]>(() => {
    const horizonSec = horizonMin * 60
    const stepSec = 15 // probe every 15s along projection
    return flights.filter(f => !f.ground && isFinite(f.lat) && isFinite(f.lng)).map(f => {
      // INSIDE check (use kinds enabled by filter)
      let insideSua: Sua | null = null
      for (const { sua, bb } of activeSuas) {
        if (f.altitudeFt < sua.floorFt - 200 || f.altitudeFt > sua.ceilingFt + 200) continue
        if (f.lat < bb.lat0 - 0.05 || f.lat > bb.lat1 + 0.05 || f.lng < bb.lng0 - 0.05 || f.lng > bb.lng1 + 0.05) continue
        if (pointInRing(f.lat, f.lng, sua.ring)) { insideSua = sua; break }
      }

      // Projection
      let entrySua: Sua | null = null
      let tEnter: number | null = null
      let tExit: number | null = null
      let entryLat: number | null = null, entryLng: number | null = null
      let exitLat: number | null = null, exitLng: number | null = null
      const gs = Math.max(60, f.velocityKts || 0)
      if (gs > 30) {
        let prevInside: Sua | null = insideSua
        if (insideSua) {
          entrySua = insideSua; tEnter = 0; entryLat = f.lat; entryLng = f.lng
        }
        for (let t = stepSec; t <= horizonSec; t += stepSec) {
          const nm = (gs * t) / 3600
          const [lng, lat] = dest(f.lat, f.lng, f.track || 0, nm)
          let nowIn: Sua | null = null
          for (const { sua, bb } of activeSuas) {
            if (f.altitudeFt < sua.floorFt - 500 || f.altitudeFt > sua.ceilingFt + 500) continue
            if (lat < bb.lat0 - 0.05 || lat > bb.lat1 + 0.05 || lng < bb.lng0 - 0.05 || lng > bb.lng1 + 0.05) continue
            if (pointInRing(lat, lng, sua.ring)) { nowIn = sua; break }
          }
          if (!entrySua && nowIn) {
            entrySua = nowIn; tEnter = t; entryLat = lat; entryLng = lng
          }
          if (entrySua && !nowIn && prevInside) {
            tExit = t; exitLat = lat; exitLng = lng
            break
          }
          prevInside = nowIn
        }
      }

      // Nearest edge
      let nearestSua: Sua | null = null
      let nearestNm = Infinity
      for (const { sua, c } of activeSuas) {
        // Cheap centroid prefilter
        const cosLat = Math.cos(f.lat * RAD)
        const dx = ((c[1] - f.lng) * 60 * cosLat)
        const dy = ((c[0] - f.lat) * 60)
        if (Math.hypot(dx, dy) > 400 && nearestNm < 200) continue
        const d = distToRingNm(f.lat, f.lng, sua.ring)
        if (d < nearestNm) { nearestNm = d; nearestSua = sua }
      }

      let tier: Tier = 'CLEAR'
      if (insideSua) tier = 'CRITICAL'
      else if (tEnter != null && tEnter <= 120) tier = 'WARN'
      else if (tEnter != null) tier = 'WATCH'

      return {
        flight: f, tier, insideSua, entrySua, tEnterSec: tEnter, tExitSec: tExit,
        entryLat, entryLng, exitLat, exitLng,
        nearestSua, nearestNm: isFinite(nearestNm) ? nearestNm : 999,
      }
    })
  }, [flights, activeSuas, horizonMin])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL: 0, WARN: 0, WATCH: 0, CLEAR: 0 }
    for (const e of encounters) c[e.tier]++
    return c
  }, [encounters])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return encounters
      .filter(e => tierFilter === 'ALL' || e.tier === tierFilter)
      .filter(e => {
        if (!q) return true
        const f = e.flight
        return (f.callsign || '').toLowerCase().includes(q)
          || (f.icao || '').toLowerCase().includes(q)
          || (f.type || '').toLowerCase().includes(q)
          || (e.insideSua?.id || '').toLowerCase().includes(q)
          || (e.entrySua?.id || '').toLowerCase().includes(q)
          || (e.nearestSua?.id || '').toLowerCase().includes(q)
      })
      .sort((a, b) => {
        const rank = (t: Tier) => t === 'CRITICAL' ? 0 : t === 'WARN' ? 1 : t === 'WATCH' ? 2 : 3
        const dr = rank(a.tier) - rank(b.tier)
        if (dr) return dr
        const at = a.tEnterSec ?? 1e9, bt = b.tEnterSec ?? 1e9
        if (at !== bt) return at - bt
        return a.nearestNm - b.nearestNm
      })
  }, [encounters, tierFilter, query])

  const kindCounts = useMemo(() => {
    const c: Record<SuaKind, number> = { P: 0, R: 0, W: 0, MOA: 0, CLB: 0 }
    for (const s of SUAS) c[s.kind]++
    return c
  }, [])

  /* Map overlay */
  useEffect(() => {
    if (!map) return
    let cancelled = false
    const install = () => {
      if (cancelled) return
      try {
        const empty: any = { type: 'FeatureCollection', features: [] }
        if (!map.getSource(SRC_POLY)) map.addSource(SRC_POLY, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_POLY_LBL)) map.addSource(SRC_POLY_LBL, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_HALO)) map.addSource(SRC_HALO, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_LINE)) map.addSource(SRC_LINE, { type: 'geojson', data: empty })
        if (!map.getSource(SRC_PTS)) map.addSource(SRC_PTS, { type: 'geojson', data: empty })

        if (!map.getLayer(LYR_POLY_FILL)) map.addLayer({
          id: LYR_POLY_FILL, type: 'fill', source: SRC_POLY,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 }
        })
        if (!map.getLayer(LYR_POLY_LINE)) map.addLayer({
          id: LYR_POLY_LINE, type: 'line', source: SRC_POLY,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': 0.9 }
        })
        if (!map.getLayer(LYR_POLY_LBL)) map.addLayer({
          id: LYR_POLY_LBL, type: 'symbol', source: SRC_POLY_LBL,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false,
            'text-offset': [0, 0],
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.2,
          }
        })
        if (!map.getLayer(LYR_HALO)) map.addLayer({
          id: LYR_HALO, type: 'circle', source: SRC_HALO,
          paint: {
            'circle-radius': 12,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-opacity': 0.95,
          }
        })
        if (!map.getLayer(LYR_HALO_LBL)) map.addLayer({
          id: LYR_HALO_LBL, type: 'symbol', source: SRC_HALO,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-offset': [0, 1.4],
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': ['get', 'color'],
            'text-halo-color': '#020617',
            'text-halo-width': 1.4,
          }
        })
        if (!map.getLayer(LYR_LINE)) map.addLayer({
          id: LYR_LINE, type: 'line', source: SRC_LINE,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.5,
            'line-dasharray': [2, 2],
            'line-opacity': 0.85,
          }
        })
        if (!map.getLayer(LYR_PTS)) map.addLayer({
          id: LYR_PTS, type: 'circle', source: SRC_PTS,
          paint: {
            'circle-radius': 4,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#020617',
            'circle-stroke-width': 1.2,
          }
        })
        installedRef.current = true
      } catch {}
    }
    if ((map as any).isStyleLoaded?.()) install(); else map.once('load', install)
    return () => {
      cancelled = true
      try {
        for (const l of [LYR_POLY_FILL, LYR_POLY_LINE, LYR_POLY_LBL, LYR_HALO, LYR_HALO_LBL, LYR_LINE, LYR_PTS]) {
          if (map.getLayer(l)) map.removeLayer(l)
        }
        for (const s of [SRC_POLY, SRC_POLY_LBL, SRC_HALO, SRC_LINE, SRC_PTS]) {
          if (map.getSource(s)) map.removeSource(s)
        }
      } catch {}
      installedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !installedRef.current) return
    const polyFeat = !showOverlay ? [] : activeSuas.map(({ sua }) => ({
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [sua.ring.map(([la, ln]) => [ln, la])] },
      properties: { color: KIND_COLOR[sua.kind], id: sua.id, kind: sua.kind },
    }))
    const polyLblFeat = !showOverlay || !showLabels ? [] : activeSuas.map(({ sua, c }) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [c[1], c[0]] },
      properties: { color: KIND_COLOR[sua.kind], label: `${sua.id}` },
    }))

    const haloFeat: any[] = []
    const lineFeat: any[] = []
    const ptsFeat: any[] = []
    for (const e of encounters) {
      if (e.tier === 'CLEAR') continue
      const color = TIER_COLOR[e.tier]
      const f = e.flight
      const lbl = showLabels
        ? (e.insideSua ? `INSIDE ${e.insideSua.id}` : (e.entrySua ? `${f.callsign || f.icao.toUpperCase()} T-${fmtT(e.tEnterSec)} ${e.entrySua.id}` : ''))
        : ''
      haloFeat.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
        properties: { color, label: lbl }
      })
      if (showLines && e.tEnterSec != null && e.tEnterSec > 0 && e.entryLat != null && e.entryLng != null) {
        lineFeat.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[f.lng, f.lat], [e.entryLng, e.entryLat]] },
          properties: { color: '#0ea5e9' }
        })
        ptsFeat.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [e.entryLng, e.entryLat] },
          properties: { color: '#f97316' }
        })
        if (e.exitLat != null && e.exitLng != null) {
          ptsFeat.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [e.exitLng, e.exitLat] },
            properties: { color: '#a855f7' }
          })
        }
      }
    }

    try {
      const src = (id: string) => map.getSource(id) as any
      src(SRC_POLY)?.setData({ type: 'FeatureCollection', features: polyFeat })
      src(SRC_POLY_LBL)?.setData({ type: 'FeatureCollection', features: polyLblFeat })
      src(SRC_HALO)?.setData({ type: 'FeatureCollection', features: haloFeat })
      src(SRC_LINE)?.setData({ type: 'FeatureCollection', features: lineFeat })
      src(SRC_PTS)?.setData({ type: 'FeatureCollection', features: ptsFeat })
    } catch {}
  }, [map, encounters, activeSuas, showOverlay, showLines, showLabels])

  return (
    <div className="fixed top-16 right-3 z-40 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">!</span>
          <span className="text-sm font-semibold tracking-wide">SUA MONITOR</span>
          <span className="text-[10px] text-slate-500">restricted airspace</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {(['CRITICAL', 'WARN', 'WATCH', 'CLEAR'] as Tier[]).map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }}>
            <span className="text-[9px] tracking-wider">{t.slice(0, 4)}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div className="flex flex-wrap gap-1">
          {(['P', 'R', 'W', 'MOA', 'CLB'] as SuaKind[]).map(k => (
            <button key={k} onClick={() => setKindFilter(p => ({ ...p, [k]: !p[k] }))}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${kindFilter[k] ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-500'}`}
              style={{ borderLeftColor: KIND_COLOR[k], borderLeftWidth: 2 }}>
              {KIND_LABEL[k]} <span className="text-slate-500">{kindCounts[k]}</span>
            </button>
          ))}
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>HORIZON</span>
            <span className="font-mono text-slate-300">{horizonMin} min</span>
          </div>
          <input type="range" min={1} max={30} step={1} value={horizonMin}
            onChange={e => setHorizonMin(parseInt(e.target.value))}
            className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLines} onChange={e => setShowLines(e.target.checked)} className="accent-sky-500" /><span>LINES</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / sua id"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="flex border-b border-slate-800 text-[10px] font-mono tracking-wider">
        {(['THREATS', 'CATALOG'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-3 py-1.5 ${tab === t ? 'bg-sky-500/15 text-sky-100 border-b border-sky-500/50' : 'text-slate-500 hover:text-slate-300'}`}>
            {t} {t === 'THREATS' ? `· ${filtered.length}` : `· ${SUAS.length}`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'THREATS' ? (
          filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-[11px] text-slate-500">No aircraft match these filters.</div>
          ) : filtered.map(e => {
            const f = e.flight
            const color = TIER_COLOR[e.tier]
            const sua = e.insideSua || e.entrySua || e.nearestSua
            return (
              <button key={f.icao} onClick={() => onFly(f.icao)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 transition flex items-stretch gap-2">
                <div className="w-0.5 rounded" style={{ background: color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="font-mono text-xs text-slate-100 font-bold truncate">{f.callsign || f.icao.toUpperCase()}</span>
                      <span className="text-[10px] text-slate-500 truncate">{f.type || ''}</span>
                    </div>
                    <span className="text-[10px] font-mono tracking-wider shrink-0" style={{ color }}>{e.tier}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500 mt-0.5">
                    {sua && (
                      <span style={{ color: KIND_COLOR[sua.kind] }}>{KIND_LABEL[sua.kind]} {sua.id}</span>
                    )}
                    {e.insideSua ? (
                      <span className="text-rose-400">INSIDE · exit T-{fmtT(e.tExitSec)}</span>
                    ) : e.tEnterSec != null ? (
                      <span className="text-amber-300">enter T-{fmtT(e.tEnterSec)}{e.tExitSec != null ? ` · exit T-${fmtT(e.tExitSec)}` : ''}</span>
                    ) : (
                      <span>{e.nearestNm.toFixed(0)} nm clear</span>
                    )}
                    <span className="ml-auto text-slate-600">FL{Math.round(f.altitudeFt / 100)}</span>
                  </div>
                </div>
              </button>
            )
          })
        ) : (
          SUAS
            .filter(s => kindFilter[s.kind])
            .filter(s => !query.trim() || s.id.toLowerCase().includes(query.toLowerCase()) || s.name.toLowerCase().includes(query.toLowerCase()))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(s => {
              const c = centroidRing(s.ring)
              return (
                <button key={s.id} onClick={() => onFlyLatLng(c[0], c[1], 7)}
                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 transition flex items-stretch gap-2">
                  <div className="w-0.5 rounded" style={{ background: KIND_COLOR[s.kind] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-slate-100">{s.id}</span>
                      <span className="text-[10px] font-mono tracking-wider" style={{ color: KIND_COLOR[s.kind] }}>{KIND_LABEL[s.kind]}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">{s.name}</div>
                    <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                      {s.floorFt === 0 ? 'SFC' : `${(s.floorFt / 100).toFixed(0)}`}
                      {' → '}
                      {s.ceilingFt >= 60000 ? 'UNL' : `FL${Math.round(s.ceilingFt / 100)}`}
                    </div>
                  </div>
                </button>
              )
            })
        )}
      </div>
    </div>
  )
}
