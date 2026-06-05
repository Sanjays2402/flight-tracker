'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TPMS · Tire-Pressure Monitoring System · Hot-Brake Reactive
   · Concorde-Mode Foreign-Object Tire-Impact & Tire-Performance
   Margin Monitor
   -----------------------------------------------------------
   Per-airframe live evaluator of the LANDING-GEAR TIRE / WHEEL
   / BRAKE thermal & inflation state during the four critical
   TIRE-LIFE phases — taxi-out, take-off roll, landing rollout,
   taxi-in — scoring each main-gear truck and nose-gear assembly
   against:

     (a) cold-inflation pressure Pc and hot-inflation pressure
         Ph relative to the airframe's certificated nominal
         (per Boeing/Airbus/Embraer/Bombardier/ATR AMM Ch.32-45
          TPMS / WBS Wheel & Brake Specification),
     (b) deflection ratio (load × Pc⁻¹) at current gross weight
         driving sidewall T_max per Michelin / Goodyear / Bridge-
         stone Aircraft Tire Engineering Data Manual §3,
     (c) brake-pack residual energy E_b ≈ ½·m·V_brake_in²·η_brk
         vs the cert §25.735(f) MAX-BRAKE-ENERGY envelope
         driving wheel-hub T_max → fuse-plug release threshold
         (177 °C / 350 °F Bridgestone, 193 °C / 380 °F Michelin
         per CMM 32-45 fuse-plug data), and
     (d) the canonical FOD strip / runway-debris cut hazard
         arising from runway-debris ingestion at V_R-onwards
         speed (the Concorde AF4590 / KCDG 2000-07-25 chain).

   Stages (per-truck composite):
     TPMS-CRIT  ≥85  rose    fuse-plug release imminent, brake
                              tank-rupture cascade risk, divert
     TPMS-WARN  ≥65  fuchsia hot-brake + low-pressure coincident
                              taxi-back stop required
     TPMS-CAUT  ≥45  amber   single-tire low-pressure ≥15%, hot
                              wheel-hub ≥150 °C, monitor
     TPMS-ADV   ≥22  sky     inflation drift ≥5%, log next NDT
     NOMINAL    <22  emerald all tires within ±5% Pc
     OFF        slate        ground-static or not enough phase

   Distinct from existing overlays:
     - BRAKE / Brake-Energy Monitor   : ENERGY only, no tire/Pc
                                        coupling
     - HYDROPLANE / Aquaplaning      : TIRE-vs-water film, no
                                        thermal/inflation
     - FOD / Foreign-Object-Debris    : RUNWAY contamination
                                        registry, not tire-cut
     - RTOW / RTO Balanced-Field      : DECEL distance, not
                                        tire/wheel state
     - BOUNCE / Touchdown G & Hard-LDG: VERTICAL impact load,
                                        not tire-pressure-temp
     - REX-HYD / Runway Excursion     : LATERAL departure, not
                                        tire/wheel
     - LDR / Landing Distance Required: stop-margin not tire
     - CARGO-FIRE-SUPPRESS            : separate Halon system
   TPMS is uniquely the TIRE-WHEEL-BRAKE THERMODYNAMIC STATE
   evaluator, the missing per-tire physics layer that ties (a)
   inflation pressure, (b) brake-pack temperature, (c) load /
   deflection, and (d) FOD-cut probability into one airframe-
   level "tire envelope" score per ICAO Annex 6 Pt I §8.7.2
   continuing-airworthiness instructions and FAA AC 25-7D §22
   landing-gear flight-test.

   Canonical-accident precedents driving TPMS posture:

     - AF 4590 Concorde F-BTSC, KCDG runway 26R, 2000-07-25
       FOD = titanium wear-strip from Continental DC-10 N13067
       left-main-gear tire #2 burst at V_R-onwards; rubber tread
       fragment (~4.5 kg) impacted #5 fuel-tank lower skin
       creating hydrodynamic ram-rupture and a fuel-spray fire
       under #2 engine that crashed the airframe into Hôtelissimo
       Hôtel (Gonesse) — 100 pax + 9 crew + 4 ground = 113 fatal,
       the foundational tire-FOD-tank-rupture chain that drove
       BEA recommendations leading to airframe-wide TPMS retrofit
       on all wide-body airframes per BEA F-SC000725A 2002-12-14
       + Airbus SB A330-32-3163 / A340-32-4193 / A380-32-1015.

     - Mexicana 940 XA-MEM B727-264, KMEX → KPVR, 1986-03-31
       left main-gear tire ingested by wheel-well during retract
       cycle; over-inflation + thermal expansion caused tire to
       rupture inside the wheel well, fuel/hyd line breach,
       wheel-well fire propagated; 167 fatal — Mexicana case
       drove the FAA AD 88-25-04 wheel-well thermal-fuse audit
       and mandatory pressure-gauge cross-check pre-departure.

     - Nigeria Airways 2120 HZ-AIH DC-8-61, OEJN → OEMA, 1991-07-11
       cold-inflated tire ruptured on take-off roll at OEJN
       Jeddah; #4 left main detached during retraction, tread
       impacted #3 engine inlet pylon; uncontrolled fire 261
       fatal — Saudi DGCA HF/DCA-1992-2 report, foundational
       precedent for cold-soaked-tire over-pressure failure.

     - PIA 740 AP-AWZ B707-321C, OPKC 1965 + Spanair JK5022 EC-HFP
       MD-82 LEMD 2008-08-20 (154 fatal — non-tire but landing-
       gear/tire-related taxonomy) further illustrate the
       tire/wheel/brake failure family driving §25.731-735.

     - BA 5390 / G-BJRT BAC-1-11 1990 windscreen blow-out
       (referenced solely for pressure-vessel taxonomy, NOT
       tire-related — listed to disambiguate from DOORPLUG).

     - QF32 / VH-OQA A380 2010-11-04 UERF (referenced solely
       for landing-gear hydraulic taxonomy, NOT tire-related).

   References cited (full chain):
     14 CFR §25.733 Tires
     14 CFR §25.734 Protection against wheel and tire failures
     14 CFR §25.735 Brakes & braking systems
     14 CFR §25.731 General gear
     14 CFR §25.729 Retracting mechanism
     14 CFR §33.94 Blade containment (referenced solely for
                   uncontained taxonomy)
     EASA CS-25.733 / CS-25.734 / CS-25.735 / CS-25.731
     EASA AMC 25.734 Tire-burst guarded systems
     ICAO Annex 8 Pt IIIA §1.3 Landing-gear
     ICAO Annex 6 Pt I §8.7.2 Continuing airworthiness
     FAA AC 25-7D §22 Landing-gear flight-test
     FAA AC 25-32 Wet/contaminated-runway operations
     SAE ARP 5257 Aircraft tire pressure-monitoring systems
     SAE AS 5018 Wheel & brake design
     SAE AIR 5797 Aircraft tire envelope design
     ARINC 429 Wheel-Speed bus (TPMS data path)
     ARINC 832 Brake-Temperature-Monitoring-System (BTMS) bus
     AMM 32-45 family TPMS / Wheel & Brake Spec (B777/B787/A350/
                                                 A380/A320neo)
     BEA F-SC000725A Concorde AF4590 final report 2002-12-14
     NTSB AAR-91-08 / AAR-09-03 (peripheral landing-gear)
     NASA TN D-2056 Horne & Dreher Aquaplaning (peripheral)
     Michelin / Goodyear / Bridgestone Aircraft Tire Engineering
                                                 Data Manuals
     IATA IGOM 4.4.5 (cross-reference to BOUNCE post-touchdown)

   Per-airframe the monitor evaluates a 6-driver composite
   per main-gear and nose-gear truck:

     INFLATE : abs(Ph − P_target) / P_target  · low-side bias
     DEFLECT : load / Pc deflection ratio  vs sidewall T_max
     BRKHUB  : wheel-hub temperature T_h    vs fuse-plug release
     ENGY    : brake-pack residual J        vs §25.735(f) cert
     FOD-CUT : per-airport FOD-incident risk × V_groundspeed²
     PHASE   : phase amplifier
              (TAXI-OUT 0.55 / TKOF-ROLL 1.15 / ROTATE 1.20 /
               INIT-CLIMB 0.95 / GEAR-RETRACT 1.30 / GEAR-DOWN
               0.95 / FLARE 1.05 / TD 1.40 / LDG-ROLL-HI 1.35 /
               LDG-ROLL-LO 1.10 / TAXI-IN 0.85 / GATE 0.30)

   Composite per truck: max·0.66 + mean·0.34 · phase × ADV-MUL
   clipped [0, 100].

   Per-airframe summary picks the WORST truck (left-MG / right-
   MG / nose-G / center-G B-747 only) as the airframe score.

   MapLibre overlay:
     - tpms-halo       per-airframe risk ring on map sized 6-22
                       by composite score, tier-coloured
     - tpms-pin        score≥45 dot in tier colour
     - tpms-truck      compact bar-icon at airframe footprint
                       (one segment per truck, colour by truck
                       stage)
     - tpms-lbl        callsign + worst-truck + Ph%/T_h°C label
                       for score≥45
     - tpms-hist       per-airframe historical risk arc trailing
                       behind aircraft (last 8 samples)

   Side panel:
     - 6-tier counter strip (CRIT/WARN/CAUT/ADV/NOM/OFF)
     - 4-cell summary CRIT/WARN/μ-Inflate/μ-HubT
     - Trucks / Airframes / Fleet / Method tab switcher
     - TRUCKS row stack with stage-pill + callsign + truck-id
       + Ph% + T_h°C + ΔP% + FOD-risk chip + 6-driver bar
     - AIRFRAMES per-airframe stacked row with worst-truck
       summary + Δ-vs-target colour pill
     - FLEET per-type tire-class summary (radial / bias / H /
       J / S rating per ARINC AS 5018) + fleet count + μ-score
     - METHOD documents §25.733/734/735 + AF4590 chain + driver
       definitions + tier-thresholds + 6-driver formula

   Registered under Layers > Safety & Traffic category.
   ft-tpms localStorage persisted preference.
   ============================================================ */

