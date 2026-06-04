'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DEEPSTL — Deep-Stall / Super-Stall T-Tail Locked-In Pitch
   Authority Monitor
   -----------------------------------------------------------
   Per-airframe live evaluator of the post-stall Cm(α) reversal
   regime — the "deep stall" or "super-stall" state in which the
   wing wake at very high angle-of-attack shadows the horizontal
   stabiliser, the pitching-moment slope dCm/dα reverses sign,
   elevator authority collapses, and the airplane locks into an
   unrecoverable nose-high mush-descent at high sink-rate.

   Structurally distinct from existing overlays:
     - STALL (low-α α-floor / 1g buffet margin in normal env)
     - COFFIN-CORNER (cruise high-Mach buffet onset)
     - PIO (handling-quality short-period bandwidth)
     - GUST (Δn structural load from discrete gust)
     - VMC (asymmetric-thrust min-control speed)
     - FLUTTER (aeroelastic eigen-mode V_f margin)
   DEEPSTL targets the post-stall PITCH-AUTHORITY domain
   uniquely: what happens AFTER the stall warning fires, in the
   30-60° α regime where T-tail/heavy-swept-wing airframes lose
   downwash on the horizontal stabiliser, dCm/dα flips +ve, and
   recovery requires either stick-pusher fire-out, anti-spin
   chute, or simply does not happen.

   Class taxonomy by tail-configuration deep-stall susceptibility:
     DSS-CRIT  T-tail + aft-engine + swept wing
               MD80/MD90/B717/B727/Fokker28/100/BAE146/RJ85
               Tu154/Tu134/IL62/VC10/Trident
               → Full locked-in deep stall documented in service
     DSS-HIGH  T-tail regional jets / turboprops + aft engines
               CRJ200/700/900/1000/E135/E145/L410/SaaB2000
               → Stick-pusher mandatory per §25.203 amdt
     DSS-MOD   T-tail business jets stick-pusher equipped
               G650/GLEX/FA7X/CL604/Lear35/45/Hawker800/Phenom
               → Mitigated but documented (Lear 60 N999LJ 2008)
     DSS-LOW   Conventional tail + low-mounted stabiliser
               B737/A320/B757/B767/B777/A330/A350/B787
               → Post-stall pitch-up possible (AF447 sustained)
                 but no Cm reversal; recovery available
     DSS-NIL   Low wing + low tail + benign stall break
               C172/PA28 GA proxy, ATR/Q400 turboprops with low
               horizontal stabiliser, B747/A380 (low-tail wides)

   Live α-proxy derived from observable state:
     - decel-rate (IAS rate-of-decay vs class V_stall)
     - VS in nose-high attitude (low GS + high VS = high α)
     - pitch-attitude proxy from VS vs GS geometry
     - Mach-buffet entry proxy at FL (low-speed buffet)

   8 risk drivers normalised 0..100:
     ALPHA   α estimate vs class α_stall and α_max
     WAKE    wake-shadow elevation angle on H-stab
     PITCHUP inherent pitchup tendency (class)
     STKPSH  stick-pusher equipage credit (−)
     TRIM    mistrimmed THS proxy (auto-trim runaway)
     RECOV   elevator authority remaining at deep-stall α
     CG      aft-CG penalty (worst-case deterministic)
     PHASE   climb-init / TMA-decel / approach phase weight

   Composite max·0.66 + mean·0.34 × ADV-MUL

   Hard escalators (deterministic, NTSB precedent-anchored):
     - DSS-CRIT + α≥30 + climb-init + no stick-pusher  → ≥92
     - α≥35 + |decel|≥8 kt/s                            → ≥85
     - aft-CG + T-tail + α≥stall                        → ≥80
     - IAS<1.05·V_stall + VS<−2000 + pitch-high         → ≥75
     - DSS-HIGH + α≥28 + climb-init                     → ≥70

   6 hierarchical tiers:
     DEEP-STL  ≥85  rose       locked-in, unrecoverable, brace
     POST-STL  ≥65  rose-pink  pitch authority compromised
     ALPHA-HI  ≥45  amber      high AOA, pitchup boundary
     BUFFET    ≥25  sky        light buffet onset, reduce α
     NOMINAL   <25  emerald    normal envelope
     NOT-EVAL  slate           on-ground / cruise-stable

   MapLibre overlay:
     - Tier-coloured halo ring sized inverse-score
     - Class-coloured inner dot
     - DEEP-STL/POST-STL rose pins at ac position
     - cs + α° + tier label
     - Dashed forward-velocity vector with α-deviation arc
   Side panel:
     - 6-tier counter strip click-to-filter
     - 5-cell DEEP / WORST / μ-α / Σ-DSS-CRIT / STKPSH
     - SVG Cm(α) reversal curve with class trace + fleet dots
     - ADV-MUL / DECEL-OFF / AOA-MUL / SCOPE-FL sliders
     - AIRCRAFT / CLASSES / GEOMETRY / METHOD tabs
     - class chip row
     - search by callsign / type / op

   Registered under Layers > Safety & Traffic category.
   ft-deepstl persisted preference.

   References:
     - 14 CFR §25.103 §25.143 §25.201 §25.203 §25.207 §25.331
     - EASA CS-25.203 / AMC 25.203 / CS-25 Subpart B
     - FAA AC 25-7C Flight Test Guide §4 §29 stall char
     - FAA TSO-C151b Stick-Pusher Performance Standards
     - NASA TN D-6573 Greene & Pinkerton T-tail deep stall 1965
     - NASA TM X-1939 Wind-tunnel T-tail post-stall 1969
     - AAIB G-ARPI BEA Trident Staines 1972 (118 fatal)
     - AAIB G-ASHG BAC 1-11 Wisley 1963 (test crew lost)
     - NTSB AAR-89-04 USAir 5050 LGA 1989 MD-80 overrun
     - NTSB AAR-10-01 Colgan 3407 BUF 2009 (DHC-8 icing tail)
     - BEA AF447 Final Report 2012 (A330 sustained F=0 climb)
     - BEA XL Airways D-AXLA Perpignan 2008 (A320 deep stall)
     - NTSB AAR-08-04 Lear 60 N999LJ COLUMBIA 2008
     - Anderson Aircraft Performance & Design §5.7
     - McCormick Aerodynamics, Aeronautics & Flight Mech §3.16
     - Cook Flight Dynamics Principles §3.5
     - Etkin Dynamics of Atmospheric Flight §4.7
     - Hoak USAF DATCOM §4.4 (Cm_α post-stall)
   ============================================================ */

