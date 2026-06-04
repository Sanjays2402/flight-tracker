'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   OLS · Obstacle Limitation Surfaces conformance monitor
   ------------------------------------------------------------
   Per-airframe scorer for arriving/departing/overflight traffic
   inside the protected airspace of a 20-runway global catalogue,
   evaluating penetration of ICAO Annex 14 Vol I Chapter 4
   Obstacle Limitation Surfaces:

     - Inner horizontal surface   (Annex 14 §4.1.4 — 45m above ARP
        elevation, radius 4000m for Code 3/4 precision approach)
     - Conical surface            (Annex 14 §4.1.3 — slope 5%, height
        100m above inner-horizontal, projects outward to 6000m)
     - Approach surface           (Annex 14 §4.1.5 — first section
        2%/3000m for precision/non-precision approach)
     - Transitional surface       (Annex 14 §4.1.20 — slope 14.3%
        rising from runway edge / approach surface to inner-horizontal)
     - Take-off climb surface     (Annex 14 §4.1.27 — 2% slope from
        end of strip, divergence 12.5% each side, length 15000m)
     - Outer horizontal surface   (Annex 14 §4.1.6 — 150m above ARP,
        radius 15000m, recommended for Code 4 — informational)

   Each penetration depth is computed in meters and ranked against
   recommended TERPS/PANS-OPS obstacle assessment thresholds
   (FAA 8260.3D §2-2, ICAO Doc 8168 Vol II Pt III §3.4.1).

   References:
     ICAO Annex 14 Vol I Ch 4 Obstacle Restriction & Removal
     ICAO Doc 9137 Pt 6 Airport Services Manual — Control of obstacles
     ICAO Doc 9774 Manual on Certification of Aerodromes §3.4
     ICAO Doc 8168 PANS-OPS Vol II Pt III §3.4 obstacle assessment
     ICAO Doc 9905 RNP-AR Procedure Design Manual §3.5
     FAA Order 8260.3D TERPS §2-2 obstacle clearance
     FAA Order 8260.19 §8 vectoring obstacle clearance
     FAA AC 150/5300-13B §3 Runway Design — OFA/OFZ/RPZ
     FAA 14 CFR Part 77 Subpart C imaginary surfaces
     EASA CS-ADR-DSN.J §J.5 OLS (Code 1-4)
     EASA AMC1 ADR.OPS.B.075 obstacle management
     EUROCONTROL EAD Obstacle Database Spec ed.4
     UK CAA CAP 168 Ch.4 Aerodrome safeguarding
     UK CAA CAP 738 Safeguarding of aerodromes
     ICAO Doc 9981 PANS-Aerodromes Pt II §2 obstacle surveys
     NTSB AAR-13-02 Asiana 214 SFO seawall (approach surface)
     NTSB AAR-09-08 Continental 1404 DEN runway excursion
     AAIB EW/C2008/01/01 BA38 LHR (approach surface)
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'PENETRATE' | 'CRITICAL' | 'WARN' | 'CAUTION' | 'WATCH' | 'CLEAR' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  PENETRATE: '#ef4444', CRITICAL: '#f43f5e', WARN: '#f59e0b', CAUTION: '#f59e0b', WATCH: '#0ea5e9', CLEAR: '#10b981', IDLE: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { PENETRATE: 0, CRITICAL: 1, WARN: 2, CAUTION: 3, WATCH: 4, CLEAR: 5, IDLE: 6 }

type Surface = 'IH' | 'CON' | 'APP' | 'TRN' | 'TKO' | 'OH'
const SURF_COLOR: Record<Surface, string> = {
  IH: '#a855f7', CON: '#06b6d4', APP: '#0ea5e9', TRN: '#10b981', TKO: '#f59e0b', OH: '#94a3b8',
}
const SURF_NAME: Record<Surface, string> = {
  IH: 'Inner Horizontal', CON: 'Conical', APP: 'Approach', TRN: 'Transitional', TKO: 'Take-off Climb', OH: 'Outer Horizontal',
}

type AeroCode = 1 | 2 | 3 | 4
type ApproachKind = 'PREC-CAT-I' | 'PREC-CAT-II-III' | 'NON-PREC' | 'NON-INSTR'

interface Runway {
  id: string; airport: string; lat: number; lng: number; brg: number; lenM: number;
  arpElevM: number; code: AeroCode; kind: ApproachKind; authority: string
}

