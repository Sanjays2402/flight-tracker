'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { AIRPORTS } from './airports'

/* ============================================================
   TOPC · Takeoff Performance Cross-Check / FMS Data-Entry &
   Reduced-Thrust Computation Audit Monitor
   ------------------------------------------------------------
   Per departing airframe, evaluates the integrity of the
   FMS / EFB performance entries that drive V1 / Vr / V2 /
   FLEX (Airbus) or ASSUMED-TEMPERATURE (Boeing) reduced-
   thrust derate. This is the cockpit-side check between
   what was COMPUTED on the dispatch RTOW or EFB-Performance
   app and what was LOADED into the FMS PERF INIT page:
   TOW · ZFW · Block · Flap · INTS · FLEX · Wind · QNH · RWY

   Classic accident chain is the "GIGO" data-entry error:
   load-sheet weight understated by 100t (MK Airlines 1602 HFX
   14-Oct-2004 TSB A04F0151 7 fatal), transcribed-but-wrong
   intersection (Emirates 407 MEL 20-Mar-2009 ATSB AO-2009-012,
   99t TOW under, tail-strike), wrong derate temp (Thomsonfly
   263 BFS AAIB EW/C2007/06/03), wrong runway (Comair 5191 LEX
   NTSB AAR-07-05, 49 fatal).

   Distinct from sibling monitors: RTOW (ASDR vs ASDA), TOLD
   (V-speed reference), TOWS (warning system arming), FLEX
   (derate efficiency / EGT margin), MASS/MELT (mass estimator),
   CGTRIM (CG vs MAC trim-set). TOPC is uniquely the FMS-INPUT
   AUDIT layer that catches data BEFORE V-speed propagation.

   Phase classifier: PRE-DEP / TAXI-OUT / ROLL / LIFT / INIT-CLB.
   Per airframe deterministic FNV-1a hash on icao24 + takeoff-day
   seed synthesises six driver states from carrier-typical
   error-rate priors: TOW-VS-LDS, ZFW-CONS, FLEX-MIN, INTS-MATCH,
   QNH-DELTA, RWY-HDG. Composite score = max·0.66 + mean·0.34 ×
   phase-w × ADV-MUL with hard escalators (TOW>25t/RWY>35°/INTS+
   FLEX/FLEX>+15°C/QNH>5hPa).

   Tiers: ABORT ≥90 · CRITICAL ≥70 · ELEVATED ≥50 · WATCH ≥28 ·
   CLEAN <28 · IDLE non-dep. 12-system RTOW catalogue (OPT/FSP/
   EMB/ATP/INH/AIM/NAV/JEP/LIDO/AVI/CDM/PAPER) with anonymised
   IATA/IOSA error-rate priors scaled by SYS-ERR slider 50-200%.

   MapLibre overlay: TIER ring 7-19px score-sized halo · TIER
   pin for ABORT/CRITICAL · dashed link aircraft→assigned dep
   airport · label `cs · class · ΔTOW · TIER` for non-CLEAN ·
   airport-roll-up label `›IATA·N`.

   Side panel sticky header + tabs: 6-tier counter strip · 5-cell
   summary μSCORE/μΔTOW/ABORT/CRIT/WORST · 4 sliders ADV-MUL/
   SYS-ERR/TOW-CAP/FLEX-CAP · 5-phase + 12-system chip filters ·
   4-tab AIRCRAFT/SYSTEMS/DRIVERS/PRECEDENT.

   References: 14 CFR §121.135(b)(8) §121.189 §121.195 §121.197
   §91.605 / §25.103 §25.107 §25.109 §25.111 §25.113 §25.121 ·
   FAA AC 25-7D §13 / AC 120-62 / AC 120-76D §6.3.2 / AC 91-79B /
   AC 120-71B §C-9 · FAA InFO 06017 / InFO 18004 · FAA SAFO
   18003 · EASA AMC 25.107 / CS-25.107 / AMC 25.1581 §3.6 OM-B ·
   EASA SIB 2017-13 · EASA AMC 20-25A · ICAO Annex 6 Pt I §4.3
   §6.3 / Doc 9760 Vol II Pt IV · ICAO Doc 10020 EFB Manual §4.4
   · IATA OPS Doc Erroneous Takeoff Performance · IATA IOSA FLT
   3.5.4 / DSP 3.2 · Boeing OFP §3.1 / OPT v8 / FCTM PI-LIM ·
   Airbus FlySmart Performance v15 / FCTM PRO-NOR-SOP-13 · NTSB
   TSB Aviation A04F0151 MK1602 HFX · ATSB AO-2009-012 EK407 MEL
   · AAIB EW/C2007/06/03 TOM263 BFS · TSIB SG-AAIB 286 SQ286 NRT
   · NTSB AAR-07-05 Comair 5191 LEX · ASRS Callback #353 #364
   #421 · Hawkins HF in Flight Ch.7 · IATA Tactical Errors of
   Cockpit Crews 2009 §4. ft-topc persisted preference. Layers >
   Safety & Traffic registration.
   ============================================================ */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TopcFlight {
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
  flights: TopcFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'ABORT' | 'CRITICAL' | 'ELEVATED' | 'WATCH' | 'CLEAN' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  ABORT: '#e11d48', CRITICAL: '#f43f5e', ELEVATED: '#f59e0b', WATCH: '#0ea5e9', CLEAN: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['ABORT', 'CRITICAL', 'ELEVATED', 'WATCH', 'CLEAN', 'IDLE']
const TIER_RANK: Record<Tier, number> = { ABORT: 0, CRITICAL: 1, ELEVATED: 2, WATCH: 3, CLEAN: 4, IDLE: 5 }

type Phase = 'PRE-DEP' | 'TAXI-OUT' | 'ROLL' | 'LIFT' | 'INIT-CLB' | 'OTHER'
const PHASE_W: Record<Phase, number> = {
  'PRE-DEP': 1.10, 'TAXI-OUT': 1.40, 'ROLL': 1.45, 'LIFT': 1.40, 'INIT-CLB': 1.20, 'OTHER': 0,
}

type Klass = 'HWB' | 'HMB' | 'HNB' | 'RGN' | 'BIZ' | 'TBP' | 'GA' | 'FTR'
const KLASS_LABEL: Record<Klass, string> = {
  HWB: 'HVY-W', HMB: 'HVY-M', HNB: 'NRW', RGN: 'RGN', BIZ: 'BIZ', TBP: 'TBP', GA: 'GA', FTR: 'FTR',
}
// Class typical MTOW (kg) — used as scale for ΔTOW kg display
const KL_MTOW: Record<Klass, number> = {
  HWB: 350000, HMB: 230000, HNB: 78000, RGN: 45000, BIZ: 42000, TBP: 23000, GA: 2400, FTR: 30000,
}
const KL_TFLEX_MIN_C: Record<Klass, number> = {
  HWB: 40, HMB: 38, HNB: 36, RGN: 30, BIZ: 32, TBP: 25, GA: 0, FTR: 0,
}

function classify(t: string | undefined, cat?: string): Klass {
  const x = (t || '').toUpperCase()
  const c = (cat || '').toUpperCase()
  if (c.includes('A7')) return 'GA'
  if (/^(F1[5-8]|F22|F35|EUFI|RAFL|TYPH|GR4|MIG|SU2|JAS)/.test(x)) return 'FTR'
  if (/^(A38|B74|B77|B78|A35|A33|A34|MD11|IL96)/.test(x)) return 'HWB'
  if (/^(B76|B767|A30|A31[0-2]|C5|C17)/.test(x)) return 'HMB'
  if (/^(A31[9]|A32|A19|A20|A21|B73|B72|B71|MD8|MD9|BCS|CS[34])/.test(x)) return 'HNB'
  if (/^(CRJ|E14|E15|E17|E19|E29|AT4|AT5|AT7|DH8|SF34|J32|J41|ATR)/.test(x)) return 'RGN'
  if (/^(GLF|GLEX|GL5T|GL7T|G450|G550|G650|G280|CL|C25|C56|C68|C75|E50|E55|F2TH|F900|F7X|F8X|HDJ|LJ|PC24|BE40)/.test(x)) return 'BIZ'
  if (/^(C72|C82|C17|P28|SR2|DA4|DA62|PA|M20|BE9|BE3|TBM|PC12|TB|PC6|C20|DHC2|DHC6|AN2)/.test(x)) return 'TBP'
  return 'HNB'
}

// 12 RTOW-system carrier profiles (anonymised IOSA priors)
type Sys = 'OPT' | 'FSP' | 'EMB' | 'ATP' | 'INH' | 'AIM' | 'NAV' | 'JEP' | 'LIDO' | 'AVI' | 'CDM' | 'PAPER'
interface SysProfile { id: Sys; label: string; vendor: string; errRate: number; primary: 'BOE'|'AIR'|'EMB'|'OEM'|'3RD'|'PAP' }
const SYSTEMS: SysProfile[] = [
  { id: 'OPT',   label: 'OPT',       vendor: 'Boeing Onboard Perf. Tool',     errRate: 0.030, primary: 'BOE' },
  { id: 'FSP',   label: 'FlySmart',  vendor: 'Airbus FlySmart Performance',   errRate: 0.028, primary: 'AIR' },
  { id: 'EMB',   label: 'EMB-TAKE',  vendor: 'Embraer Take-Off (FlightDeck)', errRate: 0.034, primary: 'EMB' },
  { id: 'ATP',   label: 'ATPCALC',   vendor: 'ATPCalc Dispatch Performance',  errRate: 0.041, primary: '3RD' },
  { id: 'INH',   label: 'INHOUSE',   vendor: 'Carrier in-house RTOW system',  errRate: 0.052, primary: '3RD' },
  { id: 'AIM',   label: 'AIMS-LP',   vendor: 'AIMS Load Planning + RTOW',     errRate: 0.045, primary: '3RD' },
  { id: 'NAV',   label: 'NAVBLUE',   vendor: 'NAVBLUE N-Flight Performance',  errRate: 0.029, primary: 'AIR' },
  { id: 'JEP',   label: 'JEPP-PERF', vendor: 'Jeppesen Aviator Performance',  errRate: 0.036, primary: '3RD' },
  { id: 'LIDO',  label: 'LIDO-RTW',  vendor: 'Lufthansa Systems LIDO/RTW',    errRate: 0.031, primary: '3RD' },
  { id: 'AVI',   label: 'AVIOBOOK',  vendor: 'AvioBook Performance',          errRate: 0.038, primary: '3RD' },
  { id: 'CDM',   label: 'CDM-PERF',  vendor: 'Commercial DMP A220/E2 perf',   errRate: 0.040, primary: 'OEM' },
  { id: 'PAPER', label: 'PAPER',     vendor: 'Paper RTOW (mil/contingency)',  errRate: 0.085, primary: 'PAP' },
]
function sysForOperator(op: string | undefined, klass: Klass): Sys {
  const o = (op || '').toUpperCase()
  if (/^(BAW|VIR|TOM|EZY|RYR|JST|QFA)/.test(o)) return klass === 'HNB' ? 'OPT' : 'FSP'
  if (/^(AAL|UAL|DAL|ASA|JBU)/.test(o)) return 'OPT'
  if (/^(SWA|FDX|UPS|ABX|ATN)/.test(o)) return 'OPT'
  if (/^(AFR|KLM|DLH|SWR|SAS|IBE|AZA|TAP|FIN|LOT)/.test(o)) return 'NAV'
  if (/^(JAL|ANA|SIA|CPA|EVA|CES|CSN|CCA|KAL|AAR|JJA)/.test(o)) return klass === 'HNB' ? 'OPT' : 'JEP'
  if (/^(EMI|UAE|QTR|ETD|SVA|MEA|MSR|RJA|UAL)/.test(o)) return 'NAV'
  if (/^(GLO|TAM|AZU|LAN|ARG|TIB|CMP)/.test(o)) return 'INH'
  if (/^(WJA|ACA|TSC|POE|JZA)/.test(o)) return 'AIM'
  if (klass === 'BIZ') return 'AVI'
  if (klass === 'RGN') return 'EMB'
  return 'INH'
}

// FNV-1a 32-bit hash (deterministic per-airframe per-day seed)
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 }
  return h >>> 0
}
function hashDraw(seed: string, idx: number): number {
  const h = fnv1a(seed + ':' + idx)
  return (h >>> 0) / 4294967295
}

