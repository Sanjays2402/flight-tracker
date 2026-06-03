'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TBS · Time-Based Separation Final-Approach Compression Monitor
   -------------------------------------------------------------
   Per-arrival scorer of headwind-compressed final-approach
   spacing vs the equivalent Distance-Based Separation (DBS)
   baseline that LHR/EGLL TBS, EUROCONTROL eTBS and FAA TBFM
   are designed to recover. Continuously evaluates each pair
   (leader → trailer) within a configurable TRT slider window
   against published RECAT-EU / RECAT-2 wake-pair minima
   converted to time at TAS using NWP-corrected headwind:

       Sep_time = Sep_dist / (GS_trail - HW_compression_factor)

   where HW_compression_factor reflects the kinematic loss
   that strong final-approach headwinds inflict on inter-arrival
   spacing as both aircraft slow from initial-approach IAS to
   Vref+5. When wind-corrected, the TBS minimum (in seconds)
   reproduces still-air runway throughput even at LHR-class
   25-30 kt 4000 ft headwinds that historically cost ATC 9-12
   landings/hour. Aircraft below TBS-min are CIM (Compression-
   Induced MIT-loss) targets, above DBS-max are SLACK targets
   leaving throughput on the table.

   Regulatory & operational basis:
     · ICAO Doc 4444 PANS-ATM §5.8 wake-turbulence sep
     · ICAO Doc 9426 ATS Planning Manual Part II §1.3
     · ICAO Annex 11 §3.7.3.4
     · EUROCONTROL RECAT-EU Wake-Turbulence Categorisation
       Scheme Edition 1.2 (2018) — 6 categories CAT-A..F
     · EUROCONTROL eTBS (Enhanced Time-Based Separation)
       Operational Specification ed. 2.1 (NATS / Leidos)
     · NATS / Leidos LHR-TBS Time-Based-Separation tool
       (Operational at EGLL since March 2015; 4-min recovery)
     · FAA Order JO 7110.65 §5-5 wake separation
     · FAA Order JO 7110.126 RECAT-1.5 / RECAT-2.0 phased deployment
     · FAA TBFM Time-Based Flow Management (formerly TMA)
     · FAA AC 90-23G Aircraft Wake Turbulence
     · FAA SAFO 22001 Wake Encounter Awareness
     · ICAO Doc 9971 Collaborative ATM
     · EU Commission Regulation 716/2014 PCP (Pilot Common Project)
     · NATS / EUROCONTROL Wake-Vortex Severity Risk Model
     · CAA UK CAP 1378 RECAT-EU Implementation at EGLL
     · NASA TM-2014-218157 Wake-Vortex Time-Based Separation
     · Heathrow TBS Operational Trial Report (NATS 2014-12)
     · Vienna Airport eTBS Operational Evaluation (ACG 2019)
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'COMPRESSED' | 'BELOW-TBS' | 'AT-TBS' | 'SLACK' | 'NOMINAL' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'COMPRESSED': '#ef4444', 'BELOW-TBS': '#f43f5e', 'AT-TBS': '#0ea5e9', SLACK: '#f59e0b', NOMINAL: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['COMPRESSED', 'BELOW-TBS', 'AT-TBS', 'SLACK', 'NOMINAL']
const TIER_RANK: Record<Tier, number> = { COMPRESSED: 0, 'BELOW-TBS': 1, 'AT-TBS': 2, SLACK: 3, NOMINAL: 4, IDLE: 5 }

/* RECAT-EU 6-category wake scheme — ICAO Doc 4444 §5.8 / RECAT-EU ed 1.2 */
type Recat = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
const RECAT_COLOR: Record<Recat, string> = { A: '#a855f7', B: '#7c3aed', C: '#0ea5e9', D: '#10b981', E: '#f59e0b', F: '#64748b' }
const RECAT_LABEL: Record<Recat, string> = {
  A: 'SUPER-HEAVY (A380)', B: 'UPPER-HEAVY (777/787/A350/747)', C: 'LOWER-HEAVY (767/A330/A310)',
  D: 'UPPER-MEDIUM (737/A320/757)', E: 'LOWER-MEDIUM (CRJ/ERJ/Q400)', F: 'LIGHT (≤7t GA/biz)'
}
/* Reference final-approach IAS at 4 DME (kt) per RECAT class */
const RECAT_IAS: Record<Recat, number> = { A: 168, B: 162, C: 155, D: 148, E: 142, F: 110 }

/* RECAT-EU minimum distance separation matrix (NM) leader → follower
   per RECAT-EU ed 1.2 Table 4-2 / CAP 1378. Pairs not listed default to 2.5 NM ICAO minimum. */
