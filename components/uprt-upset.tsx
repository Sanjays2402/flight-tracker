'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   UPRT · Upset Prevention & Recovery Training Envelope &
   Aircraft-Upset / Unusual-Attitude State Classifier Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of the IATA / ICAO / FAA / EASA
   "airplane upset" envelope as defined in the Aeroplane Upset
   Prevention & Recovery Training Aid (AUPRTA) Rev 3 — the
   integrated post-AF447 / Colgan-3407 regulatory regime created
   to address Loss-of-Control In-flight (LOC-I) as the #1
   Commercial Aviation Safety Team (CAST) accident category by
   fatality count for the past two decades.

   The AUPRTA / ICAO Doc 10011 / FAA AC 120-111 / EASA AMC1
   FCL.745.A / IATA Guidance Material on UPRT definition of
   "airplane upset" is the per-frame envelope:
     · Pitch attitude > 25° nose-UP
     · Pitch attitude > 10° nose-DOWN
     · Bank angle > 45° in either direction
     · IAS inappropriate for current configuration (>1.10·VMO
       or below Vs1g·1.13 with low alt margin)
     · α approaching / exceeding α_stall warning (stick-shaker)
   PLUS any inappropriate flight-path response, dynamic
   divergence, or automation-induced excursion.

   Structurally distinct from:
     · STALL (single-axis 1g α-floor warning — STALL is one
       driver inside UPRT, the AERO-STALL upset class).
     · DEEPSTL (post-stall T-tail Cm(α) reversal at α=40-50°
       locked-in — a specific catastrophic exit-mode of an
       AERO-STALL upset, not the upset envelope itself).
     · DUTCH-ROLL (lateral-directional Dutch-roll eigenmode
       damping — UPRT is ATTITUDE excursion not modal damping).
     · MACH-TUCK (transonic compressibility Cm(M) reversal at
       M_crit — driver of HIGH-PITCH-ND upset class but not
       the envelope evaluator).
     · PIO (closed-loop pilot-airframe handling-quality coupling
       Neal-Smith Bandwidth/Phase-Delay — UPRT is open-loop
       attitude envelope departure, PIO is the high-gain
       compensatory-tracking resonance pathology).
     · VMC / VMCA / VMCL (asymmetric-thrust controllability
       floor — specific lateral-directional driver, not the
       integrated upset envelope).
     · TEM-ENERGY (kinetic+potential balance state monitor — a
       contributing driver but does not score attitude excursion).
     · FMA (automation mode-awareness Sarter-Woods — driver of
       AUTOM-INDUCED upset class but not the envelope).
     · COFFIN (Vmo-Mmo / Vs1g convergence cruise envelope only).
     · UAS / pitot-icing (sensor failure cascade — specific
       sub-driver of AUTOM/FAIL upset class).

   UPRT is uniquely the AGGREGATED airplane-upset envelope
   classifier per AUPRTA Rev 3 — it scores per-airframe
   proximity to or actual penetration of the {pitch, bank,
   speed, alpha, g-load} 5-axis attitude/energy envelope that
   defines the "upset" regime, classifies the upset by
   mechanism (AERO-STALL / HIGH-PITCH-NU / HIGH-PITCH-ND /
   HIGH-BANK / UNDER-SPEED / OVER-SPEED / DUAL-ENV / NEUTRAL),
   and grades recovery margin (altitude-to-recover-AGL,
   thrust-asymmetry, control-authority remaining) against the
   per-airframe certification (§25.143 / §25.181 / §25.203 /
   §25.255 / AC 25-7D) and the AUPRTA Rev 3 5-class taxonomy
   (AERODYNAMIC / SYSTEM-INDUCED / ENVIRONMENT-INDUCED /
   PILOT-INDUCED / AUTOMATION-INDUCED).

   Seven driver scores [0..100] aggregated per flight:
     ATT-PITCH  |pitch°| vs 25° NU / 10° ND AUPRTA thresholds
     ATT-BANK   |bank°| vs 45° AUPRTA threshold
     ENERGY     KE+PE balance + speed appropriate for altitude
     MARGIN-V   Vs1g / VMO·MMO envelope proximity
     G-LOAD     Δn deviation from 1g + corner-loading
     AUTOM      automation-induced excursion risk (mode-conf)
     ENV        turbulence/wake/wind-shear/icing/mtn-wave
                aggravator (environmental upset driver)

   8 upset categories:
     AERO-STALL      α approaching α_stall warning
     HIGH-PITCH-NU   |pitch| > 25° nose-up
     HIGH-PITCH-ND   |pitch| > 10° nose-down
     HIGH-BANK       |bank| > 45°
     UNDER-SPEED     IAS < 1.10·Vs1g with low altitude margin
     OVER-SPEED      IAS > 0.97·VMO or M > 0.97·MMO
     DUAL-ENV        two-or-more concurrent envelope corners
     NEUTRAL         within envelope

   9-phase classifier:
     TKO         takeoff roll / V1 to lift-off
     INIT-CLB    initial climb (<1500 ft AGL)
     CLB         climb (1500 ft - cruise)
     CRZ         cruise (max-altitude / coffin-corner risk)
     DST         descent
     APP-INT     approach intermediate (FL150 - 1500 ft AGL)
     APP-FNL     approach final (<1500 ft AGL)
     FLARE       flare / landing (<200 ft AGL)
     GA          go-around (initiated within 1500 ft AGL)
     OFF         ground / off-radar

   Six tiers (mapped from composite score):
     CRITICAL ≥85  rose       active upset penetration
     RECOVERY ≥65  rose-pink  AUPRTA recovery procedure required
     UPSET    ≥45  amber      envelope corner approached
     MARGIN   ≥25  sky        elevated risk
     CLEAR    ≥10  emerald    within normal envelope
     NEUTRAL  <10  slate      benign cruise

   Composite = max(0.65·worst, 0.35·mean) + 0.35·mean × phase
   multiplier (TKO 1.10 · INIT-CLB 1.25 · CLB 1.05 · CRZ 1.00 ·
   DST 1.00 · APP-INT 1.10 · APP-FNL 1.35 · FLARE 1.50 ·
   GA 1.40 · OFF 0).  Hard escalators:
     · |pitch| > 30° NU or > 15° ND → floor 88
     · |bank| > 60° → floor 85
     · AERO-STALL warning triggered → floor 80
     · DUAL-ENV → floor 78

   Accident precedent library (deterministic-by-ICAO-hash
   scenario sampling):
     · AF447  (A330 F-GZCP, 2009-06-01, BEA F-CP090601) —
       canonical AUTOM+AERO-STALL upset · UAS cascade → ALT-LAW
       reversion → aft sidestick held → 30° NU pitch + 16°
       bank → full stall to ocean surface FL350 → 0.
     · Colgan 3407 (Q400 N200WQ, 2009-02-12, NTSB AAR-10-01)
       — canonical AERO-STALL upset · stick-shaker @ flap/gear
       config → captain pulled aft against shaker → stick-pusher
       inhibited → 31° NU + 105° L bank → impact.
     · AirAsia 8501 (A320 PK-AXC, 2014-12-28, KNKT 32-12-12)
       — RTLU rudder-limiter fault → 5× MASTER CAUTION → CB
       reset killed FAC1+2 → ALT-LAW → 54° L bank → 38° NU
       stall → loss to Java Sea.
     · West Caribbean 708 (MD-82 HK-4374X, 2005-08-16, BEA-
       Final) — Engine ice → loss thrust @ FL330 → aft-engine
       T-tail DEEP-STALL post-stall pitch-up lock-in.
     · ABX 3591 (B767-300 N1217A, 2019-02-23, NTSB DCA19MA086)
       — somatogravic illusion ND upset · GA-mode inadvertent
       activation on flap extension → pilot pushed nose down
       attributing pitch-up to autoflight → 49° ND → impact.
     · USAir 427 (B737 N513AU, 1994-09-08, NTSB AAR-99-01) —
       rudder PCU jam-reversal full hardover → uncommanded
       roll → split-throttle → ND penetration → impact.
     · China Air 006 (B747SP N4522V, 1985-02-19, NTSB AAR-
       86-03) — engine #4 flame-out + manual A/P retention →
       uncoordinated roll → 270° rolling dive FL410 → FL110
       recovery (g-load 4.8g, max +5g cert).
     · Adam Air 574 (B737-400 PK-KKW, 2007-01-01, KNKT 07-
       26-VWB) — IRS dual fault → captain head-down trouble-
       shoot → roll departure → 100° R bank → impact ocean.
     · Birgenair 301 (B757 TC-GEN, 1996-02-06, DGAC Dom Rep)
       — pitot static blockage UAS → A/T speed conflict →
       pitch-up stall departure to ocean.
     · Tatarstan 363 (B735 VQ-BBN, 2013-11-17, IAC final) —
       inadvertent go-around → captain trim error + pitch-up
       runaway → 75° ND penetration → impact.
     · ABX/Atlas 3591 second-precedent share with PIO/FMA.
     · West African Air Express 1148 (Brazzaville 2003) —
       wake-encounter rolling departure FL320.

   References: ICAO Doc 10011 Manual on Aeroplane Upset
   Prevention & Recovery Training (2014) · FAA AC 120-111
   Upset Prevention & Recovery Training (2015-04-14) · FAA
   AC 120-109A Stall Prevention & Recovery Training (2015) ·
   FAA Order 8900.1 Vol 3 Ch 19 §11 UPRT · 14 CFR §121.423
   Pilot training requirements · §121.424 Pilot proficiency
   checks · §61.155 / §61.157 ATP training · §25.143 (g)/(h)
   Maneuver protection · §25.181 Dynamic stability · §25.203
   Stall characteristics · §25.255 Out-of-trim characteristics ·
   EASA Part-FCL AMC1 FCL.745.A APS UPRT · CS-FCD AMC1 ORO.FC ·
   ICAO Annex 1 Ch 2 · Doc 9868 PANS-TRG App 2 / 3 / 4 · Doc
   9683 HF training · Doc 9994 EBT manual · IATA APS UPRT
   Guidance Material 2nd ed. (2019) · IATA Loss of Control In-
   Flight (LOC-I) Accident Analysis Report 2019-2023 · CAST/
   ICAO Common Taxonomy Team CICTT LOC-I category ·  IATA/
   Boeing/Airbus Aeroplane Upset Prevention & Recovery Training
   Aid (AUPRTA) Rev 3 (2017) · Royal Aero Soc UPRT FAQ ·
   ICATEE Industry Committee on UPRT · NTSB AAR-10-01 Colgan
   3407 · AAR-86-03 China Air 006 · AAR-99-01 USAir 427 ·
   DCA19MA086 ABX 3591 · BEA F-CP090601 AF447 · KNKT 32-
   12-12 AirAsia 8501 · KNKT 07-26-VWB Adam Air 574 · ATSB
   AO-2008-070 Qantas 72 ADIRU upset · NTSB AAR-09-04 UPS
   1354.  Boeing FCTM 8.5 Upset Recovery · Airbus FCTM PRO-
   ABN-MISC Upset Recovery · Embraer AOM §03 Upset · CRJ
   FCOM Vol 2 §03 · IATA STEADES 2024 §3 LOC-I trending ·
   FAA/NASA TM-2018-219997 Heidelberg LOC-I accident analysis ·
   FAA-S-8081-22 PTS ATP type rating UPRT tasks · ICAO Doc
   9995 PBN Manual interactions.

   UPRT is the integrated AUPRTA Rev 3 5-class upset taxonomy
   evaluator — distinct from each single-axis sub-monitor in
   the suite, this is the AGGREGATOR.
   ============================================================ */

