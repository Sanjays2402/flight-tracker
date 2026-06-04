// ALPHA-FLOOR · Alpha-Protection-Law / Auto-Thrust Wakeup / High-AoA Envelope-Protection Monitor
//
// What this is
// ------------
// A per-airframe live evaluator of the HIGH-ANGLE-OF-ATTACK ENVELOPE-PROTECTION
// SUBSYSTEM state for each aircraft, scoring whether the certified protection
// law will (a) ARM Alpha-Prot (the law engages and replaces conventional speed
// control with AOA control), (b) trigger ALPHA-FLOOR (the autothrust wakes up
// and commands TO/GA thrust irrespective of A/THR mode or pilot input), or
// (c) drive ALPHA-MAX (the airframe holds the certified maximum AoA against
// the pilot's nose-up demand) — the LAST-LINE certified FBW protection that
// distinguishes a fully-protected Airbus or B777/B787 from a conventional jet
// where the same conditions would result in a stall warning only.
//
// This is the AIRBORNE PROTECTION-LAW state, not a stall margin number. Per
// Airbus A320 FCOM DSC-22 §1 Flight Controls Normal Law / DSC-27 §3 Auto Flight
// System / FCTM PRO-NOR-SOP-21 PROTECTIONS, the alpha protection band is
// bracketed by three specific angles:
//
//   α_PROT  — protection-arm threshold (~16-18°): SS forward neutralised,
//             A/P disconnects, side-stick deflection commands AoA directly,
//             autotrim freezes, V_PROT band shown on PFD speed scale
//   α_FLOOR — A/THR wakeup threshold (~17-19°, typically α_PROT + 1.0-1.5°):
//             autothrust selects TOGA THRUST irrespective of pilot input or
//             A/THR mode; the only way to override is to manually push the
//             thrust levers to MAX and back to TOGA detent
//   α_MAX   — maximum AoA achievable in Normal Law (~19-22°, ~1°-2° below
//             stall AoA α_S): full aft side-stick holds this AoA against
//             the gravitational and inertial moments; the airframe cannot
//             stall in Normal Law (Sully demonstrated this with US-1549 in
//             the Hudson river ditching at α≈14° well below α_PROT)
//
// On B777/B787 with the Boeing FBW law architecture the equivalent thresholds
// are α_REF (reference AoA, the trim-target during flare and approach where
// pitch axis is AOA-driven), α_MIN-SPD (PFD chevron band marking minimum
// manoeuvre speed at current weight/config), and α_STK-SHKR (stick-shaker
// activation at ~1.10·α_REF). Boeing FBW does NOT implement an A/THR alpha-
// floor wakeup; that is uniquely Airbus per AMM 22-30-00. Boeing maintains
// stick-shaker + stall ID + AFDS reversion to manual.
//
// Distinct from / complementary to existing overlays:
//   · STALL (the 1g longitudinal AOA-margin/buffet warning - the regime
//            BEFORE protections engage, no FBW law involvement, applies to
//            every airframe including conventional jets and pre-FBW types)
//   · FBW-REV (the airborne LAW REVERSION state Normal/Alt1/Alt2/Direct -
//              when protections are LOST, not when they are active)
//   · COFFIN (Mach-Vs1g cruise envelope - the high-FL low-margin regime
//             that triggers protections eventually, but COFFIN is the speed
//             squeeze geometry, not the protection state)
//   · TEM-ENERGY (kinetic+potential balance - related but TEM is energy
//                 management not the AOA-protection law)
//   · STABLE-APP (stabilised-approach gate - 1000ft/500ft criteria, no AOA)
//   · PIO (closed-loop pilot bandwidth handling-quality - control inceptor
//          coupling not high-AOA protection)
//   · MCAS (B737MAX stab-trim runaway - longitudinal pitch-augmentation
//           subsystem at moderate AOA, NOT a high-AoA protection)
//   · FMA (automation MODE-AWARENESS displayed annunciator strip - what
//          mode you're in, NOT what envelope-protection law is doing to
//          the controls)
//   · VMC (asymmetric-thrust lateral controllability floor - directional,
//          steady-state OEI)
//   · DUTCH-ROLL (lateral-directional 2nd eigenmode oscillation - dynamic
//                 lateral, not high-AOA)
//
// ALPHA-FLOOR is uniquely the HIGH-AOA CERTIFIED-PROTECTION-LAW evaluator,
// scoring whether each airframe is approaching or inside the alpha-prot band,
// whether the A/THR is or would be commanded to wake up to TOGA, whether the
// airframe is in a flight phase where this matters, and whether the airframe
// even has the law implemented per its type.
//
// Per-airframe FBW protection-law catalogue (10 classes):
//   AB-FBW-NEW   A350 / A380 / A220 Normal-Law (latest spec, α-PROT 16.5°,
//                α-FLOOR 17.5°, α-MAX 19.5°, full alpha-protection enabled
//                throughout flight envelope incl. high-FL)
//   AB-FBW-CLS   A320-fam / A330 / A340 Normal-Law (foundational FBW per
//                Wolfgang Bremer / Pierre Baud 1984, α-PROT 17°, α-FLOOR 18°,
//                α-MAX 21°, alpha-floor inhibited above 100ft AGL on
//                approach if Vapp-target stable per FCOM DSC-27)
//   AB-FBW-ALT   A320 in Alternate Law (protections LOST per DSC-22 §2;
//                stall warning only at α_SW ≈ α_PROT - 1°, no AOA control)
//   BO-FBW-NEW   B787 / B777X new-gen Boeing-FBW (α-REF AOA-tracking in
//                flare, stall-ID at α-stall, no A/THR alpha-floor wakeup;
//                AFDS holds path but does not autobreathe thrust)
//   BO-FBW-CLS   B777 classic Boeing-FBW (Hesse spec 1995, α-REF + stall-ID
//                + soft envelope-protection limits, no autothrust wakeup)
//   BO-CONV      B737-NG/MAX / B757 / B767 / B747-400 conventional cable
//                or hydraulic flight controls (NO FBW, NO alpha-protection,
//                stick-shaker + stick-pusher only on some variants)
//   BO-737MAX-MCAS  B737MAX pitch-augmentation subsystem (NOT alpha-protect:
//                MCAS commands nose-DOWN trim at high AOA to compensate for
//                LEAP-1B nacelle-lift moment, the opposite of an alpha-floor)
//   E-JET-FBW    E190-E2 / E195-E2 FBW Normal-Law (Brazilian-FBW per
//                Embraer FOM ch.10, AOA-band + thrust-protection but no
//                full alpha-floor wakeup)
//   RGN-CONV     CRJ / E170 / ATR / Q400 conventional flight controls,
//                stick-shaker + pusher on some, no alpha-protection
//   GA-LIGHT     light aircraft / piston (NO FBW, no protection law, basic
//                AOA indicator on some glass-cockpit retrofits)
//
// Per-airframe AOA state (synthesised from icao-hash, deterministic):
//   The actual AOA is computed from the IAS/Vapp ratio + load-factor proxy
//   + phase-specific factor. The AoA the airframe is operating at right NOW:
//     base α = α_TRIM + (1.0/IAS_ratio² - 1) · α_DELTA + n_z proxy
//   where IAS_ratio = IAS/Vapp (lower → higher AOA, classic 1/V² scaling)
//   and load factor proxy adds AOA in steep banks / pull-ups.
//
// 7 risk drivers (each normalised 0-100, mapped to score)
//   ALPHA  - α current vs α_PROT (1.0 at α=α_FLOOR, 0 at α<α_PROT-2°)
//   IAS    - IAS deficit below Vapp (1.0 at IAS<Vs1g, 0 at IAS>Vapp+10kts)
//   AFLR   - is alpha-floor active right now (binary big-hit, 100 if active)
//   APROT  - is alpha-prot armed (binary, 80 if in band)
//   PHASE  - APPR-FNL / TKO-LIFT 1.5x / GA 1.3x / TMA 1.0 / CRZ 0.6
//   LAW    - what FBW law is active (Normal=0, Alt-1=40, Alt-2=70, Direct=90,
//            Conventional NoFBW=20 i.e. some stick-shaker mitigation only)
//   ENERGY - kinetic + potential energy deficit (low+slow penalty)
//
// Composite = max·0.66 + mean·0.34 × phase-weight × ADV-MUL
//
// 6 tier system (sky/emerald accent for chrome, rose for safety-critical):
//   ALPHA-FLOOR  ≥ 85 - alpha-floor active, A/THR TOGA driven now
//                       (rose, immediate authority hand-off, AF447 Mont mode)
//   ALPHA-PROT   ≥ 65 - alpha-protection armed, stick-back commanding AOA
//                       (rose-pink, SS-fwd to neutralise or release)
//   ALPHA-WATCH  ≥ 45 - within 1° of α_PROT, monitor closely
//                       (amber, reduce AOA, increase speed)
//   ALPHA-MARG   ≥ 22 - 2-3° below α_PROT, healthy band
//                       (sky, monitoring normal envelope)
//   NOMINAL      < 22 - well within envelope                 (emerald)
//   OFF             - on-ground or non-FBW class no protection (slate)
//
// MapLibre overlay:
//   - tier-coloured halo rings 7-19px score-sized
//   - ALPHA-FLOOR/ALPHA-PROT pins
//   - dashed forward AOA-trend vector (length proportional to AOA-margin
//     deficit, perpendicular jitter if alpha-floor active)
//   - cs / cls / α / V/Vapp labels
//
// Side panel:
//   - 6-tier counter strip click-to-filter
//   - 5-cell summary (μ-α, μ-V/Vapp, AFLR cnt, APROT cnt, WORST)
//   - 4 sliders ADV-MUL / APP-MUL / AOA-OFFSET / LAW-MUL
//   - 6-phase chip filter (TKO-LIFT, CLIMB, CRZ, TMA, APPR-FNL, GA)
//   - HALO/PIN/LBL/VEC toggles + search
//   - AIRCRAFT / CLASSES / ENVELOPE / METHOD tabs
//
// AIRCRAFT tier-worst-first row stack:
//   cs + type + law-pill + phase-pill + tier-pill
//   α / V/Vapp / AOA-margin / Law row
//   α_PROT / α_FLOOR / α_MAX / α_S row
//   tier-coloured score bar + 7-driver chips + advice line
//
// CLASSES per-class row:
//   law-pill + protection-band table (α_PROT/α_FLOOR/α_MAX/α_S in degrees)
//   + class counters (AFLR cnt / APROT cnt)
//
// ENVELOPE tab full SVG:
//   AOA-vs-IAS envelope plot for picked airframe class showing
//   - α_PROT (rose dashed)
//   - α_FLOOR (rose solid)
//   - α_MAX (rose double-line)
//   - α_S stall (slate dashed)
//   - V_PROT band on x-axis
//   - all fleet plotted as tier-coloured dots at their current (V/Vapp, α)
//
// METHOD tab:
//   text panels with definition, distinct-from list, hard-escalator table,
//   precedent accident family (AF447, Asiana 214, Aeroflot SU1492,
//   AirAsia 8501), and references (CS-25.143, DSC-22 §1, AMM 22-30-00,
//   etc.)
//
// References: 14 CFR §25.143(h) §25.171 §25.173 §25.175 §25.207 §25.255 /
// EASA CS-25.143 §25.207 §25.143(h) / AMC 25.207(c) / FAA AC 25-7D §5.2.5 /
// Airbus A320/A330/A340/A350/A380 FCOM DSC-22 §1 / FCOM DSC-27 §3 / FCTM
// PRO-NOR-SOP-21 / AMM 22-30-00 Auto-Thrust Alpha-Floor / Briere & Traverse
// AIAA-93-3811 A320 FBW Architecture / Favre AIAA-94-3492 FBW Certification /
// Boeing 777 / 787 FCOM Vol 2 §03 Flight Controls / Hesse AIAA-95-3416 B777
// FBW spec / Embraer E190-E2 / E195-E2 FOM ch.10 FBW / NTSB AAR-14-01
// Asiana 214 (B777 AFDS / FLCH HOLD / no Boeing alpha-floor wakeup) /
// BEA AF447 (A330 stall in ALT-2 with no alpha-protection) / KNKT SBI
// AirAsia 8501 (A320 LOC-I after RTLU reset, ALT-2 law / no protection) /
// AAIB INT report Turkish 1951 (B737 conventional, no alpha-prot) /
// Interstate Aviation Committee Aeroflot 1492 (SSJ100, SVO 2019, stall in
// non-FBW law).

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import maplibregl from 'maplibre-gl'