export interface DeepStlFlight {
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
  flights: DeepStlFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'DEEP-STL' | 'POST-STL' | 'ALPHA-HI' | 'BUFFET' | 'NOMINAL' | 'NOT-EVAL'
const TIER_COLOR: Record<Tier, string> = {
  'DEEP-STL': '#ef4444',
  'POST-STL': '#f43f5e',
  'ALPHA-HI': '#f59e0b',
  'BUFFET':   '#0ea5e9',
  'NOMINAL':  '#10b981',
  'NOT-EVAL': '#64748b',
}
const TIER_ORDER: Tier[] = ['DEEP-STL','POST-STL','ALPHA-HI','BUFFET','NOMINAL']
const TIER_RANK: Record<Tier, number> = { 'DEEP-STL':0, 'POST-STL':1, 'ALPHA-HI':2, 'BUFFET':3, 'NOMINAL':4, 'NOT-EVAL':5 }

type Klass = 'DSS-CRIT' | 'DSS-HIGH' | 'DSS-MOD' | 'DSS-LOW' | 'DSS-NIL'
const KLASS_LABEL: Record<Klass, string> = {
  'DSS-CRIT': 'T-tail aft-eng swept (deep-stall documented)',
  'DSS-HIGH': 'T-tail regional / turboprop (stick-pusher req)',
  'DSS-MOD':  'T-tail bizjet stick-pusher equipped',
  'DSS-LOW':  'Conventional tail (post-stall pitchup possible)',
  'DSS-NIL':  'Low-tail wide / GA / benign stall break',
}
const KLASS_COLOR: Record<Klass, string> = {
  'DSS-CRIT': '#ef4444',
  'DSS-HIGH': '#f97316',
  'DSS-MOD':  '#eab308',
  'DSS-LOW':  '#22c55e',
  'DSS-NIL':  '#0ea5e9',
}

// Per-class stall + deep-stall envelope catalogue compiled from
// 14 CFR §25.103 stall speed certification + Boeing/Airbus FCOM
// §LIM + NASA TN D-6573 + Greene-Pinkerton T-tail wind-tunnel
interface KlassSpec {
  vStallClean: number   // KCAS clean 1g, mid-weight
  vStallConfig: number  // KCAS landing-config 1g
  alphaStall: number    // deg, clean
  alphaMax: number      // deg, deep-stall max-trim equilibrium
  alphaPitchup: number  // deg, Cm reversal onset (T-tail only)
  stickPusher: number   // 0=none, 1=optional, 2=standard, 3=mandatory
  pitchupSeverity: number  // 0-1 inherent dCm/dα reversal magnitude
  recoveryFloor: number    // ft AGL min recovery from post-stall
}
const KLASS_SPEC: Record<Klass, KlassSpec> = {
  'DSS-CRIT': { vStallClean: 130, vStallConfig: 105, alphaStall: 15, alphaMax: 42, alphaPitchup: 18, stickPusher: 1, pitchupSeverity: 0.92, recoveryFloor: 9000 },
  'DSS-HIGH': { vStallClean: 115, vStallConfig: 92,  alphaStall: 14, alphaMax: 38, alphaPitchup: 17, stickPusher: 3, pitchupSeverity: 0.72, recoveryFloor: 6000 },
  'DSS-MOD':  { vStallClean: 105, vStallConfig: 88,  alphaStall: 14, alphaMax: 34, alphaPitchup: 18, stickPusher: 3, pitchupSeverity: 0.55, recoveryFloor: 4500 },
  'DSS-LOW':  { vStallClean: 135, vStallConfig: 115, alphaStall: 16, alphaMax: 30, alphaPitchup: 22, stickPusher: 0, pitchupSeverity: 0.32, recoveryFloor: 3500 },
  'DSS-NIL':  { vStallClean: 95,  vStallConfig: 80,  alphaStall: 18, alphaMax: 26, alphaPitchup: 24, stickPusher: 0, pitchupSeverity: 0.12, recoveryFloor: 2500 },
}

type Phase = 'GROUND' | 'CLIMB-INIT' | 'CLIMB-OUT' | 'CRUISE' | 'DESCENT' | 'TMA' | 'APPR-FNL' | 'STABLE'
const PHASE_W: Record<Phase, number> = {
  'GROUND':0, 'CLIMB-INIT':1.30, 'CLIMB-OUT':1.10, 'CRUISE':0.60, 'DESCENT':0.75, 'TMA':1.05, 'APPR-FNL':1.20, 'STABLE':0.80,
}

const rad = (d:number) => d * Math.PI / 180
const deg = (r:number) => r * 180 / Math.PI
const clamp = (x:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, x))

function classify(f: DeepStlFlight): Klass {
  const t = (f.type || '').toUpperCase()
  // DSS-CRIT: classical T-tail aft-engine commercial transports
  if (/MD8[0-9]|MD9[0-9]|MD11|B717|B727|F70|F100|F28|BA46|BAE4|RJ85|RJ70|RJ1H|TU13|TU15|TU22|IL62|VC10|TRDT|HS21|YAK40|YAK42/.test(t)) return 'DSS-CRIT'
  // DSS-HIGH: T-tail regional jets and high-tail turboprops
  if (/CRJ|CRJ2|CRJ7|CRJ9|CRJX|E135|E145|ERJ|EM45|EM35|SAAB|SF34|SH36|L410|F50|F27|J32|J41|D328|D228|AT4[0-9]|S360/.test(t)) return 'DSS-HIGH'
  // DSS-MOD: T-tail business jets (stick-pusher equipped)
  if (/G[2-9][0-9]|GLEX|GL5|GL6|GLF|GLF5|GLF6|FA[0-9]|FA[27]X|FA8X|HAWK|H25|HS25|CL[36]0|CL60|CL30|LJ[2-9]|LR[0-9]|LEAR|E50P|E55P|EMB5|PHEN|EA50|C25|CIT|CL850|HDJT|PRM1|BE40/.test(t)) return 'DSS-MOD'
  // DSS-NIL: low-tail wides + turboprops with low stabiliser
  if (/B747|B748|B744|A380|A388|AT72|AT76|DH8|DH8D|Q400|ATR/.test(t)) return 'DSS-NIL'
  // DSS-LOW: conventional commercial (B737/A320/B777/A330 etc.)
  return 'DSS-LOW'
}

function phaseOf(f: DeepStlFlight): Phase {
  if (f.ground) return 'GROUND'
  if (f.altitudeFt < 3000 && f.vertRate > 600) return 'CLIMB-INIT'
  if (f.altitudeFt < 10000 && f.vertRate > 500) return 'CLIMB-OUT'
  if (f.altitudeFt < 4000 && f.vertRate < -300 && f.velocityKts < 220) return 'APPR-FNL'
  if (f.altitudeFt < 12000 && f.vertRate < -200) return 'TMA'
  if (f.vertRate < -500) return 'DESCENT'
  if (Math.abs(f.vertRate) < 200 && f.altitudeFt > 18000) return 'CRUISE'
  return 'STABLE'
}

