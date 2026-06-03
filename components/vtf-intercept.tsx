'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   VTF · Vector-to-Final ILS Intercept Geometry Monitor
   -------------------------------------------------------------
   Per-arrival assessment of the radar-vector-to-final segment
   that precedes the Final Approach Fix (FAF) on an ILS / LOC /
   RNAV-LNAV/VNAV approach. Continuously evaluates each tracked
   aircraft that has captured (or is converging on) a published
   localiser course extension, scoring 6 geometric drivers:

       1. ANG  intercept angle vs course (≤30° good, >45° bust)
       2. DTF  distance-to-FAF at intercept (≥2 NM, ≤25 NM)
       3. GSL  altitude vs glideslope at intercept (on / above)
       4. SPD  IAS-proxy vs flap-extension window (Vfe/Vlo)
       5. CFG  configuration window (gear/flap by 1500 AGL)
       6. ALN  cross-track displacement at intercept (≤1 NM)

   per FAA JO 7110.65 §5-9-1 / §5-9-2 (Approach Clearance &
   Final Approach Course Interception requirements):
     · Intercept angle ≤30° final-course unless approved
     · Intercept point ≥2 NM outside the FAF (or 5 NM if HVY)
     · Aircraft must be at or above glideslope at LOC capture
     · Established laterally before glideslope-intercept altitude
     · Speed ≤210 KIAS within 40 NM, ≤170 KIAS at FAF (AIM 5-5-9)

   Procedural & regulatory basis:
     · FAA Order JO 7110.65AA §5-9-1 Approach Clearance
     · FAA Order JO 7110.65AA §5-9-2 Final-Course Interception
     · FAA Order JO 7110.65AA §4-8-1 Approach Sequencing
     · FAA AIM 5-4-7 ILS approach / 5-4-20 approach gates
     · FAA AIM 5-5-9 Speed Adjustments
     · FAA AC 90-100A US Terminal & Enroute RNAV Ops
     · FAA AC 120-71B SOPs Stabilised Approach
     · ICAO Doc 4444 PANS-ATM §8.6.5 ATC Vectors to Final
     · ICAO Annex 11 §3.7.1 Approach Control Service
     · ICAO Doc 8168 PANS-OPS Vol II Pt I §1 Final Segment
     · EUROCONTROL Continuous-Climb / CDO Concept of Ops 2017
     · ICAO Doc 9931 CDO Manual §4 Final Approach Profile
     · NTSB AAR-13-02 UPS 1354 BHM premature descent
     · NTSB AAR-72-26 Eastern 401 EVE / NTSB AAR-95-04 AA 965 CALI
     · Boeing FCOM 11.31 ILS capture envelope / Airbus FCOM AS-NAV
     · FSF ALAR Briefing Note 7.1 Stabilised Approach
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'COURSE-BUST' | 'CHASE' | 'TIGHT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'COURSE-BUST': '#ef4444', CHASE: '#f43f5e', TIGHT: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['COURSE-BUST', 'CHASE', 'TIGHT', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'COURSE-BUST': 0, CHASE: 1, TIGHT: 2, WATCH: 3, OK: 4, IDLE: 5 }

/* Per-airframe weight class — heavier aircraft need wider intercepts (≥5 NM outside FAF). */
type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#7c3aed', NRW: '#0ea5e9', RGN: '#10b981', BIZ: '#f59e0b', TBP: '#64748b' }
const KLASS_VFE: Record<Klass, number> = { HVY: 215, NRW: 200, RGN: 195, BIZ: 185, TBP: 170 } // flap-2 Vfe kt IAS proxy
const KLASS_VAT: Record<Klass, number> = { HVY: 145, NRW: 138, RGN: 130, BIZ: 120, TBP: 110 } // Vref kt IAS
const KLASS_FAF_MIN: Record<Klass, number> = { HVY: 5, NRW: 2, RGN: 2, BIZ: 2, TBP: 2 } // min DTF nm at intercept per 5-9-2
function classifyKlass(type?: string, cat?: string): Klass {
  const t = (type || '').toUpperCase()
  if (/^(B77|B78|B74|B748|A35|A34|A33|A310|A300|MD11|IL96|IL76)/.test(t) || cat === 'A5') return 'HVY'
  if (/^(B73|B75|A21|A22|A31|A32|A220|B71|MD8|MD9|BCS|CS[123])/.test(t) || cat === 'A3' || cat === 'A4') return 'NRW'
  if (/^(CRJ|E1[37]|E14|E17|DH8|AT4|AT7|SF34|RJ85|RJ100|F50|F70|F100)/.test(t) || cat === 'A2') return 'RGN'
  if (/^(GLF|FA[12378]|CL[36]|GLEX|G280|HDJT|PC24|C56|C68|C75|LJ[34567])/.test(t)) return 'BIZ'
  return 'TBP'
}

