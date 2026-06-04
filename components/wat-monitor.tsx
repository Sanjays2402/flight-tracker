'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   WAT · Weight / Altitude / Temperature Takeoff Climb-Limit
   & Hot-and-High Performance Envelope Monitor
   ------------------------------------------------------------
   FAR 25.121 climb-gradient certification:
     1st segment  (gear down, OEI)         ≥ 0.0%  2-eng / 0.3% 3 / 0.5% 4
     2nd segment  (gear up, OEI, V2)       ≥ 2.4%  2-eng / 2.7% 3 / 3.0% 4
     final segm.  (en-route OEI, MCT)      ≥ 1.2%  2-eng / 1.5% 3 / 1.7% 4
     approach     (gear up, OEI)           ≥ 2.1%  2-eng / 2.4% 3 / 2.7% 4
     landing      (gear down, OEI)         ≥ 3.2%
   2nd-segment is the dominant WAT-limit for hot/high departures
   per Airbus FPOM 3.04 & Boeing PI-22 — limits MTOW well below
   structural MTOW once PA > 5000 ft and OAT > ISA+15.

   References:
     · FAR 25.121 OEI climb performance
     · FAR 25.111 takeoff path
     · ICAO Annex 6 Pt I §4.2.3 takeoff performance
     · ICAO Doc 9613 PBN §5 obstacle accountability
     · FAA AC 25-7D Flight Test Guide §4 climb performance
     · FAA AC 120-91A airport obstacle analysis
     · FAA Order 8900.1 vol.4 ch.2 §1 takeoff alternates
     · EASA CS-25.121 climb-gradient certification
     · EASA AMC 25-13 reduced & assumed-temperature thrust
     · Boeing FCOM PI-22 climb-limit weight tables
     · Boeing FCTM 3.20 hot-and-high operations
     · Airbus FPOM 3.04 WAT-limit performance
     · Airbus Getting-to-Grips with Aircraft Performance §6
     · IATA IOSA FLT 3.2 takeoff performance verification
     · UK CAA CAP 698 §4 OEI obstacle clearance
     · NTSB AAR-89-04 USAir 5050 LGA OEI rotation
     · NTSB AAR-09-01 Continental 1404 KDEN crosswind
     · BFU 02-09 LH B744 hot-day MTOW exceedance
     · AAIB Bulletin 5/2004 Airbus A320 contaminated WAT
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}
interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'WAT-LIMIT' | 'CLIMB-CRIT' | 'DERATE-BUST' | 'WATCH' | 'OK' | 'IDLE'
const TIER_COLOR: Record<Tier, string> = {
  'WAT-LIMIT': '#ef4444', 'CLIMB-CRIT': '#f43f5e', 'DERATE-BUST': '#f59e0b',
  WATCH: '#0ea5e9', OK: '#10b981', IDLE: '#64748b',
}
const TIER_ORDER: Tier[] = ['WAT-LIMIT', 'CLIMB-CRIT', 'DERATE-BUST', 'WATCH', 'OK']
const TIER_RANK: Record<Tier, number> = { 'WAT-LIMIT': 0, 'CLIMB-CRIT': 1, 'DERATE-BUST': 2, WATCH: 3, OK: 4, IDLE: 5 }

type Klass = 'HVY-Q' | 'HVY' | 'NRW' | 'RGN' | 'BIZ' | 'TBP'
const KLASS_COLOR: Record<Klass, string> = {
  'HVY-Q': '#a855f7', HVY: '#8b5cf6', NRW: '#0ea5e9', RGN: '#22d3ee', BIZ: '#10b981', TBP: '#f59e0b',
}

interface KlassPerf {
  // structural MTOW kg
  mtowKg: number
  // 2nd-segment certified gradient floor (FAR 25.121b)
  grad2pct: number
  // engines: 2 / 3 / 4
  engN: 2 | 3 | 4
  // baseline V2 KIAS at ISA/SL/MTOW
  v2Kts: number
  // tire-speed limit kt (groundspeed)
  tireKts: number
  // brake-energy RTO limit (MJ) per AC 25-7D
  brakeMj: number
  // ISA-deviation penalty %MTOW per °C above ISA at sea-level (linear)
  isaPenPct: number
  // pressure-altitude penalty %MTOW per 1000 ft PA above SL
  paPenPct: number
  // anti-ice ON cost in %MTOW (engine bleed + cowl)
  aiCostPct: number
  examples: string
}
const KLASS: Record<Klass, KlassPerf> = {
  'HVY-Q': { mtowKg: 575000, grad2pct: 3.0, engN: 4, v2Kts: 168, tireKts: 215, brakeMj: 285, isaPenPct: 0.45, paPenPct: 1.40, aiCostPct: 0.9, examples: 'B748 A380' },
  HVY:     { mtowKg: 351500, grad2pct: 2.4, engN: 2, v2Kts: 162, tireKts: 204, brakeMj: 200, isaPenPct: 0.55, paPenPct: 1.85, aiCostPct: 1.2, examples: 'B777 B787 A350 A330' },
  NRW:     { mtowKg:  79000, grad2pct: 2.4, engN: 2, v2Kts: 148, tireKts: 195, brakeMj: 100, isaPenPct: 0.70, paPenPct: 2.30, aiCostPct: 1.5, examples: 'B737 A320 B757 BCS' },
  RGN:     { mtowKg:  42000, grad2pct: 2.4, engN: 2, v2Kts: 138, tireKts: 182, brakeMj:  62, isaPenPct: 0.80, paPenPct: 2.70, aiCostPct: 1.7, examples: 'CRJ E-Jet' },
  BIZ:     { mtowKg:  45000, grad2pct: 2.4, engN: 2, v2Kts: 132, tireKts: 190, brakeMj:  55, isaPenPct: 0.75, paPenPct: 2.40, aiCostPct: 1.4, examples: 'GLF FA7X CL30' },
  TBP:     { mtowKg:  23000, grad2pct: 2.4, engN: 2, v2Kts: 118, tireKts: 165, brakeMj:  32, isaPenPct: 0.95, paPenPct: 3.10, aiCostPct: 1.9, examples: 'ATR Q400 DH8' },
}