type Tier = 'ALPHA-FLOOR'|'ALPHA-PROT'|'ALPHA-WATCH'|'ALPHA-MARG'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier, string> = {
  'ALPHA-FLOOR':'#ef4444',
  'ALPHA-PROT':'#f43f5e',
  'ALPHA-WATCH':'#f59e0b',
  'ALPHA-MARG':'#0ea5e9',
  'NOMINAL':'#10b981',
  'OFF':'#475569'
}
const TIER_RANK: Record<Tier, number> = {
  'ALPHA-FLOOR':0,'ALPHA-PROT':1,'ALPHA-WATCH':2,'ALPHA-MARG':3,'NOMINAL':4,'OFF':5
}
const TIER_ORDER: Tier[] = ['ALPHA-FLOOR','ALPHA-PROT','ALPHA-WATCH','ALPHA-MARG','NOMINAL']

type Law = 'NORMAL'|'ALT-1'|'ALT-2'|'DIRECT'|'CONV'|'NONE'

interface ClassSpec {
  cls: string
  label: string
  aProt: number     // α_PROT degrees
  aFloor: number    // α_FLOOR degrees
  aMax: number      // α_MAX degrees (or alpha-stick-shaker on Boeing)
  aStall: number    // α_S aerodynamic stall AoA
  vRefMul: number   // typical Vref multiplier vs Vs1g
  hasAFlrAThr: boolean   // Airbus-style A/THR alpha-floor wakeup
  defaultLaw: Law
  vapTyp: number    // typical Vapp KIAS at MLW
}

const SPECS: ClassSpec[] = [
  { cls:'AB-FBW-NEW',  label:'Airbus A350/A380/A220 Normal-Law (full alpha-protect)',
    aProt:16.5, aFloor:17.5, aMax:19.5, aStall:21.5, vRefMul:1.23, hasAFlrAThr:true,
    defaultLaw:'NORMAL', vapTyp:140 },
  { cls:'AB-FBW-CLS',  label:'Airbus A320/A330/A340 Normal-Law (foundational FBW)',
    aProt:17.0, aFloor:18.0, aMax:21.0, aStall:23.0, vRefMul:1.23, hasAFlrAThr:true,
    defaultLaw:'NORMAL', vapTyp:138 },
  { cls:'AB-FBW-ALT',  label:'Airbus Alt-Law (protections LOST · stall warning only)',
    aProt:99.0, aFloor:99.0, aMax:99.0, aStall:22.5, vRefMul:1.23, hasAFlrAThr:false,
    defaultLaw:'ALT-2', vapTyp:138 },
  { cls:'BO-FBW-NEW',  label:'Boeing B787/B777X FBW (α-REF + stall ID, no A/THR wake)',
    aProt:14.5, aFloor:99.0, aMax:17.0, aStall:19.0, vRefMul:1.30, hasAFlrAThr:false,
    defaultLaw:'NORMAL', vapTyp:142 },
  { cls:'BO-FBW-CLS',  label:'Boeing B777-classic FBW (α-REF + soft protection)',
    aProt:14.0, aFloor:99.0, aMax:16.5, aStall:18.5, vRefMul:1.30, hasAFlrAThr:false,
    defaultLaw:'NORMAL', vapTyp:145 },
  { cls:'BO-CONV',     label:'Boeing B737NG/MAX/B757/B767/B747-400 cable+stick-shaker',
    aProt:99.0, aFloor:99.0, aMax:99.0, aStall:17.5, vRefMul:1.30, hasAFlrAThr:false,
    defaultLaw:'CONV', vapTyp:140 },
  { cls:'BO-737-MCAS', label:'B737MAX (MCAS nose-DOWN at high AOA, NOT alpha-protect)',
    aProt:99.0, aFloor:99.0, aMax:99.0, aStall:17.5, vRefMul:1.30, hasAFlrAThr:false,
    defaultLaw:'CONV', vapTyp:144 },
  { cls:'E-JET-FBW',   label:'Embraer E190-E2/E195-E2 FBW Normal-Law',
    aProt:15.5, aFloor:99.0, aMax:18.0, aStall:20.0, vRefMul:1.23, hasAFlrAThr:false,
    defaultLaw:'NORMAL', vapTyp:130 },
  { cls:'RGN-CONV',    label:'CRJ/E170/ATR/Q400 conventional + stick-shaker/pusher',
    aProt:99.0, aFloor:99.0, aMax:99.0, aStall:17.0, vRefMul:1.30, hasAFlrAThr:false,
    defaultLaw:'CONV', vapTyp:128 },
  { cls:'GA-LIGHT',    label:'Light GA / piston · no FBW · pilot-only stall judgement',
    aProt:99.0, aFloor:99.0, aMax:99.0, aStall:18.0, vRefMul:1.30, hasAFlrAThr:false,
    defaultLaw:'NONE', vapTyp:70 },
]

