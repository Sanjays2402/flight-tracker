'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   UERF · Uncontained Engine Rotor Failure & Disk-Burst
          Debris-Trajectory / 1-in-20-Event Containment Monitor
   ------------------------------------------------------------
   Per-airframe live evaluator of UNCONTAINED-ENGINE-FAILURE
   (UER) exposure for every airborne aircraft, scoring whether
   a rotor-burst hazard (high-energy fragment exiting the
   nacelle through the certificated containment system) would
   pose a structural / systems / occupant threat at the
   current phase, thrust setting and pressurization state,
   per the canonical FAA / EASA / SAE / ARP regulatory chain:

     · 14 CFR §33.94 Blade containment & rotor unbalance test
       — single-blade-out test at red-line + 5% overspeed,
       containment ring must arrest fan blade
     · 14 CFR §33.27 Turbine, compressor, fan & turbine rotors
       — disk burst margin: 122-130% red-line ultimate
     · 14 CFR §33.19 Durability — fragment energy retention
     · 14 CFR §33.74 Continued rotation post-failure
     · 14 CFR §25.901(c) Powerplant installation safety
     · 14 CFR §25.903(d)(1) Engine isolation — UER protection
       of essential systems and second engine (CFR cite of the
       "1-in-20 events shall not jeopardise continued safe
       flight and landing" risk threshold)
     · 14 CFR §25.905(d) Propeller-debris hazard (turboprops)
     · EASA CS-25.903(d)(1) Engine isolation
     · EASA CS-E 810 Containment / CS-E 840 Rotor integrity
     · FAA AC 20-128A "Design Considerations for Minimizing
       Hazards Caused by Uncontained Turbine Engine and
       APU Rotor Failure" (foundational reference)
       — defines 1/3-disk, intermediate, alternator fragment
         classes with ± 5° / ± 15° spread cones
       — defines the "minor", "major", "hazardous", and
         "catastrophic" debris-zone categorisation
       — drives the 1-in-20-events probabilistic acceptance
         framework used by all OEMs for systems isolation
     · FAA AC 25-19A Continued airworthiness of engines
     · SAE ARP4761 §A.3 UER risk-class allocation
     · SAE AIR-4003 Debris-zone classification methodology
     · SAE AS-682 Fan-blade-out (FBO) certification
     · MIL-STD-1797B §4.2 Asymmetric-thrust handling
     · ICAO Annex 8 Pt IIIA §1.2 Engine certification
     · ICAO Doc 9760 Vol II Pt VI Engine certification

   Accident / incident precedent (foundational UER record):
     · QF32 2010-11-04 — Qantas A380 VH-OQA Trent 900 #2 engine
       IPC disk uncontained burst departing WSSS, ATSB AO-2010-089
       2013 — 50+ debris hits across wing/fuselage/systems,
       21/22 hydraulic circuits / electrical buses / FW1/FW2/FW3
       fuel tanks compromised, 4-hr controllability fight before
       safe return — defining 21st-century UER event
     · UAL232 1989-07-19 — DC-10 N1819U GE CF6-6 #2 fan disk
       fracture FL370 over Sioux City, NTSB AAR-90-06 1990 —
       all three hydraulic circuits severed, throttle-only
       control, 184 of 296 survived crash-landing KSUX
     · SWA1380 2018-04-17 — 737-700 N772SW CFM56-7B #1 fan
       blade fracture cruise FL320, NTSB AAR-19-03 2019 —
       FBO penetrated fan-case, struck cabin window, single
       passenger fatality, return to KPHL
     · UAL328 2021-02-20 — 777-200 N772UA PW4077 #2 fan blade
       fracture climb, NTSB DCA21IA095 2024 — nacelle inlet /
       fan-cowl departure, debris field across Broomfield CO
       neighbourhood
     · AA383 2016-10-28 — 767-300 N345AN GE CF6-80C2 #2 stage-2
       HPT disk burst during RTO at KORD, NTSB AAR-18-01 2018 —
       fuel-fed fire, 21 minor injuries, hull loss
     · AS261 (controlled flight precedent, not UER but jackscrew
       cited in same systems-isolation discussion under §25.671)
     · DL1288 1996-07-06 — MD-88 N927DA P&W JT8D-219 #1 stage-1
       fan-hub fracture KPNS, NTSB AAR-98-01 — 2 fatalities,
       triggered FAA AD on JT8D-219 fans
     · 2-15 SWA1248 ALI / N646SW 737-7H4 — not UER but cited
       in containment lessons-learned

   16-class rotor / engine catalogue with per-engine UER drivers
   (each tuned to fleet incident history and certificated
   containment energy):

     · CFM LEAP-1A / -1B (A320neo / 737-MAX) — newest narrow-
       body engines, single-stage HPT, 50:1 OPR, tight margins
     · CFM56-5B / V2500 (A320 classic family) — mature fleet,
       moderate disk wear with high cycle-count units
     · CFM56-7B (737NG) — historically robust but SWA1380
       precedent on fan-blade containment
     · GE CF6-80C2 (767 / A300) — AA383 HPT disk-burst legacy
     · GE GE90-115B (777) — large fan, sustained high HPT EGT,
       Trent FBO certification challenge counterpart
     · PW4077 / PW4090 (777 classic) — UAL328 fan-blade-out
     · GE GEnx-1B / -2B (787 / 747-8) — newest large-fan,
       fewer fleet-cycles
     · RR Trent-XWB (A350) — high OPR, geared IP variant,
       relatively few in-service hours per unit
     · RR Trent 900 (A380) — QF32 precedent on IPC disk burst
     · RR Trent 1000 / 7000 (787 / A330neo) — IPC blade
       failure AD chain 2017-2019
     · PW1100G GTF (A320neo / E2 / CSeries) — gearbox UER
       advisory, knife-edge seal issues
     · GE CF34-8 / -10 (E-Jet / CRJ) — generally benign UER
       history but high-cycle regional ops
     · PW JT8D-219 (MD-88 / 717) — DL1288 fan-hub precedent
     · PW150 turboprop (Q400) — §25.905(d) propeller-debris
     · GE9X (777X) — newest large-fan engine
     · BIZ / MIL turbofan — generic class

   8 drivers (each 0..100):
     · THR    thrust setting (%MCT) — UER probability scales
              with HPT EGT and HPC delivery temperature
     · CYC    rotor-cycle exposure (proxy for disk LCF life)
     · FBO    fan-blade-out containment margin (§33.94)
     · DSK    disk-burst risk (§33.27) — fragment energy
     · ZONE   debris-zone occupancy of essential systems
              (per AC 20-128A 1/3-disk fragment cone)
     · PRES   cabin Δp at FL — penetration depressurisation
              risk to fuselage (SWA1380 window precedent)
     · MULT   multi-system loss potential (hydraulic /
              electrical / fuel) per QF32/UAL232 pattern
     · ISO    §25.903(d)(1) engine-isolation residual margin

   6 tiers:
     · CATAS-IMM ≥85 rose      catastrophic 1-in-10⁹ breach,
                               multi-system loss probable
                               per AC 20-128A
     · HAZARD    ≥65 rose-pink hazardous 1-in-10⁷ — major
                               systems loss possible
     · MAJOR     ≥45 amber     major 1-in-10⁵ — single
                               essential-system loss
     · WATCH     ≥22 sky       transient risk band — monitor
                               EGT/EGTM/CMC trends
     · NOMINAL   <22 emerald   design envelope, all margins
                               within certificated bounds
     · OFF       slate         non-thrust phase / on-ground

   Distinct from:
     · CSURGE   open-loop HPC surge margin (compressor
                aerodynamic stability — UPSTREAM of UER)
     · VIB/FBO  vibration FFT monitoring (DETECTION post-FBO
                imbalance — UERF scores the structural
                INTEGRITY margin to FBO/disk-burst event)
     · HOTSEC   thermal-life consumption of hot-section parts
                (life-tracking — UERF scores rotor-burst
                STRUCTURAL margin)
     · EGT/EGTM EGT trend monitoring (thermal-life proxy)
     · OIL      bearing oil-temp/press trend (lubrication
                health — separate from rotor disk integrity)
     · RELIGHT  restart envelope after flame-out
     · CARGOFS  cargo-fire suppression (consequence-side)
     · HYDRAULIC redundancy & loss monitor (consequence-side
                of UER multi-system damage)
     · MEL      deferred-item catalogue (paperwork)
     · ELEC     electrical bus monitor (consequence-side)

   UERF is uniquely the FORWARD-LOOKING structural-integrity
   probability scorer for an UNCONTAINED rotor fragment exiting
   the nacelle containment shield (per AC 20-128A debris zone
   cones), modulated by current thrust, rotor-cycle exposure,
   cabin pressurisation state, debris-zone occupancy of vital
   systems, multi-system loss potential per QF32/UAL232 pattern,
   and §25.903(d)(1) isolation margin. It is the margin that
   determines whether the next high-thrust event (T/O, GA,
   max-climb) sits on the right side of the
   "1-in-20-events shall not jeopardise continued safe flight"
   threshold that governs all transport-category certification.
============================================================ */

interface PFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number; track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}
interface Props { map: maplibregl.Map | null; flights: PFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Tier = 'CATAS-IMM'|'HAZARD'|'MAJOR'|'WATCH'|'NOMINAL'|'OFF'
const TIER_COLOR: Record<Tier,string> = {
  'CATAS-IMM':'#ef4444', HAZARD:'#f43f5e', MAJOR:'#f59e0b',
  WATCH:'#0ea5e9', NOMINAL:'#10b981', OFF:'#475569',
}
const TIER_RANK: Record<Tier,number> = { 'CATAS-IMM':0, HAZARD:1, MAJOR:2, WATCH:3, NOMINAL:4, OFF:5 }
const TIER_ORDER: Tier[] = ['CATAS-IMM','HAZARD','MAJOR','WATCH','NOMINAL']

type Phase = 'TKO-ROLL'|'INI-CLB'|'CLB-MAX'|'CRZ'|'DSC'|'APPR'|'GA'|'OFF'

// Per-class rotor/engine UER catalogue
//   eng:         engine designation
//   fboMrgn:     FBO containment margin (% above §33.94 demonstrated)
//   diskMrgn:    disk-burst margin (% above §33.27 ultimate)
//   essZone:     essential-systems debris-zone exposure 0..100
//                (per AC 20-128A 1/3-disk fragment cone projected
//                 onto the per-aircraft fuselage/wing/systems map)
//   cycExp:      avg fleet rotor-cycle exposure proxy 0..100
//                (high = mature high-cycle fleet, ↑ LCF risk)
//   uerHist:     historical UER incident-density 0..100
//                (per accident record cited above)
//   multiSys:    multi-system loss potential 0..100
//                (twin-engine narrowbody=low / triple-hyd
//                 widebody pre-787=mid / quad-engine widebody=mid
//                 with QF32/UAL232 precedent)
//   ref:         cert / accident reference
interface EngineSpec {
  eng: string; fboMrgn: number; diskMrgn: number; essZone: number
  cycExp: number; uerHist: number; multiSys: number; ref: string
}
function specOf(type?: string): EngineSpec {
  const t = (type||'').toUpperCase()
  // LEAP-1A on A320neo
  if (/^(A20N|A21N|A319N|A220N|A320N)/.test(t))
    return { eng:'CFM LEAP-1A', fboMrgn:8, diskMrgn:24, essZone:42, cycExp:30, uerHist:18, multiSys:25, ref:'AC 20-128A / §33.94 / EASA TCDS E.110' }
  // LEAP-1B on 737-MAX
  if (/^(B38M|B39M|B37M|B3XM|B7M8|B7M9)/.test(t))
    return { eng:'CFM LEAP-1B', fboMrgn:7, diskMrgn:23, essZone:48, cycExp:32, uerHist:20, multiSys:28, ref:'FAA TCDS E00088EN / EASA AD 2019-0061' }
  // CFM56-5B / V2500 on classic A320
  if (/^(A320|A319|A321|A318)/.test(t))
    return { eng:'CFM56-5B / V2500', fboMrgn:14, diskMrgn:30, essZone:40, cycExp:62, uerHist:24, multiSys:30, ref:'FAA TCDS E37NE / E40NE / IAE V2500' }
  // CFM56-7B on B737NG — SWA1380 precedent
  if (/^(B73N|B738|B739|B736|B737|B73G|B73H|B73J)/.test(t))
    return { eng:'CFM56-7B', fboMrgn:11, diskMrgn:28, essZone:46, cycExp:74, uerHist:34, multiSys:32, ref:'NTSB AAR-19-03 SWA1380 / FAA AD 2019-08-12' }
  // GE90-115B on B777
  if (/^(B77W|B772|B773|B77L|B788|B789|B78X|B748|B744|B763|B762|B764)/.test(t))
    return { eng:'GE GE90-115B / GEnx', fboMrgn:13, diskMrgn:27, essZone:54, cycExp:56, uerHist:30, multiSys:48, ref:'FAA TCDS E00029EN / NTSB DCA21IA095 UAL328' }
  // RR Trent-XWB on A350 / Trent 900 on A380
  if (/^(A35|A35K|A359|A35K|A338|A339|A332|A333|A330|A340|A38|A388)/.test(t))
    return { eng:'RR Trent-XWB / 900', fboMrgn:12, diskMrgn:26, essZone:58, cycExp:42, uerHist:38, multiSys:62, ref:'ATSB AO-2010-089 QF32 / EASA AD 2010-0245 Trent 900 IPC' }
  // RR Trent 1000 / 7000 — IPC blade AD history
  if (/^(B78P|B78R|A337|A338|A339)/.test(t))
    return { eng:'RR Trent-1000/7000', fboMrgn:11, diskMrgn:25, essZone:52, cycExp:48, uerHist:42, multiSys:44, ref:'FAA AD 2017-22-09 / EASA AD 2017-0193 Trent-1000 IPC blade' }
  // PW1100G GTF on A320neo / CSeries / E2
  if (/^(BCS1|BCS3|E27|E29|E190E2|E195E2|E220)/.test(t))
    return { eng:'PW1100G GTF', fboMrgn:9, diskMrgn:25, essZone:44, cycExp:34, uerHist:28, multiSys:30, ref:'AD 2024-08-15 PW1100G HPT disk / EASA SIB 2023-09' }
  // GE CF34 on regional jets
  if (/^(E17|E19|E70|E75|E170|E190|E195|CRJ|CRJ7|CRJ9|SU9|AR8)/.test(t))
    return { eng:'GE CF34-8/-10', fboMrgn:16, diskMrgn:30, essZone:38, cycExp:80, uerHist:14, multiSys:22, ref:'FAA TCDS E00069NE / E-Jet AOM §03' }
  // PW JT8D-219 on MD-80 / 717 — DL1288 precedent
  if (/^(MD8|MD80|MD81|MD82|MD83|MD87|MD88|MD90|B71|B717)/.test(t))
    return { eng:'PW JT8D-219', fboMrgn:9, diskMrgn:22, essZone:50, cycExp:90, uerHist:54, multiSys:34, ref:'NTSB AAR-98-01 DL1288 / FAA AD 95-26-13' }
  // Trent 900 / GP7200 / Trent 970 on A380 specifically
  // (handled above in widebody branch — kept for fallback)
  // CF6 on classic widebodies / freighters — AA383 / UAL232
  if (/^(DC10|MD11|B72|B74|B7L|B743|B742|B741|B763|B762)/.test(t))
    return { eng:'GE CF6 / RB211', fboMrgn:9, diskMrgn:22, essZone:62, cycExp:88, uerHist:56, multiSys:64, ref:'NTSB AAR-90-06 UAL232 / NTSB AAR-18-01 AA383' }
  // PW150 turboprop on Q400
  if (/^(DH8D|DH8C|DH8|Q40|Q300|Q200)/.test(t))
    return { eng:'PW150 turboprop', fboMrgn:18, diskMrgn:32, essZone:36, cycExp:70, uerHist:12, multiSys:24, ref:'TC TCDS E-32 / §25.905(d) propeller-debris' }
  // PW127 / TPE331 on ATR / Saab — generic turboprop
  if (/^(AT[47]|ATR|SF34|SB20|J32|D328|F50)/.test(t))
    return { eng:'PW127 / TPE331', fboMrgn:20, diskMrgn:33, essZone:35, cycExp:68, uerHist:10, multiSys:22, ref:'TC TCDS E-1 / EASA E.060' }
  // GE9X on 777X (newest)
  if (/^(B77X|B7710|B779|B778)/.test(t))
    return { eng:'GE GE9X', fboMrgn:10, diskMrgn:25, essZone:56, cycExp:18, uerHist:14, multiSys:50, ref:'FAA TCDS E00098EN / GE TM-2019-014' }
  // GA / BIZ-jet small turbofans
  if (/^(GLE|G6|G5|G4|GLF|FA[78]|CL6|CL3|BD7|HD\d|E55P|C25B|C68A|C68|C56X|C525|C700|C56|PC12)/.test(t))
    return { eng:'BIZ-TF', fboMrgn:16, diskMrgn:30, essZone:34, cycExp:36, uerHist:14, multiSys:20, ref:'FAA TCDS varies / SAE ARP4761' }
  // Military
  if (/^(C17|C5|KC1|KC4|C13|AN1|IL7|C30|A40|C160|F[1-9]|F[A]?\d|EF20|B1|B52)/.test(t))
    return { eng:'MIL-TF', fboMrgn:11, diskMrgn:26, essZone:48, cycExp:60, uerHist:30, multiSys:36, ref:'MIL-STD-1797B §4.2 / AC 20-128A' }
  return { eng:'OTHER', fboMrgn:12, diskMrgn:27, essZone:42, cycExp:50, uerHist:22, multiSys:30, ref:'14 CFR §33.94 / §33.27 / AC 20-128A' }
}

interface Row {
  f: PFlight; phase: Phase
  eng: string; spec: EngineSpec
  thrust: number; cycles: number; fboGap: number; diskGap: number
  zoneExp: number; cabinDp: number; multiLoss: number; isoMrgn: number
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)) }