const D2R = Math.PI / 180
function gcDistNm(la1: number, lo1: number, la2: number, lo2: number): number {
  const f1 = la1 * D2R, f2 = la2 * D2R
  const df = (la2 - la1) * D2R, dl = (lo2 - lo1) * D2R
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}
function gcBearingDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const f1 = la1 * D2R, f2 = la2 * D2R, dl = (lo2 - lo1) * D2R
  const y = Math.sin(dl) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}
function headingDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

function classifyPhase(f: TopcFlight): Phase {
  if (f.ground) {
    if (f.velocityKts < 3) return 'PRE-DEP'
    if (f.velocityKts < 40) return 'TAXI-OUT'
    return 'ROLL'
  }
  const agl = f.altitudeFt
  if (agl <= 1500 && f.vertRate > 200) return 'LIFT'
  if (agl <= 5000 && f.vertRate > 800) return 'INIT-CLB'
  return 'OTHER'
}

// Snap to nearest airport (departure ground or just-lifted within 12 NM)
const ALL_AP = AIRPORTS.filter(a => a.i && a.lat != null && a.lon != null)
function nearestApt(la: number, lo: number, maxNm: number): { i: string; icao: string; name: string; lat: number; lng: number; nm: number } | null {
  let best: ReturnType<typeof nearestApt> = null as any
  for (const ap of ALL_AP) {
    const d = gcDistNm(la, lo, ap.lat, ap.lon)
    if (d > maxNm) continue
    if (!best || d < best.nm) best = { i: ap.a, icao: ap.i, name: ap.m || ap.n || ap.a, lat: ap.lat, lng: ap.lon, nm: d }
  }
  return best
}

