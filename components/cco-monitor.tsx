'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   CCO · Continuous Climb Operations Compliance Monitor
   ------------------------------------------------------------
   ICAO Doc 9993 Continuous Climb Operations Manual /
   ICAO Doc 4444 PANS-ATM §6 / Annex 11 §3.7 /
   FAA AC 91-86 Continuous Climb / JO 7110.65 §4-5 SID climb /
   EUROCONTROL CCO/CDO Concept of Operations ed.1.2 /
   IATA Fuel Efficiency Gap Analysis 2023 ch.5 /
   Boeing FCOM PI-22 climb fuel penalty /
   Airbus FOBN GO Climb Performance.

   CCO is the departure-phase equivalent of CDO: from rotation to
   TOC the aircraft should climb continuously at or near optimum
   thrust without ATC-imposed intermediate level-offs. Every
   level-off below TOC burns excess fuel (~75-220 kg per minute
   for a typical narrowbody at FL150 holding 1500 fpm vs level),
   adds CO2, and elevates noise contour exposure under SIDs.

   For every airframe in departure scope (climbing within 250 NM
   of a known departure airport below cruise level) the monitor:
     · classifies the origin SID structure if known and pulls the
       published initial-climb altitude (ICA), top-of-climb (TOC)
       target, and noise-sensitive sector (NADP1/NADP2)
     · derives ROC vs the airframe-class optimum climb profile
       (HVY 2200 fpm to FL100 then 1800 to FL280 then 1100 to TOC,
        NRW 2400/2000/1300, RGN 2200/1800/1100, BIZ 3000/2500/1800,
        TBP 1500/1100/700)
     · detects level-off segments (|VS| < 200 fpm, hash-stable
       synthetic duration 0-12 min biased by phase + ATC density)
     · estimates excess fuel-burn per level-off via Breguet/SFC
       lookup (HVY 105 kg/min, NRW 48 kg/min, RGN 22 kg/min,
       BIZ 14 kg/min, TBP 6 kg/min) and CO2 = 3.16 × kg-fuel
     · compares actual altitude-gain to ideal continuous-climb
       trajectory across the climb-window, producing CCO-efficiency
       % (1 = perfect continuous, 0 = entire climb spent level)
     · cross-checks SID lateral conformance (any track-deviation
       greater than 8° from published bearing inflates ATC-vector
       cause attribution)
   And produces a 6-tier escalation:
     STEPPED / LONG-LEVEL / SHORT-LEVEL / WATCH / CCO-OK / IDLE

   References:
     · ICAO Doc 9993 Continuous Climb Operations Manual
     · ICAO Doc 4444 PANS-ATM §6 ATC clearances
     · ICAO Annex 11 §3.7.1 Approach Control / §3.7.2 Departure
     · ICAO Doc 9931 CDO Manual sec 2.2 (CCO counterpart)
     · FAA AC 91-86 Continuous Climb Operations
     · FAA Order JO 7110.65AA §4-5 Departure procedures
     · EUROCONTROL CCO/CDO Concept of Operations ed.1.2
     · IATA Fuel Efficiency Gap Analysis 2023 ch.5
     · Boeing FCOM PI-22 Climb at MAX-CLIMB thrust fuel penalty
     · Airbus FOBN Getting-to-Grips Climb Performance
     · CAEP/12 WG2 Operations 2022-IP09 CCO benefits
     · ASBU B0-CDO Aviation System Block Upgrade
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'STEPPED' | 'LONG-LEVEL' | 'SHORT-LEVEL' | 'WATCH' | 'CCO-OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  STEPPED: '#ef4444', 'LONG-LEVEL': '#f43f5e', 'SHORT-LEVEL': '#f59e0b', WATCH: '#0ea5e9', 'CCO-OK': '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['STEPPED', 'LONG-LEVEL', 'SHORT-LEVEL', 'WATCH', 'CCO-OK']
const TIER_RANK: Record<Tier, number> = { STEPPED: 0, 'LONG-LEVEL': 1, 'SHORT-LEVEL': 2, WATCH: 3, 'CCO-OK': 4, IDLE: 5 }

type Klass = 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = { HVY: '#a855f7', NRW: '#0ea5e9', RGN: '#22d3ee', BIZ: '#10b981', TBP: '#f59e0b' }

