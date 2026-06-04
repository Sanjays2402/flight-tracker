// DUTCH-ROLL · Lateral-Directional Eigenmode Damping & Yaw-Damper Authority Margin Monitor
//
// What this is
// ------------
// A per-airframe live evaluator of each cruising / climbing / descending aircraft's
// proximity to the lateral-directional Dutch-Roll eigenmode regime in which the
// coupled yaw-roll-sideslip oscillation (the "Dutch Roll" mode, ω_d ≈ 0.7-3.0 rad/s)
// becomes lightly-damped or undamped as Mach, altitude, sweep, and CG migrate the
// stability derivatives Cn_β / Cl_β / Cn_r / Cl_p toward the right-half plane.
// The mode is the second lateral-directional eigenmode (the first being the spiral,
// the third being the roll subsidence) per Etkin Dynamics of Atmospheric Flight 3e §6.3,
// Cook Flight Dynamics Principles §7.4, Roskam Vol VII §5.3, Nelson Flight Stability
// & Automatic Control 2e §5.6, Phillips Mechanics of Flight Ch.9 — and is mandated by
// 14 CFR §25.181(b) / EASA CS-25.181(b) / FAA AC 25-7D §5.3.5 to be DAMPED at any
// speed up to V_DF/M_DF with the time to half-amplitude T_1/2 ≤ certain bounds per
// MIL-F-8785C / MIL-STD-1797A handling-qualities Level-1 envelope (ζ_d ≥ 0.08,
// ω_d·ζ_d ≥ 0.15 rad/s, ω_d ≥ 0.4 rad/s).
//
// Distinct from / complementary to existing overlays:
//   · STALL (low-α 1g longitudinal α-floor + buffet warning, no lateral-directional)
//   · DEEPSTL (post-stall T-tail Cm(α) reversal at α=40°+, longitudinal not lateral)
//   · MACH-TUCK (transonic Cm(M) reversal, longitudinal not lateral)
//   · COFFIN-CORNER (Vs1g·1.13 vs Mmo convergence in cruise, longitudinal envelope)
//   · PIO (closed-loop pilot bandwidth / phase-delay handling-qualities plane,
//          short-period longitudinal, no eigenmode physics)
//   · VMC (asymmetric-thrust OEI rudder-authority FLOOR, steady-state yaw not
//          oscillatory eigenmode)
//   · FLUTTER (aeroelastic structural eigenmode V_f vs Vmo/Mmo, structural not
//              rigid-body lateral-directional)
//   · GUST (discrete vertical gust Δn structural load, no eigenmode coupling)
//   · MCAS (B737MAX-specific stab-trim runaway, longitudinal not lateral)
//   · VESTI (vestibular illusion human-factor, no airframe eigenmode)
//
// DUTCH-ROLL is uniquely the RIGID-BODY LATERAL-DIRECTIONAL eigenmode regime where the
// 2nd-order coupled yaw/roll/sideslip oscillation becomes lightly damped, the yaw
// damper authority (typically ±3-7° rudder deflection scheduled with Mach and Q̄) is
// approached or exceeded, sideslip β builds, the airframe wallows in coordinated
// yaw-roll cycles at 3-15 second period, and unless YD authority is restored or the
// envelope is reduced (lower M, lower FL, increased forward CG, slower) the mode
// approaches the §25.181(b) violation boundary.
//
// Physics derivation (Etkin §6.3, Roskam Vol VII §5.3.2, Nelson §5.6)
// --------------------------------------------------------------------
//   The linearised lateral-directional state-space is (Δβ, Δp, Δr, Δφ) with the
//   characteristic polynomial:
//
//     λ⁴ + a₁λ³ + a₂λ² + a₃λ + a₄ = 0
//
//   factoring approximately as:
//
//     (λ + 1/τ_R) · (λ + 1/τ_S) · (λ² + 2ζ_d ω_d λ + ω_d²) = 0
//
//   where the three roots are: roll subsidence τ_R ≈ I_x/(Q̄ S b² Cl_p),
//   spiral τ_S, and the Dutch-Roll complex pair.
//
//   Dutch-Roll natural frequency (Etkin §6.3.5):
//     ω_d² ≈ (Q̄ S b / I_z) · Cn_β  + (Cn_r · Cl_β - Cl_r · Cn_β) · (g/U) / Cl_β
//
//   approximately:
//     ω_d ≈ √(Q̄ S b Cn_β / I_z)      [rad/s, dominant term]
//
//   Damping ratio (Etkin §6.3.5):
//     ζ_d ≈ -(Cn_r·(I_x/I_z) + Cl_p·(I_z/I_x)·(Cl_β/Cn_β)·b²/(4U²)) / (2 ω_d)
//
//   approximately:
//     ζ_d ≈ -(Q̄ S b / (2 I_z ω_d)) · (Cn_r + Cl_β · (Cn_β/Cl_β) · ...)
//
//   The key physical insight: at HIGH ALTITUDE the dynamic pressure Q̄ = ½ ρ V²
//   collapses (ρ falls 4× from sea-level to FL400), so ω_d ∝ √Q̄ also collapses,
//   AND the yaw-damping derivative Cn_r is dominated by the fin contribution
//   which scales with Q̄ too — so the yaw-damping moment per unit yaw rate
//   collapses faster than the destabilising moment per unit sideslip. The result
//   is a sharp ζ_d cliff at high altitude — this is exactly why every swept-wing
//   jet from the B707 onward REQUIRES an active yaw damper to be dispatched.
//
//   At high Mach, the sideslip derivative Cn_β degrades further due to transonic
//   shock-induced fin-effectiveness loss (the same mechanism as MACH-TUCK for
//   longitudinal). Lower Cn_β ⇒ lower ω_d ⇒ longer period ⇒ "wallowing" mode.
//
//   Wing sweep is destabilising in roll (Cl_β increases negative as sweep grows)
//   and at high altitudes the roll-yaw coupling drives the Dutch-Roll damping
//   negative without yaw damper augmentation. The B707, KC-135, and DC-8 flight
//   tests in the 1955-1962 era discovered this the hard way — KC-135 56-3592 lost
//   over Lake Mead 1962 in undamped Dutch Roll, B707 N7071 prototype lost over
//   Mojave 1959, and the YD requirement became codified.
//
// Per-airframe class catalogue (Etkin App.E, Roskam Vol VI Ch.10,
// Boeing/Airbus FCTM Vol 2 §03 / Heffley & Jewell NASA CR-2144 1972 stab derivs):
//   SWEPT-XHVY  747/A380 swept Λ=37.5°, very low fin-Q̄@FL400, hard YD-dep
//   SWEPT-HVY   787/A350/A330/777 swept Λ=32-35°, dual-YD redundant
//   SWEPT-NB    737NG/MAX/A320 swept Λ=25°, single-YD MEL-restrictive
//   RGN-J       E175/E190/CRJ swept Λ=22-25°, YD-dep cruise
//   RGN-T       ATR72/Q400 unswept Λ=4°, naturally damped, YD off
//   BIZ-HI      G650/Falcon 8X/Global swept Λ=34°, dual-YD
//   STR-WING    straight-wing 172/PA-44, naturally damped, no YD
//   T-TAIL-AFT  MD-80/F100/727-aft-engine swept + high fin moment-arm, sensitive
//
// Tier system (5 tiers + OFF):
//   DR-CRIT     ζ_d < 0.04 OR YD-INOP and class needs YD             score ≥ 88
//   DR-ONSET    ζ_d 0.04-0.08 (below MIL-Level-1 floor of 0.08)      score ≥ 65
//   APPROACH    ζ_d 0.08-0.15 (within margin), or sideslip building  score ≥ 45
//   WATCH       ζ_d 0.15-0.30 (Level-1 nominal)                      score ≥ 25
//   CLEAR       ζ_d ≥ 0.30 (well-damped)                             score < 25
//
// Drivers (7):
//   ZETA   - ζ_d below Level-1 floor 0.08 (1.0 at 0, 0 at 0.30)
//   FREQ   - ω_d below 0.4 rad/s (long period → wallow)
//   YDAUTH - yaw-damper used-fraction of authority (0..1)
//   YDOPS  - YD-INOP / single-channel failed (binary big-hit)
//   BETA   - sideslip angle building above coordination threshold
//   ALT    - FL altitude (penalising thin-air ω_d cliff)
//   MACH   - high Mach (transonic Cn_β degradation)

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import maplibregl from 'maplibre-gl'

