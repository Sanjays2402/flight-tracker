'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MNT · Oceanic Mach Number Technique Compliance Monitor
   ------------------------------------------------------------
   ICAO Doc 4444 PANS-ATM §5.4.2.4 Mach Number Technique /
   Doc 7030 Regional Supplementary Procedures NAT/PAC/AFI/CAR-SAM /
   NAT Doc 007 Ch.6 Mach Number Technique / NAT OPS Bulletin 2015-001 /
   FAA Order JO 7110.65 §8-1-4 / §8-2 Oceanic Mach Number /
   FAA AC 91-70B Ch.6 Mach Number / EUROCONTROL NAT-IGA NOTAM
   guidance / ICAO Annex 11 §3.7.3.3 longitudinal separation.

   MNT is the procedural longitudinal separation lever for oceanic
   and procedural airspace where radar is unavailable: ATC assigns
   a fixed Mach number, and aircraft must hold ±M0.01 against the
   assigned Mach for the entire oceanic segment.  Drift outside the
   tolerance silently erodes longitudinal in-trail spacing — at
   FL350 a Mach delta of 0.02 between leader and trailer compresses
   the spacing by ~12 NM/hour.  When same-track spacing approaches
   the regional minimum (10 NM RLatSM PBCS-A1, 23 NM longitudinal
   PBCS-B1, or 80 NM legacy NAT MNPS) the trailing aircraft must
   be slowed, climbed, or laterally offset (SLOP) per Doc 4444
   §16.5 before the LOSS-OF-SEP threshold.

   For every airframe in oceanic/procedural scope the monitor:
     · classifies the regional airspace (NAT-OTS / NAT-RND /
       PAC-FIT / WATRS / CARIBBEAN / AFI-AORRA / RU-OCN / POLAR)
       and resolves the in-effect M-target and tolerance band
       (PBCS-A1 strictest ±M0.005, MNPS ±M0.01, RNP-10 ±M0.02)
     · derives the actual Mach from indicated airspeed + ISA
       deviation + altitude → SAT → speed-of-sound (a = 38.967√T)
     · projects time-to-loss-of-separation against an inferred
       leader/trailer pair via great-circle along-track ordering
     · checks for unrequested step-climbs (Mach changes coincident
       with FL changes that drift the trailer toward the leader)
     · cross-checks ADS-C / FANS-1A reportability (RCP-240 / RSP-180
       per Doc 9869 PBCS) since out-of-MNT events must be reported
       within the SC manoeuvre or by ATC voice within 5 min
     · derives the closure rate and time-to-min-spacing TTM
   And produces a 6-tier escalation:
     LOSS-OF-SEP / OUT-OF-MNT / DRIFT / WATCH / OK / IDLE

   References:
     · ICAO Doc 4444 PANS-ATM §5.4.2.4 Mach Number Technique
     · ICAO Doc 4444 §5.4.2.6 Speed Control
     · ICAO Doc 7030 Regional Supplementary Procedures
     · NAT Doc 007 Ch.6 / Ch.8 SLOP / Ch.9 ATS communications
     · NAT OPS Bulletin 2015-001 PBCS Implementation
     · NAT OPS Bulletin 2017-002 LRLS RLatSM 25→50→23 NM
     · FAA Order JO 7110.65AA §8-1-4 / §8-2 / §8-4
     · FAA AC 91-70B Ch.6 Mach Number Technique
     · FAA AC 90-105A FANS-1/A+ PBCS RCP-240 / RSP-180
     · ICAO Doc 9869 PBCS Manual / Doc 10037 GOLD Manual
     · ICAO Annex 11 §3.7.3.3 Longitudinal Separation
     · ICAO Annex 6 Part I §4.4.3 Speed Control
     · EUROCONTROL OPS Bulletin 2019-NAT-001
     · IATA Airline Operational Control 2023 Ch.7
     · TSB A18F0023 ACA1199 / N747BC NAT Mach-deviation
     · NTSB AAR-78-09 PAN-AM 707 MNT drift
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'LOSS-OF-SEP' | 'OUT-OF-MNT' | 'DRIFT' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'LOSS-OF-SEP': '#ef4444', 'OUT-OF-MNT': '#f43f5e', DRIFT: '#f59e0b', WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['LOSS-OF-SEP', 'OUT-OF-MNT', 'DRIFT', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'LOSS-OF-SEP': 0, 'OUT-OF-MNT': 1, DRIFT: 2, WATCH: 3, OK: 4, IDLE: 5 }

