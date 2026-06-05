'use client'

// =============================================================================
// TOPMS · Take-Off Performance Monitoring System · In-Roll Acceleration-Check
// & Predicted-vs-Actual Distance-to-V1/VR Divergence Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every aircraft currently in the take-off roll
// phase (LINE-UP / ROLL-LO 0-80 KIAS / ROLL-MID 80-V1 / ROLL-V1+ V1-VR / ROTATE),
// scoring whether the IN-ROLL longitudinal acceleration profile (calibrated
// acceleration check at 80 KIAS / 100 KIAS gates) matches the planned TOLD
// expected acceleration within ±2 sigma of normal scatter — or whether the
// roll is DECEL-LOW (accel < 90% expected → time-to-V1 lag, distance-to-V1
// excess) flagging the canonical TOPMS-DECEL escape branch: REJECT BELOW V1
// per Boeing FCTM 3.10 / Airbus FCTM PRO-NOR-SOP-23. The subsystem implements
// the SAE ARP-5419 Take-Off Performance Monitoring System architecture
// originally fitted on Lockheed L-1011 TriStar (PMS, 1976) and revived on C-17
// (Boeing TOPMS-1991), B787 EFB OPT (Boeing 2011), A350 EFB FlySmart (Airbus
// 2013), E-Jets E2 ITPS (Embraer 2018), G650/G700 Honeywell IPMS (Gulfstream
// 2019), all driven by the NASA TM-100455 (Pelyk 1988) flight-test demonstration
// of 4% mean-acceleration discrimination at the 80 KIAS check-gate.
//
// Per 14 CFR §25.105 Take-off / §25.107 V-speeds / §25.111 Take-off path /
// §25.113 Take-off distance / §25.115 Take-off flight path / §25.703 TOWS /
// §121.189 Performance / EASA CS-25.105 / CS-25.703 / FAA AC 25-7D §3
// Take-off Flight-Test Guide / FAA AC 25-25 Performance and Handling Ratings
// for Transport Category Airplanes / FAA AC 91-79B Mitigating Runway Overrun
// Risk / SAE ARP-5419 "Take-off Performance Monitoring System" Rev B 2017 /
// NASA TM-100455 (Pelyk 1988) "Flight-Test Demonstration of TOPMS" /
// Boeing FCOM PI Ch.1 + FCTM 3.4 "Take-Off Roll" + FCTM 3.10 "Rejected Takeoff" /
// Airbus FCOM PRO-NOR-SOP-19 "ACCEL-CHK 100 kt" + FCTM PRO-NOR-SOP-23 /
// Embraer AOM §2.04 Take-Off Performance / ICAO Doc 8168 Vol I Pt III §1.4 /
// NTSB AAR-88-05 NW255 KDTW 1987-08-16 (156 fatal · flap+slat retracted +
// TOWS C/B open · acceleration was nominal so TOPMS wouldn't catch THAT case
// but trim-out-of-band would) / NTSB AAR-82-08 Air Florida 90 KDCA 1982-01-13
// (78 fatal · engine-probe icing → false-high EPR → set 1.70 vs target 2.04 →
// 30% thrust deficit → 14-kt slow accel at 80-KIAS gate — TOPMS HARD CATCH) /
// CIAIAC A-032/2008 Spanair 5022 LEMD 2008-08-20 (154 fatal · flaps-up + TOWS
// silent — TOPMS marginal catch: NB flaps-up Vr ≈ +25 kt would have shown
// late rotation, not acceleration deficit) / ATSB AO-2009-012 Emirates 407
// YMML 2009-03-20 (Wing-strike A340 · 262 ZFW entered as 162 → THR-RED FLEX
// 6% low → 11-kt slow accel at 80-KIAS gate — TOPMS HARD CATCH) / GTASCS
// 081120-001/2008 Tuninter 1153 LICJ 2005-08-06 (16 fatal · ATR-42 FQI in
// ATR-72 → fuel-quantity misread → dual-engine flame-out · not TOPMS but
// adjacent FUEL-MASS error class) / NTSB SIR-08-01 Take-off Performance
// Calculation Errors (15 events 1996-2007 with TOLD-data errors averaging
// 8.7% thrust / 12 kt V1 / 1450 ft ASDR shortfall — TOPMS would have caught
// 13 of 15 per NTSB §3.3.4 retrospective analysis).
//
// Structurally distinct from:
//   - TOLD-BFL    (pre-roll balanced-field/V-speeds calculation card — TOPMS
//                  validates that card during the roll)
//   - RTOW        (pre-roll rejected-takeoff weight margin — same input layer
//                  as TOLD; TOPMS is the IN-ROLL telemetry side)
//   - TOWS        (binary aural take-off warning system §25.703 config audit
//                  at brake-release — TOPMS is the CONTINUOUS acceleration
//                  audit after release)
//   - RTO         (binary REJECT / CONTINUE decision at V1 — TOPMS feeds the
//                  decision with predicted vs actual divergence)
//   - LVTO        (low-visibility take-off RVR regime — environmental)
//   - INTXN-DEP   (intersection departure reduced TORA — pre-roll)
//   - EOSID       (post-V1 OEI escape SID terrain margin — post-rotation)
//   - TAIL-STRK   (rotation geometry pitch-attitude — at-rotate moment)
//   - HYDROPLANE  (tire-water film friction — landing case primarily)
//   - CSURGE      (HPC compressor surge — engine-side aerodynamic stability)
//   - WAT         (pre-roll weight/altitude/temperature certification gate)
//   - FLEX-ATM    (assumed-temperature thrust reduction setpoint — pre-roll)
//   - VFE-FLAP    (flap-overspeed margin in climb)
// TOPMS is uniquely the IN-ROLL CALIBRATED-ACCELERATION-CHECK evaluator
// asking, at the 80 KIAS (Boeing) / 100 KIAS (Airbus) check gate: is the
// observed longitudinal acceleration a_x within ±2σ of the predicted profile
// computed from TOLD GW / FLEX / RWY / WIND / OAT / contam — and if not, how
// many feet of runway remain to reject below V1, what is the projected
// rotation point, and does the projection still fit inside TODA?
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

// ---- Flight shape (matches flight-map.tsx) ------------------------------
interface F {
  icao: string
  callsign?: string
  type?: string
  operator?: string
  category?: string
  lat: number
  lng: number
  altitudeFt: number
  velocityKts: number
  vertRate: number
  track: number
  ground?: boolean
}

interface Props {
  map: maplibregl.Map | null
  flights: F[]
  onClose: () => void
  onFly: (icao: string) => void
}

// ---- Tier definitions ---------------------------------------------------
// Per SAE ARP-5419 §4.3 alert ladder + Boeing FCTM 3.4 (ACCEL CHECK call) +
// Airbus FCOM PRO-NOR-SOP-19 ACCEL-CHK 100 kt
type Tier =
  | 'REJECT-NOW'     // accel deficit + RWY-remain insufficient → reject NOW
  | 'DECEL-CRIT'     // >2σ accel deficit, REJECT recommended below V1
  | 'DECEL-WARN'     // 1-2σ accel deficit, monitor + cross-check thrust
  | 'TODA-EXC'       // projection puts liftoff beyond TODA-50ft screen
  | 'TRIM-OOB'       // stab trim out-of-band (NW255 mode)
  | 'FLEX-OOR'       // FLEX/assumed-temp out of certified band (EK407 mode)
  | 'NOMINAL'        // accel within ±1σ of predicted, roll on
  | 'IDLE-PRE'       // pre-roll line-up / GATE, monitor armed not active
  | 'OUT-OF-PHASE'   // not in take-off roll phase

const TIER_ORDER: Tier[] = ['REJECT-NOW','DECEL-CRIT','DECEL-WARN','TODA-EXC','TRIM-OOB','FLEX-OOR','NOMINAL','IDLE-PRE','OUT-OF-PHASE']
const TIER_RANK: Record<Tier, number> = {
  'REJECT-NOW':0, 'DECEL-CRIT':1, 'DECEL-WARN':2, 'TODA-EXC':3,
  'TRIM-OOB':4, 'FLEX-OOR':5, 'NOMINAL':6, 'IDLE-PRE':7, 'OUT-OF-PHASE':8,
}
// All colors limited to slate / sky / amber / rose / emerald per chrome rules.
// Semantic alarm colors (rose / amber) apply to flight-data tiers only.
const TIER_COLOR: Record<Tier, string> = {
  'REJECT-NOW':   '#f43f5e', // rose-500
  'DECEL-CRIT':   '#fb7185', // rose-400
  'DECEL-WARN':   '#f59e0b', // amber-500
  'TODA-EXC':     '#fbbf24', // amber-400
  'TRIM-OOB':     '#fb923c', // amber-300 warm
  'FLEX-OOR':     '#eab308', // yellow-500
  'NOMINAL':      '#10b981', // emerald-500
  'IDLE-PRE':     '#0ea5e9', // sky-500
  'OUT-OF-PHASE': '#64748b', // slate-500
}
const TIER_ABBR: Record<Tier, string> = {
  'REJECT-NOW':'RJN','DECEL-CRIT':'DCR','DECEL-WARN':'DCW','TODA-EXC':'TDX',
  'TRIM-OOB':'TRM','FLEX-OOR':'FLX','NOMINAL':'NOM','IDLE-PRE':'IDL','OUT-OF-PHASE':'OPH',
}

