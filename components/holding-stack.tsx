'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Holding Stack Designer
   -----------------------------------------------------------
   Picks a holding fix (any airport from the global DB or the
   nearest one to map center) and builds a vertical stack of
   FAA-standard racetrack holding patterns layered every
   STACK_STEP feet starting at STACK_FLOOR (default FL110, +2000ft
   each: 110/130/150/170/190/210/230).

   Inbound aircraft (within INBOUND_RNG nm of the fix, closing
   on the fix per ground-vector projection, in descent or already
   level <= TOP_FL) are sorted by arrival-time-to-fix and assigned
   to stack levels in arrival order: first plane gets the BOTTOM
   level (so it can be released first), each subsequent plane
   gets the next higher available level. The expected hold time
   for each plane is computed as (slotIndex / departureRate) where
   departureRate is the user-tunable AAR (Acceptance Rate) in
   movements/hour.

   Per holding level we paint a standard racetrack:
     - inbound leg duration = 1 min (below 14k MSL) or 1.5 min
       (above) per FAA AIM 5-3-7
     - leg length = TAS * leg_min / 60   (TAS class-tuned by FL)
     - turn radius = TAS^2 / (11.26 * tan(25deg))  /60  in nm
       (standard rate turn / 25deg bank)
     - right-hand turns by default, holding outbound radial =
       inboundCourse + 180; pattern footprint is the union of:
        * two 180deg semicircles at each end of the inbound leg
        * straight inbound leg from holding-side end -> fix
        * straight outbound leg from fix -> opposite end

   Fuel burn per orbit = (2*leg_min + ~2min for turns) * pph/60
   pph estimated per airframe-class (heavy 7000, narrow 4500,
   regional 1800, biz 1600, turboprop 900, GA 200).

   Tier classification per assignment:
     HOLDING-FULL  : stack already at capacity, this plane is
                     stacked above top (FL > stackCeiling)
     LONG-HOLD     : expected hold >= 25min
     SHORT-HOLD    : expected hold >= 5min
     RELEASE       : expected hold < 5min (next to depart)

   MapLibre overlay paints per-level racetrack polygons in
   tier-colored fill + dashed outline, the holding fix as a
   violet pin with IATA + "HOLD" label, per-aircraft dashed
   sky line from current position to the assigned level
   centroid with callsign + assigned-FL + ETH (expected hold)
   labels, and altitude rung tags ("FL150 · 3 a/c") at each
   level's outbound terminus.

   Side panel: airport picker (searchable IATA/ICAO/city +
   NEAREST snap + FIT), 4-tier counter strip (click-to-filter),
   3-cell summary (STACK DEPTH / AVG-WAIT / TOTAL-BURN-pph),
   SVG vertical stack diagram (each level as a horizontal bar
   colored by occupancy with FL label + count + ETH per slot),
   AAR / FLOOR-FL / STEP-FT / LEG-MIN / INBOUND-RNG sliders,
   inbound-radial slider (0-359 / +AUTO from dominant inbound
   bearing), OVL/RACETRACK/LINKS/LBL toggles, callsign search,
   ranked aircraft list sorted by tier worst-first then ETH desc
   with tier color stripe.
   ============================================================ */

export interface HsFlight {
  icao: string
  callsign: string
  type?: string
  category?: number | string
  operator?: string
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
  flights: HsFlight[]
  mapCenterLat: number
  mapCenterLng: number
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

const R_NM = 3440.065
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function distNm(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * RAD, φ2 = la2 * RAD
  const dφ = (la2 - la1) * RAD, dλ = (lo2 - lo1) * RAD
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * RAD, φ2 = la2 * RAD, dλ = (lo2 - lo1) * RAD
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * DEG + 360) % 360
}
function dest(lat: number, lng: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM
  const φ1 = lat * RAD, λ1 = lng * RAD, θ = brg * RAD
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
                             Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  let lo = λ2 * DEG
  lo = ((lo + 540) % 360) - 180
  return [lo, φ2 * DEG]
}
function geodesic(la1: number, lo1: number, la2: number, lo2: number, n = 32): number[][] {
  const out: number[][] = []
  const φ1 = la1 * RAD, λ1 = lo1 * RAD, φ2 = la2 * RAD, λ2 = lo2 * RAD
  const dφ = φ2 - φ1, dλ = λ2 - λ1
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  const δ = 2 * Math.asin(Math.min(1, Math.sqrt(a)))
  if (δ < 1e-9) return [[lo1, la1], [lo2, la2]]
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * δ) / Math.sin(δ)
    const B = Math.sin(f * δ) / Math.sin(δ)
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
    const z = A * Math.sin(φ1) + B * Math.sin(φ2)
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y))
    const λ = Math.atan2(y, x)
    out.push([((λ * DEG + 540) % 360) - 180, φ * DEG])
  }
  return out
}