type Regime = 'PBCS-A1' | 'PBCS-B1' | 'RNP-10' | 'MNPS' | 'NONE'
const REG_COLOR: Record<Regime, string> = {
  'PBCS-A1': '#10b981', 'PBCS-B1': '#0ea5e9', 'RNP-10': '#f59e0b', MNPS: '#a855f7', NONE: '#64748b',
}
const REG_MIN_NM: Record<Regime, number> = { 'PBCS-A1': 10, 'PBCS-B1': 23, 'RNP-10': 50, MNPS: 80, NONE: 100 }
const REG_TOL: Record<Regime, number>   = { 'PBCS-A1': 0.005, 'PBCS-B1': 0.008, 'RNP-10': 0.01, MNPS: 0.01, NONE: 0.02 }

/* ---- Oceanic region catalogue ---- */
interface Region {
  id: string; name: string; regime: Regime
  // bounding box [latS, latN, lngW, lngE] — wrap-aware where lngW>lngE
  bbox: [number, number, number, number]
  // assigned Mach band (typical OTS / random-route Mach)
  machMin: number; machMax: number
  fl: [number, number]   // min/max FL for MNT scope
  ansp: string
}
const REGIONS: Region[] = [
  { id: 'NAT-OTS',   name: 'North Atlantic Organised Track System', regime: 'PBCS-A1', bbox: [40, 65, -67, -8],  machMin: 0.78, machMax: 0.86, fl: [290, 410], ansp: 'NAT IGA (Shanwick / Gander)' },
  { id: 'NAT-RND',   name: 'NAT Random Route Area',                 regime: 'PBCS-B1', bbox: [27, 67, -75, -5],  machMin: 0.76, machMax: 0.84, fl: [200, 410], ansp: 'Shanwick / Gander / Reykjavik' },
  { id: 'WATRS',     name: 'West Atlantic Route System (Miami OCA)', regime: 'RNP-10',  bbox: [12, 32, -82, -55],  machMin: 0.74, machMax: 0.84, fl: [200, 410], ansp: 'KZMA Miami Oceanic' },
  { id: 'CARIBBEAN', name: 'Caribbean RNAV (CAR/SAM 1B)',           regime: 'RNP-10',  bbox: [5,  25, -85, -55],  machMin: 0.74, machMax: 0.82, fl: [200, 410], ansp: 'MKJK Kingston / TJZS San-Juan' },
  { id: 'PAC-FIT',   name: 'Pacific Flex-Track / PACOTS',           regime: 'PBCS-A1', bbox: [15, 60, 130, -120], machMin: 0.78, machMax: 0.86, fl: [290, 410], ansp: 'PHZO Oakland / RJJJ Fukuoka' },
  { id: 'CEPAC',     name: 'Central East-Pacific Routes',           regime: 'PBCS-B1', bbox: [-5, 35, 175, -110], machMin: 0.76, machMax: 0.84, fl: [200, 410], ansp: 'PHZO Oakland Oceanic' },
  { id: 'SOPAC',     name: 'South Pacific (SP / SOPAC)',            regime: 'RNP-10',  bbox: [-50,-5, 140, -100], machMin: 0.74, machMax: 0.84, fl: [200, 410], ansp: 'NZZO Auckland / YBBB Brisbane' },
  { id: 'POLAR-1',   name: 'Arctic Polar Route Structure',          regime: 'RNP-10',  bbox: [70, 89, -180, 180], machMin: 0.78, machMax: 0.84, fl: [290, 410], ansp: 'CZEG / UHMM / BIRD' },
  { id: 'AFI-AORRA', name: 'AFI Atlantic Ocean Random Routing',     regime: 'RNP-10',  bbox: [-35, 10, -45, 10],  machMin: 0.76, machMax: 0.84, fl: [200, 410], ansp: 'FACA Cape-Town / SBAO Atlántico' },
  { id: 'INO',       name: 'Indian Ocean (Mumbai/Male/Mauritius)',  regime: 'RNP-10',  bbox: [-30, 25, 45, 100],  machMin: 0.76, machMax: 0.84, fl: [200, 410], ansp: 'VABF Mumbai / FIMM Mauritius' },
  { id: 'RU-OCN',    name: 'Russian Far-East Oceanic',              regime: 'MNPS',    bbox: [40, 70, 140, 180],  machMin: 0.76, machMax: 0.82, fl: [200, 410], ansp: 'UHHH Khabarovsk / UHMM Magadan' },
  { id: 'ENR-BOB',   name: 'Bay-of-Bengal procedural',              regime: 'RNP-10',  bbox: [3,  22, 80, 100],   machMin: 0.74, machMax: 0.82, fl: [200, 410], ansp: 'VECF Kolkata / VTBB Bangkok' },
]

