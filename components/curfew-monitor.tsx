'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   Night Curfew Monitor
   -----------------------------------------------------------
   Real ops concern: many major airports enforce night-flight
   bans, slot restrictions or noise-quota windows. Movements
   during the closed window trigger fines, route deviation,
   or forced diversion. Examples in this dataset:

     LHR  London Heathrow      23:30 -> 06:00  (CAA Section 78)
     LGW  London Gatwick       23:30 -> 06:00
     STN  Stansted             23:30 -> 06:00
     FRA  Frankfurt            23:00 -> 05:00  (hard 22-06 quota)
     MUC  Munich               00:00 -> 05:00
     DUS  Dusseldorf           22:00 -> 06:00
     ZRH  Zurich               23:00 -> 06:00  (extended to 23:30)
     BRU  Brussels             23:00 -> 06:00  (Plan Wathelet)
     AMS  Schiphol             slot-restricted nightly
     ORY  Paris-Orly           23:30 -> 06:00  (hard ban)
     CDG  Paris-CDG            00:00 -> 05:00  (quota count)
     VIE  Vienna               23:30 -> 05:30
     MXP  Milan-Malpensa       23:00 -> 06:00
     LIN  Milan-Linate         23:00 -> 06:30
     MAD  Madrid-Barajas       slot-restricted 23-07
     BCN  Barcelona            23:00 -> 07:00
     LIS  Lisbon               00:00 -> 06:00
     DUB  Dublin               23:00 -> 07:00  (proposed cap)
     SYD  Sydney               23:00 -> 06:00  (Sydney Airport Curfew Act 1995)
     HND  Tokyo-Haneda         23:00 -> 06:00  (limited slots)
     ITM  Osaka-Itami          21:00 -> 07:00

   For each curfew airport we evaluate every airborne aircraft
   on a closing track (cos(track - bearingToAirport) > -0.2,
   distance < INB-RNG nm) and compute ETA = nm / GS hours.
   Local time at touchdown is built by adding airport timezone
   offset (precomputed per airport) to UTC ETA. We then test
   whether the resulting local-time minute-of-day falls inside
   the airport's curfew window (handles midnight wrap).

   Severity tiers per inbound aircraft:
     BREACH    - landing inside the curfew window
     MARGIN    - lands within 15 min of curfew open
     CAUTION   - lands within 30 min before close OR 30 min after open
     CLEAR     - lands well outside curfew (also LZ for not-yet-active airports)

   Per airport rollup tiers (same names, worst of any inbound).

   MapLibre overlay:
     - violet airport pin per curfew airport with IATA + window label
     - tier-coloured halo + dashed range ring (INB-RNG) per airport
     - dashed link line from each inbound aircraft to its airport
       coloured by per-aircraft tier
     - callsign + ETA-local label on each inbound aircraft

   Side panel:
     - 4-tier counter strip (BREACH/MARGIN/CAUTION/CLEAR click-to-filter)
     - 3-cell summary: BREACH count / NEXT-CURFEW (min to nearest open)
       / TRACKED inbound count
     - INB-RNG slider 30-400nm
     - SAFETY-BUFFER slider 0-60 min (raises MARGIN/CAUTION sensitivity)
     - NOW-OVERRIDE slider -24..+24 h for what-if rehearsals
     - OVL / RING / LINKS / LBL toggles
     - search box (callsign / type / operator / icao / iata)
     - AIRPORTS tab (worst tier first, time-to-open countdown)
     - INBOUNDS tab (per-aircraft worst-first then ETA asc)
     - click-to-fly per row
   ============================================================ */

export interface CfFlight {
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
  flights: CfFlight[]
  onClose: () => void
  onFly: (icao: string) => void
  onFlyLatLng: (lat: number, lng: number, zoom?: number) => void
}

type Tier = 'BREACH' | 'MARGIN' | 'CAUTION' | 'CLEAR'
const TIER_COLOR: Record<Tier, string> = {
  BREACH: '#f43f5e',
  MARGIN: '#f59e0b',
  CAUTION: '#eab308',
  CLEAR: '#38bdf8',
}
const TIER_ORDER: Tier[] = ['BREACH', 'MARGIN', 'CAUTION', 'CLEAR']
const TIER_RANK: Record<Tier, number> = { BREACH: 0, MARGIN: 1, CAUTION: 2, CLEAR: 3 }