// 20-runway global catalogue (lat/lng = threshold; brg = runway heading toward departure end)
const RUNWAYS: Runway[] = [
  { id:'KJFK-04L', airport:'KJFK', lat:40.6228, lng:-73.7869, brg: 40, lenM:3682, arpElevM:4,   code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'KJFK-13R', airport:'KJFK', lat:40.6478, lng:-73.8169, brg:131, lenM:4423, arpElevM:4,   code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'KLAX-25R', airport:'KLAX', lat:33.9499, lng:-118.4019,brg:249, lenM:3382, arpElevM:38,  code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'KLAX-07L', airport:'KLAX', lat:33.9494, lng:-118.4348,brg: 69, lenM:2719, arpElevM:38,  code:4, kind:'PREC-CAT-I',      authority:'FAA' },
  { id:'KSFO-28R', airport:'KSFO', lat:37.6258, lng:-122.3589,brg:282, lenM:3618, arpElevM:4,   code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'KORD-10L', airport:'KORD', lat:41.9787, lng:-87.9088, brg:100, lenM:2286, arpElevM:204, code:4, kind:'PREC-CAT-I',      authority:'FAA' },
  { id:'KATL-08R', airport:'KATL', lat:33.6294, lng:-84.4419, brg: 92, lenM:2743, arpElevM:308, code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'KDFW-17R', airport:'KDFW', lat:32.9009, lng:-97.0414, brg:175, lenM:4085, arpElevM:184, code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'KBOS-04R', airport:'KBOS', lat:42.3526, lng:-71.0177, brg: 45, lenM:3073, arpElevM:6,   code:4, kind:'PREC-CAT-I',      authority:'FAA' },
  { id:'KSEA-16L', airport:'KSEA', lat:47.4675, lng:-122.3115,brg:160, lenM:3627, arpElevM:131, code:4, kind:'PREC-CAT-II-III', authority:'FAA' },
  { id:'EGLL-09L', airport:'EGLL', lat:51.4775, lng:-0.4886,  brg: 89, lenM:3902, arpElevM:25,  code:4, kind:'PREC-CAT-II-III', authority:'UK CAA' },
  { id:'EGLL-27R', airport:'EGLL', lat:51.4775, lng:-0.4339,  brg:269, lenM:3902, arpElevM:25,  code:4, kind:'PREC-CAT-II-III', authority:'UK CAA' },
  { id:'EGKK-08R', airport:'EGKK', lat:51.1481, lng:-0.1903,  brg: 85, lenM:3316, arpElevM:62,  code:4, kind:'PREC-CAT-I',      authority:'UK CAA' },
  { id:'EHAM-18R', airport:'EHAM', lat:52.3217, lng:4.7775,   brg:183, lenM:3800, arpElevM:-3,  code:4, kind:'PREC-CAT-II-III', authority:'LVNL' },
  { id:'EDDF-25R', airport:'EDDF', lat:50.0421, lng:8.5862,   brg:249, lenM:4000, arpElevM:111, code:4, kind:'PREC-CAT-II-III', authority:'DFS' },
  { id:'LFPG-27L', airport:'LFPG', lat:49.0083, lng:2.5762,   brg:265, lenM:4215, arpElevM:119, code:4, kind:'PREC-CAT-II-III', authority:'DSNA' },
  { id:'OMDB-30R', airport:'OMDB', lat:25.2671, lng:55.3915,  brg:301, lenM:4000, arpElevM:19,  code:4, kind:'PREC-CAT-II-III', authority:'GCAA' },
  { id:'WSSS-20C', airport:'WSSS', lat:1.3722,  lng:103.9858, brg:201, lenM:4000, arpElevM:6,   code:4, kind:'PREC-CAT-II-III', authority:'CAAS' },
  { id:'VHHH-07L', airport:'VHHH', lat:22.3128, lng:113.9114, brg: 73, lenM:3800, arpElevM:9,   code:4, kind:'PREC-CAT-II-III', authority:'CAD-HK' },
  { id:'RJTT-34R', airport:'RJTT', lat:35.5404, lng:139.7855, brg:344, lenM:3000, arpElevM:6,   code:4, kind:'PREC-CAT-II-III', authority:'JCAB' },
]

// Annex 14 Tbl 4-1 OLS dimensions (Code 3/4 precision approach)
const OLS_DIM = {
  innerHorizRadM: 4000, innerHorizHtM: 45,
  conicalSlope: 0.05, conicalHtM: 100,                  // rises to 145m above ARP
  approachInnerEdgeM: 60, approachOriginM: 60,          // edge 60m beyond threshold, half-width 150m
  approachHalfWidthM: 150, approachDivergence: 0.15,
  approachFirstSlope: 0.02, approachFirstLenM: 3000,
  approachSecondSlope: 0.025, approachSecondLenM: 3600,
  transitionalSlope: 1/7,                               // 14.3%
  takeoffOriginM: 60,                                   // 60m beyond runway end
  takeoffSlope: 0.02, takeoffLenM: 15000,
  takeoffStartHalfWidthM: 90, takeoffDivergence: 0.125,
  outerHorizRadM: 15000, outerHorizHtM: 150,
} as const

const NM_PER_DEG_LAT = 60
function nmPerDegLng(lat: number) { return 60 * Math.cos(lat * Math.PI / 180) }
function distNm(aLat:number,aLng:number,bLat:number,bLng:number){const dy=(aLat-bLat)*NM_PER_DEG_LAT;const dx=(aLng-bLng)*nmPerDegLng((aLat+bLat)/2);return Math.hypot(dx,dy)}
function nmToM(nm:number){return nm*1852}
function mToFt(m:number){return m*3.28084}
function ftToM(ft:number){return ft/3.28084}

// Project (lat,lng) into runway frame centred on threshold with x along brg, y perpendicular (right positive). Meters.
function projectToRunway(flat:number, flng:number, r:Runway): { x:number; y:number } {
  const dLat = (flat - r.lat) * NM_PER_DEG_LAT
  const dLng = (flng - r.lng) * nmPerDegLng((flat + r.lat) / 2)
  const eNm = dLng, nNm = dLat
  const eM = nmToM(eNm), nM = nmToM(nNm)
  const rad = r.brg * Math.PI / 180
  const ax = Math.sin(rad), ay = Math.cos(rad)
  const x = eM * ax + nM * ay
  const y = eM * ay - nM * ax
  return { x, y }
}

interface Eval {
  flight: SFlight
  rwy: Runway
  acAltM: number     // absolute MSL
  acAglM: number     // above ARP elev
  surface: Surface
  surfaceCeilM: number    // height of OLS at this (x,y) above ARP elev
  penetM: number          // ac height above surface — positive = penetration
  phase: 'APP' | 'DEP' | 'OVR'
  driver: { PEN:number; TYPE:number; CFG:number; PROX:number; VSI:number; CODE:number }
  score: number
  tier: Tier
  advice: string
}