interface SFlight {
  icao: string; callsign?: string; type?: string; operator?: string; category?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
}

interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Driver = 'ATT-PITCH' | 'ATT-BANK' | 'ENERGY' | 'MARGIN-V' | 'G-LOAD' | 'AUTOM' | 'ENV'
type Tier = 'CRITICAL' | 'RECOVERY' | 'UPSET' | 'MARGIN' | 'CLEAR' | 'NEUTRAL'
type Phase = 'TKO' | 'INIT-CLB' | 'CLB' | 'CRZ' | 'DST' | 'APP-INT' | 'APP-FNL' | 'FLARE' | 'GA' | 'OFF'
type Category =
  | 'AERO-STALL'
  | 'HIGH-PITCH-NU'
  | 'HIGH-PITCH-ND'
  | 'HIGH-BANK'
  | 'UNDER-SPEED'
  | 'OVER-SPEED'
  | 'DUAL-ENV'
  | 'NEUTRAL'

type Mechanism = 'AERODYNAMIC' | 'SYSTEM-INDUCED' | 'ENVIRONMENT' | 'PILOT-INDUCED' | 'AUTOMATION-INDUCED' | 'NORMAL'

type AirframeClass =
  | 'WB-HVY'   // B777/B787/A350/A380 wide-body heavy
  | 'WB-T2'    // B767/A330/A340 wide-body twin
  | 'NB'       // B737/A320/A321/A220 narrow-body
  | 'RGN-J'    // E190/CRJ900 regional jet
  | 'RGN-T'    // ATR72/Q400 regional turboprop
  | 'BIZ'      // G650/GLEX/Falcon business
  | 'MIL'      // C-17/KC-135 military transport
  | 'LIGHT'    // PC-12/TBM/Cirrus light
  | 'OTHER'

const DRIVERS: Driver[] = ['ATT-PITCH','ATT-BANK','ENERGY','MARGIN-V','G-LOAD','AUTOM','ENV']
const TIERS: Tier[] = ['CRITICAL','RECOVERY','UPSET','MARGIN','CLEAR','NEUTRAL']
const PHASES: Phase[] = ['TKO','INIT-CLB','CLB','CRZ','DST','APP-INT','APP-FNL','FLARE','GA','OFF']
const CATEGORIES: Category[] = ['AERO-STALL','HIGH-PITCH-NU','HIGH-PITCH-ND','HIGH-BANK','UNDER-SPEED','OVER-SPEED','DUAL-ENV','NEUTRAL']
const AIRFRAMES: AirframeClass[] = ['WB-HVY','WB-T2','NB','RGN-J','RGN-T','BIZ','MIL','LIGHT','OTHER']

const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#ef4444', RECOVERY: '#f43f5e', UPSET: '#f59e0b',
  MARGIN: '#0ea5e9', CLEAR: '#10b981', NEUTRAL: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { CRITICAL:0, RECOVERY:1, UPSET:2, MARGIN:3, CLEAR:4, NEUTRAL:5 }
function tierFromScore(s: number): Tier {
  if (s >= 85) return 'CRITICAL'
  if (s >= 65) return 'RECOVERY'
  if (s >= 45) return 'UPSET'
  if (s >= 25) return 'MARGIN'
  if (s >= 10) return 'CLEAR'
  return 'NEUTRAL'
}
const TIER_LABEL: Record<Tier, string> = {
  CRITICAL: 'CRITICAL', RECOVERY: 'RECOVERY', UPSET: 'UPSET',
  MARGIN: 'MARGIN', CLEAR: 'CLEAR', NEUTRAL: 'NEUTRAL',
}

const CATEGORY_COLOR: Record<Category, string> = {
  'AERO-STALL':    '#ef4444',
  'HIGH-PITCH-NU': '#f43f5e',
  'HIGH-PITCH-ND': '#dc2626',
  'HIGH-BANK':     '#f97316',
  'UNDER-SPEED':   '#f59e0b',
  'OVER-SPEED':    '#a855f7',
  'DUAL-ENV':      '#be123c',
  'NEUTRAL':       '#64748b',
}

const CATEGORY_DESC: Record<Category, string> = {
  'AERO-STALL':    'α approaching α_stall warning · stick-shaker / α-floor regime · AF447 / Colgan / AirAsia',
  'HIGH-PITCH-NU': '|pitch| > 25° nose-up · AUPRTA NU envelope corner · runaway-trim / GA misfly / inadvertent climb',
  'HIGH-PITCH-ND': '|pitch| > 10° nose-down · AUPRTA ND corner · ABX 3591 somatogravic / USAir 427 PCU',
  'HIGH-BANK':     '|bank| > 45° · AUPRTA bank corner · spatial disorient / wake / UCA / IRS fault',
  'UNDER-SPEED':   'IAS < 1.10·Vs1g · approach-stall regime · Asiana 214 / TK1951 / B737 unstabilised',
  'OVER-SPEED':    'IAS > 0.97·VMO or M > 0.97·MMO · structural / aeroelastic / coffin-corner egress',
  'DUAL-ENV':      'two-or-more envelope corners concurrent · DUAL-ENV is the most-dangerous AUPRTA class',
  'NEUTRAL':       'within nominal AUPRTA envelope',
}

const MECHANISM_DESC: Record<Mechanism, string> = {
  'AERODYNAMIC':         'AUPRTA Class-A · stall / α-departure / control-surface authority loss',
  'SYSTEM-INDUCED':      'AUPRTA Class-B · system fault driving upset (RTLU / PCU hardover / ADIRU / IRS)',
  'ENVIRONMENT':         'AUPRTA Class-C · turbulence / wake / wind-shear / mtn-wave / icing',
  'PILOT-INDUCED':       'AUPRTA Class-D · inappropriate manual input (somatogravic / startle / Birgenair pitch-up)',
  'AUTOMATION-INDUCED':  'AUPRTA Class-E · automation surprise / mode confusion driving upset (AF447 / Asiana 214)',
  'NORMAL':              'no upset mechanism active',
}

const DRIVER_DESC: Record<Driver, string> = {
  'ATT-PITCH':   'Pitch attitude (°) vs AUPRTA 25° NU / 10° ND thresholds.',
  'ATT-BANK':    'Bank angle (°) vs AUPRTA 45° threshold.',
  'ENERGY':      'KE+PE balance + speed appropriate for altitude (low/high energy state).',
  'MARGIN-V':    'Vs1g 1.13× lower / 0.97·VMO upper envelope proximity.',
  'G-LOAD':      'Vertical load-factor Δn deviation from 1g + corner loading.',
  'AUTOM':       'Automation-induced excursion risk · mode confusion driver (FMA Sarter-Woods).',
  'ENV':         'Turbulence / wake / wind-shear / icing / mountain-wave aggravator.',
}

const DRIVER_WEIGHT: Record<Driver, number> = {
  'ATT-PITCH': 0.22, 'ATT-BANK': 0.18, 'ENERGY': 0.12,
  'MARGIN-V': 0.16, 'G-LOAD': 0.10, 'AUTOM': 0.12, 'ENV': 0.10,
}

const PHASE_DESC: Record<Phase, string> = {
  'TKO':      'Takeoff roll / V1 to lift-off',
  'INIT-CLB': 'Initial climb · highest LOC-I exposure phase per CAST',
  'CLB':      'Climb · normal performance climb',
  'CRZ':      'Cruise · max-altitude / coffin-corner risk',
  'DST':      'Descent · standard / emergency / drift-down',
  'APP-INT':  'Approach intermediate · FL150 - 1500 ft AGL',
  'APP-FNL':  'Approach final · <1500 ft AGL, stabilised gate',
  'FLARE':    'Flare / landing · <200 ft AGL, energy gate',
  'GA':       'Go-around · initiated <1500 ft AGL, high attitude excursion risk',
  'OFF':      'Ground / off-radar / not airborne',
}

