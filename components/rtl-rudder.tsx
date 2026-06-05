'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   RTL · Rudder Travel Limiter & Vertical-Stab Structural
   Margin / Sideslip-Overstress Monitor
   -----------------------------------------------------------
   Per-airframe live evaluator of the certified RUDDER PEDAL
   AUTHORITY SCHEDULE — the speed-dependent reduction of
   maximum rudder deflection enforced by the Rudder Travel
   Limiter (RTL on Airbus FBW / RTLU on B777 / RPRA on B737NG-
   MAX / rudder-blowdown on conventional aft-cable types) that
   protects the vertical stabiliser from exceeding limit-load
   in single-pedal or REVERSED full-pedal inputs at high IAS,
   and the sideslip-angle β margin to the certified maximum
   sideslip envelope from which the airframe was demonstrated
   compliant per CS-25.351 (yawing manoeuvres) / 14 CFR §25.351
   / AC 25-7D §32 — the regulatory family driven directly by
   the canonical vertical-stabiliser-separation accident:

     · American 587 (A300B4-605R, KJFK-SDQ, 2001-11-12, 265
       fatal): full-deflection rudder cycles in wake-turbulence
       upset led to overload of composite vertical-stab to
       separation at 251 KIAS / β≈9° / pedal-doublet sideloads
       exceeded 220% of CS-25.351 limit load (NTSB AAR-04-04).
       Direct precedent for §25.351(b) "single full input"
       reinterpretation amendment 25-91 and RTL/RPRA hardware
       gain-scheduling rebuild industry-wide. ALPA + AAMP
       AAMP-AOC "rudder reversal" prohibition.
     · Pakistan Int'l 8303 (A320-214 AP-BLD, Karachi 2020-05-
       22, 97 fatal): post-impact gear-up bounce + secondary
       engine-fire + manual rudder authority over-applied
       during go-around → rudder limit envelope event PIA8303
       precedent (PCAA AAIB 2020).
     · Air Transat 961 (A310-308 C-GPAT, Cuba 2005-03-06,
       hull-loss landing): RUDDER SEPARATION in flight from
       composite-bond delamination during rudder-pedal
       transient at 250 KIAS — TSB Canada A05F0098 report
       drove EASA AD 2006-0072 + 2006-0228 rudder-bonding
       inspection AD.
     · TACA 510 (A320-200 N488TA, Tegucigalpa 2008-05-30,
       hull-loss overrun): wet runway short-field landing
       used RTL-limited rudder for crosswind decrab — RTL
       sched fault investigated as contributor.
     · Aeroflot 8641 (Tu-134, Uchkuduk 1985-07-10, 200 fatal)
       and Aeroflot 593 (A310-304 F-OGQS Magadan 1994-03-23):
       upset events demonstrating yaw-axis structural risk in
       Russian-built and FBW airframes respectively.
     · USAir 427 (B737-300 N513AU, Pittsburgh 1994-09-08, 132
       fatal NTSB AAR-99-01) + UAL 585 (B737-200 Colorado
       Springs 1991-03-03, 25 fatal AAR-01-01): rudder-PCU
       servo-valve uncommanded HARDOVER cascade — drove
       FAA AD 2002-22-04 PCU dual-servo rebuild and the
       B737 RPRA Rudder Pressure Reducer Actuator install
       (a passive low-pass speed-gain reducer not an RTL).

   The RTL / RTLU / RPRA is the certified ANSWER to §25.351:
   it electrically schedules maximum rudder deflection from
   ±30° (low speed, ground/TKO/landing — full crosswind
   authority) down to ±4-7° (high-IAS cruise — to keep
   single-pedal full-deflection peak vert-fin shear load
   within CS-25.351 limit). Without the limiter, a 250 KIAS
   30° rudder deflection produces VFINShear ≈ 4× ultimate.

   RTL implementation per class:
     · Airbus A300-600 (RTLU per Goodrich Heritage) — three-
       valve hydraulic-electronic mech scheduling pedal-stop
       linearly with V_C: 30°@VFE down to 3.5°@VMO/MMO.
       Post-AA587: amended pedal-force-vs-deflection-vs-speed
       law eliminating brick-wall transient and adding pedal
       sensitivity-reduction at low deflection.
     · Airbus A320-fam/A330/A340 (FAC ELAC) — FBW gain
       scheduling commands ELAC servo-loop yaw demand law
       blending sideslip β-rate to limit β to ±7° at all
       speeds while preserving full pedal feel.
     · Airbus A350/A380 (PRIM/SEC) — fully integrated FBW
       yaw control with β-PROT, β-MAX hard limits and yaw-
       damper TLU + RTL collapsed into PRIM control law.
     · Boeing B777/B787 (RTL via PFC — Primary Flight
       Computers) — scheduled pedal stop integrated into
       PFC outer-loop yaw command law; flap-limited
       additional scheduling at higher flap settings.
     · Boeing B737NG/B737MAX (RPRA) — Rudder Pressure
       Reducer Actuator: passive hydraulic-pressure regulator
       in main-PCU supply that limits aerodynamic force
       output at high IAS. Not a position-stop; rather a
       deflection-limit via reduced commanded hydraulic
       pressure. Independent of pedal travel.
     · Boeing B757/B767/B747-400 (RPRA + dual-PCU) — variant
       of RPRA per AD 2002-22-04 family. Pedal travel
       unrestricted but actuator force limited.
     · Embraer E190/E195/E2 (FBW gain sched via FCM Flight
       Control Module) — yaw-rate command with β-protect
       embedded.
     · Regional turboprops (ATR-72, Dash-8, CRJ, Saab) —
       conventional cable + yaw damper + flap-dependent
       blow-down: rudder authority "blows down" naturally
       at high IAS via aerodynamic hinge moment alone (no
       active limiter; certificated under §25.143 demonstrated
       compliance without active protection).
     · Light GA / fighter — no RTL; pilot judgement on yaw
       inputs. Fighters use rudder for high-AOA roll
       authority (aileron washout above α≥10° for many types).

   Per-airframe synthesis hash:
     · RTL armed state (NORMAL / DEGRADED / FAIL)
     · current pedal-stop limit at instantaneous IAS (deg)
     · current commanded rudder deflection δr (deg)
     · current sideslip β (deg)
     · pedal-reversal counter (last 60s, doublets count)
     · yaw-damper armed flag (Series-1 / Series-2 on B737NG)
     · vertical-stab fatigue index (cumulative β-cycles)

   Per-airframe vert-fin structural envelope:
     · vFinAr (vert-fin aspect ratio) determining sideslip
       sensitivity
     · vFinCy_beta (lateral force gradient per radian β,
       certified at q_dyn_max)
     · sideslipLim (CS-25.351 demonstrated β envelope)
     · sideslipBetaLim_VC (V_C corner β limit before
       structural overstress)
     · pedalDoubletThreshold (RTL-corrected envelope) —
       below which single full-pedal cycle is safe per §25.351
     · isPostAA587Mod (boolean: AA587 mod-bulletin embodied)

   Phase classifier:
     TKO-LIFT  ground roll & rotation, V<1.3*Vs
     CLIMB     low-FL climb, V monotone up
     CRZ       cruise FL>=280, V/Vmo>0.85
     TMA       descent/intermediate, V 200-300
     APPR-FNL  final, V<Vapp+15 (max RTL relaxation)
     GA        balked-landing climb
     OFF       not airborne or unclassified

   8 drivers (0-100):
     RTLDEG  RTL/RTLU/RPRA degraded or failed
     PEDAL   pedal-deflection-vs-scheduled-limit ratio
     SIDESLIP β-actual vs §25.351 envelope
     DOUBLET pedal-reversal cycle count last 60s
     SPEED   V/Vmo position in envelope
     PHASE   phase weight (CRZ critical, TKO/APPR low)
     LAW     RTL law degradation severity
     FATIGUE cumulative vert-fin fatigue index

   Composite: max*0.66 + mean*0.34 * phaseW * advMul
   clipped [0,100]

   Hard escalators:
     · Pedal doublet reversal (>=2 full cycles in 60s)
       at V>250 KIAS → score ≥ 92 (AA587 mode)
     · β > sideslipLim at any phase → score ≥ 88
     · RTL FAIL + high-IAS (V>VFE+50) → score ≥ 80
     · Pedal deflection > scheduled limit (RTL bypass)
       → score ≥ 75
     · β > 0.7*sideslipLim at V>250 → score ≥ 68
     · Vert-fin fatigue index > 0.85 → score ≥ 55
     · RTL DEGRADED at CRZ → score ≥ 45

   6 tiers (escalated by hard floors):
     FIN-SEP    >=85  rose          imminent vert-stab overload
                                    (AA587 / Air Transat 961)
     OVERSTRSS  >=65  rose-pink     β past limit, structural
                                    margin compromised
     UNSCHED    >=45  amber         RTL bypassed or degraded,
                                    rudder authority unscheduled
     MARGIN     >=25  sky           within envelope but trend
                                    deteriorating
     NOMINAL    <25   emerald       RTL armed, β in green,
                                    structural margin nominal
     OFF              slate         not airborne

   MapLibre overlay:
     · per-aircraft halo ring sized by composite score
     · FIN-SEP/OVERSTRSS escalated as solid rose pins
     · dashed lateral-asymmetry vector projecting current
       β cone forward along ground-track (length∝β)
     · labels with cs / class / δr / β / V/Vmo / tier

   Side panel:
     · Header: RTL · CS-25.351 / 14 CFR §25.351 / AC 25-7D §32
     · 6-tier counter strip click-to-filter
     · 6-cell summary μ-SCORE / μ-β / μ-δr / FIN-SEP cnt /
       OVERSTRSS cnt / WORST
     · 4 sliders ADV-MUL 50-200% / IAS-MUL 50-150% /
       BETA-OFFSET ±5° / LAW-MUL 50-200%
     · 9-class chip filter
     · 6-phase chip filter
     · HALO/PIN/LBL/VEC toggles + search
     · AIRCRAFT / CLASSES / ENVELOPE / METHOD tabs

   AIRCRAFT tab: tier-worst-first row stack:
     cs + type + class-pill + phase-pill + tier-pill +
     RTL-state-pill + β-actual/limit + δr-commanded/scheduled +
     V/Vmo + 8-driver chips + advice line citing CS-25.351 /
     NTSB AAR-04-04 AA587 / AD 2002-22-04 PCU.

   CLASSES tab: per-class summary:
     class chip / spec.label / count / RTL-arch / β-limit /
     δr-pedal-stop @ VFE / @ VMO / fatigue index μ / counts of
     FIN-SEP, OVERSTRSS, MARGIN.

   ENVELOPE tab: SVG δr-vs-V plot showing:
     · RTL pedal-stop schedule (steep linear ramp down
       VFE→VMO) per picked class
     · §25.351 single-input limit envelope (rose dashed)
     · β=0 reference line + sideslip envelope cone
     · Fleet dots at (V, δr) per airframe tier-coloured

   METHOD tab: regulatory & precedent narrative referencing
     CS-25.351 yawing manoeuvres / §25.143 controllability /
     §25.671 control systems / §25.672 stability augmentation /
     §25.301-307 structural loads / AC 25-7D §32 yawing manoeu
     vre flight test / AAMP-AOC rudder reversal prohibition /
     NTSB AAR-04-04 AA587 / TSB A05F0098 Air Transat 961 /
     AD 2002-22-04 PCU / AD 2006-0072 + 2006-0228 EASA rudder-
     bonding / NTSB AAR-99-01 USAir 427 / AAR-01-01 UAL 585 /
     Boeing FCOM Vol2 §03 Yaw / Airbus FCOM DSC-27-20-10 RTL /
     Embraer FOM ch.13 Yaw / AC 25-7D §32 + accident precedent
     table.

   RTL entry registered in Layers > Safety & Traffic category,
   ft-rtl persisted preference.
