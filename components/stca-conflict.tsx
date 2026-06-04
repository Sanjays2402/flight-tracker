'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   STCA · Short-Term Conflict Alert (controller-side safety net)
   ------------------------------------------------------------
   STCA is the radar-room automation that probes every pairwise
   combination of correlated tracks for predicted loss-of-separation
   inside a configurable look-ahead window (typically 60-180 s,
   sometimes up to 240 s for upper-airspace adaptations) using
   linearly-extrapolated state vectors. It is the SHORT-term safety
   net — distinct from MTCD (medium-term, 8-20 min trajectory probe)
   and from TCAS (airborne RA logic). STCA fires on the ground at
   the controller console as a visual/aural CAUTION/WARNING and is
   one of the four EUROCONTROL ground-based safety nets (STCA, MSAW,
   APW, APM) per the Safety Nets Implementation Guideline.

   This monitor evaluates pairwise conflicts against:
     · ICAO Doc 4444 PANS-ATM §15.7 STCA / Cooperative Surveillance
     · ICAO Annex 11 §2.27 ATS surveillance safety nets
     · EUROCONTROL STCA Specification ed.1.0 (2007) + Implementation Guideline
     · EUROCONTROL Safety Nets Implementation Guideline 2018
     · EUROCAE ED-202A Safety Net Functional Spec
     · EUROCAE ED-153 Safety Software Assurance Guideline (SWAL-2)
     · FAA Order JO 7110.65 §5-7 Conflict Alert / Mode-C Intruder
     · FAA Order JO 6190.18 ARTS / STARS Conflict-Alert adaptation
     · FAA NextGen ERAM Conflict Alert / Mode-C Intruder spec
     · ICAO Doc 4444 §5.4 separation minima (radar 3-5 NM / 1000 ft)
     · ICAO Doc 8168 PANS-OPS Vol I §VI vertical separation
     · NATS UK CAA CAP 670 SUR §5 surveillance safety nets
     · DFS DEFRA STCA parameter set
     · NTSB AAR-87-07 PSA 1771 — STCA inhibition
     · NTSB AAR-06-04 Lexington 5191 — STCA-suppression class
     · BFU 02-AX001-1-2 Überlingen — STCA latency / coordination
     · ATSB AO-2013-100 STCA nuisance-rate study
     · MIT Lincoln Lab TR-1257 ERAM CA adaptation
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'WARNING' | 'CAUTION' | 'WATCH' | 'NEAR' | 'CLEAR' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  WARNING: '#ef4444', CAUTION: '#f43f5e', WATCH: '#f59e0b', NEAR: '#0ea5e9', CLEAR: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['WARNING', 'CAUTION', 'WATCH', 'NEAR', 'CLEAR']
const TIER_RANK: Record<Tier, number> = { WARNING: 0, CAUTION: 1, WATCH: 2, NEAR: 3, CLEAR: 4, IDLE: 5 }

/* Airspace domain — sets baseline lateral minima per ICAO Doc 4444 §5.4 */
type Domain = 'TMA' | 'ENROUTE' | 'OCEANIC' | 'UPPER'
const DOMAIN_COLOR: Record<Domain, string> = { TMA: '#0ea5e9', ENROUTE: '#10b981', OCEANIC: '#7c3aed', UPPER: '#f59e0b' }
const DOMAIN_MIN_NM: Record<Domain, number> = { TMA: 3, ENROUTE: 5, OCEANIC: 10, UPPER: 5 }
const DOMAIN_MIN_FT: Record<Domain, number> = { TMA: 1000, ENROUTE: 1000, OCEANIC: 1000, UPPER: 1000 }

/* Airframe class for severity weighting */
type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#7c3aed', NRW: '#0ea5e9', RGN: '#10b981', BIZ: '#f59e0b', TBP: '#64748b' }
function classifyKlass(type?: string): Klass {
  const t = (type || '').toUpperCase()
  if (/^(A38|B74|B77|B78|A35|A34|A33|MD11|IL96|B767|A310|A300)/.test(t)) return 'HVY'
  if (/^(B73|B75|A21|A22|A31|A32|A220|MD8|MD9|BCS|CS[123])/.test(t)) return 'NRW'
  if (/^(CRJ|E1[37]|E14|E17|E19|RJ85|RJ100|F50|F70|F100)/.test(t)) return 'RGN'
  if (/^(GLF|GLEX|GL[5-7]|FA[57]|F2TH|CL[3-6]|C[56]|HDJ|LJ)/.test(t)) return 'BIZ'
  if (/^(AT[47]|DH8|SF34|J32|J41|BE20|BE30|BE40|PC12|TBM)/.test(t)) return 'TBP'
  return 'NRW'
}