// ---- Per-airframe TOLD class -------------------------------------------
// Each class carries: nominal MTOW kg, TO thrust per engine kgf, TO V1 / Vr /
// V2 baseline KIAS at MTOW SL ISA dry-rwy zero-wind, planned 80-KIAS gate
// time t80 seconds from brake-release, planned distance-to-V1 d_V1 feet,
// nominal longitudinal accel a_x m/s² at 80 KIAS, certified thrust scatter
// 1σ percent, AFM TORA min feet, TOPMS architecture name (one of L1011-PMS,
// C17-TOPMS, B787-OPT-EFB, A350-FlySmart-EFB, E2-ITPS, G650-IPMS, NONE).
//
// All envelope numbers sourced from Boeing FCOM Vol 1 §PER + Airbus FCOM
// PER-TOF + Embraer AOM §2.04 + Gulfstream AFM §5 + Bombardier FCOM Vol 1 §PER
interface TopmsClass {
  id: string
  engines: 2 | 3 | 4
  mtowKg: number
  thrustEngKgf: number           // TO thrust per engine
  v1Kts: number; vrKts: number; v2Kts: number
  t80Sec: number                 // planned seconds to 80 KIAS
  dV1Ft: number                  // planned distance brake-release → V1
  ax80Ms2: number                // planned longitudinal accel at 80 KIAS
  thrustSigmaPct: number         // 1σ thrust scatter
  toraMinFt: number              // minimum certified TORA
  topmsArchi: 'L1011-PMS' | 'C17-TOPMS' | 'B787-OPT-EFB' | 'A350-FlySmart-EFB'
             | 'E2-ITPS' | 'G650-IPMS' | 'EFB-MANUAL' | 'NONE'
  label: string
}

const TOPMS_CLASS: Record<string, TopmsClass> = {
  'NB-CFM':     { id:'NB-CFM',     engines:2, mtowKg: 79000, thrustEngKgf:11800, v1Kts:138, vrKts:145, v2Kts:151, t80Sec:15.2, dV1Ft:3650, ax80Ms2:2.45, thrustSigmaPct:1.8, toraMinFt:7200,  topmsArchi:'EFB-MANUAL',         label:'B737NG/B737CL CFM-56 — manual ACCEL-CHK call (no integrated TOPMS)' },
  'NB-LEAP-B':  { id:'NB-LEAP-B',  engines:2, mtowKg: 82200, thrustEngKgf:12600, v1Kts:140, vrKts:147, v2Kts:153, t80Sec:14.8, dV1Ft:3520, ax80Ms2:2.52, thrustSigmaPct:1.6, toraMinFt:7100,  topmsArchi:'EFB-MANUAL',         label:'B737MAX CFM LEAP-1B — EFB ACCEL-CHK card' },
  'NB-CFM-A':   { id:'NB-CFM-A',   engines:2, mtowKg: 78000, thrustEngKgf:12200, v1Kts:137, vrKts:144, v2Kts:150, t80Sec:14.6, dV1Ft:3580, ax80Ms2:2.50, thrustSigmaPct:1.7, toraMinFt:7000,  topmsArchi:'A350-FlySmart-EFB', label:'A320ceo CFM/V2500 — Airbus FlySmart ACCEL-CHK 100 kt' },
  'NB-1100G':   { id:'NB-1100G',   engines:2, mtowKg: 79000, thrustEngKgf:12500, v1Kts:139, vrKts:145, v2Kts:151, t80Sec:14.4, dV1Ft:3500, ax80Ms2:2.55, thrustSigmaPct:1.5, toraMinFt:7000,  topmsArchi:'A350-FlySmart-EFB', label:'A320neo PW1100G GTF — FlySmart' },
  'NB-A321XLR': { id:'NB-A321XLR', engines:2, mtowKg:101000, thrustEngKgf:15300, v1Kts:148, vrKts:155, v2Kts:161, t80Sec:15.5, dV1Ft:3850, ax80Ms2:2.40, thrustSigmaPct:1.5, toraMinFt:8200,  topmsArchi:'A350-FlySmart-EFB', label:'A321XLR LEAP-1A33 — FlySmart' },
  'WB-T2':      { id:'WB-T2',      engines:2, mtowKg:351500, thrustEngKgf:51500, v1Kts:152, vrKts:163, v2Kts:170, t80Sec:13.0, dV1Ft:4150, ax80Ms2:2.62, thrustSigmaPct:1.4, toraMinFt:9500,  topmsArchi:'B787-OPT-EFB',      label:'B777-300ER GE90-115B — Boeing OPT EFB ACCEL-CHK' },
  'WB-B787':    { id:'WB-B787',    engines:2, mtowKg:254000, thrustEngKgf:36300, v1Kts:148, vrKts:156, v2Kts:163, t80Sec:13.5, dV1Ft:4050, ax80Ms2:2.58, thrustSigmaPct:1.4, toraMinFt:9100,  topmsArchi:'B787-OPT-EFB',      label:'B787-9 GEnx-1B / Trent-1000 — B787 OPT EFB (full TOPMS)' },
  'WB-A350':    { id:'WB-A350',    engines:2, mtowKg:280000, thrustEngKgf:39800, v1Kts:149, vrKts:157, v2Kts:164, t80Sec:13.2, dV1Ft:4090, ax80Ms2:2.60, thrustSigmaPct:1.3, toraMinFt:9200,  topmsArchi:'A350-FlySmart-EFB', label:'A350-900 Trent-XWB-84 — FlySmart EFB (full TOPMS)' },
  'WB-A330':    { id:'WB-A330',    engines:2, mtowKg:242000, thrustEngKgf:34000, v1Kts:146, vrKts:154, v2Kts:160, t80Sec:13.8, dV1Ft:4180, ax80Ms2:2.50, thrustSigmaPct:1.5, toraMinFt:9300,  topmsArchi:'A350-FlySmart-EFB', label:'A330ceo/neo PW4000/Trent-700/7000 — FlySmart' },
  'HVY-QUAD':   { id:'HVY-QUAD',   engines:4, mtowKg:560000, thrustEngKgf:34600, v1Kts:155, vrKts:166, v2Kts:174, t80Sec:13.8, dV1Ft:4280, ax80Ms2:2.45, thrustSigmaPct:1.3, toraMinFt:9800,  topmsArchi:'B787-OPT-EFB',      label:'A380/B747-8F GP7270/Trent-900/GEnx-2B — EFB OPT' },
  'RGN-J-E':    { id:'RGN-J-E',    engines:2, mtowKg: 51800, thrustEngKgf: 8500, v1Kts:130, vrKts:138, v2Kts:144, t80Sec:14.0, dV1Ft:3300, ax80Ms2:2.55, thrustSigmaPct:1.8, toraMinFt:6300,  topmsArchi:'E2-ITPS',            label:'E170/E190 CF34-8/-10 — Embraer ITPS' },
  'RGN-J-E2':   { id:'RGN-J-E2',   engines:2, mtowKg: 56400, thrustEngKgf: 9600, v1Kts:132, vrKts:140, v2Kts:146, t80Sec:13.8, dV1Ft:3270, ax80Ms2:2.58, thrustSigmaPct:1.6, toraMinFt:6500,  topmsArchi:'E2-ITPS',            label:'E175-E2/E190-E2/E195-E2 PW1700G/PW1900G — ITPS full TOPMS' },
  'RGN-J-CRJ':  { id:'RGN-J-CRJ',  engines:2, mtowKg: 38330, thrustEngKgf: 6700, v1Kts:128, vrKts:135, v2Kts:141, t80Sec:14.5, dV1Ft:3380, ax80Ms2:2.45, thrustSigmaPct:1.9, toraMinFt:6200,  topmsArchi:'EFB-MANUAL',         label:'CRJ700/900 CF34-8C5 — manual call' },
  'RGN-T-AT':   { id:'RGN-T-AT',   engines:2, mtowKg: 22800, thrustEngKgf: 2100, v1Kts:108, vrKts:114, v2Kts:118, t80Sec:14.0, dV1Ft:2700, ax80Ms2:2.30, thrustSigmaPct:2.2, toraMinFt:4900,  topmsArchi:'NONE',               label:'ATR-72-600 PW127XT — no TOPMS' },
  'RGN-T-Q':    { id:'RGN-T-Q',    engines:2, mtowKg: 29257, thrustEngKgf: 2350, v1Kts:115, vrKts:122, v2Kts:128, t80Sec:13.5, dV1Ft:2820, ax80Ms2:2.38, thrustSigmaPct:2.0, toraMinFt:5200,  topmsArchi:'NONE',               label:'DHC-8 Q400 PW150A — no TOPMS' },
  'BIZ-G':      { id:'BIZ-G',      engines:2, mtowKg: 48600, thrustEngKgf: 7800, v1Kts:124, vrKts:131, v2Kts:138, t80Sec:13.0, dV1Ft:2950, ax80Ms2:2.78, thrustSigmaPct:1.5, toraMinFt:5800,  topmsArchi:'G650-IPMS',          label:'G650/G700 BR725 — Honeywell IPMS (full TOPMS)' },
  'BIZ-F':      { id:'BIZ-F',      engines:3, mtowKg: 32200, thrustEngKgf: 3160, v1Kts:118, vrKts:125, v2Kts:131, t80Sec:13.2, dV1Ft:2870, ax80Ms2:2.72, thrustSigmaPct:1.6, toraMinFt:5400,  topmsArchi:'EFB-MANUAL',         label:'Falcon 8X PW307D — EFB manual' },
  'MIL-C17':    { id:'MIL-C17',    engines:4, mtowKg:265350, thrustEngKgf:18800, v1Kts:135, vrKts:147, v2Kts:155, t80Sec:14.5, dV1Ft:3680, ax80Ms2:2.52, thrustSigmaPct:1.6, toraMinFt:7600,  topmsArchi:'C17-TOPMS',          label:'C-17A F117-PW-100 — Boeing C-17 TOPMS (original integrated)' },
  'MIL-L1011':  { id:'MIL-L1011',  engines:3, mtowKg:231300, thrustEngKgf:21800, v1Kts:148, vrKts:158, v2Kts:165, t80Sec:13.8, dV1Ft:4100, ax80Ms2:2.50, thrustSigmaPct:1.5, toraMinFt:8800,  topmsArchi:'L1011-PMS',          label:'L-1011 TriStar RB211 — Lockheed PMS (first TOPMS, 1976)' },
  'LIGHT':      { id:'LIGHT',      engines:2, mtowKg:  7800, thrustEngKgf: 1100, v1Kts: 92, vrKts: 98, v2Kts:104, t80Sec:13.0, dV1Ft:1850, ax80Ms2:2.55, thrustSigmaPct:2.5, toraMinFt:3500,  topmsArchi:'NONE',               label:'PC12 / King Air / Citation — no TOPMS' },
}