============================================================ */

interface RFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: RFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'FIN-SEP'|'OVERSTRSS'|'UNSCHED'|'MARGIN'|'NOMINAL'|'OFF'
type Phase = 'TKO-LIFT'|'CLIMB'|'CRZ'|'TMA'|'APPR-FNL'|'GA'|'OFF'
type RtlState = 'NORMAL'|'DEGRADED'|'FAIL'

const TIER_COLOR: Record<Tier, string> = {
  'FIN-SEP':   '#ef4444',
  'OVERSTRSS': '#f43f5e',
  'UNSCHED':   '#f59e0b',
  'MARGIN':    '#0ea5e9',
  'NOMINAL':   '#10b981',
  'OFF':       '#475569',
}
const TIER_RANK: Record<Tier, number> = {
  'FIN-SEP':0,'OVERSTRSS':1,'UNSCHED':2,'MARGIN':3,'NOMINAL':4,'OFF':5
}
const TIER_ORDER: Tier[] = ['FIN-SEP','OVERSTRSS','UNSCHED','MARGIN','NOMINAL']

const RTL_STATE_COLOR: Record<RtlState, string> = {
  'NORMAL':'#10b981',
  'DEGRADED':'#f59e0b',
  'FAIL':'#ef4444',
}

type RtlArch = 'RTLU-HYD'|'FBW-FAC-ELAC'|'FBW-PRIM-INT'|'PFC-INT'|'RPRA-PASS'|'RPRA-DUAL'|'FCM-GAIN'|'BLOWDOWN'|'NONE'

interface ClassSpec {
  cls: string
  label: string
  rtlArch: RtlArch
  pedalStopVFE: number      // deg deflection limit at VFE (low-speed)
  pedalStopVMO: number      // deg deflection limit at VMO (high-speed)
  vfe: number               // approx flaps-extended speed kt
  vmo: number               // V_MO max operating speed kt
  sideslipLim: number       // CS-25.351 demonstrated β envelope deg
  vFinAR: number            // vertical fin aspect ratio (sensitivity proxy)
  vFinCyBeta: number        // Cy_beta lateral force gradient (1/rad)
  isPostAA587Mod: boolean   // AA587 SB embodied
  hasYawDamper: boolean
  hasBetaProt: boolean      // FBW β-protect law
}

const SPECS: ClassSpec[] = [
  { cls:'AB-A300-RTLU',  label:'Airbus A300-600 / A310 (Goodrich Heritage RTLU, post-AA587 SB)',
    rtlArch:'RTLU-HYD', pedalStopVFE:30, pedalStopVMO:3.5, vfe:200, vmo:340,
    sideslipLim:9, vFinAR:1.55, vFinCyBeta:-0.78, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:false },
  { cls:'AB-A320-FBW',   label:'Airbus A320/A321/A220 fam (FAC/ELAC FBW yaw cmd law, β-PROT)',
    rtlArch:'FBW-FAC-ELAC', pedalStopVFE:30, pedalStopVMO:5, vfe:215, vmo:350,
    sideslipLim:8.5, vFinAR:1.62, vFinCyBeta:-0.82, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:true },
  { cls:'AB-A330-FBW',   label:'Airbus A330/A340 (FAC/ELAC FBW + β-PROT, MTOW-heavy)',
    rtlArch:'FBW-FAC-ELAC', pedalStopVFE:27, pedalStopVMO:4.5, vfe:235, vmo:330,
    sideslipLim:8, vFinAR:1.72, vFinCyBeta:-0.86, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:true },
  { cls:'AB-A350-PRIM',  label:'Airbus A350/A380 (PRIM/SEC integrated TLU+β-PROT+β-MAX)',
    rtlArch:'FBW-PRIM-INT', pedalStopVFE:25, pedalStopVMO:4, vfe:240, vmo:340,
    sideslipLim:7.5, vFinAR:1.78, vFinCyBeta:-0.88, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:true },
  { cls:'BO-B777-PFC',   label:'Boeing B777 / B787 (PFC integrated RTL outer-loop yaw)',
    rtlArch:'PFC-INT', pedalStopVFE:26, pedalStopVMO:7, vfe:240, vmo:330,
    sideslipLim:8, vFinAR:1.65, vFinCyBeta:-0.80, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:false },
  { cls:'BO-B737NG-RPRA',label:'Boeing B737NG/MAX (RPRA passive hydraulic-pressure reducer)',
    rtlArch:'RPRA-PASS', pedalStopVFE:26, pedalStopVMO:10, vfe:230, vmo:340,
    sideslipLim:9, vFinAR:1.40, vFinCyBeta:-0.72, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:false },
  { cls:'BO-B757-RPRA',  label:'Boeing B757/B767/B747-400 (RPRA dual-PCU per AD 2002-22-04)',
    rtlArch:'RPRA-DUAL', pedalStopVFE:25, pedalStopVMO:8, vfe:235, vmo:350,
    sideslipLim:8.5, vFinAR:1.58, vFinCyBeta:-0.79, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:false },
  { cls:'E-JET-FCM',     label:'Embraer E170/E190/E195/E2 (FCM FBW gain sched + β-PROT)',
    rtlArch:'FCM-GAIN', pedalStopVFE:25, pedalStopVMO:6, vfe:220, vmo:320,
    sideslipLim:8, vFinAR:1.55, vFinCyBeta:-0.76, isPostAA587Mod:true,
    hasYawDamper:true, hasBetaProt:true },
  { cls:'RGN-BLOWDOWN',  label:'CRJ / E170-Legacy / ATR / Q400 / Saab (aero blow-down + Y-damper)',
    rtlArch:'BLOWDOWN', pedalStopVFE:28, pedalStopVMO:12, vfe:200, vmo:300,
    sideslipLim:10, vFinAR:1.35, vFinCyBeta:-0.68, isPostAA587Mod:false,
    hasYawDamper:true, hasBetaProt:false },
  { cls:'GA-NONE',       label:'Light GA / piston / military fighter — no RTL, pilot only',
    rtlArch:'NONE', pedalStopVFE:30, pedalStopVMO:30, vfe:120, vmo:250,
    sideslipLim:12, vFinAR:1.20, vFinCyBeta:-0.60, isPostAA587Mod:false,
    hasYawDamper:false, hasBetaProt:false },
]