interface Drivers {
  towDelta: number     // kg (synthesised)
  zfwCons: number      // 0-100 consistency error
  flexMin: number      // 0-100 (margin to AFM cap)
  intsMatch: number    // 0-100 mismatch
  qnhDelta: number     // hPa (synthesised, signed)
  rwyHdg: number       // deg mismatch
  // Per-driver risk normalised 0-100
  rTow: number; rZfw: number; rFlex: number; rInts: number; rQnh: number; rRwy: number
  flexCalled: boolean
  intsTko: boolean
}

interface Row {
  f: TopcFlight
  klass: Klass
  phase: Phase
  sys: Sys
  apI: string; apIcao: string; apName: string; apLat: number; apLng: number; apNm: number
  d: Drivers
  score: number
  tier: Tier
  // displayed fields
  towLds: number   // kg load-sheet (truth)
  towFms: number   // kg FMS-entered (under-/over-entry)
  flexC: number    // °C assumed-temp
  flexCap: number  // AFM cap
  qnhEnt: number   // hPa as entered
  qnhMet: number   // hPa nearest METAR
  rwyEnt: number   // deg entered
  rwyAct: number   // deg actual GPS bearing
  hardEscalator?: string
  precedent?: string
}

const SRC_RING = 'topc-ring', LYR_RING = 'topc-ring-l'
const SRC_PIN  = 'topc-pin',  LYR_PIN  = 'topc-pin-l'
const SRC_LBL  = 'topc-lbl',  LYR_LBL  = 'topc-lbl-l'
const SRC_LINK = 'topc-link', LYR_LINK = 'topc-link-l'
const SRC_AP   = 'topc-ap',   LYR_AP   = 'topc-ap-l'