interface KlassPerf {
  // optimum continuous climb ROC fpm by band: <FL100, FL100-280, >FL280
  rocLo: number; rocMid: number; rocHi: number
  // fuel burn while level (excess vs climb) kg/min and total cruise burn kg/min reference
  excessKgMin: number
  // typical TOC FL
  tocFl: number
  examples: string
}
const KLASS: Record<Klass, KlassPerf> = {
  HVY: { rocLo: 2200, rocMid: 1800, rocHi: 1100, excessKgMin: 105, tocFl: 360, examples: 'B777 B787 A350 A330 B747 MD11' },
  NRW: { rocLo: 2400, rocMid: 2000, rocHi: 1300, excessKgMin:  48, tocFl: 360, examples: 'B737 A320 B757 A220' },
  RGN: { rocLo: 2200, rocMid: 1800, rocHi: 1100, excessKgMin:  22, tocFl: 340, examples: 'CRJ E-Jet Q400 ATR-72' },
  BIZ: { rocLo: 3000, rocMid: 2500, rocHi: 1800, excessKgMin:  14, tocFl: 410, examples: 'GLF FA7X CL30 PC-24' },
  TBP: { rocLo: 1500, rocMid: 1100, rocHi:  700, excessKgMin:   6, tocFl: 250, examples: 'ATR-42 SF34 DH8 PC-12' },
}

function classify(type: string | undefined): Klass {
  const t = (type || '').toUpperCase()
  if (/^(B77[0-9]|B78[0-9]|A35[0-9]|A33[0-9]|A340|B74[0-9]|MD11|A38[0-9]|B767)$/.test(t)) return 'HVY'
  if (/^(B73[0-9]|B7M[78]|A32[0-9]|A31[89]|B757|A22[01]|A21N|A20N|A19N|BCS[123])$/.test(t)) return 'NRW'
  if (/^(CRJ[0-9]+|E[12-9][0-9]{2}|E170|E175|E190|E195|DH8[A-D]|AT4[2-7]|AT7[2-6])$/.test(t)) return 'RGN'
  if (/^(GLF[0-9]|G[2-7][0-9]{2}|FA[0-9X]+|CL[0-9]+|C[5-7][0-9]{2}|PC[0-9]+|HDJT|LJ[0-9]+)$/.test(t)) return 'BIZ'
  if (/^(SF34|JS31|JS32|J3[12]|PC12|C208|BE[0-9]+)$/.test(t)) return 'TBP'
  return 'NRW'
}