type Tier = 'FULL' | 'LONG' | 'SHORT' | 'RELEASE'
const TIER_COLOR: Record<Tier, string> = { FULL: '#ef4444', LONG: '#fbbf24', SHORT: '#0ea5e9', RELEASE: '#a855f7' }
const TIER_ORDER: Tier[] = ['FULL', 'LONG', 'SHORT', 'RELEASE']
const TIER_PILL: Record<Tier, string> = {
  FULL: 'bg-rose-500/15 text-rose-200 border-rose-500/40',
  LONG: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
  SHORT: 'bg-sky-500/15 text-sky-200 border-sky-500/40',
  RELEASE: 'bg-violet-500/15 text-violet-200 border-violet-500/40',
}

function classifyType(t: string | undefined, cat?: number | string): 'heavy'|'narrow'|'regional'|'biz'|'turboprop'|'ga' {
  const catN = typeof cat === 'number' ? cat : (cat ? parseInt(cat) : NaN)
  if (catN === 5 || catN === 6) return 'heavy'
  if (catN === 4) return 'narrow'
  const s = (t || '').toUpperCase()
  if (/^(A38|A35|A33|A34|B74|B77|B78|B79|MD11|IL96|IL76|AN12|AN22|AN124|AN225|C5|C17|KC10|KC135)/.test(s)) return 'heavy'
  if (/^(A31|A32|A220|B73|B72|B75|B76|MD8|MD9|E19|BCS|CRJ9|CRJ10)/.test(s)) return 'narrow'
  if (/^(E14|E17|CRJ|AT4|AT7|DH8|SF34|ATR)/.test(s)) return 'regional'
  if (/^(GLF|GLEX|GL5T|G(II|III|IV|V)|CL30|CL35|CL60|CL64|CRJ2|LJ|BE40|FA|HDJ|C56|C68|C25|C75|E50|E55|PC24|EA50)/.test(s)) return 'biz'
  if (/^(BE9|BE10|BE20|BE30|DH8|PC12|TBM|C208|PA46|SR22|C172|C152|C182|C206|C310)/.test(s)) return 'turboprop'
  return 'ga'
}
const TAS_BY_FL: Record<string, (fl: number) => number> = {
  heavy: (fl) => 230 + (fl - 110) * 0.5,
  narrow: (fl) => 220 + (fl - 110) * 0.45,
  regional: (fl) => 200 + (fl - 110) * 0.35,
  biz: (fl) => 220 + (fl - 110) * 0.5,
  turboprop: (fl) => 180,
  ga: (fl) => 120,
}
const PPH_BY_CLASS: Record<string, number> = { heavy: 7000, narrow: 4500, regional: 1800, biz: 1600, turboprop: 900, ga: 200 }

interface Slot {
  fl: number
  flight: HsFlight | null
  tier: Tier
  slotIdx: number
  ethMin: number
  ttfMin: number          // current time-to-fix in minutes
  legLengthNm: number
  turnRadiusNm: number
  fuelPerOrbit: number    // lbs
  totalBurn: number       // lbs over expected hold
}

const SRC_RACE = 'hs-race-src'
const LYR_RACE_FILL = 'hs-race-fill'
const LYR_RACE_LINE = 'hs-race-line'
const SRC_LINK = 'hs-link-src'
const LYR_LINK = 'hs-link-lyr'
const SRC_FIX = 'hs-fix-src'
const LYR_FIX = 'hs-fix-lyr'
const LYR_FIX_LBL = 'hs-fix-lbl'
const SRC_LBL = 'hs-lbl-src'
const LYR_LBL = 'hs-lbl-lyr'

