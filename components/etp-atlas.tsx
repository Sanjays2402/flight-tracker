'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   Equal-Time Point (ETP) / Critical Point Atlas
   -----------------------------------------------------------
   The ETP (also called Critical Point / CP in oceanic ops) is
   the position along a flight leg where time-to-go to the
   nearest suitable airport ahead equals time-to-go to the
   nearest suitable airport behind, accounting for wind. It is
   the textbook "point of no return" used by long-haul and
   oceanic dispatchers (NAT-OPS Doc 007 §1.6 / FAA AC 120-42B
   ETOPS appendix) to decide whether to return to origin or
   continue to destination after an in-flight event (depress,
   medical, single-engine, fuel exhaustion of an alternate).

   This is conceptually distinct from:
     - ETOPS: which asks "am I within N min of any diversion?"
     - Reserve Fuel: which asks "do I have legal reserves?"
     - Drift-Down: which asks "what altitude can I hold OEI?"
   ETP/CP answers: "which way is faster from here, forward or
   back, and where is the crossover?"

   For every airborne aircraft above MIN-FL slider:

   1) Scan AIRPORTS catalogue (IATA large) for two anchors:
        FWD = nearest airport within MAX-RNG nm whose bearing
              from aircraft is within +/- 70 deg of track
              (i.e. ahead and roughly on-route)
        BCK = nearest airport within MAX-RNG nm whose bearing
              is within +/- 70 deg of RECIPROCAL track
              (i.e. behind aircraft, either lateral)
   2) Total dist between FWD and BCK measured great-circle.
   3) Wind component: WIND-COMP slider -100..+100 kt expresses
      forward-leg headwind (positive = headwind toward FWD,
      negative = tailwind). TAS proxy = current GS magnitude.
        Vfwd  = max(80, TAS - windComp)
        Vback = max(80, TAS + windComp)
   4) ETP distance from BCK toward FWD along leg:
        dEtpFromBck = dTotal * Vback / (Vfwd + Vback)
      Time at ETP to either end (must match by definition):
        tEtp = dEtpFromBck / Vback   [hours]
   5) Project current position onto the FWD->BCK leg as a
      scalar fraction f in [0..1] (0=BCK, 1=FWD) using
      great-circle bearings (cosine similarity of bearings).
      Then signed-distance-from-current-to-ETP along leg
      (positive = ETP ahead of aircraft, negative = passed).
   6) Time aircraft -> FWD = dFwd / Vfwd   [min]
      Time aircraft -> BCK = dBck / Vback  [min]
      delta = tFwd - tBck (negative = forward faster).

   Tier classification:
     ISOLATED   no FWD or no BCK in range -> rose (lone leg)
     BALANCED   |delta| <= BAL-WIN slider min -> amber
                (at decision point: weather/medical/fuel here
                forces the call; either way comparable)
     RETURN     tBck < tFwd by > BAL-WIN -> sky
                (return is faster: divert back if doubt)
     COMMITTED  tFwd < tBck by > BAL-WIN -> emerald
                (past the ETP: continuing is faster, normal)

   MapLibre overlay:
     - Tier-coloured halo ring sized by 1 - |delta|/30min
       inverted so BALANCED has the biggest halo (ops focus)
     - Dashed sky line aircraft -> BCK airport
     - Dashed emerald line aircraft -> FWD airport
     - Diamond at the ETP position along the FWD-BCK leg
       (interpolated great-circle waypoint at fraction
       dEtpFromBck/dTotal from BCK), tier-coloured, with
       inner star ring for BALANCED tier
     - Tier-coloured callsign + delta-min + FWD/BCK IATA label

   Side panel:
     - 4-tier counter strip click-to-filter
     - 3-cell MEAN-|delta|-min / WORST-BALANCED-callsign /
       ISOLATED-COUNT summary
     - 2-cell MEAN-Vfwd / MEAN-Vback secondary
     - SVG diagram: x = tBck min 0..360, y = tFwd min 0..360,
       diagonal y=x is the ETP line, BAL-WIN band shaded
       amber on either side of diagonal, every aircraft as
       tier-coloured dot at (tBck, tFwd); points below
       diagonal = COMMITTED forward, above = RETURN faster
     - 4 sliders MIN-FL 0..400, MAX-RNG 200..2500nm,
       WIND-COMP -100..+100kt, BAL-WIN 5..25min
     - 7-class chip filter
     - HALO/LINES/ETP/LBL toggles
     - search by callsign/type/operator/icao/IATA
     - ranked list sorted tier-worst-first then |delta| asc
       with tier color stripe + class-pill + tier-pill +
       FL + tFwd + tBck + delta-min + dEtpFromCur-nm line +
       centered tier-coloured delta bar -60..+60min with
       amber ±BAL-WIN ticks + FWD/BCK IATA + dFwd/dBck nm +
       Vfwd/Vback kt + operator + tier-coloured advice
       (lone leg declare emergency / decision point divert
       per ATC / return faster turn back / committed forward
       continue) footer click-to-fly per row

   Registered in Layers > Routes & Flow category.
   ft-etp persisted preference.
   ============================================================ */