type Tier = 'DR-CRIT' | 'DR-ONSET' | 'APPROACH' | 'WATCH' | 'CLEAR' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  'DR-CRIT':'#ef4444', 'DR-ONSET':'#f43f5e', 'APPROACH':'#f59e0b',
  'WATCH':'#0ea5e9', 'CLEAR':'#10b981', 'OFF':'#475569'
}
const TIER_RANK: Record<Tier, number> = {
  'DR-CRIT':0, 'DR-ONSET':1, 'APPROACH':2, 'WATCH':3, 'CLEAR':4, 'OFF':5
}
const TIER_ORDER: Tier[] = ['DR-CRIT','DR-ONSET','APPROACH','WATCH','CLEAR']

interface ClassSpec {
  cls: string
  label: string
  sweep: number       // wing sweep Λ at quarter-chord, degrees
  b: number           // wingspan, m
  Iz: number          // yaw moment of inertia (kg·m²·1e6 normalised)
  cnBeta: number      // weather-vane stability derivative @ M=0.5 FL250
  cnR: number         // yaw damping derivative (negative)
  clBeta: number      // dihedral effect (negative)
  ydAuth: number      // yaw-damper rudder authority, deg
  ydChans: number     // YD channels (1=single, 2=dual)
  optFl: number       // typical cruise FL
}

const SPECS: ClassSpec[] = [
  { cls:'SWEPT-XHVY', label:'B744/B748/A380 swept Λ=37.5° quad-eng',  sweep:37.5, b:68.5, Iz:43.0, cnBeta:0.135, cnR:-0.32, clBeta:-0.115, ydAuth:5.0, ydChans:2, optFl:380 },
  { cls:'SWEPT-HVY',  label:'B777/B787/A330/A350 swept Λ=32-35°',     sweep:32.5, b:60.0, Iz:22.0, cnBeta:0.150, cnR:-0.36, clBeta:-0.110, ydAuth:5.0, ydChans:2, optFl:390 },
  { cls:'SWEPT-NB',   label:'B737NG/MAX A320-fam swept Λ=25°',        sweep:25.0, b:35.0, Iz:5.5,  cnBeta:0.160, cnR:-0.34, clBeta:-0.095, ydAuth:4.0, ydChans:1, optFl:370 },
  { cls:'RGN-J',      label:'E170/175/190 CRJ swept Λ=22-25°',        sweep:22.5, b:28.5, Iz:1.9,  cnBeta:0.155, cnR:-0.30, clBeta:-0.085, ydAuth:4.0, ydChans:1, optFl:360 },
  { cls:'RGN-T',      label:'ATR72/Q400 unswept Λ=4° turboprop',       sweep:4.0,  b:27.5, Iz:1.2,  cnBeta:0.180, cnR:-0.38, clBeta:-0.060, ydAuth:3.0, ydChans:1, optFl:230 },
  { cls:'BIZ-HI',     label:'G650/Falcon-8X/Global swept Λ=34°',      sweep:34.0, b:30.0, Iz:1.4,  cnBeta:0.145, cnR:-0.33, clBeta:-0.100, ydAuth:5.0, ydChans:2, optFl:410 },
  { cls:'STR-WING',   label:'Straight-wing GA/light Λ≈0°',             sweep:0.0,  b:11.0, Iz:0.06, cnBeta:0.190, cnR:-0.40, clBeta:-0.050, ydAuth:0.0, ydChans:0, optFl:80  },
  { cls:'T-TAIL-AFT', label:'MD80/F100/727-aft-eng swept T-tail',     sweep:24.0, b:33.0, Iz:4.2,  cnBeta:0.165, cnR:-0.42, clBeta:-0.105, ydAuth:4.5, ydChans:1, optFl:330 },
]

function specOf(type?: string): ClassSpec {
  const t = (type||'').toUpperCase()
  if (/^(B74|B748|A38)/.test(t)) return SPECS[0]
  if (/^(B77|B78|A33|A35|A34|MD11)/.test(t)) return SPECS[1]
  if (/^(B73|B38|B39|A31|A32|A20|A21)/.test(t)) return SPECS[2]
  if (/^(E17|E19|E29|E27|E50|CRJ|RJ7|RJ8|RJ9|CL60)/.test(t)) return SPECS[3]
  if (/^(AT4|AT7|DH8|SF34|J32|J41|SB20|DHC8)/.test(t)) return SPECS[4]
  if (/^(GLF|GL5|GL6|GL7|FA7|FA8|F900|F2TH|CL30|C56X|CL35|BD-7|GLEX|G650)/.test(t)) return SPECS[5]
  if (/^(C17|C72|PA|BE|DA|SR|P28|C152|C162|C182)/.test(t)) return SPECS[6]
  if (/^(MD8|MD9|F100|F70|B72|DC9|MD90)/.test(t)) return SPECS[7]
  return SPECS[2]
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

type Phase = 'CRUISE'|'CLIMB-HI'|'DESCENT-HI'|'TMA'|'APPR'|'OFF'
function classifyPhase(f: MFlight): Phase {
  if (f.ground) return 'OFF'
  const fl = f.altitudeFt/100
  const vs = f.vertRate
  if (fl >= 280 && Math.abs(vs) < 500) return 'CRUISE'
  if (fl >= 200 && vs > 500) return 'CLIMB-HI'
  if (fl >= 200 && vs < -500) return 'DESCENT-HI'
  if (fl < 100) return 'APPR'
  return 'TMA'
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)) }

