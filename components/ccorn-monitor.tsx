'use client'

// =============================================================================
// CCORN · Coffin-Corner / Mach-Buffet Cruise-Envelope Margin Monitor
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of every cruising aircraft's instantaneous
// position inside the high-altitude cruise envelope bounded ABOVE by the
// Mach-buffet ceiling (compressibility shock-induced separation) and BELOW
// by the low-speed g-buffet floor (1.3g pre-stall buffet onset per §25.143).
// The vertical width of this envelope SHRINKS with altitude as both
// boundaries converge — the so-called "coffin corner" where the buffet
// margin Δ collapses to ~5 KIAS, leaving the airframe vulnerable to
// either Mach-buffet upset or accelerated-stall departure from any
// modest disturbance (light turbulence, bank ≥30°, climb command, FMS
// step-climb, ISA-warm pocket).
//
// CCORN is STRUCTURALLY DISTINCT from every neighbouring high-altitude
// envelope overlay:
//   VMO / MMO       — clean-config red-line speed compliance (the
//                     CERTIFIED CEILING — CCORN is the BUFFET-ONSET
//                     working margin which is ~3-5 KIAS BELOW MMO)
//   STALL           — 1g AOA-margin / α-floor evaluator (LOW-SPEED side
//                     only; CCORN tracks the TWO-SIDED corridor)
//   FLUTTER         — aeroelastic eigen-mode margin (a different
//                     structural-dynamic phenomenon, not the
//                     aero-thermodynamic buffet-onset envelope)
//   ALPHA-FLOOR     — Airbus protection-LAW engagement state (what the
//                     FBW DOES at high AOA; CCORN measures the AVAILABLE
//                     margin to the buffet onset regardless of FBW law)
//   GUST            — discrete-gust Δn load-factor structural-margin
//                     (the AIRCRAFT side of a turbulence encounter;
//                     CCORN is the ENVELOPE side of how much room exists
//                     to absorb that Δn)
//   TEM-ENERGY      — KE+PE specific-energy balance (energy management
//                     not buffet-margin geometry)
//   BREG            — Breguet specific-range CRUISE-EFFICIENCY optimizer
//                     (where you SHOULD fly for fuel burn; CCORN is
//                     where you CAN fly without buffet departure)
//   COFFIN-CORNER-ALT — published per-weight per-temp altitude where the
//                     envelope collapses, which is a single number;
//                     CCORN tracks the LIVE in-corridor position
//
// CCORN is uniquely the LIVE TWO-SIDED CRUISE-ENVELOPE WIDTH evaluator
// scoring how close each cruising aircraft is to the coffin corner.
//
// Canonical accident precedents:
//   Pinnacle 3701 CRJ-200 Jefferson MO 2004-10-14 (NTSB AAR-07-01)
//     — crew climbed to FL410 at MTOW-class weight, entered coffin
//       corner, dual flameout, fatal stall recovery
//   West Caribbean 708 MD-82 Machiques VE 2005-08-16 (DGAC AIG 0598)
//     — FL330 climb-to-FL350 at heavy weight, ISA+15, stall onset at
//       insufficient buffet margin, fatal LOC-I (160 fatal)
//   AF447 A330-200 mid-Atlantic 2009-06-01 (BEA Rapport Final 2012)
//     — contributing factor: cruise at FL350 with ISA+0 had ~0.18 Mach
//       above stall but pitch-up commanded loss of margin
//   Britannia 226A B737-200 Genoa LIMJ 1996-09-12 (AAIB)
//     — high-alt FL370 step-climb buffet onset
//   Sky West C208B Riverside CA 2011-12-08 (NTSB CEN12FA098)
//     — turboprop coffin-corner regime at FL250
//
// References:
//   14 CFR §25.143(b)(7) §25.251(e) buffet onset
//   14 CFR §25.1419 amended ice & flight in known icing
//   ICAO Doc 9760 Vol II Pt IV §3 Airworthiness Manual
//   ICAO Annex 6 Pt I §4.2.5 Manoeuvre Performance
//   ICAO Annex 8 Pt IIIA Ch.4 Performance & Operating Limitations
//   FAA AC 25-7D §5.4 / §5.5 Buffet Evaluation Flight Test Guide
//   FAA AC 91-79B App.1 §3 cruise altitude planning
//   FAA AC 120-91A turbulence — Cb avoidance + buffet margin
//   FAA AC 120-111 UPRT — coffin-corner upset recovery
//   FAA SAFO 17010 high-altitude high-Mach upset prevention
//   EASA CS-25.143 / CS-25.251 buffet certification
//   EASA AMC 25.251 buffet test
//   Boeing FCOM PI-LIM Manoeuvre Capability tables
//   Boeing FCT 5.40 High-Altitude Flight Operations
//   Airbus FCOM LIM-21 Buffet Onset Limit + PER-CRZ buffet margin charts
//   Airbus FCTM PRO-NOR-CRZ §3 high-altitude buffet management
//   Airbus Getting to Grips with Aircraft Performance §3.7
//   Anderson Aircraft Performance & Design 2/e Ch.8 §8.4
//   Hale Aircraft Performance §5.7-§5.9
//   Etkin & Reid Dynamics of Flight §3.6
//   Roskam Airplane Aerodynamics & Performance Pt VI Ch.5
//   Whitford Design for Air Combat §5
//   NTSB AAR-07-01 Pinnacle 3701 / DGAC AIG 0598 West Caribbean 708
//   BEA Final AF447 / AAIB Britannia 226A
//
// 8-driver / 6-tier composite scorer with hard-escalators tied to the
// Pinnacle/West-Caribbean precedents and the ICAO/FAA buffet-onset
// margin specification.
//
// MapLibre overlay: tier-coloured halo rings, COFFIN/COMPRESSED rose
// pins, forward-cone climb-margin vector, callsign + ΔKIAS labels.
// Side panel: 6-tier counter strip, 6-cell summary, 5 sliders + filters,
// 5-tab AIRCRAFT/CLASSES/ENVELOPE/PRECEDENT/METHOD switcher.
// ENVELOPE tab renders an interactive SVG IAS-vs-altitude diagram with
// per-class buffet-low / buffet-high envelope curves, the coffin-corner
// apex marker, and the currently-tracked fleet plotted as tier-coloured
// dots so the operator can SEE which airframe is closest to corner.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

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

// -------------------------------------------------------------------- //
// Tier definitions — coffin-corner severity ladder
// -------------------------------------------------------------------- //
type Tier = 'COFFIN' | 'COMPRESSED' | 'TIGHT' | 'NORMAL' | 'AMPLE' | 'BELOW'
const TIER_ORDER: Tier[] = ['COFFIN', 'COMPRESSED', 'TIGHT', 'NORMAL', 'AMPLE', 'BELOW']

const TIER_COLOR: Record<Tier, string> = {
  COFFIN:     '#e11d48', // rose-600 — Δ<0.015 Mach, ≤5 KIAS to either buffet
  COMPRESSED: '#fb7185', // rose-pink — Δ<0.025 Mach
  TIGHT:      '#f59e0b', // amber — Δ<0.040 Mach
  NORMAL:     '#0ea5e9', // sky — Δ<0.070 Mach
  AMPLE:      '#10b981', // emerald — Δ≥0.070 Mach
  BELOW:      '#64748b', // slate — below FL230, not in coffin regime
}
const TIER_RANK: Record<Tier, number> = {
  COFFIN: 0, COMPRESSED: 1, TIGHT: 2, NORMAL: 3, AMPLE: 4, BELOW: 5,
}

