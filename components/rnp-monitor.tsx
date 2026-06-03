'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   RNP / PBN Lateral Performance Monitor
   -----------------------------------------------------------
   ICAO Doc 9613 PBN Manual / FAA AC 90-105 / EASA AMC 20-26
   Required Navigation Performance compliance check.

   For every cruising aircraft above MIN-FL within MAX-FL,
   1) infers the intended LEG by picking the closest aligned
      origin (IATA airport BEHIND the ground track within
      CAPTURE nm) and destination (IATA airport AHEAD of the
      ground track within CAPTURE nm) — both must lie within
      +/- 60 deg of the track-back / track-fwd respectively;
   2) reconstructs the great-circle LEG origin→destination,
      then computes cross-track distance (XTE, nm signed
      L/R-positive) via standard navigation cross-track formula
      d_xt = asin(sin(d13/R)*sin(brg13-brg12)) * R;
   3) selects required RNP band per phase + altitude:
        FL>=290 oceanic-track candidate → RNP 4 (NAT HLA)
        FL>=180 enroute domestic         → RNP 2
        FL<180 terminal arrival          → RNP 1
        approach <=5kft AGL              → RNP 0.3 (LPV/LNAV-VNAV)
      overridable via RNP-FORCE slider 0=AUTO..4 (RNP10/4/2/1/.3);
   4) computes Total System Error TSE ≈ sqrt(NSE^2 + FTE^2)
      with NSE estimated 0.15·RNP (GNSS w/ SBAS typical) and
      FTE inferred from bank-angle proxy + vertRate volatility
      (placeholder constant 0.18·RNP for ADS-B passive);
   5) containment limit = 2 × RNP (ICAO Doc 9613 1·E-7 OBC);
   6) classifies into 4 tiers:
        ON-TRACK |XTE| <= 0.5 RNP                emerald
        WITHIN   |XTE| <= 1.0 RNP                sky
        DEVIATE  |XTE| <= 2.0 RNP (containment)  amber
        BUST     |XTE| >  2.0 RNP                rose
      OUT bucket for aircraft with no inferrable leg.

   MapLibre overlay:
     - Tier-coloured halo ring sized by |XTE|/RNP ratio.
     - Sky dashed planned-leg great circle (sampled 32 pts).
     - Tier-coloured short XTE vector aircraft → planned-line
       perpendicular foot for non-ON-TRACK.
     - Airport pins for active O/D with IATA labels.
     - Callsign + ±XTE-nm + RNP-band labels (tier-coloured).

   Side panel: 4-tier counter + OUT bucket click-to-filter,
   3-cell MEAN-XTE-nm / WORST-callsign±nm / BUST-COUNT,
   2-cell MEAN-TSE-nm / CONTAINMENT-pct secondary row,
   SVG XTE-vs-RNP scatter (x = RNP band log scale, y = XTE
   nm signed, emerald +/-0.5R sky +/-1R amber +/-2R bands
   shaded with matching threshold lines, every aircraft
   plotted as tier-coloured dot), 5 sliders (MIN-FL, MAX-FL,
   CAPTURE-NM, RNP-FORCE 0=AUTO..4, NSE-MULT 50-200pct),
   7-class chip filter, HALO/LEG/VEC/LBL/DIAG toggles,
   search, AIRCRAFT/LEGS tab switcher.

   Registered under Layers > Routes & Flow category.
   ft-rnp persisted preference.
   ============================================================ */