function classify(type: string | undefined): Klass {
  const t = (type || '').toUpperCase()
  if (/^(A38[0-9]|B74[0-9])$/.test(t)) return 'HVY-Q'
  if (/^(B77[0-9]|B78[0-9]|A35[0-9]|A33[0-9]|A340|MD11|B767)$/.test(t)) return 'HVY'
  if (/^(B73[0-9]|B7M[78]|A32[0-9]|A31[89]|B757|A22[01]|A21N|A20N|A19N|BCS[123])$/.test(t)) return 'NRW'
  if (/^(CRJ[0-9]+|E[12-9][0-9]{2}|E170|E175|E190|E195)$/.test(t)) return 'RGN'
  if (/^(GLF[0-9]|G[2-7][0-9]{2}|FA[0-9X]+|CL[0-9]+|C[5-7][0-9]{2}|PC[0-9]+|HDJT|LJ[0-9]+)$/.test(t)) return 'BIZ'
  if (/^(SF34|JS3[12]|J3[12]|PC12|C208|BE[0-9]+|DH8[A-D]|AT4[2-7]|AT7[2-6])$/.test(t)) return 'TBP'
  return 'NRW'
}

/* ---- Hot-and-high airport catalogue (28) ---- */
interface HhAp {
  icao: string; name: string; lat: number; lng: number; elevFt: number
  /** Tower elevation severity: HOT (≥5000ft or extreme summer), MID (3-5kft), STD (<3kft) */
  sev: 'HOT' | 'MID' | 'STD'
  /** Climatological ISA-deviation in °C for current ops bias (mid-summer afternoon) */
  isaDev: number
  /** Longest TORA ft */
  toraFt: number
  /** Obstacle climb requirement (4%/3.3%/2.5% net) — limits derate use */
  obsPct: number
}
const HH: HhAp[] = [
  { icao: 'SLLP', name: 'La Paz El Alto',          lat:-16.513, lng: -68.192, elevFt: 13325, sev: 'HOT', isaDev:  5, toraFt: 13123, obsPct: 4.0 },
  { icao: 'SPJC', name: 'Cusco',                   lat:-13.536, lng: -71.939, elevFt: 10860, sev: 'HOT', isaDev:  8, toraFt: 11148, obsPct: 4.0 },
  { icao: 'SEQM', name: 'Quito Mariscal-Sucre',    lat: -0.129, lng: -78.358, elevFt:  7841, sev: 'HOT', isaDev: 10, toraFt: 13468, obsPct: 4.0 },
  { icao: 'SKBO', name: 'Bogotá El Dorado',        lat:  4.701, lng: -74.146, elevFt:  8361, sev: 'HOT', isaDev:  8, toraFt: 12467, obsPct: 3.3 },
  { icao: 'MMMX', name: 'Mexico City Benito Juárez', lat: 19.435, lng: -99.072, elevFt: 7316, sev: 'HOT', isaDev: 13, toraFt: 12966, obsPct: 4.0 },
  { icao: 'MMTO', name: 'Toluca',                  lat: 19.337, lng: -99.566, elevFt:  8466, sev: 'HOT', isaDev: 13, toraFt: 14111, obsPct: 4.0 },
  { icao: 'KDEN', name: 'Denver',                  lat: 39.862, lng:-104.673, elevFt:  5434, sev: 'HOT', isaDev: 18, toraFt: 16000, obsPct: 2.5 },
  { icao: 'KASE', name: 'Aspen Pitkin',            lat: 39.223, lng:-106.869, elevFt:  7820, sev: 'HOT', isaDev: 15, toraFt:  8006, obsPct: 4.0 },
  { icao: 'KTEX', name: 'Telluride',               lat: 37.954, lng:-107.909, elevFt:  9078, sev: 'HOT', isaDev: 14, toraFt:  7111, obsPct: 4.0 },
  { icao: 'KEGE', name: 'Eagle Vail',              lat: 39.643, lng:-106.918, elevFt:  6548, sev: 'HOT', isaDev: 15, toraFt:  9000, obsPct: 4.0 },
  { icao: 'KJAC', name: 'Jackson Hole',            lat: 43.607, lng:-110.738, elevFt:  6451, sev: 'HOT', isaDev: 14, toraFt:  6299, obsPct: 4.0 },
  { icao: 'KSLC', name: 'Salt Lake City',          lat: 40.788, lng:-111.978, elevFt:  4227, sev: 'MID', isaDev: 17, toraFt: 12003, obsPct: 2.5 },
  { icao: 'KPHX', name: 'Phoenix Sky Harbor',      lat: 33.434, lng:-112.012, elevFt:  1135, sev: 'STD', isaDev: 24, toraFt: 11489, obsPct: 2.5 },
  { icao: 'KLAS', name: 'Las Vegas Harry Reid',    lat: 36.080, lng:-115.152, elevFt:  2181, sev: 'STD', isaDev: 22, toraFt: 14512, obsPct: 2.5 },
  { icao: 'KABQ', name: 'Albuquerque Sunport',     lat: 35.040, lng:-106.609, elevFt:  5355, sev: 'HOT', isaDev: 18, toraFt: 13793, obsPct: 3.3 },
  { icao: 'KEKO', name: 'Elko',                    lat: 40.825, lng:-115.792, elevFt:  5141, sev: 'HOT', isaDev: 17, toraFt:  7140, obsPct: 4.0 },
  { icao: 'OTHH', name: 'Doha Hamad',              lat: 25.273, lng:  51.608, elevFt:    13, sev: 'STD', isaDev: 26, toraFt: 14760, obsPct: 2.5 },
  { icao: 'OMDB', name: 'Dubai International',     lat: 25.253, lng:  55.364, elevFt:    62, sev: 'STD', isaDev: 25, toraFt: 13123, obsPct: 2.5 },
  { icao: 'OMAA', name: 'Abu Dhabi',               lat: 24.433, lng:  54.651, elevFt:    88, sev: 'STD', isaDev: 24, toraFt: 13451, obsPct: 2.5 },
  { icao: 'OERK', name: 'Riyadh King Khalid',      lat: 24.957, lng:  46.699, elevFt:  2049, sev: 'MID', isaDev: 22, toraFt: 13796, obsPct: 2.5 },
  { icao: 'OEJN', name: 'Jeddah King Abdulaziz',   lat: 21.679, lng:  39.156, elevFt:    48, sev: 'STD', isaDev: 23, toraFt: 13452, obsPct: 2.5 },
  { icao: 'HAAB', name: 'Addis Ababa Bole',        lat:  8.978, lng:  38.799, elevFt:  7657, sev: 'HOT', isaDev: 10, toraFt: 13123, obsPct: 3.3 },
  { icao: 'HKJK', name: 'Nairobi Jomo Kenyatta',   lat: -1.319, lng:  36.928, elevFt:  5330, sev: 'HOT', isaDev: 10, toraFt: 13507, obsPct: 3.3 },
  { icao: 'FAJS', name: 'Johannesburg OR Tambo',   lat:-26.139, lng:  28.246, elevFt:  5558, sev: 'HOT', isaDev: 12, toraFt: 14495, obsPct: 3.3 },
  { icao: 'FAOR', name: 'Pretoria Wonderboom',     lat:-25.654, lng:  28.224, elevFt:  4095, sev: 'MID', isaDev: 12, toraFt:  5577, obsPct: 4.0 },
  { icao: 'VEPF', name: 'Paro Bhutan',             lat: 27.403, lng:  89.425, elevFt:  7333, sev: 'HOT', isaDev: 12, toraFt:  7431, obsPct: 4.0 },
  { icao: 'VILH', name: 'Leh Kushok-Bakula',       lat: 34.136, lng:  77.546, elevFt: 10682, sev: 'HOT', isaDev:  8, toraFt:  9059, obsPct: 4.0 },
  { icao: 'ZULS', name: 'Lhasa Gonggar',           lat: 29.298, lng:  90.912, elevFt: 11713, sev: 'HOT', isaDev:  6, toraFt: 13123, obsPct: 4.0 },
]