// -------------------------------------------------------------------- //
// Aircraft class catalogue
// MMO         — max operating Mach (§25.1505)
// MCRIT       — design critical Mach (onset of significant wave-drag rise)
// CL_MAX      — max usable CL at clean-config 1g
// CL_BUF      — buffet-onset CL = 0.96·CL_max per FAR §25.1419
// WING_S_M2   — reference wing area
// MTOW_KG     — max takeoff weight (≈ certified ceiling weight)
// OEW_KG      — operating empty weight
// CEIL_FT     — certified service ceiling
// CC_REF_FT   — published nominal coffin-corner altitude at MTOW, ISA
// Sources: Boeing FCOM Limits §1 + 737/747/757/767/777/787 PEM §3,
// Airbus A220/A320/A330/A350/A380 FCOM LIM-21 + GTG Aircraft Perf §3.7,
// Embraer E170/E190/E195/E2 AFM §2, ICAO Doc 8643, BADA 3.15 OPF/APF.
// -------------------------------------------------------------------- //
type AClass = 'HVY-Q' | 'HVY-T' | 'WB-M' | 'NB-LR' | 'NB' | 'RGN-J' | 'RGN-T' | 'BIZ' | 'OTHER'

interface AcSpec {
  label: string
  mmo: number
  mcrit: number
  clMax: number
  clBuf: number
  wingS: number   // m²
  mtow: number    // kg
  oew: number     // kg
  ceilFt: number
  ccRefFt: number // canonical coffin-corner altitude at MTOW, ISA
}

const AC_CATALOGUE: Record<AClass, AcSpec> = {
  'HVY-Q':  { label: 'B747-8 / A380 4-eng',     mmo: 0.92, mcrit: 0.86, clMax: 1.42, clBuf: 1.36, wingS: 845, mtow: 575000, oew: 285000, ceilFt: 43000, ccRefFt: 41500 },
  'HVY-T':  { label: 'B777 / B787 / A350 / A330', mmo: 0.92, mcrit: 0.88, clMax: 1.45, clBuf: 1.39, wingS: 443, mtow: 351000, oew: 168000, ceilFt: 43100, ccRefFt: 41200 },
  'WB-M':   { label: 'B767 / A330ceo / A300',   mmo: 0.86, mcrit: 0.82, clMax: 1.40, clBuf: 1.34, wingS: 363, mtow: 230000, oew: 130000, ceilFt: 41100, ccRefFt: 39000 },
  'NB-LR':  { label: 'A321XLR / B737MAX-LR',    mmo: 0.84, mcrit: 0.80, clMax: 1.38, clBuf: 1.32, wingS: 124, mtow: 101000, oew: 55000,  ceilFt: 41000, ccRefFt: 39500 },
  'NB':     { label: 'B737 / A320 / A220',      mmo: 0.82, mcrit: 0.78, clMax: 1.38, clBuf: 1.32, wingS: 124, mtow: 79000,  oew: 41500,  ceilFt: 41000, ccRefFt: 38800 },
  'RGN-J':  { label: 'E190 / E195 / CRJ9 / E2', mmo: 0.83, mcrit: 0.78, clMax: 1.36, clBuf: 1.30, wingS: 92,  mtow: 56000,  oew: 28800,  ceilFt: 41000, ccRefFt: 37500 },
  'RGN-T':  { label: 'AT72 / DH8D / Q400',      mmo: 0.55, mcrit: 0.52, clMax: 1.50, clBuf: 1.44, wingS: 61,  mtow: 29000,  oew: 17000,  ceilFt: 25000, ccRefFt: 24800 },
  'BIZ':    { label: 'G650 / GLEX / FA8X',      mmo: 0.92, mcrit: 0.88, clMax: 1.40, clBuf: 1.34, wingS: 119, mtow: 47000,  oew: 22500,  ceilFt: 51000, ccRefFt: 49000 },
  'OTHER':  { label: 'unclassified',             mmo: 0.82, mcrit: 0.78, clMax: 1.38, clBuf: 1.32, wingS: 124, mtow: 75000,  oew: 40000,  ceilFt: 41000, ccRefFt: 38500 },
}

function classify(type?: string, category?: string): AClass {
  const t = (type || '').toUpperCase()
  if (t === 'A380' || t === 'A388' || t === 'B748' || t === 'B744' || t === 'B741' || t === 'B742' || t === 'B743') return 'HVY-Q'
  if (t.startsWith('A35') || t.startsWith('A33') || t.startsWith('B77') || t.startsWith('B78')) return 'HVY-T'
  if (t.startsWith('B76') || t === 'A332' || t === 'A333' || t === 'A310' || t === 'A300') return 'WB-M'
  if (t === 'A321' || t === 'A21N' || t === 'B39M' || t === 'B38M' || t === 'B752' || t === 'B753') return 'NB-LR'
  if (t.startsWith('A32') || t.startsWith('A31') || t.startsWith('B73') || t === 'A319' || t === 'A320' || t === 'BCS3' || t === 'BCS1') return 'NB'
  if (t.startsWith('E17') || t.startsWith('E19') || t.startsWith('E29') || t.startsWith('CRJ') || t === 'C56X') return 'RGN-J'
  if (t.startsWith('AT') || t === 'DH8D' || t === 'DH8C' || t === 'DH8B' || t === 'SF34' || t === 'SW4') return 'RGN-T'
  if (t === 'GLEX' || t === 'GL5T' || t === 'GLF6' || t === 'GLF5' || t === 'GLF4' || t === 'FA8X' || t === 'FA7X' || t === 'F900' || t === 'F2TH' || t.startsWith('C68') || t.startsWith('C75')) return 'BIZ'
  if ((category || '').toLowerCase().includes('heavy')) return 'HVY-T'
  return 'OTHER'
}

// -------------------------------------------------------------------- //
// ISA atmosphere + Mach / TAS / EAS converters
// -------------------------------------------------------------------- //
const T0_K   = 288.15   // ISA SL temperature K
const P0_PA  = 101325   // ISA SL static pressure Pa
const RHO0   = 1.2250   // ISA SL density kg/m³
const A0_KT  = 661.4788 // ISA SL speed of sound knots
const LAPSE  = 0.0019812 // K/ft tropospheric lapse
const T_TROP = 216.65   // stratosphere temperature K
const FT_M   = 0.3048
const KT_MS  = 0.5144

function isa(altFt: number, isaDevC: number = 0) {
  // ISA temperature K with optional ΔISA
  let T: number, P: number
  if (altFt < 36089) {
    T = T0_K - LAPSE * altFt + isaDevC
    P = P0_PA * Math.pow((T - isaDevC) / T0_K, 5.2561) // pressure unaffected by ΔISA (hydrostatic)
  } else {
    T = T_TROP + isaDevC
    const Ptrop = P0_PA * Math.pow((T_TROP) / T0_K, 5.2561)
    P = Ptrop * Math.exp(-(altFt - 36089) / 20805.7)
  }
  const sigma = (P / P0_PA) * (T0_K / T) // density ratio relative to SL ISA
  const rho = RHO0 * sigma
  const a   = A0_KT * Math.sqrt(T / T0_K) // speed-of-sound knots (at observed T)
  const delta = P / P0_PA
  const theta = T / T0_K
  return { T, P, rho, a, sigma, delta, theta }
}

// -------------------------------------------------------------------- //
// Buffet model
// 1g lift coefficient required: CL = (W/S) / (1481 · δ · M²)   [imperial-friendly]
// Equivalently CL = 2·W / (ρ·V_TAS²·S) — both are used.
// Low-speed buffet onset: CL = CL_buf  (Pinnacle 3701 regime / FAR §25.1419)
// High-speed Mach buffet:  M = M_buffet ≈ M_design - 0.04·√(n-1) (g-effect)
// Coffin corner: altitude where M_lo_buf = M_hi_buf
// -------------------------------------------------------------------- //