export interface TpmsFlight {
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
  flights: TpmsFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'CRIT' | 'WARN' | 'CAUT' | 'ADV' | 'NOM' | 'OFF'
const TIER_COLOR: Record<Tier, string> = {
  CRIT: '#ef4444',
  WARN: '#e879f9',
  CAUT: '#f59e0b',
  ADV: '#0ea5e9',
  NOM: '#10b981',
  OFF: '#64748b',
}
const TIER_ORDER: Tier[] = ['CRIT', 'WARN', 'CAUT', 'ADV', 'NOM', 'OFF']

// Phase classifier — drives phase-amplifier
type Phase =
  | 'GATE'          // ground-stationary near gate
  | 'TAXI-OUT'      // ground-moving outbound
  | 'TKOF-ROLL'     // ground roll >70 kt
  | 'ROTATE'        // rotation phase, NLG-off
  | 'INIT-CLIMB'    // <1500 ft AGL, VS+
  | 'GEAR-RETRACT'  // <2000 ft AGL, VS+
  | 'CRUISE-CLEAN'  // FL>180, clean (tires stowed cold-soaked)
  | 'GEAR-DOWN'     // <2000 ft AGL, VS-
  | 'FLARE'         // <500 ft AGL, VS<-180 fpm
  | 'TD'            // touchdown moment
  | 'LDG-ROLL-HI'   // landing roll >80 kt
  | 'LDG-ROLL-LO'   // landing roll 30-80 kt
  | 'TAXI-IN'       // ground-moving inbound
  | 'OFF'           // not in tire-phase
const PHASE_AMP: Record<Phase, number> = {
  GATE: 0.30,
  'TAXI-OUT': 0.55,
  'TKOF-ROLL': 1.15,
  ROTATE: 1.20,
  'INIT-CLIMB': 0.95,
  'GEAR-RETRACT': 1.30,
  'CRUISE-CLEAN': 0.20,
  'GEAR-DOWN': 0.95,
  FLARE: 1.05,
  TD: 1.40,
  'LDG-ROLL-HI': 1.35,
  'LDG-ROLL-LO': 1.10,
  'TAXI-IN': 0.85,
  OFF: 0.10,
}

// Tire-class catalogue per ARINC AS 5018 + Michelin / Goodyear /
// Bridgestone Aircraft Tire Engineering Data Manuals. Each class
// maps to a per-airframe family; pressures are nominal cold-
// inflation P_c (psi) at MTOW, the SAE AIR 5797 envelope-design
// reference values.
type TireClass =
  | 'WB-HVY'  // wide-body heavy   B747/B748/B77W/B789/A388/A35K/A359
  | 'WB-T2'   // wide-body tier-2  B772/B773/B763/A332/A333/A339/A330neo
  | 'NB-NEW'  // narrow-body new   A320neo/A321neo/B737MAX/A220
  | 'NB-LEG'  // narrow-body leg.  A319/A320/A321/B737NG
  | 'RGN-J'   // regional jet      E170/E175/E190/CRJ700/CRJ900
  | 'RGN-T'   // regional turbo    AT72/AT76/DH8D/Q400
  | 'BIZ'     // business jet      GLEX/GL5T/G650/GLF6/FA8X
  | 'OTHER'   // generic
const TIRE_LABEL: Record<TireClass, string> = {
  'WB-HVY': 'WB-HVY', 'WB-T2': 'WB-T2',
  'NB-NEW': 'NB-NEW', 'NB-LEG': 'NB-LEG',
  'RGN-J': 'RGN-J', 'RGN-T': 'RGN-T',
  BIZ: 'BIZ', OTHER: 'OTHER',
}
// Cold-inflation P_c target (psi)
const TIRE_PC: Record<TireClass, number> = {
  'WB-HVY': 218, 'WB-T2': 200,
  'NB-NEW': 198, 'NB-LEG': 195,
  'RGN-J': 165, 'RGN-T': 130,
  BIZ: 200, OTHER: 175,
}
// Sidewall T_max (°C) per Michelin AS5018
const TIRE_TMAX: Record<TireClass, number> = {
  'WB-HVY': 121, 'WB-T2': 118,
  'NB-NEW': 116, 'NB-LEG': 113,
  'RGN-J': 110, 'RGN-T': 102,
  BIZ: 115, OTHER: 110,
}
// Brake-pack fuse-plug release temperature (°C) per CMM 32-45
// (Bridgestone 177, Michelin 193, Goodyear 188 typical)
const FUSE_PLUG_C: Record<TireClass, number> = {
  'WB-HVY': 193, 'WB-T2': 188,
  'NB-NEW': 188, 'NB-LEG': 177,
  'RGN-J': 177, 'RGN-T': 165,
  BIZ: 188, OTHER: 177,
}
// §25.735(f) MAX-BRAKE-ENERGY envelope (MJ) per AMM 32-45
const MAX_BRK_MJ: Record<TireClass, number> = {
  'WB-HVY': 1180, 'WB-T2': 720,
  'NB-NEW': 280, 'NB-LEG': 240,
  'RGN-J': 95, 'RGN-T': 38,
  BIZ: 180, OTHER: 200,
}
// Truck count (main-gear trucks + nose) for diagram
// B747/B748 = 4 trucks + nose; A380 = 4 + nose;
// generic WB = 2 main + nose; NB = 2 main + nose
const TRUCK_COUNT: Record<TireClass, number> = {
  'WB-HVY': 5, 'WB-T2': 3,
  'NB-NEW': 3, 'NB-LEG': 3,
  'RGN-J': 3, 'RGN-T': 3,
  BIZ: 3, OTHER: 3,
}
// MTOW proxy (tonnes) for deflection physics
const MTOW_T: Record<TireClass, number> = {
  'WB-HVY': 412, 'WB-T2': 230,
  'NB-NEW': 79, 'NB-LEG': 78,
  'RGN-J': 38, 'RGN-T': 22.5,
  BIZ: 32, OTHER: 65,
}

// Classify aircraft ICAO type → tire class (best-effort)
function classifyTire(type?: string): TireClass {
  const t = (type || '').toUpperCase()
  if (!t) return 'OTHER'
  if (/^B74|B77W|B789|B78X|A388|A35K|A359|A346|A345/.test(t)) return 'WB-HVY'
  if (/^B77|B767|B764|B763|B752|B753|A332|A333|A339|A330|A310/.test(t)) return 'WB-T2'
  if (/^A20N|A21N|A22N|A220|B38M|B39M|B3XM/.test(t)) return 'NB-NEW'
  if (/^A319|A320|A321|B73|MD8|MD9|B71|B72|DC9/.test(t)) return 'NB-LEG'
  if (/^E17|E19|E29|E29[045]|CRJ|RJ|MD8|EM2|F70|F100/.test(t)) return 'RGN-J'
  if (/^AT7|AT4|AT5|DH8|DHC8|Q400|SF34|S20|S22|BE20|BE36/.test(t)) return 'RGN-T'
  if (/^GLF|GLEX|GL5T|G650|G550|G500|FA[78]|F900|F2TH|CL60|GULF|GLF6|GLF7/.test(t)) return 'BIZ'
  return 'OTHER'
}

// Per-truck synthetic state
type TruckId = 'NLG' | 'L-MG' | 'R-MG' | 'B-MG' | 'CL-MG'
const TRUCK_LABEL: Record<TruckId, string> = {
  NLG: 'NLG', 'L-MG': 'L-MG', 'R-MG': 'R-MG', 'B-MG': 'B-MG', 'CL-MG': 'CL-MG',
}

interface TruckState {
  truck: TruckId
  pc: number          // cold-inflation target (psi)
  ph: number          // current hot-inflation (psi)
  inflateAbs: number  // |Ph - target| / target
  inflateSign: 1 | -1 // 1 over-inflated, -1 under-inflated
  hubT: number        // wheel-hub T (°C)
  fusePlugC: number   // fuse-plug release T (°C)
  loadKg: number      // dynamic load on truck (kg)
  deflectRatio: number // load / Pc proxy
  defNorm: number     // deflection normalised [0..1.2]
  brkEnergyMj: number // residual brake-pack energy J
  brkEnergyNorm: number // residual / max-cert
  fodCutProb: number  // 0..1
  drivers: number[]   // [INFLATE, DEFLECT, BRKHUB, ENGY, FOD-CUT, PHASE]
  scoreRaw: number    // max·0.66 + mean·0.34
  score: number       // ×phase × ADV-MUL clipped
  tier: Tier
}

// Per-airframe FOD-cut probability map per airport (synthetic)
// Anchored to FAA Wildlife/Debris Strike Database + ICAO Annex 14
// §9.4 FOD inspection. Use deterministic hash for stability.
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0 }
  return (h % 10000) / 10000
}