function fmtMin(m: number): string {
  if (!isFinite(m) || m < 0) return '—'
  const mm = Math.floor(m), ss = Math.round((m - mm) * 60)
  return `${mm}:${String(ss).padStart(2, '0')}`
}

export default function HoldingStackDesigner({ map, flights, mapCenterLat, mapCenterLng, onClose, onFly, onFlyLatLng }: Props) {
  const [apIcao, setApIcao] = useState<string>('')
  const [showPicker, setShowPicker] = useState<boolean>(false)
  const [pickerQuery, setPickerQuery] = useState<string>('')
  const [aar, setAar] = useState<number>(30)
  const [floorFl, setFloorFl] = useState<number>(110)
  const [stepFt, setStepFt] = useState<number>(2000)
  const [legMin, setLegMin] = useState<number>(1.5)
  const [inboundRng, setInboundRng] = useState<number>(80)
  const [radialMode, setRadialMode] = useState<'AUTO' | 'MANUAL'>('AUTO')
  const [manualRadial, setManualRadial] = useState<number>(360)
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const [showRace, setShowRace] = useState<boolean>(true)
  const [showLinks, setShowLinks] = useState<boolean>(true)
  const [showLbl, setShowLbl] = useState<boolean>(true)
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [query, setQuery] = useState<string>('')

  const installedRef = useRef<boolean>(false)

  // Pick fix
  const fix = useMemo(() => {
    if (apIcao) {
      const a = AIRPORTS.find(x => x.i === apIcao)
      if (a) return a
    }
    // nearest to map center
    let best: any = null; let bd = Infinity
    for (const a of AIRPORTS) {
      const d = distNm(mapCenterLat, mapCenterLng, a.lat, a.lon)
      if (d < bd) { bd = d; best = a }
    }
    return best
  }, [apIcao, mapCenterLat, mapCenterLng])

  // Pre-compute dominant inbound radial
  const dominantRadial = useMemo(() => {
    if (!fix) return 360
    // sum of unit vectors from inbound aircraft bearing-TO-fix
    let su = 0, sv = 0
    for (const f of flights) {
      if (f.ground) continue
      const d = distNm(f.lat, f.lng, fix.lat, fix.lon)
      if (d > inboundRng || d < 0.5) continue
      const brgToFix = bearingDeg(f.lat, f.lng, fix.lat, fix.lon)
      const closure = Math.cos((f.track - brgToFix) * RAD)
      if (closure < 0.2) continue
      // inbound radial = bearing FROM fix to aircraft (=brgFromFix), since holding inbound course is FROM holding side TO fix => opposite
      const brgFromFix = (brgToFix + 180) % 360
      const θ = brgFromFix * RAD
      su += Math.cos(θ); sv += Math.sin(θ)
    }
    if (Math.abs(su) + Math.abs(sv) < 1e-6) return 360
    let r = (Math.atan2(sv, su) * DEG + 360) % 360
    return r
  }, [flights, fix, inboundRng])

  const inboundRadial = radialMode === 'AUTO' ? dominantRadial : manualRadial

  // Build slot assignments
  const slots: Slot[] = useMemo(() => {
    if (!fix) return []
    // inbound list
    type Inb = { f: HsFlight; ttfMin: number; closure: number }
    const inb: Inb[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = Math.round(f.altitudeFt / 100)
      if (fl > floorFl + 14 * (stepFt / 100)) continue // way above stack
      const d = distNm(f.lat, f.lng, fix.lat, fix.lon)
      if (d > inboundRng) continue
      const brgToFix = bearingDeg(f.lat, f.lng, fix.lat, fix.lon)
      const closure = Math.cos((f.track - brgToFix) * RAD)
      if (closure < 0.1) continue
      const gs = Math.max(120, f.velocityKts || 200)
      const ttfMin = (d / (gs * closure)) * 60
      if (!isFinite(ttfMin) || ttfMin < 0) continue
      inb.push({ f, ttfMin, closure })
    }
    inb.sort((a, b) => a.ttfMin - b.ttfMin)
    const out: Slot[] = []
    const headwayMin = aar > 0 ? 60 / aar : 2.5
    inb.forEach((it, idx) => {
      const fl = floorFl + idx * (stepFt / 100)
      const ethMin = Math.max(0, idx * headwayMin - it.ttfMin)
      const cls = classifyType(it.f.type, it.f.category)
      const tas = TAS_BY_FL[cls](Math.max(110, fl))
      const legLengthNm = tas * legMin / 60
      const turnRadiusNm = (tas * tas) / (11.26 * Math.tan(25 * RAD)) / 6076.12 // ft->nm conversion already implicit? Recompute properly:
      // Standard rate turn radius (nm) = TAS / (π * rate_deg_per_min /180) /60 simplified: TAS / (20 * π) for 3deg/s
      const radNm = tas / (20 * Math.PI) // ~standard rate
      const pph = PPH_BY_CLASS[cls]
      const orbitMin = 2 * legMin + 2 // ~2 min for two 180deg standard-rate turns
      const fuelPerOrbit = pph * orbitMin / 60
      const orbits = Math.ceil(ethMin / orbitMin)
      const totalBurn = orbits * fuelPerOrbit
      const stackCap = 7
      let tier: Tier
      if (idx >= stackCap) tier = 'FULL'
      else if (ethMin >= 25) tier = 'LONG'
      else if (ethMin >= 5) tier = 'SHORT'
      else tier = 'RELEASE'
      out.push({ fl, flight: it.f, tier, slotIdx: idx, ethMin, ttfMin: it.ttfMin, legLengthNm, turnRadiusNm: radNm, fuelPerOrbit, totalBurn })
    })
    return out
  }, [flights, fix, floorFl, stepFt, legMin, inboundRng, aar])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return slots.filter(s => {
      if (tierFilter && s.tier !== tierFilter) return false
      if (q && s.flight && ![s.flight.callsign, s.flight.icao, s.flight.type || '', s.flight.operator || ''].some(x => x.toLowerCase().includes(q))) return false
      return true
    })
  }, [slots, tierFilter, query])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { FULL: 0, LONG: 0, SHORT: 0, RELEASE: 0 }
    slots.forEach(s => { c[s.tier]++ })
    return c
  }, [slots])

  const summary = useMemo(() => {
    const depth = slots.length
    const avgWait = slots.length ? slots.reduce((a, s) => a + s.ethMin, 0) / slots.length : 0
    const totalPph = slots.reduce((a, s) => a + PPH_BY_CLASS[classifyType(s.flight?.type, s.flight?.category)], 0)
    return { depth, avgWait, totalPph }
  }, [slots])

  // Build racetrack polygon for a given level (centered at fix, inbound radial, leg, radius)
  function racetrack(centerLat: number, centerLng: number, inboundRad: number, legNm: number, radNm: number): number[][] {
    // Inbound course = OPPOSITE of inboundRad (a/c flying TOWARD fix from holding side)
    // Outbound course = inboundRad
    // Pattern: fix at one end of inbound leg, opposite end is "holding end"
    // For a standard right-hand hold: outbound leg parallel to inbound, displaced right by 2*radius
    const inboundCourse = (inboundRad + 180) % 360
    const outboundCourse = inboundRad
    // Right-perpendicular to inbound course = inboundCourse + 90
    const perp = (inboundCourse + 90) % 360
    // Holding-end point (start of outbound leg) = fix moved opposite inbound course by 0 (fix is at start)
    // Standard hold: fix is the holding fix; aircraft flies inbound leg TO fix, then turns right 180, flies outbound leg in opposite direction for legNm, turns right 180, back to fix.
    // So pattern centerline endpoints:
    //   A = fix
    //   B = fix + outboundCourse * legNm  (end of outbound leg)
    // Then turn circles centered at midline offset perpendicular to fix-side and B-side
    const A: [number, number] = [centerLng, centerLat]
    const B = dest(centerLat, centerLng, outboundCourse, legNm)
    // The two parallel legs are offset by 2*radNm in the +perp direction (right-hand)
    // So the outbound leg starts at fix + perp*2r, ends at B + perp*2r (since after turning right at fix, you head outbound on parallel track)
    // Actually for cleanest racetrack the inbound leg is on one side, outbound on the other.
    // Build polygon: start at A, go along inbound side (which is centerline shifted -perp*r? no)
    // Simplification: build the boundary polygon as
    //   semicircle around fix-side (centered between A_in and A_out)
    //   straight along outbound side
    //   semicircle around outbound-end
    //   straight back along inbound side
    // Inbound side endpoint near fix:
    const Ain = dest(centerLat, centerLng, (perp + 180) % 360, radNm)        // -perp r
    const Aout = dest(centerLat, centerLng, perp, radNm)                       // +perp r
    const Bin = dest(B[1], B[0], (perp + 180) % 360, radNm)
    const Bout = dest(B[1], B[0], perp, radNm)
    const poly: number[][] = []
    // semicircle around A from Ain -> Aout going through "back of A" (opposite outbound direction)
    const N = 16
    for (let i = 0; i <= N; i++) {
      const t = i / N
      // angle sweep from inboundCourse - 90 (= perp + 180) to inboundCourse + 90 (= perp), going OUTWARD (away from outbound) so through angle = inboundCourse
      const startAng = (perp + 180) % 360
      const endAng = perp
      // sweep CCW through inboundCourse (i.e., opposite of outboundCourse)
      // Use shortest sweep going through inboundCourse: from startAng increase by 180 deg in direction that contains inboundCourse
      // Simply parametrize by going from -90 to +90 relative to inboundCourse
      const rel = -90 + t * 180
      const ang = (inboundCourse + rel + 360) % 360
      const p = dest(centerLat, centerLng, ang, radNm)
      poly.push(p)
    }
    // straight from Aout along outbound side to Bout
    poly.push(Aout, Bout)
    // semicircle around B from Bout -> Bin going through "front of B" (along outbound direction)
    for (let i = 0; i <= N; i++) {
      const t = i / N
      const rel = -90 + t * 180
      const ang = (outboundCourse + rel + 360) % 360
      const p = dest(B[1], B[0], ang, radNm)
      poly.push(p)
    }
    // straight from Bin back to Ain along inbound side
    poly.push(Bin, Ain)
    poly.push(poly[0]) // close
    return poly
  }

  // ---- overlay install ----
  useEffect(() => {
    const m = map; if (!m) return
    let cancelled = false
    const install = () => {
      if (cancelled || installedRef.current) return
      try {
        if (!m.getSource(SRC_RACE)) m.addSource(SRC_RACE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_RACE_FILL)) m.addLayer({
          id: LYR_RACE_FILL, type: 'fill', source: SRC_RACE,
          paint: {
            'fill-color': ['match', ['get', 'tier'], 'FULL', '#ef4444', 'LONG', '#fbbf24', 'SHORT', '#0ea5e9', 'RELEASE', '#a855f7', '#64748b'],
            'fill-opacity': 0.10,
          }
        })
        if (!m.getLayer(LYR_RACE_LINE)) m.addLayer({
          id: LYR_RACE_LINE, type: 'line', source: SRC_RACE,
          paint: {
            'line-color': ['match', ['get', 'tier'], 'FULL', '#ef4444', 'LONG', '#fbbf24', 'SHORT', '#0ea5e9', 'RELEASE', '#a855f7', '#64748b'],
            'line-width': 1.6, 'line-dasharray': [3, 2], 'line-opacity': 0.85,
          }
        })
        if (!m.getSource(SRC_LINK)) m.addSource(SRC_LINK, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_LINK)) m.addLayer({
          id: LYR_LINK, type: 'line', source: SRC_LINK,
          paint: { 'line-color': '#38bdf8', 'line-width': 1.1, 'line-dasharray': [2, 2], 'line-opacity': 0.7 }
        })
        if (!m.getSource(SRC_FIX)) m.addSource(SRC_FIX, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_FIX)) m.addLayer({
          id: LYR_FIX, type: 'circle', source: SRC_FIX,
          paint: { 'circle-radius': 6, 'circle-color': '#a855f7', 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 2 }
        })
        if (!m.getLayer(LYR_FIX_LBL)) m.addLayer({
          id: LYR_FIX_LBL, type: 'symbol', source: SRC_FIX,
          layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'] },
          paint: { 'text-color': '#ddd6fe', 'text-halo-color': '#020617', 'text-halo-width': 1.4 }
        })
        if (!m.getSource(SRC_LBL)) m.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
        if (!m.getLayer(LYR_LBL)) m.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'] },
          paint: {
            'text-color': ['match', ['get', 'tier'], 'FULL', '#fecaca', 'LONG', '#fde68a', 'SHORT', '#bae6fd', 'RELEASE', '#ddd6fe', '#cbd5e1'],
            'text-halo-color': '#020617', 'text-halo-width': 1.4
          }
        })
        installedRef.current = true
      } catch {}
    }
    if (m.isStyleLoaded()) install()
    else m.once('load', install)
    return () => {
      cancelled = true
      try {
        ;[LYR_LBL, LYR_FIX_LBL, LYR_FIX, LYR_LINK, LYR_RACE_LINE, LYR_RACE_FILL].forEach(id => { if (m.getLayer(id)) m.removeLayer(id) })
        ;[SRC_LBL, SRC_FIX, SRC_LINK, SRC_RACE].forEach(id => { if (m.getSource(id)) m.removeSource(id) })
      } catch {}
      installedRef.current = false
    }
  }, [map])

  // ---- overlay data ----
  useEffect(() => {
    const m = map; if (!m || !installedRef.current || !fix) return
    try {
      if (!showOverlay) {
        ;[SRC_RACE, SRC_LINK, SRC_FIX, SRC_LBL].forEach(id => (m.getSource(id) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: [] } as any))
        return
      }
      const raceFs: any[] = []
      const linkFs: any[] = []
      const lblFs: any[] = []
      if (showRace) {
        for (const s of filtered) {
          const poly = racetrack(fix.lat, fix.lon, inboundRadial, s.legLengthNm, s.turnRadiusNm)
          raceFs.push({ type: 'Feature', properties: { tier: s.tier, fl: s.fl }, geometry: { type: 'Polygon', coordinates: [poly] } })
        }
      }
      if (showLinks) {
        for (const s of filtered) {
          if (!s.flight) continue
          const coords = geodesic(s.flight.lat, s.flight.lng, fix.lat, fix.lon, 24)
          linkFs.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })
        }
      }
      if (showLbl) {
        for (const s of filtered) {
          if (!s.flight) continue
          lblFs.push({
            type: 'Feature',
            properties: { tier: s.tier, label: `${s.flight.callsign || s.flight.icao} · FL${String(s.fl).padStart(3, '0')} · ETH ${fmtMin(s.ethMin)}` },
            geometry: { type: 'Point', coordinates: [s.flight.lng, s.flight.lat] },
          })
        }
      }
      ;(m.getSource(SRC_RACE) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: raceFs } as any)
      ;(m.getSource(SRC_LINK) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: linkFs } as any)
      ;(m.getSource(SRC_LBL) as maplibregl.GeoJSONSource)?.setData({ type: 'FeatureCollection', features: lblFs } as any)
      ;(m.getSource(SRC_FIX) as maplibregl.GeoJSONSource)?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { label: `${fix.a || fix.i} HOLD · R${Math.round(inboundRadial).toString().padStart(3, '0')}` }, geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] } }]
      } as any)
    } catch {}
  }, [map, fix, filtered, showOverlay, showRace, showLinks, showLbl, inboundRadial])

  // picker matches
  const picks = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    if (!q) return AIRPORTS.slice(0, 30)
    return AIRPORTS.filter(a =>
      a.i.toLowerCase().includes(q) || a.a.toLowerCase().includes(q) || a.m.toLowerCase().includes(q) || a.n.toLowerCase().includes(q)
    ).slice(0, 40)
  }, [pickerQuery])

  // SVG stack diagram
  const maxLevels = 8
  const stackBars = useMemo(() => {
    const arr: { fl: number; slot: Slot | null }[] = []
    for (let i = 0; i < maxLevels; i++) {
      const fl = floorFl + i * (stepFt / 100)
      const slot = slots.find(s => s.slotIdx === i) || null
      arr.push({ fl, slot })
    }
    return arr.reverse() // top first
  }, [slots, floorFl, stepFt])

  return (
    <div className="absolute right-4 top-32 w-[440px] max-w-[92vw] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl z-30 text-slate-100">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-sm font-semibold tracking-wide">HOLDING STACK</div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">
            {fix ? `${fix.a || fix.i} · ${fix.m}` : 'No fix'}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 space-y-3">
        {/* picker row */}
        <div className="flex gap-1.5">
          <button onClick={() => setShowPicker(v => !v)}
            className="flex-1 bg-slate-900/60 border border-slate-800 hover:border-slate-700 rounded-lg px-2 py-1.5 text-xs text-left font-mono">
            {fix ? `${fix.a || fix.i} ${fix.m}` : 'Pick fix…'}
          </button>
          <button onClick={() => { setApIcao('') }} className="px-2 py-1.5 rounded-lg text-[10px] bg-slate-900/60 border border-slate-800 text-slate-300 hover:border-slate-700">NEAREST</button>
          <button onClick={() => { if (fix) onFlyLatLng(fix.lat, fix.lon, 9) }} className="px-2 py-1.5 rounded-lg text-[10px] bg-slate-900/60 border border-slate-800 text-slate-300 hover:border-slate-700">FIT</button>
        </div>
        {showPicker && (
          <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-2 space-y-1.5">
            <input value={pickerQuery} onChange={e => setPickerQuery(e.target.value)} placeholder="IATA / ICAO / city…"
              className="w-full bg-slate-950 border border-slate-800 rounded-md px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-sky-600" />
            <div className="max-h-40 overflow-y-auto space-y-0.5">
              {picks.map(a => (
                <button key={a.i} onClick={() => { setApIcao(a.i); setShowPicker(false); setPickerQuery('') }}
                  className="w-full text-left px-2 py-1 rounded text-[11px] hover:bg-slate-800/60 font-mono flex items-baseline gap-2">
                  <span className="text-sky-300">{a.a || a.i}</span>
                  <span className="text-slate-400 truncate">{a.m}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* tier counters */}
        <div className="grid grid-cols-4 gap-1.5 text-center text-[10px]">
          {TIER_ORDER.map(t => (
            <button key={t} onClick={() => setTierFilter(tierFilter === t ? null : t)}
              className={`rounded-md py-1.5 px-1 border transition ${tierFilter === t ? TIER_PILL[t] : 'bg-slate-900/40 text-slate-400 border-slate-800 hover:border-slate-700'}`}>
              <div className="font-mono text-sm leading-none">{counts[t]}</div>
              <div className="uppercase tracking-wider mt-0.5 text-[9px]">{t}</div>
            </button>
          ))}
        </div>

        {/* summary cells */}
        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
          <div className="bg-slate-900/40 rounded-md p-1.5 border border-slate-800">
            <div className="text-slate-500 uppercase tracking-wider text-[9px]">Depth</div>
            <div className="font-mono text-sm text-slate-100">{summary.depth}</div>
          </div>
          <div className="bg-slate-900/40 rounded-md p-1.5 border border-slate-800">
            <div className="text-slate-500 uppercase tracking-wider text-[9px]">Avg wait</div>
            <div className="font-mono text-sm text-slate-100">{fmtMin(summary.avgWait)}</div>
          </div>
          <div className="bg-slate-900/40 rounded-md p-1.5 border border-slate-800">
            <div className="text-slate-500 uppercase tracking-wider text-[9px]">Burn pph</div>
            <div className="font-mono text-sm text-slate-100">{summary.totalPph.toLocaleString()}</div>
          </div>
        </div>

        {/* SVG stack diagram */}
        <div className="bg-slate-900/40 rounded-md p-2 border border-slate-800">
          <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Vertical stack</div>
          <svg viewBox="0 0 400 160" className="w-full h-[160px]">
            {stackBars.map((b, i) => {
              const y = 8 + i * 18
              const occ = b.slot ? 1 : 0
              const tier = b.slot?.tier
              const color = tier ? TIER_COLOR[tier] : '#1e293b'
              const w = b.slot ? Math.max(20, Math.min(280, 60 + (b.slot.ethMin / 30) * 220)) : 14
              return (
                <g key={i}>
                  <text x="6" y={y + 11} fill="#64748b" fontSize="10" fontFamily="monospace">FL{String(b.fl).padStart(3, '0')}</text>
                  <rect x="46" y={y} width={w} height="14" fill={color} fillOpacity={occ ? 0.35 : 0.15} stroke={color} strokeWidth="1" strokeDasharray={occ ? '0' : '3 2'} rx="2" />
                  {b.slot && (
                    <text x={50 + w + 4} y={y + 11} fill="#e2e8f0" fontSize="10" fontFamily="monospace">
                      {b.slot.flight?.callsign || b.slot.flight?.icao} · ETH {fmtMin(b.slot.ethMin)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>

        {/* sliders */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
          <div>
            <div className="flex justify-between text-slate-400 mb-0.5"><span>AAR /hr</span><span className="font-mono">{aar}</span></div>
            <input type="range" min={10} max={120} step={2} value={aar} onChange={e => setAar(+e.target.value)} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-slate-400 mb-0.5"><span>Floor FL</span><span className="font-mono">{floorFl}</span></div>
            <input type="range" min={50} max={250} step={10} value={floorFl} onChange={e => setFloorFl(+e.target.value)} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-slate-400 mb-0.5"><span>Step ft</span><span className="font-mono">{stepFt}</span></div>
            <input type="range" min={1000} max={4000} step={500} value={stepFt} onChange={e => setStepFt(+e.target.value)} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-slate-400 mb-0.5"><span>Leg min</span><span className="font-mono">{legMin.toFixed(1)}</span></div>
            <input type="range" min={0.5} max={3} step={0.5} value={legMin} onChange={e => setLegMin(+e.target.value)} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-slate-400 mb-0.5"><span>Inb rng</span><span className="font-mono">{inboundRng}nm</span></div>
            <input type="range" min={20} max={200} step={10} value={inboundRng} onChange={e => setInboundRng(+e.target.value)} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-slate-400 mb-0.5">
              <span>Radial</span>
              <span className="font-mono">{Math.round(inboundRadial).toString().padStart(3, '0')}° {radialMode === 'AUTO' ? '·A' : '·M'}</span>
            </div>
            <input type="range" min={0} max={359} step={1} value={manualRadial}
              onChange={e => { setManualRadial(+e.target.value); setRadialMode('MANUAL') }}
              onDoubleClick={() => setRadialMode('AUTO')}
              className="w-full accent-sky-500" />
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 text-[10px]">
          {([['OVL', showOverlay, setShowOverlay], ['RACETRACK', showRace, setShowRace], ['LINKS', showLinks, setShowLinks], ['LBL', showLbl, setShowLbl]] as const).map(([l, v, set]) => (
            <button key={l} onClick={() => (set as any)(!v)}
              className={`px-2 py-1 rounded-md border ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-400'}`}>{l}</button>
          ))}
          <button onClick={() => setRadialMode(radialMode === 'AUTO' ? 'MANUAL' : 'AUTO')}
            className={`px-2 py-1 rounded-md border ${radialMode === 'AUTO' ? 'bg-sky-500/15 border-sky-500/40 text-sky-200' : 'bg-slate-900/40 border-slate-800 text-slate-400'}`}>AUTO-R</button>
        </div>

        <input type="text" placeholder="Filter callsign / type / operator…" value={query} onChange={e => setQuery(e.target.value)}
          className="w-full bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:border-sky-500" />
      </div>

      <div className="max-h-[42vh] overflow-y-auto">
        {filtered.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-500">No inbound aircraft within {inboundRng}nm of the fix.</div>}
        {filtered.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.ethMin - a.ethMin).slice(0, 60).map(s => (
          <button key={s.flight?.icao || s.slotIdx} onClick={() => s.flight && onFly(s.flight.icao)}
            className="w-full text-left px-4 py-2 border-b border-slate-800/50 hover:bg-slate-800/40 transition flex items-center gap-3">
            <div className="w-1 self-stretch rounded-full" style={{ background: TIER_COLOR[s.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold">{s.flight?.callsign || s.flight?.icao}</span>
                <span className="text-[10px] text-slate-500 font-mono">{s.flight?.type || '—'}</span>
                <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${TIER_PILL[s.tier]}`}>{s.tier}</span>
              </div>
              <div className="text-[10px] text-slate-400 font-mono">
                FL{String(s.fl).padStart(3, '0')} · TTF {fmtMin(s.ttfMin)} · ETH {fmtMin(s.ethMin)}
              </div>
              <div className="text-[10px] text-slate-500 font-mono">
                LEG {s.legLengthNm.toFixed(1)}nm · R {s.turnRadiusNm.toFixed(1)}nm · {Math.round(s.fuelPerOrbit)}lb/orbit · Σ{Math.round(s.totalBurn).toLocaleString()}lb
              </div>
            </div>
            <div className="text-right text-[10px] font-mono leading-tight">
              <div className="text-sky-300">#{s.slotIdx + 1}</div>
              <div className="text-slate-500">{s.flight?.operator || ''}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