/* Runway / ILS catalogue — magnetic localiser bearing, GS angle, FAF distance & altitude,
   threshold lat/lng, threshold elevation. 26 ILS-equipped runways across major hubs. */
interface Loc {
  icao: string; rwy: string; locBrg: number; gs: number; thrLat: number; thrLng: number; thrElev: number;
  fafNm: number; fafAlt: number; name: string;
}
const LOCS: Loc[] = [
  { icao: 'KJFK', rwy: '22L', locBrg: 220, gs: 3.0, thrLat: 40.6595, thrLng: -73.7775, thrElev: 13,  fafNm: 6.0, fafAlt: 1900, name: 'JFK' },
  { icao: 'KJFK', rwy: '04R', locBrg: 40,  gs: 3.0, thrLat: 40.6256, thrLng: -73.7702, thrElev: 13,  fafNm: 6.0, fafAlt: 1900, name: 'JFK' },
  { icao: 'KLGA', rwy: '04',  locBrg: 32,  gs: 3.0, thrLat: 40.7747, thrLng: -73.8866, thrElev: 21,  fafNm: 5.0, fafAlt: 1600, name: 'LaGuardia' },
  { icao: 'KEWR', rwy: '22L', locBrg: 219, gs: 3.0, thrLat: 40.7160, thrLng: -74.1660, thrElev: 18,  fafNm: 5.5, fafAlt: 1800, name: 'Newark' },
  { icao: 'KORD', rwy: '10C', locBrg: 99,  gs: 3.0, thrLat: 41.9787, thrLng: -87.9292, thrElev: 672, fafNm: 6.2, fafAlt: 2700, name: "O'Hare" },
  { icao: 'KORD', rwy: '28C', locBrg: 279, gs: 3.0, thrLat: 41.9786, thrLng: -87.8762, thrElev: 672, fafNm: 6.2, fafAlt: 2700, name: "O'Hare" },
  { icao: 'KATL', rwy: '08R', locBrg: 89,  gs: 3.0, thrLat: 33.6293, thrLng: -84.4438, thrElev: 1026,fafNm: 5.8, fafAlt: 3000, name: 'Atlanta' },
  { icao: 'KATL', rwy: '26L', locBrg: 269, gs: 3.0, thrLat: 33.6361, thrLng: -84.4060, thrElev: 1026,fafNm: 5.8, fafAlt: 3000, name: 'Atlanta' },
  { icao: 'KDFW', rwy: '17C', locBrg: 174, gs: 3.0, thrLat: 32.9080, thrLng: -97.0398, thrElev: 607, fafNm: 5.5, fafAlt: 2700, name: 'DFW' },
  { icao: 'KDFW', rwy: '35C', locBrg: 354, gs: 3.0, thrLat: 32.8696, thrLng: -97.0420, thrElev: 607, fafNm: 5.5, fafAlt: 2700, name: 'DFW' },
  { icao: 'KLAX', rwy: '25L', locBrg: 249, gs: 3.0, thrLat: 33.9425, thrLng: -118.4081,thrElev: 126, fafNm: 6.4, fafAlt: 2100, name: 'LAX' },
  { icao: 'KLAX', rwy: '07R', locBrg: 69,  gs: 3.0, thrLat: 33.9355, thrLng: -118.4189,thrElev: 126, fafNm: 6.4, fafAlt: 2100, name: 'LAX' },
  { icao: 'KSFO', rwy: '28R', locBrg: 281, gs: 3.0, thrLat: 37.6132, thrLng: -122.3573,thrElev: 13,  fafNm: 6.0, fafAlt: 1800, name: 'SFO' },
  { icao: 'KSEA', rwy: '16L', locBrg: 163, gs: 3.0, thrLat: 47.4581, thrLng: -122.3097,thrElev: 433, fafNm: 5.5, fafAlt: 2300, name: 'Seattle' },
  { icao: 'KDEN', rwy: '16R', locBrg: 173, gs: 3.0, thrLat: 39.8908, thrLng: -104.6736,thrElev: 5431,fafNm: 6.0, fafAlt: 7400, name: 'Denver' },
  { icao: 'KBOS', rwy: '22L', locBrg: 215, gs: 3.0, thrLat: 42.3739, thrLng: -71.0144, thrElev: 20,  fafNm: 5.6, fafAlt: 1800, name: 'Boston' },
  { icao: 'EGLL', rwy: '27L', locBrg: 270, gs: 3.0, thrLat: 51.4775, thrLng: -0.4339,  thrElev: 80,  fafNm: 7.2, fafAlt: 2500, name: 'Heathrow' },
  { icao: 'EGLL', rwy: '09R', locBrg: 90,  gs: 3.0, thrLat: 51.4647, thrLng: -0.4830,  thrElev: 80,  fafNm: 7.2, fafAlt: 2500, name: 'Heathrow' },
  { icao: 'EHAM', rwy: '18R', locBrg: 183, gs: 3.0, thrLat: 52.3624, thrLng: 4.7115,   thrElev: -11, fafNm: 6.0, fafAlt: 2000, name: 'Schiphol' },
  { icao: 'LFPG', rwy: '26L', locBrg: 263, gs: 3.0, thrLat: 49.0173, thrLng: 2.5687,   thrElev: 392, fafNm: 6.4, fafAlt: 2400, name: 'Paris CDG' },
  { icao: 'EDDF', rwy: '25L', locBrg: 248, gs: 3.0, thrLat: 50.0345, thrLng: 8.5879,   thrElev: 364, fafNm: 6.0, fafAlt: 2300, name: 'Frankfurt' },
  { icao: 'EDDM', rwy: '26L', locBrg: 263, gs: 3.0, thrLat: 48.3404, thrLng: 11.8083,  thrElev: 1486,fafNm: 6.0, fafAlt: 3500, name: 'Munich' },
  { icao: 'RJTT', rwy: '34L', locBrg: 339, gs: 3.0, thrLat: 35.5210, thrLng: 139.7714, thrElev: 21,  fafNm: 5.5, fafAlt: 1800, name: 'Haneda' },
  { icao: 'VHHH', rwy: '07R', locBrg: 73,  gs: 3.0, thrLat: 22.3149, thrLng: 113.9036, thrElev: 28,  fafNm: 6.0, fafAlt: 2000, name: 'Hong Kong' },
  { icao: 'WSSS', rwy: '02L', locBrg: 22,  gs: 3.0, thrLat: 1.3219,  thrLng: 103.9888, thrElev: 22,  fafNm: 6.0, fafAlt: 2000, name: 'Singapore' },
  { icao: 'OMDB', rwy: '12R', locBrg: 121, gs: 3.0, thrLat: 25.2607, thrLng: 55.3174,  thrElev: 62,  fafNm: 5.8, fafAlt: 2000, name: 'Dubai' },
]