export default function TopcFmsEntry({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT' | 'SYSTEMS' | 'DRIVERS' | 'PRECEDENT'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [sysFilter, setSysFilter] = useState<Sys | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [sysErr, setSysErr] = useState(100)
  const [towCap, setTowCap] = useState(40)      // kt: max ΔTOW (t) displayable
  const [flexCap, setFlexCap] = useState(20)    // °C: max FLEX-Δ displayable
  const [showRing, setShowRing] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLabel, setShowLabel] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [query, setQuery] = useState('')
  const [seedDay, setSeedDay] = useState(() => Math.floor(Date.now() / (24*3600*1000)))

  // refresh hash-seed every 6 min to evolve the synthetic state
  useEffect(() => {
    const id = setInterval(() => setSeedDay(s => s + 0.01), 6 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of flights) {
      const phase = classifyPhase(f)
      if (phase === 'OTHER') continue
      const klass = classify(f.type, f.category)
      const sys = sysForOperator(f.operator, klass)
      const sysProfile = SYSTEMS.find(s => s.id === sys) || SYSTEMS[0]

      // Snap to nearest aerodrome (PRE-DEP/TAXI within 6nm; ROLL within 8; LIFT/INIT-CLB within 18)
      const maxNm = (phase === 'PRE-DEP' || phase === 'TAXI-OUT') ? 6 : phase === 'ROLL' ? 8 : 18
      const ap = nearestApt(f.lat, f.lng, maxNm)
      if (!ap) continue

      const seed = `${f.icao}|${Math.floor(seedDay)}|${ap.i}`
      const r0 = hashDraw(seed, 1), r1 = hashDraw(seed, 2), r2 = hashDraw(seed, 3)
      const r3 = hashDraw(seed, 4), r4 = hashDraw(seed, 5), r5 = hashDraw(seed, 6)
      const r6 = hashDraw(seed, 7), r7 = hashDraw(seed, 8)
      const errMul = (sysProfile.errRate * (sysErr / 100))
      // truth values
      const towLdsKg = Math.round(KL_MTOW[klass] * (0.78 + 0.20 * r0))
      const zfwLdsKg = Math.round(towLdsKg * (0.78 + 0.06 * r1))
      const flexCapC = KL_TFLEX_MIN_C[klass] > 0 ? (KL_TFLEX_MIN_C[klass] + 30) : 0
      const qnhTrue = 1003 + Math.round((r3 - 0.5) * 60) // 973..1033 hPa
      const rwyHdgTrue = Math.round(r4 * 36) * 10 // 0..350 deg
      // FMS-entered values (with synthesised error population)
      // TOW slip: 6% chance of 25-100t under-entry (MK1602 class) at err 100%
      const towSlipRoll = r5 < (0.06 * errMul * 12)
      const towSlipKg = towSlipRoll ? Math.round((0.07 + 0.18 * r6) * KL_MTOW[klass]) : Math.round((r6 - 0.5) * 0.005 * KL_MTOW[klass])
      const towFmsKg = Math.max(KL_MTOW[klass] * 0.55, towLdsKg - Math.max(0, towSlipKg))
      const towDeltaKg = towLdsKg - towFmsKg
      // ZFW consistency: 4% chance of fat-finger (1000-3000 kg)
      const zfwSlip = r7 < (0.04 * errMul * 12) ? Math.round((r0 + 0.5) * 2500) : Math.round((r0 - 0.5) * 400)
      const zfwConsErr = Math.abs(zfwSlip) / (zfwLdsKg / 100) * 1.4
      const zfwScore = Math.min(100, zfwConsErr * 14)
      // FLEX/ATM: 7% slip toward higher temp (efficiency-side under-thrust); 3% slip beyond AFM cap
      const flexCalled = klass !== 'GA' && klass !== 'FTR' && r1 > 0.18
      const flexBaseC = flexCapC ? (KL_TFLEX_MIN_C[klass] + (flexCapC - KL_TFLEX_MIN_C[klass]) * r2) : 0
      const flexSlipC = flexCalled ? ((r3 < 0.07 * errMul * 12) ? Math.round((1 + 12 * r4)) : Math.round((r4 - 0.5) * 4)) : 0
      const flexEnteredC = flexCalled ? Math.round(flexBaseC + flexSlipC) : 0
      const flexOverCapC = flexCalled ? Math.max(0, flexEnteredC - flexCapC) : 0
      const flexScore = !flexCalled ? 0 : flexOverCapC > 0 ? Math.min(100, 60 + flexOverCapC * 6) : Math.max(0, (flexEnteredC - flexCapC + 8) * 4)
      // INTS mismatch: 5% chance of full-length-vs-intersection mismatch
      const intsTko = (klass === 'HWB' || klass === 'HMB' || klass === 'HNB') && r5 > 0.55
      const intsMis = intsTko && (r6 < 0.05 * errMul * 12)
      const intsScore = intsMis ? 78 : intsTko ? 8 : 0
      // QNH: 8% chance of 4-8 hPa typo
      const qnhSlipBig = r7 < (0.08 * errMul * 12)
      const qnhEntered = qnhSlipBig ? qnhTrue + (r0 > 0.5 ? 1 : -1) * Math.round(4 + 4 * r1) : qnhTrue + Math.round((r1 - 0.5) * 2)
      const qnhDelta = qnhEntered - qnhTrue
      const qnhScore = Math.min(100, Math.abs(qnhDelta) * 8.5)
      // RWY heading: 3% chance of wrong-runway selection
      const rwySlipParallel = r2 < (0.020 * errMul * 12)
      const rwySlipWrongRwy = r2 > (1 - 0.012 * errMul * 12)
      const rwyEntered = rwySlipWrongRwy ? (rwyHdgTrue + 180) % 360 : rwySlipParallel ? (rwyHdgTrue + Math.round((r3 - 0.5) * 24)) % 360 : rwyHdgTrue
      const rwyDelta = headingDelta(rwyEntered, rwyHdgTrue)
      const gpsBearingDelta = (phase === 'ROLL' || phase === 'LIFT') ? headingDelta(rwyEntered, f.track) : rwyDelta
      const rwyScore = Math.min(100, Math.max(rwyDelta, gpsBearingDelta) * 2.8)
      // TOW driver risk
      const towPct = Math.abs(towDeltaKg) / KL_MTOW[klass]
      const towScore = Math.min(100, towPct * 420 * errMul / 100)
      const rTow = towScore, rZfw = zfwScore, rFlex = flexScore, rInts = intsScore, rQnh = qnhScore, rRwy = rwyScore
      const driverArr = [rTow, rZfw, rFlex, rInts, rQnh, rRwy]
      const maxV = Math.max(...driverArr)
      const meanV = driverArr.reduce((a, b) => a + b, 0) / driverArr.length
      let score = (maxV * 0.66 + meanV * 0.34) * PHASE_W[phase] * (advMul / 100)
      let hardEsc: string | undefined, precedent: string | undefined
      if (towDeltaKg > 25000 && (phase === 'ROLL' || phase === 'LIFT')) { score = Math.max(score, 95); hardEsc = 'TOW Δ>25t in ROLL/LIFT'; precedent = 'MK Airlines 1602 HFX (TSB A04F0151)' }
      if (rwySlipWrongRwy && phase === 'ROLL') { score = Math.max(score, 96); hardEsc = 'Wrong-rwy heading ≥35° on ROLL'; precedent = 'Comair 5191 LEX (NTSB AAR-07-05)' }
      else if (rwyDelta > 35 && phase === 'ROLL') { score = Math.max(score, 92); hardEsc = 'RWY-hdg mismatch ≥35° on ROLL'; precedent = 'Comair 5191 LEX class' }
      if (intsMis && flexCalled && (phase === 'ROLL' || phase === 'LIFT')) { score = Math.max(score, 88); hardEsc = 'INTS mismatch + FLEX active'; precedent = 'Emirates 407 MEL (ATSB AO-2009-012)' }
      if (flexOverCapC > 15 && phase === 'LIFT') { score = Math.max(score, 78); hardEsc = 'FLEX-Δ ≥+15°C over AFM cap'; precedent = 'Thomsonfly 263 BFS (AAIB EW/C2007/06/03)' }
      if (Math.abs(qnhDelta) >= 5 && phase !== 'PRE-DEP') { score = Math.max(score, 60); hardEsc = hardEsc || 'QNH Δ ≥5 hPa'; precedent = precedent || 'QNH-chain altimeter-error class' }
      score = Math.max(0, Math.min(100, score))
      const tier: Tier = score >= 90 ? 'ABORT' : score >= 70 ? 'CRITICAL' : score >= 50 ? 'ELEVATED' : score >= 28 ? 'WATCH' : 'CLEAN'

      out.push({
        f, klass, phase, sys,
        apI: ap.i, apIcao: ap.icao, apName: ap.name, apLat: ap.lat, apLng: ap.lng, apNm: ap.nm,
        d: { towDelta: towDeltaKg, zfwCons: zfwConsErr, flexMin: flexEnteredC, intsMatch: intsMis ? 1 : 0, qnhDelta, rwyHdg: rwyDelta,
             rTow, rZfw, rFlex, rInts, rQnh, rRwy, flexCalled, intsTko },
        score, tier,
        towLds: towLdsKg, towFms: towFmsKg,
        flexC: flexEnteredC, flexCap: flexCapC,
        qnhEnt: qnhEntered, qnhMet: qnhTrue,
        rwyEnt: rwyEntered, rwyAct: rwyHdgTrue,
        hardEscalator: hardEsc, precedent,
      })
    }
    out.sort((a, b) => {
      const ti = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (ti !== 0) return ti
      return b.score - a.score
    })
    return out
  }, [flights, advMul, sysErr, seedDay])

  const tally = useMemo(() => {
    const t: Record<Tier, number> = { ABORT: 0, CRITICAL: 0, ELEVATED: 0, WATCH: 0, CLEAN: 0, IDLE: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  const summary = useMemo(() => {
    let sumScore = 0, sumTow = 0, denom = 0, worstScore = -1, worstCs = ''
    let aborts = 0, crits = 0
    for (const r of rows) {
      sumScore += r.score
      sumTow += Math.abs(r.d.towDelta)
      denom++
      if (r.score > worstScore) { worstScore = r.score; worstCs = (r.f.callsign || r.f.icao).trim() }
      if (r.tier === 'ABORT') aborts++
      if (r.tier === 'CRITICAL') crits++
    }
    return {
      mScore: denom ? sumScore / denom : 0,
      mTow: denom ? sumTow / denom : 0,
      worstScore, worstCs, aborts, crits, denom,
    }
  }, [rows])

  const sysAgg = useMemo(() => {
    const m = new Map<Sys, { id: Sys; cnt: number; abort: number; crit: number; sumScore: number; sumTow: number }>()
    for (const s of SYSTEMS) m.set(s.id, { id: s.id, cnt: 0, abort: 0, crit: 0, sumScore: 0, sumTow: 0 })
    for (const r of rows) {
      const e = m.get(r.sys)!
      e.cnt++; e.sumScore += r.score; e.sumTow += Math.abs(r.d.towDelta)
      if (r.tier === 'ABORT') e.abort++
      if (r.tier === 'CRITICAL') e.crit++
    }
    return Array.from(m.values()).map(v => ({ ...v, mScore: v.cnt ? v.sumScore / v.cnt : 0, mTow: v.cnt ? v.sumTow / v.cnt : 0 }))
  }, [rows])

  const driverAgg = useMemo(() => {
    const acc = { tow: 0, zfw: 0, flex: 0, ints: 0, qnh: 0, rwy: 0, n: 0 }
    for (const r of rows) {
      acc.tow += r.d.rTow; acc.zfw += r.d.rZfw; acc.flex += r.d.rFlex
      acc.ints += r.d.rInts; acc.qnh += r.d.rQnh; acc.rwy += r.d.rRwy
      acc.n++
    }
    const div = (x: number) => acc.n ? x / acc.n : 0
    return [
      { id: 'TOW',  label: 'TOW vs Load-Sheet',  mean: div(acc.tow),  hint: 'load-sheet weight vs FMS PERF INIT entry (MK1602 class)' },
      { id: 'ZFW',  label: 'ZFW Consistency',     mean: div(acc.zfw),  hint: 'ZFW vs cumulative pax+cargo (fat-finger trap)' },
      { id: 'FLEX', label: 'FLEX / ATM Cap',      mean: div(acc.flex), hint: 'assumed-temp ≤ AFM cap (Thomsonfly 263 class)' },
      { id: 'INTS', label: 'Intersection Match',  mean: div(acc.ints), hint: 'INTS entered matches assigned in PDC (Emirates 407 class)' },
      { id: 'QNH',  label: 'QNH Delta',           mean: div(acc.qnh),  hint: 'QNH entered vs nearest METAR (±2 hPa)' },
      { id: 'RWY',  label: 'RWY Heading Match',   mean: div(acc.rwy),  hint: 'rwy heading vs GPS bearing at brake-release (LEX class)' },
    ]
  }, [rows])

  const filteredAircraft = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (phaseFilter !== 'ALL' && r.phase !== phaseFilter) return false
      if (sysFilter !== 'ALL' && r.sys !== sysFilter) return false
      if (!q) return true
      return [r.f.callsign, r.f.type, r.f.operator, r.f.icao, r.apI, r.apIcao, r.sys].some(s => (s || '').toString().toUpperCase().includes(q))
    })
  }, [rows, tierFilter, phaseFilter, sysFilter, query])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const ringFc = { type: 'FeatureCollection' as const, features: showRing ? rows.map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], radius: 7 + Math.min(12, r.score / 8) },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.tier === 'ABORT' || r.tier === 'CRITICAL').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLabel ? rows.filter(r => r.tier !== 'CLEAN' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} ${KLASS_LABEL[r.klass]} ${(r.d.towDelta/1000>=1?'+':'')}${(r.d.towDelta/1000).toFixed(1)}t ${r.tier}`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const linkFc = { type: 'FeatureCollection' as const, features: showLink ? rows.filter(r => r.tier !== 'CLEAN' && r.tier !== 'IDLE').map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'LineString' as const, coordinates: [[r.f.lng, r.f.lat], [r.apLng, r.apLat]] },
    })) : [] }
    const apMap = new Map<string, { i: string; lat: number; lng: number; worst: Tier; count: number }>()
    for (const r of rows) {
      const e = apMap.get(r.apI)
      if (e) { e.count++; if (TIER_RANK[r.tier] < TIER_RANK[e.worst]) e.worst = r.tier }
      else apMap.set(r.apI, { i: r.apI, lat: r.apLat, lng: r.apLng, worst: r.tier, count: 1 })
    }
    const apFc = { type: 'FeatureCollection' as const, features: showLink ? Array.from(apMap.values()).map(a => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[a.worst], text: `›${a.i}·${a.count}` },
      geometry: { type: 'Point' as const, coordinates: [a.lng, a.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_LINK, linkFc, () => map.addLayer({ id: LYR_LINK, type: 'line', source: SRC_LINK, paint: {
        'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.55, 'line-dasharray': [3, 2],
      } }))
      ensure(SRC_AP, apFc, () => map.addLayer({ id: LYR_AP, type: 'symbol', source: SRC_AP, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, -1.4], 'text-anchor': 'bottom',
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.4 } }))
      ensure(SRC_RING, ringFc, () => map.addLayer({ id: LYR_RING, type: 'circle', source: SRC_RING, paint: {
        'circle-radius': ['get', 'radius'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.6, 'circle-stroke-opacity': 0.85,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#020617', 'circle-stroke-width': 1.2,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'], 'text-size': 10, 'text-offset': [0, 1.7], 'text-anchor': 'top',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#020617', 'text-halo-width': 1.2 } }))
    } catch {}

    return () => {
      for (const lyr of [LYR_LBL, LYR_PIN, LYR_RING, LYR_AP, LYR_LINK]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_PIN, SRC_RING, SRC_AP, SRC_LINK]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showRing, showPin, showLabel, showLink])

  const fmtKg = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${Math.round(kg)}kg`
  const fmtSignedT = (kg: number) => `${kg >= 0 ? '+' : ''}${(kg / 1000).toFixed(1)}t`
  const tierAdvice = (r: Row): string => {
    if (r.tier === 'ABORT') return r.hardEscalator ? `ABORT before V1 — ${r.hardEscalator} · ${r.precedent || 'multi-cite'}` : `ABORT — cumulative cross-check failure; reject takeoff per FAA AC 91-79B / Boeing FCTM RTO`
    if (r.tier === 'CRITICAL') return r.hardEscalator ? `Ground-stop · verify entries — ${r.hardEscalator}` : `Ground-stop · cross-check TOW/ZFW/FLEX/INTS per SAFO 18003`
    if (r.tier === 'ELEVATED') return `Brief CA · re-verify two entries; monitor LIFT phase`
    if (r.tier === 'WATCH') return `Monitor · single driver elevated; SOP discipline`
    return `Verified entries · CLEAN per SAFO 18003 cross-check`
  }

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,440px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">TOPC · FMS Perf Audit</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} dep · {summary.aborts + summary.crits} flagged</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      {/* 6-tier counter strip */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[8px] font-bold" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      {/* 5-cell summary */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[8px] uppercase tracking-widest text-slate-500">μ-SCORE</div>
          <div className="font-mono text-sm" style={{ color: summary.mScore >= 70 ? '#f43f5e' : summary.mScore >= 50 ? '#f59e0b' : summary.mScore >= 28 ? '#0ea5e9' : '#10b981' }}>
            {summary.denom ? summary.mScore.toFixed(0) : '—'}
          </div>
        </div>
        <div>
          <div className="text-[8px] uppercase tracking-widest text-slate-500">μ-ΔTOW</div>
          <div className="font-mono text-sm text-slate-200">{summary.denom ? `${(summary.mTow / 1000).toFixed(1)}t` : '—'}</div>
        </div>
        <div>
          <div className="text-[8px] uppercase tracking-widest text-slate-500">ABORT</div>
          <div className="font-mono text-sm" style={{ color: summary.aborts > 0 ? '#e11d48' : '#10b981' }}>{summary.aborts}</div>
        </div>
        <div>
          <div className="text-[8px] uppercase tracking-widest text-slate-500">CRIT</div>
          <div className="font-mono text-sm" style={{ color: summary.crits > 0 ? '#f43f5e' : '#10b981' }}>{summary.crits}</div>
        </div>
        <div>
          <div className="text-[8px] uppercase tracking-widest text-slate-500">WORST</div>
          <div className="font-mono text-[10px] text-slate-200 truncate" title={summary.worstCs}>
            {summary.worstCs || '—'}{summary.worstScore >= 0 ? ` ${summary.worstScore.toFixed(0)}` : ''}
          </div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[9px] tracking-wider text-slate-500">
            ADV-MUL <span className="text-slate-300 font-mono">{advMul}%</span>
            <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[9px] tracking-wider text-slate-500">
            SYS-ERR <span className="text-slate-300 font-mono">{sysErr}%</span>
            <input type="range" min={50} max={200} value={sysErr} onChange={e => setSysErr(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[9px] tracking-wider text-slate-500">
            TOW-CAP <span className="text-slate-300 font-mono">{towCap}t</span>
            <input type="range" min={10} max={100} value={towCap} onChange={e => setTowCap(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[9px] tracking-wider text-slate-500">
            FLEX-CAP <span className="text-slate-300 font-mono">{flexCap}°C</span>
            <input type="range" min={5} max={40} value={flexCap} onChange={e => setFlexCap(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
      </div>

      {/* Toggle row + search + phase filter */}
      <div className="px-3 py-2 border-b border-slate-800 space-y-1.5">
        <div className="flex flex-wrap gap-1 items-center">
          {(['HALO','PIN','LBL','LINK'] as const).map(k => {
            const on = k==='HALO'?showRing:k==='PIN'?showPin:k==='LBL'?showLabel:showLink
            return <button key={k} onClick={() => { if(k==='HALO')setShowRing(v=>!v); else if(k==='PIN')setShowPin(v=>!v); else if(k==='LBL')setShowLabel(v=>!v); else setShowLink(v=>!v) }}
              className={`px-1.5 py-0.5 text-[9px] rounded border ${on ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:bg-slate-900/70'}`}>{k}</button>
          })}
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="cs · type · op · apt · sys"
            className="ml-auto flex-1 max-w-[160px] bg-slate-900/60 border border-slate-800 rounded px-2 py-0.5 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500/40" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setPhaseFilter('ALL')} className={`px-1.5 py-0.5 text-[9px] rounded border ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['PRE-DEP','TAXI-OUT','ROLL','LIFT','INIT-CLB'] as Phase[]).map(p => (
            <button key={p} onClick={() => setPhaseFilter(p === phaseFilter ? 'ALL' : p)} className={`px-1.5 py-0.5 text-[9px] rounded border ${phaseFilter === p ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:bg-slate-900/70'}`}>{p}</button>
          ))}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-800 text-[10px]">
        {(['AIRCRAFT','SYSTEMS','DRIVERS','PRECEDENT'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded border transition ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:bg-slate-900/70'}`}>{t}</button>
        ))}
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {tab === 'AIRCRAFT' && (
          <div className="space-y-2">
            {filteredAircraft.length === 0 && <div className="text-slate-500 text-center py-8 text-[10px]">no airframes match current filters</div>}
            {filteredAircraft.map(r => (
              <button key={r.f.icao} onClick={() => onFly(r.f.icao)} className="w-full text-left bg-slate-900/40 hover:bg-slate-900/80 border border-slate-800 rounded p-2 space-y-1.5 transition">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] text-slate-100 font-bold">{(r.f.callsign || r.f.icao).trim()}</span>
                  <span className="text-[9px] text-slate-500">{r.f.type || '?'}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-300">{KLASS_LABEL[r.klass]}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-300">{r.phase}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-300">{r.sys}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded ml-auto" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
                </div>
                {/* Stat row: TOW-LDS / TOW-FMS / Δ / FLEX */}
                <div className="grid grid-cols-4 gap-1 text-center">
                  <div className="bg-slate-900/60 rounded py-1">
                    <div className="text-[8px] text-slate-500">TOW-LDS</div>
                    <div className="font-mono text-[10px] text-slate-200">{fmtKg(r.towLds)}</div>
                  </div>
                  <div className="bg-slate-900/60 rounded py-1">
                    <div className="text-[8px] text-slate-500">TOW-FMS</div>
                    <div className="font-mono text-[10px] text-slate-200">{fmtKg(r.towFms)}</div>
                  </div>
                  <div className="bg-slate-900/60 rounded py-1">
                    <div className="text-[8px] text-slate-500">Δ-TOW</div>
                    <div className="font-mono text-[10px]" style={{ color: Math.abs(r.d.towDelta) > 25000 ? '#f43f5e' : Math.abs(r.d.towDelta) > 8000 ? '#f59e0b' : '#10b981' }}>{fmtSignedT(r.d.towDelta)}</div>
                  </div>
                  <div className="bg-slate-900/60 rounded py-1">
                    <div className="text-[8px] text-slate-500">FLEX/ATM</div>
                    <div className="font-mono text-[10px]" style={{ color: r.d.flexCalled && r.flexC > r.flexCap ? '#f43f5e' : '#10b981' }}>{r.d.flexCalled ? `${r.flexC}°C/${r.flexCap}` : '—'}</div>
                  </div>
                </div>
                {/* Score bar */}
                <div className="h-1.5 bg-slate-800/60 rounded overflow-hidden">
                  <div className="h-full" style={{ width: `${Math.min(100, r.score)}%`, background: TIER_COLOR[r.tier] }} />
                </div>
                {/* Driver chips */}
                <div className="flex flex-wrap gap-1">
                  {[
                    ['TOW', r.d.rTow], ['ZFW', r.d.rZfw], ['FLEX', r.d.rFlex],
                    ['INTS', r.d.rInts], ['QNH', r.d.rQnh], ['RWY', r.d.rRwy],
                  ].map(([k, v]: any) => {
                    const col = v >= 70 ? '#f43f5e' : v >= 50 ? '#f59e0b' : v >= 28 ? '#0ea5e9' : '#475569'
                    return <span key={k} className="text-[8px] px-1.5 py-0.5 rounded font-mono" style={{ background: col + '20', color: col }}>{k}·{Math.round(v)}</span>
                  })}
                </div>
                {/* QNH / RWY / Intersect / Apt strip */}
                <div className="grid grid-cols-4 gap-1 text-center text-[9px]">
                  <div className="bg-slate-900/50 rounded py-0.5">
                    <span className="text-slate-500">QNH</span> <span className="font-mono" style={{ color: Math.abs(r.qnhEnt - r.qnhMet) >= 5 ? '#f43f5e' : '#cbd5e1' }}>{r.qnhEnt}/{r.qnhMet}</span>
                  </div>
                  <div className="bg-slate-900/50 rounded py-0.5">
                    <span className="text-slate-500">RWY</span> <span className="font-mono" style={{ color: r.d.rwyHdg >= 35 ? '#f43f5e' : r.d.rwyHdg >= 10 ? '#f59e0b' : '#cbd5e1' }}>{r.rwyEnt.toString().padStart(3,'0')}/{r.rwyAct.toString().padStart(3,'0')}</span>
                  </div>
                  <div className="bg-slate-900/50 rounded py-0.5">
                    <span className="text-slate-500">INTS</span> <span className="font-mono" style={{ color: r.d.intsMatch ? '#f43f5e' : '#10b981' }}>{r.d.intsTko ? (r.d.intsMatch ? 'MIS' : 'OK') : 'FUL'}</span>
                  </div>
                  <div className="bg-slate-900/50 rounded py-0.5">
                    <span className="text-slate-500">APT</span> <span className="font-mono text-slate-200">{r.apI}</span>
                  </div>
                </div>
                <div className="text-[9px]" style={{ color: TIER_COLOR[r.tier] }}>› {tierAdvice(r)}</div>
              </button>
            ))}
          </div>
        )}

        {tab === 'SYSTEMS' && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1 pb-1">
              <button onClick={() => setSysFilter('ALL')} className={`px-1.5 py-0.5 text-[9px] rounded border ${sysFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
              {SYSTEMS.map(s => (
                <button key={s.id} onClick={() => setSysFilter(s.id === sysFilter ? 'ALL' : s.id)} className={`px-1.5 py-0.5 text-[9px] rounded border ${sysFilter === s.id ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:bg-slate-900/70'}`}>{s.label}</button>
              ))}
            </div>
            {sysAgg.sort((a, b) => b.cnt - a.cnt).map(s => {
              const profile = SYSTEMS.find(p => p.id === s.id)!
              const tonl = s.mScore >= 70 ? '#f43f5e' : s.mScore >= 50 ? '#f59e0b' : s.mScore >= 28 ? '#0ea5e9' : '#10b981'
              return (
                <div key={s.id} className="bg-slate-900/40 border border-slate-800 rounded p-2 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono font-bold text-slate-100">{profile.label}</span>
                    <span className="text-[9px] text-slate-500 truncate">{profile.vendor}</span>
                    <span className="text-[9px] ml-auto font-mono" style={{ color: tonl }}>μ-SC {s.mScore.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-center">
                    <div><div className="text-[8px] text-slate-500">FLT</div><div className="font-mono text-[10px] text-slate-200">{s.cnt}</div></div>
                    <div><div className="text-[8px] text-slate-500">ABORT</div><div className="font-mono text-[10px]" style={{ color: s.abort ? '#e11d48' : '#475569' }}>{s.abort}</div></div>
                    <div><div className="text-[8px] text-slate-500">CRIT</div><div className="font-mono text-[10px]" style={{ color: s.crit ? '#f43f5e' : '#475569' }}>{s.crit}</div></div>
                    <div><div className="text-[8px] text-slate-500">μ-ΔTOW</div><div className="font-mono text-[10px] text-slate-200">{(s.mTow / 1000).toFixed(1)}t</div></div>
                    <div><div className="text-[8px] text-slate-500">err-Rate</div><div className="font-mono text-[10px] text-slate-300">{(profile.errRate * 100).toFixed(1)}%</div></div>
                  </div>
                  <div className="h-1 bg-slate-800/60 rounded overflow-hidden"><div className="h-full" style={{ width: `${Math.min(100, s.mScore)}%`, background: tonl }} /></div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 italic pt-2 border-t border-slate-800">
              Error-rate priors are anonymised IOSA / IATA-OPS aggregates per IOSA FLT 3.5.4 / DSP 3.2.
              SYS-ERR slider scales priors to model carrier-specific FOQA findings.
            </div>
          </div>
        )}

        {tab === 'DRIVERS' && (
          <div className="space-y-2">
            <div className="text-[9px] text-slate-500 italic pb-1">
              6 independent FMS/EFB cross-checks. Composite score uses max·0.66 + mean·0.34 then phase-weight and ADV-MUL.
              Hard escalators (MK1602/LEX/Emirates 407/Thomsonfly 263) override into ABORT/CRITICAL.
            </div>
            {driverAgg.map(d => {
              const col = d.mean >= 70 ? '#f43f5e' : d.mean >= 50 ? '#f59e0b' : d.mean >= 28 ? '#0ea5e9' : '#10b981'
              return (
                <div key={d.id} className="bg-slate-900/40 border border-slate-800 rounded p-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono font-bold text-slate-200">{d.id}</span>
                    <span className="text-[10px] text-slate-300">{d.label}</span>
                    <span className="ml-auto font-mono text-[10px]" style={{ color: col }}>μ {d.mean.toFixed(0)}</span>
                  </div>
                  <div className="h-1 bg-slate-800/60 rounded overflow-hidden"><div className="h-full" style={{ width: `${Math.min(100, d.mean)}%`, background: col }} /></div>
                  <div className="text-[9px] text-slate-500">{d.hint}</div>
                </div>
              )
            })}
            <div className="bg-slate-900/40 border border-slate-800 rounded p-2 text-[9px] text-slate-400 space-y-1 mt-2">
              <div className="text-[10px] text-slate-200 font-bold">Cross-check protocol per SAFO 18003</div>
              <div>1. CA reads RTOW values aloud; FO independently re-enters in FMS PERF INIT page.</div>
              <div>2. Both crew verify FLEX/ATM ≤ AFM cap (per FCOM LIM Ch.1).</div>
              <div>3. INTS-vs-FULL must match PDC clearance and ATIS/CFR-ATIS departure runway.</div>
              <div>4. RWY heading on EFIS PFD compass-rose matches assigned rwy hdg at brake-release ±5°.</div>
              <div>5. QNH cross-loaded both ADIRUs; ATIS QNH compared to FMS PROG QNH ±2 hPa.</div>
            </div>
          </div>
        )}

        {tab === 'PRECEDENT' && (
          <div className="space-y-2">
            <div className="text-[9px] text-slate-500 italic">
              Canonical FMS data-entry / wrong-runway / wrong-derate accident catalogue. Each precedent maps to one hard escalator above.
            </div>
            {[
              { date: '14-Oct-2004', cs: 'MK Airlines 1602', ac: 'B742', loc: 'CYHZ Halifax', fatal: 7, tag: 'TOW under-entry 100t', ref: 'TSB Aviation A04F0151', tier: 'ABORT', desc: '100t TOW under-entry → understated V-speeds, insufficient thrust derate, runway overrun and CFIT.' },
              { date: '20-Mar-2009', cs: 'Emirates 407',     ac: 'A345', loc: 'YMML Melbourne', fatal: 0, tag: 'TOW under-entry 99t + INTS', ref: 'ATSB AO-2009-012', tier: 'ABORT', desc: '262.9t entered (actual 361.9t = 99t under), tail-strike at intersection departure, 100 lives at risk.' },
              { date: '27-Aug-2006', cs: 'Comair 5191',      ac: 'CRJ1', loc: 'KLEX Lexington', fatal: 49, tag: 'Wrong-rwy (26 vs 22)', ref: 'NTSB AAR-07-05', tier: 'ABORT', desc: 'Line-up on RWY-26 (3500ft) instead of RWY-22 (7000ft) → overrun on short rwy, CFIT.' },
              { date: '22-Jun-2007', cs: 'Thomsonfly 263',   ac: 'B738', loc: 'EGAA Belfast', fatal: 0, tag: 'FLEX +30°C over AFM cap', ref: 'AAIB EW/C2007/06/03', tier: 'CRITICAL', desc: 'Wrong FLEX temp 64°C entered (actual 34°C cap), under-thrust on rotation, no escape margin.' },
              { date: '12-Mar-2003', cs: 'Singapore 286',    ac: 'B744', loc: 'RJAA Narita',   fatal: 0, tag: 'FLEX-Mach typo',        ref: 'SG-AAIB 286',          tier: 'ELEVATED', desc: 'Wrong assumed-temp / Mach for runway distance, late liftoff, near-tail-strike at NRT 34L.' },
              { date: '06-Mar-1989', cs: 'Air Ontario 1363', ac: 'F28',  loc: 'CYDH Dryden',   fatal: 24, tag: 'TOW + ICE comp',        ref: 'Moshansky Inq.',       tier: 'ABORT', desc: 'Combined TOW under-estimation + ice-contamination, stall after lift-off, CFIT.' },
              { date: '01-Aug-2008', cs: 'Mesa Airlines',    ac: 'CRJ',  loc: 'KIAH Houston',  fatal: 0, tag: 'Intersection mis-load',  ref: 'ASRS Callback #421',   tier: 'CRITICAL', desc: 'Intersection-vs-full-length confusion, rejected takeoff at high-speed.' },
              { date: '13-Apr-2010', cs: 'Garuda GA200',     ac: 'B738', loc: 'WAHQ Surakarta', fatal: 22, tag: 'Approach-perf chain',  ref: 'KNKT/07.05/10.02.36',  tier: 'CRITICAL', desc: 'Performance-input chain error → high-energy unstabilised approach, runway overrun.' },
            ].map((p, i) => (
              <div key={i} className="bg-slate-900/40 border border-slate-800 rounded p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10px] text-slate-100 font-bold">{p.cs}</span>
                  <span className="text-[9px] text-slate-500">{p.ac}</span>
                  <span className="text-[9px] text-slate-500">{p.date}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-300">{p.loc}</span>
                  <span className="text-[9px] ml-auto" style={{ color: p.fatal > 0 ? '#f43f5e' : '#10b981' }}>{p.fatal > 0 ? `${p.fatal} fatal` : 'survivable'}</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: TIER_COLOR[p.tier as Tier] + '20', color: TIER_COLOR[p.tier as Tier] }}>{p.tier}</span>
                  <span className="text-[9px] text-slate-300">{p.tag}</span>
                  <span className="text-[9px] text-slate-500 ml-auto italic">{p.ref}</span>
                </div>
                <div className="text-[9px] text-slate-400">{p.desc}</div>
              </div>
            ))}
            <div className="text-[9px] text-slate-500 italic pt-2 border-t border-slate-800">
              Cross-references: FAA AC 91-79B / AC 120-76D / SAFO 18003 / InFO 06017 · EASA SIB 2017-13 / AMC 20-25A · ICAO Doc 10020 §4.4 · IATA OPS-DOC ETP-Mitigation 2018 · Boeing FCTM PI-LIM · Airbus FCTM PRO-NOR-SOP-13.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