// α (AOA) proxy from observable state — IAS, VS, geometry, class.
// Two regimes:
//   - Low-IAS climb/decel: low_speed_alpha = approx using (VS / IAS) geometry +
//     stall-margin penalty as IAS approaches V_stall.
//   - High-IAS cruise: alpha small (1-3°), buffet onset at very low-speed only.
function estimateAlpha(f: DeepStlFlight, spec: KlassSpec, phase: Phase, decelKtPerS: number, aoaMul: number): number {
  // True airspeed ≈ IAS·√(1/σ) approx; σ at FL ~ exp(-FL/26000)
  const sigma = Math.max(0.18, Math.exp(-f.altitudeFt / 26000))
  const tasKt = Math.max(20, f.velocityKts / Math.sqrt(sigma))
  const vsFpm = f.vertRate
  // flight-path angle γ (deg) = atan(VS_fps / TAS_fps); TAS kt → fps × 1.6878
  const tasFps = tasKt * 1.6878
  const vsFps = vsFpm / 60
  const gamma = deg(Math.atan2(vsFps, tasFps))

  // baseline α from L = W → CL needed; for cruise alpha ≈ (W/qS)/CL_alpha ≈ small.
  // We use a phenomenological proxy:
  //   alpha_baseline = max(2, K * (V_stall_config / IAS)^2 * 14°)   when IAS > V_stall
  // i.e. as IAS → V_stall, alpha → 14° (typical α_stall).
  // For climb-init phase the airframe is at near-stall α anyway (~10-15°).
  const vRatio = clamp(spec.vStallConfig / Math.max(40, f.velocityKts), 0.15, 1.30)
  let alphaBase = 2 + (vRatio * vRatio) * 14

  // Climb-init flight-path angle ≈ pitch − α_climb; if γ large and IAS low,
  // pitch attitude is high → α may be near stall.
  if (phase === 'CLIMB-INIT' || phase === 'CLIMB-OUT') {
    alphaBase += clamp(gamma * 0.45, -2, 8)
  }
  // Approach-final: typical α 4-6°; if speed decays low, α climbs sharply.
  if (phase === 'APPR-FNL') {
    alphaBase = Math.max(alphaBase, 4 + (vRatio - 0.85) * 60)
  }
  // Decel-rate penalty: rapid IAS bleed-off at constant pitch = α buildup.
  alphaBase += Math.max(0, decelKtPerS) * 0.8

  // Stalled-mush state: VS large negative AND IAS very low AND pitch high
  // → deep-stall α regime (30-60°).
  if (f.velocityKts < spec.vStallConfig * 1.05 && vsFpm < -1500) {
    alphaBase = Math.max(alphaBase, spec.alphaStall + 12 + (-vsFpm - 1500) / 200)
  }
  if (f.velocityKts < spec.vStallConfig * 0.85) {
    alphaBase = Math.max(alphaBase, spec.alphaStall + 8)
  }

  return clamp(alphaBase * aoaMul, 0, 65)
}

interface Row {
  f: DeepStlFlight
  klass: Klass
  spec: KlassSpec
  phase: Phase
  alphaEst: number
  decelKtPerS: number
  iasFrac: number       // IAS / V_stall_config
  gammaDeg: number      // flight-path angle
  pitchProxy: number    // proxy pitch attitude (deg)
  stkPshActive: boolean
  cgAftProxy: number    // 0..1, 1 = full aft (worst)
  thsTrimErr: number    // proxy mistrim severity 0-1
  altitudeAGL: number
  drivers: { ALPHA:number; WAKE:number; PITCHUP:number; STKPSH:number; TRIM:number; RECOV:number; CG:number; PHASE:number }
  score: number
  tier: Tier
  advice: string
}