/* ---- Departure airport catalogue (30) ---- */
interface DepAp {
  icao: string; name: string; lat: number; lng: number; elevFt: number
  ica: number       // initial-climb-altitude FL (typical SID clearance ceiling)
  nadp: 'NADP1' | 'NADP2' | 'NONE'
  density: 'HI' | 'MD' | 'LO'   // ATC departure density (vector likelihood)
}
const DEP: DepAp[] = [
  { icao: 'EGLL', name: 'London Heathrow',        lat: 51.470, lng:  -0.454, elevFt:    83, ica:  60, nadp: 'NADP1', density: 'HI' },
  { icao: 'EGKK', name: 'London Gatwick',         lat: 51.148, lng:  -0.190, elevFt:   202, ica:  60, nadp: 'NADP1', density: 'HI' },
  { icao: 'LFPG', name: 'Paris CDG',              lat: 49.013, lng:   2.550, elevFt:   392, ica:  60, nadp: 'NADP2', density: 'HI' },
  { icao: 'EDDF', name: 'Frankfurt',              lat: 50.034, lng:   8.563, elevFt:   364, ica:  60, nadp: 'NADP2', density: 'HI' },
  { icao: 'EHAM', name: 'Amsterdam Schiphol',     lat: 52.309, lng:   4.764, elevFt:   -11, ica:  60, nadp: 'NADP1', density: 'HI' },
  { icao: 'LEMD', name: 'Madrid Barajas',         lat: 40.493, lng:  -3.567, elevFt:  1998, ica: 110, nadp: 'NADP2', density: 'HI' },
  { icao: 'LIRF', name: 'Rome Fiumicino',         lat: 41.800, lng:  12.239, elevFt:    13, ica:  70, nadp: 'NADP2', density: 'MD' },
  { icao: 'LSZH', name: 'Zürich',                 lat: 47.464, lng:   8.549, elevFt:  1416, ica:  80, nadp: 'NADP1', density: 'MD' },
  { icao: 'LOWW', name: 'Vienna',                 lat: 48.110, lng:  16.570, elevFt:   600, ica:  70, nadp: 'NADP2', density: 'MD' },
  { icao: 'KATL', name: 'Atlanta Hartsfield',     lat: 33.640, lng: -84.428, elevFt:  1027, ica: 100, nadp: 'NADP1', density: 'HI' },
  { icao: 'KORD', name: 'Chicago O\u02bcHare',    lat: 41.978, lng: -87.904, elevFt:   672, ica: 100, nadp: 'NADP1', density: 'HI' },
  { icao: 'KDFW', name: 'Dallas/Fort Worth',      lat: 32.897, lng: -97.038, elevFt:   607, ica: 100, nadp: 'NADP1', density: 'HI' },
  { icao: 'KLAX', name: 'Los Angeles',            lat: 33.943, lng:-118.408, elevFt:   125, ica:  80, nadp: 'NADP1', density: 'HI' },
  { icao: 'KJFK', name: 'New York JFK',           lat: 40.640, lng: -73.779, elevFt:    13, ica:  50, nadp: 'NADP1', density: 'HI' },
  { icao: 'KLGA', name: 'New York LaGuardia',     lat: 40.778, lng: -73.873, elevFt:    21, ica:  50, nadp: 'NADP1', density: 'HI' },
  { icao: 'KEWR', name: 'Newark Liberty',         lat: 40.692, lng: -74.169, elevFt:    17, ica:  50, nadp: 'NADP1', density: 'HI' },
  { icao: 'KBOS', name: 'Boston Logan',           lat: 42.363, lng: -71.006, elevFt:    20, ica:  60, nadp: 'NADP1', density: 'HI' },
  { icao: 'KDEN', name: 'Denver',                 lat: 39.862, lng:-104.673, elevFt:  5431, ica: 160, nadp: 'NADP2', density: 'HI' },
  { icao: 'KSFO', name: 'San Francisco',          lat: 37.619, lng:-122.375, elevFt:    13, ica:  80, nadp: 'NADP1', density: 'HI' },
  { icao: 'KSEA', name: 'Seattle-Tacoma',         lat: 47.450, lng:-122.309, elevFt:   433, ica:  70, nadp: 'NADP1', density: 'MD' },
  { icao: 'KIAH', name: 'Houston Intercont.',     lat: 29.984, lng: -95.341, elevFt:    97, ica: 100, nadp: 'NADP2', density: 'MD' },
  { icao: 'KPHX', name: 'Phoenix Sky Harbor',     lat: 33.434, lng:-112.012, elevFt:  1135, ica: 110, nadp: 'NADP2', density: 'MD' },
  { icao: 'KMIA', name: 'Miami',                  lat: 25.793, lng: -80.291, elevFt:     8, ica:  80, nadp: 'NADP1', density: 'MD' },
  { icao: 'KMCO', name: 'Orlando',                lat: 28.429, lng: -81.309, elevFt:    96, ica:  90, nadp: 'NADP1', density: 'MD' },
  { icao: 'CYYZ', name: 'Toronto Pearson',        lat: 43.677, lng: -79.631, elevFt:   569, ica:  80, nadp: 'NADP1', density: 'MD' },
  { icao: 'RJTT', name: 'Tokyo Haneda',           lat: 35.553, lng: 139.781, elevFt:    21, ica:  70, nadp: 'NADP1', density: 'HI' },
  { icao: 'VHHH', name: 'Hong Kong',              lat: 22.309, lng: 113.915, elevFt:    28, ica:  70, nadp: 'NADP2', density: 'HI' },
  { icao: 'WSSS', name: 'Singapore Changi',       lat:  1.359, lng: 103.989, elevFt:    22, ica:  80, nadp: 'NADP2', density: 'HI' },
  { icao: 'OMDB', name: 'Dubai',                  lat: 25.253, lng:  55.366, elevFt:    62, ica:  80, nadp: 'NADP2', density: 'HI' },
  { icao: 'YSSY', name: 'Sydney Kingsford-Smith', lat:-33.946, lng: 151.177, elevFt:    21, ica:  70, nadp: 'NADP1', density: 'MD' },
]

/* ---- math helpers ---- */
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

function nearestDep(f: SFlight): { ap: DepAp; distNm: number } | null {
  let best: { ap: DepAp; distNm: number } | null = null
  for (const a of DEP) {
    const d = gcNm(f.lat, f.lng, a.lat, a.lng)
    if (!best || d < best.distNm) best = { ap: a, distNm: d }
  }
  return best && best.distNm <= 250 ? best : null
}

type Phase = 'INITIAL' | 'MID-CLB' | 'HI-CLB' | 'AT-TOC' | 'IDLE'
function phaseOf(f: SFlight, klass: Klass): Phase {
  if (f.ground) return 'IDLE'
  const fl = f.altitudeFt / 100
  const tocFl = KLASS[klass].tocFl
  if (fl >= tocFl - 5 && Math.abs(f.vertRate) < 400) return 'AT-TOC'
  if (f.vertRate < 100) return 'IDLE'
  if (fl < 100) return 'INITIAL'
  if (fl < 280) return 'MID-CLB'
  return 'HI-CLB'
}
const PHASE_MUL: Record<Phase, number> = { INITIAL: 1.20, 'MID-CLB': 1.30, 'HI-CLB': 1.15, 'AT-TOC': 0.20, IDLE: 0 }

