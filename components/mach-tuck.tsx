'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   MACH-TUCK · Transonic Compressibility Tuck-Under & Mach-Trim
                 Compensator Authority Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of each cruising aircraft's
   proximity to the transonic compressibility tuck-under regime
   in which, as Mach number approaches M_crit (the free-stream
   Mach at which sonic flow first appears on the upper wing),
   shock-induced flow separation begins to migrate the wing
   center-of-pressure AFT, the resulting nose-down pitching
   moment ΔCm grows non-linearly with M·ΔM, the longitudinal
   trim solution drifts toward an UNSTABLE equilibrium
   (dCm/dM > 0 reverses sign), and unless the Mach Trim
   Compensator (MTC) drives the THS / variable-incidence
   stabiliser to inject a compensating nose-UP moment, the
   aircraft pitches over progressively into a runaway dive
   that quickly exceeds M_MO / V_MO and aeroelastic flutter
   onset — the classic "Mach Tuck" / "tuck-under" loss-of-
   control regime, also known as the "graveyard dive".

   Distinct from / complementary to existing overlays:
     · FLUTTER  aeroelastic eigen-mode V_f vs Vmo/Mmo per §25.629
                MACH-TUCK is the AERODYNAMIC pitch-moment reversal
                onset at M_crit < M_MO ≤ M_FLUTTER
     · STALL    low-α 1g α-floor and buffet — MACH-TUCK is high-Mach
                with NO α coupling required
     · DEEPSTL  post-stall T-tail pitch authority reversal at α=40°+
                MACH-TUCK is pre-stall in normal α range
     · COFFIN-CORNER  the convergence point where Vs1g·1.13 meets
                M_MO at high FL — MACH-TUCK is the descent dynamic
                away from M_MO toward and through M_crit
     · PIO      closed-loop handling quality bandwidth — MACH-TUCK
                is an open-loop aerodynamic moment reversal
     · GUST     §25.341 discrete vertical gust Δn structural load
     · VMC      OEI lateral-directional rudder-authority floor
     · TEM      total energy state (h + V²/2g)
   MACH-TUCK is uniquely the HIGH-SUBSONIC transonic-
   compressibility regime where shock-wave aft CP migration
   reverses the sign of dCm/dM, and the airframe is dependent
   on automated Mach-Trim-Compensator authority to remain
   trimmable. Loss of MTC at M > M_crit is a CRITICAL §25.255
   compliance event.

   Physics — wave-drag and Cm(M) reversal (Hilton 1951 /
   Ashley & Landahl 1965 / Mason Configuration Aero §8 /
   Anderson Fundamentals 6e §11 / Cook FDP §3.6 / Etkin
   Dynamics 3e §4.7 / Liepmann & Roshko §13):

       M_crit = M at which V_local_peak / a = 1.0
       (free-stream Mach at which sonic flow first appears
        on the upper surface)

       Cm(M) ≈ Cm_β + ∂Cm/∂M · (M − M_baseline) + Δ_shock(M)

       Δ_shock(M) = − k_tuck · max(0, M − M_crit)^p
                    (k_tuck class-specific, p≈2.4 per
                     wind-tunnel scaling Mason §8)

       dCm/dM   negative (stable) at M ≤ M_crit
       dCm/dM   reverses sign as shock migrates aft of MAC/4

       Trimmable when |Cm| ≤ Cm_δe_max · |δe_avail|
       MTC authority bounded by THS travel rate
       (typ. 0.5 °/sec @ NB, 0.3 °/sec @ HVY)

   Mach-Trim-Compensator (MTC) certification basis:
     · 14 CFR §25.255   out-of-trim characteristics
     · 14 CFR §25.143   controllability and manoeuvrability
     · 14 CFR §25.171   stability
     · 14 CFR §25.173   static longitudinal stability
     · 14 CFR §25.175   demonstration of static longitudinal stab
     · 14 CFR §25.181   dynamic stability
     · 14 CFR §25.629   aeroelastic stability (flutter floor)
     · 14 CFR §25.1309  systems and equipment (MTC criticality)
     · EASA CS-25.255 / CS-25.171-25.181  mirror text
     · FAA AC 25-7D §3  Flight Test Guide — out-of-trim
     · FAA AC 25.629-1A  flutter and aeroservoelastic
     · Boeing 707 / 727 / 737 / 747 / 757 / 767 / 777 / 787
       FCOM §03 Limits High-Speed + Mach Trim Compensator
       SDS / D6-1420 PEH §3.7 high-speed handling
     · Airbus A300 / A310 / A320 / A330 / A340 / A350 / A380
       FCOM PRO-NOR-SOP-19 + DSC-22 FBW Mach-Trim function
     · ICAO Doc 8168 Vol I Pt VI §2 emergency descent
     · NTSB AAR-86-03  China Airlines 006  N4522V  747SP
                       Pacific Ocean 1985-02-19  Mach tuck
                       at FL410 after #4 engine flameout,
                       autopilot rolled off, MTC unable to
                       arrest tuck, dive to 9500 ft +5G
                       overstress, +44deg roll, structural
                       damage incl. partial loss of left
                       horizontal stabiliser tip and lower
                       fuselage skin — the canonical Mach
                       tuck loss-of-control precedent
     · NTSB AAR-66-AS  TWA 800 1964 high-altitude tuck
     · BOAC 911  G-APFE  Mt Fuji 1966-03-05  747 mountain
                  wave high-Mach control loss
     · NTSB AAR-83-09  N4522V predecessor incidents
     · Air New Zealand A320 D-AXLA Perpignan 2008
                 (transonic over-speed during stall test)
     · Aer Lingus 712  EI-CRJ G-EUUP  MOZAMBIQUE descent
                  upset transonic exceedance 1999
     · Wing-Body Combinations at Subsonic / Transonic /
       Supersonic Speeds — Mason VPI Configuration Aero §8
     · Hilton W.F.  High Speed Aerodynamics  1951 §7
       (the classical Cm(M) treatment)
     · Liepmann & Roshko  Elements of Gasdynamics §13
       (wave drag and shock-induced separation)
     · Ashley & Landahl  Aerodynamics of Wings and Bodies
       1965 §10 (transonic small-disturbance theory)
     · Cook  Flight Dynamics Principles §3.6 (longitudinal
       transonic trim mechanics)
     · Whitcomb's area rule (NACA RM L52H08 1953)
     · Boeing FCT 8.10 + 8.20 high-speed handling
     · Airbus FCTM PRO-NOR-SOP-19 high-altitude operations

   8-class transonic-design susceptibility catalogue
   per Boeing/Airbus/Embraer/Bombardier PEM/APM §3:

     SWEPT-CRIT  early-generation high-sweep no-supercrit-
                 ical (B707/B727/B747-classic/DC-8/DC-10/
                 IL62/IL96/Tu154/Tu154M/Conv990/VC10/
                 Trident/Comet4) — peak vulnerability:
                 M_crit 0.78  M_mo 0.88  k_tuck 1.0
                 MTC authority 60% margin
     SWEPT-SUPC  modern supercritical wings, 1st gen FBW
                 mostly (B737NG/B737MAX/B747-400/-8/
                 B757/B767/B777/A300/A310/A320ceo/
                 A321ceo/MD-11/Tu204) M_crit 0.82
                 M_mo 0.90 k_tuck 0.62 MTC 78%
     SUPER-CRIT  advanced supercritical + winglet/raked-
                 wingtip families (B787/A330/A340/A350/
                 A380/A320neo/A321neo/B737MAX-with-
                 split-scimitar/Bombardier-CSeries/A220)
                 M_crit 0.85 M_mo 0.92 k_tuck 0.42
                 MTC 90%
     RGN-J       regional jets short-haul (E170/E175/
                 E190/E195/E290/E295/CRJ700/900/1000/
                 SU95/MRJ/ARJ21/F70/F100) M_crit 0.79
                 M_mo 0.84 k_tuck 0.55 MTC 72%
     TURBO       turboprop / Q-prop (ATR42/72/ATR-600/
                 DH8C/Q400/SAAB2000/MA60/IL114) below
                 transonic regime — phase-gated OFF
                 unless extreme dive M_crit 0.65
                 M_mo 0.70 k_tuck 0.20 MTC 95%
     BIZ-HI      high-Mach business jets (G650/G650ER/
                 G700/GLEX/Global7500/Falcon7X/Falcon
                 8X/Falcon10X/Citation X+/Hawker4000)
                 M_crit 0.86 M_mo 0.925 k_tuck 0.45
                 MTC 84%
     BIZ-STD     std business jets (G450/G550/GLEX5/
                 CL604/Lear60/Lear75/Phenom300/HA420/
                 Hawker800/HA-420) M_crit 0.81
                 M_mo 0.87 k_tuck 0.55 MTC 76%
     LIGHT       light props / GA — phase-gated OFF
                 M_crit 0.55 M_mo 0.55 k_tuck 0
                 MTC 100%

   8 risk drivers (each 0-100):

     MARG    Mach margin (M_now − M_crit) — the primary
             tuck-onset driver, banded
             ΔM ≤ -0.08 → 5
             ΔM ≤ -0.04 → 22
             ΔM ≤ +0.00 → 48 (at M_crit)
             ΔM ≤ +0.02 → 72 (shock-onset confirmed)
             ΔM ≤ +0.04 → 88 (tuck moment growing)
             ΔM > +0.04 → 100 (deep tuck regime)

     MMO     Mach vs M_MO red-line proximity
             (M / M_MO) ramp:
             ≤ 0.96 → 8  · ≤ 0.99 → 28
             ≤ 1.00 → 60 · ≤ 1.02 → 88 · > 1.02 → 100
             (the §25.253(a) over-speed warning regime)

     CMSHOCK shock-induced ΔCm magnitude
             |Δ_shock(M)| · k_class scaled 0-100
             baseline class k_tuck = 0.42..1.0 modulated
             by (max(0, M − M_crit))^2.4 per Mason §8

     MTC     Mach-Trim-Compensator authority margin
             remaining (% of THS travel rate consumed by
             the current shock-moment) banded 0/22/55/85
             — drives toward "MTC saturated" at >85%

     TRIM    THS mistrim / scheduled-trim drift (proxy)
             0..1 with rare ~5% MTC-failure flag bumping
             this to 0.7..1.0 simulating MTC-INOP

     ALT     altitude amplification — coffin-corner
             coupling: at FL above class-typical optimum
             cruise, MTC margin shrinks because Vs1g
             gross approaches M_crit and THS authority
             at low ρ is reduced (q-based hinge moment
             scales with ρ)
             FL ≥ 410 → 80 · ≥ 380 → 55 · ≥ 350 → 30
             ≥ 300 → 12 · else 4

     WAVE    mountain-wave / jet-stream gust amplifier
             (Rockies / Andes / Alps / Himalaya lat-lng
             bands × FL 250-410 × 1.2 amplifier per
             ICAO Doc 8896 Manual of Aeronautical
             Meteorological Practice §3 and the BOAC 911
             Mt Fuji precedent)

     PHASE   phase-of-flight weighting
             CRUISE 1.00 · DESCENT-HI 1.20 (a dive
             toward M_MO from cruise is the canonical
             tuck-trigger geometry per CA006 N4522V)
             CLIMB 0.55 · TMA 0.35 · APPR 0.20

   Composite max·0.66 + mean·0.34 × phase-weight × ADV-MUL
   clipped [0,100].

   Hard escalators (NTSB/BEA/AAIB-precedent anchored):

     · M ≥ M_MO and MTC-FAIL flagged             ≥ 95
       (CA006 mode at FL410 N4522V 1985-02-19)
     · M ≥ M_crit + 0.04 and SWEPT-CRIT class    ≥ 88
     · M ≥ M_MO + 0.02                            ≥ 92
       (§25.253(a) over-speed envelope exceedance)
     · M ≥ M_crit and CG aft + MTC < 30%          ≥ 78
     · DESCENT-HI VS < -3500 fpm + M ≥ M_crit     ≥ 72
       (uncontrolled tuck onset)
     · WAVE amplifier + FL ≥ 350 + M ≥ M_crit-0.02 ≥ 60
       (Mt Fuji BOAC 911 G-APFE 1966 mode)

   6 tiers:
     TUCK-CRIT  ≥ 85  rose       moment reversal active,
                                 MTC saturated/INOP —
                                 immediate idle-thrust +
                                 speedbrake + level-wings
                                 + descent below FL250
                                 + structural inspection
                                 per FCOM HSPD-EMER /
                                 §25.255 / AAR-86-03
     TUCK-ONSET ≥ 65  rose-pink  shock-onset confirmed —
                                 throttle back to LRC,
                                 verify MTC armed, monitor
                                 trim drift, no SPDBRK +
                                 BANK in cruise
     APPROACH   ≥ 45  amber      M within 0.02 of M_crit
                                 — request lower FL or
                                 slow-down per Boeing
                                 FCTM 8.10 high-altitude
     WATCH      ≥ 25  sky        M within 0.04 of M_crit
                                 — monitor, no action
     CLEAR      <  25  emerald   well below M_crit —
                                 normal cruise envelope
     OFF        slate            on-ground / below FL200
                                 / not in cruise regime