// Compute which OLS the aircraft is inside, and the surface ceiling above ARP at that (x,y).
function ceilingFor(x:number, y:number, rwyLenM:number): { surface: Surface; ceilM: number } {
  const D = OLS_DIM
  const r = Math.hypot(x - rwyLenM/2, y)  // distance from runway midpoint for inner-horizontal cap
  const approachX = -x - D.approachInnerEdgeM   // distance into approach (positive when before threshold)
  const takeoffX = x - rwyLenM - D.takeoffOriginM
  // Transitional: slope rises from runway centerline edges (half-width = approach edge half-width) to inner-horizontal
  // For aircraft over runway strip, approach edge half-width at this x:
  let stripHalf = D.approachHalfWidthM
  if (x < 0) stripHalf = D.approachHalfWidthM + D.approachDivergence * (-x)
  else if (x > rwyLenM) stripHalf = D.approachHalfWidthM + D.approachDivergence * (x - rwyLenM)
  const transHt = Math.max(0, (Math.abs(y) - stripHalf)) * D.transitionalSlope * -1  // descending below IH

  // Approach surface (only if before threshold, within trapezoid)
  if (approachX > 0 && approachX <= D.approachFirstLenM + D.approachSecondLenM) {
    const halfW = D.approachHalfWidthM + D.approachDivergence * approachX
    if (Math.abs(y) <= halfW) {
      let appHt: number
      if (approachX <= D.approachFirstLenM) appHt = approachX * D.approachFirstSlope
      else appHt = D.approachFirstLenM * D.approachFirstSlope + (approachX - D.approachFirstLenM) * D.approachSecondSlope
      return { surface:'APP', ceilM: appHt }
    }
  }
  // Take-off climb surface (after runway end)
  if (takeoffX > 0 && takeoffX <= D.takeoffLenM) {
    const halfW = D.takeoffStartHalfWidthM + D.takeoffDivergence * takeoffX
    if (Math.abs(y) <= halfW) {
      const tkoHt = takeoffX * D.takeoffSlope
      return { surface:'TKO', ceilM: tkoHt }
    }
  }
  // Transitional (over strip but lateral)
  if (x >= -D.approachInnerEdgeM && x <= rwyLenM + D.takeoffOriginM && Math.abs(y) > stripHalf && Math.abs(y) < stripHalf + (D.innerHorizHtM / D.transitionalSlope)) {
    const tHt = (Math.abs(y) - stripHalf) * D.transitionalSlope
    if (tHt < D.innerHorizHtM) return { surface:'TRN', ceilM: tHt }
  }
  // Inner horizontal disc (within radius)
  if (r <= D.innerHorizRadM) return { surface:'IH', ceilM: D.innerHorizHtM }
  // Conical (between inner-horizontal and conical outer extent)
  const conLen = D.conicalHtM / D.conicalSlope   // 2000m
  if (r <= D.innerHorizRadM + conLen) return { surface:'CON', ceilM: D.innerHorizHtM + (r - D.innerHorizRadM) * D.conicalSlope }
  // Outer horizontal (informational)
  if (r <= D.outerHorizRadM) return { surface:'OH', ceilM: D.outerHorizHtM }
  return { surface:'OH', ceilM: D.outerHorizHtM }
}