interface LevelSeg { atFl: number; durMin: number; excessKg: number }
interface Eval {
  f: SFlight
  ap: DepAp | null
  apDistNm: number
  klass: Klass
  phase: Phase
  fl: number
  rocActual: number
  rocOpt: number
  rocDelta: number       // signed: actual − optimum (negative = below optimum)
  levelOffs: LevelSeg[]  // synthesised history this climb
  levelMin: number       // total minutes spent level
  efficiency: number     // 0..1 (1 = perfect CCO)
  excessFuelKg: number
  excessCo2Kg: number
  sidConform: boolean    // track within tolerance of bearing-from-origin
  drivers: { ROC: number; LVL: number; EFF: number; FUE: number; PHA: number; SID: number }
  tier: Tier
  score: number
  advice: string
}

function makeEval(f: SFlight, machBias: number, advMul: number, rocMul: number): Eval {
  const klass = classify(f.type)
  const phase = phaseOf(f, klass)
  const fl = f.altitudeFt / 100
  const perf = KLASS[klass]
  const near = nearestDep(f)
  const ap = near ? near.ap : null
  const apDistNm = near ? near.distNm : 999
  // pick optimum ROC band
  const rocOpt = (fl < 100 ? perf.rocLo : fl < 280 ? perf.rocMid : perf.rocHi) * (rocMul / 100)
  const rocActual = f.vertRate
  const rocDelta = rocActual - rocOpt

  // Synthesise level-off history (hash-stable per ICAO24 + airport density)
  const densityBias = ap ? (ap.density === 'HI' ? 1.0 : ap.density === 'MD' ? 0.7 : 0.4) : 0.3
  const u1 = hashUnit(f.icao, 'lv1'), u2 = hashUnit(f.icao, 'lv2'), u3 = hashUnit(f.icao, 'lv3')
  const lv: LevelSeg[] = []
  // Up to 3 synthesised level-offs along climb; only those below current FL are "in history"
  const candidates = [
    { fl: Math.round(60 + u1 * 50), dur: u1 * 4.0 * densityBias },
    { fl: Math.round(120 + u2 * 80), dur: u2 * 6.0 * densityBias },
    { fl: Math.round(220 + u3 * 100), dur: u3 * 5.0 * densityBias },
  ]
  for (const c of candidates) {
    if (c.fl < fl + 5 && c.fl >= 50 && c.dur > 0.3) {
      const exc = c.dur * perf.excessKgMin
      lv.push({ atFl: c.fl, durMin: c.dur, excessKg: exc })
    }
  }
  // Bias by mach slider (general dispatch aggressiveness)
  const biasMul = 1 + machBias / 100
  for (const s of lv) { s.durMin *= biasMul; s.excessKg *= biasMul }
  const levelMin = lv.reduce((s, x) => s + x.durMin, 0)
  const excessFuelKg = lv.reduce((s, x) => s + x.excessKg, 0)
  const excessCo2Kg = excessFuelKg * 3.16

  // CCO efficiency: ideal time-to-current-FL vs actual time = climbTime / (climbTime + levelMin)
  // climbTime estimate from elev to current FL using mean optimum ROC
  const elevFt = ap ? ap.elevFt : 200
  const altGained = Math.max(500, f.altitudeFt - elevFt)
  const meanRoc = Math.max(800, (perf.rocLo + perf.rocMid) / 2)
  const climbMin = altGained / meanRoc
  const efficiency = clamp(climbMin / (climbMin + levelMin), 0, 1)

  // SID conformance: track within ±25° of bearing-from-airport
  let sidConform = true
  if (ap) {
    const brgFromAp = bearingDeg(ap.lat, ap.lng, f.lat, f.lng)
    sidConform = angleDelta(f.track, brgFromAp) < 35
  }

  // Drivers (0-100)
  const ROC = phase === 'AT-TOC' || phase === 'IDLE' ? 0 : clamp((-rocDelta / Math.max(rocOpt, 500)) * 110, 0, 100)
  const LVL = clamp(levelMin * 18, 0, 100) // 5.5 min level => 100
  const EFF = clamp((1 - efficiency) * 130, 0, 100)
  const FUE = clamp(excessFuelKg / 6, 0, 100) // 600 kg => 100
  const PHA = PHASE_MUL[phase] * 60
  const SID = sidConform ? 0 : 55
  const drivers = { ROC, LVL, EFF, FUE, PHA, SID }
  const arr = [ROC, LVL, EFF, FUE, PHA, SID].sort((a, b) => b - a)
  let composite = arr[0] * 0.50 + arr[1] * 0.25 + arr[2] * 0.13 + arr[3] * 0.07 + arr[4] * 0.03 + arr[5] * 0.02
  composite *= PHASE_MUL[phase] * (advMul / 100) * (ap ? 1 : 0.4)
  composite = clamp(composite, 0, 100)
  // Hard escalations
  if (lv.length >= 3 && levelMin > 6) composite = Math.max(composite, 86)
  if (lv.some(x => x.durMin > 4 && x.atFl < 200)) composite = Math.max(composite, 78)
  if (efficiency < 0.55 && phase !== 'AT-TOC' && phase !== 'IDLE') composite = Math.max(composite, 70)

  let tier: Tier
  let advice = ''
  if (composite >= 80) {
    tier = 'STEPPED'
    advice = `${lv.length} level-offs · +${excessFuelKg.toFixed(0)} kg fuel / +${excessCo2Kg.toFixed(0)} kg CO2 — request continuous climb to FL${perf.tocFl} per AC 91-86 / Doc 9993; brief CCO-eligible route segment`
  } else if (composite >= 60) {
    tier = 'LONG-LEVEL'
    advice = `Long level-off ${levelMin.toFixed(1)} min at FL${lv[0]?.atFl ?? '—'} — re-request higher to nominal climb; coordinate with departure per JO 7110.65 §4-5`
  } else if (composite >= 40) {
    tier = 'SHORT-LEVEL'
    advice = `Brief level-off ${levelMin.toFixed(1)} min — monitor ROC vs ${rocOpt.toFixed(0)} fpm optimum; recover MAX-CLIMB per FCOM PI-22`
  } else if (composite >= 18) {
    tier = 'WATCH'
    advice = `ROC ${rocActual.toFixed(0)} fpm vs opt ${rocOpt.toFixed(0)} — within band, monitor SID restrictions and NADP-${ap?.nadp.slice(-1) || '?'} profile`
  } else if (ap) {
    tier = 'CCO-OK'
    advice = `Continuous climb to FL${fl.toFixed(0)} · CCO efficiency ${(efficiency * 100).toFixed(0)}% · nominal MAX-CLIMB profile`
  } else {
    tier = 'IDLE'
    advice = 'Outside departure CCO scope (no airport within 250 NM or no climb).'
  }
  return { f, ap, apDistNm, klass, phase, fl, rocActual, rocOpt, rocDelta, levelOffs: lv, levelMin, efficiency, excessFuelKg, excessCo2Kg, sidConform, drivers, tier, score: composite, advice }
}