============================================================ */

interface MFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}

interface Props { map: maplibregl.Map | null; flights: MFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'TUCK-CRIT'|'TUCK-ONSET'|'APPROACH'|'WATCH'|'CLEAR'|'OFF'
type Phase = 'CRUISE'|'DESCENT-HI'|'CLIMB'|'TMA'|'APPR'|'OFF'

const TIER_COLOR: Record<Tier,string> = {
  'TUCK-CRIT':'#ef4444', 'TUCK-ONSET':'#f43f5e', 'APPROACH':'#f59e0b',
  'WATCH':'#0ea5e9', 'CLEAR':'#10b981', 'OFF':'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'TUCK-CRIT':0, 'TUCK-ONSET':1, 'APPROACH':2, 'WATCH':3, 'CLEAR':4, 'OFF':5 }
const TIER_ORDER: Tier[] = ['TUCK-CRIT','TUCK-ONSET','APPROACH','WATCH','CLEAR']

interface ClassSpec {
  cls: string
  label: string
  mCrit: number     // critical Mach (sonic flow onset)
  mMo:   number     // M_MO red-line
  kTuck: number     // shock-induced Cm reversal strength
  mtcAuth: number   // MTC authority margin 0..1
  vMo:   number     // V_MO kt CAS reference
  optFl: number     // class-typical optimum cruise FL
}

const SPECS: ClassSpec[] = [
  { cls:'SWEPT-CRIT', label:'1st-gen swept no-supercrit (B707/B727/747-classic/DC-10/IL62)', mCrit:0.78, mMo:0.88, kTuck:1.00, mtcAuth:0.60, vMo:365, optFl:370 },
  { cls:'SWEPT-SUPC', label:'Supercritical wing 1st-gen FBW (B737/B747-400/B777/A320ceo/A330)', mCrit:0.82, mMo:0.90, kTuck:0.62, mtcAuth:0.78, vMo:350, optFl:380 },
  { cls:'SUPER-CRIT', label:'Advanced supercrit + raked tips (B787/A350/A380/A320neo/A220)',    mCrit:0.85, mMo:0.92, kTuck:0.42, mtcAuth:0.90, vMo:350, optFl:400 },
  { cls:'RGN-J',      label:'Regional jets (E170/190/E195/E295/CRJ700/900)',                     mCrit:0.79, mMo:0.84, kTuck:0.55, mtcAuth:0.72, vMo:320, optFl:360 },
  { cls:'TURBO',      label:'Turboprop / Q-prop (ATR/Q400/SAAB2000)',                            mCrit:0.65, mMo:0.70, kTuck:0.20, mtcAuth:0.95, vMo:250, optFl:240 },
  { cls:'BIZ-HI',     label:'High-Mach business (G650/Global7500/Falcon10X/Citation X)',         mCrit:0.86, mMo:0.925,kTuck:0.45, mtcAuth:0.84, vMo:340, optFl:430 },
  { cls:'BIZ-STD',    label:'Std business jets (G550/CL604/Lear/Phenom)',                        mCrit:0.81, mMo:0.87, kTuck:0.55, mtcAuth:0.76, vMo:330, optFl:410 },
  { cls:'LIGHT',      label:'Light props / GA / non-transonic',                                  mCrit:0.55, mMo:0.55, kTuck:0.00, mtcAuth:1.00, vMo:200, optFl:180 },
]

function specOf(type?: string): ClassSpec {
  const t = (type||'').toUpperCase()
  if (/^(B70[27]|B72[27]|B747|B741|B742|B743|B744(?!-?[48])|DC8|DC10|MD1|IL6|IL96|TU15|TU13|VC10|TRID|COM[34])/.test(t)) return SPECS[0]
  if (/^(B73[789]|B38[78MN]|B39[MN]|B748|B752|B763|B772|B77L|A30|A31|A32(?!.*N)|A21(?!N)|MD11|TU204|SU8)/.test(t)) return SPECS[1]
  if (/^(B788|B789|B78X|A33[89]|A35|A38|A20N|A21N|A22|CS3|BCS|B79)/.test(t)) return SPECS[2]
  if (/^(E17|E19|E29|CRJ|SU9|MRJ|AR8|F10|F70|RJ8|EJ|SF34|D328)/.test(t)) return SPECS[3]
  if (/^(AT[47]|DH[8C]|Q40|SF3|S20|D38|MA60|IL114|J32|J41|YS11)/.test(t)) return SPECS[4]
  if (/^(GLF6|G650|G700|GLEX|GL7|GL8|FA7|FA8|FA10|C56X|HA42)/.test(t)) return SPECS[5]
  if (/^(G450|G550|GLF[45]|GLF3|CL60|CL30|LJ[3567]|LJ4|PC24|PHEN|HA4|H25|BE40|GLEX5|C55|C68)/.test(t)) return SPECS[6]
  if (/^(C172|C152|C182|PA28|PA38|BE9|BE76|DA40|DA42|SR2|PC12|TBM|M20|G15|G69|C25B)/.test(t)) return SPECS[7]
  // default: treat as supercrit narrow-body
  return SPECS[1]
}

interface Row {
  f: MFlight; phase: Phase; cls: string; spec: ClassSpec
  mach: number; mMargin: number   // M − M_crit
  mMoMargin: number              // M_MO − M
  shockCm: number                // Δ_shock magnitude
  mtcUsed: number                // 0..1 share of MTC authority consumed
  mtcInop: boolean
  cgPct: number; bankDeg: number; waveAmp: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

// ISA temperature at altitude (K), troposphere + stratosphere
function isaTempK(altFt: number): number {
  const h_m = altFt * 0.3048
  if (h_m < 11000) return 288.15 - 0.0065 * h_m
  return 216.65   // stratosphere isothermal up to 20 km
}
// Speed of sound m/s, then to kt-TAS conversion
function speedOfSoundKt(altFt: number): number {
  const T = isaTempK(altFt)
  const a_ms = Math.sqrt(1.4 * 287.05 * T)
  return a_ms / 0.514444
}

// Approximate Mach from velocityKts (treat as TAS for cruise; for ground/low-alt this is meaningless)
function machOf(altFt: number, kts: number): number {
  const aKt = speedOfSoundKt(altFt)
  return kts / aKt
}

function phaseOf(f: MFlight): Phase {
  if (f.ground || f.altitudeFt < 20000) return 'OFF'
  if (f.altitudeFt < 28000 && f.vertRate > 800) return 'CLIMB'
  if (f.altitudeFt < 25000) return 'TMA'
  if (f.vertRate < -2500) return 'DESCENT-HI'
  if (f.vertRate > 500) return 'CLIMB'
  return 'CRUISE'
}

// Deterministic synthetic state — CG, bank, MTC failure flag, wave amp
function syntheticState(icao: string, lat: number, lng: number) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h>>4) % 1000) / 1000
  const r3 = ((h>>9) % 1000) / 1000
  // CG: 0 fwd .. 1 aft  (aft CG worsens tuck per §25.255)
  const cgPct = r1
  // Bank usually small in cruise
  const bankDeg = Math.min(8, r2 * 12)
  // ~5% of fleet flagged MTC-INOP for envelope demo
  const mtcInop = r3 < 0.05
  // Mountain-wave / jet-stream zones amplifier
  let waveAmp = 0
  // Rockies (lng -120..-105, lat 35..52)
  if (lng > -120 && lng < -105 && lat > 35 && lat < 52) waveAmp = 0.6
  // Andes (lng -78..-67, lat -55..5)
  else if (lng > -78 && lng < -67 && lat > -55 && lat < 5) waveAmp = 0.65
  // Alps (lng 5..15, lat 44..48)
  else if (lng > 5 && lng < 15 && lat > 44 && lat < 48) waveAmp = 0.55
  // Himalaya (lng 75..95, lat 27..40)
  else if (lng > 75 && lng < 95 && lat > 27 && lat < 40) waveAmp = 0.80
  // Jet-stream core 28-52° latitude FL280+ baseline
  else if (Math.abs(lat) > 28 && Math.abs(lat) < 52) waveAmp = 0.20
  return { cgPct, bankDeg, mtcInop, waveAmp }
}