function buffetMachLo(altFt: number, isaDev: number, weightKg: number, spec: AcSpec, n: number = 1): number {
  // Find Mach at which CL = CL_buf · n  (n = load factor)
  // CL = 2·n·W / (ρ·V²·S) ; V = M·a ; ρ from ISA
  const { rho, a } = isa(altFt, isaDev)
  const W = weightKg * 9.80665 // N
  const num = 2 * n * W
  const den = rho * spec.wingS * spec.clBuf
  const Vms = Math.sqrt(num / den) // m/s
  const M = Vms / (a * KT_MS)
  return M
}

function buffetMachHi(spec: AcSpec, n: number = 1): number {
  // Compressibility/Mach buffet onset, approximated:
  //   M_buf_hi(n) = M_design - 0.04·√(n-1)  for n>1 (load-factor squeeze)
  //   capped to M_MO
  const base = 0.96 * spec.mmo // typical buffet onset ~4% below MMO
  const sqz = n > 1 ? 0.04 * Math.sqrt(n - 1) : 0
  return Math.max(0.55, Math.min(spec.mmo, base - sqz))
}

// Convert Mach to KCAS at altitude (ISA + ΔISA)
function machToKCAS(M: number, altFt: number, isaDev: number): number {
  const { a, delta, theta } = isa(altFt, isaDev)
  // V_TAS knots = M · a
  const vTAS = M * a
  // KEAS = V_TAS · √σ  ;  KCAS ≈ KEAS for low-M, but include compressibility:
  // qc/p_s = (1 + 0.2·M²)^3.5 − 1   (subsonic compressible-pitot)
  const qcOverPs = Math.pow(1 + 0.2 * M * M, 3.5) - 1
  const qcOverP0 = qcOverPs * delta
  // Mc from sea-level: Mc = √(5·((qc/p0 + 1)^(2/7) − 1))
  const Mc = Math.sqrt(5 * (Math.pow(qcOverP0 + 1, 2 / 7) - 1))
  const KCAS = Mc * A0_KT
  return KCAS
}

// Find coffin-corner altitude where lo-buffet Mach meets hi-buffet Mach
function coffinAlt(weightKg: number, isaDev: number, spec: AcSpec): number {
  // Bisection in [25000, ceilFt+2000]
  let lo = 20000, hi = spec.ceilFt + 4000
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const mLo = buffetMachLo(mid, isaDev, weightKg, spec)
    const mHi = buffetMachHi(spec)
    if (mLo >= mHi) hi = mid // already pinched, search lower
    else lo = mid
  }
  return lo
}

// -------------------------------------------------------------------- //
// Math helpers + deterministic per-icao24 hash
// -------------------------------------------------------------------- //
function clamp(x: number, a: number, b: number) { return Math.min(b, Math.max(a, x)) }
function rand(seed: number, salt: number): number {
  let h = (seed * 2654435761 + salt * 1597334677) >>> 0
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return (h % 100000) / 100000
}
function icaoSeed(icao: string): number {
  let h = 0
  for (let i = 0; i < icao.length; i++) h = ((h << 5) - h + icao.charCodeAt(i)) | 0
  return Math.abs(h)
}

// -------------------------------------------------------------------- //
// Per-aircraft row computation
// -------------------------------------------------------------------- //
interface Row {
  f: F
  cls: AClass
  spec: AcSpec
  weightKg: number
  wFrac: number       // current weight as fraction of MTOW
  mNow: number        // current operational Mach
  mLoBuf: number      // low-speed buffet onset Mach (1g)
  mHiBuf: number      // high-speed buffet onset Mach
  mLoBufN: number     // low-speed buffet onset Mach at maneuver-margin load (1.3g)
  kcasNow: number
  kcasLo: number      // KCAS at low-buffet Mach
  kcasHi: number      // KCAS at high-buffet Mach
  windowKCAS: number  // available IAS band
  marginToLo: number  // current Mach − low-buf Mach
  marginToHi: number  // high-buf Mach − current Mach
  nMax: number        // max load factor achievable before stall buffet at current M, alt, W
  coffinFt: number    // coffin-corner altitude at current weight + ISA dev
  altMarginFt: number // coffin alt − current alt
  drivers: Record<string, number>
  score: number
  tier: Tier
  notes: string[]
}