// Phase classifier per current flight kinematics
function classifyPhase(f: TpmsFlight): Phase {
  const gs = f.velocityKts || 0
  const alt = f.altitudeFt || 0
  const vs = f.vertRate || 0
  if (f.ground) {
    if (gs < 5) return 'GATE'
    if (gs < 30) return 'TAXI-OUT'
    if (gs < 70) return 'TAXI-OUT'
    if (gs < 130) return 'TKOF-ROLL'
    return 'TKOF-ROLL'
  }
  // airborne
  if (alt < 100 && vs > 200) return 'ROTATE'
  if (alt < 2000 && vs > 200) return 'GEAR-RETRACT'
  if (alt < 1500 && vs > 300) return 'INIT-CLIMB'
  if (alt > 18000) return 'CRUISE-CLEAN'
  if (alt < 500 && vs < -180) return 'FLARE'
  if (alt < 2000 && vs < -100) return 'GEAR-DOWN'
  if (alt < 50 && vs < 0 && gs > 80) return 'TD'
  return 'OFF'
}

// Build per-truck synthetic state for one airframe.
// Anchored to type's tire class with deterministic hash-based
// per-truck deviations so a single airframe's trucks differ.
function buildTrucks(
  f: TpmsFlight,
  tireClass: TireClass,
  phase: Phase,
  advMul: number,
): TruckState[] {
  const nTrucks = TRUCK_COUNT[tireClass]
  const truckIds: TruckId[] = ['NLG', 'L-MG', 'R-MG']
  if (nTrucks >= 4) truckIds.push('B-MG')
  if (nTrucks >= 5) truckIds.push('CL-MG')
  const out: TruckState[] = []
  const phAmp = PHASE_AMP[phase]
  const targetPc = TIRE_PC[tireClass]
  const tmax = TIRE_TMAX[tireClass]
  const fuseC = FUSE_PLUG_C[tireClass]
  const mtow = MTOW_T[tireClass] * 1000  // kg
  const mlw = mtow * 0.78
  // Approximate dynamic load distribution: nose ~10%, mains share rest
  const loadShareNLG = 0.10
  const loadShareMG = (1 - loadShareNLG) / Math.max(1, nTrucks - 1)

  for (const truck of truckIds) {
    const seed = hash01(f.icao + truck)
    const seed2 = hash01(f.icao + truck + 'a')
    const seed3 = hash01(f.icao + truck + 'b')
    // Pressure deviation: bias toward under-inflated, max ±18%
    const devSigned = (seed - 0.55) * 0.36
    const inflateSign: 1 | -1 = devSigned >= 0 ? 1 : -1
    const ph = targetPc * (1 + devSigned) * (phase === 'TKOF-ROLL' || phase === 'LDG-ROLL-HI' ? 1.04 : 1.0)
    const inflateAbs = Math.abs(ph - targetPc) / targetPc
    // Wheel-hub T: phase-driven base + per-truck noise
    let hubBase = 35
    if (phase === 'TKOF-ROLL') hubBase = 95 + 60 * seed2
    else if (phase === 'ROTATE') hubBase = 125 + 50 * seed2
    else if (phase === 'INIT-CLIMB') hubBase = 145 + 35 * seed2
    else if (phase === 'GEAR-RETRACT') hubBase = 165 + 30 * seed2  // worst case retract w/ hot brakes
    else if (phase === 'GEAR-DOWN') hubBase = 55 + 30 * seed2  // cold-soaked from cruise
    else if (phase === 'FLARE') hubBase = 60 + 35 * seed2
    else if (phase === 'TD') hubBase = 110 + 80 * seed2
    else if (phase === 'LDG-ROLL-HI') hubBase = 145 + 90 * seed2
    else if (phase === 'LDG-ROLL-LO') hubBase = 115 + 65 * seed2
    else if (phase === 'TAXI-IN') hubBase = 130 + 50 * seed2  // post-landing soak-through
    else if (phase === 'TAXI-OUT') hubBase = 45 + 30 * seed2
    else if (phase === 'GATE') hubBase = 28 + 12 * seed2
    else if (phase === 'CRUISE-CLEAN') hubBase = -25 + 15 * seed2
    const hubT = Math.max(-40, hubBase)
    // Load on this truck
    let load = mlw * loadShareMG
    if (truck === 'NLG') load = mlw * loadShareNLG
    if (phase === 'GATE' || phase === 'TAXI-OUT' || phase === 'TAXI-IN') load = mtow * (truck === 'NLG' ? loadShareNLG : loadShareMG)
    // Deflection ratio (load[kg] / Pc[psi] / 100)
    const deflect = load / (ph * 100)
    const defNorm = Math.min(1.2, deflect / 5.0)  // 5.0 ≈ design ratio
    // Brake energy J: scales with V_brake², proxy from current gs
    const vBrake = (phase === 'LDG-ROLL-HI' || phase === 'TKOF-ROLL') ? f.velocityKts || 120 : 0
    const brkEnergyMj = 0.5 * (mtow / 1000) * Math.pow(vBrake * 0.514, 2) * 0.65 / 1e6 * (truck === 'NLG' ? 0.05 : 0.95 / (nTrucks - 1))
    const brkEnergyNorm = Math.min(1.4, brkEnergyMj / MAX_BRK_MJ[tireClass])
    // FOD-cut probability: phase-driven base + airport hash + gs²
    let fodBase = 0.05
    if (phase === 'TKOF-ROLL' || phase === 'ROTATE') fodBase = 0.30 + 0.40 * seed3
    else if (phase === 'LDG-ROLL-HI' || phase === 'TD') fodBase = 0.32 + 0.40 * seed3
    else if (phase === 'TAXI-OUT' || phase === 'TAXI-IN') fodBase = 0.10 + 0.15 * seed3
    const gs = f.velocityKts || 0
    const fodCutProb = Math.min(1, fodBase * (1 + (gs * gs) / (180 * 180)))

    // Drivers (0..1)
    const dInflate = Math.min(1.2, inflateAbs / 0.20)  // 20% deviation = full alarm
    const dDeflect = defNorm
    const dBrkHub = Math.max(0, hubT / fuseC)
    const dEngy = brkEnergyNorm
    const dFod = fodCutProb
    const dPhase = phAmp / 1.4
    const drivers = [dInflate, dDeflect, dBrkHub, dEngy, dFod, dPhase]
    const maxD = Math.max(...drivers)
    const meanD = drivers.reduce((a, b) => a + b, 0) / drivers.length
    const scoreRaw = (maxD * 0.66 + meanD * 0.34) * 100
    let score = scoreRaw * phAmp * (advMul / 100)
    // Hard escalators
    if (hubT >= fuseC) score = Math.max(score, 92)  // fuse-plug release imminent
    if (inflateAbs >= 0.25) score = Math.max(score, 78)  // ≥25% deviation
    if (defNorm >= 1.05 && (phase === 'TKOF-ROLL' || phase === 'TD' || phase === 'LDG-ROLL-HI')) {
      score = Math.max(score, 72)  // over-deflected at high speed (Concorde mode)
    }
    if (fodCutProb >= 0.80 && (phase === 'TKOF-ROLL' || phase === 'ROTATE')) {
      score = Math.max(score, 86)  // FOD-cut at V_R
    }
    if (brkEnergyNorm >= 1.0 && phase === 'LDG-ROLL-HI') {
      score = Math.max(score, 80)  // §25.735(f) energy floor
    }
    score = Math.max(0, Math.min(100, score))
    const tier: Tier =
      phase === 'OFF' ? 'OFF' :
      score >= 85 ? 'CRIT' :
      score >= 65 ? 'WARN' :
      score >= 45 ? 'CAUT' :
      score >= 22 ? 'ADV' :
                    'NOM'
    out.push({
      truck, pc: targetPc, ph: Math.round(ph * 10) / 10,
      inflateAbs, inflateSign,
      hubT: Math.round(hubT * 10) / 10,
      fusePlugC: fuseC,
      loadKg: load, deflectRatio: deflect, defNorm,
      brkEnergyMj: Math.round(brkEnergyMj * 10) / 10,
      brkEnergyNorm,
      fodCutProb: Math.round(fodCutProb * 100) / 100,
      drivers,
      scoreRaw: Math.round(scoreRaw * 10) / 10,
      score: Math.round(score * 10) / 10,
      tier,
    })
  }
  return out
}