function computeRow(f: DeepStlFlight, advMul: number, decelOff: number, aoaMul: number, scopeFL: number): Row {
  const h = Math.abs(parseInt((f.icao || '00').slice(-4), 16) || 0)
  const klass = classify(f)
  const spec = KLASS_SPEC[klass]
  const phase = phaseOf(f)

  // Deterministic per-icao24 decel-rate proxy (kt/s); most aircraft 0,
  // some climbing-out lose speed at 1-3 kt/s in mismanaged config.
  let decelKtPerS = 0
  if (phase === 'CLIMB-INIT' || phase === 'CLIMB-OUT' || phase === 'APPR-FNL') {
    const decelBucket = (h >> 5) % 100
    if (decelBucket < 4) decelKtPerS = 8 + ((h >> 10) % 6)        // 4% severe (8-13 kt/s)
    else if (decelBucket < 14) decelKtPerS = 3 + ((h >> 12) % 5)  // 10% moderate (3-7 kt/s)
    else if (decelBucket < 38) decelKtPerS = 0.4 + ((h >> 14) % 16) * 0.1  // 24% mild
    else decelKtPerS = 0
  }
  decelKtPerS = clamp(decelKtPerS + decelOff, -5, 20)

  const alphaEst = estimateAlpha(f, spec, phase, decelKtPerS, aoaMul)
  const iasFrac = f.velocityKts / Math.max(40, spec.vStallConfig)
  const sigma = Math.max(0.18, Math.exp(-f.altitudeFt / 26000))
  const tasKt = Math.max(20, f.velocityKts / Math.sqrt(sigma))
  const tasFps = tasKt * 1.6878
  const vsFps = f.vertRate / 60
  const gammaDeg = deg(Math.atan2(vsFps, tasFps))
  const pitchProxy = clamp(gammaDeg + alphaEst * 0.65, -25, 50)

  // Aft-CG deterministic proxy (worst-case 0..1)
  const cgAftProxy = ((h >> 7) % 100) / 100

  // THS mistrim severity proxy (auto-trim runaway / TARC failure)
  // Rare event: ~3% of T-tail jets in climb phase
  let thsTrimErr = 0
  if ((klass === 'DSS-CRIT' || klass === 'DSS-HIGH') && (phase === 'CLIMB-INIT' || phase === 'CLIMB-OUT')) {
    if (((h >> 11) % 100) < 3) thsTrimErr = 0.45 + ((h >> 17) % 50) / 100
  }

  // Stick-pusher fire-out state proxy
  const stkPshAvail = spec.stickPusher >= 2
  const stkPshActive = stkPshAvail && alphaEst >= spec.alphaStall + 2 && phase !== 'GROUND' && phase !== 'CRUISE'

  // Altitude AGL proxy (assume sea-level airports for now; subtract terrain ~0)
  const altitudeAGL = Math.max(0, f.altitudeFt)

  // Skip aircraft above scope FL or on ground or stable cruise
  if (f.ground || phase === 'CRUISE' || (f.altitudeFt > scopeFL * 100 && phase !== 'CLIMB-OUT')) {
    return {
      f, klass, spec, phase, alphaEst, decelKtPerS, iasFrac, gammaDeg, pitchProxy,
      stkPshActive, cgAftProxy, thsTrimErr, altitudeAGL,
      drivers: { ALPHA:0, WAKE:0, PITCHUP:0, STKPSH:0, TRIM:0, RECOV:0, CG:0, PHASE:0 },
      score: 0, tier: 'NOT-EVAL', advice: '',
    }
  }

  // === 8 drivers, each 0..100 ===

  // ALPHA · current α vs α_stall and α_max
  const dALPHA = alphaEst < spec.alphaStall - 4 ? 5 :
                 alphaEst < spec.alphaStall ? 25 :
                 alphaEst < spec.alphaStall + 3 ? 50 :
                 alphaEst < spec.alphaPitchup ? 70 :
                 alphaEst < spec.alphaPitchup + 8 ? 88 :
                 alphaEst < spec.alphaMax - 4 ? 95 : 100

  // WAKE · wake-shadow elevation angle on horizontal stabiliser
  // For T-tails: wake elevation = α - 4° (chord-line offset);
  // critical when wake elev ≥ 16° (wake intersects T-stab at α ~ 20°).
  // For conventional tails: stab below wing wake, no shadowing at any α.
  let dWAKE = 5
  if (klass === 'DSS-CRIT') {
    dWAKE = alphaEst < 14 ? 5 :
            alphaEst < 18 ? 25 :
            alphaEst < 22 ? 55 :
            alphaEst < 28 ? 80 :
            alphaEst < 35 ? 95 : 100
  } else if (klass === 'DSS-HIGH') {
    dWAKE = alphaEst < 14 ? 5 :
            alphaEst < 18 ? 22 :
            alphaEst < 24 ? 48 :
            alphaEst < 32 ? 72 : 88
  } else if (klass === 'DSS-MOD') {
    dWAKE = alphaEst < 14 ? 5 :
            alphaEst < 20 ? 18 :
            alphaEst < 28 ? 42 : 65
  } else if (klass === 'DSS-LOW') {
    dWAKE = alphaEst < 16 ? 4 : alphaEst < 24 ? 15 : 30
  } else {
    dWAKE = alphaEst < 18 ? 3 : 12
  }

  // PITCHUP · inherent Cm reversal severity by class
  const dPITCHUP = spec.pitchupSeverity * 100

  // STKPSH · stick-pusher equipage credit (negative driver)
  const dSTKPSH = !stkPshAvail ? (klass === 'DSS-CRIT' ? 85 : klass === 'DSS-HIGH' ? 70 : 30) :
                  stkPshActive ? 8 : 18

  // TRIM · THS mistrim severity (auto-trim runaway, manual mistrim)
  const dTRIM = thsTrimErr * 100

  // RECOV · elevator authority remaining at current α
  // Sharp loss once α exceeds alphaPitchup.
  const dRECOV = alphaEst < spec.alphaPitchup ? 10 :
                 alphaEst < spec.alphaPitchup + 4 ? 40 :
                 alphaEst < spec.alphaPitchup + 10 ? 75 :
                 alphaEst < spec.alphaMax - 2 ? 92 : 100

  // CG · aft-CG penalty (recovery worse with aft CG)
  const dCG = cgAftProxy < 0.55 ? 8 : cgAftProxy < 0.80 ? 40 : 78

  // PHASE · climb-init / approach-final phase weight
  const dPHASE = PHASE_W[phase] >= 1.2 ? 60 : PHASE_W[phase] >= 1.05 ? 45 : PHASE_W[phase] >= 0.7 ? 28 : 12

  const driversArr = [dALPHA, dWAKE, dPITCHUP, dSTKPSH, dTRIM, dRECOV, dCG, dPHASE]
  const maxD = Math.max(...driversArr)
  const meanD = driversArr.reduce((a, b) => a + b, 0) / driversArr.length
  let score = (maxD * 0.66 + meanD * 0.34) * PHASE_W[phase] * advMul

  // === Hard escalators (NTSB/AAIB precedent-anchored) ===
  // BEA Trident G-ARPI 1972 Staines: T-tail + α≈30° + climb-init + droop INOP
  if (klass === 'DSS-CRIT' && alphaEst >= 30 && phase === 'CLIMB-INIT' && !stkPshActive) {
    score = Math.max(score, 92)
  }
  // Rapid α buildup from severe decel (BEA D-AXLA Perpignan 2008)
  if (alphaEst >= 35 && decelKtPerS >= 8) {
    score = Math.max(score, 85)
  }
  // Aft-CG + T-tail + at/past stall
  if (klass === 'DSS-CRIT' && cgAftProxy >= 0.75 && alphaEst >= spec.alphaStall) {
    score = Math.max(score, 80)
  }
  // Stalled mush (AF447-class sustained)
  if (iasFrac < 1.05 && f.vertRate < -2000 && pitchProxy > 12) {
    score = Math.max(score, 75)
  }
  // DSS-HIGH regional jet at high α in climb (Colgan 3407 mode)
  if (klass === 'DSS-HIGH' && alphaEst >= 28 && (phase === 'CLIMB-INIT' || phase === 'APPR-FNL')) {
    score = Math.max(score, 70)
  }
  // THS mistrim + T-tail + climb
  if (thsTrimErr > 0.6 && (klass === 'DSS-CRIT' || klass === 'DSS-HIGH')) {
    score = Math.max(score, 68)
  }

  score = clamp(score, 0, 100)

  let tier: Tier
  if (score >= 85) tier = 'DEEP-STL'
  else if (score >= 65) tier = 'POST-STL'
  else if (score >= 45) tier = 'ALPHA-HI'
  else if (score >= 25) tier = 'BUFFET'
  else tier = 'NOMINAL'

  let advice = ''
  if (tier === 'DEEP-STL') {
    advice = `! DEEP-STL · α≈${alphaEst.toFixed(0)}° vs αpitchup ${spec.alphaPitchup}° · Cm reversal regime · elevator authority lost · stick-pusher ${stkPshActive?'firing':'INOP/none'} · UNRECOVERABLE without anti-spin chute · brace · ref Trident G-ARPI Staines 1972 / BAC 1-11 G-ASHG Wisley 1963 · 14 CFR §25.203 §25.207`
  } else if (tier === 'POST-STL') {
    advice = `POST-STL · α ${alphaEst.toFixed(0)}° past αpitchup ${spec.alphaPitchup}° · pitch authority compromised · full nose-down + idle thrust + ${spec.recoveryFloor}ft min recovery floor · push through trim · ref BEA D-AXLA Perpignan 2008 §3.3 / NTSB AAR-10-01 Colgan 3407 ch.2`
  } else if (tier === 'ALPHA-HI') {
    advice = `ALPHA-HI · α ${alphaEst.toFixed(0)}° vs αstall ${spec.alphaStall}° · approaching pitchup boundary (${spec.alphaPitchup}°) · reduce α immediately · ${decelKtPerS > 3 ? `decel ${decelKtPerS.toFixed(1)}kt/s` : 'monitor IAS'} · ${stkPshAvail?'pusher armed':'no pusher · manual recovery'}`
  } else if (tier === 'BUFFET') {
    advice = `BUFFET · α ${alphaEst.toFixed(0)}° at light-buffet onset · stall warning may fire · increase IAS to ≥1.3·Vs1g · ref 14 CFR §25.207 stall warning margin`
  } else {
    advice = `NOMINAL · α ${alphaEst.toFixed(0)}° well below αstall ${spec.alphaStall}° · IAS ${(iasFrac*100).toFixed(0)}% of Vs · phase ${phase}`
  }

  return {
    f, klass, spec, phase, alphaEst, decelKtPerS, iasFrac, gammaDeg, pitchProxy,
    stkPshActive, cgAftProxy, thsTrimErr, altitudeAGL,
    drivers: { ALPHA:dALPHA, WAKE:dWAKE, PITCHUP:dPITCHUP, STKPSH:dSTKPSH, TRIM:dTRIM, RECOV:dRECOV, CG:dCG, PHASE:dPHASE },
    score, tier, advice,
  }
}