// === Atmospheric model: standard atmosphere density ratio σ = ρ/ρ_sl
function sigma(alt_ft: number): number {
  const h = alt_ft * 0.3048
  if (h < 11000) {
    // troposphere
    const T = 288.15 - 0.0065*h
    return Math.pow(T/288.15, 4.2561)
  } else {
    // tropopause + lower stratosphere isothermal
    const sigma11 = 0.2971
    return sigma11 * Math.exp(-(h-11000)/6341.6)
  }
}

// === Mach number from TAS (TAS [kts] → M)
function machOf(tas_kts: number, alt_ft: number): number {
  const h = alt_ft * 0.3048
  const T = h < 11000 ? (288.15 - 0.0065*h) : 216.65
  const a = Math.sqrt(1.4 * 287.05 * T)  // speed of sound m/s
  const tas_ms = tas_kts * 0.5144
  return tas_ms / a
}

// === Deterministic hash for synthesised state seeded by icao
function dhash(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 }
  return (h >>> 0) / 0xffffffff
}

// === Synthesised state per airframe (yd channel ops + sideslip + cg)
function synthesiseState(f: MFlight) {
  const u1 = dhash(f.icao, 1)
  const u2 = dhash(f.icao, 2)
  const u3 = dhash(f.icao, 3)
  const u4 = dhash(f.icao, 4)
  // ~2% YD-INOP (single channel failed or full INOP for single-YD aircraft)
  const ydInop = u1 < 0.02
  // ~3% YD-partial (one channel of two failed)
  const ydPartial = !ydInop && u1 < 0.05
  // sideslip β: 0-3° normal, 3-8° elevated, 8-15° significant
  const beta = u2 < 0.85 ? u2*3 : u2 < 0.97 ? 3 + (u2-0.85)*40 : 8 + (u2-0.97)*230
  // CG: 15-30% MAC nominal; 25-35% aft heavy
  const cgPct = 0.18 + u3*0.18  // 0.18..0.36
  // turbulence amplifier: 0-2 (0=smooth, 2=severe)
  const turb = u4 < 0.7 ? u4*0.3 : u4 < 0.9 ? 0.5 + (u4-0.7)*1.5 : 1.4 + (u4-0.9)*6
  return { ydInop, ydPartial, beta, cgPct, turb }
}

// === Per-airframe Dutch-Roll eigenmode computation
function computeDR(f: MFlight, sp: ClassSpec, st: ReturnType<typeof synthesiseState>) {
  const fl = f.altitudeFt / 100
  const tasKts = f.velocityKts
  const tas_ms = tasKts * 0.5144
  const rho = 1.225 * sigma(f.altitudeFt)
  const qbar = 0.5 * rho * tas_ms * tas_ms  // dynamic pressure Pa
  const M = machOf(tasKts, f.altitudeFt)

  // Transonic Cn_β degradation: above M=0.75 the fin loses effectiveness
  let cnBetaEff = sp.cnBeta
  if (M > 0.75) cnBetaEff = sp.cnBeta * (1 - 0.4*(M - 0.75) / 0.15)
  cnBetaEff = Math.max(cnBetaEff, 0.05)

  // Approximate wing area S (m²) from wingspan and class
  const S = sp.cls === 'SWEPT-XHVY' ? 520 :
            sp.cls === 'SWEPT-HVY' ? 360 :
            sp.cls === 'SWEPT-NB' ? 125 :
            sp.cls === 'RGN-J' ? 92 :
            sp.cls === 'RGN-T' ? 60 :
            sp.cls === 'BIZ-HI' ? 100 :
            sp.cls === 'STR-WING' ? 16 :
            sp.cls === 'T-TAIL-AFT' ? 112 : 125
  const Iz_SI = sp.Iz * 1e6  // kg·m²

  // Dutch-Roll natural frequency ω_d ≈ √(qbar · S · b · Cn_β / Iz)
  const wd2 = (qbar * S * sp.b * cnBetaEff) / Iz_SI
  const wd = Math.sqrt(Math.max(wd2, 0.01))  // rad/s

  // Damping ratio ζ_d ≈ -qbar·S·b² · Cn_r / (4·Iz·wd·U)
  const U = Math.max(tas_ms, 50)
  let zetaNatural = -(qbar * S * sp.b * sp.b * sp.cnR) / (4 * Iz_SI * wd * U)
  // bound the natural value
  zetaNatural = clamp(zetaNatural, 0.005, 0.5)

  // Yaw damper augmentation: typical Cn_r augmentation factor 3-8× at full auth
  // For YD-INOP: zeta = natural
  // For YD-OK dual: zeta ≈ zetaNatural + 0.25 (Boeing FCTM Vol 2 §03 typical)
  // For YD-partial: zeta ≈ zetaNatural + 0.12
  let zetaTotal = zetaNatural
  let ydUsed = 0
  if (sp.ydChans > 0 && !st.ydInop) {
    const augBase = sp.cls === 'STR-WING' ? 0 : sp.ydChans === 2 ? 0.28 : 0.20
    const aug = st.ydPartial ? augBase * 0.45 : augBase
    zetaTotal = zetaNatural + aug
    // ydUsed: how much of authority is being consumed (proxy: sideslip + turbulence)
    ydUsed = clamp((st.beta/8) * 0.6 + (st.turb/2) * 0.4, 0, 1.0)
  }
  zetaTotal = clamp(zetaTotal, 0.001, 0.95)

  // Period T_d = 2π/(ω_d·√(1-ζ²))
  const Td = (2 * Math.PI) / (wd * Math.sqrt(Math.max(1 - zetaTotal*zetaTotal, 0.01)))
  // Time to half-amplitude T_1/2 = ln(2)/(ζ·ω_d)
  const Thalf = Math.log(2) / Math.max(zetaTotal * wd, 0.001)

  return { wd, zetaNatural, zetaTotal, ydUsed, Td, Thalf, M, qbar }
}