export interface RnpFlight {
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
  flights: RnpFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'ON-TRACK' | 'WITHIN' | 'DEVIATE' | 'BUST'
const TIER_COLOR: Record<Tier, string> = {
  'ON-TRACK': '#10b981',
  WITHIN: '#0ea5e9',
  DEVIATE: '#f59e0b',
  BUST: '#ef4444',
}
const TIER_ORDER: Tier[] = ['BUST', 'DEVIATE', 'WITHIN', 'ON-TRACK']

type RnpBand = 'RNP10' | 'RNP4' | 'RNP2' | 'RNP1' | 'RNP0.3'
const RNP_VALUE: Record<RnpBand, number> = { RNP10: 10, RNP4: 4, RNP2: 2, RNP1: 1, 'RNP0.3': 0.3 }
const RNP_LIST: RnpBand[] = ['RNP10', 'RNP4', 'RNP2', 'RNP1', 'RNP0.3']

type Klass = 'heavy' | 'narrow' | 'regional' | 'biz' | 'turboprop' | 'ga' | 'fighter'
const KLASS_LABEL: Record<Klass, string> = {
  heavy: 'HVY', narrow: 'NRW', regional: 'RGN', biz: 'BIZ', turboprop: 'TBP', ga: 'GA', fighter: 'FTR',
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
const R_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
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
// Cross-track distance in nm; sign +R / -L relative to leg bearing
function crossTrackNm(latP: number, lngP: number, latA: number, lngA: number, latB: number, lngB: number): number {
  const d13 = gcDistNm(latA, lngA, latP, lngP) / R_NM
  const brg13 = gcBearingDeg(latA, lngA, latP, lngP) * D2R
  const brg12 = gcBearingDeg(latA, lngA, latB, lngB) * D2R
  return Math.asin(Math.sin(d13) * Math.sin(brg13 - brg12)) * R_NM
}
// Great circle waypoint at fraction f from A to B
function gcInterp(latA: number, lngA: number, latB: number, lngB: number, f: number): [number, number] {
  const φ1 = latA * D2R, φ2 = latB * D2R, λ1 = lngA * D2R, λ2 = lngB * D2R
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2))
  if (d < 1e-9) return [latA, lngA]
  const a = Math.sin((1-f)*d)/Math.sin(d)
  const b = Math.sin(f*d)/Math.sin(d)
  const x = a*Math.cos(φ1)*Math.cos(λ1) + b*Math.cos(φ2)*Math.cos(λ2)
  const y = a*Math.cos(φ1)*Math.sin(λ1) + b*Math.cos(φ2)*Math.sin(λ2)
  const z = a*Math.sin(φ1) + b*Math.sin(φ2)
  return [Math.atan2(z, Math.sqrt(x*x+y*y))/D2R, Math.atan2(y, x)/D2R]
}

interface Row {
  f: RnpFlight
  klass: Klass
  altFt: number
  gs: number
  oI: string; oIcao: string; oName: string; oLat: number; oLng: number; oNm: number
  dI: string; dIcao: string; dName: string; dLat: number; dLng: number; dNm: number
  rnp: RnpBand
  rnpVal: number
  xte: number          // signed cross-track nm (+R / -L)
  nse: number          // navigation system error nm
  fte: number          // flight technical error nm
  tse: number          // total system error nm
  containmentNm: number
  containedPct: number // = max(0, 1 - |xte|/containment) * 100
  perpLat: number; perpLng: number  // foot of perpendicular on leg
  tier: Tier
}

const SRC_RING = 'rnp-ring', SRC_LEG = 'rnp-leg', SRC_VEC = 'rnp-vec', SRC_AP = 'rnp-ap', SRC_LBL = 'rnp-lbl'
const LYR_RING = 'rnp-ring-l', LYR_LEG = 'rnp-leg-l', LYR_VEC = 'rnp-vec-l', LYR_AP = 'rnp-ap-l', LYR_LBL = 'rnp-lbl-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

function inferRnp(altFt: number): RnpBand {
  if (altFt >= 29000) return 'RNP4'
  if (altFt >= 18000) return 'RNP2'
  if (altFt >= 5000) return 'RNP1'
  return 'RNP0.3'
}