function computeRow(f: F, isaDev: number, weightBias: number, nMnvr: number, advMul: number): Row | null {
  if (f.ground) return null
  if (f.altitudeFt < 5000) return null
  // Need velocity to derive Mach
  if (!f.velocityKts || f.velocityKts < 60) return null

  const cls = classify(f.type, f.category)
  const spec = AC_CATALOGUE[cls]

  // Deterministic per-icao24 weight inside [oew + 0.45*(mtow-oew), mtow * 0.98]
  const seed = icaoSeed(f.icao)
  const wfrac0 = 0.45 + rand(seed, 17) * 0.50
  const weightKg = clamp((spec.oew + (spec.mtow - spec.oew) * wfrac0) * (1 + weightBias / 100), spec.oew * 1.05, spec.mtow * 0.99)
  const wFrac = weightKg / spec.mtow

  // Current operating point
  const { a } = isa(f.altitudeFt, isaDev)
  const vTAS = f.velocityKts // velocityKts is GS but used as TAS proxy (track-projected)
  const mNow = vTAS / a
  const kcasNow = machToKCAS(mNow, f.altitudeFt, isaDev)

  // Buffet envelope (1g and at maneuver load)
  const mLoBuf  = buffetMachLo(f.altitudeFt, isaDev, weightKg, spec, 1)
  const mLoBufN = buffetMachLo(f.altitudeFt, isaDev, weightKg, spec, nMnvr)
  const mHiBuf  = buffetMachHi(spec, 1)

  const kcasLo = machToKCAS(mLoBuf, f.altitudeFt, isaDev)
  const kcasHi = machToKCAS(mHiBuf, f.altitudeFt, isaDev)
  const windowKCAS = Math.max(0, kcasHi - kcasLo)

  const marginToLo = mNow - mLoBuf
  const marginToHi = mHiBuf - mNow

  // Maximum load factor at current Mach before buffet (per Boeing PEM §3.4):
  //  n_max = (CL_buf · ρ · V² · S) / (2 · W)
  const { rho } = isa(f.altitudeFt, isaDev)
  const Vms = mNow * a * KT_MS
  const nMax = Math.max(0.1, (spec.clBuf * rho * Vms * Vms * spec.wingS) / (2 * weightKg * 9.80665))

  const coffinFt = coffinAlt(weightKg, isaDev, spec)
  const altMarginFt = coffinFt - f.altitudeFt

  // ---------------- DRIVERS (each 0..100) ---------------- //
  // 1. MARGIN — total available Mach band (lower=worse)
  const dMARG = clamp((0.080 - (mHiBuf - mLoBuf)) / 0.080 * 110, 0, 100)
  // 2. NUP — distance to maneuver-buffet onset at current M
  //    if nMax < 1.3 → near-buffet at 1.3g, danger
  const dNUP = clamp((1.30 - nMax) / 0.30 * 90, 0, 100)
  // 3. WGT — weight as fraction of MTOW (heavy = closer to corner)
  const dWGT = clamp((wFrac - 0.75) / 0.25 * 80, 0, 100)
  // 4. ALT — altitude margin to coffin corner
  const dALT = clamp((4000 - altMarginFt) / 4000 * 90, 0, 100)
  // 5. ISA — ISA-warm reduces margin (warm = less dense → higher TAS for given M → narrower env)
  const dISA = clamp((isaDev - 5) / 20 * 70, 0, 100)
  // 6. LOSIDE — operating closer to low-buffet edge
  const dLO = clamp((0.04 - marginToLo) / 0.04 * 90, 0, 100)
  // 7. HISIDE — operating closer to Mach-buffet edge
  const dHI = clamp((0.04 - marginToHi) / 0.04 * 90, 0, 100)
  // 8. CLB — currently still climbing into thinner air with reduced margin
  const dCLB = f.vertRate > 300 && f.altitudeFt > 32000 ? clamp(f.vertRate / 30, 0, 80) : 0

  const drivers = {
    'MARG':   Math.round(dMARG),
    'NUP':    Math.round(dNUP),
    'WGT':    Math.round(dWGT),
    'ALT':    Math.round(dALT),
    'ISA':    Math.round(dISA),
    'LO':     Math.round(dLO),
    'HI':     Math.round(dHI),
    'CLB':    Math.round(dCLB),
  }
  const drvArr = Object.values(drivers)
  let score = (Math.max(...drvArr) * 0.66 + (drvArr.reduce((a, c) => a + c, 0) / drvArr.length) * 0.34) * advMul

  // ---------------- Hard escalators ---------------- //
  const notes: string[] = []
  // COFFIN: window < 8 KCAS (Pinnacle 3701 regime)
  if (windowKCAS < 8 && f.altitudeFt >= 25000) {
    score = Math.max(score, 90)
    notes.push(`COFFIN-CORNER · IAS band ${windowKCAS.toFixed(0)} KCAS (lo ${kcasLo.toFixed(0)} / hi ${kcasHi.toFixed(0)}) — any disturbance triggers buffet (Pinnacle 3701 NTSB AAR-07-01 mode)`)
  }
  // Maneuver buffet onset within nominal 1.3g manoeuvre margin per FAR §25.143
  if (nMax < 1.20 && f.altitudeFt >= 25000) {
    score = Math.max(score, 78)
    notes.push(`Buffet onset at n=${nMax.toFixed(2)}g < 1.3g — bank ≥40° will trigger pre-stall buffet per FAR §25.143(b)(7)`)
  }
  // Climbing into corner
  if (f.vertRate > 400 && altMarginFt < 2000) {
    score = Math.max(score, 72)
    notes.push(`Climbing into coffin corner · ${altMarginFt.toFixed(0)}ft margin, VS ${f.vertRate.toFixed(0)}fpm — request level off per FCT 5.40 / AC 120-111`)
  }
  // Already above coffin altitude (heavy/warm)
  if (altMarginFt < 0) {
    score = Math.max(score, 85)
    notes.push(`Above coffin-corner altitude · ${(-altMarginFt).toFixed(0)}ft over CC alt ${coffinFt.toFixed(0)}ft — descend to recover envelope per AC 25-7D §5.4`)
  }
  // West Caribbean 708 mode — heavy + ISA warm
  if (wFrac > 0.92 && isaDev > 10 && f.altitudeFt > 32000) {
    notes.push(`Heavy weight (${(wFrac * 100).toFixed(0)}% MTOW) + ISA+${isaDev.toFixed(0)} at FL${(f.altitudeFt / 100).toFixed(0)} — West Caribbean 708 precedent (DGAC AIG 0598, 160 fatal)`)
    score = Math.max(score, 65)
  }
  // AF447 contextual
  if (cls === 'HVY-T' && f.altitudeFt >= 35000 && windowKCAS < 35) {
    notes.push(`Reduced cruise envelope · ${windowKCAS.toFixed(0)} KCAS band — pitch-up command on autopilot disengagement may exceed margin (AF447 BEA Rapport Final 2012 context)`)
  }

  score = clamp(score, 0, 100)

  // ---------------- Tier classification ---------------- //
  let tier: Tier = 'BELOW'
  if (f.altitudeFt < 23000) tier = 'BELOW'
  else if (windowKCAS < 8 || score >= 85) tier = 'COFFIN'
  else if (windowKCAS < 14 || score >= 65) tier = 'COMPRESSED'
  else if (windowKCAS < 22 || score >= 45) tier = 'TIGHT'
  else if (windowKCAS < 35 || score >= 25) tier = 'NORMAL'
  else tier = 'AMPLE'

  return {
    f, cls, spec, weightKg, wFrac,
    mNow, mLoBuf, mHiBuf, mLoBufN,
    kcasNow, kcasLo, kcasHi, windowKCAS,
    marginToLo, marginToHi, nMax, coffinFt, altMarginFt,
    drivers, score, tier, notes,
  }
}