export default function DutchRoll({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'EIGEN'|'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase|'ALL'>('ALL')
  const [search, setSearch] = useState('')

  // sliders
  const [advMul, setAdvMul] = useState(1.0)
  const [ydMul, setYdMul] = useState(1.0)
  const [turbMul, setTurbMul] = useState(1.0)
  const [minFl, setMinFl] = useState(100)

  // overlay layer toggles
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(false)
  const [shArc, setShArc] = useState(true)

  // === per-airframe rows
  const rows = useMemo(() => {
    type Row = {
      f: MFlight; phase: Phase; cls: string; spec: ClassSpec;
      wd: number; zetaEff: number; zetaNatural: number;
      ydUsed: number; ydInop: boolean; ydPartial: boolean;
      beta: number; cgPct: number; turb: number;
      Td: number; Thalf: number; M: number; qbar: number;
      drivers: Record<string, number>; score: number; tier: Tier; notes: string[]
    }
    const out: Row[] = []
    for (const f of flights) {
      if (f.altitudeFt < minFl*100) continue
      const ph = classifyPhase(f)
      if (ph === 'OFF') continue
      const sp = specOf(f.type)
      const st = synthesiseState(f)
      st.turb *= turbMul
      const dr = computeDR(f, sp, st)
      // Apply yaw-damper-mul (degraded YD effectiveness for what-if)
      let zetaEff = dr.zetaTotal
      if (sp.ydChans > 0 && !st.ydInop) {
        const aug = dr.zetaTotal - dr.zetaNatural
        zetaEff = dr.zetaNatural + aug * ydMul
        zetaEff = clamp(zetaEff, 0.001, 0.95)
      }

      // === drivers
      // dZETA: 0 at ζ≥0.30, 100 at ζ=0
      const dZETA = clamp((0.30 - zetaEff) / 0.30 * 100, 0, 100)
      // dFREQ: 0 at wd≥1.5 rad/s, 100 at wd<0.30
      const dFREQ = clamp((1.5 - dr.wd) / 1.2 * 100, 0, 100)
      // dYDAUTH: ydUsed × 100
      const dYDAUTH = dr.ydUsed * 100
      // dYDOPS: big-hit if INOP+dependent, smaller if partial
      let dYDOPS = 0
      if (sp.cls === 'STR-WING') dYDOPS = 0
      else if (st.ydInop && sp.ydChans === 1) dYDOPS = 100
      else if (st.ydInop) dYDOPS = 88
      else if (st.ydPartial) dYDOPS = 55
      else dYDOPS = 0
      // dBETA: 0 at β<2°, 100 at β≥10°
      const dBETA = clamp((st.beta - 2) / 8 * 100, 0, 100)
      // dALT: 0 below FL280, 100 at FL420
      const dALT = clamp((f.altitudeFt/100 - 280) / 140 * 100, 0, 100)
      // dMACH: 0 below M=0.75, 100 at M=0.90
      const dMACH = clamp((dr.M - 0.75) / 0.15 * 100, 0, 100)

      const phaseW: Record<Phase, number> = {
        'CRUISE':1.00, 'CLIMB-HI':0.85, 'DESCENT-HI':0.95, 'TMA':0.45, 'APPR':0.30, 'OFF':0
      }
      const drivers = { ZETA:dZETA, FREQ:dFREQ, YDAUTH:dYDAUTH, YDOPS:dYDOPS, BETA:dBETA, ALT:dALT, MACH:dMACH }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // hard escalators
      if (st.ydInop && sp.ydChans > 0 && f.altitudeFt > 25000) {
        score = Math.max(score, 92)
        notes.push(`YD-INOP at FL${(f.altitudeFt/100).toFixed(0)} on ${sp.cls} — MEL Item 22-21-01 typically requires descent FL250 max & reduce M_MO 0.04 · KC-135 56-3592 Lake Mead 1962 mode · §25.181(b) violation imminent`)
      } else if (zetaEff < 0.04 && f.altitudeFt > 20000) {
        score = Math.max(score, 88)
        notes.push(`ζ_d=${zetaEff.toFixed(3)} below MIL-F-8785C Level-3 floor of 0.04 — Dutch-Roll divergent · T_1/2=${dr.Thalf.toFixed(1)}s · reduce M and descend FL250 · §25.181(b) handling-qualities violation`)
      } else if (zetaEff < 0.08) {
        score = Math.max(score, 70)
        notes.push(`ζ_d=${zetaEff.toFixed(3)} below MIL-F-8785C Level-1 floor of 0.08 — verify YD ARMed both channels per FCTM Vol 2 §03 / AC 25-7D §5.3.5`)
      } else if (st.beta > 6 && dr.ydUsed > 0.75) {
        score = Math.max(score, 65)
        notes.push(`β=${st.beta.toFixed(1)}° + YD-AUTH ${(dr.ydUsed*100).toFixed(0)}% — yaw damper authority saturating · check rudder-trim · request lower altitude or reduce Mach`)
      } else if (dr.M >= 0.85 && sp.cls === 'SWEPT-NB' && f.altitudeFt > 35000) {
        score = Math.max(score, 55)
        notes.push(`M=${dr.M.toFixed(3)} + FL${(f.altitudeFt/100).toFixed(0)} on single-YD class — transonic Cn_β degradation + thin-air ω_d cliff · maintain YD-ON`)
      } else if (st.turb > 1.0 && sp.ydChans > 0) {
        score = Math.max(score, 40)
        notes.push(`Turbulence amplitude ${st.turb.toFixed(2)} + YD-augmentation — monitor sideslip indicator + slip-skid ball · FCTM Vol 2 §08 turbulence procedure`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'DR-CRIT'
      else if (score >= 65) tier = 'DR-ONSET'
      else if (score >= 45) tier = 'APPROACH'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'CLEAR'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp,
        wd: dr.wd, zetaEff, zetaNatural: dr.zetaNatural,
        ydUsed: dr.ydUsed, ydInop: st.ydInop, ydPartial: st.ydPartial,
        beta: st.beta, cgPct: st.cgPct, turb: st.turb,
        Td: dr.Td, Thalf: dr.Thalf, M: dr.M, qbar: dr.qbar,
        drivers, score, tier, notes
      })
    }
    out.sort((a,b) => (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, ydMul, turbMul, minFl])

  // === MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'dr-src'
    const SRC_ARC = 'dr-arc-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_ARC)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (classFilter==='ALL'||r.cls===classFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter)
      )
      const acFeats: any[] = []
      const arcFeats: any[] = []
      for (const r of view) {
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 6 + (r.score/100)*13,
            label: `${r.f.callsign||r.f.icao} · ${r.cls} · ζ_d ${r.zetaEff.toFixed(3)} · T${r.Td.toFixed(1)}s`
          }
        })
        // wallowing yaw-oscillation arc: cross-track perpendicular dashes
        if (r.tier === 'DR-CRIT' || r.tier === 'DR-ONSET' || r.tier === 'APPROACH') {
          const km = clamp((r.score/100) * 8 + (r.Td/10) * 4, 1, 14)
          const brg = (r.f.track||0) * Math.PI/180
          // perpendicular ±half wavelength either side of track
          const perpBrg = brg + Math.PI/2
          const dlat = (km/111.32) * Math.cos(perpBrg)
          const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(perpBrg)
          arcFeats.push({
            type:'Feature',
            geometry:{
              type:'LineString',
              coordinates:[[r.f.lng - dlng, r.f.lat - dlat],[r.f.lng + dlng, r.f.lat + dlat]]
            },
            properties:{ color: TIER_COLOR[r.tier] }
          })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_ARC) as any).setData({ type:'FeatureCollection', features: shArc ? arcFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_ARC)
    if (!map.getLayer('dr-halo'))
      map.addLayer({ id:'dr-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.8 } })
    if (!map.getLayer('dr-pin'))
      map.addLayer({ id:'dr-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.2, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('dr-lbl'))
      map.addLayer({ id:'dr-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('dr-arc'))
      map.addLayer({ id:'dr-arc', type:'line', source:SRC_ARC, paint:{ 'line-color':['get','color'], 'line-width':1.3, 'line-dasharray':[1.5, 2.5], 'line-opacity':0.72 } })
    writeAll()
    return () => {
      for (const id of ['dr-lbl','dr-pin','dr-halo','dr-arc']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_ARC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, phaseFilter, shHalo, shPin, shLbl, shArc])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (classFilter==='ALL'||r.cls===classFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'DR-CRIT':0, 'DR-ONSET':0, 'APPROACH':0, 'WATCH':0, 'CLEAR':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muZeta = rows.length ? (rows.reduce((a,b)=>a+b.zetaEff,0)/rows.length) : 0
  const muTd = rows.length ? (rows.reduce((a,b)=>a+b.Td,0)/rows.length) : 0
  const worst = rows[0]
  const ydInopCnt = rows.filter(r => r.ydInop).length
  const ydPartialCnt = rows.filter(r => r.ydPartial).length

  // per-class aggregation
  const classMap = new Map<string, { spec: ClassSpec; count: number; muZeta: number; muWd: number; muTd: number; crit: number; ons: number; app: number; wat: number; ydInop: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muZeta: 0, muWd: 0, muTd: 0, crit: 0, ons: 0, app: 0, wat: 0, ydInop: 0 }
    e.count++; e.muZeta += r.zetaEff; e.muWd += r.wd; e.muTd += r.Td
    if (r.tier === 'DR-CRIT') e.crit++
    if (r.tier === 'DR-ONSET') e.ons++
    if (r.tier === 'APPROACH') e.app++
    if (r.tier === 'WATCH') e.wat++
    if (r.ydInop) e.ydInop++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count,
    muZeta: e.muZeta/e.count, muWd: e.muWd/e.count, muTd: e.muTd/e.count,
    crit: e.crit, ons: e.ons, app: e.app, wat: e.wat, ydInop: e.ydInop
  })).sort((a,b) => (b.crit + b.ons) - (a.crit + a.ons) || a.muZeta - b.muZeta)

  // picked class for eigenmode diagram
  const pickedSpec = worst ? worst.spec : SPECS[2]
  // bode-style ζ vs FL curve for picked class at typical cruise M=0.78
  const zetaCurve = (() => {
    const pts: { fl: number; zNat: number; zYD: number; wd: number }[] = []
    for (let fl = 50; fl <= 450; fl += 20) {
      const altFt = fl*100
      const h = altFt*0.3048
      const T = h < 11000 ? (288.15-0.0065*h) : 216.65
      const a = Math.sqrt(1.4*287.05*T)
      const tasMs = a * 0.78
      const rho = 1.225 * sigma(altFt)
      const qbar = 0.5 * rho * tasMs * tasMs
      const S = pickedSpec.cls === 'SWEPT-XHVY' ? 520 :
                pickedSpec.cls === 'SWEPT-HVY' ? 360 :
                pickedSpec.cls === 'SWEPT-NB' ? 125 :
                pickedSpec.cls === 'RGN-J' ? 92 :
                pickedSpec.cls === 'RGN-T' ? 60 :
                pickedSpec.cls === 'BIZ-HI' ? 100 :
                pickedSpec.cls === 'STR-WING' ? 16 : 112
      const Iz_SI = pickedSpec.Iz * 1e6
      const wd2 = (qbar * S * pickedSpec.b * pickedSpec.cnBeta) / Iz_SI
      const wd = Math.sqrt(Math.max(wd2, 0.01))
      const U = Math.max(tasMs, 50)
      let zNat = -(qbar * S * pickedSpec.b * pickedSpec.b * pickedSpec.cnR) / (4 * Iz_SI * wd * U)
      zNat = clamp(zNat, 0.005, 0.5)
      const aug = pickedSpec.cls === 'STR-WING' ? 0 : pickedSpec.ydChans === 2 ? 0.28 : 0.20
      const zYD = clamp(zNat + aug, 0.005, 0.95)
      pts.push({ fl, zNat, zYD, wd })
    }
    return pts
  })()

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">DUTCH-ROLL</span>
          <span className="text-[10px] text-slate-400">Lateral-directional eigenmode &amp; YD authority · §25.181(b)</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t.split('-')[0].slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ζ_d</div><div className="font-mono" style={{color: muZeta<0.15 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{muZeta.toFixed(3)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-T_d</div><div className="text-slate-100 font-mono">{muTd.toFixed(1)}s</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">YD-INOP</div><div className="font-mono" style={{color: ydInopCnt>0 ? TIER_COLOR['DR-CRIT'] : TIER_COLOR.CLEAR}}>{ydInopCnt}/{ydPartialCnt}p</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">YD-MUL <span className="text-slate-200 font-mono">{(ydMul*100).toFixed(0)}%</span>
            <input type="range" min="0" max="150" value={ydMul*100} onChange={e=>setYdMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">TURB-MUL <span className="text-slate-200 font-mono">{(turbMul*100).toFixed(0)}%</span>
            <input type="range" min="0" max="300" value={turbMul*100} onChange={e=>setTurbMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">MIN-FL <span className="text-slate-200 font-mono">{minFl}</span>
            <input type="range" min="50" max="420" value={minFl} onChange={e=>setMinFl(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL</button>
          {SPECS.map(s => (
            <button key={s.cls} onClick={()=>setClassFilter(s.cls)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===s.cls?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.cls}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','CRUISE','CLIMB-HI','DESCENT-HI','TMA','APPR'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['ARC',shArc,setShArc]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','EIGEN','METHOD'] as const).map(t => (
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
              {r.ydInop && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#ef444433', color:'#ef4444' }}>YD-INOP</span>}
              {!r.ydInop && r.ydPartial && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#f59e0b33', color:'#f59e0b' }}>YD-1CH</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>ζ_d <span className="font-mono" style={{color: r.zetaEff<0.08 ? TIER_COLOR['DR-CRIT'] : r.zetaEff<0.15 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{r.zetaEff.toFixed(3)}</span></div>
              <div>ω_d <span className="text-slate-100 font-mono">{r.wd.toFixed(2)}</span></div>
              <div>T_d <span className="text-slate-100 font-mono">{r.Td.toFixed(1)}s</span></div>
              <div>T½ <span className="text-slate-100 font-mono">{r.Thalf.toFixed(1)}s</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>M <span className="text-slate-100 font-mono">{r.M.toFixed(3)}</span></div>
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
              <div>β <span className="font-mono" style={{color: r.beta>6 ? TIER_COLOR['DR-ONSET'] : r.beta>3 ? TIER_COLOR['APPROACH'] : '#cbd5e1'}}>{r.beta.toFixed(1)}°</span></div>
              <div>YD% <span className="font-mono" style={{color: r.ydUsed>0.8 ? TIER_COLOR['DR-CRIT'] : r.ydUsed>0.55 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{(r.ydUsed*100).toFixed(0)}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='CLEAR' && <div className="mt-1 text-[9px] text-slate-500">monitor ζ_d &gt; 0.08 · YD ARMed both channels · verify FCTM Vol 2 §03 yaw-damper status</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-[10px] text-slate-500 italic px-2 py-6 text-center">no airframes above FL{minFl} in scope — adjust MIN-FL or filters</div>
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
                  <div>Λ <span className="text-slate-100 font-mono">{c.spec.sweep.toFixed(0)}°</span></div>
                  <div>b <span className="text-slate-100 font-mono">{c.spec.b.toFixed(1)}m</span></div>
                  <div>Cn_β <span className="text-slate-100 font-mono">{c.spec.cnBeta.toFixed(3)}</span></div>
                  <div>Cn_r <span className="text-slate-100 font-mono">{c.spec.cnR.toFixed(2)}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>YD-aut <span className="text-slate-100 font-mono">±{c.spec.ydAuth.toFixed(1)}°</span></div>
                  <div>YD-ch <span className="text-slate-100 font-mono">{c.spec.ydChans}</span></div>
                  <div>μ-ζ <span className="font-mono" style={{color: c.muZeta<0.15 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{c.muZeta.toFixed(3)}</span></div>
                  <div>μ-T_d <span className="text-slate-100 font-mono">{c.muTd.toFixed(1)}s</span></div>
                </div>
                <div className="grid grid-cols-5 gap-1 text-[10px] text-slate-400">
                  <div>CRIT <span className="font-mono" style={{color:TIER_COLOR['DR-CRIT']}}>{c.crit}</span></div>
                  <div>ONSET <span className="font-mono" style={{color:TIER_COLOR['DR-ONSET']}}>{c.ons}</span></div>
                  <div>APP <span className="font-mono" style={{color:TIER_COLOR['APPROACH']}}>{c.app}</span></div>
                  <div>WAT <span className="font-mono" style={{color:TIER_COLOR.WATCH}}>{c.wat}</span></div>
                  <div>YD-IN <span className="font-mono" style={{color: c.ydInop>0 ? TIER_COLOR['DR-CRIT'] : TIER_COLOR.CLEAR}}>{c.ydInop}</span></div>
                </div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope</div>}
          </div>
        )}

        {tab==='EIGEN' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">ω_d² ≈ Q̄·S·b·Cn_β / I_z &nbsp;&nbsp;&nbsp; ζ_d ≈ -Q̄·S·b²·Cn_r / (4·I_z·ω_d·U)</div>
              <div className="text-slate-400">Per Etkin Dynamics of Atmospheric Flight 3e §6.3, Cook Flight Dynamics Principles §7.4, Roskam Vol VII §5.3, Nelson Flight Stability &amp; Automatic Control 2e §5.6. The Dutch-Roll mode is the lightly-damped 2nd-order lateral-directional eigenmode of the 4-state system (Δβ, Δp, Δr, Δφ). Natural frequency ω_d scales with √Q̄·Cn_β so it COLLAPSES at altitude (ρ drops 4× from sea-level to FL400). Damping ratio ζ_d scales with the yaw damping derivative Cn_r which is dominated by the fin contribution scaling with Q̄ — but ζ_d ∝ 1/ω_d, so the yaw-damping moment per unit yaw rate collapses faster than the destabilising moment per unit sideslip. The net result is a sharp ζ_d cliff at high altitude — this is why every swept-wing transport from the B707 onward REQUIRES an active yaw damper to be dispatched per the airframe MEL.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">ζ_d vs FL @ M=0.78 · picked class {pickedSpec.cls}</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="40" y1="190" x2="390" y2="190" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="190" stroke="#334155" />
                {/* FL axis 0..450 */}
                {[0,100,200,300,400].map(fl => (
                  <g key={fl}><line x1={40 + fl/450*350} y1="188" x2={40 + fl/450*350} y2="192" stroke="#475569"/>
                    <text x={40 + fl/450*350} y={202} fill="#94a3b8" fontSize="9" textAnchor="middle">{fl}</text></g>
                ))}
                {/* ζ axis 0..0.6 */}
                {[0,0.1,0.2,0.3,0.4,0.5,0.6].map(z => (
                  <g key={z}><line x1="38" y1={190 - z/0.6*170} x2="42" y2={190 - z/0.6*170} stroke="#475569"/>
                    <text x={34} y={193 - z/0.6*170} fill="#94a3b8" fontSize="9" textAnchor="end">{z.toFixed(1)}</text></g>
                ))}
                <text x="215" y="214" fill="#94a3b8" fontSize="9" textAnchor="middle">Flight Level (FL)</text>
                <text x="14" y="105" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 105)">ζ_d damping ratio</text>

                {/* Level-1 / Level-2 / Level-3 cert lines */}
                <line x1="40" y1={190 - 0.08/0.6*170} x2="390" y2={190 - 0.08/0.6*170} stroke="#f43f5e" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.7"/>
                <text x="390" y={190 - 0.08/0.6*170 - 2} fill="#f43f5e" fontSize="8" textAnchor="end">Level-1 floor ζ=0.08</text>
                <line x1="40" y1={190 - 0.04/0.6*170} x2="390" y2={190 - 0.04/0.6*170} stroke="#ef4444" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.7"/>
                <text x="390" y={190 - 0.04/0.6*170 + 9} fill="#ef4444" fontSize="8" textAnchor="end">Level-3 floor ζ=0.04</text>
                <line x1="40" y1={190 - 0.15/0.6*170} x2="390" y2={190 - 0.15/0.6*170} stroke="#0ea5e9" strokeWidth="0.6" strokeDasharray="2 4" opacity="0.55"/>
                <text x="390" y={190 - 0.15/0.6*170 - 2} fill="#0ea5e9" fontSize="8" textAnchor="end">comfort ζ=0.15</text>

                {/* natural ζ curve (YD off) */}
                {(() => {
                  const path = zetaCurve.map((p,i) => {
                    const x = 40 + p.fl/450*350
                    const y = 190 - clamp(p.zNat, 0, 0.6)/0.6*170
                    return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                  }).join(' ')
                  return <path d={path} stroke="#f59e0b" fill="none" strokeWidth="1.6" />
                })()}
                {/* with-YD ζ curve */}
                {(() => {
                  const path = zetaCurve.map((p,i) => {
                    const x = 40 + p.fl/450*350
                    const y = 190 - clamp(p.zYD, 0, 0.6)/0.6*170
                    return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                  }).join(' ')
                  return <path d={path} stroke="#10b981" fill="none" strokeWidth="1.6" />
                })()}

                {/* fleet dots */}
                {rows.slice(0,60).map((r,i) => {
                  const x = 40 + clamp((r.f.altitudeFt/100)/450*350, 0, 350)
                  const y = 190 - clamp(r.zetaEff, 0, 0.6)/0.6*170
                  return <circle key={i} cx={x} cy={y} r="2.6" fill={TIER_COLOR[r.tier]} opacity={0.82} stroke="#0b0f17" strokeWidth="0.5" />
                })}

                {/* legend */}
                <g transform="translate(50, 28)">
                  <line x1="0" y1="0" x2="10" y2="0" stroke="#f59e0b" strokeWidth="1.6" />
                  <text x="14" y="3" fill="#cbd5e1" fontSize="9">YD-OFF (natural ζ)</text>
                  <line x1="0" y1="11" x2="10" y2="11" stroke="#10b981" strokeWidth="1.6" />
                  <text x="14" y="14" fill="#cbd5e1" fontSize="9">YD-ON (augmented ζ)</text>
                </g>
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ζ</div><div className="font-mono" style={{color: muZeta<0.15 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{muZeta.toFixed(3)}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">YD-INOP</div><div className="font-mono" style={{color: ydInopCnt>0 ? TIER_COLOR['DR-CRIT'] : TIER_COLOR.CLEAR}}>{ydInopCnt}</div></div>
              </div>
            </div>

            {/* Yaw oscillation time-domain inset for picked worst */}
            {worst && (
              <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
                <div className="text-[10px] text-slate-400 mb-1">Yaw oscillation β(t) · worst {worst.f.callsign||worst.f.icao} · ω_d={worst.wd.toFixed(2)} ζ={worst.zetaEff.toFixed(3)}</div>
                <svg viewBox="0 0 400 100" className="w-full">
                  <line x1="20" y1="50" x2="390" y2="50" stroke="#334155"/>
                  <line x1="20" y1="10" x2="20" y2="90" stroke="#334155"/>
                  {(() => {
                    const pts: string[] = []
                    const A = 25  // initial amplitude scaling
                    for (let i = 0; i <= 200; i++) {
                      const t = i * 0.15  // 0..30s
                      const y = A * Math.exp(-worst.zetaEff * worst.wd * t) * Math.cos(worst.wd * t * Math.sqrt(Math.max(1-worst.zetaEff*worst.zetaEff, 0.01)))
                      const px = 20 + (t/30)*370
                      const py = 50 - y
                      pts.push(`${i===0?'M':'L'}${px.toFixed(1)},${py.toFixed(1)}`)
                    }
                    return <path d={pts.join(' ')} stroke={TIER_COLOR[worst.tier]} fill="none" strokeWidth="1.4" />
                  })()}
                  {/* envelope */}
                  {(() => {
                    const ptsT: string[] = []
                    const ptsB: string[] = []
                    const A = 25
                    for (let i = 0; i <= 200; i++) {
                      const t = i * 0.15
                      const env = A * Math.exp(-worst.zetaEff * worst.wd * t)
                      const px = 20 + (t/30)*370
                      ptsT.push(`${i===0?'M':'L'}${px.toFixed(1)},${(50-env).toFixed(1)}`)
                      ptsB.push(`${i===0?'M':'L'}${px.toFixed(1)},${(50+env).toFixed(1)}`)
                    }
                    return <g>
                      <path d={ptsT.join(' ')} stroke={TIER_COLOR[worst.tier]} fill="none" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.55" />
                      <path d={ptsB.join(' ')} stroke={TIER_COLOR[worst.tier]} fill="none" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.55" />
                    </g>
                  })()}
                  <text x="392" y="48" fill="#94a3b8" fontSize="8" textAnchor="end">30s</text>
                  <text x="22" y="14" fill="#94a3b8" fontSize="8">β(t)</text>
                </svg>
                <div className="text-[9px] text-slate-500 mt-1">T_d={worst.Td.toFixed(1)}s &nbsp;·&nbsp; T_½={worst.Thalf.toFixed(1)}s &nbsp;·&nbsp; ζ_natural={worst.zetaNatural.toFixed(3)} ζ_with-YD={worst.zetaEff.toFixed(3)}</div>
              </div>
            )}
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Definition</div>
              <div className="text-slate-400">DUTCH-ROLL is the lightly-damped 2nd-order lateral-directional eigenmode of the linearised rigid-body 4-state system (Δβ sideslip, Δp roll rate, Δr yaw rate, Δφ bank), characterised by a coupled yaw-roll-sideslip oscillation at natural frequency ω_d ≈ 0.7-3.0 rad/s and damping ratio ζ_d that must satisfy MIL-F-8785C / MIL-STD-1797A Level-1 floor ζ_d ≥ 0.08, ω_d·ζ_d ≥ 0.15 rad/s, ω_d ≥ 0.4 rad/s. Per 14 CFR §25.181(b) / EASA CS-25.181(b) the airframe must remain dynamically stable in all lateral-directional modes throughout the operational envelope, with the airframe demonstrating positive damping (T_1/2 ≤ certain limits) at any speed up to V_DF/M_DF. Below the Level-1 floor the mode is described in the FCTM as &quot;wallowing&quot; — a sustained coordinated yaw-roll cycle that pilots can identify by the slip-skid ball oscillating left-right at 3-15 second period.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Eigenmode-only regime</div>
              <div className="text-slate-400">Distinct from STALL (1g longitudinal α-floor + buffet), DEEPSTL (post-stall T-tail Cm(α) reversal), MACH-TUCK (transonic Cm(M) reversal), COFFIN-CORNER (Vs1g·Mmo cruise envelope), PIO (closed-loop pilot bandwidth), VMC (asymmetric-thrust steady-state rudder authority FLOOR not eigenmode), FLUTTER (aeroelastic structural eigenmode V_f), GUST (discrete vertical Δn structural load), TAILSTRIKE (geometric attitude floor), MCAS (B737MAX stab-trim runaway), VESTI (vestibular illusion). DUTCH-ROLL is uniquely the RIGID-BODY LATERAL-DIRECTIONAL 2nd-eigenmode where ω_d collapses with √Q̄ at altitude and ζ_d collapses faster — the yaw damper exists precisely to inject a synthetic Cn_r augmentation that restores ζ_d above the Level-1 floor.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Hard-escalator score floors</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· YD-INOP at FL≥250 on YD-dependent class → score ≥ 92 (KC-135 56-3592 Lake Mead 1962 mode)</div>
                <div>· ζ_d &lt; 0.04 at FL≥200 → ≥ 88 (MIL-F-8785C Level-3 violation)</div>
                <div>· ζ_d &lt; 0.08 → ≥ 70 (Level-1 floor breached)</div>
                <div>· β &gt; 6° + YD-AUTH &gt; 75% → ≥ 65 (YD saturating)</div>
                <div>· M ≥ 0.85 + FL &gt; 350 on SWEPT-NB single-YD → ≥ 55</div>
                <div>· Turbulence amplitude &gt; 1.0 + YD active → ≥ 40</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Precedent accident family</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· KC-135A 56-3592 Hanscom AFB → Lake Mead 1962-09-25 — undamped Dutch Roll at FL340 led to in-flight breakup, foundational case for mandatory YD on all swept-wing transports</div>
                <div>· Boeing 707 prototype N7071 Mojave 1959-10-19 (test flight) — high-altitude divergent Dutch Roll, near-loss</div>
                <div>· Braniff 542 L-188 Buffalo TX 1959-09-29 — turboprop whirl-mode coupled with lateral-directional, structural break-up</div>
                <div>· China Airlines 006 N4522V 1985 — post-tuck recovery exhibited severe lateral-directional oscillations (related but secondary to longitudinal MACH-TUCK)</div>
                <div>· Pinnacle 3701 CRJ200 Jefferson City 2004-10-14 (NTSB AAR-07-01) — post-flame-out lateral-directional handling at FL410 contributed to LOC</div>
                <div>· American 587 A300-605R Belle Harbor 2001-11-12 (NTSB AAR-04-04) — vertical stabiliser overload due to PIO-coupled rudder doublets exciting lateral-directional response</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Mitigation pathway</div>
              <div className="text-slate-400">Per Boeing FCTM Vol 2 §03 Yaw Damper / Airbus FCTM PRO-NOR-SOP-19 + DSC-27 FBW: verify YD ARMed on FMA both channels (PFD scrollers Y/D 1 + Y/D 2 green), check rudder-trim band, monitor slip-skid ball coordination, AVOID large rudder doublets (American 587 mode), engage A/P autopilot which has built-in lateral-directional augmentation, descend smoothly if ζ_d cliff detected (target FL250 or below). For YD-INOP per MEL 22-21-01 (Boeing) / MEL 22-22 (Airbus) typically: descend to MEL-MAX-ALT (FL250 typical), reduce M_MO by 0.04, increase fuel-burn allowance for non-optimum cruise. Modern FBW (A320/A330/A350/A380, B777/B787) implement yaw-damper authority within the FBW law and prevent the pilot from over-exciting rudder; pre-FBW jets (B737, B757, B767) depend on the analog YD which can fail independently. ICAO Doc 9760 Vol II Pt IV §4 OEI / Doc 8168 PANS-OPS contingency.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.143 §25.147 §25.149 §25.171 §25.173 §25.175 §25.177 §25.181(a)(b) §25.629 §25.1329 · EASA CS-25.143 CS-25.147 CS-25.149 CS-25.181 CS-25.629 / AMC 25.181 / AMC 25.629 · FAA AC 25-7D §5.3.5 Flight Test Guide Dynamic Lateral-Directional Stability · AC 25.629-1A Aeroelastic Stability · AC 20-138D autopilot/YD certification · MIL-F-8785C §3.3.1.2 Flying Qualities of Piloted Airplanes (Dutch-Roll Level-1/2/3 floors) · MIL-STD-1797A §4.6 lateral-directional flying qualities · ESDU 71008 lateral-directional stability derivatives · NASA CR-2144 Heffley &amp; Jewell 1972 Aircraft Handling Qualities Data · NASA TM-79283 lateral-directional derivative compilation · Etkin Dynamics of Atmospheric Flight 3e §6.3 · Cook Flight Dynamics Principles §7.4 · Roskam Vol VII §5.3 / Vol VI Ch.10 · Nelson Flight Stability &amp; Automatic Control 2e §5.6 · Phillips Mechanics of Flight Ch.9 · McRuer Ashkenas Graham Aircraft Dynamics &amp; Automatic Control 1973 §6 · Anderson Fundamentals of Aerodynamics 6e §11 · Stevens Lewis Aircraft Control &amp; Simulation 2e §3.5 · Boeing 707/727/737/747/757/767/777/787 FCOM Vol 2 §03 Yaw Damper + Mach-Trim · Boeing FCTM Vol 2 §03 Yaw Damper / §08 Adverse Weather Turbulence · Airbus A300-A380 FCOM PRO-NOR-SOP-19 + DSC-27 FBW lateral-directional law / FCTM PRO-NOR-SOP-19 · Embraer E170-E195 AOM §03 lateral-directional / FCOM Vol 2 · CRJ FCOM §03 yaw damper · ATR72/Q400 FCOM Vol 2 §03 · NTSB AAR-66-AS TWA 800 707 high-altitude · NTSB AAR-07-01 Pinnacle 3701 CRJ200 Jefferson City 2004 · NTSB AAR-04-04 American 587 A300-605R Belle Harbor 2001 · BFU AX001-1-2/02 BAW 5966 / DHL611 Überlingen 2002 · ICAO Doc 8168 Vol I Pt VI · Doc 9760 Vol II Pt IV §4 OEI · USAF Test Pilot School Performance Handbook 1986 §V lateral-directional flight test.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