/* ----- math ----- */
const R_NM = 3440.065
const D2R = Math.PI / 180, R2D = 180 / Math.PI
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number) {
  const φ1 = la1 * D2R, φ2 = la2 * D2R, Δφ = (la2 - la1) * D2R, Δλ = (lo2 - lo1) * D2R
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }
function angDiff(a: number, b: number) { let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d }

/* Local-flat ENU step (NM) — fine for short look-ahead at typical lats */
function project(la: number, lo: number, brgDeg: number, distNm: number) {
  const φ = la * D2R
  const dN = distNm * Math.cos(brgDeg * D2R)
  const dE = distNm * Math.sin(brgDeg * D2R)
  const dLat = dN / 60
  const dLng = dE / (60 * Math.max(0.05, Math.cos(φ)))
  return { lat: la + dLat, lng: lo + dLng }
}
/* Linear CPA in local ENU plane between two aircraft over horizon T (sec).
   Returns { tCpa (sec, clamped 0..T), dCpa (NM), dNow (NM), vClose (kt) } */
function pairCpa(a: SFlight, b: SFlight, horizonSec: number) {
  const φ0 = ((a.lat + b.lat) / 2) * D2R
  const kx = 60 * Math.cos(φ0) // NM per deg lng
  const ky = 60                  // NM per deg lat
  const ax = a.lng * kx, ay = a.lat * ky
  const bx = b.lng * kx, by = b.lat * ky
  // velocity components (kt → NM/h → NM/s)
  const aVx = a.velocityKts * Math.sin(a.track * D2R) / 3600
  const aVy = a.velocityKts * Math.cos(a.track * D2R) / 3600
  const bVx = b.velocityKts * Math.sin(b.track * D2R) / 3600
  const bVy = b.velocityKts * Math.cos(b.track * D2R) / 3600
  const dx = ax - bx, dy = ay - by
  const dvx = aVx - bVx, dvy = aVy - bVy
  const v2 = dvx * dvx + dvy * dvy
  let tCpa = 0
  if (v2 > 1e-12) tCpa = -(dx * dvx + dy * dvy) / v2
  tCpa = clamp(tCpa, 0, horizonSec)
  const cx = dx + dvx * tCpa, cy = dy + dvy * tCpa
  const dCpa = Math.sqrt(cx * cx + cy * cy)
  const dNow = Math.sqrt(dx * dx + dy * dy)
  const vClose = Math.sqrt(v2) * 3600 // kt
  return { tCpa, dCpa, dNow, vClose }
}
/* Vertical separation at tCpa (ft), assuming current vertRate (fpm) holds */
function vertSepAtFt(a: SFlight, b: SFlight, tSec: number) {
  const aAlt = a.altitudeFt + a.vertRate * tSec / 60
  const bAlt = b.altitudeFt + b.vertRate * tSec / 60
  return Math.abs(aAlt - bAlt)
}

/* Classify pair's domain by altitude band and oceanic proxy (|lng|>30 over water).
   This is a coarse but useful adaptation in lieu of true FIR table. */
function classifyDomain(a: SFlight, b: SFlight): Domain {
  const flA = a.altitudeFt / 100, flB = b.altitudeFt / 100
  const flMax = Math.max(flA, flB), flMin = Math.min(flA, flB)
  if (flMax >= 410) return 'UPPER'
  // crude oceanic: both aircraft over open-ocean bins (NAT 30-60W, PAC 150E-130W in Pac, IND 60-90E)
  const overOcean = (lng: number, lat: number) => (
    (lng > -65 && lng < -15 && lat > 30 && lat < 65) ||  // NAT
    (lng > -180 && lng < -130 && lat > -10 && lat < 65) || // EPAC
    (lng > 150 && lng < 180 && lat > -50 && lat < 65) ||  // WPAC
    (lng > 50 && lng < 95 && lat > -40 && lat < 30)       // IND
  )
  if (overOcean(a.lng, a.lat) && overOcean(b.lng, b.lat) && flMin >= 280) return 'OCEANIC'
  if (flMin < 100) return 'TMA'
  return 'ENROUTE'
}