export interface EtpFlight {
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
  flights: EtpFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'COMMITTED' | 'RETURN' | 'BALANCED' | 'ISOLATED'
const TIER_COLOR: Record<Tier, string> = {
  COMMITTED: '#10b981',
  RETURN: '#0ea5e9',
  BALANCED: '#f59e0b',
  ISOLATED: '#ef4444',
}
const TIER_ORDER: Tier[] = ['ISOLATED', 'BALANCED', 'RETURN', 'COMMITTED']

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

const D2R = Math.PI / 180, R2D = 180 / Math.PI, ER_NM = 3440.065
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R
  const dφ = (la2 - la1) * D2R, dλ = (lo2 - lo1) * D2R
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * ER_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, dλ = (lo2 - lo1) * D2R
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) * R2D) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}
// Great-circle waypoint at fractional distance f (0..1) along leg from (lat1,lon1) to (lat2,lon2).
function gcWaypoint(la1: number, lo1: number, la2: number, lo2: number, f: number): [number, number] {
  const φ1 = la1 * D2R, λ1 = lo1 * D2R, φ2 = la2 * D2R, λ2 = lo2 * D2R
  const d = gcDistNm(la1, lo1, la2, lo2) / ER_NM
  if (d < 1e-9) return [lo1, la1]
  const A = Math.sin((1 - f) * d) / Math.sin(d)
  const B = Math.sin(f * d) / Math.sin(d)
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
  const z = A * Math.sin(φ1) + B * Math.sin(φ2)
  const φ = Math.atan2(z, Math.sqrt(x * x + y * y))
  const λ = Math.atan2(y, x)
  return [λ * R2D, φ * R2D]
}

interface Row {
  f: EtpFlight
  klass: Klass
  altFt: number
  gs: number
  trk: number
  // forward
  fwdI: string; fwdIcao: string; fwdName: string; fwdLat: number; fwdLng: number
  dFwd: number; tFwd: number; vFwd: number
  // back
  bckI: string; bckIcao: string; bckName: string; bckLat: number; bckLng: number
  dBck: number; tBck: number; vBck: number
  // ETP
  dTotal: number; etpFromBck: number; etpLat: number; etpLng: number
  dEtpFromCur: number      // signed nm along great-circle leg (positive = ETP ahead)
  delta: number             // tFwd - tBck (minutes)
  tier: Tier
  // ISOLATED rows have one or both anchors missing — those are still emitted with placeholders.
  isolated: boolean
}

const SRC_RING = 'etp-ring', SRC_FWD = 'etp-fwd', SRC_BCK = 'etp-bck', SRC_ETP = 'etp-pt', SRC_LBL = 'etp-lbl', SRC_STAR = 'etp-star'
const LYR_RING = 'etp-ring-l', LYR_FWD = 'etp-fwd-l', LYR_BCK = 'etp-bck-l', LYR_ETP = 'etp-pt-l', LYR_LBL = 'etp-lbl-l', LYR_STAR = 'etp-star-l'

const ALL_AP = AIRPORTS.filter(a => a.a && a.a.length === 3)