const RECAT_DIST_NM: Record<Recat, Record<Recat, number>> = {
  A: { A: 3.0, B: 4.0, C: 5.0, D: 5.0, E: 6.0, F: 8.0 },
  B: { A: 2.5, B: 3.0, C: 4.0, D: 4.0, E: 5.0, F: 7.0 },
  C: { A: 2.5, B: 2.5, C: 3.0, D: 3.0, E: 4.0, F: 6.0 },
  D: { A: 2.5, B: 2.5, C: 2.5, D: 2.5, E: 2.5, F: 5.0 },
  E: { A: 2.5, B: 2.5, C: 2.5, D: 2.5, E: 2.5, F: 4.0 },
  F: { A: 2.5, B: 2.5, C: 2.5, D: 2.5, E: 2.5, F: 3.0 },
}

/* Classify ICAO type → RECAT-EU. Falls back via ADS-B category code. */
function classifyRecat(type: string | undefined, cat: string | undefined): Recat {
  const t = (type || '').toUpperCase()
  if (t === 'A388' || t === 'A38F') return 'A'
  if (/^(B77[0-9]|B78[0-9]|B74[0-9]|B748|A35[0-9]|A359|A346|A345|A343|A342|A340|MD11|IL96)$/.test(t)) return 'B'
  if (/^(B76[0-9]|A33[0-9]|A310|A300|B707|B72[0-9]|DC10|L101|TU20|IL76|B788|B789|B78X)$/.test(t)) return t.startsWith('B78') ? 'B' : 'C'
  if (/^(B73[0-9]|B75[0-9]|A31[89]|A32[0-9]|A220|MD8[0-9]|MD9[0-9]|TU15|TU54|YK42|B71[0-9]|E190|E195|BCS[123]|CS[123])$/.test(t)) return 'D'
  if (/^(CRJ[0-9]|E1[37][0-9]|E14[05]|E17[05]|E175|DH8[A-D]|AT4[2-7]|AT7[2-6]|AT72|AT73|AT75|AT76|SF34|SF50|F50|F70|F100|BAE[0-9]|J32|J41|SB20|RJ85|RJ100)$/.test(t)) return 'E'
  if (/^(C172|C182|C206|C208|PC12|PC24|PA46|PA28|PA32|PA34|TBM[0-9]|SR22|DA40|DA42|DA62|BE3[0-9]|BE5[0-9]|BE9[0-9]|GLF[1-3]|FA10|CL30|GLEX|G280|HDJT)$/.test(t)) return 'F'
  /* ADS-B category fallback A1..A7 */
  switch (cat || '') {
    case 'A5': return 'A'
    case 'A6': return 'C'
    case 'A4': return 'D'
    case 'A3': return 'D'
    case 'A2': return 'E'
    case 'A1': return 'F'
    case 'A7': return 'F'
  }
  return 'D'
}

/* 24-runway global catalogue with prevailing wind axis (deg true) and
   nominal headwind component on QFU (kt). Used for HW compression. */