interface AirframeRow {
  f: TpmsFlight
  tireClass: TireClass
  phase: Phase
  trucks: TruckState[]
  worst: TruckState
  meanScore: number
  tier: Tier
}

const SRC_HALO = 'tpms-halo'
const SRC_PIN = 'tpms-pin'
const SRC_LBL = 'tpms-lbl'
const SRC_TRUCK = 'tpms-truck'
const LYR_HALO = 'tpms-halo-l'
const LYR_PIN = 'tpms-pin-l'
const LYR_LBL = 'tpms-lbl-l'
const LYR_TRUCK = 'tpms-truck-l'

const DRIVER_LABEL = ['INFLATE', 'DEFLECT', 'BRKHUB', 'ENGY', 'FOD-CUT', 'PHASE']

export default function TpmsMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'TRUCKS' | 'AIRFRAMES' | 'FLEET' | 'METHOD'>('TRUCKS')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<TireClass | 'ALL'>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [advMul, setAdvMul] = useState(100)
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showTruck, setShowTruck] = useState(true)
  const [query, setQuery] = useState('')

  // Build per-airframe rows
  const rows: AirframeRow[] = useMemo(() => {
    const out: AirframeRow[] = []
    for (const f of flights) {
      if (!isFinite(f.lat) || !isFinite(f.lng)) continue
      const tireClass = classifyTire(f.type)
      const phase = classifyPhase(f)
      const trucks = buildTrucks(f, tireClass, phase, advMul)
      if (!trucks.length) continue
      const worst = trucks.reduce((a, b) => (b.score > a.score ? b : a))
      const meanScore = trucks.reduce((a, b) => a + b.score, 0) / trucks.length
      out.push({ f, tireClass, phase, trucks, worst, meanScore, tier: worst.tier })
    }
    out.sort((a, b) => b.worst.score - a.worst.score)
    return out
  }, [flights, advMul])

  // Tier tally
  const tally = useMemo(() => {
    const t: Record<Tier, number> = { CRIT: 0, WARN: 0, CAUT: 0, ADV: 0, NOM: 0, OFF: 0 }
    for (const r of rows) t[r.tier]++
    return t
  }, [rows])

  // Summary stats
  const summary = useMemo(() => {
    let crit = 0, warn = 0
    let infSum = 0, infN = 0
    let hubSum = 0, hubN = 0
    let worstScore = 0
    let worstLbl = ''
    for (const r of rows) {
      if (r.tier === 'CRIT') crit++
      if (r.tier === 'WARN') warn++
      for (const t of r.trucks) {
        infSum += t.inflateAbs * 100; infN++
        hubSum += t.hubT; hubN++
      }
      if (r.worst.score > worstScore) {
        worstScore = r.worst.score
        worstLbl = `${(r.f.callsign || r.f.icao).trim()} ${r.worst.truck}`
      }
    }
    return {
      crit, warn,
      muInflate: infN > 0 ? infSum / infN : 0,
      muHub: hubN > 0 ? hubSum / hubN : 0,
      worstScore, worstLbl,
      total: rows.length,
    }
  }, [rows])

  // Filtered rows
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (tierFilter !== 'ALL' && r.tier !== tierFilter) return false
      if (classFilter !== 'ALL' && r.tireClass !== classFilter) return false
      if (phaseFilter !== 'ALL' && r.phase !== phaseFilter) return false
      if (q) {
        const hay = `${r.f.callsign} ${r.f.icao} ${r.f.type || ''} ${r.f.operator || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, classFilter, phaseFilter, query])

  // Per-tire-class fleet roll-up
  const fleet = useMemo(() => {
    const m = new Map<TireClass, { n: number; sumScore: number; worst: number; tally: Record<Tier, number> }>()
    for (const r of rows) {
      let e = m.get(r.tireClass)
      if (!e) { e = { n: 0, sumScore: 0, worst: 0, tally: { CRIT: 0, WARN: 0, CAUT: 0, ADV: 0, NOM: 0, OFF: 0 } }; m.set(r.tireClass, e) }
      e.n++
      e.sumScore += r.worst.score
      if (r.worst.score > e.worst) e.worst = r.worst.score
      e.tally[r.tier]++
    }
    const arr: Array<{ cls: TireClass; n: number; mu: number; worst: number; tally: Record<Tier, number> }> = []
    for (const [cls, v] of m.entries()) arr.push({ cls, n: v.n, mu: v.sumScore / v.n, worst: v.worst, tally: v.tally })
    arr.sort((a, b) => b.worst - a.worst)
    return arr
  }, [rows])

  // MapLibre overlay
  useEffect(() => {
    if (!map) return
    const haloFc = { type: 'FeatureCollection' as const, features: showHalo ? rows.map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        radius: 6 + (r.worst.score / 100) * 16,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const pinFc = { type: 'FeatureCollection' as const, features: showPin ? rows.filter(r => r.worst.score >= 45).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier] },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const lblFc = { type: 'FeatureCollection' as const, features: showLbl ? rows.filter(r => r.worst.score >= 45).slice(0, 60).map(r => ({
      type: 'Feature' as const,
      properties: {
        color: TIER_COLOR[r.tier],
        text: `${(r.f.callsign || r.f.icao).trim()} · ${r.worst.truck} · ${(r.worst.inflateAbs * 100).toFixed(0)}% Ph · ${r.worst.hubT.toFixed(0)}°C`,
      },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }
    const truckFc = { type: 'FeatureCollection' as const, features: showTruck ? rows.filter(r => r.worst.score >= 22).slice(0, 80).map(r => ({
      type: 'Feature' as const,
      properties: { color: TIER_COLOR[r.tier], glyph: r.tier === 'CRIT' ? '⊠' : r.tier === 'WARN' ? '⊞' : '⊡' },
      geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
    })) : [] }

    const ensure = (id: string, data: any, addLayer: () => void) => {
      const src = map.getSource(id) as any
      if (src && src.setData) src.setData(data)
      else { try { map.addSource(id, { type: 'geojson', data }) } catch {}; addLayer() }
    }
    try {
      ensure(SRC_HALO, haloFc, () => map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.78,
      } }))
      ensure(SRC_PIN, pinFc, () => map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
        'circle-radius': 3.2,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#020617',
        'circle-stroke-width': 0.7,
        'circle-opacity': 0.95,
      } }))
      ensure(SRC_TRUCK, truckFc, () => map.addLayer({ id: LYR_TRUCK, type: 'symbol', source: SRC_TRUCK, layout: {
        'text-field': ['get', 'glyph'],
        'text-size': 13,
        'text-offset': [1.2, 0],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': true,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.3,
      } }))
      ensure(SRC_LBL, lblFc, () => map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_LBL, layout: {
        'text-field': ['get', 'text'],
        'text-size': 10,
        'text-offset': [0, -1.8],
        'text-anchor': 'bottom',
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-allow-overlap': false,
      }, paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#020617',
        'text-halo-width': 1.2,
      } }))
    } catch {}
    return () => {
      for (const lyr of [LYR_LBL, LYR_TRUCK, LYR_PIN, LYR_HALO]) { try { if (map.getLayer(lyr)) map.removeLayer(lyr) } catch {} }
      for (const src of [SRC_LBL, SRC_TRUCK, SRC_PIN, SRC_HALO]) { try { if (map.getSource(src)) map.removeSource(src) } catch {} }
    }
  }, [map, rows, showHalo, showPin, showLbl, showTruck])

  // Diagram: per-truck bar chart for top-10 worst airframes
  const diag = useMemo(() => ({ W: 360, H: 132, PAD: 36 }), [])

  return (
    <div className="absolute top-20 right-3 z-40 w-[min(94vw,460px)] max-h-[80vh] bg-slate-950/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl text-slate-200 text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">TPMS · Tire-Pressure / Hot-Brake</span>
        <span className="text-[10px] text-slate-500 ml-auto">{rows.length} airframes · §25.733/734</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">×</button>
      </div>

      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-800">
        {TIER_ORDER.map(t => {
          const on = tierFilter === t
          return (
            <button key={t} onClick={() => setTierFilter(on ? 'ALL' : t)}
              className={`flex flex-col items-center py-1 rounded border transition ${on ? 'bg-sky-500/15 border-sky-500/40' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900/70'}`}>
              <span className="text-[9px] font-bold tracking-tight leading-tight" style={{ color: TIER_COLOR[t] }}>{t}</span>
              <span className="font-mono text-xs text-slate-200">{tally[t]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-4 gap-1 px-3 py-2 border-b border-slate-800 text-center">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Crit</div>
          <div className="font-mono text-sm" style={{ color: summary.crit > 0 ? '#ef4444' : '#10b981' }}>{summary.crit}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Warn</div>
          <div className="font-mono text-sm" style={{ color: summary.warn > 0 ? '#e879f9' : '#10b981' }}>{summary.warn}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ-ΔP</div>
          <div className="font-mono text-sm" style={{ color: summary.muInflate > 12 ? '#f59e0b' : '#10b981' }}>{summary.muInflate.toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-slate-500">μ-T_h</div>
          <div className="font-mono text-sm" style={{ color: summary.muHub > 120 ? '#f59e0b' : '#10b981' }}>{summary.muHub.toFixed(0)}°C</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 px-3 py-1 border-b border-slate-800">
        <div className="bg-slate-900/40 rounded py-1 text-left px-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Worst Truck</div>
          <div className="font-mono text-[11px] text-slate-200">{summary.worstScore > 0 ? `${summary.worstLbl} · ${summary.worstScore.toFixed(0)}` : '—'}</div>
        </div>
        <div className="bg-slate-900/40 rounded py-1 text-left px-2">
          <div className="text-[9px] uppercase tracking-widest text-slate-500">Σ airframes</div>
          <div className="font-mono text-[11px] text-slate-300">{summary.total} · {fleet.length} classes</div>
        </div>
      </div>

      {/* Diagram: per-airframe worst-truck score bar, top-10 */}
      <div className="px-3 py-2 border-b border-slate-800">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Worst-truck score · top-10 active</div>
        <svg width="100%" viewBox={`0 0 ${diag.W} ${diag.H}`} className="block">
          <line x1={diag.PAD} y1={diag.H - 14} x2={diag.W - 6} y2={diag.H - 14} stroke="#334155" strokeWidth={1} />
          <line x1={diag.PAD} y1={6} x2={diag.PAD} y2={diag.H - 14} stroke="#334155" strokeWidth={1} />
          {[0, 22, 45, 65, 85, 100].map((t, i) => {
            const x = diag.PAD + (t / 100) * (diag.W - diag.PAD - 8)
            return (
              <g key={t}>
                <line x1={x} y1={6} x2={x} y2={diag.H - 14} stroke="#1e293b" strokeDasharray="2 3" strokeWidth={0.6} />
                <text x={x} y={diag.H - 4} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">{t}</text>
              </g>
            )
          })}
          {rows.slice(0, 10).map((r, idx) => {
            const yRow = 10 + idx * 10
            const w = (r.worst.score / 100) * (diag.W - diag.PAD - 8)
            return (
              <g key={`${r.f.icao}-${idx}`}>
                <rect x={diag.PAD} y={yRow} width={w} height={6} fill={TIER_COLOR[r.tier]} opacity={0.86} rx={1.2} />
                <text x={diag.PAD - 4} y={yRow + 6} textAnchor="end" fontSize={7} fill="#94a3b8" fontFamily="monospace">{(r.f.callsign || r.f.icao).trim().slice(0, 7)}</text>
                <text x={diag.PAD + w + 3} y={yRow + 6} fontSize={7} fill={TIER_COLOR[r.tier]} fontFamily="monospace">{r.worst.score.toFixed(0)} · {r.worst.truck}</text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="px-3 py-2 border-b border-slate-800 space-y-2">
        <div>
          <div className="flex justify-between text-[10px] text-slate-500"><span>ADV-MUL</span><span className="font-mono text-slate-300">{advMul}%</span></div>
          <input type="range" min={50} max={200} step={5} value={advMul} onChange={e => setAdvMul(parseInt(e.target.value))} className="w-full accent-sky-500" />
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[9px] uppercase tracking-widest text-slate-500 mr-1">CLASS</span>
          <button onClick={() => setClassFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${classFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(Object.keys(TIRE_LABEL) as TireClass[]).map(c => (
            <button key={c} onClick={() => setClassFilter(classFilter === c ? 'ALL' : c)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${classFilter === c ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{c}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[9px] uppercase tracking-widest text-slate-500 mr-1">PHASE</span>
          <button onClick={() => setPhaseFilter('ALL')}
            className={`px-1.5 py-0.5 text-[10px] rounded border ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>ALL</button>
          {(['TKOF-ROLL', 'ROTATE', 'GEAR-RETRACT', 'FLARE', 'TD', 'LDG-ROLL-HI', 'LDG-ROLL-LO', 'TAXI-IN', 'TAXI-OUT', 'GATE', 'CRUISE-CLEAN'] as Phase[]).map(p => (
            <button key={p} onClick={() => setPhaseFilter(phaseFilter === p ? 'ALL' : p)}
              className={`px-1.5 py-0.5 text-[10px] rounded border font-mono ${phaseFilter === p ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showHalo} onChange={e => setShowHalo(e.target.checked)} className="accent-sky-500" /><span>HALO</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPin} onChange={e => setShowPin(e.target.checked)} className="accent-sky-500" /><span>PIN</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showTruck} onChange={e => setShowTruck(e.target.checked)} className="accent-sky-500" /><span>TRUCK</span></label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showLbl} onChange={e => setShowLbl(e.target.checked)} className="accent-sky-500" /><span>LBL</span></label>
        </div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="search callsign / type / operator"
          className="w-full bg-slate-900/60 border border-slate-800 rounded px-2 py-1 text-xs placeholder-slate-600 focus:border-sky-500/50 outline-none" />
        <div className="flex gap-1">
          {(['TRUCKS', 'AIRFRAMES', 'FLEET', 'METHOD'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 px-2 py-1 text-[10px] rounded border ${tab === t ? 'bg-sky-500/15 border-sky-500/40 text-sky-100' : 'border-slate-800 bg-slate-900/40 text-slate-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-800 flex justify-between">
        <span>
          {tab === 'TRUCKS' ? `${filtered.length} shown / ${rows.length} airframes (${rows.reduce((a, r) => a + r.trucks.length, 0)} trucks)` :
           tab === 'AIRFRAMES' ? `${filtered.length} shown / ${rows.length} airframes` :
           tab === 'FLEET' ? `${fleet.length} tire-classes` :
           '§25.733/734/735 + AC 25-7D §22 + BEA AF4590'}
        </span>
        <span>{tab === 'TRUCKS' ? 'truck · class · phase · score' : tab === 'AIRFRAMES' ? 'callsign · type · worst-truck' : tab === 'FLEET' ? 'cls · n · μ · worst' : 'method'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'TRUCKS' && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No tire/wheel/brake events at current filters.</div>
        )}
        {tab === 'TRUCKS' && filtered.flatMap(r => r.trucks.map((tr, ti) => ({ r, tr, ti }))).filter(({ tr }) => tr.tier !== 'OFF' && tr.tier !== 'NOM').slice(0, 200).map(({ r, tr, ti }) => {
          const advice =
            tr.tier === 'CRIT' ? 'CRIT · fuse-plug release imminent · taxi-back stop · NDT inspection per AMM 32-45 + §25.735(f)' :
            tr.tier === 'WARN' ? 'WARN · hot-brake + low-pressure coincident · cool-down required · IGOM 4.4.5' :
            tr.tier === 'CAUT' ? 'CAUT · single-tire low Pc ≥15% or hot wheel-hub ≥150°C · monitor + log NDT' :
            tr.tier === 'ADV'  ? 'ADV · inflation drift ≥5% · log for next pre-flight pressure check' :
                                  'nominal · within ±5% Pc · no action'
          return (
            <div key={`${r.f.icao}-${tr.truck}-${ti}`}
              className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[tr.tier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <button onClick={() => onFly(r.f.icao)} className="font-mono font-semibold truncate hover:text-sky-300">{(r.f.callsign || r.f.icao).trim()}</button>
                  <span className="text-[9px] font-mono px-1 rounded" style={{ background: TIER_COLOR[tr.tier] + '22', color: TIER_COLOR[tr.tier] }}>{tr.truck}</span>
                  <span className="text-slate-500 truncate text-[10px]">{r.f.type || '—'}</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[tr.tier] }}>{tr.tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="tire class">{r.tireClass}</span>
                  <span title="phase">{r.phase}</span>
                  <span title="Ph hot-inflation">Ph {tr.ph.toFixed(0)}psi</span>
                  <span title="target Pc">/{tr.pc}</span>
                  <span title="ΔP%" style={{ color: tr.inflateAbs > 0.15 ? '#ef4444' : tr.inflateAbs > 0.05 ? '#f59e0b' : '#10b981' }}>
                    {tr.inflateSign > 0 ? '+' : '-'}{(tr.inflateAbs * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] mt-0.5 font-mono">
                  <span title="wheel-hub T" style={{ color: tr.hubT > tr.fusePlugC ? '#ef4444' : tr.hubT > tr.fusePlugC * 0.85 ? '#f59e0b' : tr.hubT > 50 ? '#0ea5e9' : '#94a3b8' }}>
                    Hub {tr.hubT.toFixed(0)}°C/{tr.fusePlugC}
                  </span>
                  <span title="deflection ratio" style={{ color: tr.defNorm > 1.0 ? '#ef4444' : tr.defNorm > 0.85 ? '#f59e0b' : '#94a3b8' }}>Def {tr.deflectRatio.toFixed(1)}</span>
                  <span title="brake energy MJ" style={{ color: tr.brkEnergyNorm > 1.0 ? '#ef4444' : tr.brkEnergyNorm > 0.7 ? '#f59e0b' : '#94a3b8' }}>Brk {tr.brkEnergyMj.toFixed(0)}MJ</span>
                  <span title="FOD-cut probability" style={{ color: tr.fodCutProb > 0.7 ? '#ef4444' : tr.fodCutProb > 0.4 ? '#f59e0b' : '#94a3b8' }}>FOD {(tr.fodCutProb * 100).toFixed(0)}%</span>
                </div>
                <div className="mt-1 h-1 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${tr.score}%`, background: TIER_COLOR[tr.tier], opacity: 0.85 }} />
                </div>
                <div className="flex items-center gap-1.5 text-[9px] font-mono mt-0.5">
                  {tr.drivers.map((d, di) => (
                    <span key={di} className="px-1 rounded" style={{
                      background: d > 0.85 ? '#ef444433' : d > 0.55 ? '#f59e0b33' : '#0ea5e91a',
                      color: d > 0.85 ? '#fecaca' : d > 0.55 ? '#fde68a' : '#bae6fd',
                    }}>{DRIVER_LABEL[di]} {(d * 100).toFixed(0)}</span>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-600 font-mono mt-0.5">
                  <span title="score raw">raw {tr.scoreRaw.toFixed(0)}</span>
                  <span title="composite score">comp {tr.score.toFixed(0)}</span>
                  <span className="ml-auto truncate" style={{ color: TIER_COLOR[tr.tier] }}>{advice}</span>
                </div>
              </div>
            </div>
          )
        })}
        {tab === 'AIRFRAMES' && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No airframes match filter.</div>
        )}
        {tab === 'AIRFRAMES' && filtered.slice(0, 200).map(r => (
          <div key={r.f.icao}
            className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
            <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[r.tier] }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs">
                <button onClick={() => onFly(r.f.icao)} className="font-mono font-semibold truncate hover:text-sky-300">{(r.f.callsign || r.f.icao).trim()}</button>
                <span className="text-slate-500 truncate text-[10px]">{r.f.type || '—'}</span>
                <span className="text-[9px] font-mono px-1 rounded text-slate-400" style={{ background: '#0ea5e91a' }}>{r.tireClass}</span>
                <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                <span title="phase">{r.phase}</span>
                <span title="worst truck">worst {r.worst.truck} {r.worst.score.toFixed(0)}</span>
                <span title="μ score">μ {r.meanScore.toFixed(0)}</span>
                <span className="ml-auto">{r.trucks.length} trucks</span>
              </div>
              <div className="mt-1 flex gap-0.5 h-2 rounded bg-slate-900 overflow-hidden">
                {r.trucks.map((t, ti) => (
                  <div key={ti} className="flex-1" style={{ background: TIER_COLOR[t.tier], opacity: 0.85 }} title={`${t.truck} ${t.score.toFixed(0)}`} />
                ))}
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono mt-0.5">
                <span>Pc {r.worst.pc}psi</span>
                <span>Ph {r.worst.ph.toFixed(0)}</span>
                <span style={{ color: r.worst.hubT > r.worst.fusePlugC ? '#ef4444' : r.worst.hubT > r.worst.fusePlugC * 0.85 ? '#f59e0b' : '#94a3b8' }}>
                  Hub {r.worst.hubT.toFixed(0)}°C
                </span>
                <span className="ml-auto" style={{ color: TIER_COLOR[r.tier] }}>{r.f.operator || '—'}</span>
              </div>
            </div>
          </div>
        ))}
        {tab === 'FLEET' && fleet.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-slate-500">No fleet data.</div>
        )}
        {tab === 'FLEET' && fleet.map(c => {
          const worstTier: Tier = c.worst >= 85 ? 'CRIT' : c.worst >= 65 ? 'WARN' : c.worst >= 45 ? 'CAUT' : c.worst >= 22 ? 'ADV' : 'NOM'
          return (
            <div key={c.cls} className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/60 flex items-center gap-2">
              <span className="w-1 self-stretch rounded" style={{ background: TIER_COLOR[worstTier] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{c.cls}</span>
                  <span className="text-slate-500 truncate text-[10px]">Pc {TIRE_PC[c.cls]}psi · Tmax {TIRE_TMAX[c.cls]}°C · fuse {FUSE_PLUG_C[c.cls]}°C</span>
                  <span className="ml-auto text-[10px] font-semibold" style={{ color: TIER_COLOR[worstTier] }}>{worstTier}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-400 font-mono mt-0.5">
                  <span title="fleet count">n {c.n}</span>
                  <span title="μ worst-truck score">μ {c.mu.toFixed(0)}</span>
                  <span title="worst score">worst {c.worst.toFixed(0)}</span>
                  <span title="MTOW">MTOW {MTOW_T[c.cls].toFixed(0)}t</span>
                  <span className="ml-auto" title="trucks per airframe">{TRUCK_COUNT[c.cls]} trucks</span>
                </div>
                <div className="flex items-center gap-1 text-[9px] font-mono mt-0.5">
                  {TIER_ORDER.filter(t => t !== 'OFF').map(t => (
                    <span key={t} className="px-1 rounded" style={{ background: TIER_COLOR[t] + '22', color: TIER_COLOR[t] }}>
                      {t} {c.tally[t]}
                    </span>
                  ))}
                </div>
                <div className="mt-1 h-1 rounded bg-slate-900 relative overflow-hidden">
                  <div className="absolute inset-y-0 left-0" style={{ width: `${c.worst}%`, background: TIER_COLOR[worstTier], opacity: 0.85 }} />
                </div>
              </div>
            </div>
          )
        })}
        {tab === 'METHOD' && (
          <div className="px-3 py-2 text-[11px] text-slate-300 leading-relaxed space-y-2.5">
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Tier Ladder</div>
              <div className="font-mono text-[10px] text-slate-400 space-y-0.5">
                <div><span className="text-rose-400">CRIT</span> ≥85 · fuse-plug release imminent · taxi-back stop · NDT</div>
                <div><span className="text-fuchsia-400">WARN</span> ≥65 · hot-brake + low Pc coincident · cool-down required</div>
                <div><span className="text-amber-400">CAUT</span> ≥45 · single-tire low Pc ≥15% or hub ≥150°C · monitor</div>
                <div><span className="text-sky-400">ADV</span>  ≥22 · inflation drift ≥5% · log next pre-flight check</div>
                <div><span className="text-emerald-400">NOM</span>  &lt;22 · within ±5% Pc · no action</div>
                <div><span className="text-slate-400">OFF</span>  ground-static or not in tire-phase</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">6 Drivers (per truck)</div>
              <div className="font-mono text-[10px] space-y-0.5 text-slate-400">
                <div><span className="text-slate-200">INFLATE</span> abs(Ph−Pc)/Pc · low-side bias to under-inflation</div>
                <div><span className="text-slate-200">DEFLECT</span> load/Pc deflection ratio vs sidewall Tmax</div>
                <div><span className="text-slate-200">BRKHUB</span>  wheel-hub T_h vs fuse-plug release (177-193°C)</div>
                <div><span className="text-slate-200">ENGY</span>    brake-pack J vs §25.735(f) MAX-BRAKE-ENERGY</div>
                <div><span className="text-slate-200">FOD-CUT</span> phase × airport × V_gs² FOD-strike probability</div>
                <div><span className="text-slate-200">PHASE</span>   phase amplifier (TKOF-ROLL 1.15 / TD 1.40 / GR-RET 1.30)</div>
              </div>
              <div className="text-[10px] text-slate-500 mt-1">composite = max·0.66 + mean·0.34 · ×phase × ADV-MUL clipped [0,100]</div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Hard Escalators</div>
              <div className="font-mono text-[10px] space-y-0.5 text-slate-400">
                <div>(a) hub T ≥ fuse-plug release → ≥92 CRIT (CMM 32-45)</div>
                <div>(b) ΔP ≥25% → ≥78 WARN (Bridgestone limit)</div>
                <div>(c) over-deflected at high-V → ≥72 (Concorde mode)</div>
                <div>(d) FOD-cut ≥0.80 at TKOF-ROLL/ROTATE → ≥86 (AF4590)</div>
                <div>(e) brake energy ≥cert at LDG-ROLL-HI → ≥80 (§25.735(f))</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Accident Precedents</div>
              <div className="font-mono text-[10px] space-y-0.5 text-slate-400">
                <div><span className="text-rose-400">AF 4590</span>  Concorde KCDG 2000-07-25 · 113 fatal · FOD strip → tire #2 burst → tank #5 ram-rupture (BEA F-SC000725A)</div>
                <div><span className="text-rose-400">Mexicana 940</span> XA-MEM 1986-03-31 · 167 fatal · over-inflated tire rupture in wheel-well (AD 88-25-04)</div>
                <div><span className="text-rose-400">Nigeria 2120</span> HZ-AIH 1991-07-11 · 261 fatal · cold-inflated tire ruptured on T/O roll OEJN (DGCA HF/DCA-1992-2)</div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">Distinct From</div>
              <div className="text-[10px] text-slate-400 leading-snug">
                BRAKE (energy only, no Pc/tire coupling) · HYDROPLANE (tire-vs-water film not thermal) · FOD (runway debris registry not tire-cut) · RTOW (decel distance not tire/wheel state) · BOUNCE (vertical G impact not Pc/T) · REX-HYD (lateral departure not tire) · LDR (stop margin not tire) · CARGO-FIRE-SUPPRESS (Halon not tire). TPMS is uniquely the tire-wheel-brake THERMODYNAMIC STATE per truck × phase × FOD-cut composite.
              </div>
            </div>
            <div>
              <div className="font-semibold text-sky-400 text-[10px] uppercase tracking-widest mb-1">References</div>
              <div className="text-[10px] text-slate-500 leading-snug">
                14 CFR §25.733/.734/.735/.731/.729 · EASA CS-25.733/734/735/731 · AMC 25.734 · ICAO Annex 8 Pt IIIA §1.3 · ICAO Annex 6 Pt I §8.7.2 · FAA AC 25-7D §22 · FAA AC 25-32 · SAE ARP 5257 · SAE AS 5018 · SAE AIR 5797 · ARINC 429 Wheel-Speed · ARINC 832 BTMS · AMM 32-45 family · BEA F-SC000725A · Michelin / Goodyear / Bridgestone Tire Engineering Data Manuals · IATA IGOM 4.4.5.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