/* ---- Math helpers ---- */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const ramp  = (v: number, a: number, b: number) => clamp((v - a) / (b - a), 0, 1) * 100

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0 }
  return h >>> 0
}
function hashU(s: string): number { return (fnv1a(s) % 10000) / 10000 }

function nm(a: SFlight, b: { lat: number; lng: number }): number {
  const R = 3440.065
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

type Phase = 'ROTATE' | 'CLIMB1' | 'CLIMB2' | 'CLIMB3' | 'IDLE'
function phase(f: SFlight, apElev: number): Phase {
  const haa = f.altitudeFt - apElev
  if (f.ground) return 'IDLE'
  if (haa < 35) return 'ROTATE'
  if (haa < 400) return 'CLIMB1'    // 1st segment (gear retracting)
  if (haa < 1500) return 'CLIMB2'   // 2nd segment (V2, gear up) — WAT-critical
  if (haa < 3000) return 'CLIMB3'   // accel / 3rd / final segment
  return 'IDLE'
}

/* ---- Per-airframe WAT eval ---- */
interface Drv { GRD: number; MTW: number; ISA: number; PA: number; OBS: number; TIR: number }
interface Ev {
  f: SFlight; klass: Klass; ap?: HhAp; phase: Phase
  oat: number; isaDev: number; pa: number
  rotwKg: number; mtowKg: number; mtowMargin: number
  gradActPct: number; gradReqPct: number; gradDeltaPct: number
  gsKts: number; tireKts: number; tireMarginKts: number
  derate: 'TOGA' | 'D-TO' | 'ATM' | 'D-TO2'
  derateBust: boolean
  brakeMj: number; brakeReqMj: number
  antiIceOn: boolean
  score: number; tier: Tier; advice: string
  drv: Drv
}

function evaluate(flights: SFlight[], scope: number, ovat: number, mtowBias: number, advMul: number, minHaa: number, maxHaa: number): Ev[] {
  const out: Ev[] = []
  for (const f of flights) {
    if (f.ground) continue
    let ap: HhAp | undefined
    let best = scope
    for (const a of HH) {
      const d = nm(f, a)
      if (d < best) { best = d; ap = a }
    }
    if (!ap) continue
    const haa = f.altitudeFt - ap.elevFt
    if (haa < minHaa || haa > maxHaa) continue
    const ph = phase(f, ap.elevFt)
    if (ph === 'IDLE') continue

    const klass = classify(f.type)
    const k = KLASS[klass]

    // Synthetic OAT for this airport (mid-summer climatological bias + per-flight wobble + slider)
    const h = hashU(`${f.icao}|${ap.icao}|wat`)
    const isaDev = ap.isaDev + ovat + (h * 8 - 4) // -4..+4°C scatter
    const isaSL = 15 - 0.00198 * ap.elevFt
    const oat = isaSL + isaDev

    // Pressure altitude (assume QNH=1013, PA = field elev)
    const pa = ap.elevFt

    // WAT-limit MTOW for current conditions
    // MTOW = struct × [1 - PA-penalty - ISA-penalty - AI-penalty]
    const aiOn = h > 0.55 && oat < 12  // unlikely AI-on at hot/high
    const mtowPenPct = (pa / 1000) * k.paPenPct + Math.max(0, isaDev) * k.isaPenPct + (aiOn ? k.aiCostPct : 0)
    const mtowKg = Math.max(k.mtowKg * 0.55, k.mtowKg * (1 - mtowPenPct / 100))

    // Synthetic actual ROTOW = MTOW × (random 0.78..1.04 + bias)
    const rotwFrac = 0.78 + h * 0.26 + (mtowBias / 100)
    const rotwKg = k.mtowKg * clamp(rotwFrac, 0.5, 1.05)
    const mtowMargin = mtowKg - rotwKg

    // Actual gradient achieved (deduced from observed vertical speed & groundspeed)
    // grad% = VS / (GS×fpm-per-kt) × 100, fpm-per-kt = 101.27 (1 NM/min @ 60kt = 6076 fpm? no — use slope)
    // grad% = (VS fpm / 60) / (GS knots × 6076/3600 ft/s per knot) ≈ VS / (GS × 101.27) × 100
    const gsKts = Math.max(80, f.velocityKts || k.v2Kts + 20)
    const gradActPct = (Math.max(0, f.vertRate) / (gsKts * 101.27)) * 100

    // Required gradient: 2nd-seg floor + obstacle-segment penalty when CLIMB2 in obstacle airport
    const gradReqPct = ph === 'CLIMB2' ? Math.max(k.grad2pct, ap.obsPct - 0.8 /* gross-to-net */) : ph === 'CLIMB1' ? 0.5 : 1.2
    const gradDeltaPct = gradActPct - gradReqPct

    // Tire-speed margin (groundspeed should be ≤ tire-limit)
    const tireMarginKts = k.tireKts - gsKts

    // Derate / assumed-temp selection: high obstacle airports require TOGA
    const derate: Ev['derate'] = ap.obsPct >= 4.0 ? 'TOGA' : ap.obsPct >= 3.3 ? (h > 0.4 ? 'D-TO' : 'TOGA') : (h > 0.6 ? 'ATM' : (h > 0.3 ? 'D-TO' : 'TOGA'))
    // Derate bust: airport requires TOGA but derate selected
    const derateBust = ap.obsPct >= 4.0 && derate !== 'TOGA'

    // Brake energy on a hot-rejected-takeoff scenario (AC 25-7D — non-critical, monitor only)
    const brakeReqMj = k.brakeMj * 0.85
    const brakeMj = k.brakeMj * (0.55 + h * 0.45) * (1 + isaDev / 250) * (1 + pa / 30000)

    // 6 risk drivers
    const drv: Drv = {
      GRD: ramp(-gradDeltaPct, 0, 2.5),                 // gradient deficit (0% in spec → 100 @ −2.5%)
      MTW: ramp(-mtowMargin, 0, k.mtowKg * 0.05),       // 0 if under MTOW, 100 if 5% over
      ISA: ramp(isaDev, 8, 28),                          // ISA dev — 0 at +8 → 100 at +28
      PA:  ramp(pa, 3000, 12000),                       // pressure-alt 0 at 3k → 100 at 12k
      OBS: derateBust ? 100 : (ap.obsPct >= 4.0 ? 60 : ap.obsPct >= 3.3 ? 35 : 10),
      TIR: ramp(-tireMarginKts, 0, 15),                 // 0 if 15+kt under tire, 100 at limit
    }
    const phaseMul = ph === 'ROTATE' ? 1.30 : ph === 'CLIMB1' ? 1.20 : ph === 'CLIMB2' ? 1.40 : 1.05
    const driverArr = [drv.GRD, drv.MTW, drv.ISA, drv.PA, drv.OBS, drv.TIR]
    const max = Math.max(...driverArr)
    const mean = driverArr.reduce((s, v) => s + v, 0) / driverArr.length
    let score = clamp((max * 0.78 + mean * 0.22) * phaseMul * (advMul / 100), 0, 100)

    // Hard escalations
    if (ph === 'CLIMB2' && gradDeltaPct < -0.5) score = Math.max(score, 88)   // 2nd-seg bust
    if (mtowMargin < 0 && ap.sev === 'HOT') score = Math.max(score, 84)
    if (derateBust) score = Math.max(score, 70)

    let tier: Tier = 'OK'
    let advice = 'WAT envelope nominal · 2nd-seg gradient ≥ FAR 25.121 floor · OEI obstacle clearance assured'
    if (score >= 80 && (mtowMargin < 0 || gradDeltaPct < -0.5)) {
      tier = 'WAT-LIMIT'
      advice = 'WAT-LIMIT MTOW exceeded for current PA/OAT · reduce ROTOW or wait for cooler / lower QNH · cite Boeing PI-22 / Airbus FPOM 3.04'
    } else if (score >= 60 && gradDeltaPct < 0) {
      tier = 'CLIMB-CRIT'
      advice = 'CLIMB-CRIT 2nd-segment gradient deficit · verify V2 / flap / thrust setting per FCOM PI-22 · review OEI EOSID'
    } else if (derateBust || (score >= 38 && drv.OBS >= 50)) {
      tier = 'DERATE-BUST'
      advice = 'DERATE-BUST obstacle airport requires TOGA · de-select assumed-temperature thrust per AMC 25-13'
    } else if (score >= 18) {
      tier = 'WATCH'
      advice = 'WATCH hot/high envelope · cross-check perf calc with current ATIS QNH/OAT per CAP 698 §4'
    }

    out.push({
      f, klass, ap, phase: ph, oat, isaDev, pa, rotwKg, mtowKg, mtowMargin,
      gradActPct, gradReqPct, gradDeltaPct, gsKts, tireKts: k.tireKts, tireMarginKts,
      derate, derateBust, brakeMj, brakeReqMj, antiIceOn: aiOn,
      score, tier, advice, drv,
    })
  }
  out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.score - a.score)
  return out
}