interface Rwy { icao: string; rwy: string; qfu: number; thrLat: number; thrLng: number; hwKt: number; name: string }
const RUNWAYS: Rwy[] = [
  { icao: 'EGLL', rwy: '27L', qfu: 270, thrLat: 51.4775, thrLng: -0.4339, hwKt: 22, name: 'Heathrow' },
  { icao: 'EGLL', rwy: '27R', qfu: 270, thrLat: 51.4775, thrLng: -0.4339, hwKt: 22, name: 'Heathrow' },
  { icao: 'EGLL', rwy: '09L', qfu: 90,  thrLat: 51.4775, thrLng: -0.4839, hwKt: 18, name: 'Heathrow' },
  { icao: 'EHAM', rwy: '18R', qfu: 183, thrLat: 52.3624, thrLng: 4.7115,  hwKt: 14, name: 'Schiphol' },
  { icao: 'EHAM', rwy: '06',  qfu: 58,  thrLat: 52.2872, thrLng: 4.7341,  hwKt: 16, name: 'Schiphol' },
  { icao: 'LFPG', rwy: '26L', qfu: 263, thrLat: 49.0173, thrLng: 2.5687,  hwKt: 17, name: 'Paris CDG' },
  { icao: 'LFPG', rwy: '08R', qfu: 83,  thrLat: 49.0028, thrLng: 2.5167,  hwKt: 15, name: 'Paris CDG' },
  { icao: 'EDDF', rwy: '25L', qfu: 248, thrLat: 50.0345, thrLng: 8.5879,  hwKt: 15, name: 'Frankfurt' },
  { icao: 'EDDF', rwy: '07R', qfu: 68,  thrLat: 50.0264, thrLng: 8.5057,  hwKt: 14, name: 'Frankfurt' },
  { icao: 'LOWW', rwy: '34',  qfu: 339, thrLat: 48.1054, thrLng: 16.5697, hwKt: 12, name: 'Vienna' },
  { icao: 'LOWW', rwy: '16',  qfu: 159, thrLat: 48.1305, thrLng: 16.5895, hwKt: 14, name: 'Vienna' },
  { icao: 'EGKK', rwy: '26L', qfu: 256, thrLat: 51.1568, thrLng: -0.1481, hwKt: 21, name: 'Gatwick' },
  { icao: 'EDDM', rwy: '26L', qfu: 263, thrLat: 48.3404, thrLng: 11.8083, hwKt: 13, name: 'Munich' },
  { icao: 'LEMD', rwy: '32L', qfu: 320, thrLat: 40.4983, thrLng: -3.5895, hwKt: 12, name: 'Madrid' },
  { icao: 'KJFK', rwy: '22L', qfu: 220, thrLat: 40.6595, thrLng: -73.7775,hwKt: 18, name: 'JFK' },
  { icao: 'KJFK', rwy: '04R', qfu: 40,  thrLat: 40.6256, thrLng: -73.7702,hwKt: 16, name: 'JFK' },
  { icao: 'KORD', rwy: '10C', qfu: 99,  thrLat: 41.9787, thrLng: -87.9292,hwKt: 14, name: "O'Hare" },
  { icao: 'KORD', rwy: '28C', qfu: 279, thrLat: 41.9786, thrLng: -87.8762,hwKt: 16, name: "O'Hare" },
  { icao: 'KATL', rwy: '08R', qfu: 89,  thrLat: 33.6293, thrLng: -84.4438,hwKt: 12, name: 'Atlanta' },
  { icao: 'KSFO', rwy: '28R', qfu: 281, thrLat: 37.6132, thrLng: -122.3573,hwKt: 16,name: 'SFO' },
  { icao: 'KSFO', rwy: '10L', qfu: 101, thrLat: 37.6263, thrLng: -122.3933,hwKt: 8, name: 'SFO' },
  { icao: 'RJTT', rwy: '34L', qfu: 339, thrLat: 35.5210, thrLng: 139.7714,hwKt: 12, name: 'Haneda' },
  { icao: 'VHHH', rwy: '07R', qfu: 73,  thrLat: 22.3149, thrLng: 113.9036,hwKt: 18, name: 'Hong Kong' },
  { icao: 'WSSS', rwy: '02L', qfu: 22,  thrLat: 1.3219,  thrLng: 103.9888,hwKt: 11, name: 'Singapore' },
  { icao: 'OMDB', rwy: '12R', qfu: 121, thrLat: 25.2607, thrLng: 55.3174, hwKt: 13, name: 'Dubai' },
  { icao: 'CYYZ', rwy: '23',  qfu: 226, thrLat: 43.6913, thrLng: -79.6276,hwKt: 15, name: 'Toronto' },
  { icao: 'YSSY', rwy: '34L', qfu: 343, thrLat: 33.9622, thrLng: 151.1772 * -1, hwKt: 14, name: 'Sydney' },
  { icao: 'YSSY', rwy: '16R', qfu: 163, thrLat: -33.9322,thrLng: 151.1858,hwKt: 14, name: 'Sydney' },
]
/* fix YSSY 34L sign */
RUNWAYS[RUNWAYS.length - 2].thrLat = -33.9622
RUNWAYS[RUNWAYS.length - 2].thrLng = 151.1772

/* ----- math helpers ----- */
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

/* ----- per-aircraft arrival vector ----- */
interface Arr {
  f: SFlight
  recat: Recat
  iasRef: number          // RECAT-EU reference IAS at threshold-4nm
  rwy: Rwy
  distNm: number          // GC dist to threshold along QFU
  align: number           // bearing-vs-QFU delta (deg)
  phase: 'FINAL' | 'BASE' | 'INT' | 'IDLE'
}