function specOf(type?: string): ClassSpec {
  const t = (type||'').toUpperCase()
  if (/^(A35|A38|BCS|A22)/.test(t)) return SPECS[0]
  if (/^(A31|A32|A20|A21|A33|A34|A30)/.test(t)) return SPECS[1]
  if (/^(B78|B77W|B77X)/.test(t)) return SPECS[3]
  if (/^(B77|B772|B773)/.test(t)) return SPECS[4]
  if (/^(B38|B39)/.test(t)) return SPECS[6]   // 737 MAX
  if (/^(B73|B75|B76|B74)/.test(t)) return SPECS[5]
  if (/^(E29|E27|E190|E195)/.test(t) && /E2$/.test(t)) return SPECS[7]
  if (/^(E29|E27)/.test(t)) return SPECS[7]
  if (/^(E17|E19|CRJ|RJ7|RJ8|RJ9|AT4|AT7|DH8|SF34)/.test(t)) return SPECS[8]
  if (/^(C17|C72|PA|BE|DA|SR|P28|C152|C162|C182)/.test(t)) return SPECS[9]
  return SPECS[1]
}

interface MFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props {
  map: maplibregl.Map | null
  flights: MFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Phase = 'TKO-LIFT'|'CLIMB'|'CRZ'|'TMA'|'APPR-FNL'|'GA'|'OFF'

function classifyPhase(f: MFlight): Phase {
  if (f.ground) return 'OFF'
  const fl = f.altitudeFt/100
  const vs = f.vertRate
  if (fl < 5 && vs > 200) return 'TKO-LIFT'
  if (fl < 30 && vs > 800) return 'CLIMB'
  if (fl >= 280 && Math.abs(vs) < 700) return 'CRZ'
  if (fl < 50 && vs < -200 && f.velocityKts < 220) return 'APPR-FNL'
  if (fl < 30 && vs > 300 && f.velocityKts < 200) return 'GA'
  return 'TMA'
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)) }

function dhash(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 }
  return (h >>> 0) / 0xffffffff
}

// Standard atmosphere density ratio σ = ρ/ρ_sl
function sigma(alt_ft: number): number {
  const h = alt_ft * 0.3048
  if (h < 11000) {
    const T = 288.15 - 0.0065*h
    return Math.pow(T/288.15, 4.2561)
  } else {
    const sigma11 = 0.2971
    return sigma11 * Math.exp(-(h-11000)/6341.6)
  }
}

// TAS / Mach helpers
function tasFromIas(ias_kts: number, alt_ft: number): number {
  return ias_kts / Math.sqrt(Math.max(sigma(alt_ft), 0.05))
}

// Synthesised per-airframe AOA state
function synthesiseAoaState(f: MFlight, sp: ClassSpec, phase: Phase) {
  const u1 = dhash(f.icao, 11)
  const u2 = dhash(f.icao, 22)
  const u3 = dhash(f.icao, 33)
  const u4 = dhash(f.icao, 44)
  const u5 = dhash(f.icao, 55)

  // Approximate Vapp at MLW / current gross (proxy: typical Vapp adjusted for phase)
  let vapp = sp.vapTyp
  if (phase === 'CRZ') vapp = sp.vapTyp + 60
  else if (phase === 'CLIMB' || phase === 'TMA') vapp = sp.vapTyp + 25
  else if (phase === 'TKO-LIFT') vapp = sp.vapTyp - 5
  else if (phase === 'GA') vapp = sp.vapTyp + 12

  // V/Vapp ratio: 1.0 = on schedule, <1.0 = low+slow, >1.2 = fast
  const vRatio = Math.max(f.velocityKts, 60) / vapp

  // Base AoA (Klein/Roskam approximation): α ≈ α0 + (1/V²)·k - n_z·dα/dn
  // We use a simplified mapping: at Vapp on speed → α = 8°
  // each 10% V deficit adds ~5° AOA (1/V² scaling)
  // load factor (bank/pull) adds AOA in steeper turns
  const baseAlpha = 8.0 * Math.pow(1.0 / Math.max(vRatio, 0.5), 1.6)

  // Random load-factor / config deviation
  // 88% nominal, 8% mild deviation (+3°), 3% high AOA (+6-10°), 1% extreme (+12-18° → into protection band)
  let aoaDelta = 0
  if (u1 < 0.88) aoaDelta = u2 * 1.5
  else if (u1 < 0.96) aoaDelta = 3 + u2 * 3
  else if (u1 < 0.99) aoaDelta = 6 + u2 * 4
  else aoaDelta = 12 + u2 * 6

  // Bank-angle proxy (steep turn raises AOA): random 0-65° bank in TMA
  let bankDelta = 0
  if (phase === 'TMA' || phase === 'APPR-FNL') {
    const bank = u3 * 45
    if (bank > 30) bankDelta = (Math.pow(1/Math.cos(bank * Math.PI/180), 1) - 1) * 4
  }

  // Phase modulator: low-energy approach more likely to be near AOA
  let phaseAlphaMul = 1.0
  if (phase === 'APPR-FNL') phaseAlphaMul = 1.15
  if (phase === 'GA') phaseAlphaMul = 1.10
  if (phase === 'TKO-LIFT') phaseAlphaMul = 1.05

  const alpha = (baseAlpha + aoaDelta + bankDelta) * phaseAlphaMul

  // Law state: 4% Alt-1, 2% Alt-2, 0.5% Direct for FBW types
  let lawNow: Law = sp.defaultLaw
  if (sp.defaultLaw === 'NORMAL') {
    if (u4 < 0.005) lawNow = 'DIRECT'
    else if (u4 < 0.02) lawNow = 'ALT-2'
    else if (u4 < 0.06) lawNow = 'ALT-1'
  }

  // n_z load factor proxy
  const nz = 1.0 + (u5 - 0.5) * 0.4

  return { alpha, vapp, vRatio, lawNow, aoaDelta, bankDelta, nz }
}

interface AlphaResult {
  alphaNow: number; vapp: number; vRatio: number; lawNow: Law
  aProtActive: boolean; aFloorActive: boolean; aMaxActive: boolean
  marginToProt: number; marginToFloor: number
}

function computeAlpha(f: MFlight, sp: ClassSpec, st: ReturnType<typeof synthesiseAoaState>): AlphaResult {
  // In Alt-Law / Conv / None, alpha-prot is NOT available
  const protectionsAvailable = (st.lawNow === 'NORMAL' && sp.aProt < 99)
  const aProtActive = protectionsAvailable && st.alpha >= sp.aProt - 0.5
  const aFloorActive = protectionsAvailable && sp.hasAFlrAThr && st.alpha >= sp.aFloor - 0.3
  const aMaxActive = protectionsAvailable && st.alpha >= sp.aMax - 0.3
  return {
    alphaNow: st.alpha,
    vapp: st.vapp,
    vRatio: st.vRatio,
    lawNow: st.lawNow,
    aProtActive, aFloorActive, aMaxActive,
    marginToProt: sp.aProt - st.alpha,
    marginToFloor: sp.aFloor - st.alpha
  }
}