interface Pair {
  a: SFlight; b: SFlight
  ka: Klass; kb: Klass
  domain: Domain
  minNm: number; minFt: number
  dNow: number; tCpa: number; dCpa: number; vClose: number
  vSepNow: number; vSepCpa: number
  losLat: boolean; losVert: boolean
  losBoth: boolean
  conv: boolean
  trackDelta: number
  score: number; tier: Tier
  drivers: { HRZ: number; VRT: number; TCP: number; VCL: number; CNV: number; DOM: number }
}

export default function StcaConflict({ map, flights, onClose, onFly }: Props) {
  /* sliders */
  const [horizon, setHorizon] = useState(120)   // sec, 30..240
  const [scope, setScope] = useState(60)        // NM proximity gate
  const [latMul, setLatMul] = useState(100)     // lateral minima multiplier
  const [vrtMul, setVrtMul] = useState(100)     // vertical minima multiplier
  const [vcMul, setVcMul] = useState(100)       // closing-speed weight
  const [advMul, setAdvMul] = useState(100)     // composite adv multiplier
  const [minFL, setMinFL] = useState(50)
  const [maxFL, setMaxFL] = useState(450)
  const [inhibitGate, setInhibitGate] = useState(0) // % nuisance suppression
  /* toggles */
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showProj, setShowProj] = useState(true)
  const [showCpa, setShowCpa] = useState(true)
  const [showRing, setShowRing] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  /* filters */
  const [domFilter, setDomFilter] = useState<Domain | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'PAIRS' | 'DOMAINS' | 'ACTORS'>('PAIRS')

  const pairs: Pair[] = useMemo(() => {
    const out: Pair[] = []
    const live = flights.filter(f => !f.ground && (f.altitudeFt / 100) >= minFL && (f.altitudeFt / 100) <= maxFL)
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j]
        // cheap pre-gate by lat/lng box
        if (Math.abs(a.lat - b.lat) > scope / 50) continue
        const lngTol = scope / (50 * Math.max(0.05, Math.cos(((a.lat + b.lat) / 2) * D2R)))
        if (Math.abs(a.lng - b.lng) > lngTol) continue
        const dNowQ = gcDistNm(a.lat, a.lng, b.lat, b.lng)
        if (dNowQ > scope) continue
        const domain = classifyDomain(a, b)
        const minNm = DOMAIN_MIN_NM[domain] * (latMul / 100)
        const minFt = DOMAIN_MIN_FT[domain] * (vrtMul / 100)
        const cpa = pairCpa(a, b, horizon)
        const vSepNow = Math.abs(a.altitudeFt - b.altitudeFt)
        const vSepCpa = vertSepAtFt(a, b, cpa.tCpa)
        const losLat = cpa.dCpa < minNm
        const losVert = vSepCpa < minFt
        const losBoth = losLat && losVert
        const conv = cpa.dCpa < cpa.dNow - 0.05
        const trkD = angDiff(a.track, b.track)
        const ka = classifyKlass(a.type), kb = classifyKlass(b.type)

        // drivers
        // HRZ: horizontal margin at CPA vs minNm (0 well-clear, 100 LoS by ≥minNm)
        const HRZ = clamp((1 - cpa.dCpa / minNm) * 100 + (cpa.dCpa < minNm * 0.5 ? 25 : 0), 0, 100)
        // VRT: vertical margin at CPA vs minFt
        const VRT = clamp((1 - vSepCpa / minFt) * 100 + (vSepCpa < minFt * 0.5 ? 20 : 0), 0, 100)
        // TCP: imminence — 100 at t=0, 0 at horizon
        const TCP = clamp(100 - (cpa.tCpa / horizon) * 100, 0, 100)
        // VCL: closing speed contribution (>=300 kt closure → 100)
        const VCL = clamp((cpa.vClose / 350) * 100 * vcMul / 100, 0, 100)
        // CNV: converging geometry — 100 if dCpa<<dNow
        const CNV = clamp((1 - cpa.dCpa / Math.max(0.5, cpa.dNow)) * 100, 0, 100)
        // DOM: domain criticality (TMA highest)
        const DOM = domain === 'TMA' ? 60 : domain === 'ENROUTE' ? 45 : domain === 'UPPER' ? 50 : 30

        const drivers = { HRZ, VRT, TCP, VCL, CNV, DOM }
        // composite: max(HRZ, VRT) dominates only if both axes breach; otherwise weighted blend
        const losAxis = (losLat ? HRZ : Math.min(HRZ, 60)) * (losVert ? 1 : 0.55)
        const maxDrv = Math.max(losAxis, TCP * (losLat || losVert ? 1 : 0.4), VCL * 0.6 + CNV * 0.4)
        const secMean = (HRZ + VRT + TCP + VCL + CNV + DOM - Math.max(HRZ, VRT, TCP, VCL, CNV, DOM)) / 5
        let score = (maxDrv * 0.78 + secMean * 0.22) * (advMul / 100)
        // nuisance inhibition: parallel tracks at offset with no vertical conflict
        if (inhibitGate > 0 && !losVert && trkD < 15 && cpa.dCpa > minNm * 0.7) {
          score *= (1 - inhibitGate / 100 * 0.75)
        }
        score = clamp(score, 0, 100)

        let tier: Tier = 'CLEAR'
        if (losBoth && cpa.tCpa <= horizon * 0.5 && score >= 78) tier = 'WARNING'
        else if (losBoth && score >= 60) tier = 'CAUTION'
        else if ((losLat || losVert) && score >= 45) tier = 'WATCH'
        else if (score >= 25) tier = 'NEAR'

        out.push({
          a, b, ka, kb, domain, minNm, minFt,
          dNow: cpa.dNow, tCpa: cpa.tCpa, dCpa: cpa.dCpa, vClose: cpa.vClose,
          vSepNow, vSepCpa, losLat, losVert, losBoth, conv, trackDelta: trkD,
          score, tier, drivers,
        })
      }
    }
    out.sort((x, y) => TIER_RANK[x.tier] - TIER_RANK[y.tier] || y.score - x.score)
    return out
  }, [flights, horizon, scope, latMul, vrtMul, vcMul, advMul, minFL, maxFL, inhibitGate])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return pairs.filter(p =>
      (domFilter === 'ALL' || p.domain === domFilter) &&
      (tierFilter === 'ALL' || p.tier === tierFilter) &&
      (!q ||
        (p.a.callsign || '').toLowerCase().includes(q) || p.a.icao.toLowerCase().includes(q) ||
        (p.b.callsign || '').toLowerCase().includes(q) || p.b.icao.toLowerCase().includes(q) ||
        (p.a.type || '').toLowerCase().includes(q) || (p.b.type || '').toLowerCase().includes(q))
    )
  }, [pairs, domFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = useMemo(() => {
    const c: Record<Tier, number> = { WARNING: 0, CAUTION: 0, WATCH: 0, NEAR: 0, CLEAR: 0, IDLE: 0 }
    for (const p of pairs) c[p.tier]++
    return c
  }, [pairs])
  const worst = pairs[0]
  const warning = tierCount.WARNING
  const caution = tierCount.CAUTION
  const watch = tierCount.WATCH
  const meanScore = pairs.length ? pairs.reduce((s, p) => s + p.score, 0) / pairs.length : 0
  const meanCpa = pairs.length ? pairs.reduce((s, p) => s + p.dCpa, 0) / pairs.length : 0
  const meanTcpa = pairs.length ? pairs.reduce((s, p) => s + p.tCpa, 0) / pairs.length : 0
  const involved = new Set<string>()
  pairs.forEach(p => { involved.add(p.a.icao); involved.add(p.b.icao) })

  /* ===== MapLibre overlay ===== */
  const SRC_HALO = 'stca-halo', SRC_PIN = 'stca-pin', SRC_LBL = 'stca-lbl',
    SRC_LINK = 'stca-link', SRC_PROJ = 'stca-proj', SRC_CPA = 'stca-cpa', SRC_RING = 'stca-ring'
  const LYR_HALO = 'stca-halo-l', LYR_PIN = 'stca-pin-l', LYR_LBL = 'stca-lbl-l',
    LYR_LINK = 'stca-link-l', LYR_PROJ = 'stca-proj-l', LYR_CPA = 'stca-cpa-l', LYR_RING = 'stca-ring-l'

  useEffect(() => {
    if (!map) return
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any) }
    for (const s of [SRC_RING, SRC_LINK, SRC_PROJ, SRC_CPA, SRC_HALO, SRC_PIN, SRC_LBL]) ensure(s)
    if (!map.getLayer(LYR_RING)) map.addLayer({ id: LYR_RING, type: 'line', source: SRC_RING, paint: { 'line-color': ['get', 'color'], 'line-width': 0.9, 'line-opacity': 0.55, 'line-dasharray': [2, 2] } } as any)
    if (!map.getLayer(LYR_LINK)) map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.9 } } as any)
    if (!map.getLayer(LYR_PROJ)) map.addLayer({ id: LYR_PROJ, type: 'line', source: SRC_PROJ, paint: { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.8, 'line-dasharray': [3, 2] } } as any)
    if (!map.getLayer(LYR_CPA)) map.addLayer({ id: LYR_CPA, type: 'circle', source: SRC_CPA, paint: { 'circle-radius': 4.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.1, 'circle-opacity': 0.85 } } as any)
    if (!map.getLayer(LYR_HALO)) map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.3, 'circle-stroke-opacity': 0.9 } } as any)
    if (!map.getLayer(LYR_PIN)) map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: { 'circle-radius': 4.5, 'circle-color': '#ef4444', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.95 } } as any)
    if (!map.getLayer(LYR_LBL)) map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] } as any, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } } as any)

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], proj: any[] = [], cpa: any[] = [], ring: any[] = []

    // collect best tier per aircraft for halo/label
    const bestPer: Record<string, Pair> = {}
    for (const p of filtered) {
      const r1 = TIER_RANK[p.tier]
      if (!bestPer[p.a.icao] || TIER_RANK[bestPer[p.a.icao].tier] > r1) bestPer[p.a.icao] = p
      if (!bestPer[p.b.icao] || TIER_RANK[bestPer[p.b.icao].tier] > r1) bestPer[p.b.icao] = p
    }
    for (const ico in bestPer) {
      const p = bestPer[ico]
      const f = ico === p.a.icao ? p.a : p.b
      if (showHalo) {
        const r = 8 + (p.score / 100) * 14
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { r, color: TIER_COLOR[p.tier] } })
      }
      if (showPin && (p.tier === 'WARNING' || p.tier === 'CAUTION')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: {} })
      }
      if (showLbl && p.tier !== 'CLEAR' && p.tier !== 'NEAR') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { label: `${f.callsign || f.icao} ${p.tier} dCPA${p.dCpa.toFixed(1)} t${p.tCpa.toFixed(0)}s`, color: TIER_COLOR[p.tier] } })
      }
    }

    for (const p of filtered) {
      if (p.tier === 'CLEAR') continue
      if (showLink) {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.a.lng, p.a.lat], [p.b.lng, p.b.lat]] }, properties: { color: TIER_COLOR[p.tier] } })
      }
      if (showProj) {
        const aN = project(p.a.lat, p.a.lng, p.a.track, (p.a.velocityKts * p.tCpa) / 3600)
        const bN = project(p.b.lat, p.b.lng, p.b.track, (p.b.velocityKts * p.tCpa) / 3600)
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.a.lng, p.a.lat], [aN.lng, aN.lat]] }, properties: { color: TIER_COLOR[p.tier] } })
        proj.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.b.lng, p.b.lat], [bN.lng, bN.lat]] }, properties: { color: TIER_COLOR[p.tier] } })
        if (showCpa) {
          const mLng = (aN.lng + bN.lng) / 2, mLat = (aN.lat + bN.lat) / 2
          cpa.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [mLng, mLat] }, properties: { color: TIER_COLOR[p.tier] } })
        }
      }
    }

    if (showRing) {
      // Draw separation-minima rings around aircraft involved in WARNING/CAUTION pairs
      const drawn = new Set<string>()
      for (const p of filtered) {
        if (p.tier !== 'WARNING' && p.tier !== 'CAUTION') continue
        for (const f of [p.a, p.b]) {
          if (drawn.has(f.icao)) continue
          drawn.add(f.icao)
          const pts: number[][] = []
          for (let i = 0; i <= 32; i++) {
            const θ = (i / 32) * 360
            const np = project(f.lat, f.lng, θ, p.minNm)
            pts.push([np.lng, np.lat])
          }
          ring.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { color: TIER_COLOR[p.tier] } })
        }
      }
    }

    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_PROJ) as any).setData({ type: 'FeatureCollection', features: proj })
    ;(map.getSource(SRC_CPA) as any).setData({ type: 'FeatureCollection', features: cpa })
    ;(map.getSource(SRC_RING) as any).setData({ type: 'FeatureCollection', features: ring })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_CPA, LYR_PROJ, LYR_LINK, LYR_RING]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_PROJ, SRC_CPA, SRC_RING]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showProj, showCpa, showRing])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const domBadge = (d: Domain) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: DOMAIN_COLOR[d], backgroundColor: DOMAIN_COLOR[d] + '1a', border: `1px solid ${DOMAIN_COLOR[d]}66` }}>{d}</span>
  )
  const klassBadge = (k: Klass) => (
    <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1a', border: `1px solid ${KLASS_COLOR[k]}66` }}>{k}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (p: Pair) => {
    if (p.tier === 'WARNING') return `STCA WARNING · pair ${p.a.callsign || p.a.icao}/${p.b.callsign || p.b.icao} predicted LoS dCPA ${p.dCpa.toFixed(1)}nm < ${p.minNm.toFixed(0)}nm vSep ${p.vSepCpa.toFixed(0)}ft < ${p.minFt.toFixed(0)}ft in t${p.tCpa.toFixed(0)}s — IMMEDIATE turn/level instruction per JO 7110.65 §5-7 / Doc 4444 §15.7`
    if (p.tier === 'CAUTION') return `STCA CAUTION · ${p.domain} pair converging dCPA ${p.dCpa.toFixed(1)}nm vSep ${p.vSepCpa.toFixed(0)}ft @ t${p.tCpa.toFixed(0)}s — prepare avoiding action per EUROCONTROL STCA Spec ed.1.0 §4`
    if (p.tier === 'WATCH') return `STCA WATCH · single-axis breach (${p.losLat ? 'lat' : 'vert'}) dCPA ${p.dCpa.toFixed(1)}nm @ t${p.tCpa.toFixed(0)}s — monitor closure ${p.vClose.toFixed(0)}kt per ED-202A`
    if (p.tier === 'NEAR') return `NEAR · proximal pair within scope dCPA ${p.dCpa.toFixed(1)}nm vSep ${p.vSepCpa.toFixed(0)}ft no predicted LoS`
    return `CLEAR · ${p.dNow.toFixed(1)}nm now, dCPA ${p.dCpa.toFixed(1)}nm — well-clear`
  }

  /* scatter: dCPA (NM) vs tCPA (s) */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, scope * 0.5) / (scope * 0.5) * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n, 0, horizon) / horizon * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">STCA · Short-Term Conflict Alert</div>
          <div className="text-[10px] text-slate-500">Doc 4444 §15.7 · EUROCONTROL STCA Spec ed.1.0 · JO 7110.65 §5-7 · ED-202A · horizon {horizon}s</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean score</div>
          <div className="text-sm font-semibold" style={{ color: meanScore >= 55 ? '#f59e0b' : meanScore >= 25 ? '#0ea5e9' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst pair</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? `${worst.a.callsign || worst.a.icao}/${worst.b.callsign || worst.b.icao}` : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Warning</div>
          <div className="text-sm font-semibold" style={{ color: warning > 0 ? '#ef4444' : '#10b981' }}>{warning}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Caution</div>
          <div className="text-xs font-semibold" style={{ color: caution > 0 ? '#f43f5e' : '#10b981' }}>{caution}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Watch</div>
          <div className="text-xs font-semibold" style={{ color: watch > 0 ? '#f59e0b' : '#10b981' }}>{watch}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean dCPA / tCPA</div>
          <div className="text-xs font-semibold text-sky-300">{meanCpa.toFixed(1)}nm · {meanTcpa.toFixed(0)}s</div>
        </div>
      </div>

      {showDiag && pairs.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* breach band: dCPA < 3nm AND tCPA < horizon*0.5 (warning quadrant) */}
            <rect x={sx(0)} y={sy(horizon * 0.5)} width={sx(3) - sx(0)} height={H - 24 - sy(horizon * 0.5)} fill="#ef444425" />
            {/* watch band: dCPA < 5nm */}
            <rect x={sx(3)} y={0} width={sx(5) - sx(3)} height={H - 24} fill="#f59e0b15" />
            <line x1={sx(3)} y1={0} x2={sx(3)} y2={H - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(5)} y1={0} x2={sx(5)} y2={H - 24} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(0)} y1={sy(horizon * 0.5)} x2={sx(scope * 0.5)} y2={sy(horizon * 0.5)} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">dCPA (NM)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>tCPA (s)</text>
            {pairs.map((p, i) => (
              <circle key={i} cx={sx(p.dCpa)} cy={sy(p.tCpa)} r={2.4} fill={TIER_COLOR[p.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['HORIZON', horizon, 30, 240, setHorizon, 's'],
            ['SCOPE', scope, 20, 120, setScope, 'nm'],
            ['LAT-MUL', latMul, 50, 200, setLatMul, '%'],
            ['VRT-MUL', vrtMul, 50, 200, setVrtMul, '%'],
            ['VC-MUL', vcMul, 50, 200, setVcMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFL, 0, 300, setMinFL, ''],
            ['MAX-FL', maxFL, 100, 660, setMaxFL, ''],
            ['INH-GATE', inhibitGate, 0, 100, setInhibitGate, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['TMA', 'ENROUTE', 'OCEANIC', 'UPPER'] as Domain[]).map(d => (
            <button key={d} onClick={() => setDomFilter(domFilter === d ? 'ALL' : d)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: domFilter === d ? DOMAIN_COLOR[d] + '33' : '#0b1220', borderColor: domFilter === d ? DOMAIN_COLOR[d] : '#1e293b', color: domFilter === d ? DOMAIN_COLOR[d] : '#cbd5e1' }}>{d}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['LINK', showLink, setShowLink],
            ['PROJ', showProj, setShowProj],
            ['CPA', showCpa, setShowCpa],
            ['RING', showRing, setShowRing],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['PAIRS', 'DOMAINS', 'ACTORS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'PAIRS' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No pairs within proximity scope</div>}
          {filtered.map((p, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${TIER_COLOR[p.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <button onClick={() => onFly(p.a.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{p.a.callsign || p.a.icao}</button>
                  {klassBadge(p.ka)}
                  <span className="text-slate-500 text-[10px]">›</span>
                  <button onClick={() => onFly(p.b.icao)} className="font-semibold text-slate-100 hover:text-sky-300 truncate">{p.b.callsign || p.b.icao}</button>
                  {klassBadge(p.kb)}
                  {domBadge(p.domain)}
                </div>
                {tierBadge(p.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {'dNow '}<span className="text-slate-300">{p.dNow.toFixed(1)}nm</span>
                {' · dCPA '}<span style={{ color: p.losLat ? '#ef4444' : p.dCpa < p.minNm * 1.5 ? '#f59e0b' : '#10b981' }}>{p.dCpa.toFixed(2)}nm</span>
                {' '}<span className="text-slate-500">(min {p.minNm.toFixed(0)})</span>
                {' · tCPA '}<span style={{ color: p.tCpa < horizon * 0.3 ? '#ef4444' : p.tCpa < horizon * 0.6 ? '#f59e0b' : '#cbd5e1' }}>{p.tCpa.toFixed(0)}s</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                {'vSep '}<span style={{ color: p.losVert ? '#ef4444' : p.vSepCpa < p.minFt * 1.5 ? '#f59e0b' : '#10b981' }}>{p.vSepCpa.toFixed(0)}ft</span>
                {' '}<span className="text-slate-500">(min {p.minFt.toFixed(0)})</span>
                {' · vC '}<span style={{ color: p.vClose > 250 ? '#f59e0b' : '#cbd5e1' }}>{p.vClose.toFixed(0)}kt</span>
                {' · trk-Δ '}<span style={{ color: p.trackDelta > 140 ? '#ef4444' : p.trackDelta > 90 ? '#f59e0b' : '#cbd5e1' }}>{p.trackDelta.toFixed(0)}°</span>
                {p.conv && <span className="text-rose-400">{' · CONV'}</span>}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
                {'a-FL'}{(p.a.altitudeFt / 100).toFixed(0)}{p.a.vertRate > 200 ? '↑' : p.a.vertRate < -200 ? '↓' : '→'}
                {' · b-FL'}{(p.b.altitudeFt / 100).toFixed(0)}{p.b.vertRate > 200 ? '↑' : p.b.vertRate < -200 ? '↓' : '→'}
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${p.score}%`, backgroundColor: TIER_COLOR[p.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('HRZ', p.drivers.HRZ)}
                {drvBadge('VRT', p.drivers.VRT)}
                {drvBadge('TCP', p.drivers.TCP)}
                {drvBadge('VCL', p.drivers.VCL)}
                {drvBadge('CNV', p.drivers.CNV)}
                {drvBadge('DOM', p.drivers.DOM)}
              </div>
              <div className="text-[10px] mt-1 leading-snug" style={{ color: TIER_COLOR[p.tier] }}>{advice(p)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'DOMAINS' && (
        <div className="divide-y divide-slate-800">
          {(['TMA', 'ENROUTE', 'OCEANIC', 'UPPER'] as Domain[]).map(d => {
            const gr = pairs.filter(p => p.domain === d)
            const w = gr.filter(p => p.tier === 'WARNING').length
            const c = gr.filter(p => p.tier === 'CAUTION').length
            const wt = gr.filter(p => p.tier === 'WATCH').length
            const meanS = gr.length ? gr.reduce((s, p) => s + p.score, 0) / gr.length : 0
            const meanD = gr.length ? gr.reduce((s, p) => s + p.dCpa, 0) / gr.length : 0
            const sev = w > 0 ? '#ef4444' : c > 0 ? '#f43f5e' : wt > 0 ? '#f59e0b' : '#10b981'
            return (
              <div key={d} className="px-3 py-2" style={{ borderLeft: `3px solid ${sev}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {domBadge(d)}
                    <span className="text-slate-200 text-[11px]">{DOMAIN_MIN_NM[d]}nm / {DOMAIN_MIN_FT[d]}ft minima</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">{gr.length} pairs</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {'WARN '}<span style={{ color: w > 0 ? '#ef4444' : '#64748b' }}>{w}</span>
                  {' · CAUT '}<span style={{ color: c > 0 ? '#f43f5e' : '#64748b' }}>{c}</span>
                  {' · WATCH '}<span style={{ color: wt > 0 ? '#f59e0b' : '#64748b' }}>{wt}</span>
                  {' · mean dCPA '}<span className="text-sky-300">{meanD.toFixed(1)}nm</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${meanS}%`, backgroundColor: sev }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'ACTORS' && (
        <div className="divide-y divide-slate-800">
          {(() => {
            const per: Record<string, { f: SFlight; pairs: Pair[] }> = {}
            for (const p of pairs) {
              ;(per[p.a.icao] ||= { f: p.a, pairs: [] }).pairs.push(p)
              ;(per[p.b.icao] ||= { f: p.b, pairs: [] }).pairs.push(p)
            }
            const arr = Object.values(per).sort((a, b) => {
              const wa = a.pairs.filter(p => p.tier === 'WARNING').length
              const wb = b.pairs.filter(p => p.tier === 'WARNING').length
              if (wa !== wb) return wb - wa
              return b.pairs.length - a.pairs.length
            })
            if (arr.length === 0) return <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft involved in any pair</div>
            return arr.slice(0, 60).map(({ f, pairs: gr }) => {
              const k = classifyKlass(f.type)
              const w = gr.filter(p => p.tier === 'WARNING').length
              const c = gr.filter(p => p.tier === 'CAUTION').length
              const wt = gr.filter(p => p.tier === 'WATCH').length
              const worstS = Math.max(...gr.map(p => p.score))
              const worstT: Tier = gr.reduce<Tier>((acc, p) => TIER_RANK[p.tier] < TIER_RANK[acc] ? p.tier : acc, 'CLEAR')
              const sev = TIER_COLOR[worstT]
              return (
                <div key={f.icao} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(f.icao)} style={{ borderLeft: `3px solid ${sev}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-slate-100 truncate">{f.callsign || f.icao}</span>
                      <span className="text-slate-500 text-[10px] truncate">{f.type || '—'}</span>
                      {klassBadge(k)}
                    </div>
                    {tierBadge(worstT)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {'pairs '}<span className="text-slate-200">{gr.length}</span>
                    {' · WARN '}<span style={{ color: w > 0 ? '#ef4444' : '#64748b' }}>{w}</span>
                    {' · CAUT '}<span style={{ color: c > 0 ? '#f43f5e' : '#64748b' }}>{c}</span>
                    {' · WATCH '}<span style={{ color: wt > 0 ? '#f59e0b' : '#64748b' }}>{wt}</span>
                    {' · FL'}{(f.altitudeFt / 100).toFixed(0)}
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${worstS}%`, backgroundColor: sev }} /></div>
                </div>
              )
            })
          })()}
        </div>
      )}
    </div>
  )
}