// Curfew airport catalog: [iata, name, lat, lng, openMin, closeMin, tzOffsetHrs(std)]
// open/close are local minutes-of-day, window = [open, close) wrapping midnight
type Curfew = { iata: string; name: string; lat: number; lng: number; openMin: number; closeMin: number; tz: number; note: string }
const CURFEWS: Curfew[] = [
  { iata: 'LHR', name: 'London Heathrow',     lat: 51.470, lng: -0.454, openMin: 23*60+30, closeMin: 6*60+0,  tz: 0,  note: 'CAA s.78' },
  { iata: 'LGW', name: 'London Gatwick',      lat: 51.148, lng: -0.190, openMin: 23*60+30, closeMin: 6*60+0,  tz: 0,  note: 'CAA s.78' },
  { iata: 'STN', name: 'London Stansted',     lat: 51.885, lng:  0.235, openMin: 23*60+30, closeMin: 6*60+0,  tz: 0,  note: 'CAA s.78' },
  { iata: 'FRA', name: 'Frankfurt',           lat: 50.033, lng:  8.570, openMin: 23*60,    closeMin: 5*60,    tz: 1,  note: 'HMUKLV' },
  { iata: 'MUC', name: 'Munich',              lat: 48.353, lng: 11.786, openMin: 0,         closeMin: 5*60,    tz: 1,  note: 'BayLVwG' },
  { iata: 'DUS', name: 'Dusseldorf',          lat: 51.289, lng:  6.766, openMin: 22*60,    closeMin: 6*60,    tz: 1,  note: 'noise quota' },
  { iata: 'TXL', name: 'Berlin Tegel (hist)', lat: 52.554, lng: 13.292, openMin: 23*60,    closeMin: 6*60,    tz: 1,  note: 'BER replaces' },
  { iata: 'BER', name: 'Berlin Brandenburg',  lat: 52.366, lng: 13.503, openMin: 23*60+30, closeMin: 5*60+30, tz: 1,  note: 'Sleep prot.' },
  { iata: 'ZRH', name: 'Zurich',              lat: 47.458, lng:  8.548, openMin: 23*60,    closeMin: 6*60,    tz: 1,  note: 'BAZL' },
  { iata: 'GVA', name: 'Geneva',              lat: 46.238, lng:  6.109, openMin: 0,         closeMin: 6*60,    tz: 1,  note: 'BAZL' },
  { iata: 'BRU', name: 'Brussels',            lat: 50.901, lng:  4.484, openMin: 23*60,    closeMin: 6*60,    tz: 1,  note: 'Plan Wathelet' },
  { iata: 'AMS', name: 'Schiphol',            lat: 52.309, lng:  4.764, openMin: 23*60,    closeMin: 6*60,    tz: 1,  note: 'Slot/quota' },
  { iata: 'ORY', name: 'Paris Orly',          lat: 48.726, lng:  2.366, openMin: 23*60+30, closeMin: 6*60,    tz: 1,  note: 'Hard ban' },
  { iata: 'CDG', name: 'Paris CDG',           lat: 49.010, lng:  2.548, openMin: 0,         closeMin: 5*60,    tz: 1,  note: 'Quota count' },
  { iata: 'VIE', name: 'Vienna',              lat: 48.110, lng: 16.570, openMin: 23*60+30, closeMin: 5*60+30, tz: 1,  note: 'Austro Control' },
  { iata: 'MXP', name: 'Milan Malpensa',      lat: 45.630, lng:  8.728, openMin: 23*60,    closeMin: 6*60,    tz: 1,  note: 'ENAC' },
  { iata: 'LIN', name: 'Milan Linate',        lat: 45.445, lng:  9.276, openMin: 23*60,    closeMin: 6*60+30, tz: 1,  note: 'ENAC' },
  { iata: 'FCO', name: 'Rome Fiumicino',      lat: 41.800, lng: 12.239, openMin: 0,         closeMin: 5*60,    tz: 1,  note: 'ENAC slot' },
  { iata: 'MAD', name: 'Madrid Barajas',      lat: 40.472, lng: -3.561, openMin: 23*60,    closeMin: 7*60,    tz: 1,  note: 'AENA slot' },
  { iata: 'BCN', name: 'Barcelona El Prat',   lat: 41.297, lng:  2.078, openMin: 23*60,    closeMin: 7*60,    tz: 1,  note: 'AENA quota' },
  { iata: 'LIS', name: 'Lisbon Portela',      lat: 38.781, lng: -9.135, openMin: 0,         closeMin: 6*60,    tz: 0,  note: 'ANAC' },
  { iata: 'DUB', name: 'Dublin',              lat: 53.421, lng: -6.270, openMin: 23*60,    closeMin: 7*60,    tz: 0,  note: 'proposed cap' },
  { iata: 'CPH', name: 'Copenhagen',          lat: 55.618, lng: 12.656, openMin: 23*60,    closeMin: 6*60,    tz: 1,  note: 'noise quota' },
  { iata: 'OSL', name: 'Oslo Gardermoen',     lat: 60.194, lng: 11.100, openMin: 0,         closeMin: 6*60,    tz: 1,  note: 'Avinor' },
  { iata: 'ARN', name: 'Stockholm Arlanda',   lat: 59.652, lng: 17.918, openMin: 0,         closeMin: 6*60,    tz: 1,  note: 'noise quota' },
  { iata: 'SYD', name: 'Sydney Kingsford',    lat: -33.946,lng:151.177, openMin: 23*60,    closeMin: 6*60,    tz: 10, note: 'Curfew Act 1995' },
  { iata: 'HND', name: 'Tokyo Haneda',        lat: 35.553, lng:139.781, openMin: 23*60,    closeMin: 6*60,    tz: 9,  note: 'slot cap' },
  { iata: 'ITM', name: 'Osaka Itami',         lat: 34.785, lng:135.438, openMin: 21*60,    closeMin: 7*60,    tz: 9,  note: 'hard ban' },
  { iata: 'TPE', name: 'Taipei Taoyuan',      lat: 25.078, lng:121.234, openMin: 23*60,    closeMin: 6*60,    tz: 8,  note: 'noise abatement' },
  { iata: 'BOM', name: 'Mumbai Chhatrapati',  lat: 19.089, lng: 72.868, openMin: 0,         closeMin: 6*60,    tz: 5.5,note: 'runway maint.' },
  { iata: 'WLG', name: 'Wellington',          lat: -41.327,lng:174.805, openMin: 0,         closeMin: 6*60,    tz: 12, note: 'noise consent' },
]