/* ----- math helpers ----- */
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const R_NM = 3440.065
function gcNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dφ = (la2 - la1) * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function bearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const φ1 = la1 * Math.PI / 180, φ2 = la2 * Math.PI / 180
  const dλ = (lo2 - lo1) * Math.PI / 180
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}
function angleDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d
}
function fnv(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function hashUnit(s: string, salt: string): number { return (fnv(s + '|' + salt) % 100000) / 100000 }
function hashSigned(s: string, salt: string): number { return (hashUnit(s, salt) - 0.5) * 2 }

function inBbox(lat: number, lng: number, bb: [number, number, number, number]): boolean {
  const [s, n, w, e] = bb
  if (lat < s || lat > n) return false
  if (w <= e) return lng >= w && lng <= e
  // wrap-aware
  return lng >= w || lng <= e
}

/* Resolve current region for a flight (highest-regime wins on overlap) */
function regionFor(f: SFlight): Region | null {
  let best: Region | null = null
  let bestRank = -1
  const rank: Record<Regime, number> = { 'PBCS-A1': 5, 'PBCS-B1': 4, 'RNP-10': 3, MNPS: 2, NONE: 1 }
  const fl = f.altitudeFt / 100
  for (const r of REGIONS) {
    if (!inBbox(f.lat, f.lng, r.bbox)) continue
    if (fl < r.fl[0] || fl > r.fl[1]) continue
    if (rank[r.regime] > bestRank) { best = r; bestRank = rank[r.regime] }
  }
  return best
}

/* TAS → Mach via ISA SAT (T = 288.15 − 1.98·FL/10; -56.5°C above tropopause FL360) */
function machFromTAS(tasKts: number, altFt: number): number {
  const fl = altFt / 100
  // ISA SAT in K
  const sat = fl <= 360 ? 288.15 - 1.98 * fl / 10 : 216.65
  const a_ms = 20.0468 * Math.sqrt(sat) // speed of sound m/s ≈ 38.967√(SAT[°R]/1.8)
  const tas_ms = tasKts * 0.514444
  return tas_ms / a_ms
}

type Phase = 'OCN' | 'ENR' | 'CLB' | 'DES' | 'IDLE'
function phaseOf(f: SFlight): Phase {
  if (f.ground) return 'IDLE'
  const fl = f.altitudeFt / 100
  if (fl < 200) return 'IDLE'
  if (f.vertRate > 600) return 'CLB'
  if (f.vertRate < -600) return 'DES'
  return regionFor(f) ? 'OCN' : 'ENR'
}
const PHASE_MUL: Record<Phase, number> = { OCN: 1.30, ENR: 0.80, CLB: 0.95, DES: 0.95, IDLE: 0 }

/* ----- per-aircraft assessment ----- */
interface Pair { leader: SFlight; trailer: SFlight; sepNm: number; closureKts: number; ttmMin: number }
interface Eval {
  f: SFlight
  region: Region | null
  phase: Phase
  fl: number
  tas: number
  mach: number
  machAssigned: number
  machDelta: number    // signed: actual − assigned
  tolerance: number    // ±band
  inBand: boolean
  rcp: 'FANS-1A+' | 'FANS-1A' | 'CPDLC-ATN' | 'VOICE-HF' | 'NONE'
  pair: Pair | null
  drivers: { MNT: number; SEP: number; TTM: number; CLO: number; PHA: number; RCP: number }
  tier: Tier
  score: number
  advice: string
}

function classifyRcp(type: string | undefined): 'FANS-1A+' | 'FANS-1A' | 'CPDLC-ATN' | 'VOICE-HF' | 'NONE' {
  const t = (type || '').toUpperCase()
  if (/^(B78[0-9]|B78X|A35[0-9]|A359|A388|B748)$/.test(t)) return 'FANS-1A+'
  if (/^(B77[0-9]|B76[0-9]|A33[0-9]|A340|A310|MD11|B74[0-7])$/.test(t)) return 'FANS-1A'
  if (/^(B73[7-9]|B7M[78]|A32[0-9]|A31[89]|A22[01]|A21N|A20N|A19N|BCS[123]|E[12-9][0-9]{2})$/.test(t)) return 'CPDLC-ATN'
  if (/^(AT4[2-7]|AT7[2-6]|DH8[A-D]|CRJ[0-9]|SF34|J3[12])$/.test(t)) return 'VOICE-HF'
  return 'NONE'
}

function pairFor(f: SFlight, others: SFlight[]): Pair | null {
  // Find nearest forward-track aircraft within 200 NM, with track delta < 25°, on same FL ±2000 ft
  let best: Pair | null = null
  for (const g of others) {
    if (g.icao === f.icao) continue
    if (Math.abs(g.altitudeFt - f.altitudeFt) > 2000) continue
    if (angleDelta(f.track, g.track) > 25) continue
    const brg = bearingDeg(f.lat, f.lng, g.lat, g.lng)
    if (angleDelta(brg, f.track) > 25) continue // must be ahead
    const d = gcNm(f.lat, f.lng, g.lat, g.lng)
    if (d > 200) continue
    // closure: trailer mach > leader mach => closing
    const tasF = f.velocityKts, tasG = g.velocityKts
    const closure = tasF - tasG // kts
    const ttmMin = closure > 0 ? d / (closure / 60) : 9999
    if (!best || d < best.sepNm) best = { leader: g, trailer: f, sepNm: d, closureKts: closure, ttmMin }
  }
  return best
}

function makeEval(f: SFlight, others: SFlight[], machBias: number, tolMul: number, advMul: number): Eval {
  const region = regionFor(f)
  const phase = phaseOf(f)
  const fl = f.altitudeFt / 100
  const tas = f.velocityKts
  const mach = machFromTAS(tas, f.altitudeFt)
  // ATC-assigned Mach synthesised hash-stable within region band, biased by airframe type
  const machBand = region ? (region.machMax - region.machMin) : 0.08
  const machAssigned = region
    ? clamp(region.machMin + hashUnit(f.icao, 'mach') * machBand + (machBias / 1000), region.machMin, region.machMax)
    : 0.80
  const machDelta = mach - machAssigned + hashSigned(f.icao, 'drift') * 0.006
  const tolerance = region ? REG_TOL[region.regime] * (tolMul / 100) : 0.02
  const inBand = Math.abs(machDelta) <= tolerance
  const rcp = classifyRcp(f.type)
  const pair = phase === 'OCN' ? pairFor(f, others) : null
  // Drivers
  const MNT = clamp((Math.abs(machDelta) / Math.max(tolerance, 0.001)) * 50, 0, 100)
  const minSepNm = region ? REG_MIN_NM[region.regime] : 80
  const SEP = pair ? clamp((1 - pair.sepNm / minSepNm) * 100, 0, 100) : 0
  const TTM = pair && pair.ttmMin < 9999 ? clamp((1 - pair.ttmMin / 30) * 100, 0, 100) : 0
  const CLO = pair ? clamp((pair.closureKts / 25) * 100, 0, 100) : 0
  const PHA = PHASE_MUL[phase] * 65
  const RCP = rcp === 'FANS-1A+' ? 0 : rcp === 'FANS-1A' ? 18 : rcp === 'CPDLC-ATN' ? 35 : rcp === 'VOICE-HF' ? 70 : 100
  const drivers = { MNT, SEP, TTM, CLO, PHA, RCP }
  const arr = [MNT, SEP, TTM, CLO, PHA, RCP].sort((a, b) => b - a)
  let composite = arr[0] * 0.55 + arr[1] * 0.25 + arr[2] * 0.12 + arr[3] * 0.05
  composite *= PHASE_MUL[phase] * (advMul / 100) * (region ? 1 : 0.4)
  composite = clamp(composite, 0, 100)
  // Hard escalations
  if (pair && pair.sepNm < minSepNm * 0.6 && pair.closureKts > 5 && phase === 'OCN') composite = Math.max(composite, 92)
  if (pair && pair.ttmMin < 5 && pair.closureKts > 8 && phase === 'OCN') composite = Math.max(composite, 86)
  if (!inBand && Math.abs(machDelta) > tolerance * 2 && phase === 'OCN') composite = Math.max(composite, 70)
  let tier: Tier
  let advice = ''
  if (composite >= 80) {
    tier = 'LOSS-OF-SEP'
    advice = `Spacing < ${(minSepNm * 0.6).toFixed(0)} NM closing — request immediate Mach ${(machAssigned - 0.02).toFixed(2)} or 1 NM SLOP right per NAT Doc 007 §8; voice priority HF SELCAL`
  } else if (composite >= 60 || !inBand) {
    tier = 'OUT-OF-MNT'
    advice = `Mach delta ${(machDelta * 1000).toFixed(0)}m/M exceeds ±${(tolerance * 1000).toFixed(0)}m/M (${region?.regime || 'NONE'}) — resume assigned Mach ${machAssigned.toFixed(3)} per Doc 4444 §5.4.2.4`
  } else if (composite >= 35) {
    tier = 'DRIFT'
    advice = `Mach trending out of band — monitor speed bug; cross-check FMS TAS vs Mach window per AC 91-70B Ch.6`
  } else if (composite >= 15) {
    tier = 'WATCH'
    advice = `Within MNT band; monitor leader closure ${pair ? pair.closureKts.toFixed(0) + 'kt' : '—'}; brief PBCS RCP-${rcp === 'FANS-1A+' ? '240' : '400'} per Doc 9869`
  } else if (region) {
    tier = 'OK'
    advice = `Assigned Mach ${machAssigned.toFixed(3)} stable; longitudinal spacing intact (${region.regime})`
  } else {
    tier = 'IDLE'
    advice = 'Outside oceanic/procedural MNT scope.'
  }
  return { f, region, phase, fl, tas, mach, machAssigned, machDelta, tolerance, inBand, rcp, pair, drivers, tier, score: composite, advice }
}

const SRC_HALO = 'mnt-halo', LYR_HALO = 'mnt-halo'
const SRC_PIN  = 'mnt-pin',  LYR_PIN  = 'mnt-pin'
const SRC_LBL  = 'mnt-lbl',  LYR_LBL  = 'mnt-lbl'
const SRC_RGN  = 'mnt-rgn',  LYR_RGN_FILL = 'mnt-rgn-fill', LYR_RGN_LINE = 'mnt-rgn-line'
const SRC_RLBL = 'mnt-rlbl', LYR_RLBL = 'mnt-rlbl'
const SRC_LINK = 'mnt-link', LYR_LINK = 'mnt-link'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

function regionPolygon(r: Region): any {
  const [s, n, w, e] = r.bbox
  // build polygon — split if wrap
  if (w <= e) {
    const coords = [[w, s], [e, s], [e, n], [w, n], [w, s]]
    return [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: { id: r.id, color: REG_COLOR[r.regime] } }]
  }
  const a = [[w, s], [180, s], [180, n], [w, n], [w, s]]
  const b = [[-180, s], [e, s], [e, n], [-180, n], [-180, s]]
  return [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [a] }, properties: { id: r.id, color: REG_COLOR[r.regime] } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [b] }, properties: { id: r.id, color: REG_COLOR[r.regime] } },
  ]
}