const PHASE_MUL: Record<Phase, number> = {
  'TKO': 1.10, 'INIT-CLB': 1.25, 'CLB': 1.05, 'CRZ': 1.00, 'DST': 1.00,
  'APP-INT': 1.10, 'APP-FNL': 1.35, 'FLARE': 1.50, 'GA': 1.40, 'OFF': 0,
}

// Per-airframe-class certification envelope parameters
interface AirSpec {
  vs1gKt: number    // 1g stall speed clean cruise (kt CAS)
  vmoKt: number     // maximum operating IAS (kt)
  mmo: number       // maximum operating Mach
  ngLim: number     // positive g limit (clean) per §25.337
  ngLimFlap: number // positive g limit (flaps extended) per §25.337
  alphaStallDeg: number // canonical stall α (°)
  pitchEnvNu: number    // certified pitch nose-up envelope (°)
  pitchEnvNd: number    // certified pitch nose-down envelope (°)
  bankEnv: number       // certified bank envelope (°) — typically 67° per §25.143
  vsoKt: number     // landing-config stall speed (kt CAS)
}
const AIRFRAME_SPEC: Record<AirframeClass, AirSpec> = {
  'WB-HVY':  { vs1gKt: 220, vmoKt: 350, mmo: 0.92, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 14.5, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 130 },
  'WB-T2':   { vs1gKt: 200, vmoKt: 360, mmo: 0.88, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 14.8, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 125 },
  'NB':      { vs1gKt: 165, vmoKt: 340, mmo: 0.84, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 15.5, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 115 },
  'RGN-J':   { vs1gKt: 135, vmoKt: 330, mmo: 0.83, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 15.8, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 105 },
  'RGN-T':   { vs1gKt: 110, vmoKt: 245, mmo: 0.55, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 16.5, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 85 },
  'BIZ':     { vs1gKt: 130, vmoKt: 340, mmo: 0.90, ngLim: 2.8, ngLimFlap: 2.0, alphaStallDeg: 15.0, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 100 },
  'MIL':     { vs1gKt: 180, vmoKt: 350, mmo: 0.80, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 15.5, pitchEnvNu: 30, pitchEnvNd: 15, bankEnv: 67, vsoKt: 120 },
  'LIGHT':   { vs1gKt: 65,  vmoKt: 200, mmo: 0.50, ngLim: 3.8, ngLimFlap: 2.0, alphaStallDeg: 17.0, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 55 },
  'OTHER':   { vs1gKt: 140, vmoKt: 320, mmo: 0.82, ngLim: 2.5, ngLimFlap: 2.0, alphaStallDeg: 15.5, pitchEnvNu: 25, pitchEnvNd: 10, bankEnv: 67, vsoKt: 105 },
}

const CLASS_DESC: Record<AirframeClass, string> = {
  'WB-HVY':  'Wide-body heavy · B777/B787/A350/A380 · ngLim 2.5g · M_MO 0.92',
  'WB-T2':   'Wide-body twin · B767/A330/A340 · ngLim 2.5g · M_MO 0.88',
  'NB':      'Narrow-body · B737/A320/A321/A220 · ngLim 2.5g · M_MO 0.84',
  'RGN-J':   'Regional jet · E190/CRJ900 · ngLim 2.5g · M_MO 0.83',
  'RGN-T':   'Regional turboprop · ATR72/Q400 · ngLim 2.5g · V_MO 245kt',
  'BIZ':     'Business jet · G650/GLEX/Falcon · ngLim 2.8g · M_MO 0.90',
  'MIL':     'Military transport · C-17/KC-135 · pitchEnv ±30°/15°',
  'LIGHT':   'Light GA · PC-12/TBM/Cirrus · ngLim 3.8g · V_MO 200kt',
  'OTHER':   'Mixed / unknown',
}

// ------ Hash helpers (deterministic synthesis) ------
function h32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}
function h32b(s: string, salt: string): number { return h32(s + salt) }

function pickClass(f: SFlight): AirframeClass {
  const t = (f.type || '').toUpperCase()
  if (/^(B77|B78|A35|A38|B74)/.test(t)) return 'WB-HVY'
  if (/^(B76|B75|A33|A34|A31[06])/.test(t)) return 'WB-T2'
  if (/^(B73|B3[89]M|A31[89]|A32|A22|A220)/.test(t)) return 'NB'
  if (/^(E17|E19|E29|CRJ|CL6|RJ|SU9|MD8)/.test(t)) return 'RGN-J'
  if (/^(AT[47]|DH8|Q40|DHC8|SF3|F50|JS3|SAAB|EMB1[12])/.test(t)) return 'RGN-T'
  if (/^(GLEX|GL5T|G650|GLF|FA8X|FA50|FA7X|GLF6|C56X|C68A|E55P|PC24)/.test(t)) return 'BIZ'
  if (/^(C17|C5|KC|C130|C40|C32|E3|P8|VC25)/.test(t)) return 'MIL'
  if (/^(C172|C182|PC12|TBM|SR22|DA40|DA42|PA28|PA46|M20|BE9)/.test(t)) return 'LIGHT'
  const c = (f.category || '').toUpperCase()
  if (c === 'A5') return 'WB-HVY'
  if (c === 'A4') return 'WB-T2'
  if (c === 'A3') return 'NB'
  if (c === 'A2') return 'RGN-T'
  if (c === 'A1') return 'LIGHT'
  if (c === 'A7') return 'BIZ'
  return 'OTHER'
}

function classifyPhase(f: SFlight): Phase {
  if (f.ground) return 'OFF'
  const fl = f.altitudeFt / 100
  // Initial-climb / takeoff
  if (fl < 15 && f.vertRate > 800) return 'TKO'
  if (fl < 15 && f.vertRate >= -100 && f.vertRate <= 800) return 'INIT-CLB'
  if (fl < 30 && f.vertRate > 500) return 'INIT-CLB'
  // Go-around
  if (fl < 30 && f.vertRate > 300 && f.velocityKts < 200) return 'GA'
  // Approach
  if (fl < 15 && f.vertRate < -100) return 'FLARE'
  if (fl < 30 && f.vertRate < -300) return 'APP-FNL'
  if (fl < 150 && f.vertRate < -500) return 'APP-INT'
  // Climb / cruise / descent
  if (f.vertRate > 300) return 'CLB'
  if (f.vertRate < -300) return 'DST'
  return 'CRZ'
}

// ------ ISA + sound-of-speed helpers (for IAS/Mach math) ------
function isaTempK(ftAlt: number): number {
  const m = ftAlt * 0.3048
  if (m <= 11000) return 288.15 - 0.0065 * m
  if (m <= 20000) return 216.65
  return 216.65 + 0.001 * (m - 20000)
}
function isaPressurePa(ftAlt: number): number {
  const m = ftAlt * 0.3048
  if (m <= 11000) {
    const T = 288.15 - 0.0065 * m
    return 101325 * Math.pow(T / 288.15, 5.2561)
  }
  return 22632 * Math.exp(-0.0001577 * (m - 11000))
}
function machFromTas(tasKt: number, altFt: number): number {
  const T = isaTempK(altFt)
  const a = Math.sqrt(1.4 * 287.05 * T) * 1.94384 // a in kt
  return tasKt / Math.max(1, a)
}
function tasToIas(tasKt: number, altFt: number): number {
  // Crude IAS from TAS via sqrt(σ) — adequate for envelope visualisation
  const P = isaPressurePa(altFt)
  const T = isaTempK(altFt)
  const rho = P / (287.05 * T)
  const sigma = rho / 1.225
  return tasKt * Math.sqrt(Math.max(0.05, sigma))
}

// Synthetic upset state — deterministic per ICAO hash + airframe + phase.
interface UpsetState {
  pitchDeg: number       // signed pitch (deg, + nose-up)
  bankDeg: number        // signed bank (deg, + right wing-down)
  alphaDeg: number       // angle of attack (deg)
  iasKt: number          // calibrated indicated airspeed (kt)
  mach: number           // Mach number
  gz: number             // vertical load factor (g)
  altRecover: number     // estimated AGL recovery margin (ft)
  turbEDR: number        // EDR (m^2/3 s^-1) turbulence index (0-1)
  wakeEnc: boolean       // wake encounter present
  autom: number          // automation state suspicion (0-1, higher = more risk)
  scenario: ScenarioId
}

type ScenarioId =
  | 'NORMAL'
  | 'MILD-TURB'
  | 'NEAR-STALL'
  | 'BANK-WAKE'
  | 'PITCH-NU-GA'
  | 'AF447-LIKE'
  | 'COLGAN-LIKE'
  | 'AIRASIA-LIKE'
  | 'ABX-LIKE'
  | 'USAIR427-LIKE'
  | 'CHINAAIR006-LIKE'
  | 'BIRGENAIR-LIKE'
  | 'ADAM574-LIKE'
  | 'TATARSTAN-LIKE'