/* ----- geo math ----- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dφ = (la2 - la1) * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180, dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}
function angDelta(a: number, b: number): number { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }
/* Project point at bearing brg, distance dnm from (la,lo). */
function projectLatLng(la: number, lo: number, brg: number, dnm: number): [number, number] {
  const δ = dnm / R_NM, θ = brg * Math.PI / 180, φ1 = la * Math.PI / 180, λ1 = lo * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI]
}

/* ----- per-aircraft intercept analysis ----- */
interface Vtf {
  f: SFlight
  klass: Klass
  loc: Loc
  distThrNm: number         // along-bearing distance to threshold
  distFafNm: number         // distance to FAF (positive = outside)
  xtrackNm: number          // cross-track displacement from extended LOC (NM)
  interceptAng: number      // |track - locBrg| (deg)
  gsAltAtAcft: number       // GS-altitude at current along-track position (ft MSL)
  altDelta: number          // currentAlt - gsAlt (ft); +above / -below
  speedKt: number           // velocity (kt)
  phase: 'CAPTURE' | 'INTERCEPT' | 'CONVERGE' | 'IDLE'
  drivers: { ANG: number; DTF: number; GSL: number; SPD: number; CFG: number; ALN: number }
  score: number
  tier: Tier
}

function analyse(f: SFlight): Vtf | null {
  if (f.ground || f.altitudeFt > 10000 || f.altitudeFt < 500) return null
  const klass = classifyKlass(f.type, f.category)
  let best: { loc: Loc; distThr: number; xtrk: number; alongTrk: number; interceptAng: number } | null = null
  for (const l of LOCS) {
    const distThr = gcNm(f.lat, f.lng, l.thrLat, l.thrLng)
    if (distThr > 28 || distThr < 2) continue
    // Cross-track formula (great-circle simplified): along-track vs cross-track relative to extended LOC reciprocal from threshold.
    const reciprocal = (l.locBrg + 180) % 360 // bearing FROM threshold OUTBOUND along extended centreline
    const brgThrToAcft = bearingDeg(l.thrLat, l.thrLng, f.lat, f.lng)
    const angOffset = angDelta(brgThrToAcft, reciprocal)
    if (angOffset > 35) continue // too far off-axis to be on a vector-to-final
    const xtrk = Math.sin(angOffset * Math.PI / 180) * distThr
    const alongTrk = Math.cos(angOffset * Math.PI / 180) * distThr
    if (alongTrk < 2 || alongTrk > 26) continue
    const interceptAng = angDelta(f.track, l.locBrg)
    if (interceptAng > 90) continue // outbound, ignore
    const score = Math.abs(xtrk) + angOffset * 0.5 + interceptAng * 0.3
    if (!best || score < (best.xtrk + best.interceptAng * 0.3 + (1 - best.alongTrk / 26) * 5)) {
      best = { loc: l, distThr, xtrk, alongTrk, interceptAng }
    }
  }
  if (!best) return null
  const { loc, distThr, xtrk, alongTrk, interceptAng } = best
  const distFafNm = alongTrk - loc.fafNm
  const phase: Vtf['phase'] =
    Math.abs(xtrk) < 0.3 && interceptAng < 10 ? 'CAPTURE' :
    Math.abs(xtrk) < 1.0 && interceptAng < 35 ? 'INTERCEPT' :
    Math.abs(xtrk) < 4.0 ? 'CONVERGE' : 'IDLE'
  if (phase === 'IDLE') return null

  // Glideslope altitude at aircraft along-track position (NM from threshold)
  const gsAltAtAcft = loc.thrElev + alongTrk * Math.tan(loc.gs * Math.PI / 180) * 6076.12
  const altDelta = f.altitudeFt - gsAltAtAcft

  // 6 risk drivers (0..100)
  const ANG = interceptAng <= 30 ? clamp(interceptAng / 30 * 50, 0, 50)
            : interceptAng <= 45 ? clamp(50 + (interceptAng - 30) / 15 * 30, 50, 80)
            : clamp(80 + (interceptAng - 45) / 15 * 20, 80, 100)
  const minFaf = KLASS_FAF_MIN[klass]
  const DTF = distFafNm < minFaf
    ? clamp(50 + (minFaf - distFafNm) / minFaf * 50, 50, 100)
    : clamp(Math.max(0, (3 - distFafNm) * 25), 0, 50)
  // GSL: 0 if on or just-above GS (0..+300 ft); high if below GS or way above
  const GSL = altDelta < 0 ? clamp(60 + (-altDelta) / 400 * 40, 60, 100)
            : altDelta > 800 ? clamp(40 + (altDelta - 800) / 800 * 40, 40, 80)
            : clamp(altDelta / 300 * 30, 0, 30)
  const vfe = KLASS_VFE[klass]
  const SPD = f.velocityKts > vfe ? clamp(50 + (f.velocityKts - vfe) / 30 * 50, 50, 100)
            : f.velocityKts < KLASS_VAT[klass] - 10 ? clamp(20, 0, 20) : 0
  // CFG proxy: at <2000 AGL expect <Vfe (flap config). High score if not slowing.
  const agl = f.altitudeFt - loc.thrElev
  const CFG = agl < 2000 && f.velocityKts > vfe - 15 ? clamp(60 + (f.velocityKts - (vfe - 15)) * 4, 60, 100)
           : agl < 1500 && f.velocityKts > KLASS_VAT[klass] + 25 ? clamp(50, 30, 70) : 0
  const ALN = Math.abs(xtrk) > 1.0 ? clamp(50 + (Math.abs(xtrk) - 1.0) / 2 * 50, 50, 100)
            : clamp(Math.abs(xtrk) * 50, 0, 50)

  const drivers = { ANG, DTF, GSL, SPD, CFG, ALN }
  const maxDrv = Math.max(ANG, DTF, GSL, SPD, CFG, ALN)
  const secondary = (ANG + DTF + GSL + SPD + CFG + ALN - maxDrv) / 5
  // phase multiplier
  const pmul = phase === 'CAPTURE' ? 1.25 : phase === 'INTERCEPT' ? 1.15 : 1.00
  const rawScore = clamp(maxDrv * pmul + secondary * 0.12, 0, 100)
  let tier: Tier
  if (rawScore >= 80 || (interceptAng > 45 && phase !== 'CONVERGE')) tier = 'COURSE-BUST'
  else if (rawScore >= 60 || (Math.abs(xtrk) > 1.5 && phase === 'CAPTURE')) tier = 'CHASE'
  else if (rawScore >= 40) tier = 'TIGHT'
  else if (rawScore >= 20) tier = 'WATCH'
  else tier = 'OK'

  return {
    f, klass, loc,
    distThrNm: distThr, distFafNm, xtrackNm: xtrk, interceptAng,
    gsAltAtAcft, altDelta, speedKt: f.velocityKts,
    phase, drivers, score: rawScore, tier,
  }
}