function classify(f: SFlight, rwys: Runway[], scopeM: number, penTolM: number, advMul: number): Eval | null {
  if (f.altitudeFt < -200) return null
  if (f.altitudeFt > 12000) return null  // out of OLS scope
  let best: Runway | null = null
  let bestProj: { x:number; y:number } | null = null
  let bestD = Infinity
  for (const r of rwys) {
    const d = distNm(f.lat, f.lng, r.lat, r.lng) * 1852
    if (d < bestD) { bestD = d; best = r; bestProj = projectToRunway(f.lat, f.lng, r) }
  }
  if (!best || !bestProj) return null
  if (bestD > scopeM) return null
  const acAltM = ftToM(f.altitudeFt)
  const acAglM = acAltM - best.arpElevM
  const c = ceilingFor(bestProj.x, bestProj.y, best.lenM)
  const penetM = acAglM - c.ceilM        // positive when above ceiling — but OLS clearance means BELOW ceiling penetrates if obstacle, so for aircraft we flag BELOW-surface during approach (too low) and ABOVE-surface during take-off climb (clearance ok). Reinterpret: penetration = depth aircraft sits BELOW the protected surface (i.e., flying too low or stuck in approach funnel close to terrain). For OLS in the aircraft sense, the surface defines the *minimum-obstacle-free* envelope — aircraft flying ABOVE means safe; aircraft sitting INSIDE the protected wedge (below surface ceiling but above ground) is in the protected funnel — fine, that's the approach corridor. The risk is when an aircraft is BELOW the descending slope of the approach surface (i.e., low on the glide vs the 2% slope). So penet = (ceilingM - acAglM) when on approach/take-off slope (positive = below slope = risk).
  // For approach & takeoff slopes: penet = ceil - ac (positive = below slope = risk).
  // For IH/CON/OH (caps above): penet = ac - ceil (positive = above cap = informational — unusual for those alt bands).
  let penDepth: number
  let phase: 'APP'|'DEP'|'OVR'
  if (c.surface === 'APP') { penDepth = c.ceilM - acAglM; phase = 'APP' }
  else if (c.surface === 'TKO') { penDepth = c.ceilM - acAglM; phase = 'DEP' }
  else if (c.surface === 'TRN') { penDepth = acAglM - c.ceilM; phase = 'OVR' }
  else { penDepth = acAglM - c.ceilM; phase = 'OVR' }

  // ---- Drivers ----
  // PEN: penetration depth normalized to penTolM
  const PEN = Math.max(0, Math.min(100, (penDepth / penTolM) * 80))
  // TYPE: heavy-class amplifier
  const t = (f.type || '').toUpperCase()
  const heavy = ['A380','A388','B748','B744','B77W','B772','B773','B789','B78X','A359','A35K','A332','A333','B763'].includes(t)
  const wide = ['B752','B753','B767','B764','A310'].includes(t)
  const TYPE = heavy ? 55 : wide ? 30 : 8
  // CFG: configuration risk — ground=false + low alt + on approach surface
  const CFG = (phase === 'APP' && f.altitudeFt < 1000) ? 75 : (phase === 'DEP' && f.vertRate < 200 && f.altitudeFt > 200) ? 65 : 12
  // PROX: distance to runway
  const PROX = bestD < 2000 ? 80 : bestD < 5000 ? 55 : bestD < 10000 ? 30 : 12
  // VSI: vertical-rate risk
  const VSI = phase === 'APP' ? (f.vertRate < -1500 ? 80 : f.vertRate < -1000 ? 55 : 20) : phase === 'DEP' ? (f.vertRate < 500 ? 70 : 20) : 12
  // CODE: aerodrome reference code criticality
  const CODE = best.code === 4 ? 60 : best.code === 3 ? 40 : 20

  const drivers = { PEN, TYPE, CFG, PROX, VSI, CODE }
  const arr = Object.values(drivers)
  const maxD = Math.max(...arr)
  const meanSec = (arr.reduce((a,b)=>a+b,0) - maxD) / 5
  let score = (maxD * 0.78 + meanSec * 0.22) * advMul
  // Escalators per Annex 14 / TERPS
  if (penDepth >= penTolM * 2 && (c.surface === 'APP' || c.surface === 'TKO')) score = Math.max(score, 92)
  if (heavy && penDepth >= penTolM && c.surface === 'APP') score = Math.max(score, 88)
  score = Math.max(0, Math.min(100, score))

  let tier: Tier
  if (penDepth >= penTolM * 2 && (c.surface === 'APP' || c.surface === 'TKO')) tier = 'PENETRATE'
  else if (penDepth >= penTolM && (c.surface === 'APP' || c.surface === 'TKO')) tier = 'CRITICAL'
  else if (penDepth >= penTolM * 0.5 && c.surface !== 'OH') tier = 'WARN'
  else if (penDepth >= 0 && c.surface !== 'OH') tier = 'CAUTION'
  else if (score >= 22) tier = 'WATCH'
  else tier = 'CLEAR'

  let advice = ''
  switch (tier) {
    case 'PENETRATE': advice = `PENETRATE — ${penDepth.toFixed(0)}m below ${SURF_NAME[c.surface]} (${(penDepth/penTolM).toFixed(1)}× tol); GO-AROUND advised per FAA 8260.3D §2-2, ICAO Doc 8168 Vol II Pt III §3.4`; break
    case 'CRITICAL': advice = `CRITICAL — ${penDepth.toFixed(0)}m below ${SURF_NAME[c.surface]}; verify glideslope intercept, query controller per Annex 14 §4.1.5`; break
    case 'WARN': advice = `WARN — ${penDepth.toFixed(0)}m intrusion into ${SURF_NAME[c.surface]}; correct vertical profile per Doc 9981 Pt II §2`; break
    case 'CAUTION': advice = `CAUTION — at edge of ${SURF_NAME[c.surface]} envelope; monitor per CAP 168 Ch.4`; break
    case 'WATCH': advice = `WATCH — within OLS scope of ${best.id}, ${c.surface} surface ceiling ${c.ceilM.toFixed(0)}m AGL`; break
    default: advice = `CLEAR — well above ${SURF_NAME[c.surface]} surface (${(acAglM - c.ceilM).toFixed(0)}m clearance) per EASA CS-ADR-DSN.J.5`
  }

  return { flight: f, rwy: best, acAltM, acAglM, surface: c.surface, surfaceCeilM: c.ceilM, penetM: penDepth, phase, driver: drivers, score, tier, advice }
}

function surfPill(s: Surface) {
  return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ background:`${SURF_COLOR[s]}22`, color:SURF_COLOR[s], border:`1px solid ${SURF_COLOR[s]}55` }}>{s}</span>
}
function tierPill(t: Tier) {
  return <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase" style={{ background:`${TIER_COLOR[t]}22`, color:TIER_COLOR[t], border:`1px solid ${TIER_COLOR[t]}55` }}>{t}</span>
}