const SCENARIO_PRECEDENT: Record<ScenarioId, string> = {
  'NORMAL':           '—',
  'MILD-TURB':        'mild turbulence encounter · within envelope',
  'NEAR-STALL':       'sub-shaker α buffer · approach phase',
  'BANK-WAKE':        'wake encounter rolling departure',
  'PITCH-NU-GA':      'go-around pitch-up excursion',
  'AF447-LIKE':       'AF447-like UAS+aft-stick+ALT-LAW stall (A330 F-GZCP · BEA F-CP090601 · 2009-06-01 · 228 fatal)',
  'COLGAN-LIKE':      'Colgan 3407-like AERO-STALL low-altitude (Q400 N200WQ · NTSB AAR-10-01 · 2009-02-12 · 50 fatal)',
  'AIRASIA-LIKE':     'AirAsia 8501-like RTLU+CB+ALT-LAW pitch-bank stall (A320 PK-AXC · KNKT 32-12-12 · 2014-12-28 · 162 fatal)',
  'ABX-LIKE':         'ABX 3591-like somatogravic ND inadvertent GA-mode pitch (B767 N1217A · NTSB DCA19MA086 · 2019-02-23 · 3 fatal)',
  'USAIR427-LIKE':    'USAir 427-like PCU hardover rudder roll departure (B737 N513AU · NTSB AAR-99-01 · 1994-09-08 · 132 fatal)',
  'CHINAAIR006-LIKE': 'China Air 006-like #4-flame-out rolling dive recovery (B747SP N4522V · NTSB AAR-86-03 · 1985-02-19 · 0 fatal)',
  'BIRGENAIR-LIKE':   'Birgenair 301-like UAS pitch-up stall (B757 TC-GEN · DGAC Dom Rep · 1996-02-06 · 189 fatal)',
  'ADAM574-LIKE':     'Adam Air 574-like IRS head-down roll departure (B737-400 PK-KKW · KNKT 07-26-VWB · 2007-01-01 · 102 fatal)',
  'TATARSTAN-LIKE':   'Tatarstan 363-like inadvertent-GA pitch-up runaway ND penetration (B735 VQ-BBN · IAC final · 2013-11-17 · 50 fatal)',
}

const SCENARIO_MECH: Record<ScenarioId, Mechanism> = {
  'NORMAL':           'NORMAL',
  'MILD-TURB':        'ENVIRONMENT',
  'NEAR-STALL':       'AERODYNAMIC',
  'BANK-WAKE':        'ENVIRONMENT',
  'PITCH-NU-GA':      'PILOT-INDUCED',
  'AF447-LIKE':       'AUTOMATION-INDUCED',
  'COLGAN-LIKE':      'AERODYNAMIC',
  'AIRASIA-LIKE':     'SYSTEM-INDUCED',
  'ABX-LIKE':         'PILOT-INDUCED',
  'USAIR427-LIKE':    'SYSTEM-INDUCED',
  'CHINAAIR006-LIKE': 'SYSTEM-INDUCED',
  'BIRGENAIR-LIKE':   'PILOT-INDUCED',
  'ADAM574-LIKE':     'SYSTEM-INDUCED',
  'TATARSTAN-LIKE':   'PILOT-INDUCED',
}

function synthState(f: SFlight, klass: AirframeClass, basePhase: Phase): { state: UpsetState; phase: Phase } {
  const spec = AIRFRAME_SPEC[klass]
  const r  = h32(f.icao + 'uprt')
  const r2 = h32b(f.icao + klass, 'b')
  const r3 = h32b(f.icao + klass, 'c')
  const r4 = h32b(f.icao + klass, 'd')

  // Scenario sampling — cascade scenarios are rare events (<5% combined).
  let scenario: ScenarioId = 'NORMAL'
  if (basePhase === 'OFF') {
    scenario = 'NORMAL'
  } else if (basePhase === 'TKO' || basePhase === 'INIT-CLB') {
    if (r < 0.85) scenario = 'NORMAL'
    else if (r < 0.92) scenario = 'MILD-TURB'
    else if (r < 0.97) scenario = 'NEAR-STALL'
    else if (r < 0.985) scenario = 'COLGAN-LIKE'
    else scenario = 'BIRGENAIR-LIKE'
  } else if (basePhase === 'APP-FNL' || basePhase === 'FLARE') {
    if (r < 0.80) scenario = 'NORMAL'
    else if (r < 0.88) scenario = 'MILD-TURB'
    else if (r < 0.95) scenario = 'NEAR-STALL'
    else if (r < 0.975) scenario = 'ABX-LIKE'
    else if (r < 0.99) scenario = 'TATARSTAN-LIKE'
    else scenario = 'AIRASIA-LIKE'
  } else if (basePhase === 'GA') {
    if (r < 0.70) scenario = 'PITCH-NU-GA'
    else if (r < 0.92) scenario = 'NORMAL'
    else if (r < 0.97) scenario = 'TATARSTAN-LIKE'
    else scenario = 'PITCH-NU-GA'
  } else if (basePhase === 'APP-INT') {
    if (r < 0.86) scenario = 'NORMAL'
    else if (r < 0.93) scenario = 'MILD-TURB'
    else if (r < 0.97) scenario = 'BANK-WAKE'
    else if (r < 0.99) scenario = 'NEAR-STALL'
    else scenario = 'ABX-LIKE'
  } else if (basePhase === 'CRZ') {
    if (r < 0.86) scenario = 'NORMAL'
    else if (r < 0.93) scenario = 'MILD-TURB'
    else if (r < 0.965) scenario = 'BANK-WAKE'
    else if (r < 0.98) scenario = 'AF447-LIKE'
    else if (r < 0.99) scenario = 'CHINAAIR006-LIKE'
    else scenario = 'USAIR427-LIKE'
  } else if (basePhase === 'CLB' || basePhase === 'DST') {
    if (r < 0.88) scenario = 'NORMAL'
    else if (r < 0.94) scenario = 'MILD-TURB'
    else if (r < 0.975) scenario = 'BANK-WAKE'
    else if (r < 0.99) scenario = 'ADAM574-LIKE'
    else scenario = 'AF447-LIKE'
  } else {
    scenario = 'NORMAL'
  }

  // Derive nominal values
  const altFt = Math.max(0, f.altitudeFt)
  const tasKt = Math.max(20, f.velocityKts)
  const iasNominal = tasToIas(tasKt, altFt)
  const machNominal = machFromTas(tasKt, altFt)

  let pitchDeg = 0
  let bankDeg = (r2 - 0.5) * 8         // ±4° gentle nominal
  let alphaDeg = 2.0 + r3 * 3          // 2-5° cruise α nominal
  let iasKt = iasNominal
  let mach = machNominal
  let gz = 0.98 + r4 * 0.04           // 0.98 - 1.02g nominal
  let altRecover = altFt + 500
  let turbEDR = 0.04 + r2 * 0.04       // benign 0.04-0.08
  let wakeEnc = false
  let autom = 0.1 + r3 * 0.15

  // Pitch baseline from VS / TAS — climb/descent pitch ≈ atan(vs / tas·101)
  if (Math.abs(f.vertRate) > 50 && tasKt > 50) {
    const baseP = Math.atan2(f.vertRate / 60, (tasKt * 6076.12 / 3600)) * 180 / Math.PI
    pitchDeg = baseP
  }

  switch (scenario) {
    case 'NORMAL':
      break
    case 'MILD-TURB':
      bankDeg += (r3 - 0.5) * 12
      pitchDeg += (r4 - 0.5) * 6
      gz = 0.85 + r2 * 0.30  // 0.85-1.15g
      turbEDR = 0.15 + r3 * 0.20
      break
    case 'NEAR-STALL':
      alphaDeg = spec.alphaStallDeg - (1 + r3 * 2.5)  // 1-3.5° below stall
      iasKt = spec.vsoKt * (1.10 + r4 * 0.10)
      pitchDeg = pitchDeg + (4 + r2 * 4)
      autom = 0.25 + r3 * 0.20
      break
    case 'BANK-WAKE':
      bankDeg = (r3 < 0.5 ? -1 : 1) * (35 + r2 * 25)   // 35-60°
      gz = 0.85 + r4 * 0.55                            // 0.85-1.40g
      wakeEnc = true
      turbEDR = 0.35 + r3 * 0.30
      break
    case 'PITCH-NU-GA':
      pitchDeg = 18 + r2 * 12                          // 18-30°
      iasKt = spec.vs1gKt * (1.05 + r4 * 0.12)
      gz = 1.10 + r3 * 0.30
      autom = 0.30 + r2 * 0.25
      break
    case 'AF447-LIKE':
      pitchDeg = 25 + r2 * 12                          // 25-37° NU
      bankDeg = (r3 < 0.5 ? -1 : 1) * (10 + r4 * 16)
      alphaDeg = spec.alphaStallDeg + 1 + r2 * 4       // post-stall
      iasKt = spec.vs1gKt * (0.65 + r3 * 0.20)
      gz = 0.55 + r4 * 0.30
      autom = 0.85 + r3 * 0.10
      altRecover = Math.max(0, altFt - 35000)          // cruise alt loss
      break
    case 'COLGAN-LIKE':
      pitchDeg = 22 + r2 * 12                          // 22-34° NU
      bankDeg = (r3 < 0.5 ? -1 : 1) * (45 + r4 * 60)   // 45-105°
      alphaDeg = spec.alphaStallDeg + 2 + r2 * 3
      iasKt = spec.vsoKt * (0.85 + r3 * 0.10)
      gz = 0.65 + r4 * 0.35
      altRecover = Math.max(0, altFt - 1500)
      autom = 0.55 + r3 * 0.20
      break
    case 'AIRASIA-LIKE':
      pitchDeg = 30 + r2 * 12                          // 30-42°
      bankDeg = (r3 < 0.5 ? -1 : 1) * (40 + r4 * 25)   // 40-65°
      alphaDeg = spec.alphaStallDeg + 3 + r2 * 3
      iasKt = spec.vs1gKt * (0.60 + r3 * 0.20)
      gz = 0.50 + r4 * 0.40
      autom = 0.80 + r3 * 0.15
      altRecover = Math.max(0, altFt - 30000)
      break
    case 'ABX-LIKE':
      pitchDeg = -(35 + r2 * 20)                       // -35° to -55° ND
      bankDeg = (r3 - 0.5) * 30
      iasKt = iasNominal * (1.10 + r4 * 0.15)
      gz = 1.40 + r3 * 0.80
      autom = 0.65 + r4 * 0.20
      altRecover = Math.max(0, altFt - 6000)
      break
    case 'USAIR427-LIKE':
      bankDeg = (r3 < 0.5 ? -1 : 1) * (70 + r4 * 40)   // 70-110°
      pitchDeg = -(15 + r2 * 25)                       // ND penetration
      gz = 0.45 + r4 * 0.50
      autom = 0.30 + r3 * 0.15
      altRecover = Math.max(0, altFt - 5000)
      break
    case 'CHINAAIR006-LIKE':
      bankDeg = (r3 < 0.5 ? -1 : 1) * (90 + r4 * 80)   // 90-170° (rolling)
      pitchDeg = -(30 + r2 * 30)
      iasKt = iasNominal * (1.20 + r4 * 0.15)
      mach = Math.min(spec.mmo * 1.05, machNominal * (1.10 + r2 * 0.10))
      gz = 3.50 + r4 * 1.5
      autom = 0.50 + r3 * 0.15
      altRecover = Math.max(0, altFt - 30000)
      break
    case 'BIRGENAIR-LIKE':
      pitchDeg = 25 + r2 * 10                          // 25-35° NU
      bankDeg = (r3 - 0.5) * 35
      alphaDeg = spec.alphaStallDeg + 2 + r2 * 3
      iasKt = spec.vs1gKt * (0.80 + r3 * 0.10)
      autom = 0.60 + r4 * 0.20
      gz = 0.70 + r4 * 0.25
      altRecover = Math.max(0, altFt - 2000)
      break
    case 'ADAM574-LIKE':
      bankDeg = (r3 < 0.5 ? -1 : 1) * (80 + r4 * 30)   // 80-110°
      pitchDeg = -(20 + r2 * 25)
      gz = 0.40 + r4 * 0.50
      autom = 0.75 + r3 * 0.20
      altRecover = Math.max(0, altFt - 30000)
      break
    case 'TATARSTAN-LIKE':
      pitchDeg = -(60 + r2 * 20)                       // -60° to -80°
      bankDeg = (r3 - 0.5) * 30
      iasKt = iasNominal * (1.25 + r4 * 0.20)
      gz = 2.50 + r3 * 1.0
      autom = 0.60 + r2 * 0.20
      altRecover = Math.max(0, altFt - 3000)
      break
  }

  pitchDeg = Math.max(-90, Math.min(90, pitchDeg))
  bankDeg = Math.max(-180, Math.min(180, bankDeg))
  alphaDeg = Math.max(-5, Math.min(25, alphaDeg))
  iasKt = Math.max(20, Math.min(550, iasKt))
  mach = Math.max(0.10, Math.min(1.05, mach))
  gz = Math.max(-2, Math.min(7, gz))

  const state: UpsetState = {
    pitchDeg, bankDeg, alphaDeg, iasKt, mach, gz, altRecover,
    turbEDR, wakeEnc, autom, scenario,
  }
  return { state, phase: basePhase }
}