const SRC_HALO = 'vtf-halo', LYR_HALO = 'vtf-halo'
const SRC_PIN = 'vtf-pin', LYR_PIN = 'vtf-pin'
const SRC_LBL = 'vtf-lbl', LYR_LBL = 'vtf-lbl'
const SRC_CENT = 'vtf-cent', LYR_CENT = 'vtf-cent'
const SRC_FAF = 'vtf-faf', LYR_FAF = 'vtf-faf'
const SRC_THR = 'vtf-thr', LYR_THR = 'vtf-thr'
const SRC_LINK = 'vtf-link', LYR_LINK = 'vtf-link'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function VtfIntercept({ map, flights, onClose, onFly }: Props) {
  const [angMul, setAngMul] = useState<number>(() => lsGet('ft-vtf-angm', 100))
  const [dtfMul, setDtfMul] = useState<number>(() => lsGet('ft-vtf-dtfm', 100))
  const [spdMul, setSpdMul] = useState<number>(() => lsGet('ft-vtf-spdm', 100))
  const [scope, setScope] = useState<number>(() => lsGet('ft-vtf-scope', 26))
  const [phaseWt, setPhaseWt] = useState<number>(() => lsGet('ft-vtf-phw', 100))
  const [minFL, setMinFL] = useState<number>(() => lsGet('ft-vtf-mfl', 5))
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'RUNWAYS' | 'PHASES'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showCent, setShowCent] = useState(true)
  const [showFaf, setShowFaf] = useState(true)
  const [showThr, setShowThr] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-vtf-angm', angMul); lsSet('ft-vtf-dtfm', dtfMul); lsSet('ft-vtf-spdm', spdMul)
    lsSet('ft-vtf-scope', scope); lsSet('ft-vtf-phw', phaseWt); lsSet('ft-vtf-mfl', minFL)
  }, [angMul, dtfMul, spdMul, scope, phaseWt, minFL])

  const rows = useMemo(() => {
    const out: Vtf[] = []
    for (const f of flights) {
      if (f.altitudeFt < minFL * 100) continue
      const v = analyse(f); if (!v) continue
      // apply slider muls
      v.drivers.ANG = clamp(v.drivers.ANG * angMul / 100, 0, 100)
      v.drivers.DTF = clamp(v.drivers.DTF * dtfMul / 100, 0, 100)
      v.drivers.SPD = clamp(v.drivers.SPD * spdMul / 100, 0, 100)
      const maxDrv = Math.max(v.drivers.ANG, v.drivers.DTF, v.drivers.GSL, v.drivers.SPD, v.drivers.CFG, v.drivers.ALN)
      v.score = clamp(maxDrv * (phaseWt / 100), 0, 100)
      if (v.score >= 80) v.tier = 'COURSE-BUST'
      else if (v.score >= 60) v.tier = 'CHASE'
      else if (v.score >= 40) v.tier = 'TIGHT'
      else if (v.score >= 20) v.tier = 'WATCH'
      else v.tier = 'OK'
      out.push(v)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, angMul, dtfMul, spdMul, phaseWt, minFL])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(v => {
      if (klassFilter !== 'ALL' && v.klass !== klassFilter) return false
      if (tierFilter !== 'ALL' && v.tier !== tierFilter) return false
      if (q) {
        const blob = `${v.f.callsign} ${v.f.icao} ${v.f.type} ${v.loc.icao} ${v.loc.rwy} ${v.loc.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [rows, klassFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { 'COURSE-BUST': 0, CHASE: 0, TIGHT: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const v of rows) tierCount[v.tier]++
  const meanAng = rows.length ? rows.reduce((s, v) => s + v.interceptAng, 0) / rows.length : 0
  const meanXtrk = rows.length ? rows.reduce((s, v) => s + Math.abs(v.xtrackNm), 0) / rows.length : 0
  const busts = tierCount['COURSE-BUST']
  const worst = rows[0]
  const belowGs = rows.filter(v => v.altDelta < 0).length

  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}, before?: string) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any, before)
    }
    ensure(LYR_CENT, 'line', SRC_CENT, { 'line-color': '#0ea5e9', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [4, 3] })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.8, 'line-opacity': 0.8, 'line-dasharray': [3, 2] })
    ensure(LYR_THR, 'circle', SRC_THR, { 'circle-radius': 4, 'circle-color': '#0ea5e9', 'circle-stroke-width': 1.4, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_FAF, 'circle', SRC_FAF, { 'circle-radius': 3.5, 'circle-color': '#a855f7', 'circle-stroke-width': 1.2, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5.5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color'])
    if (map.getLayer(LYR_LBL)) map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a')
    if (map.getLayer(LYR_LBL)) map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4)

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], cent: any[] = [], faf: any[] = [], thr: any[] = []
    const activeLocs = new Set<string>()
    for (const v of filtered) {
      const c = TIER_COLOR[v.tier]
      activeLocs.add(v.loc.icao + '/' + v.loc.rwy)
      if (showHalo) halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c, r: 8 + v.score * 0.14 } })
      if (showPin && (v.tier === 'COURSE-BUST' || v.tier === 'CHASE')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { color: c } })
      if (showLbl && v.tier !== 'OK') {
        const lab = `${v.f.callsign || v.f.icao} · ${v.tier} · ${v.interceptAng.toFixed(0)}° / xtrk ${v.xtrackNm >= 0 ? '+' : ''}${v.xtrackNm.toFixed(1)}nm`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.f.lng, v.f.lat] }, properties: { label: lab, color: c } })
      }
      if (showLink) {
        // perpendicular projection of aircraft onto extended LOC, then line aircraft → projection
        const reciprocal = (v.loc.locBrg + 180) % 360
        const along = Math.abs(v.distThrNm) // approximate
        const [pla, plo] = projectLatLng(v.loc.thrLat, v.loc.thrLng, reciprocal, Math.max(1, v.distThrNm - Math.abs(v.xtrackNm) * 0.1))
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[v.f.lng, v.f.lat], [plo, pla]] }, properties: { color: c } })
      }
    }
    // draw extended centrelines & FAF/threshold pins for every catalogued LOC
    for (const l of LOCS) {
      const isActive = activeLocs.has(l.icao + '/' + l.rwy)
      if (showCent) {
        const reciprocal = (l.locBrg + 180) % 360
        const [pla, plo] = projectLatLng(l.thrLat, l.thrLng, reciprocal, 16)
        cent.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[l.thrLng, l.thrLat], [plo, pla]] }, properties: { active: isActive } })
      }
      if (showThr) thr.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.thrLng, l.thrLat] }, properties: { icao: l.icao, rwy: l.rwy } })
      if (showFaf) {
        const reciprocal = (l.locBrg + 180) % 360
        const [fla, flo] = projectLatLng(l.thrLat, l.thrLng, reciprocal, l.fafNm)
        faf.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [flo, fla] }, properties: { faf: l.fafAlt } })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_CENT) as any).setData({ type: 'FeatureCollection', features: cent })
    ;(map.getSource(SRC_FAF) as any).setData({ type: 'FeatureCollection', features: faf })
    ;(map.getSource(SRC_THR) as any).setData({ type: 'FeatureCollection', features: thr })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_FAF, LYR_THR, LYR_CENT]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_FAF, SRC_THR, SRC_CENT]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showLink, showCent, showFaf, showThr])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const klassBadge = (k: Klass) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1a', border: `1px solid ${KLASS_COLOR[k]}66` }}>{k}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (v: Vtf) => {
    if (v.tier === 'COURSE-BUST') return `COURSE-BUST · intercept ${v.interceptAng.toFixed(0)}° (limit 30°) · xtrk ${v.xtrackNm.toFixed(1)}nm · GO-AROUND or request re-vector per JO 7110.65 §5-9-2`
    if (v.tier === 'CHASE') return `CHASE-GEOMETRY · ${v.interceptAng.toFixed(0)}° onto LOC with ${v.distFafNm.toFixed(1)}nm to FAF · S-turn risk · request 10° left/right for square intercept`
    if (v.tier === 'TIGHT') return `TIGHT-INTERCEPT · ${v.distFafNm.toFixed(1)}nm DTF below ${KLASS_FAF_MIN[v.klass]}nm class-min · be configured before FAF per FCOM 11.31`
    if (v.tier === 'WATCH') return `WATCH · GS ${v.altDelta >= 0 ? '+' : ''}${v.altDelta.toFixed(0)}ft · monitor capture at LOC ${v.loc.icao}/${v.loc.rwy}`
    return `Nominal vector · ${v.interceptAng.toFixed(0)}° intercept · xtrk ${v.xtrackNm.toFixed(1)}nm · ${v.distFafNm.toFixed(1)}nm to FAF`
  }

  /* Scatter: interceptAng vs xtrack */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, 90) / 90 * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n + 3, 0, 6) / 6 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">VTF · Vector-to-Final Intercept Geometry</div>
          <div className="text-[10px] text-slate-500">JO 7110.65 §5-9-1/2 · AIM 5-4-7 · Doc 4444 §8.6.5 · FCOM 11.31</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean angle</div>
          <div className="text-sm font-semibold" style={{ color: meanAng > 30 ? '#ef4444' : meanAng > 20 ? '#f59e0b' : '#10b981' }}>{meanAng.toFixed(0)}°</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Bust</div>
          <div className="text-sm font-semibold" style={{ color: busts > 0 ? '#ef4444' : '#10b981' }}>{busts}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean xtrk</div>
          <div className="text-xs font-semibold" style={{ color: meanXtrk >= 1.5 ? '#ef4444' : meanXtrk >= 0.8 ? '#f59e0b' : '#10b981' }}>{meanXtrk.toFixed(2)}nm</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Below GS</div>
          <div className="text-xs font-semibold" style={{ color: belowGs > 0 ? '#f43f5e' : '#10b981' }}>{belowGs}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Active</div>
          <div className="text-xs font-semibold text-sky-400">{rows.length}</div>
        </div>
      </div>

      {showDiag && rows.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* bust quadrant: ang>45 or |xtrk|>2 */}
            <rect x={sx(45)} y={0} width={W - sx(45)} height={H - 24} fill="#ef444425" />
            <rect x={0} y={0} width={W} height={sy(2) - 0} fill="#ef444415" />
            <rect x={0} y={sy(-2)} width={W} height={H - 24 - sy(-2)} fill="#ef444415" />
            <line x1={sx(0)} y1={sy(0)} x2={sx(90)} y2={sy(0)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(30)} y1={0} x2={sx(30)} y2={H - 24} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(45)} y1={0} x2={sx(45)} y2={H - 24} stroke="#ef444466" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Intercept angle (°)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>X-track (NM)</text>
            {rows.map((v, i) => (
              <circle key={i} cx={sx(v.interceptAng)} cy={sy(v.xtrackNm)} r={2.4} fill={TIER_COLOR[v.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['ANG-MUL', angMul, 50, 200, setAngMul, '%'],
            ['DTF-MUL', dtfMul, 50, 200, setDtfMul, '%'],
            ['SPD-MUL', spdMul, 50, 200, setSpdMul, '%'],
            ['SCOPE', scope, 10, 40, setScope, 'nm'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['MIN-FL', minFL, 0, 100, setMinFL, ''],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY', 'NRW', 'RGN', 'BIZ', 'TBP'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: klassFilter === k ? KLASS_COLOR[k] + '33' : '#0b1220', borderColor: klassFilter === k ? KLASS_COLOR[k] : '#1e293b', color: klassFilter === k ? KLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['LINK', showLink, setShowLink],
            ['CENT', showCent, setShowCent],
            ['FAF', showFaf, setShowFaf],
            ['THR', showThr, setShowThr],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / runway / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'RUNWAYS', 'PHASES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'AIRCRAFT' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No vectored arrivals in scope</div>}
          {filtered.map((v, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(v.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[v.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{v.f.callsign || v.f.icao}</span>
                  <span className="text-slate-500 text-[10px] truncate">{v.f.type || '—'}</span>
                  {klassBadge(v.klass)}
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800/60 text-slate-300 border border-slate-700">{v.phase}</span>
                </div>
                {tierBadge(v.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{v.loc.icao}/{v.loc.rwy}</span>
                {' · LOC '}{v.loc.locBrg.toString().padStart(3, '0')}°
                {' · ANG '}<span style={{ color: v.interceptAng > 45 ? '#ef4444' : v.interceptAng > 30 ? '#f59e0b' : '#10b981' }}>{v.interceptAng.toFixed(0)}°</span>
                {' · DTF '}<span style={{ color: v.distFafNm < KLASS_FAF_MIN[v.klass] ? '#ef4444' : '#cbd5e1' }}>{v.distFafNm.toFixed(1)}nm</span>
                {' · XTRK '}<span style={{ color: Math.abs(v.xtrackNm) > 1 ? '#f59e0b' : '#cbd5e1' }}>{v.xtrackNm >= 0 ? '+' : ''}{v.xtrackNm.toFixed(2)}nm</span>
                {' · GS '}<span style={{ color: v.altDelta < 0 ? '#f43f5e' : '#10b981' }}>{v.altDelta >= 0 ? '+' : ''}{v.altDelta.toFixed(0)}ft</span>
                {' · '}<span className="text-slate-300">{v.speedKt.toFixed(0)}kt</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${v.score}%`, backgroundColor: TIER_COLOR[v.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('ANG', v.drivers.ANG)}
                {drvBadge('DTF', v.drivers.DTF)}
                {drvBadge('GSL', v.drivers.GSL)}
                {drvBadge('SPD', v.drivers.SPD)}
                {drvBadge('CFG', v.drivers.CFG)}
                {drvBadge('ALN', v.drivers.ALN)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[v.tier] }}>{advice(v)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'RUNWAYS' && (
        <div className="divide-y divide-slate-800">
          {LOCS.slice().sort((a, b) => {
            const ka = rows.filter(r => r.loc.icao === a.icao && r.loc.rwy === a.rwy).length
            const kb = rows.filter(r => r.loc.icao === b.icao && r.loc.rwy === b.rwy).length
            return kb - ka
          }).map(l => {
            const rwRows = rows.filter(r => r.loc.icao === l.icao && r.loc.rwy === l.rwy)
            const bust = rwRows.filter(r => r.tier === 'COURSE-BUST').length
            const chase = rwRows.filter(r => r.tier === 'CHASE').length
            const ms = rwRows.length ? rwRows.reduce((s, r) => s + r.score, 0) / rwRows.length : 0
            return (
              <div key={l.icao + l.rwy} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{l.icao}/{l.rwy}</span>
                    <span className="text-slate-400">{l.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">LOC {l.locBrg.toString().padStart(3, '0')}° · GS {l.gs}° · FAF {l.fafNm}nm/{l.fafAlt}ft</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {rwRows.length} on vector · <span className="text-rose-400">{bust} BUST</span> · <span className="text-rose-300">{chase} CHASE</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'PHASES' && (
        <div className="divide-y divide-slate-800">
          {(['CAPTURE', 'INTERCEPT', 'CONVERGE'] as const).map(ph => {
            const phRows = rows.filter(r => r.phase === ph)
            const bust = phRows.filter(r => r.tier === 'COURSE-BUST').length
            const chase = phRows.filter(r => r.tier === 'CHASE').length
            const ms = phRows.length ? phRows.reduce((s, r) => s + r.score, 0) / phRows.length : 0
            const meanA = phRows.length ? phRows.reduce((s, r) => s + r.interceptAng, 0) / phRows.length : 0
            return (
              <div key={ph} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${bust > 0 ? '#ef4444' : chase > 0 ? '#f43f5e' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="font-mono text-slate-200">{ph}</div>
                  <span className="text-[10px] font-mono text-slate-300">{phRows.length} ac · mean {meanA.toFixed(0)}°</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  <span className="text-rose-400">{bust} BUST</span> · <span className="text-rose-300">{chase} CHASE</span> · phase-mul {ph === 'CAPTURE' ? '1.25' : ph === 'INTERCEPT' ? '1.15' : '1.00'}
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