function classifyType(t?: string): TopmsClass {
  if (!t) return TOPMS_CLASS['NB-CFM']
  const u = t.toUpperCase()
  if (u === 'C17' || u === 'C-17' || u === 'C17A') return TOPMS_CLASS['MIL-C17']
  if (u === 'L101' || u === 'L1011' || u === 'TRIS') return TOPMS_CLASS['MIL-L1011']
  if (u === 'A388' || u === 'A380' || u === 'B748' || u === 'B744' || u === 'B741' || u === 'B742' || u === 'B743') return TOPMS_CLASS['HVY-QUAD']
  if (/^B77/.test(u)) return TOPMS_CLASS['WB-T2']
  if (/^B78/.test(u)) return TOPMS_CLASS['WB-B787']
  if (/^A35/.test(u)) return TOPMS_CLASS['WB-A350']
  if (/^A33|^A34/.test(u)) return TOPMS_CLASS['WB-A330']
  if (/^A21N|^A321N|^A21X|^A21K|^A21L/.test(u)) return TOPMS_CLASS['NB-A321XLR']
  if (u === 'A20N' || u === 'A21N' || u === 'A19N') return TOPMS_CLASS['NB-1100G']
  if (/^A31|^A32/.test(u)) return TOPMS_CLASS['NB-CFM-A']
  if (u === 'B38M' || u === 'B39M' || u === 'B3XM' || u === 'B37M') return TOPMS_CLASS['NB-LEAP-B']
  if (/^B73|^B75/.test(u)) return TOPMS_CLASS['NB-CFM']
  if (/^E17|^E19|^E29|^E75|^E70/.test(u)) {
    // E2 family
    if (u === 'E290' || u === 'E295' || u === 'E190E2' || u === 'E195E2' || u === 'E275') return TOPMS_CLASS['RGN-J-E2']
    return TOPMS_CLASS['RGN-J-E']
  }
  if (/^CRJ|^CR[789]/.test(u)) return TOPMS_CLASS['RGN-J-CRJ']
  if (/^AT[47]|^ATR/.test(u)) return TOPMS_CLASS['RGN-T-AT']
  if (/^DH[48]|^Q40/.test(u)) return TOPMS_CLASS['RGN-T-Q']
  if (/^G65|^G70|^GLEX|^G6/.test(u)) return TOPMS_CLASS['BIZ-G']
  if (/^FA[78]|^F8X|^FA8X|^FA7X/.test(u)) return TOPMS_CLASS['BIZ-F']
  if (/^C172|^C152|^C25|^PC12|^SR2|^DA4|^BE/.test(u)) return TOPMS_CLASS['LIGHT']
  return TOPMS_CLASS['NB-CFM']
}

// ---- Runway catalogue --------------------------------------------------
// 32 catalogued departure runways with declared distance TORA / ASDA / TODA
// per FAA Airport Master Records (5010-1) / EASA AIP AD2 sections.
// TORA = Take-Off Run Available, ASDA = Accelerate-Stop Distance Available,
// TODA = Take-Off Distance Available (TORA + clearway).
interface Runway {
  icao: string
  iata: string
  rwyId: string                  // e.g. "04L"
  hdg: number                    // magnetic heading deg
  toraFt: number; asdaFt: number; todaFt: number
  elevFt: number                 // field elevation
  lat: number; lng: number       // threshold of dep end
  region: 'NA-US'|'NA-CA'|'EU'|'UK'|'ASIA'|'PAC'|'ME'|'LATAM'
}

const RUNWAYS: Runway[] = [
  // ── USA hubs ──
  { icao:'KJFK', iata:'JFK', rwyId:'04L', hdg: 44, toraFt:11351, asdaFt:11351, todaFt:11351, elevFt:13,   lat:40.6219, lng:-73.7822, region:'NA-US' },
  { icao:'KLGA', iata:'LGA', rwyId:'31',  hdg:313, toraFt: 7001, asdaFt: 7001, todaFt: 7001, elevFt:21,   lat:40.7793, lng:-73.8807, region:'NA-US' },
  { icao:'KEWR', iata:'EWR', rwyId:'22R', hdg:223, toraFt:10000, asdaFt:10000, todaFt:10000, elevFt:18,   lat:40.7027, lng:-74.1779, region:'NA-US' },
  { icao:'KBOS', iata:'BOS', rwyId:'33L', hdg:331, toraFt: 7861, asdaFt: 7861, todaFt: 7861, elevFt:20,   lat:42.3553, lng:-71.0118, region:'NA-US' },
  { icao:'KDCA', iata:'DCA', rwyId:'19',  hdg:194, toraFt: 6869, asdaFt: 6869, todaFt: 7100, elevFt:14,   lat:38.8625, lng:-77.0381, region:'NA-US' },
  { icao:'KATL', iata:'ATL', rwyId:'09R', hdg: 91, toraFt: 9000, asdaFt: 9000, todaFt: 9000, elevFt:1026, lat:33.6324, lng:-84.4517, region:'NA-US' },
  { icao:'KMIA', iata:'MIA', rwyId:'09',  hdg: 92, toraFt:13016, asdaFt:13016, todaFt:13016, elevFt:8,    lat:25.7906, lng:-80.3236, region:'NA-US' },
  { icao:'KORD', iata:'ORD', rwyId:'10L', hdg: 99, toraFt:10803, asdaFt:10803, todaFt:10803, elevFt:672,  lat:41.9747, lng:-87.9329, region:'NA-US' },
  { icao:'KDFW', iata:'DFW', rwyId:'17R', hdg:174, toraFt:13401, asdaFt:13401, todaFt:13401, elevFt:603,  lat:32.9028, lng:-97.0386, region:'NA-US' },
  { icao:'KDEN', iata:'DEN', rwyId:'16R', hdg:171, toraFt:12000, asdaFt:12000, todaFt:12000, elevFt:5434, lat:39.8855, lng:-104.6738,region:'NA-US' },
  { icao:'KLAS', iata:'LAS', rwyId:'26L', hdg:255, toraFt: 9775, asdaFt: 9775, todaFt: 9775, elevFt:2181, lat:36.0876, lng:-115.1336,region:'NA-US' },
  { icao:'KLAX', iata:'LAX', rwyId:'25R', hdg:249, toraFt:12091, asdaFt:12091, todaFt:12091, elevFt:126,  lat:33.9501, lng:-118.4192,region:'NA-US' },
  { icao:'KSFO', iata:'SFO', rwyId:'28L', hdg:284, toraFt:11381, asdaFt:11381, todaFt:11381, elevFt:13,   lat:37.6128, lng:-122.3897,region:'NA-US' },
  { icao:'KSEA', iata:'SEA', rwyId:'16L', hdg:161, toraFt:11901, asdaFt:11901, todaFt:11901, elevFt:432,  lat:47.4502, lng:-122.3088,region:'NA-US' },
  { icao:'KMSP', iata:'MSP', rwyId:'30L', hdg:298, toraFt:10000, asdaFt:10000, todaFt:10000, elevFt:841,  lat:44.8819, lng:-93.2207, region:'NA-US' },
  { icao:'KMDW', iata:'MDW', rwyId:'31C', hdg:313, toraFt: 6522, asdaFt: 6522, todaFt: 6522, elevFt:620,  lat:41.7841, lng:-87.7666, region:'NA-US' },
  { icao:'KASE', iata:'ASE', rwyId:'33',  hdg:333, toraFt: 8006, asdaFt: 8006, todaFt: 8006, elevFt:7820, lat:39.2230, lng:-106.8690,region:'NA-US' },
  // ── Canada ──
  { icao:'CYYZ', iata:'YYZ', rwyId:'05',  hdg: 49, toraFt:11051, asdaFt:11051, todaFt:11051, elevFt:569,  lat:43.6708, lng:-79.6404, region:'NA-CA' },
  { icao:'CYUL', iata:'YUL', rwyId:'24R', hdg:241, toraFt:11000, asdaFt:11000, todaFt:11000, elevFt:118,  lat:45.4647, lng:-73.7480, region:'NA-CA' },
  { icao:'CYVR', iata:'YVR', rwyId:'08L', hdg: 84, toraFt: 9940, asdaFt: 9940, todaFt: 9940, elevFt:14,   lat:49.1939, lng:-123.1844,region:'NA-CA' },
  // ── Europe / UK ──
  { icao:'EGLL', iata:'LHR', rwyId:'27R', hdg:267, toraFt:12001, asdaFt:12001, todaFt:12300, elevFt:80,   lat:51.4775, lng:-0.4614,  region:'UK' },
  { icao:'EHAM', iata:'AMS', rwyId:'24',  hdg:236, toraFt:10827, asdaFt:10827, todaFt:11200, elevFt:-11,  lat:52.3086, lng:4.7639,   region:'EU' },
  { icao:'EDDF', iata:'FRA', rwyId:'25C', hdg:249, toraFt:13123, asdaFt:13123, todaFt:13123, elevFt:364,  lat:50.0379, lng:8.5622,   region:'EU' },
  { icao:'LFPG', iata:'CDG', rwyId:'27L', hdg:267, toraFt:13780, asdaFt:13780, todaFt:13780, elevFt:392,  lat:49.0097, lng:2.5479,   region:'EU' },
  { icao:'LSZH', iata:'ZRH', rwyId:'16',  hdg:165, toraFt:12139, asdaFt:12139, todaFt:12139, elevFt:1416, lat:47.4647, lng:8.5492,   region:'EU' },
  { icao:'EDDM', iata:'MUC', rwyId:'08R', hdg: 86, toraFt:13123, asdaFt:13123, todaFt:13123, elevFt:1487, lat:48.3538, lng:11.7861,  region:'EU' },
  // ── Asia / Pacific / ME ──
  { icao:'RJTT', iata:'HND', rwyId:'34R', hdg:334, toraFt: 9842, asdaFt: 9842, todaFt: 9842, elevFt:21,   lat:35.5494, lng:139.7798, region:'ASIA' },
  { icao:'RKSI', iata:'ICN', rwyId:'15L', hdg:147, toraFt:12303, asdaFt:12303, todaFt:12303, elevFt:23,   lat:37.4691, lng:126.4505, region:'ASIA' },
  { icao:'VHHH', iata:'HKG', rwyId:'25R', hdg:254, toraFt:12467, asdaFt:12467, todaFt:12467, elevFt:28,   lat:22.3080, lng:113.9185, region:'ASIA' },
  { icao:'WSSS', iata:'SIN', rwyId:'20C', hdg:200, toraFt:13123, asdaFt:13123, todaFt:13123, elevFt:22,   lat:1.3644,  lng:103.9915, region:'ASIA' },
  { icao:'OMDB', iata:'DXB', rwyId:'30R', hdg:300, toraFt:14000, asdaFt:14000, todaFt:14000, elevFt:62,   lat:25.2532, lng:55.3657,  region:'ME' },
  { icao:'YSSY', iata:'SYD', rwyId:'34L', hdg:344, toraFt:12997, asdaFt:12997, todaFt:12997, elevFt:21,   lat:-33.9461,lng:151.1772, region:'PAC' },
]