interface Assess {
  f: SFlight
  klass: AirframeClass
  phase: Phase
  state: UpsetState
  drivers: Record<Driver, number>
  category: Category
  mechanism: Mechanism
  score: number
  tier: Tier
  rationale: string
  worst: Driver
  weightedMean: number
}

function scoreFlight(f: SFlight, advMul: number, envMul: number): Assess {
  const klass = pickClass(f)
  const spec = AIRFRAME_SPEC[klass]
  const basePhase = classifyPhase(f)
  const { state, phase } = synthState(f, klass, basePhase)

  const drivers: Record<Driver, number> = {
    'ATT-PITCH': 0, 'ATT-BANK': 0, 'ENERGY': 0, 'MARGIN-V': 0,
    'G-LOAD': 0, 'AUTOM': 0, 'ENV': 0,
  }

  // ATT-PITCH: 0 at <10° NU / <5° ND nominal; scale through 25° NU / 10° ND AUPRTA threshold
  const p = state.pitchDeg
  if (p >= 0) {
    // Nose-up
    if (p < 5) drivers['ATT-PITCH'] = p * 1.0
    else if (p < spec.pitchEnvNu) drivers['ATT-PITCH'] = 5 + ((p - 5) / (spec.pitchEnvNu - 5)) * 45
    else drivers['ATT-PITCH'] = Math.min(100, 50 + ((p - spec.pitchEnvNu) / 10) * 50)
  } else {
    const pa = -p
    if (pa < 3) drivers['ATT-PITCH'] = pa * 1.5
    else if (pa < spec.pitchEnvNd) drivers['ATT-PITCH'] = 4.5 + ((pa - 3) / (spec.pitchEnvNd - 3)) * 45
    else drivers['ATT-PITCH'] = Math.min(100, 50 + ((pa - spec.pitchEnvNd) / 8) * 50)
  }

  // ATT-BANK: 0 at <10° nominal; scale through 45° AUPRTA threshold; >60° hard escalator
  const ba = Math.abs(state.bankDeg)
  if (ba < 10) drivers['ATT-BANK'] = ba * 0.5
  else if (ba < 45) drivers['ATT-BANK'] = 5 + ((ba - 10) / 35) * 50
  else if (ba < 60) drivers['ATT-BANK'] = 55 + ((ba - 45) / 15) * 25
  else drivers['ATT-BANK'] = Math.min(100, 80 + ((ba - 60) / 30) * 20)

  // ENERGY: balance KE+PE; speed-appropriate-for-altitude proxy
  // Low-energy: ias < 1.10·vs1g with phase != cruise → high score
  // High-energy: ias > 0.95·vmo or mach > 0.95·mmo → high score
  const vRatLow = state.iasKt / Math.max(40, spec.vs1gKt * 1.10)
  const vRatHigh = Math.max(state.iasKt / spec.vmoKt, state.mach / spec.mmo)
  let energyScore = 0
  if (vRatLow < 0.85) energyScore = Math.min(100, (0.85 - vRatLow) * 220)
  else if (vRatLow < 1.05) energyScore = (1.05 - vRatLow) * 30
  if (vRatHigh > 0.85) energyScore = Math.max(energyScore, Math.min(100, (vRatHigh - 0.85) * 250))
  drivers['ENERGY'] = energyScore

  // MARGIN-V: explicit Vs1g·1.13 lower / 0.97·VMO upper margin
  let mv = 0
  const vLowGate = spec.vs1gKt * 1.13
  const vHighGate = spec.vmoKt * 0.97
  if (state.iasKt < vLowGate) mv = Math.max(mv, Math.min(100, (vLowGate - state.iasKt) / vLowGate * 220))
  if (state.iasKt > vHighGate) mv = Math.max(mv, Math.min(100, (state.iasKt - vHighGate) / vHighGate * 320))
  if (state.mach > spec.mmo * 0.97) mv = Math.max(mv, Math.min(100, (state.mach - spec.mmo * 0.97) / spec.mmo * 600))
  drivers['MARGIN-V'] = mv

  // G-LOAD: deviation from 1g
  const dg = Math.abs(state.gz - 1.0)
  if (dg < 0.15) drivers['G-LOAD'] = dg * 30
  else if (state.gz > 1.0) drivers['G-LOAD'] = Math.min(100, 4.5 + (state.gz - 1.15) / Math.max(0.1, spec.ngLim - 1.15) * 95)
  else drivers['G-LOAD'] = Math.min(100, 4.5 + (0.85 - state.gz) / 0.85 * 95)

  // AUTOM: synthetic 0-1 → 0-100
  drivers['AUTOM'] = Math.min(100, state.autom * 100)

  // ENV: turbulence EDR + wake enc + multiplier
  let envS = state.turbEDR * 160
  if (state.wakeEnc) envS = Math.max(envS, 55)
  envS *= envMul / 100
  drivers['ENV'] = Math.min(100, envS)

  // ADV-MUL
  const mul = advMul / 100
  for (const d of DRIVERS) drivers[d] = Math.min(100, drivers[d] * mul)

  // Stall α escalator — bake into ATT-PITCH driver as α extreme overrides pitch
  if (state.alphaDeg >= spec.alphaStallDeg) {
    drivers['ATT-PITCH'] = Math.max(drivers['ATT-PITCH'], 70)
  } else if (state.alphaDeg >= spec.alphaStallDeg - 2) {
    drivers['ATT-PITCH'] = Math.max(drivers['ATT-PITCH'], 50)
  }

  // Weighted mean
  let wm = 0, wsum = 0
  for (const d of DRIVERS) { wm += drivers[d] * DRIVER_WEIGHT[d]; wsum += DRIVER_WEIGHT[d] }
  const weightedMean = wsum > 0 ? wm / wsum : 0

  // Worst driver
  let worst: Driver = 'ATT-PITCH'; let bestV = -1
  for (const d of DRIVERS) if (drivers[d] > bestV) { bestV = drivers[d]; worst = d }

  // Categorise
  const pitchHigh = p > spec.pitchEnvNu || (state.alphaDeg >= spec.alphaStallDeg && p > 8)
  const pitchLow = p < -spec.pitchEnvNd
  const bankHigh = ba > 45
  const stalled = state.alphaDeg >= spec.alphaStallDeg
  const underSpeed = state.iasKt < spec.vs1gKt * 1.10
  const overSpeed = state.iasKt > spec.vmoKt * 0.97 || state.mach > spec.mmo * 0.97
  const corners = [pitchHigh, pitchLow, bankHigh, underSpeed, overSpeed, stalled].filter(Boolean).length

  let category: Category = 'NEUTRAL'
  if (corners >= 2) category = 'DUAL-ENV'
  else if (stalled) category = 'AERO-STALL'
  else if (pitchHigh) category = 'HIGH-PITCH-NU'
  else if (pitchLow) category = 'HIGH-PITCH-ND'
  else if (bankHigh) category = 'HIGH-BANK'
  else if (underSpeed) category = 'UNDER-SPEED'
  else if (overSpeed) category = 'OVER-SPEED'

  const mechanism: Mechanism = SCENARIO_MECH[state.scenario]

  // Composite: max(0.65·worst, 0.35·mean) + 0.35·mean
  let composite = Math.max(0.65 * bestV, 0.35 * weightedMean) + 0.35 * weightedMean
  composite *= PHASE_MUL[phase]

  // Hard escalators
  if (Math.abs(state.pitchDeg) > 30 && p > 0) composite = Math.max(composite, 88)
  if (state.pitchDeg < -15) composite = Math.max(composite, 88)
  if (ba > 60) composite = Math.max(composite, 85)
  if (stalled) composite = Math.max(composite, 80)
  if (category === 'DUAL-ENV') composite = Math.max(composite, 78)

  const score = Math.min(100, Math.max(0, composite))
  const tier = tierFromScore(score)

  // Rationale
  let rationale = ''
  const pstr = `${state.pitchDeg >= 0 ? '+' : ''}${state.pitchDeg.toFixed(0)}°P`
  const bstr = `${Math.abs(state.bankDeg).toFixed(0)}°${state.bankDeg < 0 ? 'L' : 'R'}B`
  const vstr = `${Math.round(state.iasKt)}kt M${state.mach.toFixed(2)}`
  const gstr = `${state.gz.toFixed(2)}g`
  if (tier === 'CRITICAL') {
    rationale = `CRITICAL ${category} — ${pstr} ${bstr} ${vstr} ${gstr} on ${klass}; AUPRTA Rev 3 ${mechanism} class. APPLY recovery: push, roll wings level, thrust, pitch to attitude. Reference FCTM upset recovery.`
  } else if (tier === 'RECOVERY') {
    rationale = `RECOVERY ${category} — ${pstr} ${bstr} ${vstr} on ${klass}; AUPRTA recovery procedure required (push/roll/thrust/pitch). ${state.altRecover < 5000 ? `${Math.round(state.altRecover)}ft AGL margin — execute now.` : ''}`
  } else if (tier === 'UPSET') {
    rationale = `UPSET corner approached — ${category} on ${klass}; ${pstr} ${bstr} ${vstr}; verify FMA, monitor pitch/bank, re-stabilise on attitude indicator.`
  } else if (tier === 'MARGIN') {
    rationale = `MARGIN elevated — ${category} on ${klass}; mild excursion from nominal envelope; monitor energy state.`
  } else if (tier === 'CLEAR') {
    rationale = `CLEAR — within AUPRTA envelope on ${klass}; ${PHASE_DESC[phase]}.`
  } else {
    rationale = `NEUTRAL — ${PHASE_DESC[phase]}.`
  }
  if (state.scenario !== 'NORMAL' && state.scenario !== 'MILD-TURB' && state.scenario !== 'NEAR-STALL' &&
      state.scenario !== 'BANK-WAKE' && state.scenario !== 'PITCH-NU-GA') {
    rationale += ` Scenario: ${SCENARIO_PRECEDENT[state.scenario]}.`
  }

  return { f, klass, phase, state, drivers, category, mechanism, score, tier, rationale, worst, weightedMean }
}