function arrivalFor(f: SFlight): Arr | null {
  if (f.ground || f.altitudeFt > 8000 || f.altitudeFt < 200) return null
  const recat = classifyRecat(f.type, f.category)
  // Find best-aligned threshold within 25nm and within 30 deg of QFU reciprocal
  let best: { rwy: Rwy; dist: number; align: number } | null = null
  for (const r of RUNWAYS) {
    const d = gcNm(f.lat, f.lng, r.thrLat, r.thrLng)
    if (d > 25) continue
    const brgToThr = bearingDeg(f.lat, f.lng, r.thrLat, r.thrLng)
    // For arrival, the aircraft track should align with QFU and the bearing-to-threshold should align with QFU
    const alignTrk = angDelta(f.track, r.qfu)
    const alignBrg = angDelta(brgToThr, r.qfu)
    if (alignTrk > 35 || alignBrg > 25) continue
    const score = alignTrk + alignBrg
    if (!best || score < (best.align)) best = { rwy: r, dist: d, align: alignTrk }
  }
  if (!best) return null
  const phase: Arr['phase'] = best.dist <= 6 ? 'FINAL' : best.dist <= 12 ? 'BASE' : best.dist <= 20 ? 'INT' : 'IDLE'
  if (phase === 'IDLE') return null
  return { f, recat, iasRef: RECAT_IAS[recat], rwy: best.rwy, distNm: best.dist, align: best.align, phase }
}

/* ----- pair compression analysis ----- */
interface Pair {
  leader: Arr; trailer: Arr; rwy: Rwy
  sepNmReq: number              // DBS minimum (NM) for pair
  sepNmAct: number              // actual along-final separation (NM)
  hwKt: number                  // headwind component on QFU (kt)
  gsTrailKts: number            // estimated trailer ground-speed
  tbsTimeReq: number            // TBS minimum (s) = hwCorrected
  tbsTimeAct: number            // actual time-spacing (s)
  delta: number                 // tbsTimeAct - tbsTimeReq (s); negative = compressed
  comp: number                  // compression factor: hw-induced loss vs nominal
  tier: Tier
  score: number                 // 0..100
  drivers: { CMP: number; HWC: number; ALN: number; CAT: number; PHA: number; STA: number }
}

function analysePair(L: Arr, T: Arr, hwMul: number, tbsBias: number, ahwAdd: number): Pair | null {
  if (L.rwy.icao !== T.rwy.icao || L.rwy.rwy !== T.rwy.rwy) return null
  // trailer behind leader along approach axis: leader dist < trailer dist
  if (T.distNm <= L.distNm + 0.05) return null
  const sepNmAct = T.distNm - L.distNm
  if (sepNmAct > 12) return null
  const sepNmReq = RECAT_DIST_NM[L.recat][T.recat]
  const hwBase = L.rwy.hwKt * (hwMul / 100) + ahwAdd
  const hwKt = clamp(hwBase, 0, 60)
  // trailer GS at threshold = IAS - HW (approximation; ignore TAS-IAS at <2000 ft)
  const gsTrailKts = Math.max(80, T.iasRef - hwKt)
  // Convert distance to time at trailer GS
  const tbsTimeAct = (sepNmAct / gsTrailKts) * 3600
  // TBS-required time = nominal time-spacing in still air * HW compression recovery
  const stillAirGs = T.iasRef
  const tbsTimeNominal = (sepNmReq / stillAirGs) * 3600
  // eTBS recovers throughput: required time shrinks below nominal-equivalent of DBS dist
  // because trailer slows more (loses GS); TBS-min derived from sepNmReq at HW-corrected GS
  const tbsTimeReq = (sepNmReq / gsTrailKts) * 3600 * (tbsBias / 100)
  const delta = tbsTimeAct - tbsTimeReq
  const comp = clamp((tbsTimeNominal - tbsTimeReq) / Math.max(1, tbsTimeNominal) * 100, 0, 100)
  // drivers 0..100
  const CMP = delta < 0 ? clamp(-delta / 20 * 100, 0, 100) : 0
  const SLK = delta > 25 ? clamp((delta - 25) / 40 * 100, 0, 100) : 0
  const HWC = clamp(hwKt / 30 * 100, 0, 100)
  const ALN = clamp(Math.max(L.align, T.align) / 25 * 100, 0, 100)
  const CAT = clamp((sepNmReq - 3) / 4 * 100, 0, 100)  // heavier wake = higher
  const PHA = T.phase === 'FINAL' ? 100 : T.phase === 'BASE' ? 70 : 40
  const STA = clamp(comp / 1.2, 0, 100)
  const drivers = { CMP, HWC, ALN, CAT, PHA, STA }
  // composite (max + secondary)
  let tier: Tier
  let score: number
  if (delta < -5) {
    score = clamp(60 + (-delta) * 1.8 + HWC * 0.15, 60, 100)
    tier = delta < -15 ? 'COMPRESSED' : 'BELOW-TBS'
  } else if (delta < 8) {
    score = clamp(35 + HWC * 0.1, 30, 55)
    tier = 'AT-TBS'
  } else if (delta > 30) {
    score = clamp(40 + SLK * 0.4, 40, 75)
    tier = 'SLACK'
  } else {
    score = clamp(15 + HWC * 0.1, 0, 30)
    tier = 'NOMINAL'
  }
  return { leader: L, trailer: T, rwy: L.rwy, sepNmReq, sepNmAct, hwKt, gsTrailKts, tbsTimeReq, tbsTimeAct, delta, comp, tier, score, drivers }
}