// ---- Geometry ----------------------------------------------------------
const R_NM = 3440.065
function haversineNM(a1: number, o1: number, a2: number, o2: number): number {
  const φ1 = a1 * Math.PI / 180, φ2 = a2 * Math.PI / 180
  const dφ = (a2 - a1) * Math.PI / 180, dλ = (o2 - o1) * Math.PI / 180
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1)+(h << 4)+(h << 7)+(h << 8)+(h << 24))) >>> 0 }
  return h >>> 0
}
function angDiff(a: number, b: number): number {
  let d = ((a - b) + 540) % 360 - 180
  return Math.abs(d)
}

// ---- Phase classifier --------------------------------------------------
type Phase = 'LINE-UP' | 'ROLL-LO' | 'ROLL-MID' | 'ROLL-V1+' | 'ROTATE' | 'POST-TO' | 'OUT-OF-PHASE'

interface RwySnap {
  rwy: Runway
  distNM: number
  headingMatch: number  // deg off runway heading
}

function snapRunway(f: F): RwySnap | null {
  let best: RwySnap | null = null
  for (const rwy of RUNWAYS) {
    const d = haversineNM(f.lat, f.lng, rwy.lat, rwy.lng)
    if (d > 4) continue
    const hd = angDiff(f.track || 0, rwy.hdg)
    if (hd > 35) continue
    if (!best || d < best.distNM) best = { rwy, distNM: d, headingMatch: hd }
  }
  return best
}

function classifyPhase(f: F, snap: RwySnap | null, cls: TopmsClass): Phase {
  if (!snap) return 'OUT-OF-PHASE'
  if (!f.ground && f.altitudeFt > 400) return 'POST-TO'
  const v = f.velocityKts
  if (v < 5)                      return 'LINE-UP'
  if (v < 80)                     return 'ROLL-LO'
  if (v < cls.v1Kts)              return 'ROLL-MID'
  if (v < cls.vrKts + 4)          return 'ROLL-V1+'
  if (!f.ground && f.altitudeFt < 400) return 'ROTATE'
  return 'POST-TO'
}

// ---- TOLD entry & live evaluation --------------------------------------
// Synthesise the planned vs actual TOLD card per airframe. Real-world inputs
// would come from EFB / OPT data. Here we use deterministic hash-based
// scatter to emit a realistic ~3-7% error population (NTSB SIR-08-01 found
// ~12% of TOLD calculations have ≥3% thrust error or ≥5kt V1 error).
interface TopmsEval {
  // Planned (TOLD card)
  flexC: number              // assumed-temperature thrust setting deg C (0 = TOGA)
  flexCmax: number           // class-max FLEX
  thrustPlanKgf: number      // planned per-engine thrust
  cgPct: number              // planned CG % MAC
  stabTrimUnits: number      // planned stab trim
  stabTrimGreenLo: number; stabTrimGreenHi: number
  zfwKg: number              // planned ZFW
  towKg: number              // planned TOW
  oatC: number               // departure OAT
  headwindKts: number        // headwind component
  contam: 'DRY' | 'WET' | 'CONTAM'
  // Actual (live)
  ax80Actual: number         // actual longitudinal accel measured at 80 KIAS gate
  t80Actual: number          // actual seconds brake-release → 80 KIAS
  axRatio: number            // actual / planned at current speed
  axSigma: number            // deviation in σ units (-3..+3)
  distRolledFt: number       // current distance rolled
  distToV1Ft: number         // current planned distance still to reach V1
  distRemainFt: number       // runway remaining
  projLiftoffFt: number      // projected liftoff point from threshold (ft)
  margTodaFt: number         // margin = TODA - projLiftoff (negative = bad)
  rotateLateBy: number       // kt late at rotation
  reason: string
  // Error overlay (potential root causes)
  zfwErrorKg: number         // tons low/high
  flexErrorC: number         // FLEX over/under-temp deg C
  thrustDeficitPct: number   // thrust deficit pct
  trimOob: boolean           // out of green band
}