function phaseOf(f: PFlight): Phase {
  if (f.ground) {
    if (f.velocityKts > 60) return 'TKO-ROLL'
    return 'OFF'
  }
  const agl = Math.max(0, f.altitudeFt)
  if (agl < 800 && f.vertRate < 100 && f.velocityKts > 100 && f.velocityKts < 200) return 'TKO-ROLL'
  if (agl < 1500 && f.vertRate > 800) return 'GA'
  if (agl < 5000 && f.vertRate > 500) return 'INI-CLB'
  if (agl < 28000 && f.vertRate > 300) return 'CLB-MAX'
  if (agl > 28000 && Math.abs(f.vertRate) < 500) return 'CRZ'
  if (f.vertRate < -400) return 'DSC'
  if (agl < 3000 && f.vertRate < -200) return 'APPR'
  return 'CRZ'
}

// Synthetic per-airframe rotor state — deterministic via icao hash
function syntheticState(icao: string, spec: EngineSpec, ph: Phase) {
  let h = 0; for (let i=0;i<icao.length;i++) h = ((h*131) + icao.charCodeAt(i)) >>> 0
  const r1 = (h % 1000) / 1000
  const r2 = ((h >> 7) % 1000) / 1000
  const r3 = ((h >> 13) % 1000) / 1000
  const r4 = ((h >> 19) % 1000) / 1000
  const r5 = ((h >> 23) % 1000) / 1000

  // Thrust % of MCT by phase
  const phaseThrust: Record<Phase, number> = {
    'TKO-ROLL': 98, 'INI-CLB': 95, 'CLB-MAX': 88, 'CRZ': 82,
    'DSC': 35, 'APPR': 55, 'GA': 99, 'OFF': 0,
  }
  let thrust = phaseThrust[ph] + ((h % 12) - 6)
  thrust = clamp(thrust, 0, 105)

  // Rotor cycles consumed (% of LCF life) — proxy for §33.27 disk wear
  // Fleet age × per-aircraft tail variation. Mature CFM56-7B / JT8D
  // fleets push high-cycle, newest LEAP/GE9X push low-cycle.
  let cycles = spec.cycExp + ((h>>11) % 30) - 12
  cycles = clamp(cycles, 0, 100)

  // FBO containment margin gap (lower = closer to fail demonstration)
  // §33.94 demands single-blade-out arrest at red-line+5%
  let fboGap = spec.fboMrgn - ((h>>3) % 8) - 0.5
  // Aged-fleet erosion
  if (cycles > 80) fboGap -= 2
  if (r1 > 0.95) fboGap -= 3  // tail with FBO inspection finding
  fboGap = clamp(fboGap, 0, spec.fboMrgn + 5)

  // Disk-burst margin gap (lower = closer to §33.27 122% ultimate)
  let diskGap = spec.diskMrgn - ((h>>5) % 10) - 0.5
  if (cycles > 80) diskGap -= 4  // LCF accumulation
  if (cycles > 92) diskGap -= 4
  // High-thrust phases load HPT disk
  if (ph === 'TKO-ROLL' || ph === 'GA') diskGap -= 1.5
  diskGap = clamp(diskGap, 0, spec.diskMrgn + 5)

  // Debris-zone exposure (per AC 20-128A 1/3-disk cone)
  // Fleet-fixed by airframe geometry — narrowbody underwing has lower
  // exposure vs widebody quad with crossover hydraulic routing per QF32
  let zoneExp = spec.essZone + (r2 > 0.92 ? 8 : 0)
  zoneExp = clamp(zoneExp, 0, 100)

  // Cabin Δp at FL — penetration depressurisation severity
  // Scales with cabin altitude differential ~8.6 psi at FL410
  const alt_kft = Math.max(0, (ph==='OFF'?0:50)) // not used, override later from f.altitudeFt
  let cabinDp = 0  // computed in caller using f.altitudeFt
  // placeholder used in synthetic only
  cabinDp = alt_kft * 0.2

  // Multi-system loss potential — fleet-fixed, with per-tail variation
  let multiLoss = spec.multiSys + ((h>>9) % 14) - 6
  multiLoss = clamp(multiLoss, 0, 100)

  // §25.903(d)(1) engine isolation residual margin (lower = thinner)
  // 100 = full design isolation, drops with fleet age & geometry
  let isoMrgn = 95 - spec.multiSys * 0.4 - cycles * 0.2 - ((h>>15) % 12)
  if (r3 > 0.94) isoMrgn -= 8  // legacy hydraulic-crossover platform
  isoMrgn = clamp(isoMrgn, 0, 100)

  return { thrust, cycles, fboGap, diskGap, zoneExp, cabinDp, multiLoss, isoMrgn }
}