export default function EtpAtlas({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [minFl, setMinFl] = useState(150)
  const [maxRng, setMaxRng] = useState(1200)
  const [windComp, setWindComp] = useState(0)
  const [balWin, setBalWin] = useState(10)
  const [showRing, setShowRing] = useState(true)
  const [showLines, setShowLines] = useState(true)
  const [showEtp, setShowEtp] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (f.ground) continue
      if (!isFinite(f.altitudeFt)) continue
      const flCur = f.altitudeFt / 100
      if (flCur < minFl) continue
      const klass = classify(f.type, f.category)
      const gs = Math.max(80, f.velocityKts || 400)
      const trk = f.track || 0
      const recip = (trk + 180) % 360
      // Scan airports
      let fwd: { i: string, icao: string, name: string, lat: number, lng: number, d: number } | null = null
      let bck: { i: string, icao: string, name: string, lat: number, lng: number, d: number } | null = null
      for (const ap of ALL_AP) {
        const d = gcDistNm(f.lat, f.lng, ap.lat, ap.lon)
        if (d > maxRng) continue
        if (d < 6) continue
        const br = gcBearingDeg(f.lat, f.lng, ap.lat, ap.lon)
        if (headingDelta(br, trk) <= 70) {
          if (!fwd || d < fwd.d) fwd = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        } else if (headingDelta(br, recip) <= 70) {
          if (!bck || d < bck.d) bck = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, d }
        }
      }
      const vFwd = Math.max(80, gs - windComp)
      const vBck = Math.max(80, gs + windComp)
      const isolated = !fwd || !bck
      if (isolated) {
        // Emit ISOLATED row with whichever anchor we have so the operator sees the gap.
        const dFwd = fwd ? fwd.d : NaN
        const dBck = bck ? bck.d : NaN
        const tFwd = isFinite(dFwd) ? (dFwd / vFwd) * 60 : NaN
        const tBck = isFinite(dBck) ? (dBck / vBck) * 60 : NaN
        out.push({
          f, klass, altFt: f.altitudeFt, gs, trk,
          fwdI: fwd ? fwd.i : '—', fwdIcao: fwd ? fwd.icao : '', fwdName: fwd ? fwd.name : '',
          fwdLat: fwd ? fwd.lat : f.lat, fwdLng: fwd ? fwd.lng : f.lng,
          dFwd: isFinite(dFwd) ? dFwd : 0, tFwd: isFinite(tFwd) ? tFwd : 999, vFwd,
          bckI: bck ? bck.i : '—', bckIcao: bck ? bck.icao : '', bckName: bck ? bck.name : '',
          bckLat: bck ? bck.lat : f.lat, bckLng: bck ? bck.lng : f.lng,
          dBck: isFinite(dBck) ? dBck : 0, tBck: isFinite(tBck) ? tBck : 999, vBck,
          dTotal: 0, etpFromBck: 0, etpLat: f.lat, etpLng: f.lng,
          dEtpFromCur: 0, delta: 0, tier: 'ISOLATED', isolated: true,
        })
        continue
      }
      const F = fwd!, B = bck!
      const dTotal = gcDistNm(B.lat, B.lng, F.lat, F.lng)
      const etpFromBck = dTotal * vBck / (vFwd + vBck)
      const [etpLng, etpLat] = gcWaypoint(B.lat, B.lng, F.lat, F.lng, dTotal > 0 ? etpFromBck / dTotal : 0.5)
      const tFwdMin = (F.d / vFwd) * 60
      const tBckMin = (B.d / vBck) * 60
      const delta = tFwdMin - tBckMin
      // Signed dEtpFromCur along ground track: positive = ETP ahead.
      // Approx as great-circle distance signed by bearing similarity to track.
      const dToEtp = gcDistNm(f.lat, f.lng, etpLat, etpLng)
      const brEtp = gcBearingDeg(f.lat, f.lng, etpLat, etpLng)
      const dEtpSigned = headingDelta(brEtp, trk) <= 90 ? dToEtp : -dToEtp
      let tier: Tier
      if (Math.abs(delta) <= balWin) tier = 'BALANCED'
      else if (delta < 0) tier = 'COMMITTED'
      else tier = 'RETURN'
      out.push({
        f, klass, altFt: f.altitudeFt, gs, trk,
        fwdI: F.i, fwdIcao: F.icao, fwdName: F.name, fwdLat: F.lat, fwdLng: F.lng,
        dFwd: F.d, tFwd: tFwdMin, vFwd,
        bckI: B.i, bckIcao: B.icao, bckName: B.name, bckLat: B.lat, bckLng: B.lng,
        dBck: B.d, tBck: tBckMin, vBck,
        dTotal, etpFromBck, etpLat, etpLng,
        dEtpFromCur: dEtpSigned, delta, tier, isolated: false,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
      if (ti !== 0) return ti
      return Math.abs(a.delta) - Math.abs(b.delta)
    })
    return out
  }, [flights, minFl, maxRng, windComp, balWin])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { COMMITTED: 0, RETURN: 0, BALANCED: 0, ISOLATED: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    const total = rows.length
    let sumAbs = 0, sumVf = 0, sumVb = 0, n = 0
    let worstBal = Infinity, worstBalCs = ''
    let isoCount = 0
    for (const r of rows) {
      if (r.tier === 'ISOLATED') { isoCount++; continue }
      sumAbs += Math.abs(r.delta); sumVf += r.vFwd; sumVb += r.vBck; n++
      if (r.tier === 'BALANCED' && Math.abs(r.delta) < worstBal) {
        worstBal = Math.abs(r.delta); worstBalCs = (r.f.callsign || r.f.icao).trim()
      }
    }
    const meanAbs = n > 0 ? sumAbs / n : 0
    const meanVf = n > 0 ? sumVf / n : 0
    const meanVb = n > 0 ? sumVb / n : 0
    if (!isFinite(worstBal)) worstBal = 0
    return { total, meanAbs, meanVf, meanVb, worstBal, worstBalCs, isoCount }
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (klassFilter !== 'ALL' && r.klass !== klassFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.fwdI, r.bckI, r.fwdIcao, r.bckIcao].some(s => (s || '').toUpperCase().includes(q))
    })
  }, [rows, tierFilter, klassFilter, query])

  useEffect(() => {
    if (!map) return
    // Ring radius: BALANCED biggest, others scaled by inverse closeness to ETP.
    const haloR = (r: Row) => {
      if (r.tier === 'ISOLATED') return 18
      if (r.tier === 'BALANCED') return 20
      const k = Math.min(1, Math.abs(r.delta) / 60) // 0 close, 1 far
      return 8 + (1 - k) * 10
    }
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: haloR(r) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const fwdFc = { type: 'FeatureCollection' as const, features: showLines ? rows.filter(r => !r.isolated || r.fwdIcao).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR.COMMITTED },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.fwdLng, r.fwdLat]] },
    })) : [] }
    const bckFc = { type: 'FeatureCollection' as const, features: showLines ? rows.filter(r => !r.isolated || r.bckIcao).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR.RETURN },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.bckLng, r.bckLat]] },
    })) : [] }
    const etpFc = { type: 'FeatureCollection' as const, features: showEtp ? rows.filter(r => !r.isolated).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.etpLng, r.etpLat] },
    })) : [] }
    const starFc = { type: 'FeatureCollection' as const, features: showEtp ? rows.filter(r => r.tier === 'BALANCED').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR.BALANCED },
      geometry: { type: 'Point' as const, coordinates: [r.etpLng, r.etpLat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabels ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: r.isolated
          ? `${(r.f.callsign || r.f.icao).trim()} ISO`
          : `${(r.f.callsign || r.f.icao).trim()} ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(0)}m ${r.bckI}›${r.fwdI}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
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
      ensure(SRC_FWD, fwdFc, () => map.addLayer({ id: LYR_FWD, type: 'line', source: SRC_FWD, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      } }))
      ensure(SRC_BCK, bckFc, () => map.addLayer({ id: LYR_BCK, type: 'line', source: SRC_BCK, paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.4,
        'line-opacity': 0.7,
        'line-dasharray': [2, 3],
      } }))
      ensure(SRC_ETP, etpFc, () => map.addLayer({ id: LYR_ETP, type: 'circle', source: SRC_ETP, paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 1.4,
      } }))
      ensure(SRC_STAR, starFc, () => map.addLayer({ id: LYR_STAR, type: 'circle', source: SRC_STAR, paint: {
        'circle-radius': 11,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.85,
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
      for (const lyr of [LYR_LBL, LYR_STAR, LYR_ETP, LYR_BCK, LYR_FWD, LYR_RING]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_STAR, SRC_ETP, SRC_BCK, SRC_FWD, SRC_RING]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showLines, showEtp, showLabels])

  // Diagram: x = tBck min, y = tFwd min, diagonal = ETP locus.
  const diag = useMemo(() => {
    const W = 360, H = 200, PAD = 28
    const maxT = 360
    const xs = (m: number) => PAD + Math.max(0, Math.min(1, m / maxT)) * (W - PAD - 8)
    const ys = (m: number) => 6 + (1 - Math.max(0, Math.min(1, m / maxT))) * (H - PAD - 8)
    return { W, H, PAD, xs, ys, maxT }
  }, [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,400px)] max-h-[78vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">ETP / Critical Point</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} tracked</span>
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
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean |Δ|</div>
          <div className="font-mono text-sm" style={{ color: summary.meanAbs <= balWin ? '#f59e0b' : summary.meanAbs <= 30 ? '#0ea5e9' : '#10b981' }}>
            {summary.meanAbs.toFixed(1)}<span className="text-[9px] text-slate-500"> min</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Bal</div>
          <div className="font-mono text-[11px] text-slate-200 truncate" title={summary.worstBalCs}>
            {summary.worstBalCs ? `${summary.worstBalCs} ${summary.worstBal.toFixed(0)}m` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Isolated</div>
          <div className="font-mono text-sm" style={{ color: summary.isoCount > 0 ? '#ef4444' : '#10b981' }}>{summary.isoCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Vfwd</div>
          <div className="font-mono text-xs text-emerald-300">{summary.meanVf.toFixed(0)}<span className="text-[9px] text-slate-500"> kt</span></div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Mean Vback</div>
          <div className="font-mono text-xs text-sky-300">{summary.meanVb.toFixed(0)}<span className="text-[9px] text-slate-500"> kt</span></div>
        </div>
      </div>

      {showDiag && (
        <div className="px-3 py-2 border-b border-slate-800">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">tFwd · min vs tBck · min · y=x is ETP</div>
          <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
            <line x1={diag.PAD} y1={diag.H - diag.PAD} x2={diag.W - 6} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - diag.PAD} stroke="#334155" strokeWidth={1} />
            {/* BALANCED band: |tFwd - tBck| <= balWin shaded amber */}
            <polygon
              points={[
                [diag.xs(0), diag.ys(balWin)],
                [diag.xs(diag.maxT - balWin), diag.ys(diag.maxT)],
                [diag.xs(diag.maxT), diag.ys(diag.maxT)],
                [diag.xs(diag.maxT), diag.ys(diag.maxT - balWin)],
                [diag.xs(balWin), diag.ys(0)],
                [diag.xs(0), diag.ys(0)],
              ].map(p => p.join(',')).join(' ')}
              fill="#f59e0b" opacity={0.08}
            />
            {/* ETP diagonal y=x */}
            <line x1={diag.xs(0)} y1={diag.ys(0)} x2={diag.xs(diag.maxT)} y2={diag.ys(diag.maxT)} stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="4 3" opacity={0.8} />
            <text x={diag.xs(diag.maxT) - 4} y={diag.ys(diag.maxT) + 10} textAnchor="end" fontSize={8} fill="#f59e0b" fontFamily="monospace">ETP (y=x)</text>
            {/* gridlines */}
            {[60, 120, 180, 240, 300].map(m => (
              <g key={m}>
                <line x1={diag.xs(m)} y1={6} x2={diag.xs(m)} y2={diag.H - diag.PAD} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.xs(m)} y={diag.H - diag.PAD + 9} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{m}</text>
                <line x1={diag.PAD} y1={diag.ys(m)} x2={diag.W - 6} y2={diag.ys(m)} stroke="#1e293b" strokeDasharray="2 3" />
                <text x={diag.PAD - 2} y={diag.ys(m) + 3} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">{m}</text>
              </g>
            ))}
            {/* axis labels */}
            <text x={diag.W - 6} y={diag.H - 2} textAnchor="end" fontSize={8} fill="#64748b" fontFamily="monospace">tBck min ›</text>
            <text x={diag.PAD + 2} y={10} textAnchor="start" fontSize={8} fill="#64748b" fontFamily="monospace">› tFwd min</text>
            {/* zone hints */}
            <text x={diag.xs(290)} y={diag.ys(80)} textAnchor="middle" fontSize={8} fill="#10b981" fontFamily="monospace" opacity={0.8}>COMMITTED</text>
            <text x={diag.xs(80)} y={diag.ys(290)} textAnchor="middle" fontSize={8} fill="#0ea5e9" fontFamily="monospace" opacity={0.8}>RETURN</text>
            {/* aircraft dots */}
            {rows.filter(r => !r.isolated).map(r => (
              <circle key={r.f.icao} cx={diag.xs(Math.min(diag.maxT, r.tBck))} cy={diag.ys(Math.min(diag.maxT, r.tFwd))} r={2.6} fill={TIER_COLOR[r.tier]} opacity={0.95} />
            ))}
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
            <div className="flex justify-between text-[10px] text-slate-500"><span>MAX-RNG</span><span className="font-mono text-slate-300">{maxRng}nm</span></div>
            <input type="range" min={200} max={2500} step={50} value={maxRng} onChange={e => setMaxRng(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>WIND-COMP</span><span className="font-mono text-slate-300">{windComp >= 0 ? '+' : ''}{windComp}kt</span></div>
            <input type="range" min={-100} max={100} step={5} value={windComp} onChange={e => setWindComp(parseInt(e.target.value))} className="w-full accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-slate-500"><span>BAL-WIN</span><span className="font-mono text-slate-300">±{balWin}m</span></div>
            <input type="range" min={5} max={25} step={1} value={balWin} onChange={e => setBalWin(parseInt(e.target.value))} className="w-full accent-sky-500" />
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
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLines} onChange={e => setShowLines(e.target.checked)} className="accent-sky-500" /><span>LINES</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showEtp} onChange={e => setShowEtp(e.target.checked)} className="accent-sky-500" /><span>ETP</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showDiag} onChange={e => setShowDiag(e.target.checked)} className="accent-sky-500" /><span>DIAG</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator / icao / IATA"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>{filtered.length} shown / {rows.length} tracked</span>
        <span>tFwd · tBck · Δ · ETP-nm</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No aircraft match.</div>
        )}
        {filtered.map(r => {
          // delta bar: -60..+60 -> 0..100%
          const dPct = Math.max(0, Math.min(100, ((r.delta + 60) / 120) * 100))
          const tickMid = 50
          const tickL = ((-balWin + 60) / 120) * 100
          const tickR = ((balWin + 60) / 120) * 100
          const advice =
            r.tier === 'ISOLATED' ? 'lone leg · no realistic divert · declare emergency'
            : r.tier === 'BALANCED' ? 'at decision point · divert per ATC weather/wx'
            : r.tier === 'RETURN' ? 'return faster · turn back if doubt'
            : 'past ETP · continue forward (normal)'
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
                  <span title="time to forward" className="text-emerald-300">›{r.isolated && !r.fwdIcao ? '—' : `${r.tFwd.toFixed(0)}m`}</span>
                  <span title="time to back" className="text-sky-300">‹{r.isolated && !r.bckIcao ? '—' : `${r.tBck.toFixed(0)}m`}</span>
                  <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }} title="delta tFwd-tBck">
                    {r.isolated ? 'ISO' : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(0)}m`}
                  </span>
                  <span title="dist to ETP along track" className="text-slate-500">
                    {r.isolated ? '—' : `${r.dEtpFromCur >= 0 ? '+' : ''}${r.dEtpFromCur.toFixed(0)}nm`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-slate-900 relative overflow-hidden" title="delta tFwd-tBck (-60..+60min)">
                  <div className="absolute inset-y-0" style={{ left: `${Math.min(50, dPct)}%`, width: `${Math.abs(dPct - 50)}%`, background: TIER_COLOR[r.tier], opacity: 0.85 }} />
                  <div className="absolute inset-y-0 w-0.5 bg-slate-600" style={{ left: `${tickMid}%` }} title="ETP (delta=0)" />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${tickL}%` }} title={`-${balWin}min`} />
                  <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${tickR}%` }} title={`+${balWin}min`} />
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="forward airport" className="text-emerald-300">›{r.fwdI || '—'} {r.dFwd ? `${r.dFwd.toFixed(0)}nm` : ''}</span>
                  <span title="back airport" className="text-sky-300">‹{r.bckI || '—'} {r.dBck ? `${r.dBck.toFixed(0)}nm` : ''}</span>
                  <span className="ml-auto" title="ground-leg distance">{r.dTotal > 0 ? `${r.dTotal.toFixed(0)}nm leg` : '—'}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                  <span title="forward speed (TAS-wind)" className="text-emerald-300">Vf {r.vFwd.toFixed(0)}</span>
                  <span title="back speed (TAS+wind)" className="text-sky-300">Vb {r.vBck.toFixed(0)}</span>
                  <span title="ETP fraction from back airport" className="ml-auto">
                    ETP {r.dTotal > 0 ? `${((r.etpFromBck / r.dTotal) * 100).toFixed(0)}%` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="operator" className="truncate">{r.f.operator || '\u2014'}</span>
                  <span className="ml-auto truncate" style={{ color: TIER_COLOR[r.tier] }}>{advice}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