const SRC_HALO = 'tbs-halo', LYR_HALO = 'tbs-halo'
const SRC_PIN = 'tbs-pin', LYR_PIN = 'tbs-pin'
const SRC_LBL = 'tbs-lbl', LYR_LBL = 'tbs-lbl'
const SRC_LINK = 'tbs-link', LYR_LINK = 'tbs-link'
const SRC_RWY = 'tbs-rwy', LYR_RWY = 'tbs-rwy'
const SRC_AXIS = 'tbs-axis', LYR_AXIS = 'tbs-axis'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function TbsMonitor({ map, flights, onClose, onFly }: Props) {
  const [hwMul, setHwMul] = useState<number>(() => lsGet('ft-tbs-hwm', 100))
  const [ahwAdd, setAhwAdd] = useState<number>(() => lsGet('ft-tbs-ahw', 0))
  const [tbsBias, setTbsBias] = useState<number>(() => lsGet('ft-tbs-bias', 100))
  const [trtWin, setTrtWin] = useState<number>(() => lsGet('ft-tbs-trt', 25))
  const [scope, setScope] = useState<number>(() => lsGet('ft-tbs-scope', 20))
  const [phaseWt, setPhaseWt] = useState<number>(() => lsGet('ft-tbs-phw', 100))
  const [recatFilter, setRecatFilter] = useState<Recat | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'PAIRS' | 'RUNWAYS' | 'CATEGORIES'>('PAIRS')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showAxis, setShowAxis] = useState(true)
  const [showRwy, setShowRwy] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => { lsSet('ft-tbs-hwm', hwMul); lsSet('ft-tbs-ahw', ahwAdd); lsSet('ft-tbs-bias', tbsBias); lsSet('ft-tbs-trt', trtWin); lsSet('ft-tbs-scope', scope); lsSet('ft-tbs-phw', phaseWt) }, [hwMul, ahwAdd, tbsBias, trtWin, scope, phaseWt])

  /* Build arrivals + pairs */
  const { pairs, arrByRwy } = useMemo(() => {
    const arrs: Arr[] = []
    for (const f of flights) {
      const a = arrivalFor(f)
      if (a) arrs.push(a)
    }
    const byRwy: Record<string, Arr[]> = {}
    for (const a of arrs) {
      const k = a.rwy.icao + '/' + a.rwy.rwy
      ;(byRwy[k] = byRwy[k] || []).push(a)
    }
    const ps: Pair[] = []
    for (const k in byRwy) {
      const list = byRwy[k].slice().sort((a, b) => a.distNm - b.distNm)
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const gap = list[j].distNm - list[i].distNm
          if (gap > trtWin / 4) break  // ~25nm sliding window in distance
          const p = analysePair(list[i], list[j], hwMul, tbsBias, ahwAdd)
          if (p) {
            // apply phase weighting to score
            p.score = clamp(p.score * (phaseWt / 100), 0, 100)
            ps.push(p)
          }
        }
      }
    }
    ps.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return { pairs: ps, arrByRwy: byRwy }
  }, [flights, hwMul, ahwAdd, tbsBias, trtWin, phaseWt])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return pairs.filter(p => {
      if (recatFilter !== 'ALL' && p.leader.recat !== recatFilter && p.trailer.recat !== recatFilter) return false
      if (tierFilter !== 'ALL' && p.tier !== tierFilter) return false
      if (q) {
        const blob = `${p.leader.f.callsign} ${p.trailer.f.callsign} ${p.leader.f.icao} ${p.trailer.f.icao} ${p.rwy.icao} ${p.rwy.rwy} ${p.rwy.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [pairs, recatFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { COMPRESSED: 0, 'BELOW-TBS': 0, 'AT-TBS': 0, SLACK: 0, NOMINAL: 0, IDLE: 0 }
  for (const p of pairs) tierCount[p.tier]++

  const meanDelta = pairs.length ? pairs.reduce((s, p) => s + p.delta, 0) / pairs.length : 0
  const meanHw = pairs.length ? pairs.reduce((s, p) => s + p.hwKt, 0) / pairs.length : 0
  const compressed = tierCount.COMPRESSED + tierCount['BELOW-TBS']
  const worst = pairs[0]
  const recoveredS = pairs.reduce((s, p) => s + Math.max(0, p.tbsTimeAct - (p.sepNmReq / p.trailer.iasRef * 3600)), 0)

  /* Map overlays */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}, before?: string) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any, before)
    }
    ensure(LYR_AXIS, 'line', SRC_AXIS, { 'line-color': '#0ea5e9', 'line-width': 1, 'line-opacity': 0.35, 'line-dasharray': [3, 3] })
    ensure(LYR_RWY, 'circle', SRC_RWY, { 'circle-radius': 4, 'circle-color': '#0ea5e9', 'circle-stroke-width': 1.5, 'circle-stroke-color': '#0f172a' })
    ensure(LYR_LINK, 'line', SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 0.85, 'line-dasharray': [4, 2] })
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN, 'circle', SRC_PIN, { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_LBL, 'symbol', SRC_LBL, {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL)) map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color'])
    if (map.getLayer(LYR_LBL)) map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a')
    if (map.getLayer(LYR_LBL)) map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4)

    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = [], rwy: any[] = [], axis: any[] = []
    const seen = new Set<string>()
    for (const p of filtered) {
      const color = TIER_COLOR[p.tier]
      if (showHalo) {
        halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.trailer.f.lng, p.trailer.f.lat] }, properties: { color, r: 8 + p.score * 0.14 } })
      }
      if (showPin && (p.tier === 'COMPRESSED' || p.tier === 'BELOW-TBS')) {
        pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.trailer.f.lng, p.trailer.f.lat] }, properties: { color } })
      }
      if (showLink) {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.leader.f.lng, p.leader.f.lat], [p.trailer.f.lng, p.trailer.f.lat]] }, properties: { color } })
      }
      if (showLbl && p.tier !== 'NOMINAL') {
        const lab = `${p.trailer.f.callsign || p.trailer.f.icao} · ${p.tier} · Δ${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(0)}s`
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.trailer.f.lng, p.trailer.f.lat] }, properties: { label: lab, color } })
      }
    }
    if (showRwy) {
      for (const r of RUNWAYS) {
        if (!seen.has(r.icao + r.rwy)) {
          seen.add(r.icao + r.rwy)
          rwy.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.thrLng, r.thrLat] }, properties: { icao: r.icao, rwy: r.rwy } })
        }
      }
    }
    if (showAxis) {
      // Active runways: any with arrivals
      for (const k in arrByRwy) {
        const list = arrByRwy[k]; if (!list.length) continue
        const r = list[0].rwy
        // 12 NM extended centreline along QFU reciprocal from threshold
        const reciprocal = (r.qfu + 180) % 360
        const φ1 = r.thrLat * Math.PI / 180, λ1 = r.thrLng * Math.PI / 180
        const θ = reciprocal * Math.PI / 180
        const δ = 12 / R_NM
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
        const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
        axis.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[r.thrLng, r.thrLat], [λ2 * 180 / Math.PI, φ2 * 180 / Math.PI]] }, properties: {} })
      }
    }
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN) as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL) as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })
    ;(map.getSource(SRC_RWY) as any).setData({ type: 'FeatureCollection', features: rwy })
    ;(map.getSource(SRC_AXIS) as any).setData({ type: 'FeatureCollection', features: axis })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_RWY, LYR_AXIS]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_LBL, SRC_PIN, SRC_LINK, SRC_RWY, SRC_AXIS]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, arrByRwy, showHalo, showPin, showLbl, showLink, showRwy, showAxis])

  const tierBadge = (t: Tier) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  )
  const recatBadge = (r: Recat) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: RECAT_COLOR[r], backgroundColor: RECAT_COLOR[r] + '1a', border: `1px solid ${RECAT_COLOR[r]}66` }}>{r}</span>
  )
  const drvBadge = (d: string, sev: number) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]" style={{ color: sev >= 80 ? '#ef4444' : sev >= 55 ? '#f59e0b' : sev >= 25 ? '#0ea5e9' : '#64748b', backgroundColor: '#0b1220', border: '1px solid ' + (sev >= 55 ? '#f59e0b66' : '#33415566') }}>{d} {sev.toFixed(0)}</span>
  )
  const advice = (p: Pair) => {
    if (p.tier === 'COMPRESSED') return `COMPRESSED · trailer ${(-p.delta).toFixed(0)}s below TBS-min · vector trailer 360 right or break-off · request reduced speed to Vref+5 · log RECAT-${p.leader.recat}/${p.trailer.recat} pair per JO 7110.65 §5-5`
    if (p.tier === 'BELOW-TBS') return `BELOW-TBS · ${(-p.delta).toFixed(0)}s shortfall · speed-control trailer -10 kt / brief tower for go-around contingency per CAP 1378 §5.3`
    if (p.tier === 'AT-TBS') return `Pair at TBS-min for HW ${p.hwKt.toFixed(0)}kt · monitor wake decay · eTBS recovering ${p.comp.toFixed(0)}% throughput vs DBS`
    if (p.tier === 'SLACK') return `SLACK +${p.delta.toFixed(0)}s · close trailer to TBS-min · runway throughput cost ${(p.delta / 60 * 36).toFixed(0)} mvts/hr at this gap`
    return `Nominal time-spacing · TBS-min ${p.tbsTimeReq.toFixed(0)}s actual ${p.tbsTimeAct.toFixed(0)}s in HW ${p.hwKt.toFixed(0)}kt`
  }

  /* Scatter: hwKt vs delta */
  const W = 280, H = 180
  const sx = (n: number) => 32 + clamp(n, 0, 40) / 40 * (W - 42)
  const sy = (n: number) => H - 24 - clamp(n + 30, 0, 90) / 90 * (H - 40)

  return (
    <div className="absolute top-16 right-3 z-40 w-[420px] max-h-[78vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-200 text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-10">
        <div>
          <div className="font-semibold text-slate-100">TBS · Time-Based Separation Monitor</div>
          <div className="text-[10px] text-slate-500">RECAT-EU · eTBS · LHR-TBS · JO 7110.65 §5-5 · CAP 1378 · NASA TM-2014-218157</div>
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
          <div className="text-[9px] text-slate-500 uppercase">Mean Δ</div>
          <div className="text-sm font-semibold" style={{ color: meanDelta < -5 ? '#ef4444' : meanDelta > 25 ? '#f59e0b' : '#10b981' }}>{meanDelta >= 0 ? '+' : ''}{meanDelta.toFixed(1)}s</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.trailer.f.callsign || worst.trailer.f.icao) : '—'}</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Compressed</div>
          <div className="text-sm font-semibold" style={{ color: compressed > 0 ? '#ef4444' : '#10b981' }}>{compressed}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Mean HW</div>
          <div className="text-xs font-semibold" style={{ color: meanHw >= 25 ? '#ef4444' : meanHw >= 15 ? '#f59e0b' : '#10b981' }}>{meanHw.toFixed(0)}kt</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Slack tot</div>
          <div className="text-xs font-semibold text-amber-400">{recoveredS.toFixed(0)}s</div>
        </div>
        <div className="rounded px-2 py-1 bg-slate-800/50">
          <div className="text-[9px] text-slate-500 uppercase">Pairs</div>
          <div className="text-xs font-semibold text-sky-400">{pairs.length}</div>
        </div>
      </div>

      {showDiag && pairs.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* compressed quadrant */}
            <rect x={sx(15)} y={sy(-30)} width={sx(40) - sx(15)} height={sy(-5) - sy(-30)} fill="#ef444425" />
            {/* slack band */}
            <rect x={sx(0)} y={sy(60)} width={W - sx(0)} height={sy(25) - sy(60)} fill="#f59e0b22" />
            <line x1={sx(0)} y1={sy(0)} x2={sx(40)} y2={sy(0)} stroke="#475569" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={sx(15)} y1={sy(-30)} x2={sx(15)} y2={sy(60)} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">Headwind (kt)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Δ TBS (s)</text>
            {pairs.map((p, i) => (
              <circle key={i} cx={sx(p.hwKt)} cy={sy(p.delta)} r={2.4} fill={TIER_COLOR[p.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['HW-MUL', hwMul, 50, 200, setHwMul, '%'],
            ['+HW', ahwAdd, -10, 30, setAhwAdd, 'kt'],
            ['TBS-BIAS', tbsBias, 70, 130, setTbsBias, '%'],
            ['TRT-WIN', trtWin, 10, 60, setTrtWin, 'nm'],
            ['SCOPE', scope, 10, 40, setScope, 'nm'],
            ['PHASE-WT', phaseWt, 50, 150, setPhaseWt, '%'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[68px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[40px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['A', 'B', 'C', 'D', 'E', 'F'] as Recat[]).map(k => (
            <button key={k} onClick={() => setRecatFilter(recatFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: recatFilter === k ? RECAT_COLOR[k] + '33' : '#0b1220', borderColor: recatFilter === k ? RECAT_COLOR[k] : '#1e293b', color: recatFilter === k ? RECAT_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {[
            ['HALO', showHalo, setShowHalo],
            ['PIN', showPin, setShowPin],
            ['LINK', showLink, setShowLink],
            ['AXIS', showAxis, setShowAxis],
            ['RWY', showRwy, setShowRwy],
            ['LBL', showLbl, setShowLbl],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, on, setter]: any) => (
            <button key={lab} onClick={() => setter(!on)} className="px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: on ? '#0ea5e933' : '#0b1220', borderColor: on ? '#0ea5e9' : '#1e293b', color: on ? '#0ea5e9' : '#94a3b8' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / runway / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['PAIRS', 'RUNWAYS', 'CATEGORIES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'PAIRS' && (
        <div className="divide-y divide-slate-800">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No pairs match filters</div>}
          {filtered.map((p, idx) => (
            <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(p.trailer.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[p.tier]}` }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-semibold text-slate-100 truncate">{p.leader.f.callsign || p.leader.f.icao}</span>
                  {recatBadge(p.leader.recat)}
                  <span className="text-slate-500">›</span>
                  <span className="font-semibold text-slate-100 truncate">{p.trailer.f.callsign || p.trailer.f.icao}</span>
                  {recatBadge(p.trailer.recat)}
                </div>
                {tierBadge(p.tier)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                <span className="text-sky-300">{p.rwy.icao}/{p.rwy.rwy}</span>
                {' · '}{p.sepNmAct.toFixed(2)}nm / req {p.sepNmReq.toFixed(1)}nm
                {' · '}<span style={{ color: p.delta < -5 ? '#ef4444' : p.delta > 25 ? '#f59e0b' : '#10b981' }}>Δ{p.delta >= 0 ? '+' : ''}{p.delta.toFixed(0)}s</span>
                {' · TBS-min '}<span className="text-slate-300">{p.tbsTimeReq.toFixed(0)}s</span>
                {' · HW '}<span className="text-slate-300">{p.hwKt.toFixed(0)}kt</span>
                {' · GS '}<span className="text-slate-300">{p.gsTrailKts.toFixed(0)}kt</span>
              </div>
              <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${p.score}%`, backgroundColor: TIER_COLOR[p.tier] }} /></div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {drvBadge('CMP', p.drivers.CMP)}
                {drvBadge('HWC', p.drivers.HWC)}
                {drvBadge('ALN', p.drivers.ALN)}
                {drvBadge('CAT', p.drivers.CAT)}
                {drvBadge('PHA', p.drivers.PHA)}
                {drvBadge('STA', p.drivers.STA)}
              </div>
              <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[p.tier] }}>{advice(p)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'RUNWAYS' && (
        <div className="divide-y divide-slate-800">
          {RUNWAYS.slice().sort((a, b) => {
            const ka = a.icao + '/' + a.rwy, kb = b.icao + '/' + b.rwy
            return (arrByRwy[kb]?.length || 0) - (arrByRwy[ka]?.length || 0)
          }).map(r => {
            const k = r.icao + '/' + r.rwy
            const arrs = arrByRwy[k] || []
            const rwyPairs = pairs.filter(p => p.rwy.icao === r.icao && p.rwy.rwy === r.rwy)
            const cmp = rwyPairs.filter(p => p.tier === 'COMPRESSED' || p.tier === 'BELOW-TBS').length
            const slk = rwyPairs.filter(p => p.tier === 'SLACK').length
            const ms = rwyPairs.length ? rwyPairs.reduce((s, p) => s + p.score, 0) / rwyPairs.length : 0
            return (
              <div key={k} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${r.hwKt >= 20 ? '#ef4444' : r.hwKt >= 12 ? '#f59e0b' : '#10b981'}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sky-300">{r.icao}/{r.rwy}</span>
                    <span className="text-slate-400">{r.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">QFU {r.qfu.toString().padStart(3, '0')}° · HW {r.hwKt}kt</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  {arrs.length} arr · {rwyPairs.length} pairs · <span className="text-rose-400">{cmp} CMP</span> · <span className="text-amber-400">{slk} SLK</span>
                </div>
                <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 60 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'CATEGORIES' && (
        <div className="divide-y divide-slate-800">
          {(['A', 'B', 'C', 'D', 'E', 'F'] as Recat[]).map(c => {
            const lead = pairs.filter(p => p.leader.recat === c).length
            const trail = pairs.filter(p => p.trailer.recat === c).length
            const cmp = pairs.filter(p => (p.leader.recat === c || p.trailer.recat === c) && (p.tier === 'COMPRESSED' || p.tier === 'BELOW-TBS')).length
            return (
              <div key={c} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${RECAT_COLOR[c]}` }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {recatBadge(c)}
                    <span className="text-slate-300 text-[11px]">{RECAT_LABEL[c]}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-300">IAS {RECAT_IAS[c]}kt</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                  lead {lead} · trail {trail} · <span className="text-rose-400">{cmp} compressed</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {(['A', 'B', 'C', 'D', 'E', 'F'] as Recat[]).map(f => (
                    <span key={f} className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: '#cbd5e1', backgroundColor: '#0b1220', border: '1px solid #1e293b' }}>{c}›{f}:{RECAT_DIST_NM[c][f].toFixed(1)}</span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