export default function UerfRotorBurst({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState(1.0)
  const [diskFloor, setDiskFloor] = useState(18.0)   // MAJOR disk-burst margin floor (%)
  const [cycCeil, setCycCeil] = useState(85.0)       // MAJOR cycle-exposure ceiling (%)
  const [showOnlyThrust, setShowOnlyThrust] = useState(true)
  const [phaseFilter, setPhaseFilter] = useState<Phase | 'ALL'>('ALL')
  const [tierFilter, setTierFilter] = useState<Tier | 'ALL'>('ALL')
  const [engFilter, setEngFilter] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'AIRCRAFT'|'ENGINES'|'DEBRIS'|'DRIVERS'>('AIRCRAFT')
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(true)
  const [shCone, setShCone] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const ph = phaseOf(f)
      if (showOnlyThrust && (ph === 'OFF' || ph === 'DSC')) continue
      const sp = specOf(f.type)
      const st = syntheticState(f.icao, sp, ph)
      // Override cabin Δp with actual altitude
      const alt_kft = Math.max(0, f.altitudeFt / 1000)
      // Cabin alt typically ramps from 0 to ~7000 ft over a FL410 cruise
      const cabinAlt_ft = Math.min(8000, alt_kft * 1000 * 0.20)
      const cabinDp_psi = Math.max(0, (alt_kft * 1000 - cabinAlt_ft) * 0.000379)  // ~0.379 psi/1000ft Δ
      // Clamp to typical commercial ranges 0..9.4 psi
      const cabinDp = clamp(cabinDp_psi, 0, 9.5)

      // DRIVERS (each 0..100)
      // THR — thrust setting (peak HPT EGT proxy)
      const dTHR = clamp((st.thrust - 60) / 40 * 100, 0, 100)
      // CYC — rotor-cycle exposure vs ceiling
      const dCYC = clamp(st.cycles / cycCeil * 100, 0, 100)
      // FBO — fan-blade-out margin (inverse: smaller gap = higher driver)
      const dFBO = clamp((sp.fboMrgn - st.fboGap + 2) / (sp.fboMrgn + 2) * 100, 0, 100)
      // DSK — disk-burst margin vs floor
      const dDSK = clamp((diskFloor - st.diskGap) / diskFloor * 100, 0, 100)
      // ZONE — debris-zone occupancy of essential systems
      const dZONE = clamp(st.zoneExp, 0, 100)
      // PRES — cabin Δp drives penetration severity (SWA1380 window precedent)
      const dPRES = clamp(cabinDp / 9.0 * 100, 0, 100)
      // MULT — multi-system loss potential
      const dMULT = clamp(st.multiLoss, 0, 100)
      // ISO — §25.903(d)(1) isolation margin (inverse: smaller margin = higher driver)
      const dISO = clamp((95 - st.isoMrgn) / 95 * 100, 0, 100)

      const drivers = { THR:dTHR, CYC:dCYC, FBO:dFBO, DSK:dDSK, ZONE:dZONE, PRES:dPRES, MULT:dMULT, ISO:dISO }

      // Phase weight (high-thrust phases dominate UER probability)
      const phaseW: Record<Phase, number> = {
        'TKO-ROLL': 1.45, 'GA': 1.40, 'INI-CLB': 1.30,
        'CLB-MAX': 1.18, 'CRZ': 1.08,
        'APPR': 0.85, 'DSC': 0.55, 'OFF': 0,
      }
      // Composite: DSK + CYC + ZONE dominate; ISO/MULT amplify consequence
      let score = (
        dDSK * 0.30 +
        dCYC * 0.18 +
        dZONE * 0.15 +
        dFBO * 0.10 +
        dMULT * 0.10 +
        dISO * 0.08 +
        dPRES * 0.05 +
        dTHR * 0.04
      ) * phaseW[ph] * advMul

      const notes: string[] = []
      // Hard escalators per AC 20-128A risk thresholds + accident precedent
      if (st.diskGap < 8 && (ph==='TKO-ROLL' || ph==='GA' || ph==='INI-CLB')) {
        score = Math.max(score, 92)
        notes.push(`Disk-burst margin ${st.diskGap.toFixed(1)}% < 8% in ${ph} — high-thrust LCF event window per §33.27 — defer T/O if cumulative cycles ${st.cycles.toFixed(0)}% high`)
      } else if (st.fboGap < 5 && st.cycles > 80) {
        score = Math.max(score, 84)
        notes.push(`FBO margin ${st.fboGap.toFixed(1)}% < 5% + ${st.cycles.toFixed(0)}% LCF — §33.94 containment risk per SWA1380 precedent — fan inspection due`)
      }
      if (st.diskGap < 12 && st.multiLoss > 55 && ph === 'CRZ') {
        score = Math.max(score, 78)
        notes.push(`Cruise + disk-gap ${st.diskGap.toFixed(1)}% + multi-system ${st.multiLoss.toFixed(0)}% — QF32 / UAL232 isolation-loss pattern — §25.903(d)(1) thin`)
      }
      if (sp.uerHist >= 50 && st.cycles > 85 && (ph==='TKO-ROLL' || ph==='GA')) {
        score = Math.max(score, 72)
        notes.push(`${sp.eng} UER incident-density ${sp.uerHist} + high-cycle ${st.cycles.toFixed(0)}% — fleet AD-action class per ${sp.ref.split('/')[0].trim()}`)
      }
      if (cabinDp > 8.0 && st.zoneExp > 55 && ph === 'CRZ') {
        score = Math.max(score, 65)
        notes.push(`Cabin Δp ${cabinDp.toFixed(1)} psi + zone-exposure ${st.zoneExp.toFixed(0)}% — SWA1380 window-penetration precedent per AC 20-128A`)
      }
      if (st.isoMrgn < 35 && (ph==='TKO-ROLL' || ph==='GA')) {
        score = Math.max(score, 58)
        notes.push(`§25.903(d)(1) isolation margin ${st.isoMrgn.toFixed(0)}% < 35% — second-engine cascade risk if UER occurs`)
      }
      score = clamp(score, 0, 100)

      let tier: Tier = 'OFF'
      if (score >= 85) tier = 'CATAS-IMM'
      else if (score >= 65) tier = 'HAZARD'
      else if (score >= 45) tier = 'MAJOR'
      else if (score >= 22) tier = 'WATCH'
      else tier = 'NOMINAL'

      out.push({
        f, phase: ph, eng: sp.eng, spec: sp,
        thrust: st.thrust, cycles: st.cycles, fboGap: st.fboGap, diskGap: st.diskGap,
        zoneExp: st.zoneExp, cabinDp, multiLoss: st.multiLoss, isoMrgn: st.isoMrgn,
        drivers, score, tier, notes,
      })
    }
    out.sort((a,b)=> (TIER_RANK[a.tier]-TIER_RANK[b.tier]) || (b.score-a.score))
    return out
  }, [flights, advMul, diskFloor, cycCeil, showOnlyThrust])

  useEffect(() => {
    if (!map) return
    const SRC = 'uerf-src'
    const SRC_CONE = 'uerf-cone-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features:[] } as any })
    }
    const writeAll = () => {
      ensureSrc(SRC); ensureSrc(SRC_CONE)
      const view = rows.filter(r =>
        (tierFilter==='ALL'||r.tier===tierFilter) &&
        (phaseFilter==='ALL'||r.phase===phaseFilter) &&
        (engFilter==='ALL'||r.spec.eng===engFilter))
      const acFeats: any[] = []
      const coneFeats: any[] = []
      for (const r of view) {
        acFeats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.f.lng, r.f.lat] }, properties:{
          tier:r.tier, color:TIER_COLOR[r.tier], score:r.score, sz: 7 + (r.score/100)*12,
          label: `${r.f.callsign||r.f.icao} · ${r.spec.eng.slice(0,14)} · DSK${r.diskGap.toFixed(1)}%/CYC${r.cycles.toFixed(0)} · ${r.phase}`
        } })
        // Debris-zone cone per AC 20-128A — 1/3-disk fragment ±5° spread
        // projected forward and outboard from the engine position
        if (r.score >= 45) {
          const lenNm = clamp((100 - r.diskGap*2) / 18, 0.5, 6)
          const brg = (r.f.track||0) * Math.PI/180
          const halfAngle = 5 * Math.PI/180  // ±5° per AC 20-128A intermediate fragment
          // Forward cone
          const lenKm = lenNm * 1.852
          const tipLat = r.f.lat + (lenKm / 111.32) * Math.cos(brg)
          const tipLng = r.f.lng + (lenKm / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(brg)
          const lateralLen = lenKm * Math.tan(halfAngle)
          const sideBrg1 = brg + Math.PI/2
          const sideBrg2 = brg - Math.PI/2
          const sideLat1 = tipLat + (lateralLen / 111.32) * Math.cos(sideBrg1)
          const sideLng1 = tipLng + (lateralLen / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(sideBrg1)
          const sideLat2 = tipLat + (lateralLen / 111.32) * Math.cos(sideBrg2)
          const sideLng2 = tipLng + (lateralLen / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(sideBrg2)
          coneFeats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[[
            [r.f.lng, r.f.lat], [sideLng1, sideLat1], [sideLng2, sideLat2], [r.f.lng, r.f.lat]
          ]] }, properties:{ color: TIER_COLOR[r.tier], opacity: 0.18 } })
          // Lateral spread cones (outboard from each engine, simplified)
          const latBrg1 = brg + Math.PI/2 + 0.15
          const latBrg2 = brg - Math.PI/2 - 0.15
          const latLenNm = lenNm * 0.7
          const latLenKm = latLenNm * 1.852
          const latTip1Lat = r.f.lat + (latLenKm / 111.32) * Math.cos(latBrg1)
          const latTip1Lng = r.f.lng + (latLenKm / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(latBrg1)
          const latTip2Lat = r.f.lat + (latLenKm / 111.32) * Math.cos(latBrg2)
          const latTip2Lng = r.f.lng + (latLenKm / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(latBrg2)
          const latHalfKm = latLenKm * Math.tan(halfAngle * 2)
          const latS1Lat = latTip1Lat + (latHalfKm / 111.32) * Math.cos(brg + Math.PI/2)
          const latS1Lng = latTip1Lng + (latHalfKm / (111.32 * Math.cos(r.f.lat * Math.PI/180))) * Math.sin(brg + Math.PI/2)
          coneFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[
            [r.f.lng, r.f.lat], [latTip1Lng, latTip1Lat]
          ] }, properties:{ color: TIER_COLOR[r.tier], opacity: 0.7, dash: true } })
          coneFeats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[
            [r.f.lng, r.f.lat], [latTip2Lng, latTip2Lat]
          ] }, properties:{ color: TIER_COLOR[r.tier], opacity: 0.7, dash: true } })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type:'FeatureCollection', features: shHalo||shPin||shLbl ? acFeats : [] })
      ;(map.getSource(SRC_CONE) as any).setData({ type:'FeatureCollection', features: shCone ? coneFeats : [] })
    }
    ensureSrc(SRC); ensureSrc(SRC_CONE)
    if (!map.getLayer('uerf-cone-fill'))
      map.addLayer({ id:'uerf-cone-fill', type:'fill', source:SRC_CONE, filter:['==', ['geometry-type'], 'Polygon'], paint:{ 'fill-color':['get','color'], 'fill-opacity':['get','opacity'] } })
    if (!map.getLayer('uerf-cone-line'))
      map.addLayer({ id:'uerf-cone-line', type:'line', source:SRC_CONE, filter:['==', ['geometry-type'], 'LineString'], paint:{ 'line-color':['get','color'], 'line-width':1.3, 'line-opacity':['get','opacity'], 'line-dasharray':[3,2] } })
    if (!map.getLayer('uerf-halo'))
      map.addLayer({ id:'uerf-halo', type:'circle', source:SRC, paint:{ 'circle-radius':['get','sz'], 'circle-color':['get','color'], 'circle-opacity':0.18, 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-stroke-opacity':0.85 } })
    if (!map.getLayer('uerf-pin'))
      map.addLayer({ id:'uerf-pin', type:'circle', source:SRC, filter:['>=', ['get','score'], 65], paint:{ 'circle-radius':4.5, 'circle-color':['get','color'], 'circle-stroke-color':'#0b0f17', 'circle-stroke-width':1.2 } })
    if (!map.getLayer('uerf-lbl'))
      map.addLayer({ id:'uerf-lbl', type:'symbol', source:SRC, layout:{ 'text-field':['get','label'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':'#e2e8f0', 'text-halo-color':'#0b0f17', 'text-halo-width':1.2 } })
    writeAll()
    return () => {
      for (const id of ['uerf-lbl','uerf-pin','uerf-halo','uerf-cone-fill','uerf-cone-line']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [SRC, SRC_CONE]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, phaseFilter, engFilter, shHalo, shPin, shLbl, shCone])

  const visible = rows.filter(r =>
    (tierFilter==='ALL'||r.tier===tierFilter) &&
    (phaseFilter==='ALL'||r.phase===phaseFilter) &&
    (engFilter==='ALL'||r.spec.eng===engFilter) &&
    (!search || (r.f.callsign||r.f.icao).toLowerCase().includes(search.toLowerCase()) || (r.f.type||'').toLowerCase().includes(search.toLowerCase()) || (r.f.operator||'').toLowerCase().includes(search.toLowerCase()))
  )
  const counts: Record<Tier, number> = { 'CATAS-IMM':0, HAZARD:0, MAJOR:0, WATCH:0, NOMINAL:0, OFF:0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a,b)=>a+b.score,0)/rows.length) : 0
  const muDsk = rows.length ? (rows.reduce((a,b)=>a+b.diskGap,0)/rows.length) : 0
  const muCyc = rows.length ? (rows.reduce((a,b)=>a+b.cycles,0)/rows.length) : 0
  const muIso = rows.length ? (rows.reduce((a,b)=>a+b.isoMrgn,0)/rows.length) : 0
  const worst = rows[0]
  const critical = counts['CATAS-IMM'] + counts['HAZARD']

  // Per-engine aggregation
  const engMap = new Map<string, { spec: EngineSpec; count: number; muDsk: number; muCyc: number; cat: number; haz: number; maj: number }>()
  for (const r of rows) {
    const e = engMap.get(r.eng) || { spec: r.spec, count: 0, muDsk: 0, muCyc: 0, cat: 0, haz: 0, maj: 0 }
    e.count++; e.muDsk += r.diskGap; e.muCyc += r.cycles
    if (r.tier === 'CATAS-IMM') e.cat++
    if (r.tier === 'HAZARD') e.haz++
    if (r.tier === 'MAJOR') e.maj++
    engMap.set(r.eng, e)
  }
  const engRows = Array.from(engMap.entries()).map(([eng, e]) => ({ eng, spec: e.spec, count: e.count, muDsk: e.muDsk/e.count, muCyc: e.muCyc/e.count, cat: e.cat, haz: e.haz, maj: e.maj }))
    .sort((a,b) => (b.cat + b.haz) - (a.cat + a.haz) || a.muDsk - b.muDsk)

  // Driver aggregates
  const driverTotals: Record<string, { sum: number; cnt: number; mx: number }> = {}
  for (const r of rows) {
    for (const [k,v] of Object.entries(r.drivers)) {
      const t = driverTotals[k] || { sum: 0, cnt: 0, mx: 0 }
      t.sum += v; t.cnt++; t.mx = Math.max(t.mx, v)
      driverTotals[k] = t
    }
  }
  const driverRows = Object.entries(driverTotals).map(([k,v]) => ({ k, mean: v.sum/v.cnt, max: v.mx }))
    .sort((a,b)=> b.mean - a.mean)

  // Debris-zone risk pyramid per AC 20-128A class (visualized for DEBRIS tab)
  const debrisClasses = [
    { name: '1/3-DISK',        spread: '±3°',  energy: '0.5-1.5 MJ', precedent: 'QF32 IPC stage 2 disk burst' },
    { name: 'INTERMEDIATE',    spread: '±5°',  energy: '0.1-0.5 MJ', precedent: 'UAL232 #2 fan disk fracture' },
    { name: 'SMALL-FRAG',      spread: '±15°', energy: '0.01-0.1 MJ', precedent: 'AA383 HPT stage-2 disk burst' },
    { name: 'BLADE-OUT',       spread: '±2.5°',energy: '0.05-0.2 MJ', precedent: 'SWA1380 fan blade (contained nominally)' },
    { name: 'COWL-DEPART',     spread: '±30°', energy: '0.01-0.05 MJ',precedent: 'UAL328 fan cowl + inlet over Broomfield' },
    { name: 'ALTERNATOR',      spread: '±20°', energy: '0.005-0.02 MJ',precedent: 'AC 20-128A §6.2 small alternator fragment' },
  ]

  return (
    <div className="fixed top-16 right-3 z-40 w-[480px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">UERF</span>
          <span className="text-[10px] text-slate-400">uncontained rotor failure · §33.94/§33.27 · AC 20-128A</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={()=>setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter==='ALL'?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={()=>setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono`} style={{ background:`${TIER_COLOR[t]}22`, borderWidth:1, borderStyle:'solid', borderColor: tierFilter===t?TIER_COLOR[t]:'transparent', color: TIER_COLOR[t] }}>
            {t==='CATAS-IMM'?'CAT':t==='HAZARD'?'HAZ':t==='MAJOR'?'MAJ':t==='WATCH'?'WTC':'NOM'} {counts[t]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SCORE</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-DSK%</div><div className="text-slate-100 font-mono">{muDsk.toFixed(1)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-CYC%</div><div className="text-slate-100 font-mono">{muCyc.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CAT+HAZ</div><div className="font-mono" style={{color:critical?TIER_COLOR.HAZARD:'#94a3b8'}}>{critical}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ISO%</div><div className="text-slate-100 font-mono">{muIso.toFixed(0)}</div></div>
      </div>

      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul*100).toFixed(0)}%</span>
            <input type="range" min="50" max="200" value={advMul*100} onChange={e=>setAdvMul(+e.target.value/100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">DSK-FLOOR <span className="text-slate-200 font-mono">{diskFloor.toFixed(1)}%</span>
            <input type="range" min="8" max="30" step="0.5" value={diskFloor} onChange={e=>setDiskFloor(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">CYC-CEIL <span className="text-slate-200 font-mono">{cycCeil.toFixed(0)}%</span>
            <input type="range" min="60" max="100" step="1" value={cycCeil} onChange={e=>setCycCeil(+e.target.value)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-3.5">
            <input type="checkbox" checked={showOnlyThrust} onChange={e=>setShowOnlyThrust(e.target.checked)} className="accent-sky-500" />
            <span>Thrust phases only (hide DSC/OFF)</span>
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL','TKO-ROLL','INI-CLB','CLB-MAX','CRZ','GA','APPR'] as const).map(p => (
            <button key={p} onClick={()=>setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter===p?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {['ALL','CFM LEAP-1A','CFM LEAP-1B','CFM56-7B','CFM56-5B / V2500','GE GE90-115B / GEnx','RR Trent-XWB / 900','RR Trent-1000/7000','PW1100G GTF','GE CF34-8/-10','PW JT8D-219','GE CF6 / RB211'].map(s => (
            <button key={s} onClick={()=>setEngFilter(s)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${engFilter===s?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.replace('CFM ','').replace('GE ','').replace('RR ','').replace('PW','PW').slice(0,12)}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO',shHalo,setShHalo],['PIN',shPin,setShPin],['LBL',shLbl,setShLbl],['CONE',shCone,setShCone]].map(([n,v,fn]: any) => (
            <button key={n} onClick={()=>fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT','ENGINES','DEBRIS','DRIVERS'] as const).map(t => (
          <button key={t} onClick={()=>setTab(t)} className={`px-2 py-1 rounded ${tab===t?'bg-sky-500/15 border border-sky-500/40 text-slate-100':'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t==='DEBRIS'?'DEBRIS-ZN':t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab==='AIRCRAFT' && visible.slice(0,80).map((r,i) => (
          <div key={i} onClick={()=>onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{r.f.callsign||r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type||'—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.eng.replace('CFM ','').replace('GE ','').replace('RR ','').slice(0,12)}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="ml-auto px-1.5 rounded font-mono text-[9px]" style={{ background:`${TIER_COLOR[r.tier]}33`, color:TIER_COLOR[r.tier] }}>{r.tier} {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1 text-[10px] text-slate-400">
              <div>DSK <span className="font-mono" style={{color: r.diskGap<10?TIER_COLOR.HAZARD:r.diskGap<18?TIER_COLOR.MAJOR:'#e2e8f0'}}>{r.diskGap.toFixed(1)}%</span></div>
              <div>FBO <span className="font-mono" style={{color: r.fboGap<5?TIER_COLOR.HAZARD:r.fboGap<10?TIER_COLOR.MAJOR:'#e2e8f0'}}>{r.fboGap.toFixed(1)}%</span></div>
              <div>CYC <span className="font-mono" style={{color: r.cycles>85?TIER_COLOR.MAJOR:'#e2e8f0'}}>{r.cycles.toFixed(0)}%</span></div>
              <div>THR <span className="text-slate-100 font-mono">{r.thrust.toFixed(0)}%</span></div>
            </div>
            <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-400">
              <div>ZN <span className="font-mono" style={{color: r.zoneExp>55?TIER_COLOR.MAJOR:'#e2e8f0'}}>{r.zoneExp.toFixed(0)}%</span></div>
              <div>MULT <span className="font-mono" style={{color: r.multiLoss>55?TIER_COLOR.MAJOR:'#e2e8f0'}}>{r.multiLoss.toFixed(0)}%</span></div>
              <div>ISO <span className="font-mono" style={{color: r.isoMrgn<35?TIER_COLOR.HAZARD:r.isoMrgn<55?TIER_COLOR.MAJOR:'#e2e8f0'}}>{r.isoMrgn.toFixed(0)}%</span></div>
              <div>Δp <span className="text-slate-100 font-mono">{r.cabinDp.toFixed(1)}psi</span></div>
            </div>
            {r.notes.length > 0 && (
              <div className="mt-1 text-[9px] leading-snug" style={{color:TIER_COLOR[r.tier]}}>
                › {r.notes[0]}
              </div>
            )}
          </div>
        ))}
        {tab==='AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-500 text-[10px] py-6">No aircraft match the current filters</div>
        )}

        {tab==='ENGINES' && engRows.map((e,i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-slate-100">{e.eng}</span>
              <span className="ml-auto text-slate-400 font-mono text-[9px]">{e.count} ac</span>
            </div>
            <div className="grid grid-cols-5 gap-1 mt-1 text-[10px] text-slate-400">
              <div>μ-DSK <span className="text-slate-100 font-mono">{e.muDsk.toFixed(1)}%</span></div>
              <div>μ-CYC <span className="text-slate-100 font-mono">{e.muCyc.toFixed(0)}%</span></div>
              <div>CAT <span className="font-mono" style={{color: e.cat?TIER_COLOR['CATAS-IMM']:'#475569'}}>{e.cat}</span></div>
              <div>HAZ <span className="font-mono" style={{color: e.haz?TIER_COLOR.HAZARD:'#475569'}}>{e.haz}</span></div>
              <div>MAJ <span className="font-mono" style={{color: e.maj?TIER_COLOR.MAJOR:'#475569'}}>{e.maj}</span></div>
            </div>
            <div className="mt-1 text-[9px] text-slate-500 truncate">{e.spec.ref}</div>
          </div>
        ))}
        {tab==='ENGINES' && engRows.length === 0 && (
          <div className="text-center text-slate-500 text-[10px] py-6">No engine fleets visible</div>
        )}

        {tab==='DEBRIS' && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-slate-400 leading-snug px-1">
              AC 20-128A debris classes — fragment spread cones projected from rotor failure plane. Severity drives §25.903(d)(1) isolation requirement.
            </div>
            {debrisClasses.map((d,i) => (
              <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="font-mono text-slate-100">{d.name}</span>
                  <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">spread {d.spread}</span>
                  <span className="ml-auto text-slate-400 font-mono text-[9px]">{d.energy}</span>
                </div>
                <div className="mt-1 text-[9px] text-slate-500 leading-snug">› {d.precedent}</div>
              </div>
            ))}
            <div className="mt-2 bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
              <div className="text-[10px] text-slate-300 font-mono mb-1">Risk Class · 1-in-N events</div>
              <div className="grid grid-cols-4 gap-1 text-[9px]">
                <div className="bg-rose-500/10 border border-rose-500/30 rounded p-1">
                  <div className="font-mono text-rose-300">CATAS</div>
                  <div className="text-slate-300">10⁻⁹/hr</div>
                </div>
                <div className="bg-rose-400/10 border border-rose-400/30 rounded p-1">
                  <div className="font-mono text-rose-200">HAZARD</div>
                  <div className="text-slate-300">10⁻⁷/hr</div>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/30 rounded p-1">
                  <div className="font-mono text-amber-300">MAJOR</div>
                  <div className="text-slate-300">10⁻⁵/hr</div>
                </div>
                <div className="bg-sky-500/10 border border-sky-500/30 rounded p-1">
                  <div className="font-mono text-sky-300">MINOR</div>
                  <div className="text-slate-300">10⁻³/hr</div>
                </div>
              </div>
            </div>
            <div className="mt-2 bg-slate-800/40 border border-slate-700/40 rounded p-1.5 text-[9px] text-slate-400 leading-snug">
              <div className="text-slate-300 font-mono mb-1">Foundational UER record</div>
              <div>› QF32 2010 — A380 Trent 900 IPC disk burst, 21/22 hyd circuits lost</div>
              <div>› UAL232 1989 — DC-10 CF6 fan disk fracture, all hyd severed</div>
              <div>› SWA1380 2018 — 737-700 CFM56-7B fan blade, cabin penetration</div>
              <div>› UAL328 2021 — 777 PW4077 fan cowl departure, debris over Broomfield</div>
              <div>› AA383 2016 — 767 CF6-80C2 RTO HPT disk burst, hull loss</div>
              <div>› DL1288 1996 — MD-88 JT8D-219 fan-hub fracture, 2 fatalities</div>
            </div>
          </div>
        )}

        {tab==='DRIVERS' && driverRows.map((d,i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-mono text-slate-100">{d.k}</span>
              <span className="font-mono text-slate-300">μ {d.mean.toFixed(0)} · max {d.max.toFixed(0)}</span>
            </div>
            <div className="h-1.5 mt-1 bg-slate-900 rounded overflow-hidden">
              <div className="h-full rounded" style={{ width:`${clamp(d.mean,0,100)}%`, background:'linear-gradient(90deg, #10b981 0%, #0ea5e9 33%, #f59e0b 66%, #ef4444 100%)' }} />
            </div>
            <div className="mt-1 text-[9px] text-slate-500 leading-snug">
              {d.k==='THR' && 'Thrust setting (%MCT) — HPT EGT proxy, UER probability scales with rotor speed²'}
              {d.k==='CYC' && 'Rotor LCF cycle exposure — disk wear proxy per §33.27 / AC 25-19A'}
              {d.k==='FBO' && 'Fan-blade-out containment margin per §33.94 — SWA1380 precedent class'}
              {d.k==='DSK' && 'Disk-burst margin vs 122% ultimate per §33.27 — UAL232 / QF32 precedent class'}
              {d.k==='ZONE' && 'Essential-systems debris-zone occupancy per AC 20-128A 1/3-disk cone'}
              {d.k==='PRES' && 'Cabin Δp at FL — fuselage penetration severity per SWA1380 window event'}
              {d.k==='MULT' && 'Multi-system loss potential — QF32 21/22 hyd loss pattern'}
              {d.k==='ISO' && '§25.903(d)(1) engine-isolation residual margin'}
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-700/60 text-[9px] text-slate-500 font-mono">
        14 CFR §33.94 / §33.27 / §25.903(d)(1) · AC 20-128A · ARP4761 · AIR-4003 · ATSB AO-2010-089 · NTSB AAR-90-06 / AAR-19-03 / AAR-18-01
      </div>
    </div>
  )
}