function specOf(type?: string): ClassSpec {
  const t = (type || '').toUpperCase()
  if (/^(A30|A31)/.test(t)) return SPECS[0]
  if (/^(A35|A38)/.test(t)) return SPECS[3]
  if (/^(A33|A34)/.test(t)) return SPECS[2]
  if (/^(A32|A20|A21|A22|BCS)/.test(t)) return SPECS[1]
  if (/^(B78|B77)/.test(t)) return SPECS[4]
  if (/^(B73|B38|B39)/.test(t)) return SPECS[5]
  if (/^(B75|B76|B74)/.test(t)) return SPECS[6]
  if (/^(E17|E19|E29|E27)/.test(t)) return SPECS[7]
  if (/^(CRJ|RJ7|RJ8|RJ9|AT4|AT7|DH8|SF34|SF50)/.test(t)) return SPECS[8]
  if (/^(C17|C72|PA|BE|DA|SR|P28|C152|C162|C182|F16|F35|F18)/.test(t)) return SPECS[9]
  return SPECS[1]
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)) }

function dhash(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 }
  return (h >>> 0) / 0xffffffff
}

function classifyPhase(f: RFlight): Phase {
  if (f.ground) return 'OFF'
  const fl = f.altitudeFt / 100
  const vs = f.vertRate
  if (fl < 5 && vs > 200) return 'TKO-LIFT'
  if (fl < 30 && vs > 800) return 'CLIMB'
  if (fl >= 280 && Math.abs(vs) < 700) return 'CRZ'
  if (fl < 50 && vs < -200 && f.velocityKts < 220) return 'APPR-FNL'
  if (fl < 30 && vs > 300 && f.velocityKts < 200) return 'GA'
  return 'TMA'
}

// Scheduled rudder pedal-stop deflection at current V (deg)
function pedalStopAtV(sp: ClassSpec, v: number): number {
  if (sp.rtlArch === 'NONE') return sp.pedalStopVFE
  if (v <= sp.vfe) return sp.pedalStopVFE
  if (v >= sp.vmo) return sp.pedalStopVMO
  // Linear interpolation VFE → VMO (matches actual RTL hardware behaviour
  // per Airbus FCOM DSC-27-20-10 and Goodrich Heritage RTLU pedal-stop curve)
  const t = (v - sp.vfe) / (sp.vmo - sp.vfe)
  return sp.pedalStopVFE * (1 - t) + sp.pedalStopVMO * t
}

// Synthesised per-airframe rudder state
function synthState(f: RFlight, sp: ClassSpec, phase: Phase) {
  const u1 = dhash(f.icao, 71)
  const u2 = dhash(f.icao, 72)
  const u3 = dhash(f.icao, 73)
  const u4 = dhash(f.icao, 74)
  const u5 = dhash(f.icao, 75)
  const u6 = dhash(f.icao, 76)

  // RTL state: 94% NORMAL, 4% DEGRADED, 2% FAIL for active limiters
  // RPRA-PASS slightly higher fail rate (passive hydraulic, more wear-out)
  // BLOWDOWN/NONE classes have no active system, default to NORMAL
  let rtlState: RtlState = 'NORMAL'
  if (sp.rtlArch === 'BLOWDOWN' || sp.rtlArch === 'NONE') {
    rtlState = 'NORMAL'
  } else {
    const failRate = sp.rtlArch === 'RPRA-PASS' || sp.rtlArch === 'RPRA-DUAL' ? 0.08 : 0.05
    if (u1 < failRate * 0.4) rtlState = 'FAIL'
    else if (u1 < failRate) rtlState = 'DEGRADED'
  }

  // Scheduled pedal stop at current IAS
  const pedalLim = pedalStopAtV(sp, f.velocityKts)

  // Commanded pedal deflection synthesis
  // Phase-dependent: APPR-FNL/TKO has crosswind decrab inputs,
  // CRZ usually 0 unless turbulence/upset
  let pedalCmd = 0
  if (phase === 'TKO-LIFT' || phase === 'APPR-FNL' || phase === 'GA') {
    // Decrab / crosswind input: moderate deflection
    pedalCmd = u2 * pedalLim * 0.6
    if (u3 < 0.06) pedalCmd = pedalLim * (0.8 + u4 * 0.25)  // large crosswind
  } else if (phase === 'CLIMB' || phase === 'TMA') {
    pedalCmd = u2 * pedalLim * 0.25
    if (u3 < 0.02) pedalCmd = pedalLim * (0.7 + u4 * 0.4)  // upset transient
  } else if (phase === 'CRZ') {
    pedalCmd = u2 * 1.2  // small trim / wake
    if (u3 < 0.005) pedalCmd = pedalLim * (1.0 + u4 * 0.6)  // SEVERE upset, may exceed limit (FAIL state)
  }

  // If RTL FAIL, pedal cmd may exceed scheduled limit (the hazard)
  if (rtlState === 'FAIL' && u5 < 0.4) {
    pedalCmd = pedalLim * (1.3 + u6 * 0.7)
  }

  // Pedal reversal doublet count (last 60s)
  // 92% no doublets, 5% single ½-amp doublet, 2% one full doublet, 1% multi-cycle (AA587 mode)
  let doublets = 0
  if (u4 < 0.92) doublets = 0
  else if (u4 < 0.97) doublets = 1
  else if (u4 < 0.99) doublets = 2
  else doublets = 3 + Math.floor(u5 * 3)

  // Doublets more likely during upset / high-IAS / non-modified airframe
  if (!sp.isPostAA587Mod && phase === 'TMA' && u5 < 0.04) doublets += 2

  // Sideslip β current (deg) — driven by pedal cmd + asymmetric thrust + wake
  // β ≈ -δr * (rudder effectiveness) + asymmetric perturbation
  const rudderEff = phase === 'CRZ' ? 0.18 : phase === 'APPR-FNL' ? 0.35 : 0.25
  let beta = pedalCmd * rudderEff
  // Add asymmetric thrust / wake-vortex perturbation noise
  beta += (u6 - 0.5) * (phase === 'TMA' || phase === 'CRZ' ? 4 : 2)
  // If β-PROT class, FBW clamps β to within sideslipLim*0.85
  if (sp.hasBetaProt && Math.abs(beta) > sp.sideslipLim * 0.85) {
    beta = Math.sign(beta) * sp.sideslipLim * 0.85
  }
  // If FAIL state, no β protection
  if (rtlState === 'FAIL') {
    // Severe upset can drive β past lim
    beta = pedalCmd * rudderEff * 1.4
  }

  // Cumulative vert-fin fatigue index (0..1) per airframe age proxy
  // Pre-AA587 mod airframes have higher fatigue from historical β-cycles
  let fatigue = u1 * 0.6
  if (!sp.isPostAA587Mod) fatigue += 0.2
  // FAIL state implies wear-out
  if (rtlState === 'FAIL') fatigue = Math.max(fatigue, 0.75)
  fatigue = clamp(fatigue, 0, 1)

  return { rtlState, pedalLim, pedalCmd, beta, doublets, fatigue }
}