/* ---- Component ---- */
const SRC_HALO='wat-halo', SRC_PIN='wat-pin', SRC_LBL='wat-lbl', SRC_LINK='wat-link', SRC_AP='wat-ap', SRC_ALBL='wat-albl'
const LYR_HALO='wat-halo-l', LYR_PIN='wat-pin-l', LYR_LBL='wat-lbl-l', LYR_LINK='wat-link-l', LYR_AP='wat-ap-l', LYR_ALBL='wat-albl-l'

export default function WatMonitor({ map, flights, onClose, onFly }: Props) {
  const [scope, setScope]   = useState(60)   // nm to airport
  const [ovat, setOvat]     = useState(0)    // OAT bias °C
  const [mtowBias, setMtowBias] = useState(0)  // ROTOW bias % MTOW
  const [advMul, setAdvMul] = useState(100)
  const [minHaa, setMinHaa] = useState(0)
  const [maxHaa, setMaxHaa] = useState(3500)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [sevFilter, setSevFilter] = useState<'ALL'|'HOT'|'MID'|'STD'>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT'|'AIRPORTS'|'CLASSES'>('AIRCRAFT')
  const [query, setQuery] = useState('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin]   = useState(true)
  const [showLbl, setShowLbl]   = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [showAp, setShowAp]     = useState(true)
  const [showDiag, setShowDiag] = useState(true)

  const evals = useMemo(() => evaluate(flights, scope, ovat, mtowBias, advMul, minHaa, maxHaa),
    [flights, scope, ovat, mtowBias, advMul, minHaa, maxHaa])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evals.filter(e => {
      if (klassFilter !== 'ALL' && e.klass !== klassFilter) return false
      if (tierFilter !== 'ALL' && e.tier !== tierFilter) return false
      if (sevFilter !== 'ALL' && e.ap?.sev !== sevFilter) return false
      if (q) {
        const blob = `${e.f.callsign} ${e.f.icao} ${e.f.type} ${e.f.operator} ${e.ap?.icao} ${e.ap?.name}`.toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
  }, [evals, klassFilter, tierFilter, sevFilter, query])

  const tierCount: Record<Tier, number> = { 'WAT-LIMIT': 0, 'CLIMB-CRIT': 0, 'DERATE-BUST': 0, WATCH: 0, OK: 0, IDLE: 0 }
  for (const e of evals) tierCount[e.tier]++
  const meanScore = evals.length ? evals.reduce((s, e) => s + e.score, 0) / evals.length : 0
  const worst = evals[0]
  const overMtow = evals.filter(e => e.mtowMargin < 0).length
  const climbCrit = evals.filter(e => e.gradDeltaPct < 0 && e.phase === 'CLIMB2').length
  const meanIsa = evals.length ? evals.reduce((s, e) => s + e.isaDev, 0) / evals.length : 0

  /* Map layers */
  useEffect(() => {
    if (!map) return
    const ensure = (id: string, type: any, src: string, paint: any, layout: any = {}) => {
      if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as any)
      if (!map.getLayer(id)) map.addLayer({ id, type, source: src, paint, layout } as any)
    }
    ensure(LYR_HALO, 'circle', SRC_HALO, { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 1.2, 'circle-stroke-color': ['get', 'color'] })
    ensure(LYR_PIN,  'circle', SRC_PIN,  { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' })
    ensure(LYR_AP,   'circle', SRC_AP,   { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.55, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' })
    ensure(LYR_LINK, 'line',   SRC_LINK, { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] })
    ensure(LYR_LBL,  'symbol', SRC_LBL,  {}, { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Regular'] })
    ensure(LYR_ALBL, 'symbol', SRC_ALBL, {}, { 'text-field': ['get', 'label'], 'text-size': 9, 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-font': ['Open Sans Regular'] })
    if (map.getLayer(LYR_LBL))  { map.setPaintProperty(LYR_LBL, 'text-color', ['get', 'color']); map.setPaintProperty(LYR_LBL, 'text-halo-color', '#0f172a'); map.setPaintProperty(LYR_LBL, 'text-halo-width', 1.4) }
    if (map.getLayer(LYR_ALBL)) { map.setPaintProperty(LYR_ALBL, 'text-color', '#7dd3fc'); map.setPaintProperty(LYR_ALBL, 'text-halo-color', '#020617'); map.setPaintProperty(LYR_ALBL, 'text-halo-width', 1.4) }

    const ap: any[] = [], albl: any[] = []
    if (showAp) {
      for (const a of HH) {
        const inN = evals.filter(e => e.ap?.icao === a.icao).length
        const col = a.sev === 'HOT' ? '#a855f7' : a.sev === 'MID' ? '#f59e0b' : '#0ea5e9'
        ap.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { color: col, r: 4 + Math.min(inN, 8) * 0.6 } })
        albl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { label: `${a.icao}·${a.elevFt.toLocaleString()}ft${inN?`·${inN}`:''}` } })
      }
    }
    const halo: any[] = [], pin: any[] = [], lbl: any[] = [], link: any[] = []
    for (const e of filtered) {
      const color = TIER_COLOR[e.tier]
      if (showHalo && e.tier !== 'IDLE' && e.tier !== 'OK') halo.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, r: 8 + e.score * 0.14 } })
      if (showPin && (e.tier === 'WAT-LIMIT' || e.tier === 'CLIMB-CRIT')) pin.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color } })
      if (showLbl && e.tier !== 'OK' && e.tier !== 'IDLE') {
        lbl.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.f.lng, e.f.lat] }, properties: { color, label: `${e.f.callsign || e.f.icao} · ${e.ap?.icao || '—'} · Δ${e.gradDeltaPct >= 0 ? '+' : ''}${e.gradDeltaPct.toFixed(1)}% · ${e.tier}` } })
      }
      if (showLink && e.ap && e.tier !== 'OK' && e.tier !== 'IDLE') {
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
  const tcol = (v: number, breaks: [number, string][]) => { for (const [t, c] of breaks) if (v >= t) return c; return '#10b981' }

  /* Scatter: ISA-dev (°C) vs Gradient delta (%) */
  const W = 280, H = 110, padL = 26, padB = 16, padT = 6, padR = 6
  const xMin = -5, xMax = 30
  const yMin = -3, yMax = 4
  const sx = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * (W - padL - padR)
  const sy = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="absolute right-3 top-20 z-40 w-[26rem] max-h-[calc(100vh-6rem)] flex flex-col bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-sky-500 animate-pulse" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-sky-400">WAT · Weight/Alt/Temp Climb-Limit</span>
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
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean score</div><div className="text-sm font-semibold" style={{ color: tcol(meanScore, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }}>{meanScore.toFixed(0)}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Worst</div><div className="text-sm font-semibold text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">WAT-Limit</div><div className="text-sm font-semibold" style={{ color: tierCount['WAT-LIMIT'] > 0 ? '#ef4444' : '#10b981' }}>{tierCount['WAT-LIMIT']}</div></div>
      </div>
      <div className="grid grid-cols-3 gap-1 px-3 pb-2 border-b border-slate-800">
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Over MTOW</div><div className="text-xs font-semibold text-rose-400">{overMtow}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">2nd-Seg deficit</div><div className="text-xs font-semibold text-rose-400">{climbCrit}</div></div>
        <div className="rounded px-2 py-1 bg-slate-800/50"><div className="text-[9px] text-slate-500 uppercase">Mean ISA-dev</div><div className="text-xs font-semibold" style={{ color: tcol(meanIsa, [[22,'#ef4444'],[12,'#f59e0b'],[5,'#0ea5e9']]) }}>ISA{meanIsa >= 0 ? '+' : ''}{meanIsa.toFixed(0)}°C</div></div>
      </div>

      {showDiag && evals.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-800">
          <svg width={W} height={H} className="w-full">
            <rect x={0} y={0} width={W} height={H} fill="#020617" />
            {/* OK quadrant: ISA<+12 and grad-delta>+0.5 */}
            <rect x={padL} y={padT} width={sx(12) - padL} height={sy(0.5) - padT} fill="#10b98112" />
            {/* breach quadrant: ISA>+20 and grad-delta<0 */}
            <rect x={sx(20)} y={sy(0)} width={W - padR - sx(20)} height={H - padB - sy(0)} fill="#ef444418" />
            <line x1={padL} y1={sy(0)} x2={W - padR} y2={sy(0)} stroke="#475569" strokeWidth={0.5} />
            <line x1={sx(15)} y1={padT} x2={sx(15)} y2={H - padB} stroke="#f59e0b66" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={sx(20)} y1={padT} x2={sx(20)} y2={H - padB} stroke="#ef444466" strokeDasharray="3 3" strokeWidth={0.5} />
            <line x1={padL} y1={sy(2.4)} x2={W - padR} y2={sy(2.4)} stroke="#10b98166" strokeDasharray="3 3" strokeWidth={0.5} />
            <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="9" fill="#64748b">ISA-dev °C</text>
            <text x={6} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b" transform={`rotate(-90 6 ${H / 2})`}>Δgrad % (act−req)</text>
            {evals.map((e, i) => (
              <circle key={i} cx={sx(clamp(e.isaDev, xMin, xMax))} cy={sy(clamp(e.gradDeltaPct, yMin, yMax))} r={2.4} fill={TIER_COLOR[e.tier]} opacity={0.85} />
            ))}
          </svg>
        </div>
      )}

      <div className="px-3 py-2 border-b border-slate-800">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
          {[
            ['OAT-BIAS', ovat, -20, 30, setOvat, '°C'],
            ['ROTOW-BIAS', mtowBias, -25, 15, setMtowBias, '%'],
            ['ADV-MUL', advMul, 50, 200, setAdvMul, '%'],
            ['SCOPE', scope, 20, 200, setScope, 'nm'],
            ['MIN-HAA', minHaa, 0, 3000, setMinHaa, 'ft'],
            ['MAX-HAA', maxHaa, 1000, 6000, setMaxHaa, 'ft'],
          ].map(([lab, v, mn, mx, setter, suf]: any) => (
            <label key={lab} className="flex items-center gap-1.5">
              <span className="text-slate-500 w-[78px]">{lab}</span>
              <input type="range" min={mn} max={mx} value={v} onChange={e => setter(parseInt(e.target.value))} className="flex-1 accent-sky-500" />
              <span className="text-slate-300 w-[42px] text-right tabular-nums">{v}{suf}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HVY-Q', 'HVY', 'NRW', 'RGN', 'BIZ', 'TBP'] as Klass[]).map(k => (
            <button key={k} onClick={() => setKlassFilter(klassFilter === k ? 'ALL' : k)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: klassFilter === k ? KLASS_COLOR[k] + '33' : '#0b1220', borderColor: klassFilter === k ? KLASS_COLOR[k] : '#1e293b', color: klassFilter === k ? KLASS_COLOR[k] : '#cbd5e1' }}>{k}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {(['HOT','MID','STD'] as const).map(s => (
            <button key={s} onClick={() => setSevFilter(sevFilter === s ? 'ALL' : s)} className="px-1.5 py-0.5 rounded text-[10px] border font-mono" style={{ backgroundColor: sevFilter === s ? '#a855f733' : '#0b1220', borderColor: sevFilter === s ? '#a855f7' : '#1e293b', color: sevFilter === s ? '#c4b5fd' : '#cbd5e1' }}>{s}</button>
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
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-slate-500 text-[11px]">No climbout aircraft within scope of WAT-relevant airports.</div>}
            {filtered.map((e, idx) => {
              const sg = e.gradDeltaPct >= 0 ? '+' : ''
              const gdCol = e.gradDeltaPct < -0.5 ? '#ef4444' : e.gradDeltaPct < 0 ? '#f59e0b' : e.gradDeltaPct < 0.5 ? '#0ea5e9' : '#10b981'
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
                  <div className="flex items-center gap-1.5 text-[10px] mt-0.5 flex-wrap">
                    <span className="text-sky-400 font-mono">{e.ap?.icao}</span>
                    <span className="text-slate-500 italic">{e.ap?.name}</span>
                    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: e.ap?.sev === 'HOT' ? '#c4b5fd' : e.ap?.sev === 'MID' ? '#fbbf24' : '#7dd3fc', backgroundColor: '#0b1220', border: '1px solid #1e293b' }}>{e.ap?.sev} · {e.ap?.elevFt.toLocaleString()}ft</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">grad </span><span style={{ color: gdCol }}>{e.gradActPct.toFixed(2)}%</span><span className="text-slate-600"> / req {e.gradReqPct.toFixed(1)}%</span></div>
                    <div><span className="text-slate-500">Δ </span><span style={{ color: gdCol }}>{sg}{e.gradDeltaPct.toFixed(2)}%</span></div>
                    <div><span className="text-slate-500">ISA </span><span style={{ color: tcol(e.isaDev, [[22,'#ef4444'],[12,'#f59e0b'],[5,'#0ea5e9']]) }}>{e.isaDev >= 0 ? '+' : ''}{e.isaDev.toFixed(0)}°C</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">ROTOW </span><span className="text-slate-200">{(e.rotwKg/1000).toFixed(1)}t</span></div>
                    <div><span className="text-slate-500">WAT-MTOW </span><span style={{ color: e.mtowMargin < 0 ? '#ef4444' : '#10b981' }}>{(e.mtowKg/1000).toFixed(1)}t</span></div>
                    <div><span className="text-slate-500">margin </span><span style={{ color: e.mtowMargin < 0 ? '#ef4444' : '#10b981' }}>{e.mtowMargin >= 0 ? '+' : ''}{(e.mtowMargin/1000).toFixed(1)}t</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">PA </span><span className="text-slate-200">{e.pa.toLocaleString()}ft</span></div>
                    <div><span className="text-slate-500">GS </span><span style={{ color: e.tireMarginKts < 5 ? '#ef4444' : e.tireMarginKts < 15 ? '#f59e0b' : '#10b981' }}>{e.gsKts.toFixed(0)}kt</span><span className="text-slate-600"> / tire {e.tireKts}</span></div>
                    <div><span className="text-slate-500">thr </span><span style={{ color: e.derateBust ? '#ef4444' : e.derate === 'TOGA' ? '#10b981' : '#0ea5e9' }}>{e.derate}</span>{e.antiIceOn && <span className="text-amber-400"> ★AI</span>}</div>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${e.score}%`, backgroundColor: TIER_COLOR[e.tier] }} />
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {drvBadge('GRD', e.drv.GRD)}{drvBadge('MTW', e.drv.MTW)}{drvBadge('ISA', e.drv.ISA)}
                    {drvBadge('PA', e.drv.PA)}{drvBadge('OBS', e.drv.OBS)}{drvBadge('TIR', e.drv.TIR)}
                  </div>
                  <div className="mt-1 text-[10px] leading-tight" style={{ color: TIER_COLOR[e.tier] }}>{e.advice}</div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'AIRPORTS' && (
          <div className="divide-y divide-slate-800">
            {HH.map(a => {
              const inE = evals.filter(e => e.ap?.icao === a.icao)
              if (inE.length === 0) return null
              const mean = inE.reduce((s, e) => s + e.score, 0) / inE.length
              const watL = inE.filter(e => e.tier === 'WAT-LIMIT').length
              const cc = inE.filter(e => e.tier === 'CLIMB-CRIT').length
              const col = a.sev === 'HOT' ? '#a855f7' : a.sev === 'MID' ? '#f59e0b' : '#0ea5e9'
              return (
                <div key={a.icao} className="px-3 py-2 hover:bg-slate-800/40 cursor-pointer" onClick={() => inE[0] && onFly(inE[0].f.icao)} style={{ borderLeft: `3px solid ${tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']])}` }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sky-400 font-mono text-[11px]">{a.icao}</span>
                    <span className="px-1 py-0.5 rounded text-[9px] font-mono" style={{ color: col, backgroundColor: col + '1c', border: `1px solid ${col}55` }}>{a.sev}</span>
                    <span className="text-slate-400 text-[10px] italic truncate">{a.name}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">elev </span><span className="text-slate-200">{a.elevFt.toLocaleString()}ft</span></div>
                    <div><span className="text-slate-500">ISA </span><span className="text-amber-400">+{a.isaDev}°C</span></div>
                    <div><span className="text-slate-500">obs </span><span style={{ color: a.obsPct >= 4 ? '#ef4444' : a.obsPct >= 3.3 ? '#f59e0b' : '#0ea5e9' }}>{a.obsPct.toFixed(1)}%</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">TORA </span><span className="text-slate-200">{a.toraFt.toLocaleString()}ft</span></div>
                    <div><span className="text-slate-500">a/c </span><span className="text-slate-200">{inE.length}</span></div>
                    <div><span className="text-slate-500">WAT </span><span className="text-rose-400">{watL}</span><span className="text-slate-600"> / CC </span><span className="text-rose-400">{cc}</span></div>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${mean}%`, backgroundColor: tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'CLASSES' && (
          <div className="divide-y divide-slate-800">
            {(['HVY-Q','HVY','NRW','RGN','BIZ','TBP'] as Klass[]).map(k => {
              const inE = evals.filter(e => e.klass === k)
              if (inE.length === 0) return null
              const mean = inE.reduce((s, e) => s + e.score, 0) / inE.length
              const watL = inE.filter(e => e.tier === 'WAT-LIMIT').length
              const cc = inE.filter(e => e.tier === 'CLIMB-CRIT').length
              const perf = KLASS[k]
              return (
                <div key={k} className="px-3 py-2" style={{ borderLeft: `3px solid ${KLASS_COLOR[k]}` }}>
                  <div className="flex items-center gap-1.5">
                    {klassBadge(k)}
                    <span className="text-slate-500 text-[10px] italic">{perf.examples}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 font-mono">
                    <div><span className="text-slate-500">MTOW </span><span className="text-slate-200">{(perf.mtowKg/1000).toFixed(0)}t</span></div>
                    <div><span className="text-slate-500">V2 </span><span className="text-slate-200">{perf.v2Kts}kt</span></div>
                    <div><span className="text-slate-500">grad ≥ </span><span className="text-emerald-400">{perf.grad2pct.toFixed(1)}%</span></div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px] mt-0.5 font-mono">
                    <div><span className="text-slate-500">a/c </span><span className="text-slate-200">{inE.length}</span></div>
                    <div><span className="text-slate-500">WAT </span><span className="text-rose-400">{watL}</span></div>
                    <div><span className="text-slate-500">CC </span><span className="text-rose-400">{cc}</span></div>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${mean}%`, backgroundColor: tcol(mean, [[65,'#ef4444'],[35,'#f59e0b'],[18,'#0ea5e9']]) }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