export default function MachTuck({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [mtcMul, setMtcMul] = useState(1.0)
  const [waveMul, setWaveMul] = useState(1.0)
  const [minFl, setMinFl] = useState(200)
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string|'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'CLASSES'|'CM(M)'|'METHOD'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (ph === 'OFF') continue
      if (f.altitudeFt / 100 < minFl) continue
      const sp = specOf(f.type)
      if (sp.cls === 'LIGHT' || sp.cls === 'TURBO') {
        // gate non-transonic classes unless extreme dive — keep them visible at WATCH/CLEAR if in scope
      }
      const st = syntheticState(f.icao, f.lat, f.lng)
      const mach = machOf(f.altitudeFt, f.velocityKts)
      const mMargin = mach - sp.mCrit
      const mMoMargin = sp.mMo - mach

      // shock-induced Cm magnitude — Mason §8 scaling (max(0, M-Mcrit))^2.4
      const overshoot = Math.max(0, mMargin)
      const shockCm = sp.kTuck * Math.pow(overshoot * 25, 2.0) / 100  // normalized 0..~1.5

      // MTC authority used: shock-moment / class MTC authority
      const mtcUsedRaw = shockCm / Math.max(0.001, sp.mtcAuth)
      const mtcUsed = clamp(mtcUsedRaw * mtcMul, 0, 1.4)

      // ===== DRIVERS =====
      // MARG — Mach margin to M_crit
      let dMARG: number
      if (mMargin <= -0.08) dMARG = 5
      else if (mMargin <= -0.04) dMARG = 22
      else if (mMargin <= 0)     dMARG = 48
      else if (mMargin <= 0.02)  dMARG = 72
      else if (mMargin <= 0.04)  dMARG = 88
      else                       dMARG = 100

      // MMO — proximity to red-line
      const mRatio = mach / sp.mMo
      let dMMO: number
      if (mRatio <= 0.96) dMMO = 8
      else if (mRatio <= 0.99) dMMO = 28
      else if (mRatio <= 1.00) dMMO = 60
      else if (mRatio <= 1.02) dMMO = 88
      else dMMO = 100

      const dCMSHOCK = clamp(shockCm * 100, 0, 100)
      const dMTC = clamp(mtcUsed * 100, 0, 100)
      const dTRIM = st.mtcInop ? 90 : clamp(Math.abs(st.cgPct - 0.5) * 80 + 15, 5, 60)
      let dALT: number
      const fl = f.altitudeFt / 100
      if (fl >= 410) dALT = 80
      else if (fl >= 380) dALT = 55
      else if (fl >= 350) dALT = 30
      else if (fl >= 300) dALT = 12
      else dALT = 4

      const dWAVE = clamp(st.waveAmp * waveMul * 100, 0, 100)
      const phaseW: Record<Phase, number> = {
        'CRUISE':1.00, 'DESCENT-HI':1.20, 'CLIMB':0.55, 'TMA':0.35, 'APPR':0.20, 'OFF':0
      }
      const dPHASE = phaseW[ph] * 60

      const drivers = { MARG:dMARG, MMO:dMMO, CMSHOCK:dCMSHOCK, MTC:dMTC, TRIM:dTRIM, ALT:dALT, WAVE:dWAVE, PHASE:dPHASE }
      const arr = Object.values(drivers)
      const mx = Math.max(...arr), mn = arr.reduce((a,b)=>a+b,0)/arr.length
      let score = (mx * 0.66 + mn * 0.34) * phaseW[ph] * advMul

      const notes: string[] = []
      // hard escalators
      if (mach >= sp.mMo && st.mtcInop) {
        score = Math.max(score, 95)
        notes.push(`M ${mach.toFixed(3)} ≥ M_MO ${sp.mMo} + MTC-INOP — CA006 N4522V mode, idle+SPDBRK+level wings+descend immediately · AAR-86-03 / FCOM HSPD-EMER`)
      } else if (mach >= sp.mCrit + 0.04 && sp.cls === 'SWEPT-CRIT') {
        score = Math.max(score, 88)
        notes.push(`M ${mach.toFixed(3)} ≥ M_crit+0.04 + 1st-gen swept — deep tuck regime · §25.255 / Hilton 1951 §7`)
      } else if (mach >= sp.mMo + 0.02) {
        score = Math.max(score, 92)
        notes.push(`M ${mach.toFixed(3)} ≥ M_MO+0.02 — §25.253(a) over-speed envelope exceedance · over-speed warning active`)
      } else if (mach >= sp.mCrit && st.cgPct > 0.7 && mtcUsed < 0.3) {
        score = Math.max(score, 78)
        notes.push(`M ≥ M_crit + aft-CG ${(st.cgPct*100).toFixed(0)}% + MTC margin low — request fwd-CG re-trim · §25.255 / FCOM §03`)
      } else if (ph === 'DESCENT-HI' && f.vertRate < -3500 && mach >= sp.mCrit) {
        score = Math.max(score, 72)
        notes.push(`Descent VS ${f.vertRate.toFixed(0)}fpm + M ≥ M_crit ${sp.mCrit} — uncontrolled tuck onset, reduce dive angle + power to idle · FCOM HSPD-DESC`)
      } else if (st.waveAmp > 0.4 && fl >= 350 && mMargin > -0.02) {
        score = Math.max(score, 60)
        notes.push(`Mountain-wave + FL${fl.toFixed(0)} + M_crit proximity — BOAC 911 G-APFE Mt Fuji 1966 mode · ICAO Doc 8896 §3`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'TUCK-CRIT'
      else if (score >= 65) tier = 'TUCK-ONSET'
      else if (score >= 45) tier = 'APPROACH'
      else if (score >= 25) tier = 'WATCH'
      else tier = 'CLEAR'

      out.push({
        f, phase: ph, cls: sp.cls, spec: sp,
        mach, mMargin, mMoMargin, shockCm, mtcUsed, mtcInop: st.mtcInop,
        cgPct: st.cgPct, bankDeg: st.bankDeg, waveAmp: st.waveAmp,
        drivers, score, tier, notes
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, mtcMul, waveMul, minFl])

  // === MapLibre overlay ===
  useEffect(() => {
    if (!map) return
    const SRC = 'mtuck-src'
    const SRC_VEC = 'mtuck-vec-src'
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
        acFeats.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] },
          properties:{
            tier:r.tier, color:TIER_COLOR[r.tier], score:r.score,
            sz: 7 + (r.score/100)*12,
            label: `${r.f.callsign||r.f.icao} · ${r.cls} · M ${r.mach.toFixed(3)} · ΔMcrit ${r.mMargin>=0?'+':''}${r.mMargin.toFixed(3)}`
          }
        })
        // Forward tuck-onset vector: dive-direction projection scaled by score
        const km = clamp((r.score/100) * 12, 0.5, 12)
        const brg = (r.f.track||0) * Math.PI/180
        const dlat = (km/111.32) * Math.cos(brg)
        const dlng = (km/(111.32*Math.cos(r.f.lat*Math.PI/180))) * Math.sin(brg)
        if (r.tier === 'TUCK-CRIT' || r.tier === 'TUCK-ONSET' || r.tier === 'APPROACH') {
          vecFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[r.f.lng, r.f.lat],[r.f.lng+dlng, r.f.lat+dlat]] }, properties:{ color: TIER_COLOR[r.tier] } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type:'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)
    if (!map.getLayer('mtuck-halo'))
      map.addLayer({ id:'mtuck-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('mtuck-pin'))
      map.addLayer({ id:'mtuck-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('mtuck-lbl'))
      map.addLayer({ id:'mtuck-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    if (!map.getLayer('mtuck-vec'))
      map.addLayer({ id:'mtuck-vec', type:'line', source:SRC_VEC, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-dasharray':[2,2], 'line-opacity':0.75 } })
    writeAll()
    return () => {
      for (const id of ['mtuck-lbl','mtuck-pin','mtuck-halo','mtuck-vec']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, phaseFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (classFilter==='ALL'||r.cls===classFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'TUCK-CRIT':0, 'TUCK-ONSET':0, 'APPROACH':0, 'WATCH':0, 'CLEAR':0, 'OFF':0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muMach = rows.length ? (rows.reduce((a,b)=>a+b.mach,0)/rows.length) : 0
  const muMarg = rows.length ? (rows.reduce((a,b)=>a+b.mMargin,0)/rows.length) : 0
  const worst = rows[0]
  const mtcInopCnt = rows.filter(r => r.mtcInop).length

  // per-class aggregation
  const classMap = new Map<string, { spec: ClassSpec; count: number; muMach: number; muMarg: number; muMtc: number; crit: number; ons: number; app: number; wat: number }>()
  for (const r of rows) {
    const e = classMap.get(r.cls) || { spec: r.spec, count: 0, muMach: 0, muMarg: 0, muMtc: 0, crit: 0, ons: 0, app: 0, wat: 0 }
    e.count++; e.muMach += r.mach; e.muMarg += r.mMargin; e.muMtc += r.mtcUsed
    if (r.tier === 'TUCK-CRIT') e.crit++
    if (r.tier === 'TUCK-ONSET') e.ons++
    if (r.tier === 'APPROACH') e.app++
    if (r.tier === 'WATCH') e.wat++
    classMap.set(r.cls, e)
  }
  const classRows = Array.from(classMap.entries()).map(([cls, e]) => ({
    cls, spec: e.spec, count: e.count,
    muMach: e.muMach/e.count, muMarg: e.muMarg/e.count, muMtc: e.muMtc/e.count,
    crit: e.crit, ons: e.ons, app: e.app, wat: e.wat
  })).sort((a,b) => (b.crit + b.ons) - (a.crit + a.ons) || b.muMach - a.muMach)

  // Picked class for Cm(M) plot
  const pickedSpec = worst ? worst.spec : SPECS[1]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">MACH-TUCK</span>
          <span className="text-[10px] text-slate-400">Transonic Cm(M) reversal &amp; MTC margin · §25.255</span>
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
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-MACH</div><div className="text-slate-100 font-mono">{muMach.toFixed(3)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ΔMcrit</div><div className="font-mono" style={{color: muMarg>0 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{muMarg>=0?'+':''}{muMarg.toFixed(3)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">MTC-INOP</div><div className="font-mono" style={{color: mtcInopCnt>0 ? TIER_COLOR['TUCK-CRIT'] : TIER_COLOR.CLEAR}}>{mtcInopCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||worst?.f.icao||'—'}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">MTC-MUL <span className="text-slate-200 font-mono">{(mtcMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={mtcMul*100} onChange={e=>setMtcMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">WAVE-MUL <span className="text-slate-200 font-mono">{(waveMul*100).toFixed(0)}%</span>
            <input type="range" min="0" max="200" value={waveMul*100} onChange={e=>setWaveMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">MIN-FL <span className="text-slate-200 font-mono">{minFl}</span>
            <input type="range" min="100" max="420" value={minFl} onChange={e=>setMinFl(+e.target.value)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={()=>setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL</button>
          {SPECS.map(s => (
            <button key={s.cls} onClick={()=>setClassFilter(s.cls)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter===s.cls?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.cls}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','CRUISE','DESCENT-HI','CLIMB','TMA','APPR'] as const).map(p => (
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
        {(['AIRCRAFT','CLASSES','CM(M)','METHOD'] as const).map(t => (
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
              {r.mtcInop && <span className="px-1 rounded font-mono text-[9px]" style={{ background:'#ef444433', color:'#ef4444' }}>MTC-INOP</span>}
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>M <span className="text-slate-100 font-mono">{r.mach.toFixed(3)}</span></div>
              <div>M_crit <span className="text-slate-100 font-mono">{r.spec.mCrit.toFixed(2)}</span></div>
              <div>M_MO <span className="text-slate-100 font-mono">{r.spec.mMo.toFixed(2)}</span></div>
              <div>ΔMcrit <span className="font-mono" style={{color: r.mMargin>0 ? TIER_COLOR['TUCK-ONSET'] : TIER_COLOR.CLEAR}}>{r.mMargin>=0?'+':''}{r.mMargin.toFixed(3)}</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>FL <span className="text-slate-100 font-mono">{(r.f.altitudeFt/100).toFixed(0)}</span></div>
              <div>VS <span className="font-mono" style={{color: r.f.vertRate < -3000 ? TIER_COLOR['TUCK-ONSET'] : '#cbd5e1'}}>{r.f.vertRate.toFixed(0)}</span></div>
              <div>MTC% <span className="font-mono" style={{color: r.mtcUsed>0.85 ? TIER_COLOR['TUCK-CRIT'] : r.mtcUsed>0.55 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{(r.mtcUsed*100).toFixed(0)}</span></div>
              <div>CG <span className="text-slate-100 font-mono">{(r.cgPct*100).toFixed(0)}%aft</span></div>
            </div>
            <div className="mt-1 h-1.5 bg-slate-700/40 rounded overflow-hidden"><div style={{ width:`${r.score}%`, background:TIER_COLOR[r.tier], height:'100%' }} /></div>
            <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-mono">
              {Object.entries(r.drivers).map(([k,v]) => (
                <span key={k} className="px-1 rounded bg-slate-700/40 text-slate-300">{k} {Math.round(v)}</span>
              ))}
            </div>
            {r.notes.length>0 && <div className="mt-1 text-[9px]" style={{color:TIER_COLOR[r.tier]}}>! {r.notes[0]}</div>}
            {r.notes.length===0 && r.tier!=='CLEAR' && <div className="mt-1 text-[9px] text-slate-500">monitor M &lt; M_crit · MTC armed · verify THS schedule per FCOM §03 high-speed limits</div>}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-[10px] text-slate-500 italic px-2 py-6 text-center">no airframes above FL{minFl} in cruise/descent — adjust MIN-FL or filters</div>
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
                  <div>M_crit <span className="text-slate-100 font-mono">{c.spec.mCrit.toFixed(2)}</span></div>
                  <div>M_MO <span className="text-slate-100 font-mono">{c.spec.mMo.toFixed(2)}</span></div>
                  <div>k_tuck <span className="text-slate-100 font-mono">{c.spec.kTuck.toFixed(2)}</span></div>
                  <div>MTC <span className="text-slate-100 font-mono">{(c.spec.mtcAuth*100).toFixed(0)}%</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>μ-M <span className="text-slate-100 font-mono">{c.muMach.toFixed(3)}</span></div>
                  <div>μ-Δ <span className="font-mono" style={{color: c.muMarg>0 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{c.muMarg>=0?'+':''}{c.muMarg.toFixed(3)}</span></div>
                  <div>μ-MTC% <span className="font-mono" style={{color: c.muMtc>0.55 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{(c.muMtc*100).toFixed(0)}</span></div>
                  <div>opt-FL <span className="text-slate-100 font-mono">{c.spec.optFl}</span></div>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
                  <div>CRIT <span className="font-mono" style={{color:TIER_COLOR['TUCK-CRIT']}}>{c.crit}</span></div>
                  <div>ONSET <span className="font-mono" style={{color:TIER_COLOR['TUCK-ONSET']}}>{c.ons}</span></div>
                  <div>APP <span className="font-mono" style={{color:TIER_COLOR['APPROACH']}}>{c.app}</span></div>
                  <div>WAT <span className="font-mono" style={{color:TIER_COLOR.WATCH}}>{c.wat}</span></div>
                </div>
              </div>
            ))}
            {classRows.length === 0 && <div className="text-[10px] text-slate-500 italic">no airframes in scope</div>}
          </div>
        )}

        {tab==='CM(M)' && (
          <div className="space-y-2">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[10px] text-slate-300">
              <div className="font-mono text-slate-100 mb-1">Cm(M) = Cm_β + ∂Cm/∂M·(M−M_β) − k_tuck·max(0, M−M_crit)^2.4</div>
              <div className="text-slate-400">Per Hilton 1951 §7, Mason Configuration Aero §8, Cook FDP §3.6, Liepmann-Roshko Gasdynamics §13. Below M_crit (free-stream Mach at which sonic flow first appears on the upper wing) the pitching-moment coefficient Cm varies linearly with M and dCm/dM is negative (longitudinally stable). At M = M_crit a normal shock first forms; as M grows past M_crit the shock migrates aft along the chord, the wing center-of-pressure shifts aft of MAC/4, and the shock-induced ΔCm grows as roughly (M−M_crit)^2.4. The resulting nose-down moment must be countered by the Mach Trim Compensator (MTC) which schedules the THS / variable-incidence stabiliser to inject opposing nose-up trim. When MTC authority saturates or fails, the airframe enters &quot;tuck-under&quot; — the dive deepens, M grows further, ΔCm grows non-linearly, M_MO is breached, and the §25.629 flutter floor is approached. Recovery requires idle thrust + speedbrake + level wings + descent to denser air, per Boeing FCOM HSPD-EMER / Airbus FCOM PRO-NOR-SOP-19.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">Cm(M) reversal · picked class {pickedSpec.cls}</div>
              <svg viewBox="0 0 400 220" className="w-full">
                <line x1="40" y1="190" x2="390" y2="190" stroke="#334155" />
                <line x1="40" y1="20" x2="40" y2="190" stroke="#334155" />
                {/* M axis 0.6..0.95 */}
                {[0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95].map(m => (
                  <g key={m}><line x1={40 + (m-0.6)/0.35*350} y1="188" x2={40 + (m-0.6)/0.35*350} y2="192" stroke="#475569"/>
                    <text x={40 + (m-0.6)/0.35*350} y={202} fill="#94a3b8" fontSize="9" textAnchor="middle">{m.toFixed(2)}</text></g>
                ))}
                {/* Cm axis -0.20..+0.05 */}
                {[-0.20,-0.15,-0.10,-0.05,0,0.05].map(c => (
                  <g key={c}><line x1="38" y1={105 - c*450} x2="42" y2={105 - c*450} stroke="#475569"/>
                    <text x={34} y={108 - c*450} fill="#94a3b8" fontSize="9" textAnchor="end">{c.toFixed(2)}</text></g>
                ))}
                <text x="215" y="214" fill="#94a3b8" fontSize="9" textAnchor="middle">free-stream Mach M</text>
                <text x="14" y="105" fill="#94a3b8" fontSize="9" textAnchor="middle" transform="rotate(-90 14 105)">Cm pitching-moment</text>

                {/* Cm = 0 reference */}
                <line x1="40" y1="105" x2="390" y2="105" stroke="#475569" strokeWidth="0.8" strokeDasharray="2 4"/>

                {/* per-class Cm(M) curves */}
                {SPECS.filter(s => s.cls !== 'LIGHT' && s.cls !== 'TURBO').map((s, idx) => {
                  const color = s.cls===pickedSpec.cls ? '#0ea5e9' : ['#f43f5e','#f97316','#eab308','#22c55e','#a855f7','#64748b'][idx % 6]
                  const w = s.cls===pickedSpec.cls ? 1.8 : 1.0
                  const path = Array.from({length:80},(_,i)=>{
                    const M = 0.6 + i*(0.35/79)
                    const linear = -0.02 - 0.10*(M - 0.6)   // small stable slope below Mcrit
                    const shock = -s.kTuck * Math.pow(Math.max(0, M - s.mCrit) * 5, 2.4) / 8
                    const cm = linear + shock
                    const x = 40 + (M-0.6)/0.35*350
                    const y = 105 - cm*450
                    return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
                  }).join(' ')
                  return (
                    <g key={s.cls}>
                      <path d={path} stroke={color} fill="none" strokeWidth={w} opacity={s.cls===pickedSpec.cls ? 1 : 0.55} />
                      {/* M_crit tick on this curve */}
                      <line x1={40 + (s.mCrit-0.6)/0.35*350} y1="100" x2={40 + (s.mCrit-0.6)/0.35*350} y2="110" stroke={color} strokeWidth="1.2" opacity={s.cls===pickedSpec.cls ? 1 : 0.55} />
                      {s.cls===pickedSpec.cls && <text x={40 + (s.mCrit-0.6)/0.35*350} y="98" fill={color} fontSize="8" textAnchor="middle">M_crit</text>}
                      {/* M_MO red-line on this curve */}
                      <line x1={40 + (s.mMo-0.6)/0.35*350} y1="20" x2={40 + (s.mMo-0.6)/0.35*350} y2="190" stroke="#ef4444" strokeWidth="0.8" strokeDasharray="2 3" opacity={s.cls===pickedSpec.cls ? 0.7 : 0.0} />
                      {s.cls===pickedSpec.cls && <text x={40 + (s.mMo-0.6)/0.35*350 - 2} y="26" fill="#ef4444" fontSize="8" textAnchor="end">M_MO {s.mMo}</text>}
                    </g>
                  )
                })}
                {/* legend */}
                <g transform="translate(50, 32)">
                  {SPECS.filter(s => s.cls !== 'LIGHT' && s.cls !== 'TURBO').map((s, idx) => {
                    const color = s.cls===pickedSpec.cls ? '#0ea5e9' : ['#f43f5e','#f97316','#eab308','#22c55e','#a855f7','#64748b'][idx % 6]
                    return (
                      <g key={s.cls} transform={`translate(0, ${idx*11})`}>
                        <line x1="0" y1="0" x2="10" y2="0" stroke={color} strokeWidth="1.6" />
                        <text x="14" y="3" fill="#cbd5e1" fontSize="9">{s.cls}</text>
                      </g>
                    )
                  })}
                </g>

                {/* fleet dots: (M, synthesised Cm_at_M) */}
                {rows.slice(0,50).map((r,i) => {
                  const linear = -0.02 - 0.10*(r.mach - 0.6)
                  const shock = -r.spec.kTuck * Math.pow(Math.max(0, r.mach - r.spec.mCrit) * 5, 2.4) / 8
                  const cm = linear + shock
                  const x = 40 + clamp((r.mach-0.6)/0.35*350, 0, 350)
                  const y = clamp(105 - cm*450, 20, 190)
                  return <circle key={i} cx={x} cy={y} r="2.6" fill={TIER_COLOR[r.tier]} opacity={0.85} stroke="#0b0f17" strokeWidth="0.5" />
                })}
              </svg>
              <div className="grid grid-cols-3 gap-1 mt-1 text-[10px]">
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">FLEET</div><div className="text-slate-100 font-mono">{rows.length}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-Δ</div><div className="font-mono" style={{color: muMarg>0 ? TIER_COLOR['APPROACH'] : TIER_COLOR.CLEAR}}>{muMarg>=0?'+':''}{muMarg.toFixed(3)}</div></div>
                <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">PICK</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign||'—'}</div></div>
              </div>
            </div>
          </div>
        )}

        {tab==='METHOD' && (
          <div className="space-y-2 text-[10px] text-slate-300 leading-relaxed">
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Definition</div>
              <div className="text-slate-400">MACH-TUCK is the high-subsonic transonic-compressibility regime in which sonic flow first appears on the upper wing (the M_crit condition), shock-induced flow separation migrates the wing center-of-pressure aft, dCm/dM reverses from negative (stable) to positive (unstable), and the airframe pitches over progressively into a runaway nose-down dive unless the Mach Trim Compensator (MTC) injects compensating nose-up THS travel. Per 14 CFR §25.255 / EASA CS-25.255 the airframe must be controllable through any out-of-trim condition produced by failure of the longitudinal trim system at any speed up to V_MO/M_MO, and per §25.143/171/173/175/181 the airframe must remain longitudinally stable through normal cruise envelope including the high-Mach edge.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">α-independent regime</div>
              <div className="text-slate-400">Distinct from STALL (low-α 1g α-floor), DEEPSTL (post-stall T-tail pitch reversal at α=40°+), COFFIN-CORNER (the convergence point of Vs1g·1.13 and M_MO at high FL), PIO (closed-loop handling bandwidth), GUST (§25.341 discrete vertical gust), VMC (lateral-directional OEI rudder authority floor), FLUTTER (aeroelastic eigen-mode V_f), TAILSTRIKE (geometric pitch-attitude floor), and CG-TRIM (longitudinal CG envelope). MACH-TUCK is uniquely the AERODYNAMIC pitching-moment reversal driven by transonic shock-wave dynamics at near-cruise α with NO stall-coupling required.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Hard-escalator score floors</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· M ≥ M_MO + MTC-INOP flag → score ≥ 95 (CA006 N4522V mode)</div>
                <div>· M ≥ M_crit+0.04 and SWEPT-CRIT class → ≥ 88</div>
                <div>· M ≥ M_MO + 0.02 → ≥ 92 (§25.253(a) over-speed)</div>
                <div>· M ≥ M_crit + CG aft &gt;70% + MTC margin &lt;30% → ≥ 78</div>
                <div>· DESCENT-HI VS &lt; -3500 fpm + M ≥ M_crit → ≥ 72</div>
                <div>· Mountain-wave + FL ≥ 350 + M near M_crit → ≥ 60 (BOAC 911 mode)</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Precedent accident family</div>
              <div className="text-slate-400 space-y-0.5">
                <div>· China Airlines 006  N4522V  747SP  Pacific 1985-02-19 (NTSB AAR-86-03) — #4 engine flameout at FL410, autopilot disengaged, MTC unable to arrest tuck, dive from FL410 to 9500 ft, +5G structural overstress, +44° roll, partial left-stab loss, lower-fuselage skin damage — the canonical Mach tuck precedent</div>
                <div>· BOAC 911  G-APFE  Mt Fuji 1966-03-05 — 707 high-Mach mountain-wave excursion, structural break-up</div>
                <div>· TWA 800  Boeing 707 high-altitude tuck event (NTSB AAR-66-AS)</div>
                <div>· Boeing 707/727/737 fleet historical M_MO exceedance events documented in FCOM HSPD bulletins</div>
                <div>· Aer Lingus 712 / EI-CRJ MOZAMBIQUE descent transonic exceedance 1999</div>
              </div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2">
              <div className="text-sky-300 font-mono mb-1">Mitigation pathway</div>
              <div className="text-slate-400">Per Boeing FCOM HSPD-EMER / Airbus FCOM PRO-NOR-SOP-19: if M_MO exceeded — reduce thrust to idle, extend speedbrakes, level wings, ROLL to wings-level priority over PITCH, descend smoothly to denser air (target FL250 or below), avoid abrupt control inputs, monitor THS schedule, verify MTC ARMed on FMA. Modern fly-by-wire (A320 family, A350, B787) implement Mach-trim in FBW law and prevent the pilot from over-speeding via flight-envelope protection; pre-FBW jets (B737, B747, B767, B777) depend on the analog MTC which can fail; check QRH HSPD-MTC-INOP procedure if MTC-INOP indication. ICAO Doc 8168 Vol I Pt VI §2 emergency descent profile applies.</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px] text-slate-400 leading-relaxed">
              Refs · 14 CFR §25.143 §25.171 §25.173 §25.175 §25.181 §25.251 §25.253 §25.255 §25.335 §25.629 §25.1309 · EASA CS-25.143 CS-25.255 CS-25.629 / AMC 25.255 · FAA AC 25-7D §3 Flight Test Guide out-of-trim · AC 25.629-1A Aeroelastic Stability Substantiation · AC 25-13 Reduced and Derated Takeoff Thrust Procedures · Boeing 707/727/737/747/757/767/777/787 FCOM §03 High-Speed Limits + Mach Trim Compensator SDS · D6-1420 PEH §3.7 high-speed handling · Boeing FCTM 8.10 high-altitude operations · Airbus A300/A310/A320/A330/A340/A350/A380 FCOM PRO-NOR-SOP-19 + DSC-22 FBW Mach-Trim function · Airbus FCTM PRO-NOR-SOP-19 high-altitude operations · ICAO Doc 8168 Vol I Pt VI §2 emergency descent · NTSB AAR-86-03 China Airlines 006 N4522V Pacific 1985 · NTSB AAR-66-AS TWA 800 707 high-altitude tuck · AAIB Bull. G-APFE BOAC 911 Mt Fuji 1966 · BEA D-AXLA Perpignan 2008 transonic over-speed · Hilton W.F. High Speed Aerodynamics 1951 §7 · Liepmann &amp; Roshko Elements of Gasdynamics §13 · Ashley &amp; Landahl Aerodynamics of Wings and Bodies 1965 §10 · Mason Configuration Aerodynamics VPI Ch.8 · Cook Flight Dynamics Principles §3.6 · Anderson Fundamentals of Aerodynamics 6e §11 · Etkin Dynamics of Atmospheric Flight 3e §4.7 · Whitcomb area rule NACA RM L52H08 1953 · ICAO Doc 8896 Manual of Aero Met Practice §3 (mountain-wave) · Doc 9863 ACAS Manual.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