export default function AlphaFloor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'ENVELOPE'|'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase|'ALL'>('ALL')
  const [search, setSearch] = useState('')

  // sliders
  const [advMul, setAdvMul] = useState(1.0)
  const [appMul, setAppMul] = useState(1.0)
  const [aoaOffset, setAoaOffset] = useState(0)
  const [lawMul, setLawMul] = useState(1.0)

  // overlay layer toggles
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(false)
  const [shVec, setShVec] = useState(true)

  // === per-airframe rows
  const rows = useMemo(() => {
    type Row = {
      f: MFlight; phase: Phase; cls: string; spec: ClassSpec
      alpha: number; vapp: number; vRatio: number; lawNow: Law
      aProtActive: boolean; aFloorActive: boolean; aMaxActive: boolean
      marginToProt: number; marginToFloor: number
      drivers: Record<string, number>; score: number; tier: Tier; notes: string[]
    }
    const out: Row[] = []
    for (const f of flights) {
      const ph = classifyPhase(f)
      if (ph === 'OFF') continue
      const sp = specOf(f.type)
      const st = synthesiseAoaState(f, sp, ph)
      st.alpha += aoaOffset
      const ar = computeAlpha(f, sp, st)

      // === drivers (0-100)
      // ALPHA: 1.0 at α=α_FLOOR, 0 at α≤α_PROT-3°
      const alphaSpan = Math.max(sp.aFloor - (sp.aProt - 3), 1)
      const dALPHA = clamp(((ar.alphaNow - (sp.aProt - 3)) / alphaSpan) * 100, 0, 100)
      // IAS: 0 at V/Vapp≥1.10, 100 at V/Vapp≤0.85
      const dIAS = clamp((1.10 - ar.vRatio) / 0.25 * 100, 0, 100)
      // AFLR active binary
      const dAFLR = ar.aFloorActive ? 100 : 0
      // APROT armed binary (lighter weight)
      const dAPROT = ar.aProtActive ? 80 : 0
      // PHASE weight encoded into composite below; record raw indicator
      const dPHASE_W: Record<Phase, number> = {
        'TKO-LIFT':80,'CLIMB':50,'CRZ':30,'TMA':45,'APPR-FNL':75,'GA':70,'OFF':0
      }
      const dPHASE = dPHASE_W[ph]
      // LAW: 0 Normal, 40 Alt-1, 70 Alt-2, 90 Direct, 20 Conv (some shaker only), 5 None
      let dLAW = 0
      if (ar.lawNow === 'NORMAL') dLAW = 0
      else if (ar.lawNow === 'ALT-1') dLAW = 40
      else if (ar.lawNow === 'ALT-2') dLAW = 70
      else if (ar.lawNow === 'DIRECT') dLAW = 90
      else if (ar.lawNow === 'CONV') dLAW = 20
      else dLAW = 5
      dLAW *= lawMul
      // ENERGY proxy: low+slow at low altitude
      const isLow = f.altitudeFt < 5000
      const isSlow = ar.vRatio < 1.0
      const dENERGY = (isLow && isSlow) ? clamp((1.0 - ar.vRatio) * 200, 0, 100) :
                      (isLow && ar.vRatio < 1.10) ? 25 : 0

      const drivers = { ALPHA: dALPHA, IAS: dIAS, AFLR: dAFLR, APROT: dAPROT,
                        PHASE: dPHASE, LAW: dLAW, ENERGY: dENERGY }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length

      const phaseW: Record<Phase, number> = {
        'TKO-LIFT':1.40,'CLIMB':1.00,'CRZ':0.60,'TMA':1.00,'APPR-FNL':1.50,'GA':1.30,'OFF':0
      }
      // Apply user app-mul on top of approach-phase
      const phaseEff = (ph === 'APPR-FNL' || ph === 'GA' || ph === 'TKO-LIFT')
                       ? phaseW[ph] * appMul : phaseW[ph]
      let score = (mx * 0.66 + mn * 0.34) * phaseEff * advMul

      const notes: string[] = []
      // hard escalators
      if (ar.aFloorActive && (ph === 'APPR-FNL' || ph === 'GA' || ph === 'TKO-LIFT')) {
        score = Math.max(score, 92)
        notes.push(`α=${ar.alphaNow.toFixed(1)}° ≥ α_FLOOR ${sp.aFloor.toFixed(1)}° on ${ph} — A/THR commanding TOGA per FCOM DSC-22 §1 / FCTM PRO-NOR-SOP-21 · ${sp.cls} alpha-floor wakeup IN PROGRESS, pilot inputs cannot prevent TOGA thrust; override via MAN TLs to MAX then back to TOGA detent`)
      } else if (ar.aFloorActive) {
        score = Math.max(score, 84)
        notes.push(`α=${ar.alphaNow.toFixed(1)}° ≥ α_FLOOR — A/THR TOGA active outside critical phase; verify A/THR ON FMA + pull SS forward to reduce AOA before resuming managed climb`)
      } else if (ar.aProtActive && (ph === 'APPR-FNL' || ph === 'GA')) {
        score = Math.max(score, 76)
        notes.push(`α=${ar.alphaNow.toFixed(1)}° in α_PROT band [${sp.aProt.toFixed(1)}-${sp.aFloor.toFixed(1)}°] · SS-fwd-neutralised, autotrim FROZEN, V_PROT bracket on PFD speed scale · reduce SS pull, increase IAS to V_LS+5 per FCTM PRO-NOR-SOP-21`)
      } else if (ar.aProtActive) {
        score = Math.max(score, 58)
        notes.push(`α_PROT armed at α=${ar.alphaNow.toFixed(1)}° — SS forward to clear band; protections engaged, A/P disconnected per DSC-22`)
      } else if (ar.lawNow === 'ALT-2' || ar.lawNow === 'DIRECT') {
        score = Math.max(score, 65)
        notes.push(`LAW=${ar.lawNow} — alpha-protections LOST; revert to conventional stall-warning thresholds + airmanship · monitor speed-tape · BEA AF447 precedent (A330 in ALT-2 stalled at α=42° with no protection)`)
      } else if (ar.vRatio < 0.92 && (ph === 'APPR-FNL' || ph === 'GA')) {
        score = Math.max(score, 55)
        notes.push(`V/Vapp=${ar.vRatio.toFixed(2)} (${(ar.vRatio*100).toFixed(0)}%) low on energy at ${ph} · NTSB AAR-14-01 Asiana 214 SFO precedent (A/THR FLCH HOLD, no alpha-floor wakeup on B777) · advance thrust + reduce AOA`)
      } else if (sp.cls === 'BO-737-MCAS' && ar.alphaNow > 12) {
        score = Math.max(score, 40)
        notes.push(`α=${ar.alphaNow.toFixed(1)}° on B737MAX — MCAS may command nose-DOWN trim (not alpha-protect); verify STAB-TRIM CUTOUT switches per AD 2020-24-02 if uncommanded ND trim activates`)
      } else if (ar.marginToProt < 2 && sp.aProt < 99) {
        score = Math.max(score, 35)
        notes.push(`α=${ar.alphaNow.toFixed(1)}° within ${ar.marginToProt.toFixed(1)}° of α_PROT ${sp.aProt.toFixed(1)}° · reduce AOA · increase speed to V_LS + 10`)
      } else if (sp.cls === 'BO-CONV' && ar.vRatio < 1.0 && ph === 'APPR-FNL') {
        score = Math.max(score, 28)
        notes.push(`Conventional FCS (${sp.cls}) low on speed V/Vapp=${ar.vRatio.toFixed(2)} · no alpha-protection · monitor airspeed-trend, stick-shaker at α_S~${sp.aStall.toFixed(1)}° · Turkish 1951 EHAM precedent (B737-800, no alpha-protect)`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (sp.defaultLaw === 'NONE') tier = 'OFF'
      else if (score >= 85) tier = 'ALPHA-FLOOR'
      else if (score >= 65) tier = 'ALPHA-PROT'
      else if (score >= 45) tier = 'ALPHA-WATCH'
      else if (score >= 22) tier = 'ALPHA-MARG'
      else tier = 'NOMINAL'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp,
        alpha: ar.alphaNow, vapp: ar.vapp, vRatio: ar.vRatio, lawNow: ar.lawNow,
        aProtActive: ar.aProtActive, aFloorActive: ar.aFloorActive, aMaxActive: ar.aMaxActive,
        marginToProt: ar.marginToProt, marginToFloor: ar.marginToFloor,
        drivers, score, tier, notes
      })
    }
    out.sort((a,b) => (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, appMul, aoaOffset, lawMul])

  // === MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'afl-src'
    const SRC_VEC = 'afl-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_VEC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (classFilter==='ALL'||r.cls===classFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter)
      )
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        const labelParts: string[] = []
        labelParts.push(r.f.callsign||r.f.icao)
        labelParts.push(r.cls.split('-')[0])
        labelParts.push(`α${r.alpha.toFixed(1)}°`)
        labelParts.push(`V/Vap${r.vRatio.toFixed(2)}`)
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 6 + (r.score/100)*13,
            label: labelParts.join(' · ')
          }
        })
        // AOA-trend vector: forward along track length proportional to AOA-margin deficit
        if (r.tier === 'ALPHA-FLOOR' || r.tier === 'ALPHA-PROT' || r.tier === 'ALPHA-WATCH') {
          const km = clamp(2 + (r.score/100) * 12, 1, 14)
          const brg = (r.f.track||0) * Math.PI/180
          const dlat = (km/111.32) * Math.cos(brg)
          const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
          // Add a small perpendicular jitter if ALPHA-FLOOR (oscillation indicator)
          let coords: number[][] = [[r.f.lng, r.f.lat],[r.f.lng + dlng, r.f.lat + dlat]]
          if (r.tier === 'ALPHA-FLOOR') {
            const perpBrg = brg + Math.PI/2
            const jit = km * 0.18
            const jdlat = (jit/111.32) * Math.cos(perpBrg)
            const jdlng = (jit/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(perpBrg)
            coords = [
              [r.f.lng, r.f.lat],
              [r.f.lng + dlng*0.33 + jdlng, r.f.lat + dlat*0.33 + jdlat],
              [r.f.lng + dlng*0.66 - jdlng, r.f.lat + dlat*0.66 - jdlat],
              [r.f.lng + dlng, r.f.lat + dlat]
            ]
          }
          vecFeats.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates: coords },
            properties:{ color: TIER_COLOR[r.tier] }
          })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('afl-halo'))
      map.addLayer({ id:'afl-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.78 } })
    if (!map.getLayer('afl-pin'))
      map.addLayer({ id:'afl-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.4, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('afl-lbl'))
      map.addLayer({ id:'afl-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('afl-vec'))
      map.addLayer({ id:'afl-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[1.5, 2.5], 'line-opacity':0.78 } })
    writeAll()
    return () => {
      for (const id of ['afl-lbl','afl-pin','afl-halo','afl-vec']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, phaseFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (classFilter==='ALL'||r.cls===classFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'ALPHA-FLOOR':0,'ALPHA-PROT':0,'ALPHA-WATCH':0,'ALPHA-MARG':0,'NOMINAL':0,'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muAlpha = rows.length ? (rows.reduce((a,b)=>a+b.alpha,0)/rows.length) : 0
  const muVR = rows.length ? (rows.reduce((a,b)=>a+b.vRatio,0)/rows.length) : 0
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const aflrCnt = rows.filter(r => r.aFloorActive).length
  const aProtCnt = rows.filter(r => r.aProtActive && !r.aFloorActive).length
  const worst = rows[0]

  // per-class aggregation
  const classMap = new Map<string, { spec: ClassSpec; count: number; muAlpha: number; muVR: number; aflr: number; aprot: number; aMarg: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muAlpha: 0, muVR: 0, aflr: 0, aprot: 0, aMarg: 0 }
    e.count++; e.muAlpha += r.alpha; e.muVR += r.vRatio
    if (r.aFloorActive) e.aflr++
    if (r.aProtActive && !r.aFloorActive) e.aprot++
    if (r.tier === 'ALPHA-MARG') e.aMarg++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count,
    muAlpha: e.muAlpha/e.count, muVR: e.muVR/e.count,
    aflr: e.aflr, aprot: e.aprot, aMarg: e.aMarg
  })).sort((a,b) => (b.aflr+b.aprot) - (a.aflr+a.aprot) || b.muAlpha - a.muAlpha)

  // picked class for envelope diagram (worst's class, or default)
  const pickedSpec = worst ? worst.spec : SPECS[1]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">ALPHA-FLOOR</span>
          <span className="text-[10px] text-slate-400">High-AoA Protection Law &amp; A/THR Wakeup · CS-25.143/207</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t === 'ALPHA-FLOOR' ? 'FLOOR' : t === 'ALPHA-PROT' ? 'PROT' : t === 'ALPHA-WATCH' ? 'WATCH' : t === 'ALPHA-MARG' ? 'MARG' : t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-α</div><div className="font-mono" style={{color: muAlpha>12 ? TIER_COLOR['ALPHA-WATCH'] : '#cbd5e1'}}>{muAlpha.toFixed(1)}°</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-V/Vap</div><div className="font-mono" style={{color: muVR<1.0 ? TIER_COLOR['ALPHA-WATCH'] : TIER_COLOR.NOMINAL}}>{muVR.toFixed(2)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">AFLR</div><div className="font-mono" style={{color: aflrCnt>0 ? TIER_COLOR['ALPHA-FLOOR'] : TIER_COLOR.NOMINAL}}>{aflrCnt}<span className="text-slate-500">/{aProtCnt}p</span></div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">APP-MUL <span className="text-slate-200 font-mono">{(appMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={appMul*100} onChange={e=>setAppMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">AOA-OFFSET <span className="text-slate-200 font-mono">{aoaOffset.toFixed(1)}°</span>
            <input type="range" min="-3" max="6" step="0.1" value={aoaOffset} onChange={e=>setAoaOffset(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">LAW-MUL <span className="text-slate-200 font-mono">{(lawMul*100).toFixed(0)}%</span>
            <input type="range" min="0" max="200" value={lawMul*100} onChange={e=>setLawMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL</button>
          {SPECS.map(s => (
            <button key={s.cls} onClick={()=>setClassFilter(s.cls)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===s.cls?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.cls}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-LIFT','CLIMB','CRZ','TMA','APPR-FNL','GA'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','ENVELOPE','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: r.lawNow==='NORMAL' ? '#10b98133' : r.lawNow==='ALT-1' ? '#f59e0b33' : r.lawNow==='ALT-2' ? '#f43f5e33' : r.lawNow==='DIRECT' ? '#ef444433' : '#47556933', color: r.lawNow==='NORMAL' ? '#10b981' : r.lawNow==='ALT-1' ? '#f59e0b' : r.lawNow==='ALT-2' ? '#f43f5e' : r.lawNow==='DIRECT' ? '#ef4444' : '#94a3b8' }}>{r.lawNow}</span>
              {r.aFloorActive && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#ef444433', color:'#ef4444' }}>A-FLR</span>}
              {!r.aFloorActive && r.aProtActive && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#f43f5e33', color:'#f43f5e' }}>A-PROT</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier.replace('ALPHA-','A-')} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>α <span className="font-mono" style={{color: r.alpha>r.spec.aFloor ? TIER_COLOR['ALPHA-FLOOR'] : r.alpha>r.spec.aProt ? TIER_COLOR['ALPHA-PROT'] : r.alpha>r.spec.aProt-2 ? TIER_COLOR['ALPHA-WATCH'] : '#cbd5e1'}}>{r.alpha.toFixed(1)}°</span></div>
              <div>V/Vap <span className="font-mono" style={{color: r.vRatio<0.95 ? TIER_COLOR['ALPHA-WATCH'] : '#cbd5e1'}}>{r.vRatio.toFixed(2)}</span></div>
              <div>Δα-PROT <span className="font-mono" style={{color: r.marginToProt<2 ? TIER_COLOR['ALPHA-WATCH'] : TIER_COLOR.NOMINAL}}>{r.spec.aProt < 99 ? `${r.marginToProt.toFixed(1)}°` : 'n/a'}</span></div>
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>α-PROT <span className="text-slate-100 font-mono">{r.spec.aProt < 99 ? `${r.spec.aProt.toFixed(1)}°` : '—'}</span></div>
              <div>α-FLOOR <span className="text-slate-100 font-mono">{r.spec.aFloor < 99 ? `${r.spec.aFloor.toFixed(1)}°` : '—'}</span></div>
              <div>α-MAX <span className="text-slate-100 font-mono">{r.spec.aMax < 99 ? `${r.spec.aMax.toFixed(1)}°` : '—'}</span></div>
              <div>α-S <span className="text-slate-100 font-mono">{r.spec.aStall.toFixed(1)}°</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && r.tier!=='OFF' && <div className="mt-1 text-[9px] text-slate-500">monitor α envelope · maintain V_LS+5 minimum on approach · verify Normal Law on PFD/FMA</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-[10px] text-slate-500 italic px-2 py-6 text-center">no airframes in scope — adjust filters or AOA-OFFSET slider to probe envelope</div>
        )}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-300 truncate text-[10px]">{c.spec.label}</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>α-PROT <span className="text-slate-100 font-mono">{c.spec.aProt < 99 ? `${c.spec.aProt.toFixed(1)}°` : '—'}</span></div>
                  <div>α-FLOOR <span className="text-slate-100 font-mono">{c.spec.aFloor < 99 ? `${c.spec.aFloor.toFixed(1)}°` : '—'}</span></div>
                  <div>α-MAX <span className="text-slate-100 font-mono">{c.spec.aMax < 99 ? `${c.spec.aMax.toFixed(1)}°` : '—'}</span></div>
                  <div>α-S <span className="text-slate-100 font-mono">{c.spec.aStall.toFixed(1)}°</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>A/THR wake <span className="font-mono" style={{color: c.spec.hasAFlrAThr ? TIER_COLOR.NOMINAL : '#94a3b8'}}>{c.spec.hasAFlrAThr ? 'YES' : 'no'}</span></div>
                  <div>μ-α <span className="font-mono" style={{color: c.muAlpha>12 ? TIER_COLOR['ALPHA-WATCH'] : '#cbd5e1'}}>{c.muAlpha.toFixed(1)}°</span></div>
                  <div>μ-V/Vap <span className="font-mono" style={{color: c.muVR<0.95 ? TIER_COLOR['ALPHA-WATCH'] : '#cbd5e1'}}>{c.muVR.toFixed(2)}</span></div>
                  <div>Vap-typ <span className="text-slate-100 font-mono">{c.spec.vapTyp}kt</span></div>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
                  <div>A-FLR <span className="font-mono" style={{color: c.aflr>0 ? TIER_COLOR['ALPHA-FLOOR'] : TIER_COLOR.NOMINAL}}>{c.aflr}</span></div>
                  <div>A-PROT <span className="font-mono" style={{color: c.aprot>0 ? TIER_COLOR['ALPHA-PROT'] : TIER_COLOR.NOMINAL}}>{c.aprot}</span></div>
                  <div>A-MARG <span className="font-mono" style={{color:TIER_COLOR['ALPHA-MARG']}}>{c.aMarg}</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 italic">{
                  c.cls === 'AB-FBW-NEW' || c.cls === 'AB-FBW-CLS'
                    ? 'FCOM DSC-22 §1 Normal Law / DSC-27 §3 A/THR / AMM 22-30-00 Alpha-Floor (TOGA wakeup)'
                    : c.cls === 'AB-FBW-ALT'
                      ? 'FCOM DSC-22 §2 Alt Law · protections LOST · stall warning at α_SW only (AF447 mode)'
                      : c.cls === 'BO-FBW-NEW' || c.cls === 'BO-FBW-CLS'
                        ? 'FCOM Vol 2 §03 · soft envelope + α-REF, no A/THR alpha-floor wakeup (Asiana 214 SFO precedent)'
                        : c.cls === 'BO-737-MCAS'
                          ? 'AD 2020-24-02 / NTSB DCA19RA017 JT610 / DCA19RA086 ET302 · MCAS commands ND not protect'
                          : c.cls === 'BO-CONV'
                            ? 'Cable + hydraulic FCS · stick-shaker at α_S-1° · stall warning + airmanship only (Turkish 1951)'
                            : c.cls === 'E-JET-FBW'
                              ? 'Embraer FOM ch.10 · AOA-band + thrust-protection but no autothrust wakeup'
                              : c.cls === 'RGN-CONV'
                                ? 'Conventional + stick-shaker (CRJ Colgan 3407 precedent shaker→pusher missed)'
                                : 'Light GA · pilot judgement only · no protection law'
                }</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope</div>}
          </div>
        )}

        {tab==='ENVELOPE' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">α-vs-V/Vapp envelope · picked class {pickedSpec.cls}</div>
              <div className="text-slate-400">Per Airbus FCOM DSC-22 §1 (A320/A330/A340/A350/A380 Normal Law) the high-AoA protection band brackets α_PROT (protection engagement), α_FLOOR (A/THR TOGA wakeup) and α_MAX (full aft side-stick limit, ~1-2° below α_S). The 1/V² scaling means that as the airframe slows below Vapp, α rises sharply toward the protection band — the law engages BEFORE stall. The Boeing FBW spec (B777/B787) uses α_REF + soft-envelope protection but does NOT command A/THR wakeup; the Asiana 214 NTSB AAR-14-01 finding called out this gap explicitly.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">α vs V/Vapp envelope</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="40" y1="190" x2="390" y2="190" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="190" stroke="#334155" />
                {/* V/Vapp axis 0.7..1.5 */}
                {[0.7,0.8,0.9,1.0,1.1,1.2,1.3,1.4,1.5].map(v => (
                  <g key={v}><line x1={40 + (v-0.7)/0.8*350} y1="188" x2={40 + (v-0.7)/0.8*350} y2="192" stroke="#475569"/>
                    <text x={40 + (v-0.7)/0.8*350} y={202} fill="#94a3b8" fontSize="9" textAnchor="middle">{v.toFixed(1)}</text></g>
                ))}
                {/* α axis 0..28° */}
                {[0,5,10,15,20,25].map(a => (
                  <g key={a}><line x1="38" y1={190 - a/28*170} x2="42" y2={190 - a/28*170} stroke="#475569"/>
                    <text x={34} y={193 - a/28*170} fill="#94a3b8" fontSize="9" textAnchor="end">{a}°</text></g>
                ))}
                <text x="215" y="214" fill="#94a3b8" fontSize="9" textAnchor="middle">V / Vapp</text>
                <text x="14" y="105" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 105)">α (deg)</text>

                {/* α_S stall (top) */}
                <line x1="40" y1={190 - pickedSpec.aStall/28*170} x2="390" y2={190 - pickedSpec.aStall/28*170} stroke="#94a3b8" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.7"/>
                <text x="390" y={190 - pickedSpec.aStall/28*170 - 2} fill="#94a3b8" fontSize="8" textAnchor="end">α_S = {pickedSpec.aStall.toFixed(1)}°</text>

                {/* α_MAX */}
                {pickedSpec.aMax < 99 && <g>
                  <line x1="40" y1={190 - pickedSpec.aMax/28*170} x2="390" y2={190 - pickedSpec.aMax/28*170} stroke="#ef4444" strokeWidth="1.2"/>
                  <text x="390" y={190 - pickedSpec.aMax/28*170 - 2} fill="#ef4444" fontSize="8" textAnchor="end">α_MAX = {pickedSpec.aMax.toFixed(1)}°</text>
                </g>}

                {/* α_FLOOR */}
                {pickedSpec.aFloor < 99 && <g>
                  <line x1="40" y1={190 - pickedSpec.aFloor/28*170} x2="390" y2={190 - pickedSpec.aFloor/28*170} stroke="#f43f5e" strokeWidth="0.9"/>
                  <text x="390" y={190 - pickedSpec.aFloor/28*170 - 2} fill="#f43f5e" fontSize="8" textAnchor="end">α_FLOOR = {pickedSpec.aFloor.toFixed(1)}° {pickedSpec.hasAFlrAThr ? '· A/THR wake' : ''}</text>
                </g>}

                {/* α_PROT */}
                {pickedSpec.aProt < 99 && <g>
                  <line x1="40" y1={190 - pickedSpec.aProt/28*170} x2="390" y2={190 - pickedSpec.aProt/28*170} stroke="#f59e0b" strokeWidth="0.9" strokeDasharray="3 2"/>
                  <text x="390" y={190 - pickedSpec.aProt/28*170 - 2} fill="#f59e0b" fontSize="8" textAnchor="end">α_PROT = {pickedSpec.aProt.toFixed(1)}°</text>
                </g>}

                {/* 1/V² curve for class — α(V/Vap) ≈ 8° / V/Vap^1.6 */}
                {(() => {
                  const path: string[] = []
                  for (let i = 0; i <= 80; i++) {
                    const v = 0.7 + (i/80) * 0.8
                    const a = 8.0 * Math.pow(1.0 / v, 1.6)
                    const x = 40 + (v-0.7)/0.8*350
                    const y = 190 - clamp(a, 0, 28)/28*170
                    path.push(`${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`)
                  }
                  return <path d={path.join(' ')} stroke="#0ea5e9" fill="none" strokeWidth="1.5" />
                })()}

                {/* fleet dots — current (V/Vapp, α) per airframe colored by tier */}
                {rows.slice(0,80).map((r,i) => {
                  const x = 40 + clamp((r.vRatio-0.7)/0.8, 0, 1)*350
                  const y = 190 - clamp(r.alpha, 0, 28)/28*170
                  return <circle key={i} cx={x} cy={y} r="2.6" fill={TIER_COLOR[r.tier]} opacity={0.82} stroke="#0b0f17" strokeWidth="0.5" />
                })}

                {/* legend */}
                <g transform="translate(50, 28)">
                  <line x1="0" y1="0" x2="10" y2="0" stroke="#0ea5e9" strokeWidth="1.5" />
                  <text x="14" y="3" fill="#cbd5e1" fontSize="9">α = 8/(V/Vap)^1.6 (1/V² scaling)</text>
                  <line x1="0" y1="11" x2="10" y2="11" stroke="#f59e0b" strokeWidth="0.9" strokeDasharray="3 2" />
                  <text x="14" y="14" fill="#cbd5e1" fontSize="9">α_PROT armed band</text>
                  <line x1="0" y1="22" x2="10" y2="22" stroke="#f43f5e" strokeWidth="0.9" />
                  <text x="14" y="25" fill="#cbd5e1" fontSize="9">α_FLOOR A/THR TOGA wakeup</text>
                </g>
              </svg>
              <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-α</div><div className="font-mono" style={{color: muAlpha>12 ? TIER_COLOR['ALPHA-WATCH'] : '#cbd5e1'}}>{muAlpha.toFixed(1)}°</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PEAK-α</div><div className="font-mono" style={{color: TIER_COLOR['ALPHA-FLOOR']}}>{rows.length ? Math.max(...rows.map(r=>r.alpha)).toFixed(1) : '0'}°</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{pickedSpec.cls}</div></div>
              </div>
            </div>

            {/* per-class α-PROT band comparison strip */}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">α protection bands across FBW classes (degrees)</div>
              <svg viewBox="0 0 400 160" className="w-full">
                <line x1="40" y1="140" x2="390" y2="140" stroke="#334155" />
                <line x1="40" y1="10" x2="40" y2="140" stroke="#334155" />
                {[0,5,10,15,20,25].map(a => (
                  <g key={a}><line x1={40 + a/25*350} y1="138" x2={40 + a/25*350} y2="142" stroke="#475569"/>
                    <text x={40 + a/25*350} y={152} fill="#94a3b8" fontSize="9" textAnchor="middle">{a}°</text></g>
                ))}
                {SPECS.map((s, i) => {
                  if (s.cls === 'AB-FBW-ALT' || s.cls === 'BO-CONV' || s.cls === 'BO-737-MCAS' || s.cls === 'RGN-CONV' || s.cls === 'GA-LIGHT') return null
                  const y = 15 + i*16
                  return <g key={s.cls}>
                    <text x="36" y={y+3} fill="#94a3b8" fontSize="9" textAnchor="end">{s.cls.replace('AB-','').replace('BO-','').replace('E-','')}</text>
                    {/* α_PROT to α_FLOOR rose-pink band */}
                    {s.aProt < 99 && <rect x={40 + s.aProt/25*350} y={y-3} width={(s.aFloor - s.aProt)/25*350} height="6" fill="#f43f5e" opacity="0.4" />}
                    {/* α_FLOOR to α_MAX rose band */}
                    {s.aFloor < 99 && <rect x={40 + s.aFloor/25*350} y={y-3} width={(s.aMax - s.aFloor)/25*350} height="6" fill="#ef4444" opacity="0.55" />}
                    {/* α_MAX to α_S slate band */}
                    {s.aMax < 99 && <rect x={40 + s.aMax/25*350} y={y-3} width={(s.aStall - s.aMax)/25*350} height="6" fill="#94a3b8" opacity="0.35" />}
                    {/* α_S stall tick */}
                    <line x1={40 + s.aStall/25*350} y1={y-5} x2={40 + s.aStall/25*350} y2={y+5} stroke="#cbd5e1" strokeWidth="1.2" />
                  </g>
                })}
                <text x="215" y="158" fill="#94a3b8" fontSize="9" textAnchor="middle">angle of attack α (deg)</text>
                <g transform="translate(220, 8)">
                  <rect x="0" y="0" width="8" height="6" fill="#f43f5e" opacity="0.4" />
                  <text x="11" y="5" fill="#cbd5e1" fontSize="8">α_PROT→α_FLOOR</text>
                  <rect x="0" y="9" width="8" height="6" fill="#ef4444" opacity="0.55" />
                  <text x="11" y="14" fill="#cbd5e1" fontSize="8">α_FLOOR→α_MAX (A/THR TOGA on Airbus)</text>
                </g>
              </svg>
            </div>
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Definition</div>
              <div className="text-slate-400">ALPHA-FLOOR is the certified HIGH-AOA ENVELOPE-PROTECTION subsystem state of each airframe — the law that engages when angle-of-attack approaches stall AOA, replacing pilot speed control with AOA control (Airbus Normal Law) or commanding autothrust to TOGA irrespective of pilot input (Airbus α_FLOOR wakeup per AMM 22-30-00). The three thresholds are α_PROT (protection arm, side-stick demands AOA), α_FLOOR (A/THR TOGA wakeup, Airbus only), α_MAX (maximum AOA achievable in Normal Law). Per CS-25.143(h) + AMC 25.207(c) FBW airframes may use the protection envelope to demonstrate stall-prevention compliance in lieu of conventional stall warning + identification.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Distinct from other monitors</div>
              <div className="text-slate-400">STALL is the 1g AOA-margin/buffet WARNING for every airframe including non-FBW; ALPHA-FLOOR is the FBW PROTECTION LAW state. FBW-REV is the LAW REVERSION (Normal→Alt-1→Alt-2→Direct) — when protections are lost, not when they are active. MCAS is the B737MAX pitch-augmentation subsystem commanding nose-DOWN at high AOA, the opposite of an alpha-floor wakeup. FMA is the cockpit MODE annunciator strip (what mode you're in) not the underlying law (what the FBW is doing to the controls). PIO is closed-loop handling-quality not high-AOA. TEM-ENERGY is energy management not AOA protection. COFFIN is the high-FL low-margin geometry, not the protection engagement.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Per-class protection thresholds</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· AB-FBW-NEW A350/A380/A220 — α_PROT 16.5° / α_FLOOR 17.5° / α_MAX 19.5° / α_S 21.5° · full alpha-protection enabled including A/THR wake</div>
                <div>· AB-FBW-CLS A320-fam/A330/A340 — α_PROT 17° / α_FLOOR 18° / α_MAX 21° / α_S 23° · α-FLOOR inhibited above 100ft AGL on stable approach</div>
                <div>· AB-FBW-ALT Alt-Law — protections LOST · stall warning only at α_SW ≈ α_PROT - 1°</div>
                <div>· BO-FBW-NEW B787/B777X — α_REF 14.5° + α_MIN-SPD chevrons, no A/THR wakeup</div>
                <div>· BO-FBW-CLS B777-classic — soft protection, stall-ID + ATCS but no autothrust wake</div>
                <div>· BO-CONV B737NG/MAX/B757/B767/B747-400 — stick-shaker only at α_S - 1°</div>
                <div>· B737MAX-MCAS — MCAS commands nose-DOWN at high AOA, NOT alpha-protect (AD 2020-24-02)</div>
                <div>· E-JET-FBW E190-E2/E195-E2 — Embraer FBW with α-band + thrust protection</div>
                <div>· RGN-CONV CRJ/E170/ATR/Q400 — conventional + shaker/pusher</div>
                <div>· GA-LIGHT light GA — pilot judgement only</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Hard-escalator score floors</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· α ≥ α_FLOOR on TKO-LIFT / APPR-FNL / GA → score ≥ 92 (A/THR TOGA active, pilot cannot prevent)</div>
                <div>· α ≥ α_FLOOR outside critical phase → ≥ 84</div>
                <div>· α in α_PROT band during APPR-FNL/GA → ≥ 76 (SS-fwd-neutralised, autotrim frozen)</div>
                <div>· α_PROT armed any phase → ≥ 58</div>
                <div>· LAW = ALT-2 or DIRECT → ≥ 65 (BEA AF447 mode, protections LOST)</div>
                <div>· V/Vapp &lt; 0.92 in APPR-FNL/GA → ≥ 55 (Asiana 214 SFO precedent — B777, no A/THR wake)</div>
                <div>· B737MAX α &gt; 12° → ≥ 40 (MCAS ND-trim watchout per AD 2020-24-02)</div>
                <div>· α within 2° of α_PROT (FBW class) → ≥ 35</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Precedent accident family</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· Air France 447 A330-203 F-GZCP Atlantic 2009-06-01 (BEA Final 2012) — pitot blockage → ALT-2 law (no alpha-prot) → stall at α=42° (well past α_S) → 228 fatal. Demonstrated catastrophic difference between Normal Law (would have prevented) and ALT-2 (no protection).</div>
                <div>· Asiana 214 B777-200ER HL7742 SFO 2013-07-06 (NTSB AAR-14-01) — A/THR FLCH HOLD mode, no Boeing alpha-floor wakeup, stalled below 3° GP. NTSB specifically called out the absence of A/THR auto-wake as contributing factor.</div>
                <div>· AirAsia 8501 QZ8501 A320-216 PK-AXC Java 2014-12-28 (KNKT 2015) — RTLU repetitive faults reset → ALT-2 law → loss of alpha-protection → upset and stall at FL370 → 162 fatal.</div>
                <div>· Aeroflot 1492 SU100-95B RA-89098 SVO 2019-05-05 — SSJ100 lightning strike → Direct Mode → hard-landing bounce → ground fire, 41 fatal. Non-FBW pitch authority.</div>
                <div>· Colgan 3407 Q400 N200WQ Buffalo 2009-02-12 (NTSB AAR-10-01) — conventional FCS, stick-shaker fired, captain pulled into pusher response. RGN-CONV class precedent.</div>
                <div>· Turkish 1951 B737-800 TC-JGE EHAM 2009-02-25 — radalt failure caused autothrottle retard, conventional B737 no alpha-protect, stall at low alt 9 fatal.</div>
                <div>· US Airways 1549 A320-214 N106US Hudson 2009-01-15 — Sullenberger pulled to α_MAX in Normal Law, airframe HELD α_MAX through ditching at α≈14°, demonstrated Normal Law working as designed; aircraft cannot stall in Normal Law.</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Mitigation pathway</div>
              <div className="text-slate-400">Per Airbus FCTM PRO-NOR-SOP-21 PROTECTIONS: if α_FLOOR active, A/THR is commanding TOGA — let it run, reduce SS pull to release alpha-prot, monitor V_LS and V_PROT bands on PFD. If law has reverted to ALT-2/DIRECT, the alpha-prot is LOST — fall back to conventional handling: maintain target speed, monitor speed-tape, do NOT exceed VLS by aggressive AOA control. For B777/B787 there is no A/THR alpha-floor wakeup; the crew must manually advance thrust if speed decays toward V_REF - 5kt (Asiana 214 lesson). For B737-MAX with high AOA, verify MCAS dual-AoA comparator agree per AD 2020-24-02; if MCAS commands ND-trim with no AoA disagree, use STAB-TRIM CUTOUT switches per FCOM SP.16.5. Conventional types (B737NG, ATR, CRJ): monitor stick-shaker, push to break the stall, then thrust to recover.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.143 (controllability), §25.143(h) (PIO + protection envelope), §25.171 (general stability), §25.173 (static longitudinal), §25.175 (longitudinal stability demo), §25.207 (stall warning), §25.255 (out-of-trim), §25.671 (control systems), §25.672 (stability augmentation) · EASA CS-25.143 / CS-25.207 / AMC 25.207(c) (protection envelope) / AMC 25.143(h) §3.5 PIO &amp; protection · FAA AC 25-7D §5.2.5 Flight Test Guide Stability &amp; Control / §5.3 Stall Characteristics &amp; Warning · Airbus A320 / A330 / A340 / A350 / A380 FCOM DSC-22 §1 Flight Controls Normal Law · FCOM DSC-22 §2 Alt Law &amp; Direct Law · FCOM DSC-27 §3 Auto Flight System Auto-Thrust · FCTM PRO-NOR-SOP-21 PROTECTIONS Alpha-Floor &amp; Alpha-Prot · AMM 22-30-00 Auto-Thrust Alpha-Floor · Briere &amp; Traverse AIAA-93-3811 A320 FBW Architecture · Favre AIAA-94-3492 FBW Certification A320 · Boeing B777 FCOM Vol 2 §03 Flight Controls / FCTM Ch.8 manual-flight · Hesse AIAA-95-3416 B777 FBW spec / NASA TM-2002 Boeing FBW envelope-protection · Boeing B787 FCOM Vol 2 §03 / SP.16 Pilot Manual Operation · Embraer E190-E2 / E195-E2 FOM ch.10 FBW · NTSB AAR-14-01 Asiana 214 SFO (A/THR FLCH HOLD / no Boeing alpha-floor wakeup) · NTSB AAR-10-01 Colgan 3407 Buffalo (stick-shaker→pusher response) · BEA F-GZCP Final Report (Air France 447 ALT-2 stall) · KNKT KNKT.14.12.29.04 (AirAsia 8501 PK-AXC ALT-2 stall) · Interstate Aviation Committee Aeroflot 1492 SU100-95B SVO 2019 · AAIB INT report Turkish 1951 EHAM (B737-800 no alpha-protect) · NTSB DCA19RA017 Lion Air JT610 (MCAS) / DCA19RA086 Ethiopian ET302 (MCAS) · AD 2020-24-02 B737-MAX MCAS revised · ICAO Doc 9760 Vol II Pt VI engine/airframe cert · ICAO Doc 8168 PANS-OPS Vol I Pt VI · USAF AFFTC-TLR-90-1 PIO &amp; HQ flight-test · MIL-STD-1797B App.A handling qualities · ESDU 71008 stability derivatives · Etkin Dynamics of Atmospheric Flight 3e Ch.5 · Cook Flight Dynamics Principles Ch.6 · Stevens &amp; Lewis Aircraft Control &amp; Simulation 2e §3 / §4 longitudinal dynamics.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