export default function OlsObstacleSurface({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'SURFACES'>('AIRCRAFT')
  const [scopeNm, setScopeNm] = useState(10)
  const [penTolM, setPenTolM] = useState(60)
  const [advMul, setAdvMul] = useState(1.0)
  const [showHalo, setShowHalo] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showApp, setShowApp] = useState(true)
  const [showTko, setShowTko] = useState(true)
  const [showIH, setShowIH] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [filterSurf, setFilterSurf] = useState<Surface | 'ALL'>('ALL')
  const [filterTier, setFilterTier] = useState<Tier | 'ALL'>('ALL')
  const [query, setQuery] = useState('')

  const scopeM = nmToM(scopeNm)

  const entries: Eval[] = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) { const e = classify(f, RUNWAYS, scopeM, penTolM, advMul); if (e) out.push(e) }
    out.sort((a,b)=> TIER_RANK[a.tier]-TIER_RANK[b.tier] || b.score-a.score)
    return out
  }, [flights, scopeM, penTolM, advMul])

  const visible = useMemo(() => {
    let v = entries
    if (filterTier !== 'ALL') v = v.filter(e => e.tier === filterTier)
    if (filterSurf !== 'ALL') v = v.filter(e => e.surface === filterSurf)
    if (query.trim()) {
      const q = query.toLowerCase()
      v = v.filter(e => (e.flight.callsign||'').toLowerCase().includes(q) || (e.flight.type||'').toLowerCase().includes(q) || e.rwy.id.toLowerCase().includes(q) || e.rwy.airport.toLowerCase().includes(q))
    }
    return v
  }, [entries, filterTier, filterSurf, query])

  const rwyRoll = useMemo(() => {
    const m = new Map<string, { rwy: Runway; entries: Eval[]; worst: Tier; mean: number }>()
    for (const r of RUNWAYS) m.set(r.id, { rwy:r, entries:[], worst:'IDLE', mean:0 })
    for (const e of entries) { const r=m.get(e.rwy.id)!; r.entries.push(e); if (TIER_RANK[e.tier] < TIER_RANK[r.worst]) r.worst = e.tier }
    for (const r of m.values()) r.mean = r.entries.length ? r.entries.reduce((a,b)=>a+b.score,0)/r.entries.length : 0
    return [...m.values()].sort((a,b)=> TIER_RANK[a.worst]-TIER_RANK[b.worst] || b.entries.length-a.entries.length)
  }, [entries])

  const surfRoll = useMemo(() => {
    const m = new Map<Surface, { surf: Surface; entries: Eval[]; worst: Tier; mean: number }>()
    for (const s of ['IH','CON','APP','TRN','TKO','OH'] as Surface[]) m.set(s, { surf:s, entries:[], worst:'IDLE', mean:0 })
    for (const e of entries) { const r=m.get(e.surface)!; r.entries.push(e); if (TIER_RANK[e.tier] < TIER_RANK[r.worst]) r.worst = e.tier }
    for (const r of m.values()) r.mean = r.entries.length ? r.entries.reduce((a,b)=>a+b.score,0)/r.entries.length : 0
    return [...m.values()]
  }, [entries])

  const tierCounts: Record<Tier, number> = { PENETRATE:0,CRITICAL:0,WARN:0,CAUTION:0,WATCH:0,CLEAR:0,IDLE:0 }
  for (const e of entries) tierCounts[e.tier]++
  const meanScore = entries.length ? entries.reduce((a,b)=>a+b.score,0)/entries.length : 0
  const worst = entries[0]

  // -------- MapLibre overlay --------
  useEffect(() => {
    if (!map) return
    const SRC = 'ols-ac'; const SRC_R = 'ols-rwy'; const SRC_AP = 'ols-app'; const SRC_TK = 'ols-tko'; const SRC_IH = 'ols-ih'; const SRC_LK = 'ols-link'
    const LYRH='ols-halo', LYRP='ols-pin', LYRL='ols-lbl'
    const LYRR='ols-rwy-pin', LYRRL='ols-rwy-lbl'
    const LYRAP='ols-app-poly', LYRTK='ols-tko-poly', LYRIH='ols-ih-circ'
    const LYRLK='ols-link-line'

    const acFeats: any[] = []
    const linkFeats: any[] = []
    for (const e of entries) {
      acFeats.push({ type:'Feature', properties:{ color: TIER_COLOR[e.tier], radius: 8 + Math.min(14, e.score/7), tier: e.tier, label: `${e.flight.callsign||e.flight.icao} · ${e.surface} · ${e.penetM>=0?'+':''}${e.penetM.toFixed(0)}m` }, geometry:{ type:'Point', coordinates:[e.flight.lng, e.flight.lat] } })
      if (e.tier !== 'CLEAR' && e.tier !== 'IDLE') {
        linkFeats.push({ type:'Feature', properties:{ color: TIER_COLOR[e.tier] }, geometry:{ type:'LineString', coordinates:[[e.flight.lng, e.flight.lat],[e.rwy.lng, e.rwy.lat]] } })
      }
    }
    const rwyFeats = RUNWAYS.map(r => ({ type:'Feature', properties:{ color:'#0ea5e9', label:`${r.id} · ${r.kind}` }, geometry:{ type:'Point', coordinates:[r.lng, r.lat] } }))

    // Compute approach/takeoff trapezoid polygons in lat/lng for visualization
    function polyFromRunway(r: Runway, kind: 'APP'|'TKO'): any {
      const D = OLS_DIM
      const brgRad = r.brg * Math.PI / 180
      const ax = Math.sin(brgRad), ay = Math.cos(brgRad)  // along runway
      const px = ay, py = -ax  // right perpendicular
      const mPerDegLat = 60 * 1852
      const mPerDegLng = nmPerDegLng(r.lat) * 1852
      const toLL = (xM: number, yM: number) => {
        // x along runway from threshold, y perpendicular (right +)
        const eM = xM * ax + yM * px
        const nM = xM * ay + yM * py
        return [r.lng + eM / mPerDegLng, r.lat + nM / mPerDegLat]
      }
      let pts: number[][] = []
      if (kind === 'APP') {
        const lenT = D.approachFirstLenM + D.approachSecondLenM
        const inner = -D.approachInnerEdgeM
        const outer = inner - lenT
        const hwIn = D.approachHalfWidthM
        const hwOut = D.approachHalfWidthM + D.approachDivergence * lenT
        pts = [ toLL(inner, hwIn), toLL(inner, -hwIn), toLL(outer, -hwOut), toLL(outer, hwOut), toLL(inner, hwIn) ]
      } else {
        const start = r.lenM + D.takeoffOriginM
        const end = start + D.takeoffLenM
        const hwIn = D.takeoffStartHalfWidthM
        const hwOut = D.takeoffStartHalfWidthM + D.takeoffDivergence * D.takeoffLenM
        pts = [ toLL(start, hwIn), toLL(start, -hwIn), toLL(end, -hwOut), toLL(end, hwOut), toLL(start, hwIn) ]
      }
      return { type:'Feature', properties:{ color: kind==='APP'?SURF_COLOR.APP:SURF_COLOR.TKO, label: `${r.id} ${kind}` }, geometry:{ type:'Polygon', coordinates:[pts] } }
    }
    const appFeats = RUNWAYS.map(r => polyFromRunway(r, 'APP'))
    const tkoFeats = RUNWAYS.map(r => polyFromRunway(r, 'TKO'))
    // Inner-horizontal as approximate circle (32-pt)
    function circle(r: Runway): any {
      const mPerDegLat = 60 * 1852
      const mPerDegLng = nmPerDegLng(r.lat) * 1852
      const pts: number[][] = []
      const N = 36
      for (let i=0;i<=N;i++) {
        const t = (i/N)*Math.PI*2
        const dE = Math.sin(t) * OLS_DIM.innerHorizRadM
        const dN = Math.cos(t) * OLS_DIM.innerHorizRadM
        pts.push([r.lng + dE/mPerDegLng, r.lat + dN/mPerDegLat])
      }
      return { type:'Feature', properties:{ color: SURF_COLOR.IH }, geometry:{ type:'Polygon', coordinates:[pts] } }
    }
    const ihFeats = RUNWAYS.map(circle)

    const ensure = (id: string, data: any) => {
      const src = map.getSource(id) as any
      if (src) src.setData({ type:'FeatureCollection', features: data })
      else map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features: data } } as any)
    }
    try {
      ensure(SRC, acFeats); ensure(SRC_R, rwyFeats); ensure(SRC_AP, appFeats); ensure(SRC_TK, tkoFeats); ensure(SRC_IH, ihFeats); ensure(SRC_LK, linkFeats)
      if (!map.getLayer(LYRIH)) map.addLayer({ id:LYRIH, type:'fill', source:SRC_IH, paint:{ 'fill-color': SURF_COLOR.IH, 'fill-opacity':0.05, 'fill-outline-color': SURF_COLOR.IH } } as any)
      if (!map.getLayer(LYRAP)) map.addLayer({ id:LYRAP, type:'fill', source:SRC_AP, paint:{ 'fill-color': SURF_COLOR.APP, 'fill-opacity':0.12, 'fill-outline-color': SURF_COLOR.APP } } as any)
      if (!map.getLayer(LYRTK)) map.addLayer({ id:LYRTK, type:'fill', source:SRC_TK, paint:{ 'fill-color': SURF_COLOR.TKO, 'fill-opacity':0.12, 'fill-outline-color': SURF_COLOR.TKO } } as any)
      if (!map.getLayer(LYRR)) map.addLayer({ id:LYRR, type:'circle', source:SRC_R, paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } } as any)
      if (!map.getLayer(LYRRL)) map.addLayer({ id:LYRRL, type:'symbol', source:SRC_R, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,1.0], 'text-anchor':'top', 'text-font':['Open Sans Regular','Arial Unicode MS Regular'] }, paint:{ 'text-color':'#0ea5e9', 'text-halo-color':'#020617', 'text-halo-width':1.4 } } as any)
      if (!map.getLayer(LYRLK)) map.addLayer({ id:LYRLK, type:'line', source:SRC_LK, paint:{ 'line-color':['get','color'], 'line-width':1, 'line-dasharray':[2,2], 'line-opacity':0.6 } } as any)
      if (!map.getLayer(LYRH)) map.addLayer({ id:LYRH, type:'circle', source:SRC, paint:{ 'circle-radius':['get','radius'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } } as any)
      if (!map.getLayer(LYRP)) map.addLayer({ id:LYRP, type:'circle', source:SRC, filter:['in', ['get','tier'], ['literal',['PENETRATE','CRITICAL','WARN']]], paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1 } } as any)
      if (!map.getLayer(LYRL)) map.addLayer({ id:LYRL, type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,-1.3], 'text-anchor':'bottom', 'text-font':['Open Sans Semibold','Arial Unicode MS Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#020617', 'text-halo-width':1.5 } } as any)

      const vis = (id: string, v: boolean) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none') }
      vis(LYRH, showHalo); vis(LYRP, showHalo); vis(LYRL, showLbl)
      vis(LYRR, showRwy); vis(LYRRL, showRwy && showLbl)
      vis(LYRAP, showApp); vis(LYRTK, showTko); vis(LYRIH, showIH)
      vis(LYRLK, showLink)
    } catch {}

    return () => {
      try {
        for (const l of [LYRL,LYRP,LYRH,LYRLK,LYRRL,LYRR,LYRTK,LYRAP,LYRIH]) if (map.getLayer(l)) map.removeLayer(l)
        for (const s of [SRC,SRC_R,SRC_AP,SRC_TK,SRC_IH,SRC_LK]) if (map.getSource(s)) map.removeSource(s)
      } catch {}
    }
  }, [map, entries, showHalo, showRwy, showApp, showTko, showIH, showLbl, showLink])

  return (
    <div className="absolute top-16 right-4 z-40 w-[min(96vw,580px)] max-h-[82vh] flex flex-col bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Aerodrome safeguarding</div>
          <div className="text-sm font-semibold text-slate-100">OLS · Obstacle Limitation Surfaces <span className="text-slate-500 font-normal">· {entries.length} active · {RUNWAYS.length} runways</span></div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-3 py-2 border-b border-slate-900 flex gap-1 overflow-x-auto">
        {(['PENETRATE','CRITICAL','WARN','CAUTION','WATCH','CLEAR'] as Tier[]).map(t => (
          <button key={t} onClick={() => setFilterTier(filterTier === t ? 'ALL' : t)}
            className={`px-2 py-1 rounded text-[9px] font-mono uppercase whitespace-nowrap border ${filterTier===t?'ring-1 ring-sky-500/40':''}`}
            style={{ background: `${TIER_COLOR[t]}1f`, color: TIER_COLOR[t], borderColor: `${TIER_COLOR[t]}55` }}>
            {t} · {tierCounts[t]}
          </button>
        ))}
        {filterTier !== 'ALL' && <button onClick={()=>setFilterTier('ALL')} className="px-2 py-1 rounded text-[9px] font-mono uppercase border border-slate-700 text-slate-400">CLR</button>}
      </div>

      {/* Summary cells */}
      <div className="px-3 py-2 border-b border-slate-900 grid grid-cols-3 gap-2 text-[10px] font-mono">
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1">
          <div className="text-slate-500 text-[8px] uppercase">Mean score</div>
          <div className="font-semibold" style={{ color: meanScore > 60 ? '#ef4444' : meanScore > 30 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div>
        </div>
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1">
          <div className="text-slate-500 text-[8px] uppercase">Worst</div>
          <div className="font-semibold text-slate-100 truncate">{worst ? (worst.flight.callsign || worst.flight.icao) : '—'}</div>
        </div>
        <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1">
          <div className="text-slate-500 text-[8px] uppercase">Penetrate</div>
          <div className="font-semibold text-rose-400">{tierCounts.PENETRATE + tierCounts.CRITICAL}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-900 space-y-1.5 text-[10px] font-mono text-slate-400">
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-0.5"><div>SCOPE <span className="text-sky-300">{scopeNm.toFixed(0)}nm</span></div>
            <input type="range" min={3} max={30} step={1} value={scopeNm} onChange={e=>setScopeNm(parseFloat(e.target.value))} className="w-full accent-sky-500" /></label>
          <label className="space-y-0.5"><div>PEN-TOL <span className="text-sky-300">{penTolM.toFixed(0)}m</span></div>
            <input type="range" min={10} max={200} step={5} value={penTolM} onChange={e=>setPenTolM(parseFloat(e.target.value))} className="w-full accent-sky-500" /></label>
          <label className="space-y-0.5"><div>ADV-MUL <span className="text-sky-300">{(advMul*100).toFixed(0)}%</span></div>
            <input type="range" min={0.5} max={2} step={0.05} value={advMul} onChange={e=>setAdvMul(parseFloat(e.target.value))} className="w-full accent-sky-500" /></label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['IH','CON','APP','TRN','TKO','OH'] as Surface[]).map(s => (
            <button key={s} onClick={()=>setFilterSurf(filterSurf===s?'ALL':s)} className={`px-1.5 py-0.5 rounded text-[9px] border ${filterSurf===s?'ring-1 ring-sky-500/40':''}`} style={{ background: `${SURF_COLOR[s]}1f`, color: SURF_COLOR[s], borderColor: `${SURF_COLOR[s]}55` }}>{s}</button>
          ))}
          {(['HALO','RWY','APP','TKO','IH','LBL','LINK'] as const).map(t => {
            const v = t==='HALO'?showHalo:t==='RWY'?showRwy:t==='APP'?showApp:t==='TKO'?showTko:t==='IH'?showIH:t==='LBL'?showLbl:showLink
            const setV = t==='HALO'?setShowHalo:t==='RWY'?setShowRwy:t==='APP'?setShowApp:t==='TKO'?setShowTko:t==='IH'?setShowIH:t==='LBL'?setShowLbl:setShowLink
            return <button key={t} onClick={()=>setV(!v)} className={`px-1.5 py-0.5 rounded text-[9px] border ${v?'bg-sky-500/15 text-sky-300 border-sky-500/40':'bg-slate-900 text-slate-500 border-slate-800'}`}>{t}</button>
          })}
        </div>
        <input type="text" placeholder="search callsign / type / runway / airport" value={query} onChange={e=>setQuery(e.target.value)} className="w-full px-2 py-1 rounded bg-slate-900/60 border border-slate-800 text-slate-200 text-[10px] placeholder:text-slate-600" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-2 border-b border-slate-900 flex gap-1">
        {(['AIRCRAFT','RUNWAYS','SURFACES'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded text-[9px] font-mono uppercase ${tab===t?'bg-sky-500/15 text-sky-300 border border-sky-500/40':'bg-slate-900 text-slate-400 border border-slate-800'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto p-2 space-y-1.5 flex-1">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-[11px] text-slate-500 py-6">No aircraft inside OLS scope. Widen SCOPE or wait for arrival/departure traffic at a catalogued runway.</div>
        )}
        {tab === 'AIRCRAFT' && visible.map((e, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden cursor-pointer hover:border-slate-700" onClick={()=>onFly(e.flight.icao)}>
            <div className="h-0.5" style={{ background: TIER_COLOR[e.tier] }} />
            <div className="p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-slate-100">{e.flight.callsign || e.flight.icao}</span>
                <span className="text-slate-500 text-[10px]">{e.flight.type || '—'}</span>
                <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-300">{e.phase}</span>
                {surfPill(e.surface)}
                <div className="ml-auto">{tierPill(e.tier)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>rwy <span className="text-sky-300">{e.rwy.id}</span></span>
                <span className="text-slate-600 italic">{e.rwy.kind}</span>
                <span>Code <span className="text-slate-200">{e.rwy.code}</span></span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>alt <span className="text-slate-200">{e.flight.altitudeFt.toFixed(0)}ft</span></span>
                <span>AGL <span className="text-slate-200">{mToFt(e.acAglM).toFixed(0)}ft</span></span>
                <span>ceil <span className="text-sky-300">{mToFt(e.surfaceCeilM).toFixed(0)}ft</span></span>
                <span>Δ <span style={{ color: e.penetM >= penTolM ? '#ef4444' : e.penetM >= 0 ? '#f59e0b' : '#10b981' }}>{e.penetM>=0?'+':''}{e.penetM.toFixed(0)}m</span></span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>VSI <span style={{ color: e.flight.vertRate < -1000 ? '#ef4444' : e.flight.vertRate < -500 ? '#f59e0b' : '#10b981' }}>{e.flight.vertRate>=0?'+':''}{e.flight.vertRate.toFixed(0)}fpm</span></span>
                <span>vel <span className="text-slate-200">{e.flight.velocityKts.toFixed(0)}kt</span></span>
                <span>trk <span className="text-slate-200">{e.flight.track.toFixed(0)}°</span></span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${e.score}%`, background: TIER_COLOR[e.tier] }} />
              </div>
              <div className="grid grid-cols-6 gap-0.5 text-[9px]">
                {(['PEN','TYPE','CFG','PROX','VSI','CODE'] as const).map(k => {
                  const v = (e.driver as any)[k] as number
                  const c = v > 60 ? '#ef4444' : v > 30 ? '#f59e0b' : '#10b981'
                  return <div key={k} className="rounded px-1 py-0.5 text-center" style={{ background: `${c}1a`, color: c, border:`1px solid ${c}33` }}>{k} {v.toFixed(0)}</div>
                })}
              </div>
              <div className="text-[10px] leading-snug rounded px-1.5 py-1 border" style={{ background: `${TIER_COLOR[e.tier]}10`, borderColor: `${TIER_COLOR[e.tier]}33`, color: TIER_COLOR[e.tier] }}>{e.advice}</div>
            </div>
          </div>
        ))}

        {tab === 'RUNWAYS' && rwyRoll.map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="h-0.5" style={{ background: TIER_COLOR[r.worst] }} />
            <div className="p-2 space-y-0.5">
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono font-semibold text-sky-300">{r.rwy.id}</span>
                <span className="text-slate-500 text-[10px] italic">{r.rwy.kind}</span>
                <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-300">Code {r.rwy.code}</span>
                <div className="ml-auto">{tierPill(r.worst)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>{r.rwy.airport}</span>
                <span>brg <span className="text-slate-200">{r.rwy.brg.toFixed(0)}°</span></span>
                <span>len <span className="text-slate-200">{r.rwy.lenM.toFixed(0)}m</span></span>
                <span>elev <span className="text-slate-200">{r.rwy.arpElevM.toFixed(0)}m</span></span>
                <span className="text-slate-600">{r.rwy.authority}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>ac <span className="text-slate-200">{r.entries.length}</span></span>
                <span>mean <span style={{ color: r.mean>60?'#ef4444':r.mean>30?'#f59e0b':'#10b981' }}>{r.mean.toFixed(0)}</span></span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.mean}%`, background: TIER_COLOR[r.worst] }} />
              </div>
            </div>
          </div>
        ))}

        {tab === 'SURFACES' && surfRoll.map((r, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="h-0.5" style={{ background: SURF_COLOR[r.surf] }} />
            <div className="p-2 space-y-0.5">
              <div className="flex items-center gap-1.5 text-[11px]">
                {surfPill(r.surf)}
                <span className="text-slate-300 italic">{SURF_NAME[r.surf]}</span>
                <div className="ml-auto">{tierPill(r.worst)}</div>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                <span>ac <span className="text-slate-200">{r.entries.length}</span></span>
                <span>mean <span style={{ color: r.mean>60?'#ef4444':r.mean>30?'#f59e0b':'#10b981' }}>{r.mean.toFixed(0)}</span></span>
                <span className="text-slate-600 italic truncate">
                  {r.surf==='IH'?'45m AGL · r=4000m (Annex 14 §4.1.4)':r.surf==='CON'?'5% slope to +100m above IH (§4.1.3)':r.surf==='APP'?'2%/3000m + 2.5%/3600m (§4.1.5)':r.surf==='TRN'?'14.3% transitional (§4.1.20)':r.surf==='TKO'?'2% climb, 12.5% diverge, 15km (§4.1.27)':'150m AGL · r=15000m (§4.1.6)'}
                </span>
              </div>
              <div className="h-1 rounded bg-slate-800 overflow-hidden">
                <div className="h-full" style={{ width: `${r.mean}%`, background: TIER_COLOR[r.worst] }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