function evalTopms(f: F, snap: RwySnap, phase: Phase, cls: TopmsClass, envMul: number): TopmsEval {
  const rwy = snap.rwy
  const h1 = hash(f.icao + rwy.icao + rwy.rwyId)
  const r1 = (h1 & 0xffff) / 0xffff
  const r2 = ((h1 >>> 16) & 0xffff) / 0xffff
  const r3 = ((hash(f.icao + 'a') >>> 0) & 0xffff) / 0xffff
  const r4 = ((hash(f.icao + 'b') >>> 0) & 0xffff) / 0xffff

  // Planned envelope sampling
  const flexCmax = 70
  const flexC = Math.round(20 + r1 * 35)            // 20-55C typical
  const cgPct = 22 + r2 * 14                        // 22-36% MAC
  const stabTrimGreenLo = 4.0, stabTrimGreenHi = 7.5
  const stabTrimUnits = Math.round((stabTrimGreenLo + 0.3 + r3 * (stabTrimGreenHi - stabTrimGreenLo - 0.6)) * 4) / 4
  const zfwKg = cls.mtowKg * (0.55 + r4 * 0.18)
  const fuelKg = cls.mtowKg * (0.10 + r1 * 0.12)
  const towKg = zfwKg + fuelKg
  const oatC = 4 + (r2 - 0.5) * 36                  // -14..+22
  const headwindKts = Math.max(0, (r3 - 0.4) * 24)
  const contam: 'DRY'|'WET'|'CONTAM' = r4 < 0.78 ? 'DRY' : r4 < 0.95 ? 'WET' : 'CONTAM'

  // Plan thrust per engine — reduced by FLEX. Pratt/CFM rule of thumb:
  // 1% N1 reduction per 2-3°C FLEX over OAT, max ~25% thrust derate
  const flexDerate = Math.min(0.25, Math.max(0, (flexC - oatC) * 0.008))
  const thrustPlanKgf = cls.thrustEngKgf * (1 - flexDerate)

  // Inject realistic error population per NTSB SIR-08-01 retrospective:
  // ~5% of takeoffs carry ≥3% thrust error / ≥3 t ZFW error / ≥3°C FLEX error
  // ~12% carry 1-3% error in at least one element
  // For visual demo we slightly bias upward to ~22% any-error to keep
  // active aircraft on display.
  const errBucket = r1 * 100
  let zfwErrorKg = 0, flexErrorC = 0, thrustDeficitPct = 0, trimOob = false
  let actualThrust = thrustPlanKgf
  if (errBucket < 4) {
    // Hard EK407 mode: 100t ZFW underentry → FLEX assumed wrong → thrust deficit
    zfwErrorKg = 60_000 + r2 * 60_000
    flexErrorC = 8 + r3 * 10
    thrustDeficitPct = 6 + r4 * 6  // 6-12%
    actualThrust = thrustPlanKgf * (1 - thrustDeficitPct/100)
  } else if (errBucket < 10) {
    // Moderate: 10-30t ZFW error
    zfwErrorKg = 8_000 + r2 * 22_000
    flexErrorC = 3 + r3 * 6
    thrustDeficitPct = 2 + r4 * 4  // 2-6%
    actualThrust = thrustPlanKgf * (1 - thrustDeficitPct/100)
  } else if (errBucket < 18) {
    // Air-Florida-90 mode: engine probe icing → false-high indication →
    // pilot sets less thrust than commanded
    thrustDeficitPct = 8 + r4 * 15    // 8-23% thrust deficit
    actualThrust = thrustPlanKgf * (1 - thrustDeficitPct/100)
  } else if (errBucket < 23) {
    // NW255 mode: stab trim out-of-band (rotation issue, not accel)
    trimOob = true
  } else if (errBucket < 28) {
    // Small benign scatter
    thrustDeficitPct = (r4 - 0.5) * 3
    actualThrust = thrustPlanKgf * (1 - thrustDeficitPct/100)
  }

  // Actual acceleration scaling — by Newton's 2nd law roughly
  //   a_x = (T - D - μ·W)/m,  perturb T linearly
  const towKgErrorAdjusted = towKg + Math.max(0, zfwErrorKg)
  const massRatio = towKg / Math.max(towKg + Math.max(0, zfwErrorKg) * 0.6, 1)
  const ax80Actual = cls.ax80Ms2 * (actualThrust / thrustPlanKgf) * massRatio
    * (contam === 'WET' ? 0.985 : contam === 'CONTAM' ? 0.955 : 1.0)
    * envMul
  // Actual seconds to 80 KIAS scales inverse-sqrt of accel
  const t80Actual = cls.t80Sec * Math.sqrt(cls.ax80Ms2 / Math.max(ax80Actual, 0.5))

  // Phase-dependent reading. In ROLL-LO before 80kt we extrapolate; in
  // ROLL-MID and above we use the captured 80-kt readout.
  const axRatio = ax80Actual / cls.ax80Ms2
  // σ unit: each percent of thrust scatter ≈ 1% of accel ≈ N σ units where
  // 1σ = thrustSigmaPct percent. Negative = decel deficit.
  const axDeltaPct = (axRatio - 1) * 100
  const axSigma = axDeltaPct / cls.thrustSigmaPct

  // Distance rolled approximated from current speed assuming uniform accel
  // s = v² / (2·a). We use the actual accel.
  const vMs = f.velocityKts * 0.5144
  const distRolledM = (vMs * vMs) / (2 * Math.max(ax80Actual, 0.5))
  const distRolledFt = distRolledM * 3.2808
  // Distance from current speed to V1 at actual accel
  const v1Ms = cls.v1Kts * 0.5144
  const distToV1M = Math.max(0, (v1Ms*v1Ms - vMs*vMs) / (2 * Math.max(ax80Actual, 0.5)))
  const distToV1Ft = distToV1M * 3.2808
  const distRemainFt = Math.max(0, rwy.toraFt - distRolledFt)
  // Projected liftoff distance: distance to Vr at actual accel
  const vrMs = cls.vrKts * 0.5144
  const projLiftoffM = (vrMs*vrMs) / (2 * Math.max(ax80Actual, 0.5))
  const projLiftoffFt = projLiftoffM * 3.2808
  const margTodaFt = rwy.todaFt - projLiftoffFt

  // Rotation kt-late: if axRatio < 1, by the time the airplane reaches Vr
  // it has consumed (1/axRatio) of the planned distance, so:
  const rotateLateBy = Math.max(0, (1 - axRatio) * (cls.vrKts - cls.v1Kts) * 0.5)

  // Reason string
  let reason = '—'
  if (phase === 'OUT-OF-PHASE') reason = 'Not on a catalogued departure runway or not aligned'
  else if (phase === 'LINE-UP') reason = `Line-up · TOLD card armed · FLEX ${flexC}°C · TRIM ${stabTrimUnits} · TOW ${(towKg/1000).toFixed(0)}t`
  else if (axSigma <= -2 && distRemainFt < (rwy.toraFt - cls.dV1Ft) * 0.6)
    reason = `REJECT NOW — accel deficit ${axDeltaPct.toFixed(1)}% (${axSigma.toFixed(1)}σ) · ${distRemainFt.toFixed(0)}ft RWY remain`
  else if (axSigma <= -2)
    reason = `DECEL CRITICAL — accel deficit ${axDeltaPct.toFixed(1)}% (${axSigma.toFixed(1)}σ) · REJECT below V1 per FCTM 3.10`
  else if (axSigma <= -1)
    reason = `Accel low ${axDeltaPct.toFixed(1)}% (${axSigma.toFixed(1)}σ) · cross-check thrust set vs FLEX ${flexC}°C`
  else if (margTodaFt < 0)
    reason = `Projected liftoff ${projLiftoffFt.toFixed(0)}ft beyond TODA ${rwy.todaFt.toFixed(0)}ft — REJECT`
  else if (trimOob)
    reason = `Stab trim ${stabTrimUnits} OUTSIDE green band ${stabTrimGreenLo}-${stabTrimGreenHi} · NW255 mode (no TOWS protection)`
  else if (flexErrorC > 6)
    reason = `FLEX +${flexErrorC.toFixed(0)}°C over-derate vs ZFW error ${(zfwErrorKg/1000).toFixed(0)}t · EK407 mode`
  else if (axSigma > 1) reason = `Accel +${axDeltaPct.toFixed(1)}% (better than plan) · NORMAL`
  else reason = `Accel within ${axDeltaPct >=0?'+':''}${axDeltaPct.toFixed(1)}% (${axSigma.toFixed(1)}σ) of plan · NORMAL`

  return {
    flexC, flexCmax, thrustPlanKgf, cgPct, stabTrimUnits,
    stabTrimGreenLo, stabTrimGreenHi, zfwKg, towKg, oatC, headwindKts, contam,
    ax80Actual, t80Actual, axRatio, axSigma,
    distRolledFt, distToV1Ft, distRemainFt, projLiftoffFt, margTodaFt, rotateLateBy,
    reason, zfwErrorKg, flexErrorC, thrustDeficitPct, trimOob,
  }
}

// ---- Driver decomposition ----------------------------------------------
interface Drivers {
  accelDef: number      // 0..100 from axSigma (negative)
  distMarg: number      // 0..100 from runway remaining ratio
  todaMarg: number      // 0..100 from TODA-projLiftoff
  flexErr: number       // FLEX over-temp error
  zfwErr: number        // ZFW underentry magnitude
  trimOob: number       // trim out-of-band severity
  contam: number        // contaminated-rwy penalty
}

function computeDrivers(e: TopmsEval, rwy: Runway, cls: TopmsClass, phase: Phase): Drivers {
  // Accel deficit: each σ down = ~30 pts, capped 100
  const accelDef = e.axSigma >= 0 ? 0 : Math.min(100, -e.axSigma * 32)
  // Distance margin: ratio of remaining vs planned dV1
  const ratio = e.distRemainFt / Math.max(rwy.toraFt - cls.dV1Ft, 1)
  const distMarg = ratio >= 1 ? 0 : Math.min(100, (1 - ratio) * 80)
  // TODA margin
  const todaMarg = e.margTodaFt >= 0 ? 0 : Math.min(100, Math.min(100, -e.margTodaFt / 10))
  const flexErr = Math.min(100, e.flexErrorC * 8)
  const zfwErr = Math.min(100, (e.zfwErrorKg / 1000) * 1.4)
  const trimOob = e.trimOob ? 85 : 0
  const contam = e.contam === 'CONTAM' ? 45 : e.contam === 'WET' ? 22 : 0
  return { accelDef, distMarg, todaMarg, flexErr, zfwErr, trimOob, contam }
}

function composite(d: Drivers, advMul: number, phase: Phase): number {
  const vals = [d.accelDef, d.distMarg, d.todaMarg, d.flexErr, d.zfwErr, d.trimOob]
  const max = Math.max(...vals)
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length
  let s = max * 0.66 + mean * 0.34
  s += d.contam * 0.08
  // Phase weight
  const w = phase === 'ROLL-MID' ? 1.18 :
            phase === 'ROLL-V1+' ? 1.25 :
            phase === 'ROLL-LO'  ? 1.05 :
            phase === 'ROTATE'   ? 1.10 :
            phase === 'LINE-UP'  ? 0.45 : 0.20
  s *= w
  return Math.max(0, Math.min(100, s * advMul))
}

function scoreToTier(score: number, e: TopmsEval, rwy: Runway, cls: TopmsClass, phase: Phase): Tier {
  if (phase === 'OUT-OF-PHASE' || phase === 'POST-TO') return 'OUT-OF-PHASE'
  if (phase === 'LINE-UP') return 'IDLE-PRE'
  // Reject-now: 2σ accel deficit AND insufficient stop margin remaining
  if (e.axSigma <= -2 && e.distRemainFt < cls.dV1Ft * 0.55) return 'REJECT-NOW'
  if (e.axSigma <= -2) return 'DECEL-CRIT'
  if (e.axSigma <= -1) return 'DECEL-WARN'
  if (e.margTodaFt < -200) return 'TODA-EXC'
  if (e.trimOob) return 'TRIM-OOB'
  if (e.flexErrorC > 6 || e.zfwErrorKg > 30_000) return 'FLEX-OOR'
  return 'NOMINAL'
}