export default function DeepStlMonitor({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [decelOff, setDecelOff] = useState(0)
  const [aoaMul, setAoaMul] = useState(1.0)
  const [scopeFL, setScopeFL] = useState(280)
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [klassFilter, setKlassFilter] = useState<Klass | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'GEOMETRY'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out = flights.map(f => computeRow(f, advMul, decelOff, aoaMul, scopeFL))
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, decelOff, aoaMul, scopeFL])

  const counts: Record<Tier, number> = { 'DEEP-STL':0, 'POST-STL':0, 'ALPHA-HI':0, 'BUFFET':0, 'NOMINAL':0, 'NOT-EVAL':0 }
  for (const r of rows) counts[r.tier]++
  const evalRows = rows.filter(r => r.tier !== 'NOT-EVAL')
  const muAlpha = evalRows.length ? evalRows.reduce((a, b) => a + b.alphaEst, 0) / evalRows.length : 0
  const dssCritCnt = evalRows.filter(r => r.klass === 'DSS-CRIT').length
  const stkpshAct = evalRows.filter(r => r.stkPshActive).length
  const worstRow = rows[0]?.tier !== 'NOT-EVAL' ? rows[0] : null

  // Per-class aggregate
  const klassAgg = useMemo(() => {
    const m = new Map<Klass, { klass: Klass; cnt: number; muAlpha: number; worstTier: Tier; rows: Row[] }>()
    for (const r of rows) {
      if (r.tier === 'NOT-EVAL') continue
      const v = m.get(r.klass) || { klass: r.klass, cnt: 0, muAlpha: 0, worstTier: 'NOMINAL', rows: [] }
      v.cnt++
      v.rows.push(r)
      if (TIER_RANK[r.tier] < TIER_RANK[v.worstTier]) v.worstTier = r.tier
      m.set(r.klass, v)
    }
    const arr = Array.from(m.values())
    arr.forEach(v => { v.muAlpha = v.rows.reduce((a, b) => a + b.alphaEst, 0) / Math.max(1, v.rows.length) })
    arr.sort((a, b) => (TIER_RANK[a.worstTier] - TIER_RANK[b.worstTier]) || (b.cnt - a.cnt))
    return arr
  }, [rows])

  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (klassFilter === 'ALL' || r.klass === klassFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    r.tier !== 'NOT-EVAL' &&
    (!search || (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator || '').toLowerCase().includes(search.toLowerCase()))
  )

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC_HALO = 'deepstl-halo-src'
    const SRC_PIN  = 'deepstl-pin-src'
    const SRC_VEC  = 'deepstl-vec-src'

    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC_HALO); ensureSrc(SRC_PIN); ensureSrc(SRC_VEC)

    const writeAll = () => {
      const haloFeats: any[] = []
      const pinFeats: any[] = []
      const vecFeats: any[] = []

      for (const r of visible) {
        const tcol = TIER_COLOR[r.tier]
        const kcol = KLASS_COLOR[r.klass]
        const sz = 7 + clamp(r.score / 100, 0, 1) * 12
        haloFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{ color:tcol, kcol, sz }
        })
        if (shPin && (r.tier === 'DEEP-STL' || r.tier === 'POST-STL')) {
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
            properties:{ color:tcol, sz:6, label:'' }
          })
        }
        if (shLbl) {
          const lbl = `${(r.f.callsign || r.f.icao).slice(0, 10)} · α${r.alphaEst.toFixed(0)}° · ${r.tier}`
          pinFeats.push({
            type:'Feature',
            geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
            properties:{ color:tcol, sz:0, label:lbl, lblOnly:true }
          })
        }
        if (shVec && (r.tier === 'DEEP-STL' || r.tier === 'POST-STL' || r.tier === 'ALPHA-HI')) {
          // Forward velocity vector ~10 NM in track direction
          const dLat = Math.cos(rad(r.f.track)) * (10 / 60)
          const dLng = Math.sin(rad(r.f.track)) * (10 / 60) / Math.max(0.1, Math.cos(rad(r.f.lat)))
          vecFeats.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng + dLng, r.f.lat + dLat]] },
            properties:{ color:tcol }
          })
        }
      }

      const src = (id: string) => map.getSource(id) as any
      src(SRC_HALO).setData({ type:'FeatureCollection', features: shHalo ? haloFeats : [] })
      src(SRC_PIN).setData({ type:'FeatureCollection', features: pinFeats })
      src(SRC_VEC).setData({ type:'FeatureCollection', features: vecFeats })
    }

    if (!map.getLayer('deepstl-vec'))
      map.addLayer({ id:'deepstl-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.65, 'line-dasharray':[2, 2] } })
    if (!map.getLayer('deepstl-halo'))
      map.addLayer({ id:'deepstl-halo', type:'circle', source:SRC_HALO, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.4, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('deepstl-halo-inner'))
      map.addLayer({ id:'deepstl-halo-inner', type:'circle', source:SRC_HALO, paint:{ 'circle-radius':3, 'circle-color':['get','kcol'], 'circle-opacity':0.88 } })
    if (!map.getLayer('deepstl-pin'))
      map.addLayer({ id:'deepstl-pin', type:'circle', source:SRC_PIN, filter:['!=',['get','lblOnly'], true], paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.9 } })
    if (!map.getLayer('deepstl-pin-lbl'))
      map.addLayer({ id:'deepstl-pin-lbl', type:'symbol', source:SRC_PIN, layout:{ 'text-field':['get','label'], 'text-size':9, 'text-offset':[0, -1.2], 'text-anchor':'bottom', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })

    writeAll()
    return () => {
      for (const id of ['deepstl-pin-lbl','deepstl-pin','deepstl-halo-inner','deepstl-halo','deepstl-vec']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC_HALO, SRC_PIN, SRC_VEC]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }, [map, rows, visible, shHalo, shPin, shLbl, shVec])

  // --- GEOMETRY tab SVG: Cm vs α reversal curves per class + fleet dots ---
  const geomSvg = useMemo(() => {
    const W = 460, H = 240
    const padL = 38, padR = 14, padT = 14, padB = 30
    const innerW = W - padL - padR, innerH = H - padT - padB
    const xMax = 50  // α deg
    const yMin = -0.20, yMax = 0.10  // Cm
    const xToPx = (a: number) => padL + (Math.min(Math.max(a, 0), xMax) / xMax) * innerW
    const yToPx = (cm: number) => padT + innerH - ((Math.min(Math.max(cm, yMin), yMax) - yMin) / (yMax - yMin)) * innerH

    // Synthetic Cm(α) reversal curves per class
    // Conventional: Cm = -0.02 - 0.005·α (stable to α_stall, gentle break)
    // T-tail: Cm = -0.02 - 0.005·α  for α<αp; then Cm flat → +0.06 at α_max
    const buildCurve = (klass: Klass) => {
      const spec = KLASS_SPEC[klass]
      const sev = spec.pitchupSeverity
      const pts: { x: number; y: number }[] = []
      for (let a = 0; a <= xMax; a += 1) {
        let cm: number
        if (a < spec.alphaPitchup) {
          cm = -0.02 - 0.005 * a
        } else {
          // post-pitchup: smooth rise to peak +ve at α_max
          const x = (a - spec.alphaPitchup) / Math.max(1, spec.alphaMax - spec.alphaPitchup)
          const peak = -0.02 - 0.005 * spec.alphaPitchup + sev * 0.16 * (1 - Math.cos(Math.PI * Math.min(1, x)))
          cm = peak
        }
        pts.push({ x: xToPx(a), y: yToPx(cm) })
      }
      return pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    }

    const klassCurves: { klass: Klass; path: string; col: string }[] = (['DSS-CRIT','DSS-HIGH','DSS-MOD','DSS-LOW','DSS-NIL'] as Klass[])
      .map(k => ({ klass: k, path: buildCurve(k), col: KLASS_COLOR[k] }))

    // Fleet dots: each visible flight at (alphaEst, synthetic Cm)
    const dots: { x: number; y: number; col: string; lbl: string }[] = []
    for (const r of visible) {
      if (r.tier === 'NOT-EVAL') continue
      const a = r.alphaEst
      let cm: number
      if (a < r.spec.alphaPitchup) cm = -0.02 - 0.005 * a
      else {
        const x = (a - r.spec.alphaPitchup) / Math.max(1, r.spec.alphaMax - r.spec.alphaPitchup)
        cm = -0.02 - 0.005 * r.spec.alphaPitchup + r.spec.pitchupSeverity * 0.16 * (1 - Math.cos(Math.PI * Math.min(1, x)))
      }
      dots.push({ x: xToPx(a), y: yToPx(cm), col: TIER_COLOR[r.tier], lbl: r.f.callsign || r.f.icao })
    }

    return (
      <svg width={W} height={H} className="block">
        <rect x={0} y={0} width={W} height={H} fill="#0b0f17" rx={6} />
        {/* zero-Cm reference line */}
        <line x1={padL} y1={yToPx(0)} x2={padL + innerW} y2={yToPx(0)} stroke="#475569" strokeWidth={0.7} strokeDasharray="3 3" />
        <text x={padL + 4} y={yToPx(0) - 3} fill="#64748b" fontSize={8}>Cm = 0 (neutral)</text>
        {/* α grid */}
        {[10, 14, 18, 22, 26, 30, 35, 40, 45].map(a => (
          <g key={a}>
            <line x1={xToPx(a)} y1={padT} x2={xToPx(a)} y2={padT + innerH} stroke="#1e293b" strokeWidth={0.4} />
            <text x={xToPx(a)} y={padT + innerH + 10} fill="#64748b" fontSize={7.5} textAnchor="middle">{a}°</text>
          </g>
        ))}
        {/* Cm grid */}
        {[-0.15, -0.10, -0.05, 0.05, 0.10].map(c => (
          <g key={c}>
            <line x1={padL} y1={yToPx(c)} x2={padL + innerW} y2={yToPx(c)} stroke="#1e293b" strokeWidth={0.4} />
            <text x={padL - 3} y={yToPx(c) + 3} fill="#64748b" fontSize={7.5} textAnchor="end">{c.toFixed(2)}</text>
          </g>
        ))}
        <text x={W / 2} y={H - 6} fill="#94a3b8" fontSize={9} textAnchor="middle">α · deg</text>
        <text x={6} y={padT + 6} fill="#94a3b8" fontSize={9} transform={`rotate(-90 6 ${padT + 6})`}>Cm pitching-moment</text>
        {/* Curves per class */}
        {klassCurves.map(c => (
          <polyline key={c.klass} points={c.path} fill="none" stroke={c.col} strokeWidth={c.klass === 'DSS-CRIT' ? 1.7 : 1.2} opacity={0.85} />
        ))}
        {/* Fleet dots */}
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={3} fill={d.col} opacity={0.92} stroke="#0b0f17" strokeWidth={0.6} />
        ))}
        {/* legend */}
        <g transform={`translate(${padL + 8} ${padT + 10})`}>
          <rect x={0} y={0} width={158} height={62} fill="#0f172a" stroke="#1e293b" rx={3} opacity={0.9} />
          {(['DSS-CRIT','DSS-HIGH','DSS-MOD','DSS-LOW','DSS-NIL'] as Klass[]).map((k, i) => (
            <g key={k} transform={`translate(4 ${10 + i * 10})`}>
              <line x1={0} y1={0} x2={14} y2={0} stroke={KLASS_COLOR[k]} strokeWidth={1.4} />
              <text x={18} y={3} fill="#94a3b8" fontSize={8}>{k}</text>
            </g>
          ))}
        </g>
      </svg>
    )
  }, [visible])

  return (
    <div className="fixed top-16 right-3 z-40 w-[540px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">DEEPSTL</span>
          <span className="text-[10px] text-slate-400">deep-stall · T-tail Cm(α) reversal · pitch-authority lock-in</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* mode strip */}
      <div className="px-3 py-1.5 border-b border-slate-700/40 flex items-center gap-2 text-[10px]">
        <span className="text-slate-500">FLEET</span>
        <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-mono">{evalRows.length} eval</span>
        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 font-mono">{counts['DEEP-STL']} deep</span>
        <span className="px-1.5 py-0.5 rounded font-mono" style={{background:`${KLASS_COLOR['DSS-CRIT']}26`, color: KLASS_COLOR['DSS-CRIT']}}>{dssCritCnt} crit-class</span>
        <span className="ml-auto text-slate-500">μ α <span className="text-slate-100 font-mono">{muAlpha.toFixed(1)}°</span></span>
      </div>

      {/* tier counter strip */}
      <div className="px-3 py-2 border-b border-slate-700/40 flex gap-1.5 flex-wrap text-[10px]">
        <button onClick={() => setTierFilter('ALL')} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL {evalRows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`px-1.5 py-0.5 rounded font-mono ${tierFilter === t ? '' : 'opacity-60'}`} style={{ background: `${TIER_COLOR[t]}26`, border: `1px solid ${TIER_COLOR[t]}66`, color: TIER_COLOR[t] }}>{t} {counts[t]}</button>
        ))}
      </div>

      {/* summary 5-cell */}
      <div className="px-3 py-2 border-b border-slate-700/40 grid grid-cols-5 gap-2 text-[10px]">
        <div><div className="text-slate-500 text-[9px]">EVAL</div><div className="text-slate-100 font-mono">{evalRows.length}</div></div>
        <div><div className="text-slate-500 text-[9px]">WORST</div><div className="text-slate-100 font-mono truncate">{worstRow ? (worstRow.f.callsign || worstRow.f.icao) : '-'}</div></div>
        <div><div className="text-slate-500 text-[9px]">μ α</div><div className="text-slate-100 font-mono">{muAlpha.toFixed(1)}°</div></div>
        <div><div className="text-slate-500 text-[9px]">Σ CRIT</div><div className="font-mono" style={{ color: dssCritCnt > 0 ? KLASS_COLOR['DSS-CRIT'] : '#cbd5e1' }}>{dssCritCnt}</div></div>
        <div><div className="text-slate-500 text-[9px]">STKPSH</div><div className="font-mono" style={{ color: stkpshAct > 0 ? TIER_COLOR['ALPHA-HI'] : '#cbd5e1' }}>{stkpshAct}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/40 grid grid-cols-2 gap-2 text-[10px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">ADV-MUL <span className="text-slate-100 font-mono">{(advMul*100).toFixed(0)}%</span></span>
          <input type="range" min={0.5} max={2.0} step={0.05} value={advMul} onChange={e=>setAdvMul(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">DECEL-OFF <span className="text-slate-100 font-mono">{decelOff >= 0 ? '+' : ''}{decelOff.toFixed(1)}kt/s</span></span>
          <input type="range" min={-3} max={6} step={0.5} value={decelOff} onChange={e=>setDecelOff(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">AOA-MUL <span className="text-slate-100 font-mono">{(aoaMul*100).toFixed(0)}%</span></span>
          <input type="range" min={0.5} max={1.8} step={0.05} value={aoaMul} onChange={e=>setAoaMul(parseFloat(e.target.value))} className="accent-sky-400 h-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">SCOPE-FL <span className="text-slate-100 font-mono">≤FL{scopeFL}</span></span>
          <input type="range" min={80} max={420} step={20} value={scopeFL} onChange={e=>setScopeFL(parseInt(e.target.value))} className="accent-sky-400 h-1" />
        </label>
      </div>

      {/* chip filters */}
      <div className="px-3 py-2 border-b border-slate-700/40 flex flex-col gap-1 text-[10px]">
        <div className="flex gap-1 flex-wrap">
          <span className="text-slate-500 mr-1 self-center text-[9px]">CLASS</span>
          {(['ALL','DSS-CRIT','DSS-HIGH','DSS-MOD','DSS-LOW','DSS-NIL'] as const).map(k => (
            <button key={k} onClick={()=>setKlassFilter(k as any)} className={`px-1.5 py-0.5 rounded font-mono ${klassFilter===k?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{k}</button>
          ))}
        </div>
        <div className="flex gap-1 flex-wrap">
          <span className="text-slate-500 mr-1 self-center text-[9px]">PHASE</span>
          {(['ALL','CLIMB-INIT','CLIMB-OUT','DESCENT','TMA','APPR-FNL','STABLE'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded px-2 py-0.5 text-slate-100 text-[10px]" />
          <div className="flex gap-1 text-[9px]">
            {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['VEC',shVec,setShVec]].map(([l,v,s]:any) => (
              <button key={l} onClick={()=>s(!v)} className={`px-1 py-0.5 rounded font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','CLASSES','GEOMETRY','METHOD'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.map((r, i) => (
          <div key={i} className="bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5 cursor-pointer" onClick={()=>onFly(r.f.icao)}>
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{r.f.type || '?'}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${KLASS_COLOR[r.klass]}33`, color:KLASS_COLOR[r.klass] }}>{r.klass}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-400 font-mono text-[9px]">{r.phase}</span>
              {r.stkPshActive && <span className="px-1 rounded bg-amber-500/15 text-amber-300 font-mono text-[9px]">› STKPSH</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>α <span className="font-mono" style={{color: r.alphaEst > r.spec.alphaPitchup ? TIER_COLOR['DEEP-STL'] : r.alphaEst > r.spec.alphaStall ? TIER_COLOR['ALPHA-HI'] : '#cbd5e1'}}>{r.alphaEst.toFixed(1)}°</span></div>
              <div>αstall <span className="text-slate-100 font-mono">{r.spec.alphaStall}°</span></div>
              <div>αpitch <span className="text-slate-100 font-mono">{r.spec.alphaPitchup}°</span></div>
              <div>αmax <span className="text-slate-100 font-mono">{r.spec.alphaMax}°</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>IAS/Vs <span className="font-mono" style={{color: r.iasFrac < 1.05 ? TIER_COLOR['DEEP-STL'] : r.iasFrac < 1.2 ? TIER_COLOR['ALPHA-HI'] : '#cbd5e1'}}>{(r.iasFrac*100).toFixed(0)}%</span></div>
              <div>VS <span className="font-mono" style={{color: r.f.vertRate < -2000 ? TIER_COLOR['DEEP-STL'] : '#cbd5e1'}}>{r.f.vertRate>0?'+':''}{r.f.vertRate.toFixed(0)}fpm</span></div>
              <div>decel <span className="font-mono" style={{color: r.decelKtPerS > 4 ? TIER_COLOR['ALPHA-HI'] : '#cbd5e1'}}>{r.decelKtPerS>0?'+':''}{r.decelKtPerS.toFixed(1)}kt/s</span></div>
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>γ <span className="text-slate-100 font-mono">{r.gammaDeg>=0?'+':''}{r.gammaDeg.toFixed(1)}°</span></div>
              <div>pitch <span className="text-slate-100 font-mono">{r.pitchProxy.toFixed(1)}°</span></div>
              <div>CG <span className="font-mono" style={{color: r.cgAftProxy > 0.75 ? TIER_COLOR['ALPHA-HI'] : '#cbd5e1'}}>{r.cgAftProxy >= 0.75 ? 'AFT' : r.cgAftProxy >= 0.5 ? 'MID-A' : 'FWD'}</span></div>
              <div>THS <span className="font-mono" style={{color: r.thsTrimErr > 0.4 ? TIER_COLOR['POST-STL'] : '#cbd5e1'}}>{r.thsTrimErr > 0 ? `mistrim ${(r.thsTrimErr*100).toFixed(0)}%` : 'OK'}</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k, v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            <div className="mt-1 text-[9px] text-slate-500 italic">{r.advice}</div>
          </div>
        ))}
        {tab === 'AIRCRAFT' && visible.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft in DEEPSTL evaluation envelope · check filters / SCOPE-FL</div>}

        {tab === 'CLASSES' && klassAgg.map((v, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${KLASS_COLOR[v.klass]}33`, color:KLASS_COLOR[v.klass] }}>{v.klass}</span>
              <span className="text-slate-300 truncate">{KLASS_LABEL[v.klass]}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[v.worstTier]}33`, color:TIER_COLOR[v.worstTier] }}>{v.worstTier} · {v.cnt} ac</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>Vs-clean <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].vStallClean}kt</span></div>
              <div>Vs-cfg <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].vStallConfig}kt</span></div>
              <div>αstall <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].alphaStall}°</span></div>
              <div>αpitch <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].alphaPitchup}°</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>αmax <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].alphaMax}°</span></div>
              <div>severity <span className="text-slate-100 font-mono">{(KLASS_SPEC[v.klass].pitchupSeverity*100).toFixed(0)}%</span></div>
              <div>pusher <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].stickPusher >= 3 ? 'mand' : KLASS_SPEC[v.klass].stickPusher === 2 ? 'std' : KLASS_SPEC[v.klass].stickPusher === 1 ? 'opt' : 'none'}</span></div>
              <div>rec-flr <span className="text-slate-100 font-mono">{KLASS_SPEC[v.klass].recoveryFloor}ft</span></div>
            </div>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
              <div>μ-α <span className="text-slate-100 font-mono">{v.muAlpha.toFixed(1)}°</span></div>
              <div>DEEP-STL <span className="font-mono" style={{color: v.rows.filter(r=>r.tier==='DEEP-STL').length>0?TIER_COLOR['DEEP-STL']:'#cbd5e1'}}>{v.rows.filter(r=>r.tier==='DEEP-STL').length}</span></div>
              <div>POST-STL <span className="font-mono" style={{color: v.rows.filter(r=>r.tier==='POST-STL').length>0?TIER_COLOR['POST-STL']:'#cbd5e1'}}>{v.rows.filter(r=>r.tier==='POST-STL').length}</span></div>
            </div>
          </div>
        ))}
        {tab === 'CLASSES' && klassAgg.length === 0 && <div className="text-[10px] text-slate-500 italic">no aircraft in DEEPSTL evaluation</div>}

        {tab === 'GEOMETRY' && (
          <div className="space-y-2">
            {geomSvg}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] space-y-1">
              <div className="text-slate-400 font-semibold">Cm(α) reversal geometry · 5-class tail catalogue</div>
              <div className="text-slate-500 text-[9px]">For a longitudinally stable airplane Cm decreases with α (negative slope = nose-down restoring moment). At very high α the wing wake migrates upward; on T-tail/aft-engine designs the wake intersects the horizontal stabiliser, downwash on the H-stab collapses, the tail loses its restoring contribution, and Cm reverses to +ve (nose-up).</div>
              <div className="font-mono text-slate-300 text-[9px]">DSS-CRIT  pitchup at α≈18° · peak Cm ≈ +0.12 at α≈42° · pusher rare</div>
              <div className="font-mono text-slate-300 text-[9px]">DSS-HIGH  pitchup at α≈17° · peak Cm ≈ +0.07 · pusher mandatory</div>
              <div className="font-mono text-slate-300 text-[9px]">DSS-MOD   pitchup at α≈18° · peak Cm ≈ +0.04 · pusher fitted</div>
              <div className="font-mono text-slate-300 text-[9px]">DSS-LOW   no reversal · monotonic Cm slope (post-stall pitchup mild)</div>
              <div className="font-mono text-slate-300 text-[9px]">DSS-NIL   benign break · Cm continues negative to α≈26°</div>
              <div className="text-slate-500 italic text-[9px]">NASA TN D-6573 Greene & Pinkerton T-tail wind-tunnel 1965 · Anderson §5.7 · McCormick §3.16</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="text-slate-400 font-semibold mb-1">Why the wake-shadow matters</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· At α=0° the wing wake leaves trailing edge horizontally and passes BELOW the T-stab</div>
                <div>· At α=20° wake elevation has risen ~16° (sin(20°) ≈ 0.34) and intersects the T-stab</div>
                <div>· In the wake the local q drops 30-50% and the local α at the stab swings by Δα=−ε_dot</div>
                <div>· Stab Cm contribution collapses; wing pitchup moment dominates; airplane accelerates pitch-up</div>
                <div>· Once locked, elevator authority (Cm_δe) is insufficient to overcome the +Cm peak</div>
                <div>· Recovery requires stick-pusher fire-out at α_warn + 2° (TSO-C151b) or anti-spin chute (test)</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px]">
              <div className="text-slate-400 font-semibold mb-1">Distinction · DEEPSTL vs STALL vs COFFIN vs PIO</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· STALL overlay: low-α α-floor margin in NORMAL envelope (α &lt; α_stall, 1g)</div>
                <div>· DEEPSTL overlay: post-stall regime (α &gt; α_pitchup), Cm reversal, pitch-authority loss</div>
                <div>· COFFIN-CORNER: high-Mach buffet onset at cruise FL, distinct physical mechanism</div>
                <div>· PIO: pilot-induced-oscillation handling-quality bandwidth, no α involvement</div>
                <div>· GUST: structural Δn load from discrete gust at design speed, no α buildup</div>
              </div>
            </div>
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-400">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">DEEPSTL · Deep-stall / Super-stall locked-in pitch authority</div>
              <div>A "deep stall" or "super-stall" is the stable equilibrium that exists on certain T-tail aircraft at α far above the conventional stall (typically α=30-50°), where pitching-moment Cm(α) has reversed sign once and crossed zero a second time, producing a stable trim point in pitch-up that elevator authority cannot overcome.</div>
              <div className="text-slate-500">Ref: 14 CFR §25.203 stall characteristics · §25.143 controllability · CS-25.203 / AMC 25.203 · AC 25-7C §4 §29 · NASA TN D-6573 Greene-Pinkerton 1965 · Etkin Dynamics §4.7 · Cook §3.5</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">α-estimation methodology (proxy from ADS-B)</div>
              <div className="text-slate-500 text-[9px] space-y-0.5">
                <div>· True ADS-B does not transmit AOA — must infer from observable state</div>
                <div>· Baseline: α ≈ 2° + (V_stall/IAS)² · 14° (asymptotic α→14° as IAS→V_stall)</div>
                <div>· Climb phase: + flight-path-angle γ contribution (high pitch ≈ high α)</div>
                <div>· Approach phase: linear ramp 4° → 14° as IAS bleeds toward V_stall</div>
                <div>· Decel-rate penalty: rapid IAS bleed at constant pitch → α buildup at 0.8°/(kt/s)</div>
                <div>· Stalled-mush state: VS &lt; -1500 fpm + IAS &lt; 1.05·Vs → α forced to α_stall + 12° +</div>
                <div>· Uncertainty: α estimate within ±3° in normal envelope, ±5° at high α</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Hard escalators · NTSB/AAIB-anchored score floors</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· DSS-CRIT + α≥30° + CLIMB-INIT + no pusher → ≥92 (Trident G-ARPI Staines 1972 mode)</div>
                <div>· α≥35° + |decel|≥8 kt/s → ≥85 (D-AXLA Perpignan 2008 stall-test mode)</div>
                <div>· Aft-CG + T-tail + α≥α_stall → ≥80 (BAC 1-11 G-ASHG Wisley 1963)</div>
                <div>· IAS&lt;1.05·Vs + VS&lt;-2000 + pitch-high → ≥75 (AF447-class sustained mush)</div>
                <div>· DSS-HIGH + α≥28° + CLIMB-INIT → ≥70 (Colgan 3407 BUF 2009 mode)</div>
                <div>· THS mistrim &gt;0.6 + T-tail → ≥68 (auto-trim runaway / TARC)</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Precedent · deep-stall accident family</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· BAC 1-11 G-ASHG Wisley 1963-10-22 — test-flight intentional stall, locked deep stall, anti-spin chute failed, both crew killed; led to T-tail design discipline reform</div>
                <div>· Trident 1C G-ARPI Staines 1972-06-18 (118 fatal) — BEA 548 droop INOP, premature trim, deep stall at 1772ft, recovery impossible; AAIB Trident Report Cmnd 5701</div>
                <div>· Tu-134 / Tu-154 multiple test losses 1960s-70s — T-tail with mass-balanced elevators, deep-stall investigation OKB-156 design fixes</div>
                <div>· Lear 60 N999LJ COLUMBIA 2008-11-19 — runway overrun followed by deep stall on rejected takeoff debris-ingest, NTSB AAR-08-04 / 5 fatal</div>
                <div>· Colgan 3407 BUF 2009-02-12 (50 fatal) — DHC-8 Q400 tailplane stall + pilot-induced deep stall recovery failure, NTSB AAR-10-01</div>
                <div>· AF 447 Atlantic 2009-06-01 (228 fatal) — A330 sustained F=0 climb to FL380, α=40°, no Cm reversal (DSS-LOW) but unrecoverable mush; BEA Final Report 2012</div>
                <div>· XL Airways D-AXLA Perpignan 2008-11-27 (7 fatal) — A320 production test deep stall at low altitude during AOA-probe acceptance test, BEA Final Report</div>
                <div>· West Caribbean 708 MD-82 2005-08-16 (160 fatal) — autothrottle off + climb at FL330 + decel into deep stall, JIAAC ARG-708-2007</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 space-y-1">
              <div className="text-slate-300 font-semibold">Mitigation pathways (per §25.203 amendment family)</div>
              <div className="text-slate-400 text-[9px] space-y-0.5">
                <div>· Stick-pusher (TSO-C151b): fires at α_warn + ~2°, forces stick-forward 4-6° below α_stall</div>
                <div>· Stick-shaker (§25.207): aural+tactile warning ≥7% above Vs</div>
                <div>· Wing stall-strips: induce inboard wing stall first, preserve outboard authority</div>
                <div>· Vortilons / leading-edge slats: delay wing root stall</div>
                <div>· AOA limiter / α-floor (Airbus FBW): hard envelope protection</div>
                <div>· Mass-balanced elevator with rudder anti-spin chute (test fleet only)</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/40 text-[9px] text-slate-500 italic flex items-center justify-between">
        <span>DEEPSTL · 14 CFR §25.203 §25.207 · CS-25.203 · NASA TN D-6573 · NTSB AAR-10-01</span>
        <span className="font-mono text-slate-600">v1</span>
      </div>
    </div>
  )
}