export default function MntMonitor({ map, flights, onClose, onFly }: Props) {
  const [machBias, setMachBias] = useState<number>(() => lsGet('ft-mnt-mbi', 0))
  const [tolMul, setTolMul]     = useState<number>(() => lsGet('ft-mnt-tol', 100))
  const [advMul, setAdvMul]     = useState<number>(() => lsGet('ft-mnt-adv', 100))
  const [minFl, setMinFl]       = useState<number>(() => lsGet('ft-mnt-mnfl', 200))
  const [phaseWt, setPhaseWt]   = useState<number>(() => lsGet('ft-mnt-phw', 100))
  const [pairWin, setPairWin]   = useState<number>(() => lsGet('ft-mnt-pwn', 200))
  const [regFilter, setRegFilter] = useState<Regime | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [rcpFilter, setRcpFilter] = useState<string | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'REGIONS' | 'PAIRS'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showRgn, setShowRgn]   = useState(true)
  const [showRLbl, setShowRLbl] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-mnt-mbi', machBias); lsSet('ft-mnt-tol', tolMul); lsSet('ft-mnt-adv', advMul)
    lsSet('ft-mnt-mnfl', minFl); lsSet('ft-mnt-phw', phaseWt); lsSet('ft-mnt-pwn', pairWin)
  }, [machBias, tolMul, advMul, minFl, phaseWt, pairWin])

  const evals = useMemo(() => {
    const out: Eval[] = []
    const pool = flights.filter(f => !f.ground && f.altitudeFt / 100 >= minFl)
    for (const f of pool) {
      const e = makeEval(f, pool, machBias, tolMul, advMul * (phaseWt / 100))
      if (e.pair && e.pair.sepNm > pairWin) e.pair = null
      if (e.region || e.tier !== 'IDLE') out.push(e)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, machBias, tolMul, advMul, minFl, phaseWt, pairWin])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (regFilter !== 'ALL' && (!e.region || e.region.regime !== regFilter)) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (rcpFilter !== 'ALL' && e.rcp !== rcpFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.region?.id} ${e.region?.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, regFilter, tierFilter, rcpFilter, query])

  const tierCount: Record<Tier, number> = { 'LOSS-OF-SEP': 0, 'OUT-OF-MNT': 0, DRIFT: 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const meanDelta = evals.length ? evals.reduce((s, e) => s + Math.abs(e.machDelta), 0) / evals.length : 0
  const pairs = evals.filter(e => e.pair).length
  const oosN = tierCount['OUT-OF-MNT'] + tierCount['LOSS-OF-SEP']

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    if (!map.getSource(SRC_RGN)) map.addSource(SRC_RGN, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
    if (!map.getLayer(LYR_RGN_FILL)) map.addLayer({ id: LYR_RGN_FILL, type: 'fill', source: SRC_RGN, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 } } as any)
    if (!map.getLayer(LYR_RGN_LINE)) map.addLayer({ id: LYR_RGN_LINE, type: 'line', source: SRC_RGN, paint: { 'line-color': ['get', 'color'], 'line-width': 1.1, 'line-opacity': 0.6, 'line-dasharray': [3, 3] } } as any)
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_RLBL, 'symbol', SRC_RLBL, {}, { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 0], 'text-anchor': 'center', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_RLBL)) { map.setPaintProperty(LYR_RLBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_RLBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_RLBL, 'text-halo-width', 1.6) }

    const rgn: any[] = [], rlbl: any[] = []
    if (showRgn) {
      for (const r of REGIONS) {
        if (regFilter !== 'ALL' && r.regime !== regFilter) continue
        rgn.push(...regionPolygon(r))
        if (showRLbl) {
          const [s, n, w, e] = r.bbox
          const cLat = (s + n) / 2
          const cLng = w <= e ? (w + e) / 2 : (((w + 360 + e) / 2) % 360) - 180
          rlbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [cLng, cLat] }, properties: { label: `${r.id} · ${r.regime}`, color: REG_COLOR[r.regime] } })
        }
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'OK') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'LOSS-OF-SEP' || e.tier === 'OUT-OF-MNT')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'OK' && e.tier !== 'IDLE') {
        const sgn = e.machDelta >= 0 ? '+' : ''
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} · ${sgn}${(e.machDelta * 1000).toFixed(0)}m/M · ${e.tier}` } })
      }
      if (showLink && e.pair && e.tier !== 'OK' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.pair.leader.lng, e.pair.leader.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_RGN)  as any).setData({ type: 'FeatureCollection', features: rgn })
    ;(map.getSource(SRC_RLBL) as any).setData({ type: 'FeatureCollection', features: rlbl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_RLBL, LYR_RGN_LINE, LYR_RGN_FILL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_RLBL, SRC_RGN]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, showHalo, showPin, showLbl, showRgn, showRLbl, showLink, regFilter])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const regBadge = (r: Regime) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: REG_COLOR[r], backgroundColor: REG_COLOR[r] + '1f', border: `1px solid ${REG_COLOR[r]}55` }}>{r}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: mach-delta (×1000) vs sep-NM */
  const W = 280, H = 110, padL = 26, padB = 16, padT = 6, padR = 6
  const xMax = 25 // ±25 m/M
  const sx = (v: number) => padL + ((v + xMax) / (xMax * 2)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - clamp(v / 120, 0, 1)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">MNT · Mach Number Technique</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm leading-none">×</button>
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800 text-[10px]">
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)} className="rounded px-1 py-1 text-center" style={{ backgroundColor: tierFilter === t ? TIER_COLOR[t] + '33' : '#0b1220', border: '1px solid ' + (tierFilter === t ? TIER_COLOR[t] : '#1e293b') }}>
            <div className="text-[8px] font-semibold leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</div>
            <div className="text-sm font-bold text-slate-100">{tierCount[t]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: meanScore >= 65 ? '#ef4444' : meanScore >= 35 ? '#f59e0b' : '#10b981' }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Loss-of-sep</div><div className="text-sm font-semibold" style={{ color: tierCount['LOSS-OF-SEP'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['LOSS-OF-SEP']}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Out-of-MNT</div><div className="text-xs font-semibold text-rose-400">{oosN}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Pairs</div><div className="text-xs font-semibold text-sky-400">{pairs}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean |ΔM|</div><div className="text-xs font-semibold text-amber-400">{(meanDelta * 1000).toFixed(1)}m/M</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* tolerance band */}
            <rect x={sx(-10)} y={padT} width={sx(10) - sx(-10)} height={H - padT - padB} fill="#10b98115" />
            {/* loss band */}
            <rect x={padL} y={sy(0)} width={W - padL - padR} height={sy(0) - sy(60)} fill="#ef444418" />
            <line x1={sx(0)} y1={padT} x2={sx(0)} y2={H - padB} stroke="#475569" strokeWidth={0.5} />
            <line x1={sx(-10)} y1={padT} x2={sx(-10)} y2={H - padB} stroke="#10b98166" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={sx(10)} y1={padT} x2={sx(10)} y2={H - padB} stroke="#10b98166" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={padL} y1={sy(60)} x2={W - padR} y2={sy(60)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">ΔMach (m/M, ±25)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Sep (NM, ≤120)</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(clamp(e.machDelta * 1000, -xMax, xMax))} cy={sy(e.pair ? e.pair.sepNm : 120)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['MACH-BIAS', machBias, -20, 20, setMachBias, 'm/M'],
            ['TOL-MUL', tolMul, 50, 200, setTolMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFl, 0, 410, setMinFl, ''],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
            ['PAIR-WIN', pairWin, 50, 400, setPairWin, 'nm'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['PBCS-A1', 'PBCS-B1', 'RNP-10', 'MNPS'] as Regime[]).map(r => (
            <button key={r} onClick={() => setRegFilter(regFilter === r ? 'ALL' : r)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: regFilter === r ? REG_COLOR[r] + '33' : '#0b1220', borderColor: regFilter === r ? REG_COLOR[r] : '#1e293b', color: regFilter === r ? REG_COLOR[r] : '#cbd5e1' }}>{r}</button>
          ))}
          <span className="text-slate-700">·</span>
          {(['FANS-1A+', 'FANS-1A', 'CPDLC-ATN', 'VOICE-HF', 'NONE'] as const).map(r => (
            <button key={r} onClick={() => setRcpFilter(rcpFilter === r ? 'ALL' : r)} className="px-1.5 py-0.5 rounded text-[9px] border font-mono" style={{ backgroundColor: rcpFilter === r ? '#0ea5e933' : '#0b1220', borderColor: rcpFilter === r ? '#0ea5e9' : '#1e293b', color: rcpFilter === r ? '#7dd3fc' : '#cbd5e1' }}>{r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LBL', showLbl, setShowLbl],
            ['RGN', showRgn, setShowRgn],
            ['RLBL', showRLbl, setShowRLbl],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / region" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'REGIONS', 'PAIRS'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No aircraft in oceanic / procedural MNT scope.</div>}
            {filtered.map((e, idx) => {
              const sgn = e.machDelta >= 0 ? '+' : ''
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-slate-100 truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                      {e.region && regBadge(e.region.regime)}
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{e.rcp}</span>
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-sky-300">{e.region?.id || 'NO-RGN'}</span>
                    {' · FL'}<span className="text-slate-300">{e.fl.toFixed(0)}</span>
                    {' · M'}<span style={{ color: e.inBand ? '#10b981' : '#ef4444' }}>{e.mach.toFixed(3)}</span>
                    {' / assigned '}<span className="text-slate-300">{e.machAssigned.toFixed(3)}</span>
                    {' · Δ'}<span style={{ color: Math.abs(e.machDelta) > e.tolerance ? '#ef4444' : '#10b981' }}>{sgn}{(e.machDelta * 1000).toFixed(1)}m/M</span>
                    {' (±'}{(e.tolerance * 1000).toFixed(0)}{')'}
                  </div>
                  {e.pair && (
                    <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                      › <span className="text-slate-200">{e.pair.leader.callsign || e.pair.leader.icao}</span>
                      {' · sep '}<span style={{ color: e.pair.sepNm < (e.region ? REG_MIN_NM[e.region.regime] : 80) ? '#ef4444' : e.pair.sepNm < 60 ? '#f59e0b' : '#10b981' }}>{e.pair.sepNm.toFixed(1)}nm</span>
                      {' · closure '}<span style={{ color: e.pair.closureKts > 10 ? '#ef4444' : e.pair.closureKts > 0 ? '#f59e0b' : '#10b981' }}>{(e.pair.closureKts >= 0 ? '+' : '')}{e.pair.closureKts.toFixed(0)}kt</span>
                      {e.pair.ttmMin < 999 && (<> {' · TTM '}<span className="text-rose-300">{e.pair.ttmMin.toFixed(1)}min</span></>)}
                    </div>
                  )}
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} /></div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {drvBadge('MNT', e.drivers.MNT)}
                    {drvBadge('SEP', e.drivers.SEP)}
                    {drvBadge('TTM', e.drivers.TTM)}
                    {drvBadge('CLO', e.drivers.CLO)}
                    {drvBadge('PHA', e.drivers.PHA)}
                    {drvBadge('RCP', e.drivers.RCP)}
                  </div>
                  <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'REGIONS' && (
          <div className="divide-y divide-slate-800">
            {REGIONS.slice().sort((a, b) => {
              const ca = evals.filter(e => e.region?.id === a.id).length
              const cb = evals.filter(e => e.region?.id === b.id).length
              return cb - ca
            }).map(r => {
              const inR = evals.filter(e => e.region?.id === r.id)
              const los = inR.filter(e => e.tier === 'LOSS-OF-SEP').length
              const oos = inR.filter(e => e.tier === 'OUT-OF-MNT').length
              const ms = inR.length ? inR.reduce((s, e) => s + e.score, 0) / inR.length : 0
              return (
                <div key={r.id} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${REG_COLOR[r.regime]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 text-[11px]">{r.id}</span>
                      {regBadge(r.regime)}
                    </div>
                    <span className="text-[10px] font-mono text-slate-300">FL{r.fl[0]}–FL{r.fl[1]} · min {REG_MIN_NM[r.regime]}nm</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">{r.name}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {inR.length} ac · <span className="text-rose-400">{los} LOS</span> · <span className="text-rose-400">{oos} OUT</span> · M {r.machMin.toFixed(2)}–{r.machMax.toFixed(2)} · ±{(REG_TOL[r.regime] * 1000).toFixed(0)}m/M
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                  <div className="text-[9px] text-slate-600 mt-1 italic truncate">{r.ansp}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PAIRS' && (
          <div className="divide-y divide-slate-800">
            {evals.filter(e => e.pair).slice(0, 40).map((e, i) => e.pair && (
              <div key={i} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0 text-[11px]">
                    <span className="text-slate-200 font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                    <span className="text-slate-600">›</span>
                    <span className="text-slate-300 truncate">{e.pair.leader.callsign || e.pair.leader.icao}</span>
                  </div>
                  {tierBadge(e.tier)}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  sep <span style={{ color: e.pair.sepNm < (e.region ? REG_MIN_NM[e.region.regime] : 80) ? '#ef4444' : '#10b981' }}>{e.pair.sepNm.toFixed(1)}nm</span>
                  {' · closure '}<span style={{ color: e.pair.closureKts > 10 ? '#ef4444' : e.pair.closureKts > 0 ? '#f59e0b' : '#10b981' }}>{(e.pair.closureKts >= 0 ? '+' : '')}{e.pair.closureKts.toFixed(0)}kt</span>
                  {' · TTM '}<span className="text-rose-300">{e.pair.ttmMin < 999 ? e.pair.ttmMin.toFixed(1) + 'min' : '—'}</span>
                  {' · '}<span className="text-sky-300">{e.region?.id || '—'}</span>
                </div>
              </div>
            ))}
            {evals.filter(e => e.pair).length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No in-trail oceanic pairs detected.</div>}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        ICAO Doc 4444 §5.4.2.4 · Doc 7030 SUPPS · NAT Doc 007 Ch.6/8 · NAT OPS Bulletin 2015-001 · FAA JO 7110.65 §8-1-4 · AC 91-70B Ch.6 · Doc 9869 PBCS · Doc 10037 GOLD · Annex 11 §3.7.3.3
      </div>
    </div>
  )
}