export default function RnpMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'LEGS'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL' | 'OUT'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(50)
  const [maxFl, setMaxFl] = useState(450)
  const [captureNm, setCaptureNm] = useState(600)
  const [rnpForce, setRnpForce] = useState(0)  // 0=AUTO, 1..5 force
  const [nseMult, setNseMult] = useState(100)
  const [showRing, setShowRing] = useState(true)
  const [showLeg, setShowLeg] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    let outCount = 0
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt) || !isFinite(f.lat) || !isFinite(f.lng)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl || flCur > maxFl) continue
      const klass = classify(f.type, f.category)
      const gs = Math.max(60, f.velocityKts || 250)
      const trk = f.track || 0
      const trkBack = (trk + 180) % 360
      // Origin = best-aligned IATA BEHIND aircraft (within +/- 60 deg of trk-back)
      let origin: { i: string, icao: string, name: string, lat: number, lng: number, d: number } | null = null
      let dest: { i: string, icao: string, name: string, lat: number, lng: number, d: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > captureNm || d < 8) continue
        const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
        const dFwd = headingDelta(br, trk)
        const dBack = headingDelta(br, trkBack)
        if (dBack <= 60) {
          if (!origin || d < origin.d) origin = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        }
        if (dFwd <= 60) {
          if (!dest || d < dest.d) dest = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        }
      }
      if (!origin || !dest) { outCount++; continue }
      // Compute XTE relative to leg origin → dest
      const xte = crossTrackNm(f.lat, f.lng, origin.lat, origin.lng, dest.lat, dest.lng)
      const rnp: RnpBand = rnpForce === 0 ? inferRnp(f.altitudeFt) : RNP_LIST[Math.min(4, rnpForce - 1)]
      const rnpVal = RNP_VALUE[rnp]
      // NSE: GNSS+SBAS typical 0.15 R, scaled by user mult
      const nse = 0.15 * rnpVal * (nseMult / 100)
      // FTE: 0.18 R passive proxy
      const fte = 0.18 * rnpVal
      const tse = Math.sqrt(nse * nse + fte * fte)
      const containmentNm = 2 * rnpVal
      const containedPct = Math.max(0, 1 - Math.abs(xte) / containmentNm) * 100
      // Foot of perpendicular: interpolate along leg at the fraction matching along-track distance.
      // along-track dist d_at = acos(cos(d13)/cos(xt))
      const d13 = gcDistNm(origin.lat, origin.lng, f.lat, f.lng)
      const d12 = gcDistNm(origin.lat, origin.lng, dest.lat, dest.lng)
      const cosXt = Math.cos(Math.abs(xte) / R_NM)
      const dAt = d12 > 0 ? Math.acos(Math.min(1, Math.cos(d13 / R_NM) / cosXt)) * R_NM : 0
      const frac = d12 > 0 ? Math.max(0, Math.min(1, dAt / d12)) : 0
      const [perpLat, perpLng] = gcInterp(origin.lat, origin.lng, dest.lat, dest.lng, frac)

      let tier: Tier
      const ratio = Math.abs(xte) / rnpVal
      if (ratio > 2.0) tier = 'BUST'
      else if (ratio > 1.0) tier = 'DEVIATE'
      else if (ratio > 0.5) tier = 'WITHIN'
      else tier = 'ON-TRACK'

      out.push({
        f, klass, altFt: f.altitudeFt, gs,
        oI: origin.i, oIcao: origin.icao, oName: origin.name, oLat: origin.lat, oLng: origin.lng, oNm: origin.d,
        dI: dest.i, dIcao: dest.icao, dName: dest.name, dLat: dest.lat, dLng: dest.lng, dNm: dest.d,
        rnp, rnpVal, xte, nse, fte, tse, containmentNm, containedPct,
        perpLat, perpLng, tier,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return Math.abs(b.xte) - Math.abs(a.xte)
    })
    ;(out as any)._outCount = outCount
    return out
  }, [flights, minFl, maxFl, captureNm, rnpForce, nseMult])

  const outCount: number = (rows as any)._outCount || 0

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { 'ON-TRACK': 0, WITHIN: 0, DEVIATE: 0, BUST: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let meanXte = 0, worstAbs = 0, worstCs = '', worstSigned = 0, bustCount = 0, meanTse = 0, contSum = 0
    for (const r of rows) {
      meanXte += Math.abs(r.xte)
      meanTse += r.tse
      contSum += r.containedPct
      if (Math.abs(r.xte) > worstAbs) { worstAbs = Math.abs(r.xte); worstCs = (r.f.callsign || r.f.icao).trim(); worstSigned = r.xte }
      if (r.tier === 'BUST') bustCount++
    }
    if (total > 0) { meanXte /= total; meanTse /= total; contSum /= total }
    return { total, meanXte, worstAbs, worstCs, worstSigned, bustCount, meanTse, meanCont: contSum }
  }, [rows])

  // Leg rollup by O→D pair
  const legs = useMemo(() => {
    const m = new Map<string, { key: string, o: string, d: string, oLat: number, oLng: number, dLat: number, dLng: number, count: number, worstTier: Tier, meanXte: number, meanRnp: number }>()
    for (const r of rows) {
      const k = `${r.oI}-${r.dI}`
      const e = m.get(k)
      if (e) {
        e.count++
        e.meanXte += Math.abs(r.xte)
        e.meanRnp += r.rnpVal
        if (TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(e.worstTier)) e.worstTier = r.tier
      } else {
        m.set(k, { key: k, o: r.oI, d: r.dI, oLat: r.oLat, oLng: r.oLng, dLat: r.dLat, dLng: r.dLng, count: 1, worstTier: r.tier, meanXte: Math.abs(r.xte), meanRnp: r.rnpVal })
      }
    }
    const arr = Array.from(m.values())
    for (const e of arr) { e.meanXte /= e.count; e.meanRnp /= e.count }
    arr.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.worstTier) - TIER_ORDER.indexOf(b.worstTier)
      if (ti !== 0) return ti
      return b.count - a.count
    })
    return arr
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && tierFilter !== 'OUT' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.oI, r.dI, r.oIcao, r.dIcao, r.rnp].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  const filteredLegs = useMemo(() => {
    const q = query.trim().toUpperCase()
    return legs.filter(l => {
      if (tierFilter !== 'ALL' && tierFilter !== 'OUT' && l.worstTier !== tierFilter) return false
      if (!q) return true
      return [l.o, l.d, l.key].some(s => s.toUpperCase().includes(q))
    })
  }, [legs, tierFilter, query])

  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(15, (Math.abs(r.xte) / Math.max(0.3, r.rnpVal)) * 6) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    // Build sampled great-circle leg per unique leg (dedupe)
    const legFeatures: any[] = []
    if (showLeg) {
      const seen = new Set<string>()
      for (const r of rows) {
        const k = `${r.oI}-${r.dI}`
        if (seen.has(k)) continue
        seen.add(k)
        const pts: number[][] = []
        for (let i = 0; i <= 32; i++) {
          const [lat, lng] = gcInterp(r.oLat, r.oLng, r.dLat, r.dLng, i / 32)
          pts.push([lng, lat])
        }
        legFeatures.push({ type: 'Feature', properties: { color: '#0ea5e9' }, geometry: { type: 'LineString', coordinates: pts } })
      }
    }
    const legFc = { type: 'FeatureCollection' as const, features: legFeatures }
    // Perpendicular XTE vector for non ON-TRACK
    const vecFc = { type: 'FeatureCollection' as const, features: showVec ? rows.filter(r => r.tier !== 'ON-TRACK').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.perpLng, r.perpLat]] },
    })) : [] }
    // Origin + destination pins (unique)
    const apMap = new Map<string, { lng: number, lat: number, text: string, tier: Tier }>()
    for (const r of rows) {
      const ok = `o-${r.oI}`, dk = `d-${r.dI}`
      const ot = apMap.get(ok); if (!ot || TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(ot.tier)) apMap.set(ok, { lng: r.oLng, lat: r.oLat, text: `›${r.oI}`, tier: r.tier })
      const dt = apMap.get(dk); if (!dt || TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(dt.tier)) apMap.set(dk, { lng: r.dLng, lat: r.dLat, text: `${r.dI}‹`, tier: r.tier })
    }
    const apFc = { type: 'FeatureCollection' as const, features: Array.from(apMap.values()).map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.tier], text: a.text },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.filter(r => r.tier !== 'ON-TRACK').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${r.xte >= 0 ? '+' : ''}${r.xte.toFixed(1)}nm ${r.rnp}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_LEG, legFc, () => map.addLayer({ id: LYR_LEG, type: 'line', source: SRC_LEG, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [4, 3],
      } }))
      ensure(SRC_VEC, vecFc, () => map.addLayer({ id: LYR_VEC, type: 'line', source: SRC_VEC, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.85,
      } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_AP, apFc, () => map.addLayer({ id: LYR_AP, type: 'symbol', source: SRC_AP, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, -1.3], 'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_AP, LYR_RING, LYR_VEC, LYR_LEG]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_AP, SRC_RING, SRC_VEC, SRC_LEG]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showLeg, showVec, showLabels])

  // Diagram: x = RNP band index 0..4 (RNP10..RNP0.3), y = signed XTE / R ratio -3..+3
  const diag = useMemo(() => {
    const W = 360, H = 170, PAD_L = 30, PAD_B = 22
    const xs = (i: number) => PAD_L + (i / 4) * (W - PAD_L - 8)
    const ys = (ratio: number) => 6 + (1 - (ratio + 3) / 6) * (H - PAD_B - 8)
    return { W, H, PAD_L, PAD_B, xs, ys }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">RNP / PBN Lateral</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} legs · {outCount} OUT</span>
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
        <button onClick={() => setTierFilter(tierFilter === 'OUT' ? 'ALL' : 'OUT')}
          className={`flex flex-col items-center py-1 rounded border transition ${tierFilter === 'OUT' ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
          <span className="text-[9px] font-bold text-slate-500">OUT</span>
          <span className="font-mono text-xs text-slate-400">{outCount}</span>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean |XTE|</div>
          <div className="font-mono text-sm" style={{ color: summary.meanXte > 2 ? '#f59e0b' : summary.meanXte > 1 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanXte.toFixed(2)}<span className="text-[9px] text-slate-500"> nm</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs ? `${summary.worstCs} ${summary.worstSigned >= 0 ? '+' : ''}${summary.worstSigned.toFixed(1)}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Bust</div>
          <div className="font-mono text-sm" style={{ color: summary.bustCount > 0 ? '#ef4444' : '#10b981' }}>{summary.bustCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800 text-center">
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean TSE</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanTse > 1 ? '#f59e0b' : '#10b981' }}>{summary.meanTse.toFixed(2)}<span className="text-[9px] text-slate-500"> nm</span></div>
        </div>
        <div className="bg-slate-900/40 rounded py-1">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Contained</div>
          <div className="font-mono text-[11px]" style={{ color: summary.meanCont < 50 ? '#f59e0b' : '#10b981' }}>{summary.meanCont.toFixed(0)}<span className="text-[9px] text-slate-500"> %</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">XTE / RNP ratio · containment 2×RNP</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD_L} y1={diag.H - diag.PAD_B} x2={diag.W - 6} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD_L} y1={6} x2={diag.PAD_L} y2={diag.H - diag.PAD_B} stroke="#334155" strokeWidth={1} />
            {/* y bands */}
            {[
              { hi: 0.5, lo: -0.5, c: '#10b981', op: 0.10, label: '±0.5R' },
              { hi: 1.0, lo: -1.0, c: '#0ea5e9', op: 0.08, label: '±1R' },
              { hi: 2.0, lo: -2.0, c: '#f59e0b', op: 0.06, label: '±2R cont' },
            ].map(b => (
              <rect key={b.label} x={diag.PAD_L} y={diag.ys(b.hi)} width={diag.W - diag.PAD_L - 6} height={diag.ys(b.lo) - diag.ys(b.hi)} fill={b.c} opacity={b.op} />
            ))}
            {/* threshold lines */}
            {[0.5, -0.5, 1.0, -1.0, 2.0, -2.0].map(y => {
              const c = Math.abs(y) === 0.5 ? '#10b981' : Math.abs(y) === 1.0 ? '#0ea5e9' : '#f59e0b'
              return <line key={y} x1={diag.PAD_L} y1={diag.ys(y)} x2={diag.W - 6} y2={diag.ys(y)} stroke={c} strokeDasharray="2 3" opacity={0.6} />
            })}
            <line x1={diag.PAD_L} y1={diag.ys(0)} x2={diag.W - 6} y2={diag.ys(0)} stroke="#475569" strokeWidth={1} />
            {/* y labels */}
            {[3,2,1,0,-1,-2,-3].map(y => (
              <text key={y} x={diag.PAD_L - 2} y={diag.ys(y) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{y > 0 ? '+' : ''}{y}R</text>
            ))}
            {/* x labels: RNP bands */}
            {RNP_LIST.map((b, i) => (
              <g key={b}>
                <line x1={diag.xs(i)} y1={6} x2={diag.xs(i)} y2={diag.H - diag.PAD_B} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(i)} y={diag.H - diag.PAD_B + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{b}</text>
              </g>
            ))}
            {/* aircraft dots */}
            {rows.map(r => {
              const i = RNP_LIST.indexOf(r.rnp)
              const ratio = Math.max(-3, Math.min(3, r.xte / r.rnpVal))
              return <circle key={r.f.icao} cx={diag.xs(i)} cy={diag.ys(ratio)} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            })}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-FL</span><span className="font-mono text-slate-300">{maxFl}</span></div>
            <input type="range" min={50} max={500} step={10} value={maxFl} onChange={e => setMaxFl(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>CAPTURE</span><span className="font-mono text-slate-300">{captureNm}nm</span></div>
            <input type="range" min={100} max={2000} step={50} value={captureNm} onChange={e => setCaptureNm(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>NSE-MULT</span><span className="font-mono text-slate-300">{nseMult}%</span></div>
            <input type="range" min={50} max={200} step={10} value={nseMult} onChange={e => setNseMult(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div className="col-span-2">
            <div className="flex justify-between text-[10px] text-slate-500"><span>RNP-FORCE</span><span className="font-mono text-slate-300">{rnpForce === 0 ? 'AUTO' : RNP_LIST[rnpForce - 1]}</span></div>
            <input type="range" min={0} max={5} step={1} value={rnpForce} onChange={e => setRnpForce(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLeg} onChange={e => setShowLeg(e.target.checked)} className="accent-sky-500" /><span>LEG</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showVec} onChange={e => setShowVec(e.target.checked)} className="accent-sky-500" /><span>VEC</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA / RNP"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['AIRCRAFT', 'LEGS'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{tab === 'AIRCRAFT' ? `${filteredAircraft.length} shown / ${rows.length} legs` : `${filteredLegs.length} pairs`}</span>
        <span>{tab === 'AIRCRAFT' ? 'XTE · RNP · TSE · containment' : 'count · worst · mean'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && filteredAircraft.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {tab === 'AIRCRAFT' && filteredAircraft.map(r => {
          // XTE bar: -3R..+3R mapped 0..100 (clamp)
          const ratio = Math.max(-3, Math.min(3, r.xte / r.rnpVal))
          const pct = ((ratio + 3) / 6) * 100
          const center = 50
          const advice = r.tier === 'ON-TRACK' ? 'on planned track · LNAV holding' :
            r.tier === 'WITHIN' ? 'within RNP · minor drift · monitor FMS' :
            r.tier === 'DEVIATE' ? 'exceeds 1×RNP · cross-check FMS source · verify VOR/DME' :
            'containment loss · UNABLE RNP · advise ATC per ICAO Doc 9613'
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
                  <span title="origin">›{r.oI}</span>
                  <span title="destination">{r.dI}‹</span>
                  <span title="rnp band">{r.rnp}</span>
                  <span className="ml-auto" title="signed XTE" style={{ color: TIER_COLOR[r.tier] }}>{r.xte >= 0 ? '+' : ''}{r.xte.toFixed(2)}nm</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="XTE / RNP ratio (-3R..+3R)">
                  <div className="absolute inset-y-0" style={{ left: `${Math.min(center, pct)}%`, width: `${Math.abs(pct - center)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-slate-500" style={{ left: `${center}%` }} />
                  {/* threshold ticks at ratio +/- 0.5 / 1 / 2 */}
                  {[-2, -1, -0.5, 0.5, 1, 2].map(r2 => {
                    const x = ((r2 + 3) / 6) * 100
                    const c = Math.abs(r2) === 0.5 ? '#10b981' : Math.abs(r2) === 1 ? '#0ea5e9' : '#f59e0b'
                    return <div key={r2} className="absolute inset-y-0 w-0.5" style={{ left: `${x}%`, background: c }} />
                  })}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="NSE GNSS+SBAS estimate">NSE{r.nse.toFixed(2)}</span>
                  <span title="FTE proxy">FTE{r.fte.toFixed(2)}</span>
                  <span title="Total system error">TSE{r.tse.toFixed(2)}</span>
                  <span title="containment 2×RNP">CTN±{r.containmentNm.toFixed(1)}</span>
                  <span className="ml-auto" title="contained %" style={{ color: r.containedPct < 50 ? '#f59e0b' : '#64748b' }}>{r.containedPct.toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="origin dist">›{r.oNm.toFixed(0)}nm</span>
                  <span title="dest dist">{r.dNm.toFixed(0)}nm‹</span>
                  <span title="GS">{r.gs.toFixed(0)}kt</span>
                  <span className="ml-auto truncate" title="operator">{r.f.operator || '\u2014'}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" title="advice" style={{ color: r.tier === 'ON-TRACK' ? '#64748b' : TIER_COLOR[r.tier] }}>{advice}</div>
                <div className="text-[10px] text-slate-600 font-mono mt-0.5 truncate" title="leg">{r.oIcao} → {r.dIcao} · {r.oName} → {r.dName}</div>
              </div>
            </button>
          )
        })}
        {tab === 'LEGS' && filteredLegs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No legs match.</div>
        )}
        {tab === 'LEGS' && filteredLegs.map(l => {
          const xtePct = Math.min(100, (l.meanXte / Math.max(0.3, l.meanRnp * 2)) * 100)
          return (
            <button key={l.key} onClick={() => { try { map?.flyTo({ center: [(l.oLng + l.dLng) / 2, (l.oLat + l.dLat) / 2], zoom: 5 }) } catch {} }}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[l.worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{l.o} → {l.d}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{l.count} ac</span>
                  <span className="text-[10px] font-semibold" style={{ color: TIER_COLOR[l.worstTier] }}>{l.worstTier}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="mean |XTE| vs 2×RNP">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${xtePct}%`, background: TIER_COLOR[l.worstTier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="mean |XTE|">|XTE|{l.meanXte.toFixed(2)}nm</span>
                  <span title="mean RNP">μRNP{l.meanRnp.toFixed(1)}</span>
                  <span className="ml-auto" title="ratio">{(l.meanXte / Math.max(0.3, l.meanRnp)).toFixed(2)}R</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