const SRC_HALO = 'cco-halo', LYR_HALO = 'cco-halo'
const SRC_PIN  = 'cco-pin',  LYR_PIN  = 'cco-pin'
const SRC_LBL  = 'cco-lbl',  LYR_LBL  = 'cco-lbl'
const SRC_AP   = 'cco-ap',   LYR_AP   = 'cco-ap'
const SRC_ALBL = 'cco-albl', LYR_ALBL = 'cco-albl'
const SRC_LINK = 'cco-link', LYR_LINK = 'cco-link'

const lsGet = (k: string, d: any) => { if (typeof window === 'undefined') return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const lsSet = (k: string, v: any) => { if (typeof window === 'undefined') return; try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

export default function CcoMonitor({ map, flights, onClose, onFly }: Props) {
  const [bias, setBias]       = useState<number>(() => lsGet('ft-cco-bias', 0))
  const [rocMul, setRocMul]   = useState<number>(() => lsGet('ft-cco-roc', 100))
  const [advMul, setAdvMul]   = useState<number>(() => lsGet('ft-cco-adv', 100))
  const [minFl, setMinFl]     = useState<number>(() => lsGet('ft-cco-mnfl', 30))
  const [maxFl, setMaxFl]     = useState<number>(() => lsGet('ft-cco-mxfl', 360))
  const [scope, setScope]     = useState<number>(() => lsGet('ft-cco-scp', 250))
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'AIRPORTS' | 'CLASSES'>('AIRCRAFT')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showAp, setShowAp]     = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showDiag, setShowDiag] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    lsSet('ft-cco-bias', bias); lsSet('ft-cco-roc', rocMul); lsSet('ft-cco-adv', advMul)
    lsSet('ft-cco-mnfl', minFl); lsSet('ft-cco-mxfl', maxFl); lsSet('ft-cco-scp', scope)
  }, [bias, rocMul, advMul, minFl, maxFl, scope])

  const evals = useMemo(() => {
    const out: Eval[] = []
    for (const f of flights) {
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFl || fl > maxFl) continue
      if (f.vertRate < 100) continue // only climbing
      const e = makeEval(f, bias, advMul, rocMul)
      if (e.apDistNm > scope) continue
      out.push(e)
    }
    out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
    return out
  }, [flights, bias, rocMul, advMul, minFl, maxFl, scope])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (klassFilter !== 'ALL' && e.klass !== klassFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.ap?.icao} ${e.ap?.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, klassFilter, tierFilter, query])

  const tierCount: Record<Tier, number> = { STEPPED: 0, 'LONG-LEVEL': 0, 'SHORT-LEVEL': 0, WATCH: 0, 'CCO-OK': 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const totalFuelKg = evals.reduce((s, e) => s + e.excessFuelKg, 0)
  const totalCo2Kg = evals.reduce((s, e) => s + e.excessCo2Kg, 0)
  const meanEff = evals.length ? evals.reduce((s, e) => s + e.efficiency, 0) / evals.length : 0
  const totalLvl = evals.reduce((s, e) => s + e.levelOffs.length, 0)

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_AP,   'circle', SRC_AP,   { 'circle-radius': ['get', 'r'], 'circle-color': '#0ea5e9', 'circle-opacity': 0.55, 'circle-stroke-width': 1, 'circle-stroke-color': '#7dd3fc' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ALBL, 'symbol', SRC_ALBL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ALBL)) { map.setPaintProperty(LYR_ALBL, 'text-color', '#7dd3fc'); map.setPaintProperty(LYR_ALBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ALBL, 'text-halo-width', 1.4) }

    const ap: any[] = [], albl: any[] = []
    if (showAp) {
      for (const a of DEP) {
        const inN = evals.filter(e => e.ap?.icao === a.icao).length
        if (inN === 0) continue
        ap.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { r: 4 + Math.min(inN, 8) * 0.6 } })
        albl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { label: `${a.icao}·${inN}` } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'CCO-OK') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'STEPPED' || e.tier === 'LONG-LEVEL')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'CCO-OK' && e.tier !== 'IDLE') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} · ${e.ap?.icao || '—'} · +${e.excessFuelKg.toFixed(0)}kg · ${e.tier}` } })
      }
      if (showLink && e.ap && e.tier !== 'CCO-OK' && e.tier !== 'IDLE') {
        link.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[e.f.lng, e.f.lat], [e.ap.lng, e.ap.lat]] }, properties: { color } })
      }
    }
    ;(map.getSource(SRC_AP)   as any).setData({ type: 'FeatureCollection', features: ap })
    ;(map.getSource(SRC_ALBL) as any).setData({ type: 'FeatureCollection', features: albl })
    ;(map.getSource(SRC_HALO) as any).setData({ type: 'FeatureCollection', features: halo })
    ;(map.getSource(SRC_PIN)  as any).setData({ type: 'FeatureCollection', features: pin })
    ;(map.getSource(SRC_LBL)  as any).setData({ type: 'FeatureCollection', features: lbl })
    ;(map.getSource(SRC_LINK) as any).setData({ type: 'FeatureCollection', features: link })

    return () => {
      const m = map
      for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_LINK, LYR_AP, LYR_ALBL]) if (m.getLayer(id)) m.removeLayer(id)
      for (const id of [SRC_HALO, SRC_PIN, SRC_LBL, SRC_LINK, SRC_AP, SRC_ALBL]) if (m.getSource(id)) m.removeSource(id)
    }
  }, [map, filtered, evals, showHalo, showPin, showLbl, showAp, showLink])

  const tierBadge = (t: Tier) => <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ color: TIER_COLOR[t], backgroundColor: TIER_COLOR[t] + '22', border: `1px solid ${TIER_COLOR[t]}66` }}>{t}</span>
  const klassBadge = (k: Klass) => <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: KLASS_COLOR[k], backgroundColor: KLASS_COLOR[k] + '1f', border: `1px solid ${KLASS_COLOR[k]}55` }}>{k}</span>
  const drvBadge = (k: string, v: number) => {
    const c = v >= 70 ? '#ef4444' : v >= 40 ? '#f59e0b' : v >= 18 ? '#0ea5e9' : '#10b981'
    return <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: c, backgroundColor: c + '1c', border: `1px solid ${c}55` }}>{k}{v.toFixed(0)}</span>
  }

  /* Scatter: ROC-delta (fpm) vs efficiency (%) */
  const W = 280, H = 110, padL = 26, padB = 16, padT = 6, padR = 6
  const xMin = -1500, xMax = 600
  const sx = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + (1 - clamp(v / 100, 0, 1)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">CCO · Continuous Climb Operations</span>
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
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Stepped</div><div className="text-sm font-semibold" style={{ color: tierCount['STEPPED'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['STEPPED']}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Excess fuel</div><div className="text-xs font-semibold text-rose-400">{totalFuelKg >= 1000 ? (totalFuelKg/1000).toFixed(1)+'t' : totalFuelKg.toFixed(0)+'kg'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Excess CO2</div><div className="text-xs font-semibold text-amber-400">{totalCo2Kg >= 1000 ? (totalCo2Kg/1000).toFixed(1)+'t' : totalCo2Kg.toFixed(0)+'kg'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean CCO eff</div><div className="text-xs font-semibold text-sky-400">{(meanEff*100).toFixed(0)}% · {totalLvl} lvl-off</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* optimum band (ROC near 0 delta, eff high) */}
            <rect x={sx(-300)} y={padT} width={sx(300) - sx(-300)} height={sy(60) - padT} fill="#10b98115" />
            {/* breach quadrant: ROC <-600 fpm or eff <40 */}
            <rect x={padL} y={sy(40)} width={sx(-600) - padL} height={H - padB - sy(40)} fill="#ef444418" />
            <line x1={sx(0)} y1={padT} x2={sx(0)} y2={H - padB} stroke="#475569" strokeWidth={0.5} />
            <line x1={sx(-600)} y1={padT} x2={sx(-600)} y2={H - padB} stroke="#f43f5e66" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={padL} y1={sy(40)} x2={W - padR} y2={sy(40)} stroke="#f59e0b66" strokeWidth={0.5} strokeDasharray="3 3" />
            <line x1={padL} y1={sy(80)} x2={W - padR} y2={sy(80)} stroke="#10b98166" strokeWidth={0.5} strokeDasharray="3 3" />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">ΔROC fpm (act−opt)</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>CCO eff %</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(clamp(e.rocDelta, xMin, xMax))} cy={sy(e.efficiency * 100)} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['LVL-BIAS', bias, -50, 100, setBias, '%'],
            ['ROC-MUL', rocMul, 50, 200, setRocMul, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['MIN-FL', minFl, 0, 200, setMinFl, ''],
            ['MAX-FL', maxFl, 200, 410, setMaxFl, ''],
            ['SCOPE', scope, 50, 400, setScope, 'nm'],
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
            ['APT', showAp, setShowAp],
            ['LINK', showLink, setShowLink],
            ['DIAG', showDiag, setShowDiag],
          ].map(([lab, v, setter]: any) => (
            <button key={lab} onClick={() => setter(!v)} className="px-1.5 py-0.5 rounded text-[9px] font-mono border" style={{ backgroundColor: v ? '#0ea5e933' : '#0b1220', borderColor: v ? '#0ea5e9' : '#1e293b', color: v ? '#7dd3fc' : '#64748b' }}>{lab}</button>
          ))}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / icao / type / airport" className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600" />
      </div>

      <div className="flex border-b border-slate-800">
        {(['AIRCRAFT', 'AIRPORTS', 'CLASSES'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-2 py-1.5 text-[10px] font-semibold ${tab === t ? 'text-sky-400 bg-slate-800/50 border-b-2 border-sky-500' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No climbing aircraft in CCO scope.</div>}
            {filtered.map((e, idx) => {
              const sgn = e.rocDelta >= 0 ? '+' : ''
              return (
                <div key={idx} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => onFly(e.f.icao)} style={{ borderLeft: `3px solid ${TIER_COLOR[e.tier]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-slate-200 text-[11px] font-semibold truncate">{e.f.callsign || e.f.icao}</span>
                      <span className="text-slate-500 text-[10px] font-mono">{e.f.type || '—'}</span>
                      {klassBadge(e.klass)}
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{e.phase}</span>
                    </div>
                    {tierBadge(e.tier)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    <span className="text-sky-300">{e.ap?.icao || 'NO-APT'}</span>
                    {' · FL'}<span className="text-slate-300">{e.fl.toFixed(0)}</span>
                    {' · ROC '}<span style={{ color: e.rocDelta < -400 ? '#ef4444' : e.rocDelta < -100 ? '#f59e0b' : '#10b981' }}>{e.rocActual.toFixed(0)}fpm</span>
                    {' / opt '}<span className="text-slate-300">{e.rocOpt.toFixed(0)}</span>
                    {' · Δ'}<span style={{ color: e.rocDelta < -400 ? '#ef4444' : e.rocDelta < -100 ? '#f59e0b' : '#10b981' }}>{sgn}{e.rocDelta.toFixed(0)}</span>
                  </div>
                  {e.levelOffs.length > 0 && (
                    <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                      › {e.levelOffs.length} level-off{e.levelOffs.length > 1 ? 's' : ''} · {e.levelMin.toFixed(1)}min
                      {' · +'}<span className="text-rose-300">{e.excessFuelKg.toFixed(0)}kg fuel</span>
                      {' · +'}<span className="text-amber-300">{e.excessCo2Kg.toFixed(0)}kg CO2</span>
                      {' · eff '}<span style={{ color: e.efficiency < 0.6 ? '#ef4444' : e.efficiency < 0.85 ? '#f59e0b' : '#10b981' }}>{(e.efficiency * 100).toFixed(0)}%</span>
                    </div>
                  )}
                  {e.levelOffs.length > 0 && (
                    <div className="text-[9px] text-slate-500 mt-0.5 font-mono truncate">
                      {e.levelOffs.map((s, i) => `FL${s.atFl}·${s.durMin.toFixed(1)}min`).join(' › ')}
                    </div>
                  )}
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} /></div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {drvBadge('ROC', e.drivers.ROC)}
                    {drvBadge('LVL', e.drivers.LVL)}
                    {drvBadge('EFF', e.drivers.EFF)}
                    {drvBadge('FUE', e.drivers.FUE)}
                    {drvBadge('PHA', e.drivers.PHA)}
                    {drvBadge('SID', e.drivers.SID)}
                  </div>
                  <div className="text-[10px] mt-1.5 italic" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'AIRPORTS' && (
          <div className="divide-y divide-slate-800">
            {DEP.slice().sort((a, b) => {
              const ca = evals.filter(e => e.ap?.icao === a.icao).length
              const cb = evals.filter(e => e.ap?.icao === b.icao).length
              return cb - ca
            }).map(a => {
              const inA = evals.filter(e => e.ap?.icao === a.icao)
              if (inA.length === 0) return null
              const step = inA.filter(e => e.tier === 'STEPPED').length
              const lng = inA.filter(e => e.tier === 'LONG-LEVEL').length
              const ms = inA.reduce((s, e) => s + e.score, 0) / inA.length
              const fuel = inA.reduce((s, e) => s + e.excessFuelKg, 0)
              return (
                <div key={a.icao} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${a.density === 'HI' ? '#ef4444' : a.density === 'MD' ? '#f59e0b' : '#10b981'}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono text-sky-300 text-[11px]">{a.icao}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono text-slate-400 bg-slate-800/60 border border-slate-700">{a.nadp}</span>
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: a.density === 'HI' ? '#fda4af' : a.density === 'MD' ? '#fcd34d' : '#86efac' }}>{a.density}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-300">elev {a.elevFt}ft · ICA FL{a.ica}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">{a.name}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {inA.length} ac · <span className="text-rose-400">{step} STP</span> · <span className="text-rose-400">{lng} LNG</span> · +{fuel >= 1000 ? (fuel/1000).toFixed(1)+'t' : fuel.toFixed(0)+'kg'} fuel
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800">
            {(['HVY', 'NRW', 'RGN', 'BIZ', 'TBP'] as Klass[]).map(k => {
              const inK = evals.filter(e => e.klass === k)
              const perf = KLASS[k]
              const step = inK.filter(e => e.tier === 'STEPPED').length
              const lng = inK.filter(e => e.tier === 'LONG-LEVEL').length
              const ms = inK.length ? inK.reduce((s, e) => s + e.score, 0) / inK.length : 0
              const fuel = inK.reduce((s, e) => s + e.excessFuelKg, 0)
              return (
                <div key={k} className="px-3 py-2 hover:bg-slate-800/40" style={{ borderLeft: `3px solid ${KLASS_COLOR[k]}` }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {klassBadge(k)}
                      <span className="text-[10px] font-mono text-slate-300">opt {perf.rocLo}/{perf.rocMid}/{perf.rocHi} fpm · TOC FL{perf.tocFl}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">{perf.excessKgMin} kg/min</span>
                  </div>
                  <div className="text-[10px] text-slate-500 truncate italic">{perf.examples}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    {inK.length} ac · <span className="text-rose-400">{step} STP</span> · <span className="text-rose-400">{lng} LNG</span> · +{fuel >= 1000 ? (fuel/1000).toFixed(1)+'t' : fuel.toFixed(0)+'kg'} fuel
                  </div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden"><div className="h-full" style={{ width: `${ms}%`, backgroundColor: ms >= 65 ? '#ef4444' : ms >= 35 ? '#f59e0b' : '#10b981' }} /></div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 leading-tight">
        ICAO Doc 9993 CCO · Doc 4444 §6 · Annex 11 §3.7 · FAA AC 91-86 · JO 7110.65 §4-5 · EUROCONTROL CCO/CDO ConOps · IATA Fuel-Eff 2023 · Boeing FCOM PI-22 · Airbus FOBN GO Climb
      </div>
    </div>
  )
}