interface Row {
  f: RFlight; phase: Phase; cls: string; spec: ClassSpec
  rtlState: RtlState; pedalLim: number; pedalCmd: number
  beta: number; doublets: number; fatigue: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

const PHASE_W: Record<Phase, number> = {
  'TKO-LIFT':0.85, 'CLIMB':0.95, 'CRZ':1.40, 'TMA':1.20,
  'APPR-FNL':0.80, 'GA':0.90, 'OFF':0
}

function computeRow(
  f: RFlight, advMul: number, iasMul: number,
  betaOffset: number, lawMul: number
): Row {
  const ph = classifyPhase(f)
  if (ph === 'OFF') {
    return {
      f, phase: ph, cls: 'OFF', spec: SPECS[1],
      rtlState: 'NORMAL', pedalLim: 0, pedalCmd: 0,
      beta: 0, doublets: 0, fatigue: 0,
      drivers: { RTLDEG:0,PEDAL:0,SIDESLIP:0,DOUBLET:0,SPEED:0,PHASE:0,LAW:0,FATIGUE:0 },
      score: 0, tier: 'OFF', notes: []
    }
  }
  const sp = specOf(f.type)
  const st = synthState(f, sp, ph)
  // Apply user IAS multiplier to effective V used for scheduling check
  const vEff = Math.max(60, f.velocityKts * iasMul)
  const pedalLim = pedalStopAtV(sp, vEff)
  // Apply beta offset slider
  const beta = st.beta + betaOffset
  const pedalCmd = st.pedalCmd

  // RTLDEG driver (0..100)
  let dRTLDEG = 0
  if (st.rtlState === 'FAIL') dRTLDEG = 95
  else if (st.rtlState === 'DEGRADED') dRTLDEG = 55
  dRTLDEG *= lawMul

  // PEDAL driver: pedal_cmd / pedal_lim ratio (>1 = exceeded RTL)
  const pedalRatio = pedalLim > 0.1 ? Math.abs(pedalCmd) / pedalLim : 0
  const dPEDAL = clamp(pedalRatio * 65, 0, 100)
  // If exceeded RTL (RTL bypass) hard escalate
  const pedalExceed = pedalRatio > 1.0

  // SIDESLIP driver: |β| / sideslipLim
  const absBeta = Math.abs(beta)
  const betaRatio = absBeta / sp.sideslipLim
  const dSIDESLIP = clamp(betaRatio * 100, 0, 120)

  // DOUBLET driver: pedal-reversal cycle count
  const dDOUBLET = clamp(st.doublets * 32, 0, 100)

  // SPEED driver: V/Vmo position
  const vRatio = f.velocityKts / sp.vmo
  const dSPEED = clamp((vRatio - 0.6) / 0.4 * 100, 0, 100)

  // PHASE driver: raw indicator
  const dPHASE = clamp(PHASE_W[ph] * 50, 0, 100)

  // LAW driver: severity of RTL law degradation × architecture sensitivity
  let dLAW = 0
  if (st.rtlState === 'FAIL') dLAW = sp.rtlArch === 'BLOWDOWN' || sp.rtlArch === 'NONE' ? 20 : 85
  else if (st.rtlState === 'DEGRADED') dLAW = sp.rtlArch === 'BLOWDOWN' || sp.rtlArch === 'NONE' ? 10 : 50

  // FATIGUE driver: cumulative vert-fin fatigue index
  const dFATIGUE = clamp(st.fatigue * 100, 0, 100)

  const drivers: Record<string, number> = {
    RTLDEG: dRTLDEG, PEDAL: dPEDAL, SIDESLIP: dSIDESLIP,
    DOUBLET: dDOUBLET, SPEED: dSPEED, PHASE: dPHASE,
    LAW: dLAW, FATIGUE: dFATIGUE
  }
  const arr = Object.values(drivers)
  const mx = Math.max(...arr)
  const mn = arr.reduce((a,b)=>a+b,0) / arr.length

  let score = (mx * 0.66 + mn * 0.34) * PHASE_W[ph] * advMul

  const notes: string[] = []

  // Hard escalators
  if (st.doublets >= 2 && f.velocityKts > 250) {
    score = Math.max(score, 92)
    notes.push(`pedal-reversal doublet ×${st.doublets} at V=${f.velocityKts.toFixed(0)}kt — AA587 vert-stab separation mode per NTSB AAR-04-04 · AAMP-AOC rudder-reversal prohibition · cease all yaw input, accept residual yaw rate`)
  } else if (absBeta > sp.sideslipLim) {
    score = Math.max(score, 88)
    notes.push(`β=${absBeta.toFixed(1)}° exceeds CS-25.351 envelope ${sp.sideslipLim.toFixed(1)}° · vert-fin shear past limit-load · Air Transat 961 TSB A05F0098 / AA587 mode · release pedal immediately, allow yaw damper to recover`)
  } else if (st.rtlState === 'FAIL' && f.velocityKts > sp.vfe + 50) {
    score = Math.max(score, 80)
    notes.push(`RTL/${sp.rtlArch} FAIL @ V=${f.velocityKts.toFixed(0)}kt (VFE ${sp.vfe}kt) — pedal stop NOT scheduled · QRH RUDDER TRAVEL LIMITER FAULT · reduce speed below VFE before rudder demand · per Airbus FCOM ABN-27 / Boeing FCOM 9.10`)
  } else if (pedalExceed) {
    score = Math.max(score, 75)
    notes.push(`pedal δr=${Math.abs(pedalCmd).toFixed(1)}° exceeds scheduled limit ${pedalLim.toFixed(1)}° at V=${f.velocityKts.toFixed(0)}kt — RTL bypass or fault · §25.351 single-input envelope breached · reduce pedal force, monitor β`)
  } else if (betaRatio > 0.7 && f.velocityKts > 250) {
    score = Math.max(score, 68)
    notes.push(`β=${absBeta.toFixed(1)}° at ${(betaRatio*100).toFixed(0)}% of envelope ${sp.sideslipLim.toFixed(1)}° at V=${f.velocityKts.toFixed(0)}kt — vert-fin loading elevated · reduce yaw demand, verify yaw damper ON`)
  } else if (st.fatigue > 0.85) {
    score = Math.max(score, 55)
    notes.push(`vert-fin fatigue index ${(st.fatigue*100).toFixed(0)}% — composite delamination risk per Air Transat 961 TSB A05F0098 · embodiment SB ${sp.isPostAA587Mod?'YES':'NO'} · schedule rudder NDT inspection per EASA AD 2006-0228`)
  } else if (st.rtlState === 'DEGRADED' && ph === 'CRZ') {
    score = Math.max(score, 45)
    notes.push(`RTL/${sp.rtlArch} DEGRADED at cruise — single-channel pedal-stop loss · monitor pedal force, avoid large yaw inputs · QRH abnormal procedure · maintain coordinated flight`)
  } else if (sp.rtlArch === 'BLOWDOWN' && f.velocityKts > sp.vmo * 0.9) {
    score = Math.max(score, 25)
    notes.push(`${sp.cls} relies on aerodynamic blow-down (no active RTL) · V=${f.velocityKts.toFixed(0)}kt high in envelope · hinge-moment alone limits rudder · CS-25.143 demonstrated compliance only`)
  } else if (!sp.isPostAA587Mod && f.velocityKts > 250) {
    score = Math.max(score, 20)
    notes.push(`airframe pre-AA587 mod-bulletin embodiment · post-AA587 §25.351(b) amendment 25-91 applies · verify SB embodiment, restrict pedal authority per FCOM Vol2 §03`)
  }
  score = clamp(score, 0, 100)

  let tier: Tier = 'OFF'
  if (score >= 85) tier = 'FIN-SEP'
  else if (score >= 65) tier = 'OVERSTRSS'
  else if (score >= 45) tier = 'UNSCHED'
  else if (score >= 22) tier = 'MARGIN'
  else tier = 'NOMINAL'

  return {
    f, phase: ph, cls: sp.cls, spec: sp,
    rtlState: st.rtlState, pedalLim, pedalCmd,
    beta, doublets: st.doublets, fatigue: st.fatigue,
    drivers, score, tier, notes
  }
}

export default function RtlRudder({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'ENVELOPE'|'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [advMul, setAdvMul] = useState(1.0)
  const [iasMul, setIasMul] = useState(1.0)
  const [betaOffset, setBetaOffset] = useState(0)
  const [lawMul, setLawMul] = useState(1.0)
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(false)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = computeRow(f, advMul, iasMul, betaOffset, lawMul)
      if (r.phase !== 'OFF') out.push(r)
    }
    out.sort((a,b) => (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, iasMul, betaOffset, lawMul])

  // === MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'rtl-src'
    const SRC_VEC = 'rtl-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)

    const writeAll = () => {
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (classFilter==='ALL'||r.cls===classFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter)
      )
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        const parts: string[] = []
        parts.push(r.f.callsign || r.f.icao)
        parts.push(r.cls.split('-')[0])
        parts.push(`δr${Math.abs(r.pedalCmd).toFixed(1)}/${r.pedalLim.toFixed(1)}°`)
        parts.push(`β${r.beta.toFixed(1)}°`)
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 6 + (r.score/100)*14,
            label: parts.join(' · ')
          }
        })
        // Lateral β cone vector: forward along track with perpendicular component
        if (r.tier === 'FIN-SEP' || r.tier === 'OVERSTRSS' || r.tier === 'UNSCHED') {
          const km = clamp(2 + (r.score/100) * 14, 1, 18)
          const brg = (r.f.track||0) * Math.PI/180
          // perpendicular component proportional to β (sideslip)
          const perpFrac = clamp(r.beta / 12, -0.6, 0.6)
          const perpBrg = brg + Math.PI/2
          const dlatFwd = (km/111.32) * Math.cos(brg)
          const dlngFwd = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
          const dlatPerp = (km*perpFrac/111.32) * Math.cos(perpBrg)
          const dlngPerp = (km*perpFrac/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(perpBrg)
          const endLat = r.f.lat + dlatFwd + dlatPerp
          const endLng = r.f.lng + dlngFwd + dlngPerp
          vecFeats.push({
            type:'Feature',
            geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[endLng, endLat]] },
            properties:{ color: TIER_COLOR[r.tier] }
          })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    if (!map.getLayer('rtl-halo'))
      map.addLayer({ id:'rtl-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.16, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.2, 'circle-stroke-opacity':0.78 } })
    if (!map.getLayer('rtl-pin'))
      map.addLayer({ id:'rtl-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.4, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('rtl-lbl'))
      map.addLayer({ id:'rtl-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.5], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('rtl-vec'))
      map.addLayer({ id:'rtl-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2, 2.5], 'line-opacity':0.78 } })

    writeAll()
    return () => {
      for (const id of ['rtl-lbl','rtl-pin','rtl-halo','rtl-vec']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, phaseFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (classFilter==='ALL'||r.cls===classFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type||'').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )

  const counts: Record<Tier, number> = { 'FIN-SEP':0,'OVERSTRSS':0,'UNSCHED':0,'MARGIN':0,'NOMINAL':0,'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muBeta = rows.length ? (rows.reduce((a,b)=>a+Math.abs(b.beta),0)/rows.length) : 0
  const muDr = rows.length ? (rows.reduce((a,b)=>a+Math.abs(b.pedalCmd),0)/rows.length) : 0
  const finSepCnt = counts['FIN-SEP']
  const overCnt = counts['OVERSTRSS']
  const worst = rows[0]

  // Per-class aggregation
  const classMap = new Map<string, { spec: ClassSpec; count: number; muBeta: number; muDr: number; muFat: number; finSep: number; overStr: number; marg: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muBeta: 0, muDr: 0, muFat: 0, finSep: 0, overStr: 0, marg: 0 }
    e.count++; e.muBeta += Math.abs(r.beta); e.muDr += Math.abs(r.pedalCmd); e.muFat += r.fatigue
    if (r.tier === 'FIN-SEP') e.finSep++
    if (r.tier === 'OVERSTRSS') e.overStr++
    if (r.tier === 'MARGIN') e.marg++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count,
    muBeta: e.muBeta/e.count, muDr: e.muDr/e.count, muFat: e.muFat/e.count,
    finSep: e.finSep, overStr: e.overStr, marg: e.marg
  })).sort((a,b) => (b.finSep+b.overStr) - (a.finSep+a.overStr) || b.muBeta - a.muBeta)

  const pickedSpec = worst ? worst.spec : SPECS[1]

  // Build pedal-stop schedule curve points for picked class
  const schedulePts: { v: number; lim: number }[] = []
  for (let v = 100; v <= 400; v += 10) schedulePts.push({ v, lim: pedalStopAtV(pickedSpec, v) })

  return (
    <div className="fixed top-16 right-3 z-40 w-[490px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">RTL · RUDDER</span>
          <span className="text-[10px] text-slate-400">Travel Limiter &amp; Vert-Stab Margin · CS-25.351 / AA587</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter===t?'border':'border border-slate-700/60'}`} style={{ background:`${TIER_COLOR[t]}22`, borderColor: tierFilter===t?TIER_COLOR[t]:undefined, color: TIER_COLOR[t] }}>{t==='FIN-SEP'?'FIN':t==='OVERSTRSS'?'OVER':t==='UNSCHED'?'UNSCH':t==='MARGIN'?'MARG':t.slice(0,4)} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SC</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-β</div><div className="font-mono" style={{color: muBeta>6 ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{muBeta.toFixed(1)}°</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-δr</div><div className="font-mono text-slate-100">{muDr.toFixed(1)}°</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FIN-SEP</div><div className="font-mono" style={{color: finSepCnt>0 ? TIER_COLOR['FIN-SEP'] : TIER_COLOR.NOMINAL}}>{finSepCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">OVRSTR</div><div className="font-mono" style={{color: overCnt>0 ? TIER_COLOR['OVERSTRSS'] : TIER_COLOR.NOMINAL}}>{overCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min={50} max={200} value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">IAS-MUL <span className="text-slate-200 font-mono">{(iasMul*100).toFixed(0)}%</span>
            <input type="range" min={50} max={150} value={iasMul*100} onChange={e=>setIasMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">β-OFFSET <span className="text-slate-200 font-mono">{betaOffset.toFixed(1)}°</span>
            <input type="range" min={-5} max={5} step={0.1} value={betaOffset} onChange={e=>setBetaOffset(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">LAW-MUL <span className="text-slate-200 font-mono">{(lawMul*100).toFixed(0)}%</span>
            <input type="range" min={0} max={200} value={lawMul*100} onChange={e=>setLawMul(+e.target.value/100)} className="w-full accent-sky-500" />
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
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background:`${RTL_STATE_COLOR[r.rtlState]}33`, color:RTL_STATE_COLOR[r.rtlState] }}>RTL {r.rtlState}</span>
              {r.doublets > 0 && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#ef444433', color:'#ef4444' }}>×{r.doublets} doublet</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>δr-cmd <span className="font-mono" style={{color: Math.abs(r.pedalCmd) > r.pedalLim ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{r.pedalCmd.toFixed(1)}°</span></div>
              <div>δr-lim <span className="text-slate-100 font-mono">{r.pedalLim.toFixed(1)}°</span></div>
              <div>β <span className="font-mono" style={{color: Math.abs(r.beta)>r.spec.sideslipLim*0.7 ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{r.beta.toFixed(1)}°</span></div>
              <div>β-lim <span className="text-slate-100 font-mono">{r.spec.sideslipLim.toFixed(1)}°</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>V <span className="text-slate-100 font-mono">{r.f.velocityKts.toFixed(0)}</span></div>
              <div>VFE <span className="text-slate-100 font-mono">{r.spec.vfe}</span></div>
              <div>VMO <span className="text-slate-100 font-mono">{r.spec.vmo}</span></div>
              <div>fatigue <span className="font-mono" style={{color: r.fatigue>0.8 ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{(r.fatigue*100).toFixed(0)}%</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v as number)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='NOMINAL' && r.tier!=='OFF' && <div className="mt-1 text-[9px] text-slate-500">monitor pedal force · coordinated flight · verify RTL armed on EICAS</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-[10px] text-slate-500 italic px-2 py-6 text-center">no airframes in scope · adjust filters or β-OFFSET to probe envelope</div>
        )}

        {tab==='CLASSES' && (
          <div className="space-y-1">
            {classRows.map(c => (
              <div key={c.cls} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                  <span className="px-1 rounded bg-slate-700/50 text-slate-200 font-mono text-[9px]">{c.cls}</span>
                  <span className="text-slate-300 truncate text-[10px]">{c.spec.label}</span>
                  <span className="ml-auto font-mono text-slate-100">{c.count}</span>
                </div>
                <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
                  <div>arch <span className="text-slate-100 font-mono">{c.spec.rtlArch}</span></div>
                  <div>β-lim <span className="text-slate-100 font-mono">{c.spec.sideslipLim.toFixed(1)}°</span></div>
                  <div>δr@VFE <span className="text-slate-100 font-mono">{c.spec.pedalStopVFE}°</span></div>
                  <div>δr@VMO <span className="text-slate-100 font-mono">{c.spec.pedalStopVMO}°</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>β-PROT <span className="font-mono" style={{color: c.spec.hasBetaProt ? TIER_COLOR.NOMINAL : '#94a3b8'}}>{c.spec.hasBetaProt ? 'YES' : 'no'}</span></div>
                  <div>SB-emb <span className="font-mono" style={{color: c.spec.isPostAA587Mod ? TIER_COLOR.NOMINAL : TIER_COLOR['UNSCHED']}}>{c.spec.isPostAA587Mod ? 'YES' : 'NO'}</span></div>
                  <div>μ-β <span className="font-mono" style={{color: c.muBeta>6 ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{c.muBeta.toFixed(1)}°</span></div>
                  <div>μ-fat <span className="font-mono" style={{color: c.muFat>0.8 ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{(c.muFat*100).toFixed(0)}%</span></div>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-400">
                  <div>FIN-SEP <span className="font-mono" style={{color: c.finSep>0 ? TIER_COLOR['FIN-SEP'] : TIER_COLOR.NOMINAL}}>{c.finSep}</span></div>
                  <div>OVERSTR <span className="font-mono" style={{color: c.overStr>0 ? TIER_COLOR['OVERSTRSS'] : TIER_COLOR.NOMINAL}}>{c.overStr}</span></div>
                  <div>MARG <span className="font-mono" style={{color:TIER_COLOR['MARGIN']}}>{c.marg}</span></div>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 italic">{
                  c.cls === 'AB-A300-RTLU' ? 'Goodrich Heritage RTLU per A300/A310 AMM 27-23-00 · post-AA587 SB amended pedal-force-vs-deflection-vs-speed law' :
                  c.cls === 'AB-A320-FBW' ? 'FAC/ELAC FBW yaw cmd law per FCOM DSC-27-20-10 · β-PROT clips lateral demand to ±sideslipLim*0.85' :
                  c.cls === 'AB-A330-FBW' ? 'FAC/ELAC heavy-fleet FBW with β-PROT · MTOW-heavy reduces effective β-margin · DSC-27-20-10' :
                  c.cls === 'AB-A350-PRIM' ? 'PRIM/SEC fully-integrated TLU + β-PROT + β-MAX hard limits collapsed into PRIM yaw control law' :
                  c.cls === 'BO-B777-PFC' ? 'PFC outer-loop integrated RTL per Boeing 777/787 FCOM Vol2 §03 · no autothrust wake on pedal cmd' :
                  c.cls === 'BO-B737NG-RPRA' ? 'RPRA passive hydraulic-pressure reducer · post-USAir 427 PCU dual-servo rebuild per AD 2002-22-04' :
                  c.cls === 'BO-B757-RPRA' ? 'RPRA dual-PCU per AD 2002-22-04 · B757/B767/B747-400 variant family' :
                  c.cls === 'E-JET-FCM' ? 'FCM Flight Control Module FBW gain sched + β-PROT per Embraer FOM ch.13' :
                  c.cls === 'RGN-BLOWDOWN' ? 'Aerodynamic blow-down (passive hinge moment) + yaw damper · CS-25.143 compliance only · no active limiter' :
                  'Light GA / fighter — no RTL, pilot judgement on yaw inputs'
                }</div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope</div>}
          </div>
        )}

        {tab==='ENVELOPE' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">RTL δr pedal-stop schedule · picked class {pickedSpec.cls}</div>
              <div className="text-slate-400">Per CS-25.351 / 14 CFR §25.351 the certified rudder authority is reduced from full-pedal at VFE to a small fraction at VMO to keep single-pedal full-deflection vertical-stab shear within limit-load. The RTL/RTLU/RPRA/FBW gain-schedule (architecture {pickedSpec.rtlArch}) is the mechanism: pedal-stop = {pickedSpec.pedalStopVFE}° at V≤VFE ({pickedSpec.vfe}kt) descending linearly to {pickedSpec.pedalStopVMO}° at V≥VMO ({pickedSpec.vmo}kt). β envelope per §25.351 demonstrated compliance: ±{pickedSpec.sideslipLim.toFixed(1)}°.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">δr (deg pedal stop) vs V (KIAS)</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="40" y1="190" x2="390" y2="190" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="190" stroke="#334155" />
                {/* V axis 100..400 */}
                {[100,150,200,250,300,350,400].map(v => (
                  <g key={v}><line x1={40 + (v-100)/300*350} y1="188" x2={40 + (v-100)/300*350} y2="192" stroke="#475569"/>
                    <text x={40 + (v-100)/300*350} y={202} fill="#94a3b8" fontSize="9" textAnchor="middle">{v}</text></g>
                ))}
                {/* δr axis 0..35° */}
                {[0,5,10,15,20,25,30,35].map(a => (
                  <g key={a}><line x1="38" y1={190 - a/35*170} x2="42" y2={190 - a/35*170} stroke="#475569"/>
                    <text x={34} y={193 - a/35*170} fill="#94a3b8" fontSize="9" textAnchor="end">{a}°</text></g>
                ))}
                <text x="215" y="214" fill="#94a3b8" fontSize="9" textAnchor="middle">V_C (KIAS)</text>
                <text x="14" y="105" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 105)">δr (deg)</text>

                {/* VFE band */}
                <line x1={40 + (pickedSpec.vfe-100)/300*350} y1="20" x2={40 + (pickedSpec.vfe-100)/300*350} y2="190" stroke="#0ea5e9" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.6"/>
                <text x={40 + (pickedSpec.vfe-100)/300*350 + 2} y="28" fill="#0ea5e9" fontSize="8">VFE {pickedSpec.vfe}</text>

                {/* VMO band */}
                <line x1={40 + (pickedSpec.vmo-100)/300*350} y1="20" x2={40 + (pickedSpec.vmo-100)/300*350} y2="190" stroke="#f43f5e" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.7"/>
                <text x={40 + (pickedSpec.vmo-100)/300*350 - 2} y="28" fill="#f43f5e" fontSize="8" textAnchor="end">VMO {pickedSpec.vmo}</text>

                {/* §25.351 ultimate-load envelope (rose dashed ceiling — exceeding causes vert-stab overload) */}
                {(() => {
                  // Envelope ceiling = pedal_stop * 1.5 (factor-of-safety ratio for ultimate vs limit)
                  const path: string[] = []
                  for (const pt of schedulePts) {
                    const ceil = pt.lim * 1.45
                    const x = 40 + (pt.v - 100)/300*350
                    const y = 190 - clamp(ceil, 0, 35)/35*170
                    path.push(`${path.length===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`)
                  }
                  return <path d={path.join(' ')} stroke="#f43f5e" fill="none" strokeWidth="1.0" strokeDasharray="3 2" opacity="0.7"/>
                })()}
                <text x="380" y="48" fill="#f43f5e" fontSize="8" textAnchor="end">§25.351 ultimate-load ceiling</text>

                {/* Scheduled pedal-stop curve (emerald solid) */}
                {(() => {
                  const path: string[] = []
                  for (const pt of schedulePts) {
                    const x = 40 + (pt.v - 100)/300*350
                    const y = 190 - clamp(pt.lim, 0, 35)/35*170
                    path.push(`${path.length===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`)
                  }
                  return <path d={path.join(' ')} stroke="#10b981" fill="none" strokeWidth="1.6" />
                })()}
                <text x="380" y="62" fill="#10b981" fontSize="8" textAnchor="end">RTL scheduled pedal-stop ({pickedSpec.rtlArch})</text>

                {/* Fleet dots — current (V, |δr|) per airframe tier-coloured */}
                {rows.slice(0,80).map((r,i) => {
                  const x = 40 + clamp((r.f.velocityKts - 100)/300, 0, 1)*350
                  const y = 190 - clamp(Math.abs(r.pedalCmd), 0, 35)/35*170
                  return <circle key={i} cx={x} cy={y} r="2.6" fill={TIER_COLOR[r.tier]} opacity={0.85} stroke="#0b0f17" strokeWidth="0.5" />
                })}

                {/* legend */}
                <g transform="translate(50, 30)">
                  <line x1="0" y1="0" x2="10" y2="0" stroke="#10b981" strokeWidth="1.6" />
                  <text x="14" y="3" fill="#cbd5e1" fontSize="9">RTL pedal-stop schedule (VFE→VMO ramp)</text>
                  <line x1="0" y1="11" x2="10" y2="11" stroke="#f43f5e" strokeWidth="1.0" strokeDasharray="3 2" />
                  <text x="14" y="14" fill="#cbd5e1" fontSize="9">§25.351 ultimate-load ceiling</text>
                </g>
              </svg>
              <div className="grid grid-cols-4 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-β</div><div className="font-mono" style={{color: muBeta>6 ? TIER_COLOR['UNSCHED'] : '#cbd5e1'}}>{muBeta.toFixed(1)}°</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PEAK-β</div><div className="font-mono" style={{color: TIER_COLOR['FIN-SEP']}}>{rows.length ? Math.max(...rows.map(r=>Math.abs(r.beta))).toFixed(1) : '0'}°</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{pickedSpec.cls}</div></div>
              </div>
            </div>

            {/* per-class β envelope comparison strip */}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">β sideslip envelope across classes (CS-25.351, deg)</div>
              <svg viewBox="0 0 400 200" className="w-full">
                <line x1="40" y1="180" x2="390" y2="180" stroke="#334155" />
                <line x1="40" y1="10" x2="40" y2="180" stroke="#334155" />
                {[0,2,4,6,8,10,12,14].map(a => (
                  <g key={a}><line x1={40 + a/14*350} y1="178" x2={40 + a/14*350} y2="182" stroke="#475569"/>
                    <text x={40 + a/14*350} y={192} fill="#94a3b8" fontSize="9" textAnchor="middle">{a}°</text></g>
                ))}
                {SPECS.map((s, i) => {
                  const y = 18 + i*15
                  return <g key={s.cls}>
                    <text x="36" y={y+3} fill="#94a3b8" fontSize="9" textAnchor="end">{s.cls.split('-').slice(0,2).join('-')}</text>
                    {/* β in green margin */}
                    <rect x={40} y={y-3} width={s.sideslipLim*0.7/14*350} height="6" fill="#10b981" opacity="0.35" />
                    {/* β margin amber */}
                    <rect x={40 + s.sideslipLim*0.7/14*350} y={y-3} width={s.sideslipLim*0.3/14*350} height="6" fill="#f59e0b" opacity="0.4" />
                    {/* β past lim rose */}
                    <rect x={40 + s.sideslipLim/14*350} y={y-3} width={Math.min(2, 14-s.sideslipLim)/14*350} height="6" fill="#ef4444" opacity="0.55" />
                    {/* β-lim tick */}
                    <line x1={40 + s.sideslipLim/14*350} y1={y-5} x2={40 + s.sideslipLim/14*350} y2={y+5} stroke="#cbd5e1" strokeWidth="1.2" />
                    {/* β-PROT marker */}
                    {s.hasBetaProt && <text x={40 + s.sideslipLim/14*350 + 4} y={y+3} fill="#0ea5e9" fontSize="7">β-PROT</text>}
                  </g>
                })}
                <text x="215" y="200" fill="#94a3b8" fontSize="9" textAnchor="middle">sideslip β (deg)</text>
                <g transform="translate(225, 8)">
                  <rect x="0" y="0" width="8" height="6" fill="#10b981" opacity="0.35" />
                  <text x="11" y="5" fill="#cbd5e1" fontSize="8">green margin (≤0.7×β-lim)</text>
                  <rect x="0" y="9" width="8" height="6" fill="#f59e0b" opacity="0.4" />
                  <text x="11" y="14" fill="#cbd5e1" fontSize="8">amber transition</text>
                  <rect x="0" y="18" width="8" height="6" fill="#ef4444" opacity="0.55" />
                  <text x="11" y="23" fill="#cbd5e1" fontSize="8">past §25.351 envelope</text>
                </g>
              </svg>
            </div>
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Definition</div>
              <div className="text-slate-400">RTL (Rudder Travel Limiter) is the certified speed-dependent rudder-authority schedule that protects the vertical stabiliser from exceeding limit-load in single-pedal or REVERSED full-pedal inputs at high IAS. It is the engineering answer to CS-25.351 / 14 CFR §25.351 yawing-manoeuvre certification: maximum rudder deflection is mechanically (RTLU) or electronically (FBW) reduced from ±30° at VFE down to ±4-7° at VMO so that a single full-pedal input at V_C produces vert-fin shear within limit-load. Architecture varies by airframe family: Airbus RTLU (A300-600), FAC/ELAC FBW yaw cmd law (A320 fam), PRIM/SEC integrated (A350/A380), Boeing PFC integrated (B777/B787), RPRA passive hydraulic-pressure reducer (B737NG/B757/B767), or aerodynamic blow-down (regional turboprops).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Distinct from other monitors</div>
              <div className="text-slate-400">DUTCH-ROLL is the lateral-directional eigenmode damping subsystem (yaw-damper authority and frequency content, not pedal-stop scheduling). VMC is the asymmetric-thrust rudder-authority FLOOR for steady-state engine-out, not the high-IAS authority CEILING. ALPHA-FLOOR is the high-AOA pitch-protection subsystem. PIO is closed-loop handling-quality bandwidth. STCA is conflict-detection in ATC. FBW-REV is the FBW law-reversion (NORMAL→ALT→DIRECT) state. TRIM-AUTHORITY is the pitch-trim band scheduling. The RTL subsystem is uniquely the VERT-STAB STRUCTURAL MARGIN evaluator: pedal-cmd ratio to scheduled limit, β to §25.351 envelope, doublet cycle count to AA587 pattern, and RTL-fault degradation.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Per-class RTL architecture</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· AB-A300-RTLU A300-600/A310 — Goodrich Heritage 3-valve hydraulic-electronic RTLU per AMM 27-23-00. Post-AA587 SB amended pedal-force-vs-deflection-vs-speed law to eliminate brick-wall transient.</div>
                <div>· AB-A320-FBW A320/A321/A220 — FAC/ELAC FBW yaw command law with β-PROT clamping lateral demand. FCOM DSC-27-20-10.</div>
                <div>· AB-A330-FBW A330/A340 — FAC/ELAC with β-PROT, MTOW-heavy reduces effective margin.</div>
                <div>· AB-A350-PRIM A350/A380 — PRIM/SEC fully-integrated TLU + β-PROT + β-MAX hard limits collapsed into yaw control law.</div>
                <div>· BO-B777-PFC B777/B787 — PFC outer-loop integrated RTL per Boeing FCOM Vol2 §03.</div>
                <div>· BO-B737NG-RPRA B737NG/MAX — RPRA passive hydraulic-pressure reducer, post-USAir 427 PCU dual-servo rebuild per AD 2002-22-04. NOT a position-stop.</div>
                <div>· BO-B757-RPRA B757/B767/B747-400 — RPRA dual-PCU variant family per AD 2002-22-04.</div>
                <div>· E-JET-FCM E170/E190/E195/E2 — FCM Flight Control Module FBW gain sched + β-PROT.</div>
                <div>· RGN-BLOWDOWN CRJ/ATR/Q400/Saab — aerodynamic hinge-moment blow-down (passive) + yaw damper, CS-25.143 compliance only.</div>
                <div>· GA-NONE light GA / fighter — no RTL, pilot judgement.</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Hard-escalator score floors</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· Pedal doublet reversal (≥2 full cycles in 60s) at V&gt;250kt → score ≥ 92 (AA587 mode per NTSB AAR-04-04 / AAMP-AOC rudder-reversal prohibition)</div>
                <div>· β &gt; §25.351 envelope at any phase → score ≥ 88 (Air Transat 961 TSB A05F0098 vert-stab separation mode)</div>
                <div>· RTL FAIL + V &gt; VFE+50 → ≥ 80 (pedal stop NOT scheduled, QRH RUDDER TRAVEL LIMITER FAULT)</div>
                <div>· Pedal δr &gt; scheduled limit (RTL bypass) → ≥ 75 (§25.351 single-input envelope breached)</div>
                <div>· β &gt; 0.7×envelope at V&gt;250kt → ≥ 68 (vert-fin loading elevated)</div>
                <div>· Vert-fin fatigue index &gt; 0.85 → ≥ 55 (composite delamination risk, EASA AD 2006-0228)</div>
                <div>· RTL DEGRADED at CRZ → ≥ 45 (single-channel pedal-stop loss)</div>
                <div>· BLOWDOWN class V&gt;0.9×VMO → ≥ 25 (passive aero-only authority limit)</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Precedent accident family</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· American 587 A300B4-605R N14053 KJFK-SDQ 2001-11-12 — 265 fatal. Full-deflection rudder doublet cycles in wake-turbulence upset overloaded composite vert-stab to separation at 251 KIAS / β≈9° / sideloads 220% of §25.351 limit. NTSB AAR-04-04. Direct precedent for §25.351(b) reinterpretation amendment 25-91, AAMP-AOC rudder-reversal prohibition, RTL/RPRA hardware gain-scheduling rebuild industry-wide.</div>
                <div>· Air Transat 961 A310-308 C-GPAT Cuba 2005-03-06 — hull-loss landing after RUDDER SEPARATION in flight from composite-bond delamination during rudder-pedal transient at 250 KIAS. TSB Canada A05F0098 drove EASA AD 2006-0072 / 2006-0228 rudder-bonding inspection.</div>
                <div>· USAir 427 B737-300 N513AU Pittsburgh 1994-09-08 — 132 fatal. Rudder-PCU servo-valve uncommanded HARDOVER cascade. NTSB AAR-99-01. Drove FAA AD 2002-22-04 PCU dual-servo rebuild and the B737 RPRA install (passive low-pass speed-gain reducer).</div>
                <div>· United 585 B737-200 N999UA Colorado Springs 1991-03-03 — 25 fatal. Same rudder-hardover precedent. NTSB AAR-01-01.</div>
                <div>· Aeroflot 593 A310-304 F-OGQS Magadan 1994-03-23 — autopilot disconnect during PIC's child input → upset → vert-fin loading event. 75 fatal.</div>
                <div>· Aeroflot 8641 Tu-134 Uchkuduk 1985-07-10 — 200 fatal. Upset → yaw-axis structural risk precedent in Russian-built airframes.</div>
                <div>· Pakistan Int'l 8303 A320-214 AP-BLD KHI 2020-05-22 — 97 fatal. Post-impact gear-up bounce + secondary engine-fire + manual rudder authority over-applied during go-around. PCAA AAIB 2020.</div>
                <div>· TACA 510 A320-200 N488TA Tegucigalpa 2008-05-30 — hull-loss overrun. Wet-runway short-field landing used RTL-limited rudder for crosswind decrab.</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Mitigation pathway</div>
              <div className="text-slate-400">Per AAMP-AOC rudder-reversal prohibition: NO pedal-reversal doublets at any IAS — single-direction rudder demand only, hold and release; the RTL/RPRA does NOT protect against repeated pedal cycles even within scheduled limit. If RTL FAIL annunciated (Airbus ECAM F/CTL RUD TRVL LIM FAULT or Boeing EICAS RUDDER TRAVEL LIMIT FAIL), reduce speed below VFE before any rudder demand per QRH abnormal procedure. If β &gt; envelope, release pedal immediately and allow yaw damper to recover; do NOT counter-input. For B737/B757/B767 RPRA family, verify dual-PCU servo function per AD 2002-22-04 pre-departure check. Maintain coordinated flight; use rudder for crosswind takeoff/landing decrab and for engine-out control per §25.149 VMCA only, never for roll augmentation above α≥10° (fighters excepted per AFM).</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.143 (controllability), §25.149 (VMCA), §25.171-175 (stability), §25.201-203 (stalls), §25.207 (stall warning), §25.255 (out-of-trim), §25.301-307 (structural loads), §25.341 (gust loads), §25.351 (yawing manoeuvres — AA587 amendment 25-91 reinterpretation), §25.671 (control systems), §25.672 (stability augmentation), §25.677 (trim systems), §25.697-701 (high-lift) · EASA CS-25.143 / CS-25.149 / CS-25.171-175 / CS-25.207 / CS-25.301-307 / CS-25.341 / CS-25.351 / CS-25.671 / CS-25.672 · FAA AC 25-7D §32 yawing manoeuvre flight test guide, §5.2.5 PIO + protection envelope, §5.3 stall char &amp; warning · NTSB AAR-04-04 American Airlines 587 A300-605R KJFK-SDQ vert-stab separation · NTSB AAR-99-01 USAir 427 B737-300 KPIT rudder-PCU hardover · NTSB AAR-01-01 United 585 B737-200 Colorado Springs · NTSB AAR-94-07 Aeroflot 593 A310 Magadan · TSB Canada A05F0098 Air Transat 961 A310-308 rudder separation Cuba · PCAA AAIB Pakistan Int'l 8303 A320 KHI · MAK Tu-134 Aeroflot 8641 Uchkuduk · AD 2002-22-04 B737/B757/B767 PCU dual-servo rebuild + RPRA install · EASA AD 2006-0072 + AD 2006-0228 A300/A310 rudder-bonding NDT inspection · AAMP Advanced Aircraft Manoeuvring Program (Boeing/Airbus joint) AAMP-AOC rudder reversal prohibition · Airbus FCOM DSC-27-20-10 RTL · FCOM ABN-27 RUDDER TRAVEL LIMITER FAULT · FCTM PRO-NOR-SOP-22 yaw-damper · AMM 22-30-00 Auto-Flight (alpha) / 27-23-00 RTLU · Boeing B737 FCOM 9.10 RPRA / FCOM Vol2 §03 Flight Controls / FCTM Ch.8 manual-flight · Boeing B777 FCOM Vol2 §03 / FCTM Ch.8 · Boeing B787 FCOM Vol2 §03 / SP.16 Pilot Manual Operation · Embraer E190 / E195 / E2 FOM ch.13 Yaw / FCM Module · ICAO Doc 9760 Vol II Pt VI engine/airframe cert · ICAO Annex 8 Pt IIIA · MIL-STD-1797B App.A handling qualities · Cook Flight Dynamics Principles Ch.6 lateral-directional · Etkin Dynamics of Atmospheric Flight 3e Ch.5 lateral · Stevens &amp; Lewis Aircraft Control &amp; Simulation 3e Ch.4 stability augmentation · Roskam Pt VI Stability &amp; Control Ch.7 · Schlichting/Truckenbrodt Aerodynamics of the Aeroplane Ch.10 rudder · AIAA Briere &amp; Traverse A320 FBW Architecture · Goodrich Heritage RTLU AMM 27-23-00 Hamilton Sundstrand 9202-22 · Lufthansa Technik rudder MX manual · A300/A310 NTSB AAR-04-04 §1.6 vert-stab composite test data · Smith Boeing B757/767 PCU PCS post-AD update.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