const SRC = 'uprt-src'
const LBL = 'uprt-lbl'

export default function UprtUpset({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState<number>(100)
  const [envMul, setEnvMul] = useState<number>(100)
  const [minFL, setMinFL] = useState<number>(0)
  const [maxFL, setMaxFL] = useState<number>(450)
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL' | Phase>('ALL')
  const [catFilter, setCatFilter] = useState<'ALL' | Category>('ALL')
  const [classFilter, setClassFilter] = useState<'ALL' | AirframeClass>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CATEGORIES' | 'MECHANISMS' | 'PRECEDENT' | 'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState<string>('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showRing, setShowRing] = useState(true)

  const assessments = useMemo<Assess[]>(() => {
    const out: Assess[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      out.push(scoreFlight(f, advMul, envMul))
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.score - a.score
    })
    return out
  }, [flights, advMul, envMul, minFL, maxFL])

  const filtered = useMemo(() => {
    let xs = assessments
    if (tierFilter !== 'ALL') xs = xs.filter(a => a.tier === tierFilter)
    if (phaseFilter !== 'ALL') xs = xs.filter(a => a.phase === phaseFilter)
    if (catFilter !== 'ALL') xs = xs.filter(a => a.category === catFilter)
    if (classFilter !== 'ALL') xs = xs.filter(a => a.klass === classFilter)
    if (search) {
      const s = search.toLowerCase()
      xs = xs.filter(a =>
        (a.f.callsign || a.f.icao).toLowerCase().includes(s) ||
        (a.f.operator || '').toLowerCase().includes(s) ||
        (a.f.type || '').toLowerCase().includes(s) ||
        a.category.toLowerCase().includes(s) ||
        a.mechanism.toLowerCase().includes(s) ||
        a.state.scenario.toLowerCase().includes(s))
    }
    return xs
  }, [assessments, tierFilter, phaseFilter, catFilter, classFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL:0, RECOVERY:0, UPSET:0, MARGIN:0, CLEAR:0, NEUTRAL:0 }
    for (const a of assessments) c[a.tier]++
    return c
  }, [assessments])

  const catCounts = useMemo(() => {
    const c: Record<Category, { ac: number; crit: number; sumScore: number }> = {} as any
    for (const k of CATEGORIES) c[k] = { ac: 0, crit: 0, sumScore: 0 }
    for (const a of assessments) {
      if (a.tier === 'NEUTRAL') continue
      c[a.category].ac++
      c[a.category].sumScore += a.score
      if (a.tier === 'CRITICAL' || a.tier === 'RECOVERY') c[a.category].crit++
    }
    return c
  }, [assessments])

  const mechCounts = useMemo(() => {
    const c: Record<Mechanism, number> = { 'AERODYNAMIC':0, 'SYSTEM-INDUCED':0, 'ENVIRONMENT':0, 'PILOT-INDUCED':0, 'AUTOMATION-INDUCED':0, 'NORMAL':0 }
    for (const a of assessments) c[a.mechanism]++
    return c
  }, [assessments])

  const scenCounts = useMemo(() => {
    const c: Record<ScenarioId, number> = {} as any
    for (const k of Object.keys(SCENARIO_PRECEDENT)) c[k as ScenarioId] = 0
    for (const a of assessments) c[a.state.scenario]++
    return c
  }, [assessments])

  const meanScore = assessments.length ? (assessments.reduce((s, a) => s + a.score, 0) / assessments.length) : 0
  const worst = assessments[0]
  const totalCrit = counts.CRITICAL + counts.RECOVERY
  const totalDualEnv = assessments.filter(a => a.category === 'DUAL-ENV').length

  // ------ Map overlay ------
  useEffect(() => {
    const m = map
    if (!m) return
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    for (const a of filtered) {
      if (a.tier === 'NEUTRAL') continue
      const col = TIER_COLOR[a.tier]
      if (showHalo) {
        const r = 6 + Math.min(20, a.score * 0.22)
        features.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: r }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showRing && (a.tier === 'CRITICAL' || a.tier === 'RECOVERY')) {
        features.push({ type:'Feature', properties:{ kind:'ring', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showPin && (a.tier === 'CRITICAL' || a.tier === 'RECOVERY' || a.tier === 'UPSET')) {
        features.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLbl && (a.tier === 'CRITICAL' || a.tier === 'RECOVERY')) {
        const cs = a.f.callsign || a.f.icao.toUpperCase()
        const text = `${cs} ${a.category} ${a.state.pitchDeg >= 0 ? '+' : ''}${a.state.pitchDeg.toFixed(0)}°P ${Math.abs(a.state.bankDeg).toFixed(0)}°B`
        labels.push({ type:'Feature', properties:{ kind:'lbl', text, color: CATEGORY_COLOR[a.category] }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
    }
    try {
      for (const [id, fc] of [[SRC, features], [LBL, labels]] as Array<[string, GeoJSON.Feature[]]>) {
        if (!m.getSource(id)) m.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection })
        else (m.getSource(id) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection)
      }
      if (!m.getLayer('uprt-ring')) m.addLayer({ id:'uprt-ring', type:'circle', source:SRC, filter:['==',['get','kind'],'ring'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-radius':30, 'circle-opacity':0.55 } })
      if (!m.getLayer('uprt-halo')) m.addLayer({ id:'uprt-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.8 } })
      if (!m.getLayer('uprt-pin')) m.addLayer({ id:'uprt-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':5 } })
      if (!m.getLayer('uprt-lbl')) m.addLayer({ id:'uprt-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['uprt-ring','uprt-halo','uprt-pin','uprt-lbl'])
          if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showRing])

  // Tiny SVG attitude indicator for selected/worst aircraft view
  function AttitudeBadge({ pitch, bank, size = 38 }: { pitch: number; bank: number; size?: number }) {
    const half = size / 2
    const horizonY = half + Math.tan(pitch * Math.PI / 180) * half * 0.35
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="inline-block">
        <defs>
          <clipPath id={`uprt-clip-${pitch.toFixed(0)}-${bank.toFixed(0)}-${size}`}>
            <circle cx={half} cy={half} r={half - 1} />
          </clipPath>
        </defs>
        <g clipPath={`url(#uprt-clip-${pitch.toFixed(0)}-${bank.toFixed(0)}-${size})`} transform={`rotate(${-bank} ${half} ${half})`}>
          <rect x={-half} y={-size} width={size * 2} height={horizonY + size} fill="#0ea5e9" />
          <rect x={-half} y={horizonY} width={size * 2} height={size * 2} fill="#78350f" />
          <line x1={-half} y1={horizonY} x2={size + half} y2={horizonY} stroke="#fef3c7" strokeWidth={1} />
        </g>
        <circle cx={half} cy={half} r={half - 0.5} fill="none" stroke="#475569" strokeWidth={1} />
        <line x1={half - 8} y1={half} x2={half - 3} y2={half} stroke="#f1f5f9" strokeWidth={1.5} />
        <line x1={half + 3} y1={half} x2={half + 8} y2={half} stroke="#f1f5f9" strokeWidth={1.5} />
        <line x1={half} y1={half - 1} x2={half} y2={half + 2} stroke="#f1f5f9" strokeWidth={1.5} />
      </svg>
    )
  }

  return (
    <div className="absolute top-16 right-4 z-30 w-[520px] max-h-[84vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">UPRT</span>
          <span className="text-[10px] text-slate-500">AUPRTA Rev 3 · ICAO Doc 10011 · AC 120-111 · AF447 · Colgan 3407</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm px-1" aria-label="Close">✕</button>
      </div>

      {/* Tier strip */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        {TIERS.map(t => {
          const active = tierFilter === t
          return (
            <button key={t}
              onClick={() => setTierFilter(active ? 'ALL' : t)}
              className={`px-1 py-1.5 flex flex-col items-center ${active ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
              <span style={{ color: TIER_COLOR[t] }} className="font-semibold">{counts[t]}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{t}</span>
            </button>
          )
        })}
        <button
          onClick={() => setTierFilter('ALL')}
          className={`px-1 py-1.5 flex flex-col items-center ${tierFilter === 'ALL' ? 'bg-sky-500/15 ring-1 ring-sky-500/40' : 'bg-slate-900 hover:bg-slate-800'}`}>
          <span className="text-slate-200 font-semibold">{assessments.length}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">ALL</span>
        </button>
      </div>

      {/* Summary cells */}
      <div className="grid grid-cols-4 gap-px bg-slate-800/70 border-b border-slate-700/70 text-[10px] font-mono">
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">μ-Score</div>
          <div className="text-slate-100">{meanScore.toFixed(1)}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Worst</div>
          <div className="text-slate-100 truncate">{worst ? (worst.f.callsign || worst.f.icao.toUpperCase()) : '—'}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Crit+Rec</div>
          <div style={{ color: totalCrit > 0 ? TIER_COLOR.CRITICAL : '#94a3b8' }}>{totalCrit}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Dual-Env</div>
          <div style={{ color: totalDualEnv > 0 ? TIER_COLOR.RECOVERY : '#94a3b8' }}>{totalDualEnv}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['ENV-MUL', envMul, setEnvMul, 50, 250, '%'],
          ['MIN-FL', minFL, setMinFL, 0, 200, ''],
          ['MAX-FL', maxFL, setMaxFL, 50, 450, ''],
        ] as Array<[string, number, (n:number)=>void, number, number, string]>).map(([lbl, v, set, lo, hi, u]) => (
          <div key={lbl} className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-mono w-14">{lbl}</span>
            <input type="range" min={lo} max={hi} value={v} onChange={e => set(Number(e.target.value))} className="flex-1 accent-sky-500" />
            <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{v}{u}</span>
          </div>
        ))}
      </div>

      {/* Category chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setCatFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${catFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {CATEGORIES.map(c => {
          const active = catFilter === c
          const cnt = catCounts[c].ac
          return (
            <button key={c} onClick={() => setCatFilter(active ? 'ALL' : c)}
              disabled={cnt === 0 && !active}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : cnt === 0 ? 'border-slate-800 text-slate-700' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              title={CATEGORY_DESC[c]}>
              <span style={{ color: CATEGORY_COLOR[c] }}>●</span> {c.replace('HIGH-PITCH-','HP-').replace('HIGH-BANK','HBK').replace('UNDER-SPEED','USPD').replace('OVER-SPEED','OSPD').replace('AERO-STALL','STALL').replace('DUAL-ENV','DUAL').replace('NEUTRAL','NTR')}
            </button>
          )
        })}
      </div>

      {/* Phase chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setPhaseFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {PHASES.filter(p => p !== 'OFF').map(p => {
          const active = phaseFilter === p
          return (
            <button key={p} onClick={() => setPhaseFilter(active ? 'ALL' : p)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              title={PHASE_DESC[p]}>
              {p}
            </button>
          )
        })}
      </div>

      {/* Class chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setClassFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {AIRFRAMES.map(c => {
          const active = classFilter === c
          return (
            <button key={c} onClick={() => setClassFilter(active ? 'ALL' : c)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              title={CLASS_DESC[c]}>
              {c}
            </button>
          )
        })}
      </div>

      {/* Toggles + search */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5 flex-wrap">
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['RING',showRing,setShowRing]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
        <div className="flex-1" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/cat/mech"
          className="w-44 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        {(['AIRCRAFT','CATEGORIES','MECHANISMS','PRECEDENT','METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-sky-500/15 ring-1 ring-sky-500/40 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{t}</button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800/70">
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px] text-slate-500">No flights match filters.</div>}
            {filtered.slice(0, 250).map(a => {
              const col = TIER_COLOR[a.tier]
              const cCol = CATEGORY_COLOR[a.category]
              const st = a.state
              return (
                <button key={a.f.icao}
                  onClick={() => onFly(a.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <AttitudeBadge pitch={st.pitchDeg} bank={st.bankDeg} size={26} />
                        <span className="text-slate-100 font-semibold">{a.f.callsign || a.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{a.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.klass}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: cCol + '25', color: cCol }}>{a.category}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.phase}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{a.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{String(Math.round(a.f.altitudeFt / 100)).padStart(3,'0')}</span>
                        <span>{Math.round(st.iasKt)}kt</span>
                        <span>M{st.mach.toFixed(2)}</span>
                        <span style={{ color: a.f.vertRate > 200 ? '#10b981' : a.f.vertRate < -200 ? '#f59e0b' : '#94a3b8' }}>{a.f.vertRate > 0 ? '↑' : a.f.vertRate < 0 ? '↓' : '→'}{Math.abs(Math.round(a.f.vertRate))}fpm</span>
                        <span className="text-slate-500 truncate ml-auto">{a.f.operator || ''}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span style={{ color: Math.abs(st.pitchDeg) > 25 ? TIER_COLOR.CRITICAL : Math.abs(st.pitchDeg) > 15 ? TIER_COLOR.UPSET : '#94a3b8' }}>{st.pitchDeg >= 0 ? '+' : ''}{st.pitchDeg.toFixed(0)}°P</span>
                        <span style={{ color: Math.abs(st.bankDeg) > 45 ? TIER_COLOR.CRITICAL : Math.abs(st.bankDeg) > 30 ? TIER_COLOR.UPSET : '#94a3b8' }}>{Math.abs(st.bankDeg).toFixed(0)}°{st.bankDeg < 0 ? 'L' : 'R'}B</span>
                        <span style={{ color: st.alphaDeg > AIRFRAME_SPEC[a.klass].alphaStallDeg - 1 ? TIER_COLOR.CRITICAL : st.alphaDeg > AIRFRAME_SPEC[a.klass].alphaStallDeg - 3 ? TIER_COLOR.UPSET : '#94a3b8' }}>α{st.alphaDeg.toFixed(1)}°</span>
                        <span style={{ color: Math.abs(st.gz - 1) > 0.5 ? TIER_COLOR.UPSET : '#94a3b8' }}>{st.gz.toFixed(2)}g</span>
                        {st.wakeEnc && <span className="text-[9px] px-1 py-0 rounded" style={{ background: '#f9731625', color: '#f97316' }}>WAKE</span>}
                        {st.altRecover < 3000 && a.tier !== 'NEUTRAL' && a.tier !== 'CLEAR' && <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: TIER_COLOR.CRITICAL + '25', color: TIER_COLOR.CRITICAL }}>RCV·{Math.round(st.altRecover)}ft</span>}
                      </div>
                      <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, a.score)}%`, background: col }} />
                      </div>
                      <div className="grid grid-cols-7 gap-0.5 mt-1 text-[9px] font-mono">
                        {DRIVERS.map(k => {
                          const s = a.drivers[k]
                          const muted = s < 6
                          return (
                            <div key={k} className="bg-slate-950/60 rounded px-1 py-0.5 flex flex-col items-center" title={DRIVER_DESC[k]}>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{k.replace('ATT-PITCH','PITCH').replace('ATT-BANK','BANK').replace('MARGIN-V','MARGIN').replace('G-LOAD','GZ')}</span>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{Math.round(s)}</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{a.rationale}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'CATEGORIES' && (
          <div className="divide-y divide-slate-800/70">
            {CATEGORIES.map(cat => {
              const info = catCounts[cat]
              const mean = info.ac > 0 ? info.sumScore / info.ac : 0
              const tier = info.ac > 0 ? tierFromScore(mean) : 'NEUTRAL'
              const col = TIER_COLOR[tier]
              const cCol = CATEGORY_COLOR[cat]
              return (
                <div key={cat} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: cCol }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span style={{ color: cCol }}>●</span>
                        <span className="text-slate-100 font-semibold">{cat}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{info.ac} ac</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{CATEGORY_DESC[cat]}</div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        {info.crit > 0 && <span style={{ color: TIER_COLOR.CRITICAL }}>{info.crit} crit+rec</span>}
                        {info.ac > 0 && <span className="ml-auto">μ {mean.toFixed(1)}</span>}
                      </div>
                      {info.ac > 0 && (
                        <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                          <div className="h-full" style={{ width: `${Math.min(100, mean)}%`, background: col }} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'MECHANISMS' && (
          <div className="divide-y divide-slate-800/70">
            <div className="px-3 py-2 text-[10px] text-slate-400 leading-snug">
              <span className="text-slate-100 font-semibold">AUPRTA Rev 3 5-class upset mechanism taxonomy.</span>{' '}
              Each airframe's upset (if any) is mapped to one of five generative mechanism classes per
              ICAO Doc 10011 §3 / FAA AC 120-111 App.2 / AUPRTA Rev 3 §2.4.
            </div>
            {(Object.keys(MECHANISM_DESC) as Mechanism[]).map(m => {
              const c = mechCounts[m]
              const col = m === 'NORMAL' ? TIER_COLOR.NEUTRAL : c > 0 ? TIER_COLOR.UPSET : TIER_COLOR.CLEAR
              return (
                <div key={m} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{m}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{c}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{MECHANISM_DESC[m]}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'PRECEDENT' && (
          <div className="divide-y divide-slate-800/70">
            <div className="px-3 py-2 text-[10px] text-slate-400 leading-snug">
              <span className="text-slate-100 font-semibold">LOC-I precedent library · deterministic-by-ICAO-hash scenario sampling.</span>{' '}
              Real per-airframe scenarios are sampled from the historical AUPRTA Rev 3 / CAST LOC-I accident catalogue.
              Counts below are CURRENT-tick samples — they reflect synthetic state for the visualisation.
            </div>
            {(Object.keys(SCENARIO_PRECEDENT) as ScenarioId[]).map(s => {
              const c = scenCounts[s]
              const isCascade = s.includes('-LIKE')
              const col = isCascade ? TIER_COLOR.RECOVERY : c > 0 ? TIER_COLOR.MARGIN : TIER_COLOR.NEUTRAL
              return (
                <div key={s} className="px-2 py-1.5">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-slate-100 font-semibold">{s}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{c}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{SCENARIO_PRECEDENT[s]}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[11px] text-slate-300 leading-snug space-y-2">
            <p>
              <span className="text-slate-100 font-semibold">UPRT — Upset Prevention &amp; Recovery Training Envelope &amp; Aircraft-Upset State Classifier.</span>{' '}
              Per-airframe live evaluator of the IATA/ICAO/FAA Aeroplane Upset Prevention &amp; Recovery Training Aid
              (AUPRTA) Rev 3 5-axis attitude/energy envelope: |pitch| &gt; 25° NU or &gt; 10° ND, |bank| &gt; 45°,
              IAS inappropriate for altitude/config, α approaching α_stall, inappropriate flight-path response.
              Classifies each airframe into one of 8 upset categories and maps to one of the 5-class AUPRTA Rev 3
              generative mechanism taxonomy.
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Driver scoring [0..100]:</span>
            </p>
            <ul className="text-[10px] font-mono space-y-0.5 ml-2 text-slate-400">
              {DRIVERS.map(d => (
                <li key={d}><span className="text-slate-200">{d}</span> · <span className="text-slate-500">w={Math.round(DRIVER_WEIGHT[d]*100)}%</span> · {DRIVER_DESC[d]}</li>
              ))}
            </ul>
            <p>
              <span className="text-slate-100 font-semibold">Composite</span>{' = '}
              <span className="font-mono">max(0.65·worst, 0.35·mean) + 0.35·mean</span>, then phase-multiplier
              (TKO 1.10 · INIT-CLB 1.25 · CLB 1.05 · CRZ 1.00 · DST 1.00 · APP-INT 1.10 · APP-FNL 1.35 · FLARE 1.50 · GA 1.40).
              Hard escalators: |pitch| &gt; 30° NU or &gt; 15° ND → floor 88 · |bank| &gt; 60° → floor 85 ·
              AERO-STALL warning → floor 80 · DUAL-ENV → floor 78.
            </p>
            <p>
              <span className="text-slate-100 font-semibold">Tiers:</span>{' '}
              CRITICAL ≥ 85 (active upset penetration) · RECOVERY ≥ 65 (AUPRTA recovery procedure required) ·
              UPSET ≥ 45 (envelope corner approached) · MARGIN ≥ 25 (elevated risk) · CLEAR ≥ 10 (within envelope) ·
              NEUTRAL &lt; 10 (benign).
            </p>
            <p>
              <span className="text-slate-100 font-semibold">AUPRTA Rev 3 5-class mechanism taxonomy:</span>{' '}
              AERODYNAMIC (Class-A · stall / α-departure) · SYSTEM-INDUCED (Class-B · RTLU / PCU hardover / ADIRU) ·
              ENVIRONMENT (Class-C · turbulence / wake / wind-shear / icing) · PILOT-INDUCED (Class-D · somatogravic /
              startle / inappropriate input) · AUTOMATION-INDUCED (Class-E · mode-confusion / Alt-Law).
            </p>
            <p>
              <span className="text-slate-100 font-semibold">LOC-I precedent library:</span>{' '}
              AF447 (A330 BEA F-CP090601 · 228 fatal · canonical AUTOM+AERO-STALL) ·
              Colgan 3407 (Q400 NTSB AAR-10-01 · 50 fatal · canonical AERO-STALL low-alt) ·
              AirAsia 8501 (A320 KNKT 32-12-12 · 162 fatal · SYSTEM-INDUCED) ·
              ABX 3591 (B767 NTSB DCA19MA086 · 3 fatal · PILOT-INDUCED somatogravic) ·
              USAir 427 (B737 NTSB AAR-99-01 · 132 fatal · SYSTEM-INDUCED PCU hardover) ·
              China Air 006 (B747SP NTSB AAR-86-03 · 0 fatal · canonical recovery from 270° rolling dive) ·
              Birgenair 301 (B757 DGAC Dom Rep · 189 fatal · PILOT-INDUCED UAS pitch-up) ·
              Adam Air 574 (B737-400 KNKT 07-26-VWB · 102 fatal · SYSTEM-INDUCED IRS) ·
              Tatarstan 363 (B735 IAC final · 50 fatal · PILOT-INDUCED inadvertent-GA).
            </p>
            <p className="text-slate-400">
              <span className="text-slate-200">Distinct from</span>{' '}
              STALL (single-axis 1g α-floor — one driver inside UPRT),
              DEEPSTL (post-stall T-tail Cm(α) reversal locked-in),
              DUTCH-ROLL (lateral-directional eigenmode damping),
              MACH-TUCK (transonic Cm(M) reversal at M_crit),
              PIO (closed-loop pilot-airframe Bandwidth/Phase-Delay coupling),
              VMC (asymmetric-thrust controllability floor),
              TEM-ENERGY (energy state monitor not attitude),
              FMA (automation mode-awareness only),
              COFFIN (Vmo-Mmo / Vs1g cruise convergence only),
              UAS (pitot/static sensor failure cascade).
              UPRT is uniquely the AGGREGATED airplane-upset envelope classifier — every other monitor
              feeds into one of the 7 drivers but UPRT is the integration layer.
            </p>
            <p className="text-slate-500 italic">
              References: ICAO Doc 10011 (2014) · FAA AC 120-111 (2015) · AC 120-109A (2015) · EASA AMC1 FCL.745.A ·
              IATA APS UPRT 2nd ed. (2019) · IATA LOC-I Accident Analysis 2019-2023 · AUPRTA Rev 3 (2017) ·
              14 CFR §25.143 / §25.181 / §25.203 / §25.255 · §121.423 / §121.424 · §61.155 / §61.157 ·
              Boeing FCTM 8.5 Upset Recovery · Airbus FCTM PRO-ABN-MISC Upset Recovery · Embraer AOM §03 ·
              CAST/ICAO CICTT LOC-I category · ICAO Annex 1 Ch 2 · Doc 9868 PANS-TRG App 2/3/4 · Doc 9683 HF ·
              Doc 9994 EBT Manual · NTSB AAR-10-01 / AAR-86-03 / AAR-99-01 / DCA19MA086 ·
              BEA F-CP090601 · KNKT 32-12-12 / 07-26-VWB · DGAC Dom Rep · IAC Tatarstan · ATSB AO-2008-070 ·
              FAA/NASA TM-2018-219997 LOC-I analysis · IATA STEADES 2024 §3.
            </p>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/70 text-[9px] text-slate-500 leading-snug">
        AUPRTA Rev 3 · ICAO Doc 10011 · AC 120-111 · EASA AMC1 FCL.745.A · 5-axis upset envelope · synthetic deterministic-by-ICAO-hash attitude sample, not live ARINC-429 data · planner/visualisation only, not a certified UPRT trainer.
      </div>
    </div>
  )
}