const SRC_PIN  = 'cf-pin-src',  LYR_PIN  = 'cf-pin-lyr',  LYR_PIN_LBL = 'cf-pin-lbl'
const SRC_RING = 'cf-ring-src', LYR_RING = 'cf-ring-lyr'
const SRC_LNK  = 'cf-lnk-src',  LYR_LNK  = 'cf-lnk-lyr'
const SRC_LBL  = 'cf-lbl-src',  LYR_LBL  = 'cf-lbl-lyr'

function deg2rad(d: number) { return d * Math.PI / 180 }
function distNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065
  const dLat = deg2rad(lat2 - lat1), dLng = deg2rad(lng2 - lng1)
  const a = Math.sin(dLat/2)**2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = deg2rad(lat1), φ2 = deg2rad(lat2), Δλ = deg2rad(lng2 - lng1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function ringPoly(lat: number, lng: number, radiusNm: number, n = 64): [number, number][] {
  const out: [number, number][] = []
  const R = radiusNm / 60
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI
    const dLat = R * Math.cos(a)
    const dLng = R * Math.sin(a) / Math.max(0.1, Math.cos(deg2rad(lat)))
    out.push([lng + dLng, lat + dLat])
  }
  return out
}
function fmtMin(m: number): string { // minutes -> HH:MM
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60)
  const mm = Math.floor(((m % 1440) + 1440) % 1440) % 60
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`
}
function inWindow(localMin: number, openMin: number, closeMin: number): boolean {
  const lm = ((localMin % 1440) + 1440) % 1440
  if (openMin === closeMin) return false
  if (openMin < closeMin) return lm >= openMin && lm < closeMin
  // wraps midnight
  return lm >= openMin || lm < closeMin
}
// minutes until next 'open' edge given current local minute (always >=0, <1440)
function minToOpen(localMin: number, openMin: number): number {
  const lm = ((localMin % 1440) + 1440) % 1440
  const diff = (openMin - lm + 1440) % 1440
  return diff
}
function minToClose(localMin: number, openMin: number, closeMin: number): number {
  // assumes inWindow == true; returns minutes until close edge
  const lm = ((localMin % 1440) + 1440) % 1440
  return ((closeMin - lm + 1440) % 1440) || 1440
}

export default function CurfewMonitor({ map, flights, onClose, onFly, onFlyLatLng }: Props) {
  const [inbRng, setInbRng] = useState<number>(180)
  const [buffer, setBuffer] = useState<number>(15)
  const [nowOffsetHrs, setNowOffsetHrs] = useState<number>(0)
  const [showOvl, setShowOvl] = useState(true)
  const [showRings, setShowRings] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [tab, setTab] = useState<'INBOUNDS' | 'AIRPORTS'>('INBOUNDS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [, setNowTick] = useState(0)

  useEffect(() => { const id = setInterval(() => setNowTick(t => t + 1), 30000); return () => clearInterval(id) }, [])

  const nowUtcMs = Date.now() + nowOffsetHrs * 3600 * 1000

  // ---- per-aircraft analysis ----
  type Inb = {
    f: CfFlight
    ap: Curfew
    distNm: number
    bearingTo: number
    closure: number // kts toward ap
    etaMin: number  // mins from now to touchdown
    localMin: number // local minute-of-day at touchdown
    tier: Tier
    bufferMin: number // signed margin to nearest curfew edge (+ => inside curfew, - => outside)
  }
  const analysis = useMemo(() => {
    const inbs: Inb[] = []
    const apTier = new Map<string, { worst: Tier; nInb: number; nBreach: number }>()
    for (const c of CURFEWS) apTier.set(c.iata, { worst: 'CLEAR', nInb: 0, nBreach: 0 })

    for (const f of flights) {
      if (f.ground) continue
      if (f.altitudeFt < 1000) continue
      if (!Number.isFinite(f.velocityKts) || f.velocityKts < 80) continue
      for (const ap of CURFEWS) {
        const dN = distNm(f.lat, f.lng, ap.lat, ap.lng)
        if (dN > inbRng) continue
        const brg = bearingDeg(f.lat, f.lng, ap.lat, ap.lng)
        const trkDiff = ((f.track - brg + 540) % 360) - 180 // -180..180
        const cosTheta = Math.cos(trkDiff * Math.PI / 180)
        if (cosTheta < -0.2) continue // moving away
        const closure = Math.max(60, f.velocityKts * cosTheta)
        const etaHr = dN / closure
        if (etaHr > 4) continue // out of scope
        const etaMin = etaHr * 60
        const touchdownUtcMin = ((nowUtcMs / 60000) % 1440 + etaMin)
        const localMin = touchdownUtcMin + ap.tz * 60
        const inside = inWindow(localMin, ap.openMin, ap.closeMin)
        // signed buffer (mins to nearest edge); positive => inside curfew
        let signedBuf: number
        if (inside) {
          signedBuf = +Math.min(
            ((localMin - ap.openMin + 1440) % 1440),
            ((ap.closeMin - localMin + 1440) % 1440)
          )
        } else {
          signedBuf = -Math.min(
            minToOpen(localMin, ap.openMin),
            ((localMin - ap.closeMin + 1440) % 1440)
          )
        }
        let tier: Tier
        if (inside) tier = 'BREACH'
        else if (-signedBuf <= buffer) tier = 'MARGIN'
        else if (-signedBuf <= buffer * 2) tier = 'CAUTION'
        else tier = 'CLEAR'

        inbs.push({ f, ap, distNm: dN, bearingTo: brg, closure, etaMin, localMin, tier, bufferMin: signedBuf })
        const rec = apTier.get(ap.iata)!
        rec.nInb++
        if (tier === 'BREACH') rec.nBreach++
        if (TIER_RANK[tier] < TIER_RANK[rec.worst]) rec.worst = tier
      }
    }
    return { inbs, apTier }
  }, [flights, inbRng, buffer, nowUtcMs])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { BREACH: 0, MARGIN: 0, CAUTION: 0, CLEAR: 0 }
    for (const r of analysis.inbs) c[r.tier]++
    return c
  }, [analysis])

  // minutes to nearest curfew window opening across all airports (informative)
  const nextOpenMin = useMemo(() => {
    const nowMinUtc = nowUtcMs / 60000
    let best = Infinity
    for (const ap of CURFEWS) {
      const localNow = nowMinUtc + ap.tz * 60
      // skip if already inside curfew
      if (inWindow(localNow, ap.openMin, ap.closeMin)) continue
      const m = minToOpen(localNow, ap.openMin)
      if (m < best) best = m
    }
    return best === Infinity ? null : best
  }, [nowUtcMs])

  const rankedInb = useMemo(() => {
    const q = query.trim().toLowerCase()
    return analysis.inbs
      .filter(r => tierFilter === 'ALL' || r.tier === tierFilter)
      .filter(r => !q || r.f.callsign?.toLowerCase().includes(q) || r.f.type?.toLowerCase().includes(q)
        || r.f.operator?.toLowerCase().includes(q) || r.f.icao.toLowerCase().includes(q) || r.ap.iata.toLowerCase().includes(q))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.etaMin - b.etaMin)
  }, [analysis, tierFilter, query])

  const rankedAp = useMemo(() => {
    const q = query.trim().toLowerCase()
    const nowMinUtc = nowUtcMs / 60000
    return CURFEWS
      .map(ap => {
        const rec = analysis.apTier.get(ap.iata)!
        const localNow = nowMinUtc + ap.tz * 60
        const active = inWindow(localNow, ap.openMin, ap.closeMin)
        const toEdge = active
          ? minToClose(localNow, ap.openMin, ap.closeMin)
          : minToOpen(localNow, ap.openMin)
        return { ap, ...rec, active, toEdge, localNow: ((localNow % 1440) + 1440) % 1440 }
      })
      .filter(x => !q || x.ap.iata.toLowerCase().includes(q) || x.ap.name.toLowerCase().includes(q))
      .filter(x => tierFilter === 'ALL' || x.worst === tierFilter || (tierFilter === 'BREACH' && x.nBreach > 0))
      .sort((a, b) => TIER_RANK[a.worst] - TIER_RANK[b.worst] || a.toEdge - b.toEdge)
  }, [analysis, tierFilter, query, nowUtcMs])

  // ---- MapLibre overlay ----
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SRC_RING)) map.addSource(SRC_RING, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_RING)) map.addLayer({
          id: LYR_RING, type: 'line', source: SRC_RING,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
        })
        if (!map.getSource(SRC_LNK)) map.addSource(SRC_LNK, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LNK)) map.addLayer({
          id: LYR_LNK, type: 'line', source: SRC_LNK,
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.75, 'line-dasharray': [1, 1.3] },
        })
        if (!map.getSource(SRC_PIN)) map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_PIN)) map.addLayer({
          id: LYR_PIN, type: 'circle', source: SRC_PIN,
          paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 },
        })
        if (!map.getLayer(LYR_PIN_LBL)) map.addLayer({
          id: LYR_PIN_LBL, type: 'symbol', source: SRC_PIN,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 },
        })
        if (!map.getSource(SRC_LBL)) map.addSource(SRC_LBL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        if (!map.getLayer(LYR_LBL)) map.addLayer({
          id: LYR_LBL, type: 'symbol', source: SRC_LBL,
          layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.4], 'text-anchor': 'bottom', 'text-allow-overlap': true },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 },
        })
      } catch {}
    }
    ensure()

    if (!showOvl) {
      try {
        for (const s of [SRC_RING, SRC_LNK, SRC_PIN, SRC_LBL]) {
          (map.getSource(s) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] })
        }
      } catch {}
      return
    }

    const ringFeats: any[] = []
    const pinFeats: any[] = []
    const nowMinUtc = nowUtcMs / 60000
    for (const ap of CURFEWS) {
      const rec = analysis.apTier.get(ap.iata)!
      const localNow = nowMinUtc + ap.tz * 60
      const active = inWindow(localNow, ap.openMin, ap.closeMin)
      const tier = rec.worst
      const color = active ? '#a78bfa' : TIER_COLOR[tier]
      if (showRings) {
        ringFeats.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ringPoly(ap.lat, ap.lng, inbRng)] },
          properties: { color },
        })
      }
      pinFeats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ap.lng, ap.lat] },
        properties: { color: active ? '#a78bfa' : '#38bdf8', label: showLabels ? `${ap.iata} ${fmtMin(ap.openMin)}-${fmtMin(ap.closeMin)}${active?' \u25CF NIGHT':''}` : ap.iata },
      })
    }

    const lnkFeats: any[] = []
    const lblFeats: any[] = []
    for (const r of analysis.inbs) {
      if (showLinks) {
        lnkFeats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.ap.lng, r.ap.lat]] },
          properties: { color: TIER_COLOR[r.tier] },
        })
      }
      if (showLabels) {
        const eta = `T+${Math.floor(r.etaMin)}m`
        const local = fmtMin(r.localMin)
        lblFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: { color: TIER_COLOR[r.tier], label: `${r.f.callsign?.trim() || r.f.icao} \u2192 ${r.ap.iata} ${eta} L${local}` },
        })
      }
    }

    try {
      ;(map.getSource(SRC_RING) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: ringFeats })
      ;(map.getSource(SRC_PIN) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pinFeats })
      ;(map.getSource(SRC_LNK) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lnkFeats })
      ;(map.getSource(SRC_LBL) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lblFeats })
    } catch {}
  }, [map, analysis, inbRng, showOvl, showRings, showLinks, showLabels, nowUtcMs])

  useEffect(() => () => {
    if (!map) return
    try { for (const l of [LYR_LBL, LYR_PIN_LBL, LYR_PIN, LYR_LNK, LYR_RING]) if (map.getLayer(l)) map.removeLayer(l) } catch {}
    try { for (const s of [SRC_LBL, SRC_PIN, SRC_LNK, SRC_RING]) if (map.getSource(s)) map.removeSource(s) } catch {}
  }, [map])

  // ---- SVG sparkline: 24h timeline of curfew windows ----
  const sparkline = useMemo(() => {
    const W = 360, H = 40, pad = 4
    const nowMinUtc = nowUtcMs / 60000
    const items: { x: number; w: number; tier: 'BREACH' | 'CLEAR' }[] = []
    // sweep next 24 hours, paint per-airport curfew windows merged at top
    const totalMins = 1440
    const innerW = W - 2 * pad
    const bars: { color: string; x: number; w: number; y: number; iata: string }[] = []
    const sortedAps = [...CURFEWS].sort((a, b) => a.tz - b.tz)
    sortedAps.slice(0, 12).forEach((ap, row) => {
      const y = pad + row * 2.2
      const localStart = nowMinUtc + ap.tz * 60
      // sample minute by minute (60-min resolution -> 24 cells)
      for (let h = 0; h < 24; h++) {
        const localM = localStart + h * 60 + 30
        if (inWindow(localM, ap.openMin, ap.closeMin)) {
          bars.push({ color: '#a78bfa', x: pad + (h / 24) * innerW, w: innerW / 24, y, iata: ap.iata })
        }
      }
    })
    void items
    return { W, H, bars }
  }, [nowUtcMs])

  return (
    <div className="fixed top-16 right-3 z-40 w-[420px] max-h-[calc(100vh-5rem)] flex flex-col rounded-lg border border-slate-800 bg-slate-950/95 backdrop-blur text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sky-400">&#9790;</span>
          <span className="text-sm font-semibold tracking-wide">CURFEW MONITOR</span>
          <span className="text-[10px] text-slate-500">night-flight ban watch</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">&times;</button>
      </div>

      <div className="px-3 py-2 grid grid-cols-4 gap-1 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t}
            onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex flex-col items-center rounded px-1 py-1 border ${tierFilter === t ? 'border-sky-500/40 bg-sky-500/15' : 'border-slate-800 bg-slate-900/40'}`}
            style={{ color: TIER_COLOR[t] }} title={t}>
            <span className="text-[9px] tracking-wider">{t}</span>
            <span className="text-sm font-mono">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="px-3 py-2 grid grid-cols-3 gap-1 border-b border-slate-800">
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">BREACH</span>
          <span className="text-sm font-mono" style={{ color: counts.BREACH ? TIER_COLOR.BREACH : '#cbd5e1' }}>{counts.BREACH}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">NEXT CURFEW</span>
          <span className="text-sm font-mono text-slate-100">{nextOpenMin == null ? '\u2014' : `${Math.floor(nextOpenMin/60)}h${String(Math.floor(nextOpenMin%60)).padStart(2,'0')}`}</span>
        </div>
        <div className="flex flex-col items-center rounded px-1 py-1 border border-slate-800 bg-slate-900/40">
          <span className="text-[9px] tracking-wider text-slate-500">INBOUND</span>
          <span className="text-sm font-mono text-slate-100">{analysis.inbs.length}</span>
        </div>
      </div>

      {/* 24h sparkline */}
      <div className="px-3 py-2 border-b border-slate-800">
        <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider mb-1">
          <span>24H CURFEW SWEEP (top 12 airports)</span>
          <span>now &rarr; +24h</span>
        </div>
        <svg viewBox={`0 0 ${sparkline.W} ${sparkline.H}`} className="w-full h-10 bg-slate-900/50 rounded">
          {/* hour grid */}
          {Array.from({ length: 25 }).map((_, i) => (
            <line key={i} x1={4 + (i / 24) * (sparkline.W - 8)} x2={4 + (i / 24) * (sparkline.W - 8)} y1={2} y2={sparkline.H - 2} stroke="#1e293b" strokeWidth={i % 6 === 0 ? 0.6 : 0.3} />
          ))}
          {sparkline.bars.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.w} height={1.8} fill={b.color} opacity={0.85} />
          ))}
          {/* now line */}
          <line x1={4} x2={4} y1={1} y2={sparkline.H - 1} stroke="#f59e0b" strokeWidth={1} />
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>INBOUND RANGE</span><span className="font-mono text-slate-300">{inbRng}nm</span>
          </div>
          <input type="range" min={30} max={400} step={10} value={inbRng} onChange={e => setInbRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>SAFETY BUFFER</span><span className="font-mono text-slate-300">{buffer}min</span>
          </div>
          <input type="range" min={0} max={60} step={5} value={buffer} onChange={e => setBuffer(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[10px] text-slate-500 tracking-wider">
            <span>NOW &Delta; (what-if)</span>
            <span className="font-mono text-slate-300">{nowOffsetHrs >= 0 ? '+' : ''}{nowOffsetHrs}h</span>
          </div>
          <input type="range" min={-24} max={24} step={1} value={nowOffsetHrs} onChange={e => setNowOffsetHrs(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showOvl} onChange={e => setShowOvl(e.target.checked)} className="accent-sky-500" /><span>OVL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showRings} onChange={e => setShowRings(e.target.checked)} className="accent-sky-500" /><span>RING</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLinks} onChange={e => setShowLinks(e.target.checked)} className="accent-sky-500" /><span>LINK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / iata"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/40 outline-none" />
        <div className="flex items-center gap-1">
          {(['INBOUNDS', 'AIRPORTS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 text-[10px] tracking-wider px-2 py-1 rounded border ${tab === t ? 'border-sky-500/40 bg-sky-500/15 text-slate-100' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'INBOUNDS' && (
          <>
            {rankedInb.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No inbounds match curfew filter.</div>}
            {rankedInb.map((r, i) => (
              <button key={`${r.f.icao}-${r.ap.iata}-${i}`} onClick={() => onFly(r.f.icao)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold truncate text-slate-100">{r.f.callsign?.trim() || r.f.icao}</span>
                    <span className="text-slate-500 truncate">{r.f.type || '\u2014'}</span>
                    <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border" style={{ color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] + '66' }}>{r.tier}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span className="text-sky-300">{r.ap.iata}</span>
                    <span>{r.distNm.toFixed(0)}nm</span>
                    <span>GS{Math.round(r.closure)}</span>
                    <span>ETA T+{Math.floor(r.etaMin)}m</span>
                    <span className="ml-auto" title="local touchdown time">L{fmtMin(r.localMin)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mt-0.5">
                    <div className="flex-1 h-1.5 bg-slate-900 rounded overflow-hidden relative">
                      {/* shows where touchdown sits relative to curfew open edge */}
                      {(() => {
                        const span = 120 // +/-120min view
                        const pct = Math.max(0, Math.min(1, (r.bufferMin + span) / (2 * span)))
                        return (
                          <>
                            <div className="absolute inset-y-0" style={{ left: '50%', width: 1, background: '#475569' }} />
                            <div className="absolute inset-y-0" style={{ left: `${pct * 100}%`, width: 2, background: TIER_COLOR[r.tier] }} />
                          </>
                        )
                      })()}
                    </div>
                    <span className="font-mono" style={{ color: TIER_COLOR[r.tier] }}>
                      {r.bufferMin >= 0 ? `+${Math.floor(r.bufferMin)}m IN` : `${Math.ceil(r.bufferMin)}m`}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-600 truncate mt-0.5">{r.f.operator || '\u2014'} &middot; {r.ap.name} {fmtMin(r.ap.openMin)}&ndash;{fmtMin(r.ap.closeMin)} ({r.ap.note})</div>
                </div>
              </button>
            ))}
          </>
        )}
        {tab === 'AIRPORTS' && (
          <>
            {rankedAp.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-500">No airports match.</div>}
            {rankedAp.map(x => (
              <button key={x.ap.iata} onClick={() => onFlyLatLng(x.ap.lat, x.ap.lng, 7)}
                className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
                <span className="w-1 self-stretch rounded" style={{ background: x.active ? '#a78bfa' : TIER_COLOR[x.worst] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-sky-300">{x.ap.iata}</span>
                    <span className="text-slate-300 truncate">{x.ap.name}</span>
                    <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border"
                      style={{ color: x.active ? '#a78bfa' : TIER_COLOR[x.worst], borderColor: (x.active ? '#a78bfa' : TIER_COLOR[x.worst]) + '66' }}>
                      {x.active ? 'NIGHT' : x.worst}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                    <span>L{fmtMin(x.localNow)}</span>
                    <span>{fmtMin(x.ap.openMin)}&ndash;{fmtMin(x.ap.closeMin)}</span>
                    <span title={x.active ? 'opens in' : 'closes in'}>
                      {x.active ? `\u2192 open ${Math.floor(x.toEdge/60)}h${String(Math.floor(x.toEdge%60)).padStart(2,'0')}` : `\u2192 night ${Math.floor(x.toEdge/60)}h${String(Math.floor(x.toEdge%60)).padStart(2,'0')}`}
                    </span>
                    <span className="ml-auto">inb {x.nInb}{x.nBreach ? ` / \u26A0 ${x.nBreach}` : ''}</span>
                  </div>
                  <div className="text-[10px] text-slate-600 truncate mt-0.5">tz UTC{x.ap.tz >= 0 ? '+' : ''}{x.ap.tz} &middot; {x.ap.note}</div>
                </div>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-500 tracking-wider flex justify-between">
        <span>BREACH=land in curfew &middot; MARGIN=&le;{buffer}m &middot; CAUTION=&le;{buffer*2}m</span>
        <span>{CURFEWS.length} APTS</span>
      </div>
    </div>
  )
}