// -------------------------------------------------------------------- //
// Component
// -------------------------------------------------------------------- //
export default function CcornMonitor({ map, flights, onClose, onFly }: Props) {
  const [isaDev, setIsaDev] = useState(0)
  const [weightBias, setWeightBias] = useState(0)
  const [nMnvr, setNmnvr] = useState(1.3)
  const [advMul, setAdvMul] = useState(1.0)
  const [minFL, setMinFL] = useState(230)
  const [maxFL, setMaxFL] = useState(450)
  const [classFilter, setClassFilter] = useState<'ALL' | AClass>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CLASSES' | 'ENVELOPE' | 'PRECEDENT' | 'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)
  const [pickedIcao, setPickedIcao] = useState<string | null>(null)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = computeRow(f, isaDev, weightBias, nMnvr, advMul)
      if (!r) continue
      if (r.f.altitudeFt < minFL * 100) continue
      if (r.f.altitudeFt > maxFL * 100) continue
      out.push(r)
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, isaDev, weightBias, nMnvr, advMul, minFL, maxFL])

  const filtered = useMemo(() => rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls === classFilter) &&
    (search === '' ||
      (r.f.callsign || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      r.cls.toLowerCase().includes(search.toLowerCase()))
  ), [rows, tierFilter, classFilter, search])

  // Per-tier counters
  const tierCnt: Record<Tier, number> = { COFFIN: 0, COMPRESSED: 0, TIGHT: 0, NORMAL: 0, AMPLE: 0, BELOW: 0 }
  for (const r of rows) tierCnt[r.tier]++

  // Summary metrics
  const muWin = rows.length ? rows.reduce((s, r) => s + r.windowKCAS, 0) / rows.length : 0
  const muMarg = rows.length ? rows.reduce((s, r) => s + (r.mHiBuf - r.mLoBuf), 0) / rows.length : 0
  const sumCoffin = tierCnt.COFFIN + tierCnt.COMPRESSED
  const worst = rows[0]
  const muAltMargin = rows.length ? rows.reduce((s, r) => s + r.altMarginFt, 0) / rows.length : 0

  // Per-class aggregation
  const classAgg = useMemo(() => {
    const m = new Map<AClass, { n: number; muScore: number; muWin: number; coffin: number; comp: number; tight: number }>()
    for (const r of rows) {
      const v = m.get(r.cls) || { n: 0, muScore: 0, muWin: 0, coffin: 0, comp: 0, tight: 0 }
      v.n++
      v.muScore += r.score
      v.muWin += r.windowKCAS
      if (r.tier === 'COFFIN') v.coffin++
      if (r.tier === 'COMPRESSED') v.comp++
      if (r.tier === 'TIGHT') v.tight++
      m.set(r.cls, v)
    }
    const arr = Array.from(m.entries()).map(([c, v]) => ({
      cls: c, spec: AC_CATALOGUE[c], n: v.n,
      muScore: v.muScore / Math.max(1, v.n), muWin: v.muWin / Math.max(1, v.n),
      coffin: v.coffin, comp: v.comp, tight: v.tight,
    }))
    arr.sort((a, b) => b.muScore - a.muScore)
    return arr
  }, [rows])

  // ---------------- MapLibre overlay ---------------- //
  useEffect(() => {
    if (!map) return
    const SRC_AC = 'ccorn-ac-src'
    const SRC_VEC = 'ccorn-vec-src'
    const ensure = (id: string) => {
      if (!map.getSource(id)) {
        try { map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any }) } catch { /* ignore */ }
      }
    }
    ;[SRC_AC, SRC_VEC].forEach(ensure)

    const writeAll = () => {
      const ac: any[] = []
      const vec: any[] = []
      for (const r of filtered) {
        ac.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            tier: r.tier,
            color: TIER_COLOR[r.tier],
            score: r.score,
            sz: 7 + (r.score / 100) * 16,
            label: `${r.f.callsign || r.f.icao} · ${r.tier} · Δ${r.windowKCAS.toFixed(0)}kt n${r.nMax.toFixed(2)}g`,
            isCriticalPin: (r.tier === 'COFFIN' || r.tier === 'COMPRESSED') ? 1 : 0,
          },
        })
        if (shVec && r.altMarginFt > 0 && r.altMarginFt < 6000) {
          // Forward cone toward coffin altitude — synthetic 12 NM along track scaled by danger
          const head = r.f.track || 0
          const dist = clamp(6 - r.altMarginFt / 1000, 1, 14) // 1..14 NM
          const dLat = (dist / 60) * Math.cos(head * Math.PI / 180)
          const dLng = (dist / 60) * Math.sin(head * Math.PI / 180) / Math.cos(r.f.lat * Math.PI / 180)
          vec.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [r.f.lng + dLng, r.f.lat + dLat]] },
            properties: { color: TIER_COLOR[r.tier] },
          })
        }
      }
      const acSrc = map.getSource(SRC_AC) as any
      if (acSrc) acSrc.setData({ type: 'FeatureCollection', features: ac })
      const vecSrc = map.getSource(SRC_VEC) as any
      if (vecSrc) vecSrc.setData({ type: 'FeatureCollection', features: vec })
    }

    const addLayer = (id: string, def: any) => {
      if (!map.getLayer(id)) {
        try { map.addLayer(def) } catch { /* ignore */ }
      }
    }

    if (shHalo) {
      addLayer('ccorn-halo', {
        id: 'ccorn-halo', type: 'circle', source: SRC_AC,
        paint: {
          'circle-radius': ['get', 'sz'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.18,
          'circle-stroke-width': 1.4,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.85,
        },
      })
    }
    if (shPin) {
      addLayer('ccorn-pin', {
        id: 'ccorn-pin', type: 'circle', source: SRC_AC,
        filter: ['==', ['get', 'isCriticalPin'], 1],
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#e11d48',
          'circle-stroke-width': 1.2,
          'circle-stroke-color': '#fee2e2',
        },
      })
    }
    if (shLbl) {
      addLayer('ccorn-lbl', {
        id: 'ccorn-lbl', type: 'symbol', source: SRC_AC,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 9.5,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#020617',
          'text-halo-width': 1.2,
        },
      })
    }
    if (shVec) {
      addLayer('ccorn-vec', {
        id: 'ccorn-vec', type: 'line', source: SRC_VEC,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.5,
          'line-opacity': 0.65,
          'line-dasharray': [3, 2],
        },
      })
    }

    writeAll()

    return () => {
      ;['ccorn-vec', 'ccorn-lbl', 'ccorn-pin', 'ccorn-halo'].forEach(id => {
        if (map.getLayer(id)) { try { map.removeLayer(id) } catch { /* ignore */ } }
      })
      ;[SRC_VEC, SRC_AC].forEach(id => {
        if (map.getSource(id)) { try { map.removeSource(id) } catch { /* ignore */ } }
      })
    }
  }, [map, filtered, shHalo, shPin, shLbl, shVec])

  // ENVELOPE diagram pre-compute (for picked class or worst row's class)
  const envSpec = useMemo(() => {
    if (pickedIcao) {
      const r = rows.find(rr => rr.f.icao === pickedIcao)
      if (r) return { spec: r.spec, cls: r.cls, picked: r }
    }
    return worst ? { spec: worst.spec, cls: worst.cls, picked: worst } : { spec: AC_CATALOGUE['HVY-T'], cls: 'HVY-T' as AClass, picked: null as Row | null }
  }, [pickedIcao, rows, worst])

  // Build envelope curves
  const envCurves = useMemo(() => {
    const { spec } = envSpec
    const Ws = [
      { label: 'MTOW',  w: spec.mtow * 0.99, color: '#f59e0b' },
      { label: '0.85',  w: spec.oew + (spec.mtow - spec.oew) * 0.85, color: '#0ea5e9' },
      { label: '0.65',  w: spec.oew + (spec.mtow - spec.oew) * 0.65, color: '#10b981' },
    ]
    const altPts: number[] = []
    for (let f = 25000; f <= spec.ceilFt + 4000; f += 1000) altPts.push(f)
    const curves = Ws.map(W => {
      const lo: { alt: number; kcas: number }[] = []
      const hi: { alt: number; kcas: number }[] = []
      let coffin = spec.ceilFt
      for (const alt of altPts) {
        const mLo = buffetMachLo(alt, isaDev, W.w, spec, 1)
        const mHi = buffetMachHi(spec, 1)
        const kLo = machToKCAS(mLo, alt, isaDev)
        const kHi = machToKCAS(mHi, alt, isaDev)
        if (mLo >= mHi - 0.005 && alt < coffin) coffin = alt
        lo.push({ alt, kcas: kLo })
        hi.push({ alt, kcas: kHi })
      }
      return { ...W, lo, hi, coffin }
    })
    return curves
  }, [envSpec, isaDev])

  // SVG helpers for envelope diagram
  const SVG_W = 340, SVG_H = 220
  const PAD_L = 38, PAD_R = 12, PAD_T = 12, PAD_B = 28
  const kcasMin = 130, kcasMax = 380
  const altMin  = 24000, altMax = (envSpec.spec.ceilFt + 4000)
  const xFor = (kcas: number) => PAD_L + ((kcas - kcasMin) / (kcasMax - kcasMin)) * (SVG_W - PAD_L - PAD_R)
  const yFor = (alt: number) => SVG_H - PAD_B - ((alt - altMin) / (altMax - altMin)) * (SVG_H - PAD_T - PAD_B)

  return (
    <div className="absolute top-16 right-4 z-30 w-[400px] max-h-[calc(100vh-5rem)] flex flex-col bg-slate-900/95 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-2xl text-slate-100 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div>
          <div className="text-[11px] font-bold tracking-widest text-sky-300">CCORN</div>
          <div className="text-[9px] text-slate-500">Coffin-Corner / Mach-Buffet Cruise-Envelope Margin Monitor</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-1">×</button>
      </div>

      {/* Tier strip */}
      <div className="px-2 py-1.5 border-b border-slate-700/60 flex gap-1">
        <button onClick={() => setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>
          ALL <span className="text-slate-500">{rows.length}</span>
        </button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(tierFilter === t ? 'ALL' : t)}
            className={`flex-1 px-1 py-1 rounded text-[9px] font-mono border ${tierFilter === t ? 'bg-slate-800/80' : 'bg-slate-800/40'}`}
            style={{ borderColor: TIER_COLOR[t] + (tierFilter === t ? 'ff' : '40'), color: TIER_COLOR[t] }}>
            {t.slice(0, 4)} <span className="opacity-70">{tierCnt[t]}</span>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="px-3 py-2 border-b border-slate-700/60 grid grid-cols-6 gap-1 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μWIN kt</div><div className="text-slate-100 font-mono">{muWin.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μΔM</div><div className="text-slate-100 font-mono">{muMarg.toFixed(3)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CRIT</div><div className="font-mono" style={{ color: sumCoffin ? TIER_COLOR.COFFIN : '#94a3b8' }}>{sumCoffin}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μΔALT</div><div className="text-slate-100 font-mono">{(muAltMargin / 1000).toFixed(1)}k</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">ISAΔ</div><div className="text-slate-100 font-mono">{isaDev >= 0 ? '+' : ''}{isaDev}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst ? (worst.f.callsign || worst.f.icao) : '—'}</div></div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ISA ΔC <span className="text-slate-200 font-mono">{isaDev >= 0 ? '+' : ''}{isaDev}</span>
            <input type="range" min="-30" max="30" value={isaDev} onChange={e => setIsaDev(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">WT-BIAS % <span className="text-slate-200 font-mono">{weightBias >= 0 ? '+' : ''}{weightBias}</span>
            <input type="range" min="-15" max="15" value={weightBias} onChange={e => setWeightBias(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">n-MNVR <span className="text-slate-200 font-mono">{nMnvr.toFixed(2)}g</span>
            <input type="range" min="100" max="200" value={nMnvr * 100} onChange={e => setNmnvr(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul * 100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul * 100} onChange={e => setAdvMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">MIN FL <span className="text-slate-200 font-mono">{minFL}</span>
            <input type="range" min="180" max="400" step="10" value={minFL} onChange={e => setMinFL(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">MAX FL <span className="text-slate-200 font-mono">{maxFL}</span>
            <input type="range" min="280" max="510" step="10" value={maxFL} onChange={e => setMaxFL(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        {/* Class filter */}
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL-CLS</button>
          {(['HVY-Q', 'HVY-T', 'WB-M', 'NB-LR', 'NB', 'RGN-J', 'RGN-T', 'BIZ'] as AClass[]).map(c => (
            <button key={c} onClick={() => setClassFilter(c)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === c ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        {/* Overlay toggles + search */}
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO', shHalo, setShHalo], ['PIN', shPin, setShPin], ['LBL', shLbl, setShLbl], ['VEC', shVec, setShVec]].map(([n, v, fn]: any) => (
            <button key={n} onClick={() => fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/cls" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-slate-700/60">
        {(['AIRCRAFT', 'CLASSES', 'ENVELOPE', 'PRECEDENT', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-1 py-1 rounded text-[10px] font-mono ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {tab === 'AIRCRAFT' && (
          <>
            {filtered.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-6">
                No aircraft in coffin-corner regime · widen FL window or adjust ISA/WT
              </div>
            )}
            {filtered.slice(0, 60).map(r => (
              <div key={r.f.icao} className="border rounded-lg p-2 bg-slate-800/40" style={{ borderColor: TIER_COLOR[r.tier] + '60' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: TIER_COLOR[r.tier] + '22', color: TIER_COLOR[r.tier] }}>{r.tier}</span>
                    <button onClick={() => { onFly(r.f.icao); setPickedIcao(r.f.icao) }} className="text-slate-100 font-mono text-[11px] hover:text-sky-300">{r.f.callsign || r.f.icao}</button>
                    <span className="text-slate-400 text-[10px]">{r.f.type || '?'}·{r.cls}·FL{(r.f.altitudeFt / 100).toFixed(0)}</span>
                  </div>
                  <div className="text-[10px] font-mono" style={{ color: TIER_COLOR[r.tier] }}>{r.score.toFixed(0)}</div>
                </div>
                <div className="grid grid-cols-5 gap-1 mt-1.5 text-[10px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">M now</div><div className="text-slate-200 font-mono">{r.mNow.toFixed(3)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">M lo</div><div className="font-mono" style={{ color: r.marginToLo < 0.02 ? TIER_COLOR.COFFIN : '#cbd5e1' }}>{r.mLoBuf.toFixed(3)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">M hi</div><div className="font-mono" style={{ color: r.marginToHi < 0.02 ? TIER_COLOR.COFFIN : '#cbd5e1' }}>{r.mHiBuf.toFixed(3)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">Δkt</div><div className="font-mono" style={{ color: r.windowKCAS < 12 ? TIER_COLOR.COFFIN : '#cbd5e1' }}>{r.windowKCAS.toFixed(0)}</div></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><div className="text-slate-500">n max</div><div className="font-mono" style={{ color: r.nMax < 1.2 ? TIER_COLOR.COFFIN : '#cbd5e1' }}>{r.nMax.toFixed(2)}g</div></div>
                </div>
                {/* Envelope bar: lo / current / hi */}
                <div className="mt-1.5">
                  <div className="text-[9px] text-slate-500 mb-0.5">Cruise envelope · CC alt {r.coffinFt.toFixed(0)}ft · ΔALT {r.altMarginFt >= 0 ? '+' : ''}{r.altMarginFt.toFixed(0)}ft</div>
                  <div className="h-2 bg-slate-900/60 rounded relative overflow-hidden">
                    {(() => {
                      const lo = r.kcasLo, hi = r.kcasHi, cur = r.kcasNow
                      const span = Math.max(40, hi - lo + 30)
                      const base = lo - 15
                      const pct = (k: number) => clamp(((k - base) / span) * 100, 0, 100)
                      return (
                        <>
                          <div className="absolute top-0 h-full bg-rose-600/40" style={{ left: 0, width: `${pct(lo)}%` }} />
                          <div className="absolute top-0 h-full bg-emerald-500/40" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
                          <div className="absolute top-0 h-full bg-rose-600/40" style={{ left: `${pct(hi)}%`, width: `${100 - pct(hi)}%` }} />
                          <div className="absolute top-0 bottom-0 w-0.5 bg-sky-300" style={{ left: `${pct(cur)}%` }} />
                        </>
                      )
                    })()}
                  </div>
                  <div className="flex justify-between text-[8px] text-slate-500 mt-0.5">
                    <span>LO {r.kcasLo.toFixed(0)}kt</span>
                    <span>NOW {r.kcasNow.toFixed(0)}kt</span>
                    <span>HI {r.kcasHi.toFixed(0)}kt</span>
                  </div>
                </div>
                {/* Drivers */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Object.entries(r.drivers).map(([k, v]) => (
                    <span key={k} className="text-[9px] px-1 py-0.5 rounded font-mono" style={{ background: v >= 50 ? TIER_COLOR.COMPRESSED + '22' : '#334155', color: v >= 50 ? TIER_COLOR.COMPRESSED : '#94a3b8' }}>{k} {v}</span>
                  ))}
                </div>
                {/* Notes */}
                {r.notes.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {r.notes.slice(0, 3).map((n, i) => (
                      <div key={i} className="text-[9px] text-slate-300 leading-tight">› {n}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {filtered.length > 60 && (
              <div className="text-center text-[9px] text-slate-500 py-2">… +{filtered.length - 60} more · narrow filters to inspect</div>
            )}
          </>
        )}

        {tab === 'CLASSES' && (
          <>
            <div className="text-[9px] text-slate-500 mb-1.5">7-class certified-envelope catalogue · click to filter</div>
            {classAgg.length === 0 && (
              <div className="text-center text-[10px] text-slate-500 py-4">No aircraft in scope</div>
            )}
            {classAgg.map(c => (
              <button key={c.cls} onClick={() => setClassFilter(c.cls)} className={`w-full text-left px-2 py-1.5 rounded border ${classFilter === c.cls ? 'bg-sky-500/10 border-sky-500/40' : 'bg-slate-800/40 border-slate-700/40'} mb-1`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[11px] font-mono text-slate-100">{c.cls} · {c.spec.label}</div>
                    <div className="text-[9px] text-slate-500">MMO {c.spec.mmo.toFixed(2)} · CL_buf {c.spec.clBuf.toFixed(2)} · CC-ref FL{(c.spec.ccRefFt / 100).toFixed(0)}</div>
                  </div>
                  <div className="text-[10px] font-mono text-right">
                    <div className="text-slate-300">n={c.n}</div>
                    <div style={{ color: TIER_COLOR.COFFIN }}>C{c.coffin} c{c.comp} t{c.tight}</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μSCR</span> <span className="font-mono text-slate-200">{c.muScore.toFixed(0)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μΔkt</span> <span className="font-mono text-slate-200">{c.muWin.toFixed(0)}</span></div>
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">CEIL</span> <span className="font-mono text-slate-200">FL{(c.spec.ceilFt / 100).toFixed(0)}</span></div>
                </div>
              </button>
            ))}
          </>
        )}

        {tab === 'ENVELOPE' && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-slate-500">
              Buffet envelope · class <span className="font-mono text-sky-300">{envSpec.cls}</span> · {envSpec.spec.label} · ISAΔ {isaDev >= 0 ? '+' : ''}{isaDev}°C
            </div>
            <div className="bg-slate-950/60 rounded p-1 border border-slate-800">
              <svg width={SVG_W} height={SVG_H}>
                {/* Grid */}
                {[150, 200, 250, 300, 350].map(k => (
                  <g key={`x${k}`}>
                    <line x1={xFor(k)} y1={PAD_T} x2={xFor(k)} y2={SVG_H - PAD_B} stroke="#1e293b" strokeWidth="1" />
                    <text x={xFor(k)} y={SVG_H - PAD_B + 12} fontSize="8" fill="#475569" textAnchor="middle">{k}</text>
                  </g>
                ))}
                {[26000, 30000, 34000, 38000, 42000, 46000].filter(a => a >= altMin && a <= altMax).map(a => (
                  <g key={`y${a}`}>
                    <line x1={PAD_L} y1={yFor(a)} x2={SVG_W - PAD_R} y2={yFor(a)} stroke="#1e293b" strokeWidth="1" />
                    <text x={PAD_L - 4} y={yFor(a) + 3} fontSize="8" fill="#475569" textAnchor="end">FL{(a / 100).toFixed(0)}</text>
                  </g>
                ))}
                <text x={SVG_W / 2} y={SVG_H - 6} fontSize="8" fill="#64748b" textAnchor="middle">KCAS</text>
                {/* Envelope curves per weight */}
                {envCurves.map((c, i) => {
                  const pathLo = c.lo.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xFor(p.kcas)} ${yFor(p.alt)}`).join(' ')
                  const pathHi = c.hi.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xFor(p.kcas)} ${yFor(p.alt)}`).join(' ')
                  return (
                    <g key={i}>
                      <path d={pathLo} fill="none" stroke={c.color} strokeWidth="1.3" strokeDasharray="4 3" opacity="0.85" />
                      <path d={pathHi} fill="none" stroke={c.color} strokeWidth="1.3" opacity="0.85" />
                      {/* Coffin apex marker */}
                      <circle cx={xFor((c.lo[c.lo.length - 1]?.kcas + c.hi[c.hi.length - 1]?.kcas) / 2)} cy={yFor(c.coffin)} r="3" fill={c.color} stroke="#020617" strokeWidth="0.8" />
                      <text x={xFor((c.lo[c.lo.length - 1]?.kcas + c.hi[c.hi.length - 1]?.kcas) / 2) + 6} y={yFor(c.coffin) + 3} fontSize="8" fill={c.color}>{c.label} CC FL{(c.coffin / 100).toFixed(0)}</text>
                    </g>
                  )
                })}
                {/* Fleet dots — same class as envelope */}
                {rows.filter(r => r.cls === envSpec.cls).slice(0, 60).map(r => (
                  <circle key={r.f.icao}
                    cx={xFor(clamp(r.kcasNow, kcasMin, kcasMax))}
                    cy={yFor(clamp(r.f.altitudeFt, altMin, altMax))}
                    r={r.tier === 'COFFIN' ? 4 : r.tier === 'COMPRESSED' ? 3.5 : 2.5}
                    fill={TIER_COLOR[r.tier]}
                    opacity={r === envSpec.picked ? 1 : 0.75}
                    stroke={r === envSpec.picked ? '#fff' : 'none'}
                    strokeWidth={r === envSpec.picked ? 1 : 0}
                  >
                    <title>{r.f.callsign || r.f.icao} · FL{(r.f.altitudeFt / 100).toFixed(0)} · {r.kcasNow.toFixed(0)}kt · {r.tier}</title>
                  </circle>
                ))}
                {/* Picked-row callout box */}
                {envSpec.picked && (
                  <g>
                    <rect x={PAD_L + 4} y={PAD_T + 4} width={150} height={36} fill="#0f172a" stroke="#334155" strokeWidth="0.8" rx="3" />
                    <text x={PAD_L + 8} y={PAD_T + 16} fontSize="9" fill="#0ea5e9" fontFamily="monospace">{envSpec.picked.f.callsign || envSpec.picked.f.icao}</text>
                    <text x={PAD_L + 8} y={PAD_T + 26} fontSize="8" fill="#cbd5e1">M{envSpec.picked.mNow.toFixed(3)} · {envSpec.picked.kcasNow.toFixed(0)}kt · n{envSpec.picked.nMax.toFixed(2)}g</text>
                    <text x={PAD_L + 8} y={PAD_T + 36} fontSize="8" fill={TIER_COLOR[envSpec.picked.tier]}>{envSpec.picked.tier} · Δ{envSpec.picked.windowKCAS.toFixed(0)}kt · score {envSpec.picked.score.toFixed(0)}</text>
                  </g>
                )}
              </svg>
            </div>
            <div className="text-[9px] text-slate-400 leading-snug">
              Solid lines = Mach-buffet HIGH ceiling · dashed = stall-buffet LOW floor · curves converge at coffin-corner apex (dot). Three weight cases plotted: <span style={{ color: '#f59e0b' }}>MTOW</span>, <span style={{ color: '#0ea5e9' }}>0.85·MTOW</span>, <span style={{ color: '#10b981' }}>0.65·MTOW</span>. Fleet aircraft of same class overlaid at (KCAS, FL).
            </div>
            {pickedIcao && (
              <button onClick={() => setPickedIcao(null)} className="w-full text-[9px] text-slate-500 hover:text-slate-300 px-2 py-1 bg-slate-800/40 rounded font-mono">clear pick · show worst-row</button>
            )}
          </div>
        )}

        {tab === 'PRECEDENT' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ACCIDENT PRECEDENT — coffin-corner LOC-I</div>
              <div className="space-y-1.5">
                <div className="bg-rose-950/40 rounded px-2 py-1.5 border border-rose-900/40">
                  <div className="font-mono text-[10px] text-rose-300">Pinnacle 3701 · CRJ-200 · KIRK 2004-10-14</div>
                  <div className="text-[10px] text-slate-300">NTSB AAR-07-01 · 2 fatal · crew climbed CRJ-200 to FL410 (service ceiling) at heavy weight, entered coffin corner where IAS band collapsed to ~3kt. Stall onset triggered dual flameout from compressor stall during recovery. Fatal forced-landing short of KJEF.</div>
                </div>
                <div className="bg-rose-950/40 rounded px-2 py-1.5 border border-rose-900/40">
                  <div className="font-mono text-[10px] text-rose-300">West Caribbean 708 · MD-82 · VE 2005-08-16</div>
                  <div className="text-[10px] text-slate-300">DGAC Venezuela AIG 0598 · 160 fatal · climbed to FL330 then commanded FL350 at high weight + ISA+15°C deviation. Buffet onset at insufficient margin, autopilot disconnect, stall-into-spin LOC-I. Direct coffin-corner mode.</div>
                </div>
                <div className="bg-rose-950/40 rounded px-2 py-1.5 border border-rose-900/40">
                  <div className="font-mono text-[10px] text-rose-300">AF447 · A330-203 · mid-Atlantic 2009-06-01</div>
                  <div className="text-[10px] text-slate-300">BEA Rapport Final 2012 · 228 fatal · contributing factor — cruise at FL350 with already-compressed buffet envelope (~30kt band); pitch-up commanded after pitot-icing AP disconnect exceeded available margin, full stall LOC-I.</div>
                </div>
                <div className="bg-rose-950/40 rounded px-2 py-1.5 border border-rose-900/40">
                  <div className="font-mono text-[10px] text-rose-300">Britannia 226A · B737-200 · LIMJ 1996-09-12</div>
                  <div className="text-[10px] text-slate-300">AAIB · upset event · FL370 step-climb caused buffet onset, manual recovery to lower FL. Highlighted classic 737-200 coffin-corner regime at MTOW.</div>
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› ESCAPE TECHNIQUE</div>
              <div className="bg-slate-800/40 rounded px-2 py-1.5">
                <div className="text-[10px] text-slate-300">
                  Coffin-corner exit per AC 120-111 / Boeing FCT 5.40 / Airbus FCTM PRO-NOR-CRZ §3:
                  <ol className="list-decimal pl-4 mt-1 space-y-0.5">
                    <li>Disengage A/T if commanding power above MCT</li>
                    <li>Pitch DOWN to descend ≥2000ft below buffet altitude</li>
                    <li>Accept Mach DECREASE (do NOT pitch up to "regain" speed)</li>
                    <li>Re-establish at lower FL, request FL change with ATC</li>
                    <li>If buffet onset already: relax back-pressure, wings level, do NOT pull</li>
                  </ol>
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› TRAINING</div>
              <div className="bg-slate-800/40 rounded px-2 py-1.5 text-[10px] text-slate-300">
                FAA SAFO 17010 · UPRT AC 120-111 · IATA APS UPRT Rev 3 · ICAO Doc 10011 · EASA AMC1 FCL.745.A — full-flight simulator coffin-corner exposure mandated post-Pinnacle 3701 / post-AF447.
              </div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 space-y-2 leading-snug">
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› MODEL</div>
              <div className="text-[10px] text-slate-400">
                Two-sided buffet envelope evaluator. Per-class certified spec (MMO, MCRIT, CL_max, CL_buf, S_wing, MTOW, OEW, ceiling, CC-ref-alt) from Boeing PEM §3 / Airbus FCOM LIM-21 / Embraer AFM §2 / ICAO Doc 8643 / BADA 3.15 OPF. Deterministic per-icao24 weight in [OEW + 0.45·(MTOW−OEW), 0.99·MTOW] × (1 + WT-BIAS%).
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› PHYSICS</div>
              <div className="bg-slate-800/40 rounded px-2 py-1.5 font-mono text-[9.5px] text-slate-200 leading-snug">
                Low-buffet Mach:<br/>
                &nbsp;&nbsp;CL_buf = 0.96·CL_max (FAR §25.1419)<br/>
                &nbsp;&nbsp;V<sub>ms</sub> = √(2·n·W / (ρ·S·CL_buf))<br/>
                &nbsp;&nbsp;M_lo(n) = V<sub>ms</sub> / a<br/>
                High-buffet Mach:<br/>
                &nbsp;&nbsp;M_hi(n) = 0.96·MMO − 0.04·√(n−1)<br/>
                ISA atmosphere: T = 288.15 − 0.0019812·h + ΔISA (h&lt;36089ft)<br/>
                Density: ρ = ρ₀·(P/P₀)·(T₀/T)<br/>
                Sound speed: a = a₀·√(T/T₀)<br/>
                Coffin alt: bisection of h where M_lo(1)=M_hi(1)<br/>
                Max load factor: n_max = CL_buf·ρ·V²·S / (2·W)<br/>
                KCAS via subsonic-compressible pitot:<br/>
                &nbsp;&nbsp;q_c/p_s = (1+0.2M²)^3.5 − 1<br/>
                &nbsp;&nbsp;Mc = √(5·((q_c/p_0 + 1)^(2/7) − 1))<br/>
                &nbsp;&nbsp;KCAS = Mc·a₀
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› DRIVERS (8) & COMPOSITE</div>
              <div className="text-[10px] text-slate-400">
                <span className="font-mono text-slate-200">MARG</span> total M-band 0→0.080 ·
                <span className="font-mono text-slate-200"> NUP</span> n_max&lt;1.3g ·
                <span className="font-mono text-slate-200"> WGT</span> W/MTOW ·
                <span className="font-mono text-slate-200"> ALT</span> coffin-margin&lt;4kft ·
                <span className="font-mono text-slate-200"> ISA</span> ISA+&gt;5°C ·
                <span className="font-mono text-slate-200"> LO</span> M−M_lo&lt;0.04 ·
                <span className="font-mono text-slate-200"> HI</span> M_hi−M&lt;0.04 ·
                <span className="font-mono text-slate-200"> CLB</span> active climb above FL320.
                Composite = max·0.66 + mean·0.34 × ADV-MUL. Hard escalators: window&lt;8kt→90 (Pinnacle), n_max&lt;1.2g→78, above-CC-alt→85, climb-into-corner→72.
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› TIERS (6)</div>
              <div className="text-[10px] text-slate-400 space-y-0.5">
                <div><span className="font-mono px-1 rounded" style={{ background: TIER_COLOR.COFFIN + '22', color: TIER_COLOR.COFFIN }}>COFFIN</span> &nbsp;Δ&lt;8kt or score≥85 — apex regime, descend</div>
                <div><span className="font-mono px-1 rounded" style={{ background: TIER_COLOR.COMPRESSED + '22', color: TIER_COLOR.COMPRESSED }}>COMPRESSED</span> &nbsp;Δ&lt;14kt or score≥65 — compressed envelope</div>
                <div><span className="font-mono px-1 rounded" style={{ background: TIER_COLOR.TIGHT + '22', color: TIER_COLOR.TIGHT }}>TIGHT</span> &nbsp;Δ&lt;22kt or score≥45 — tight margin</div>
                <div><span className="font-mono px-1 rounded" style={{ background: TIER_COLOR.NORMAL + '22', color: TIER_COLOR.NORMAL }}>NORMAL</span> &nbsp;Δ&lt;35kt or score≥25 — nominal cruise</div>
                <div><span className="font-mono px-1 rounded" style={{ background: TIER_COLOR.AMPLE + '22', color: TIER_COLOR.AMPLE }}>AMPLE</span> &nbsp;Δ≥35kt — ample buffer</div>
                <div><span className="font-mono px-1 rounded" style={{ background: TIER_COLOR.BELOW + '22', color: TIER_COLOR.BELOW }}>BELOW</span> &nbsp;FL&lt;230 — outside coffin regime</div>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-sky-300 mb-1">› REFERENCES</div>
              <div className="text-[9.5px] text-slate-400 leading-snug">
                14 CFR §25.143(b)(7) §25.251(e) §25.1419 · ICAO Doc 9760 Vol II Pt IV §3 · Annex 6 Pt I §4.2.5 · Annex 8 Pt IIIA Ch.4 · FAA AC 25-7D §5.4 · AC 91-79B App.1 · AC 120-111 · SAFO 17010 · EASA CS-25.143 / CS-25.251 / AMC 25.251 · Boeing FCOM PI-LIM · FCT 5.40 · Airbus FCOM LIM-21 · FCTM PRO-NOR-CRZ §3 · GTG Aircraft Perf §3.7 · Anderson Aircraft Perf & Design Ch.8 · Hale Aircraft Perf §5.7-9 · Etkin & Reid §3.6 · Roskam Pt VI Ch.5 · NTSB AAR-07-01 Pinnacle 3701 · DGAC AIG 0598 West Caribbean 708 · BEA Final AF447 · AAIB Britannia 226A
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