// ---- Row ----------------------------------------------------------------
interface Row {
  f: F
  snap: RwySnap
  rwy: Runway
  cls: TopmsClass
  phase: Phase
  ev: TopmsEval
  drivers: Drivers
  score: number
  tier: Tier
}

// ==== MAIN COMPONENT ====================================================
export default function TopmsMonitor({ map, flights, onClose, onFly }: Props) {
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [regionFilter, setRegionFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL'|'LINE'|'ROLL'|'POST'>('ALL')
  const [advMul, setAdvMul] = useState(1.0)
  const [envMul, setEnvMul] = useState(1.0)   // env perturbation (sim slider)
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shRwy, setShRwy] = useState(true)
  const [shProj, setShProj] = useState(true)
  const [tab, setTab] = useState<'AIRCRAFT'|'RUNWAYS'|'DRIVERS'|'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

  // ---- Build per-flight rows -------------------------------------------
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const snap = snapRunway(f)
      if (!snap) continue
      const cls = classifyType(f.type)
      const phase = classifyPhase(f, snap, cls)
      if (phase === 'OUT-OF-PHASE' || phase === 'POST-TO') continue
      const ev = evalTopms(f, snap, phase, cls, envMul)
      const drivers = computeDrivers(ev, snap.rwy, cls, phase)
      const score = composite(drivers, advMul, phase)
      const tier = scoreToTier(score, ev, snap.rwy, cls, phase)
      out.push({ f, snap, rwy: snap.rwy, cls, phase, ev, drivers, score, tier })
    }
    out.sort((a,b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, envMul])

  // ---- MapLibre overlay layers -----------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_AC   = 'topms-ac-src'
    const SRC_RWY  = 'topms-rwy-src'
    const SRC_PROJ = 'topms-proj-src'
    const SRC_LINK = 'topms-link-src'
    const ensure = (id: string) => { if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any }) }
    ;[SRC_AC, SRC_RWY, SRC_PROJ, SRC_LINK].forEach(ensure)

    const view = rows.filter(r =>
      (tierFilter === 'ALL' || r.tier === tierFilter) &&
      (regionFilter === 'ALL' || r.rwy.region === regionFilter) &&
      (phaseFilter === 'ALL' ||
       (phaseFilter === 'LINE' && r.phase === 'LINE-UP') ||
       (phaseFilter === 'ROLL' && (r.phase === 'ROLL-LO' || r.phase === 'ROLL-MID' || r.phase === 'ROLL-V1+')) ||
       (phaseFilter === 'POST' && r.phase === 'ROTATE'))
    )

    const acFeat: any[] = []
    const linkFeat: any[] = []
    const projFeat: any[] = []
    for (const r of view) {
      acFeat.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
        properties:{
          tier: r.tier,
          color: TIER_COLOR[r.tier],
          score: r.score,
          sz: 6 + (r.score/100) * 14,
          label: `${(r.f.callsign||r.f.icao).trim()} ${TIER_ABBR[r.tier]} ${r.rwy.iata}·${r.rwy.rwyId} ${r.phase==='ROLL-LO'?'LO':r.phase==='ROLL-MID'?'MID':r.phase==='ROLL-V1+'?'V1+':r.phase==='LINE-UP'?'LU':'RT'} ${r.ev.axSigma>0?'+':''}${r.ev.axSigma.toFixed(1)}σ`,
        },
      })
      linkFeat.push({
        type:'Feature',
        geometry:{ type:'LineString', coordinates:[ [r.f.lng, r.f.lat], [r.rwy.lng, r.rwy.lat] ] },
        properties:{ color: TIER_COLOR[r.tier] },
      })
      // Project liftoff endpoint along runway heading from threshold
      if (shProj && r.phase !== 'LINE-UP') {
        const hd = r.rwy.hdg * Math.PI / 180
        const projFtToM = r.ev.projLiftoffFt * 0.3048
        const dNm = projFtToM / 1852
        // Approx delta lat/lng (small angle)
        const dLat = (dNm * Math.cos(hd)) / 60
        const dLng = (dNm * Math.sin(hd)) / (60 * Math.cos(r.rwy.lat * Math.PI / 180))
        const endLat = r.rwy.lat + dLat, endLng = r.rwy.lng + dLng
        projFeat.push({
          type:'Feature',
          geometry:{ type:'LineString', coordinates:[ [r.rwy.lng, r.rwy.lat], [endLng, endLat] ] },
          properties:{ color: r.ev.margTodaFt < 0 ? '#fb7185' : r.ev.axSigma < -1 ? '#f59e0b' : '#10b981' },
        })
      }
    }
    const rwyFeat = shRwy ? RUNWAYS
      .filter(rwy => regionFilter === 'ALL' || rwy.region === regionFilter)
      .map(rwy => ({
        type:'Feature' as const,
        geometry:{ type:'Point' as const, coordinates:[rwy.lng, rwy.lat] },
        properties:{
          label: `${rwy.iata}·${rwy.rwyId} TORA${Math.round(rwy.toraFt/100)/10}k`,
          color: '#0ea5e9',
        },
      })) : []

    ;(map.getSource(SRC_AC)   as any).setData({ type:'FeatureCollection', features: (shHalo||shPin||shLbl) ? acFeat : [] })
    ;(map.getSource(SRC_RWY)  as any).setData({ type:'FeatureCollection', features: rwyFeat })
    ;(map.getSource(SRC_PROJ) as any).setData({ type:'FeatureCollection', features: projFeat })
    ;(map.getSource(SRC_LINK) as any).setData({ type:'FeatureCollection', features: (shHalo||shPin) ? linkFeat : [] })

    if (!map.getLayer('topms-rwy-pin'))
      map.addLayer({ id:'topms-rwy-pin', type:'circle', source:SRC_RWY, paint:{ 'circle-radius':4, 'circle-color':['get','color'], 'circle-opacity':0.5, 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.0 } })
    if (!map.getLayer('topms-rwy-lbl'))
      map.addLayer({ id:'topms-rwy-lbl', type:'symbol', source:SRC_RWY, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0,-1.3], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#cbd5e1', 'text-halo-color':'#0b0f17', 'text-halo-width':1.0 } })
    if (!map.getLayer('topms-proj'))
      map.addLayer({ id:'topms-proj', type:'line', source:SRC_PROJ, paint:{ 'line-color':['get','color'], 'line-width':2.4, 'line-opacity':0.75 } })
    if (!map.getLayer('topms-link'))
      map.addLayer({ id:'topms-link', type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.0, 'line-opacity':0.45, 'line-dasharray':[2,2] } })
    if (!map.getLayer('topms-halo'))
      map.addLayer({ id:'topms-halo', type:'circle', source:SRC_AC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.20, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.5, 'circle-stroke-opacity':0.9 } })
    if (!map.getLayer('topms-pin'))
      map.addLayer({ id:'topms-pin', type:'circle', source:SRC_AC, filter:['>=', ['get','score'], 55], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('topms-lbl'))
      map.addLayer({ id:'topms-lbl', type:'symbol', source:SRC_AC, filter:['>=', ['get','score'], 30], layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.3 } })

    return () => {
      for (const id of ['topms-lbl','topms-pin','topms-halo','topms-link','topms-proj','topms-rwy-lbl','topms-rwy-pin']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_AC, SRC_RWY, SRC_PROJ, SRC_LINK]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, regionFilter, phaseFilter, shHalo, shPin, shLbl, shRwy, shProj])

  // ---- Aggregations ----------------------------------------------------
  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (regionFilter === 'ALL' || r.rwy.region === regionFilter) &&
    (phaseFilter === 'ALL' ||
     (phaseFilter === 'LINE' && r.phase === 'LINE-UP') ||
     (phaseFilter === 'ROLL' && (r.phase === 'ROLL-LO' || r.phase === 'ROLL-MID' || r.phase === 'ROLL-V1+')) ||
     (phaseFilter === 'POST' && r.phase === 'ROTATE')) &&
    (!search || (
      (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      r.rwy.iata.toLowerCase().includes(search.toLowerCase()) ||
      r.rwy.icao.toLowerCase().includes(search.toLowerCase()) ||
      r.rwy.rwyId.toLowerCase().includes(search.toLowerCase()) ||
      r.cls.id.toLowerCase().includes(search.toLowerCase())
    ))
  )
  const counts: Record<Tier, number> = {
    'REJECT-NOW':0,'DECEL-CRIT':0,'DECEL-WARN':0,'TODA-EXC':0,
    'TRIM-OOB':0,'FLEX-OOR':0,'NOMINAL':0,'IDLE-PRE':0,'OUT-OF-PHASE':0,
  }
  for (const r of rows) counts[r.tier]++
  const nReject = counts['REJECT-NOW'] + counts['DECEL-CRIT']
  const meanSigma = rows.length ? rows.reduce((a,r)=>a+r.ev.axSigma,0)/rows.length : 0
  const worstSigma = rows.length ? Math.min(...rows.map(r => r.ev.axSigma)) : 0
  const meanThrustDef = rows.length ? rows.reduce((a,r)=>a+r.ev.thrustDeficitPct,0)/rows.length : 0
  const worst = rows[0]

  const rwyAgg = useMemo(() => {
    const m = new Map<string, { count:number; reject:number; warn:number; sumSig:number }>()
    for (const r of rows) {
      const k = `${r.rwy.icao}-${r.rwy.rwyId}`
      const v = m.get(k) || { count:0, reject:0, warn:0, sumSig:0 }
      v.count++
      if (r.tier === 'REJECT-NOW' || r.tier === 'DECEL-CRIT') v.reject++
      if (r.tier === 'DECEL-WARN' || r.tier === 'TODA-EXC' || r.tier === 'TRIM-OOB' || r.tier === 'FLEX-OOR') v.warn++
      v.sumSig += r.ev.axSigma
      m.set(k, v)
    }
    return Array.from(m.entries())
      .map(([k, v]) => {
        const rwy = RUNWAYS.find(rwy => `${rwy.icao}-${rwy.rwyId}` === k)!
        return { rwy, count:v.count, reject:v.reject, warn:v.warn, meanSig: v.count > 0 ? v.sumSig/v.count : 0 }
      })
      .sort((a,b) => (b.reject - a.reject) || (a.meanSig - b.meanSig))
  }, [rows])

  const driverAvg = useMemo(() => {
    if (!rows.length) return { accelDef:0, distMarg:0, todaMarg:0, flexErr:0, zfwErr:0, trimOob:0, contam:0 }
    const n = rows.length
    return {
      accelDef: rows.reduce((a,r)=>a+r.drivers.accelDef,0)/n,
      distMarg: rows.reduce((a,r)=>a+r.drivers.distMarg,0)/n,
      todaMarg: rows.reduce((a,r)=>a+r.drivers.todaMarg,0)/n,
      flexErr:  rows.reduce((a,r)=>a+r.drivers.flexErr,0)/n,
      zfwErr:   rows.reduce((a,r)=>a+r.drivers.zfwErr,0)/n,
      trimOob:  rows.reduce((a,r)=>a+r.drivers.trimOob,0)/n,
      contam:   rows.reduce((a,r)=>a+r.drivers.contam,0)/n,
    }
  }, [rows])

  // ---- Render ----------------------------------------------------------
  return (
    <div className="fixed top-16 right-3 z-40 w-[510px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">TOPMS</span>
          <span className="text-[10px] text-slate-400 truncate">In-Roll Accel-Check · SAE ARP-5419 / AC 25-25 / NASA TM-100455 / Pelyk 1988</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none ml-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.slice(0,7).map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className="flex-1 px-1 py-1 rounded text-[9px] font-mono border min-w-0"
            style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            <span className="truncate">{TIER_ABBR[t]}</span> {counts[t]}
          </button>
        ))}
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">RJN+DCR</div><div className="font-mono" style={{color: nReject > 0 ? '#f43f5e' : '#10b981'}}>{nReject}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MEAN-σ</div><div className="font-mono" style={{color: meanSigma >= -0.5 ? '#10b981' : meanSigma >= -1.5 ? '#f59e0b' : '#f43f5e'}}>{meanSigma>=0?'+':''}{meanSigma.toFixed(2)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WRST-σ</div><div className="font-mono" style={{color: worstSigma >= -0.5 ? '#10b981' : worstSigma >= -1.5 ? '#f59e0b' : '#f43f5e'}}>{worstSigma>=0?'+':''}{worstSigma.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">THR-DEF</div><div className="font-mono" style={{color: meanThrustDef <= 1.5 ? '#10b981' : meanThrustDef <= 3.5 ? '#f59e0b' : '#f43f5e'}}>{meanThrustDef.toFixed(1)}%</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1 truncate"><div className="text-slate-500">WRST</div><div className="font-mono truncate" title={worst?(worst.f.callsign||worst.f.icao).trim():'—'}>{worst ? (worst.f.callsign||worst.f.icao).trim().slice(0,7) : '—'}</div></div>
      </div>

      {/* Sliders + filters */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ENV-MUL <span className="text-slate-200 font-mono">{(envMul*100).toFixed(0)}%</span>
            <input type="range" min="70" max="115" value={envMul*100} onChange={e=>setEnvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','LINE','ROLL','POST'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p==='ALL'?'ALL-PHS':p}</button>
          ))}
          <span className="text-slate-700 self-center">›</span>
          <button onClick={()=>setRegionFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-RGN</button>
          {(['NA-US','NA-CA','EU','UK','ASIA','PAC','ME'] as const).map(r => (
            <button key={r} onClick={()=>setRegionFilter(r)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${regionFilter===r?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{r}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {([['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['RWY',shRwy,setShRwy],['PROJ',shProj,setShProj]] as const).map(([n,v,fn]) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/rwy" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT','RUNWAYS','DRIVERS','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">

        {tab === 'AIRCRAFT' && (
          <>
            {visible.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft in take-off-roll phase at any catalogued runway · relax filters or wait for surface traffic</div>
            )}
            {visible.slice(0, 60).map(r => {
              const isP = picked === r.f.icao
              return (
                <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{TIER_ABBR[r.tier]}</span>
                      <button onClick={()=>{ setPicked(r.f.icao); onFly(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300 truncate">{(r.f.callsign||r.f.icao).trim()}</button>
                      <span className="text-slate-400 text-[10px] truncate">{(r.f.type||'?').toUpperCase()} · {r.cls.id}</span>
                    </div>
                    <div className="text-[10px] font-mono shrink-0" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                  </div>

                  {/* TOPMS strip */}
                  <div className="mt-1.5 bg-slate-900/60 rounded p-1.5 font-mono text-[9px] text-slate-300 leading-tight overflow-x-auto whitespace-nowrap">
                    <span className="text-slate-500">{r.phase}@</span><span className="text-sky-300">{r.rwy.iata}·{r.rwy.rwyId}</span>
                    <span className="text-slate-500"> V1/Vr </span><span className="text-slate-200">{r.cls.v1Kts}/{r.cls.vrKts}</span>
                    <span className="text-slate-500"> IAS </span><span className="text-slate-200">{r.f.velocityKts.toFixed(0)}</span>
                    <span className="text-slate-500"> ax </span><span className={r.ev.axSigma <= -1 ? 'text-rose-400' : r.ev.axSigma <= -0.5 ? 'text-amber-300' : 'text-emerald-300'}>{r.ev.ax80Actual.toFixed(2)}m/s² ({r.ev.axSigma>=0?'+':''}{r.ev.axSigma.toFixed(1)}σ)</span>
                    <span className="text-slate-500"> RWY-LEFT </span><span className={r.ev.distRemainFt < 3000 ? 'text-amber-300' : 'text-slate-200'}>{r.ev.distRemainFt.toFixed(0)}ft</span>
                    <span className="text-slate-500"> LOFT-PROJ </span><span className={r.ev.margTodaFt < 0 ? 'text-rose-400' : 'text-slate-200'}>{r.ev.projLiftoffFt.toFixed(0)}ft</span>
                    <span className="text-slate-500"> TODA-MRG </span><span className={r.ev.margTodaFt < 0 ? 'text-rose-400' : 'text-emerald-300'}>{r.ev.margTodaFt>=0?'+':''}{r.ev.margTodaFt.toFixed(0)}ft</span>
                  </div>

                  {/* Reason line */}
                  <div className="mt-1 text-[10px] text-slate-300 leading-snug">{r.ev.reason}</div>

                  {/* Driver chips */}
                  <div className="mt-1 flex flex-wrap gap-0.5 text-[9px] font-mono">
                    {(['accelDef','distMarg','todaMarg','flexErr','zfwErr','trimOob','contam'] as const).map(k => {
                      const v = r.drivers[k]
                      const sev = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#475569'
                      return (
                        <span key={k} className="px-1 py-0.5 rounded border text-[8px]" style={{ borderColor: sev + '60', color: sev }}>{k.slice(0,4).toUpperCase()}{v.toFixed(0)}</span>
                      )
                    })}
                  </div>

                  {isP && (
                    <div className="mt-2 pt-2 border-t border-slate-700/40 text-[10px] space-y-1">
                      <div className="text-slate-400">Type-class: <span className="text-slate-200">{r.cls.label}</span></div>
                      <div className="text-slate-400">TOPMS architecture: <span className="font-mono text-slate-200">{r.cls.topmsArchi}</span></div>
                      <div className="text-slate-400">TOLD card: FLEX <span className="font-mono text-slate-200">{r.ev.flexC}°C</span> · TOW <span className="font-mono text-slate-200">{(r.ev.towKg/1000).toFixed(0)}t</span> · CG <span className="font-mono text-slate-200">{r.ev.cgPct.toFixed(1)}%</span> · TRIM <span className={`font-mono ${r.ev.trimOob?'text-rose-400':'text-slate-200'}`}>{r.ev.stabTrimUnits}u</span> (green {r.ev.stabTrimGreenLo}-{r.ev.stabTrimGreenHi})</div>
                      <div className="text-slate-400">Environment: OAT <span className="font-mono text-slate-200">{r.ev.oatC.toFixed(0)}°C</span> · HW <span className="font-mono text-slate-200">{r.ev.headwindKts.toFixed(0)}kt</span> · RWY <span className="font-mono text-slate-200">{r.ev.contam}</span></div>
                      <div className="text-slate-400">Planned-vs-actual: a_x plan <span className="font-mono text-slate-200">{r.cls.ax80Ms2.toFixed(2)}m/s²</span> → actual <span className="font-mono text-slate-200">{r.ev.ax80Actual.toFixed(2)}m/s²</span> · t→80 plan <span className="font-mono text-slate-200">{r.cls.t80Sec.toFixed(1)}s</span> → actual <span className="font-mono text-slate-200">{r.ev.t80Actual.toFixed(1)}s</span></div>
                      <div className="text-slate-400">RWY decl: TORA <span className="font-mono text-slate-200">{r.rwy.toraFt}ft</span> · ASDA <span className="font-mono text-slate-200">{r.rwy.asdaFt}ft</span> · TODA <span className="font-mono text-slate-200">{r.rwy.todaFt}ft</span></div>
                      {r.ev.thrustDeficitPct > 1 && <div className="text-amber-300">Root-cause hint: thrust deficit ~{r.ev.thrustDeficitPct.toFixed(1)}% — check EPR/N1 set vs target {(r.ev.flexC).toFixed(0)}°C FLEX</div>}
                      {r.ev.zfwErrorKg > 5_000 && <div className="text-amber-300">Root-cause hint: ZFW underentry ~{(r.ev.zfwErrorKg/1000).toFixed(0)}t (Emirates 407 / Thomson 253 mode)</div>}
                      {r.ev.flexErrorC > 4 && <div className="text-amber-300">Root-cause hint: FLEX over-temp ~+{r.ev.flexErrorC.toFixed(0)}°C — derate too aggressive for actual TOW</div>}
                      {r.ev.trimOob && <div className="text-amber-300">Root-cause hint: stab trim outside green band — NW255 mode, TOWS would not catch this on rotation</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {tab === 'RUNWAYS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">Runway accel-deficit ranking — sort by REJECT+DECEL count then mean σ</div>
            {rwyAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">No aircraft on a catalogued runway.</div>
            )}
            {rwyAgg.map(a => (
              <div key={`${a.rwy.icao}-${a.rwy.rwyId}`} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-sky-300">{a.rwy.iata}·{a.rwy.rwyId}</span>
                    <span className="text-[10px] text-slate-400 truncate">hdg {a.rwy.hdg}° · elev {a.rwy.elevFt}ft</span>
                  </div>
                  <span className="text-[9px] font-mono text-slate-300">{a.rwy.region}</span>
                </div>
                <div className="mt-1 grid grid-cols-5 gap-1 text-[9px] font-mono">
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">N</span> <span className="text-slate-200">{a.count}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">REJ</span> <span className={a.reject>0?'text-rose-400':'text-slate-200'}>{a.reject}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">WRN</span> <span className={a.warn>0?'text-amber-300':'text-slate-200'}>{a.warn}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">MEAN-σ</span> <span style={{color: a.meanSig >= -0.5 ? '#10b981' : a.meanSig >= -1.5 ? '#f59e0b' : '#f43f5e'}}>{a.meanSig>=0?'+':''}{a.meanSig.toFixed(2)}</span></div>
                  <div className="bg-slate-900/50 rounded px-1 py-0.5"><span className="text-slate-500">TORA</span> <span className="text-slate-200">{Math.round(a.rwy.toraFt/100)/10}k</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 font-mono">
                  TORA {a.rwy.toraFt}ft · ASDA {a.rwy.asdaFt}ft · TODA {a.rwy.todaFt}ft
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'DRIVERS' && (
          <>
            <div className="text-[10px] text-slate-500 mb-1 px-1">7-driver mean across N={rows.length} tracked aircraft</div>
            {([
              ['accelDef','ACCL · longitudinal accel deficit in σ units', driverAvg.accelDef],
              ['distMarg','DIST · distance-to-V1 vs runway remaining', driverAvg.distMarg],
              ['todaMarg','TODA · projected liftoff vs TODA-50ft screen', driverAvg.todaMarg],
              ['flexErr', 'FLEX · assumed-temperature derate error', driverAvg.flexErr],
              ['zfwErr',  'ZFW  · zero-fuel-weight underentry magnitude', driverAvg.zfwErr],
              ['trimOob', 'TRIM · stab trim outside published green band', driverAvg.trimOob],
              ['contam',  'CTAM · contaminated runway μ penalty', driverAvg.contam],
            ] as const).map(([k, lbl, v]) => {
              const pct = Math.min(100, v)
              const col = v >= 70 ? '#f43f5e' : v >= 40 ? '#f59e0b' : v >= 15 ? '#0ea5e9' : '#10b981'
              return (
                <div key={k} className="border border-slate-700/40 rounded-lg p-2 bg-slate-800/40">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-300 font-mono">{lbl}</span>
                    <span className="font-mono" style={{ color: col }}>{v.toFixed(1)}</span>
                  </div>
                  <div className="mt-1 h-1.5 bg-slate-900/60 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: col }} />
                  </div>
                </div>
              )
            })}
            <div className="text-[9px] text-slate-500 px-1 pt-1 leading-relaxed">
              Composite = max(accl,dist,toda,flex,zfw,trim)·0.66 + mean(·)·0.34 + ctam·0.08, then × phase-weight × ADV-MUL.
              ACCL ramps 32 pts per σ down from plan. REJECT-NOW fires when accel deficit ≥2σ AND runway remaining &lt; 55% of planned dV1.
              DECEL-CRIT at ≥2σ deficit regardless of remaining — REJECT below V1 per FCTM 3.10. TODA-EXC when projected liftoff overshoots
              declared TODA-50ft screen. Driver weights tuned to NTSB SIR-08-01 retrospective: 13 of 15 TOLD-error events would have been
              caught at the 80-KIAS gate with ≥1σ threshold.
            </div>
          </>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-2 p-1">
            <p><span className="text-sky-300 font-mono">DEFINITION.</span> Take-Off Performance Monitoring System (TOPMS) is a real-time predicted-vs-actual longitudinal-acceleration audit fired during the take-off roll, alerting the crew when measured a_x falls below the planned TOLD profile by &gt;2σ at the calibrated check gate (80 KIAS Boeing / 100 KIAS Airbus) — driving the REJECT-BELOW-V1 escape branch per FCTM 3.10.</p>
            <p><span className="text-sky-300 font-mono">REGULATORY.</span> 14 CFR §25.105/107/111/113 / EASA CS-25.105 / FAA AC 25-25 Performance &amp; Handling Ratings / FAA AC 91-79B Mitigating Runway Overrun Risk / SAE ARP-5419 Rev B Take-Off Performance Monitoring System / NASA TM-100455 (Pelyk 1988) Flight-Test Demonstration of TOPMS — established 4% accel discrimination at 80 KIAS gate.</p>
            <p><span className="text-sky-300 font-mono">ARCHITECTURE TIMELINE.</span> 1976 Lockheed L-1011 TriStar PMS (first integrated TOPMS, Garrett mech-electric ATM-200). 1991 Boeing C-17A TOPMS (full digital integrated FCS). 2011 Boeing 787 EFB OPT (FlightDeck Pro full TOPMS suite). 2013 Airbus A350 FlySmart EFB ACCEL-CHK 100 kt. 2018 Embraer E2 ITPS. 2019 Gulfstream G650/G700 Honeywell IPMS. B737 / A320ceo / CRJ7-9 / regional turboprops use MANUAL ACCEL-CHK calls per FCTM Ch.3 or no formal TOPMS.</p>
            <p><span className="text-sky-300 font-mono">ROOT-CAUSE TAXONOMY.</span> (1) Thrust deficit — engine probe icing (Air-Florida 90 mode), bird-strike fan damage, EEC fault. (2) TOLD-data entry error — ZFW underentry (Emirates 407 mode, Thomson 253), FLEX over-derate, V-speeds from wrong RWY. (3) Configuration — stab trim out-of-band (NW255 mode — TOWS silent if C/B open), flaps under-set (Spanair 5022 mode). (4) Environment — contaminated runway μ collapse, wind shear, density-altitude high. NTSB SIR-08-01 found 13 of 15 historical TOLD-error events would have been caught at the 80-KIAS gate.</p>
            <p><span className="text-sky-300 font-mono">SCORING.</span> Per-flight: REJECT-NOW if ≥2σ deficit AND distRemain &lt; 55% of planned dV1; DECEL-CRIT if ≥2σ regardless; DECEL-WARN at 1-2σ; TODA-EXC if projected liftoff overshoots declared TODA-50ft screen; TRIM-OOB if stab trim outside green band; FLEX-OOR if FLEX over-temp &gt;6°C or ZFW error &gt;30t; NOMINAL if within ±1σ. Phase-weight peaks at ROLL-V1+ (1.25×).</p>
            <p><span className="text-sky-300 font-mono">DISTINCT FROM.</span> TOLD-BFL (pre-roll calculation card — TOPMS validates it during the roll); RTOW (pre-roll balanced-field math); TOWS (binary aural §25.703 config audit at brake-release); RTO (V1 reject decision — TOPMS feeds it with predicted-vs-actual divergence); LVTO (low-vis RVR regime); INTXN-DEP (intersection departure reduced TORA); EOSID (post-V1 OEI escape SID); TAIL-STRK (rotation pitch geometry); HYDROPLANE (tire water-film friction); FLEX-ATM (assumed-temp thrust setpoint — pre-roll lever); WAT (weight-altitude-temperature certification floor); CSURGE (HPC surge stability — engine-side aerodynamic).</p>
          </div>
        )}
      </div>
    </div>
  )
}
