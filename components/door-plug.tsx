'use client'
import React, { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   DOORPLUG · Cabin Door-Plug / Pax-Door / Cargo-Door Latch
   Integrity & Plug-Blowout / Explosive-Decompression Risk
   ------------------------------------------------------------
   Per-airframe live evaluator of the certified PRESSURE-VESSEL
   APERTURE INTEGRITY subsystem — the latched, bolted, gasket-
   sealed plug-doors, hinged pax-doors, semi-plug cargo-doors,
   over-wing exits, and aft-bulkhead-mounted aft-pressure-dome
   apertures whose latch / lock / sensor / bolt / hinge chain
   resists the cabin-to-ambient differential pressure ΔP, scored
   per-aircraft across cruise / climb / descent against accident
   precedent and the §25.783 / §25.807 / §25.812 / §25.365 /
   §25.571 regulatory family that govern door / plug / fuselage-
   skin pressure-cabin-aperture integrity.

   Distinct from:
     · CABIN-PRESS (ΔP / outflow-valve schedule, not aperture)
     · TUC / HYPOXIA  (physiological consequence, not source)
     · EDR / EMERG-DESC (the descent response, not the failure)
     · OXYGEN (mask deployment downstream of decompression)
     · ASIP (airframe fatigue, structural envelope-life cycles)
     · ROW-ROP / EMAS (rollout-side events, ground-side)

   Canonical accident precedent (the regulatory drivers):
     · Alaska 1282 (B737-9 MAX N704AL, KPDX-KONT 2024-01-05):
       LEFT-MID DOOR-PLUG departed at FL160 / 16,300ft climb-
       out from KPDX. Plug had four locating bolts MISSING
       (omitted at Boeing Renton during Spirit-built fuselage
       rework). NTSB DCA24MA063 / EAD 2024-02-51. Drove FAA
       AD 2024-02-51 (immediate inspection) + multi-operator
       grounding of B737-9 MAX with door-plug (151 fleet, 9
       days). Manufacturer SB 737-25A-1955.
     · Aloha 243 (B737-200 N73711, Hawaii 1988-04-28): ~5.5m
       of upper fuselage skin separated in flight at FL240
       due to cold-bond debond + WFD (Widespread Fatigue
       Damage). 1 fatal (flight attendant ejected). Drove
       NTSB AAR-89-03 + FAA Aging Aircraft Program / AC 91-
       56B / §25.571 WFD revision / SSID Supplemental
       Structural Inspection Documents.
     · Turkish 981 (DC-10-10 TC-JAV, Ermenonville 1974-03-03,
       346 fatal — deadliest single-aircraft crash at the
       time): aft cargo-door blew off at FL120 after climb
       from Paris-Orly. Latch-locking mechanism design defect
       (vent-door latch failed to confirm full lock). McDonnell
       Douglas AAWS-recalled cargo-door redesign — NTSB AAR-
       74-08, French BEA F-WL-AW report. Direct precedent
       for §25.783 plug-door + latch-positive-confirmation
       requirement amendment 25-54.
     · UAL 811 (B747-122 N4713U, Honolulu 1989-02-24, 9 fatal):
       FORWARD CARGO DOOR opened at FL222 over Pacific after
       latch-cam-sector linkage failure. 9 pax in business
       class ejected. NTSB AAR-90-01 + AAR-92-02 reissue.
       Drove FAA AD 88-12-04 + AD 90-09-06 + Boeing SB 53A-
       2391 cargo-door cam-lock redesign on all 747-100/200/
       300/SP/SR.
     · BA 5390 (BAC 1-11 G-BJRT, Didcot UK 1990-06-10): LH
       cockpit windshield panel departed at FL173 during
       climb due to maintenance bolts undersized by 0.66mm
       (mis-replaced by maintenance using bolt-bin similar-
       size but wrong-grip-length items). Captain partially
       sucked out, restrained by F/O + cabin crew, recovered
       at Southampton. AAIB Bull 1/92. Maintenance-error
       door-shaped-aperture precedent.
     · NWA 85 (B747-400 1991): Lower forward CARGO DOOR
       partial opening at cruise — recovered, no separation.
     · Continental 1404 / EAS Cargo / many partial events
       documented in FAA SDR + EASA OCC.
     · TWA 800 (B747-131 N93119, off Long Island 1996-07-17,
       230 fatal): centre-fuel-tank explosion — not a door
       event but drove §25.981 FRM Fuel-Tank Flammability
       Reduction Rule which interacts with skin/door temp.
     · JAL 123 (B747SR JA8119, Mt Osutaka 1985-08-12, 520
       fatal): AFT-PRESSURE-DOME (aft-pressure-bulkhead)
       fatigue failure from improper splice plate repair
       7 years prior (Boeing AOG Service repair after tail-
       strike) → uncontrolled decompression + sustained loss
       of all hydraulics. JTSB AAIR-87-02. Direct precedent
       for §25.571 fail-safe + multi-load-path damage-
       tolerance + composite splice-plate inspection AD.
     · China Airlines 611 (B747-200 B-18255, Penghu 2002-05-
       25, 225 fatal): in-flight breakup at FL350 from prior
       (1980) tail-strike repair with single-plate doubler vs
       Boeing SRM-required double-doubler — fatigue crack
       propagated 22 years through repair area. ASC AOO-91-
       01-1. Skin/aperture-fatigue precedent.
     · Comet 1 G-ALYP (1954-01-10) + Comet 1 G-ALYY (1954-04-
       08): cabin-window-aperture stress-concentration WFD
       cyclic-fatigue cracks at corners of square windows
       (later rounded). De Havilland Comet COI. Foundational
       case for pressure-cabin aperture stress-concentration
       and §25.571 damage-tolerance regulatory regime.

   Subsystem inventory per airframe class:
     Each fuselage carries N apertures, each with:
       · type      DOOR-PAX / DOOR-PLUG / DOOR-CARGO /
                   DOOR-OWE (over-wing) / WINDOW / APD
                   (aft-pressure-dome)
       · seal      single / double / gasket / O-ring
       · latch     CAM-LOCK / PLUG-BOLT / TYPE-A / TYPE-II /
                   TYPE-III / OVERWING-EJECT
       · sensor    LIMIT-SW / PROX / DUAL / NONE
       · area_m2   aperture projected area for blowout-force
                   calculation
       · age       cycles fraction of certified life

   Per-airframe synthesis:
     · For each aperture, latch-armed flag (NORMAL / SUSPECT /
       UNCERT / OPEN) determined from per-icao24 hash, latch
       type robustness, post-AA587/AD embodiment, calendar
       age, and maintenance-history proxy
     · Per-aperture pressure-induced blowout force F_blow =
       ΔP × area (N), compared to certified latch-strength
       F_latch certified per §25.783
     · Margin M = F_latch / F_blow (safety factor; ≥1 OK)
     · Sensor-uncertainty SU (% probability that an OPEN
       state would NOT be detected by cockpit warning)
     · Plug-bolt-fatigue index (Alaska 1282 mode for plug
       doors with bolts; not applicable to hinged doors)
     · Skin-WFD index (Aloha 243 mode; calendar age + FC
       proxy)

   ΔP computation per current FL:
     · Cabin altitude at cruise typically 6000-8000ft on
       legacy metal, 4500-6000ft on B787/A350 composite
     · ΔP = P_cabin − P_amb per ISA model
     · Peak ΔP at cruise ceiling, scales with FL

   8 drivers (0-100):
     LATCH    latch-state risk (CAM-LOCK suspect, plug-bolt
              missing/loose Alaska 1282 mode)
     BLOWOUT  ΔP-induced load vs latch-strength margin
     SENSOR   sensor coverage uncertainty (single/dual/none)
     PLUG     plug-bolt fatigue / torque-stretch index for
              plug-type doors (Alaska 1282 driver)
     WFD      skin / aperture-corner fatigue index
              (Aloha 243, Comet, CAL611 driver)
     SEAL     gasket / O-ring degradation
     PHASE    phase weight (CRZ + high-ΔP = critical)
     MAINT    maintenance-record proxy / SDR frequency
              for class (Boeing 737-9 MAX +
              cargo-door 747 family historic)

   Composite: max·0.66 + mean·0.34 × phaseW × advMul
   clipped [0,100]

   Hard escalators:
     · Plug-bolt MISSING + ΔP>4psi → score ≥ 95
       (Alaska 1282 / direct AD 2024-02-51 mode)
     · Cargo-door cam-lock SUSPECT + ΔP>5psi → ≥ 88
       (UAL 811 / Turkish 981 mode)
     · WFD index >0.85 + ΔP>5psi → ≥ 82
       (Aloha 243 / CAL611 mode)
     · APD splice-plate suspect + ΔP>5psi → ≥ 78
       (JAL123 mode)
     · Latch-strength margin <1.5 → ≥ 65
     · Sensor uncertainty >40% any aperture → ≥ 55
     · Maintenance SDR-rate-high airframe + ΔP>5psi → ≥ 45

   6 tiers (escalated by hard floors):
     BLOWOUT   ≥85  rose       imminent plug/door blowout
                                (Alaska 1282 / Turkish 981 /
                                 UAL 811 / JAL 123 mode)
     CRITICAL  ≥65  rose-pink  aperture-latch margin breached
                                or WFD past threshold —
                                immediate diversion / descent
     UNCERT    ≥45  amber      sensor cannot confirm latch
                                state, treat as suspect
     WATCH     ≥25  sky        elevated risk vector, monitor
                                & schedule inspection
     NOMINAL   <25  emerald    all apertures NORMAL
     OFF             slate     not pressurised (ground or
                                FL<60 / cabin-alt unpressed)

   MapLibre overlay:
     · halo ring sized by composite score, tier-coloured
     · BLOWOUT / CRITICAL escalated as solid rose pins
     · dashed ΔP-vector forward along ground-track scaled
       by ΔP (red @ ΔP>8psi)
     · labels with cs / class / worst-aperture / ΔP / tier

   Side panel:
     · Header: DOORPLUG · §25.783 / NTSB DCA24MA063 / AAR-89-03
     · 6-tier counter strip click-to-filter
     · 6-cell summary μ-SCORE / μ-ΔP / WORST / BLOWOUT cnt /
       CRITICAL cnt / SUSPECT-LATCH cnt
     · 4 sliders ADV-MUL 50-200% / DP-MUL 50-200% /
       PLUG-MUL 50-200% / WFD-MUL 50-200%
     · 10-class chip filter
     · 6-phase chip filter
     · HALO/PIN/LBL/VEC toggles + search
     · AIRCRAFT / APERTURES / PRECEDENT / METHOD tabs

   AIRCRAFT tab: tier-worst-first row stack with cs + type +
     class-pill + phase-pill + tier-pill + worst-aperture + ΔP
     + latch-margin + 8-driver chips + advice citing accident
     precedent + AD reference.

   APERTURES tab: per-aperture summary across fleet:
     aperture-type / count / SUSPECT-cnt / mean-margin /
     mean-sensor-cov / typical-latch-architecture.

   PRECEDENT tab: chronological accident-precedent table:
     date / type / event / fatalities / regulatory output AD
     / SB / FAR amendment.

   METHOD tab: regulatory & physics narrative referencing
     §25.783 / §25.807 / §25.812 / §25.365 / §25.571 / AD
     2024-02-51 / SB 737-25A-1955 / NTSB DCA24MA063 / AAR-89-
     03 / AAR-90-01 / AAR-92-02 / JTSB AAIR-87-02 / ASC AOO-
     91-01-1 / AAIB Bull 1/92 / AC 25.571-1D / AC 91-56B /
     14 CFR §121.703 SDR rule.

   DOORPLUG entry registered in Layers > Safety & Traffic
   category, ft-doorplug persisted preference.
============================================================ */

interface DFlight {
  icao: string; callsign?: string; type?: string; operator?: string
  lat: number; lng: number; altitudeFt: number; velocityKts: number
  track: number; vertRate: number; ground: boolean
  arrival?: string; departure?: string
}

interface Props {
  map: maplibregl.Map | null
  flights: DFlight[]
  onClose: () => void
  onFly: (icao: string) => void
}

type Tier = 'BLOWOUT'|'CRITICAL'|'UNCERT'|'WATCH'|'NOMINAL'|'OFF'
type Phase = 'GND'|'CLB-LOW'|'CLB-HI'|'CRZ'|'DSC-HI'|'DSC-LOW'|'OFF'
type LatchState = 'NORMAL'|'SUSPECT'|'UNCERT'|'OPEN'
type ApertureType = 'DOOR-PAX'|'DOOR-PLUG'|'DOOR-CARGO'|'DOOR-OWE'|'WINDOW'|'APD'

const TIER_COLOR: Record<Tier, string> = {
  'BLOWOUT':  '#ef4444',
  'CRITICAL': '#f43f5e',
  'UNCERT':   '#f59e0b',
  'WATCH':    '#0ea5e9',
  'NOMINAL':  '#10b981',
  'OFF':      '#475569',
}
const TIER_RANK: Record<Tier, number> = {
  'BLOWOUT':0,'CRITICAL':1,'UNCERT':2,'WATCH':3,'NOMINAL':4,'OFF':5
}
const TIER_ORDER: Tier[] = ['BLOWOUT','CRITICAL','UNCERT','WATCH','NOMINAL']

const LATCH_COLOR: Record<LatchState, string> = {
  'NORMAL':'#10b981',
  'SUSPECT':'#f59e0b',
  'UNCERT':'#fb923c',
  'OPEN':'#ef4444',
}

interface ApertureDef {
  type: ApertureType
  label: string          // L1, R2, CARGO-FWD, PLUG-MID, etc
  area_m2: number        // projected blowout area
  latchArch: string      // certified latch family
  sensorArch: 'LIMIT-SW'|'PROX'|'DUAL'|'NONE'
  isPlugType: boolean    // has bolts subject to Alaska 1282 mode
  isCargo: boolean
  isAPD: boolean
}

interface ClassSpec {
  cls: string
  label: string
  apertures: ApertureDef[]
  cabinAltCrz_ft: number   // certified cabin alt at typical cruise FL
  maxDp_psi: number        // certified peak ΔP at MTOW cruise
  isPostAlaska1282: boolean // post AD 2024-02-51 inspection compliance
  baseSdrRate: number      // SDR frequency proxy 0..1
}

const SPECS: ClassSpec[] = [
  // B737-9 MAX — Alaska 1282 direct precedent class
  { cls:'BO-737-9MAX', label:'Boeing 737-9 MAX (MID-EXIT DOOR PLUG · Alaska 1282 N704AL precedent · AD 2024-02-51)',
    apertures:[
      { type:'DOOR-PAX', label:'L1', area_m2:1.6, latchArch:'TYPE-A hinged 4-cam', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'R1', area_m2:1.6, latchArch:'TYPE-A hinged 4-cam', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PLUG', label:'L2-PLUG', area_m2:1.3, latchArch:'PLUG 4-bolt 4-stop-pad', sensorArch:'NONE', isPlugType:true, isCargo:false, isAPD:false },
      { type:'DOOR-PLUG', label:'R2-PLUG', area_m2:1.3, latchArch:'PLUG 4-bolt 4-stop-pad', sensorArch:'NONE', isPlugType:true, isCargo:false, isAPD:false },
      { type:'DOOR-OWE', label:'OWE L/R', area_m2:0.8, latchArch:'TYPE-III eject', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'L2-rear', area_m2:1.6, latchArch:'TYPE-A hinged', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:2.0, latchArch:'CAM-LOCK 8-cam outward', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:2.0, latchArch:'CAM-LOCK 8-cam outward', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'splice-plate', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:8.35, isPostAlaska1282:true, baseSdrRate:0.18 },
  // B737NG (non-plug variant)
  { cls:'BO-737NG', label:'Boeing 737NG / 737-8 MAX (hinged exits, no MID plug)',
    apertures:[
      { type:'DOOR-PAX', label:'L1', area_m2:1.6, latchArch:'TYPE-A hinged 4-cam', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'R1', area_m2:1.6, latchArch:'TYPE-A hinged 4-cam', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-OWE', label:'OWE L/R', area_m2:0.8, latchArch:'TYPE-III eject', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'L2', area_m2:1.6, latchArch:'TYPE-A hinged', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:2.0, latchArch:'CAM-LOCK 8-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:2.0, latchArch:'CAM-LOCK 8-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'splice-plate', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:8.35, isPostAlaska1282:true, baseSdrRate:0.10 },
  // B737-200 / Classic — Aloha 243 precedent class
  { cls:'BO-737-CL', label:'Boeing 737-200 / -300 / -400 / -500 (Aloha 243 NTSB AAR-89-03 WFD precedent)',
    apertures:[
      { type:'DOOR-PAX', label:'L1', area_m2:1.6, latchArch:'TYPE-A early hinged', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'R1', area_m2:1.6, latchArch:'TYPE-A early hinged', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-OWE', label:'OWE L/R', area_m2:0.8, latchArch:'TYPE-III eject', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:false },
      { type:'WINDOW', label:'PAX-WIN', area_m2:0.2, latchArch:'frame-bonded', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:1.8, latchArch:'CAM-LOCK 6-cam', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'aged splice-plate', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:7.85, isPostAlaska1282:false, baseSdrRate:0.28 },
  // B747 — UAL 811 / JAL 123 precedent class
  { cls:'BO-747', label:'Boeing 747-100/200/300/400/SP (UAL 811 cargo-door + JAL 123 APD precedent)',
    apertures:[
      { type:'DOOR-PAX', label:'L1-L5', area_m2:1.7, latchArch:'TYPE-A hinged 4-cam', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'UPPER-L', area_m2:1.4, latchArch:'TYPE-A hinged', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:5.5, latchArch:'CAM-LOCK 8-cam (post-AD-90-09-06)', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:5.5, latchArch:'CAM-LOCK 8-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'NOSE-MAIN (-F)', area_m2:8.0, latchArch:'CAM-LOCK 12-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'composite splice (post-JAL123 SRM)', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:9.40, isPostAlaska1282:false, baseSdrRate:0.15 },
  // B777 / B787 — modern composite, B787 has lower cabin alt
  { cls:'BO-777-787', label:'Boeing 777 / 787 (composite skin, lower cabin alt 6000-6500ft on 787)',
    apertures:[
      { type:'DOOR-PAX', label:'L1-L4', area_m2:1.7, latchArch:'TYPE-A hinged 4-cam electric', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:4.5, latchArch:'CAM-LOCK 8-cam electric', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:4.5, latchArch:'CAM-LOCK 8-cam electric', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'BULK', area_m2:1.5, latchArch:'TYPE-III plug', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'composite frame-integrated', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:6500, maxDp_psi:9.40, isPostAlaska1282:false, baseSdrRate:0.06 },
  // Airbus A320 family
  { cls:'AB-A320', label:'Airbus A320 / A321 / A220 family (hinged TYPE-A, semi-plug cargo)',
    apertures:[
      { type:'DOOR-PAX', label:'L1-L2', area_m2:1.6, latchArch:'TYPE-A hinged + slide', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-OWE', label:'OWE L/R', area_m2:0.8, latchArch:'TYPE-III eject', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:2.4, latchArch:'CAM-LOCK semi-plug 6-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:2.4, latchArch:'CAM-LOCK semi-plug 6-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'frame-integrated', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:8.6, isPostAlaska1282:false, baseSdrRate:0.08 },
  // Airbus A330 / A340
  { cls:'AB-A330-340', label:'Airbus A330 / A340 (large semi-plug cargo, ULD-pallet doors)',
    apertures:[
      { type:'DOOR-PAX', label:'L1-L4', area_m2:1.7, latchArch:'TYPE-A hinged powered', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:4.5, latchArch:'CAM-LOCK 8-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:4.5, latchArch:'CAM-LOCK 8-cam', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'BULK', area_m2:1.5, latchArch:'TYPE-III plug', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'composite frame', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:8.5, isPostAlaska1282:false, baseSdrRate:0.07 },
  // Airbus A350 / A380 — modern composite
  { cls:'AB-A350-380', label:'Airbus A350 / A380 (composite, lower cabin alt 6000ft on A350)',
    apertures:[
      { type:'DOOR-PAX', label:'L1-L5', area_m2:1.8, latchArch:'TYPE-A hinged electric', sensorArch:'DUAL', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'FWD-CARGO', area_m2:5.0, latchArch:'CAM-LOCK 10-cam electric', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:5.0, latchArch:'CAM-LOCK 10-cam electric', sensorArch:'DUAL', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'composite integrated', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:6000, maxDp_psi:9.20, isPostAlaska1282:false, baseSdrRate:0.05 },
  // Regional jets
  { cls:'RGN-EMB-CRJ', label:'Embraer E170/190/E2 / Bombardier CRJ700-900 (regional plug/hinged mix)',
    apertures:[
      { type:'DOOR-PAX', label:'L1', area_m2:1.3, latchArch:'TYPE-I hinged plug-action', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-PAX', label:'L2-AFT', area_m2:1.2, latchArch:'TYPE-I hinged', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-OWE', label:'OWE L/R', area_m2:0.7, latchArch:'TYPE-III eject', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'AFT-CARGO', area_m2:1.4, latchArch:'TYPE-III plug', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'frame-integrated', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:8.40, isPostAlaska1282:false, baseSdrRate:0.10 },
  // Regional turboprops (low ΔP)
  { cls:'RGN-AT72-DH8', label:'ATR-72 / Dash-8 Q400 (lower cruise alt FL250 / low ΔP)',
    apertures:[
      { type:'DOOR-PAX', label:'L-AFT', area_m2:1.4, latchArch:'TYPE-I hinged plug', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-OWE', label:'OWE L/R', area_m2:0.7, latchArch:'TYPE-III eject', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:false, isAPD:false },
      { type:'DOOR-CARGO', label:'CARGO', area_m2:1.2, latchArch:'TYPE-III plug', sensorArch:'LIMIT-SW', isPlugType:false, isCargo:true, isAPD:false },
      { type:'APD', label:'AFT-PRESS-DOME', area_m2:0.0, latchArch:'frame-integrated', sensorArch:'NONE', isPlugType:false, isCargo:false, isAPD:true },
    ],
    cabinAltCrz_ft:8000, maxDp_psi:6.30, isPostAlaska1282:false, baseSdrRate:0.12 },
]

function specOf(type?: string): ClassSpec {
  const t = (type || '').toUpperCase()
  if (/^(B73[9]|B39M)/.test(t)) return SPECS[0]  // 737-9 MAX (Alaska 1282 plug)
  if (/^(B73|B38)/.test(t)) return SPECS[1]      // 737NG / 737-8 MAX
  if (/^(B74)/.test(t)) return SPECS[3]
  if (/^(B77|B78)/.test(t)) return SPECS[4]
  if (/^(A35|A38)/.test(t)) return SPECS[7]
  if (/^(A33|A34)/.test(t)) return SPECS[6]
  if (/^(A32|A20|A21|A22|BCS)/.test(t)) return SPECS[5]
  if (/^(E17|E19|E29|CRJ|RJ7|RJ8|RJ9)/.test(t)) return SPECS[8]
  if (/^(AT4|AT7|DH8|Q4)/.test(t)) return SPECS[9]
  return SPECS[1]
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)) }

function dhash(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619 }
  return (h >>> 0) / 0xffffffff
}

function classifyPhase(f: DFlight): Phase {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt / 100
  const vs = f.vertRate
  if (fl < 60) return fl < 30 ? 'CLB-LOW' : 'CLB-LOW'
  if (vs > 500 && fl < 280) return 'CLB-HI'
  if (vs < -500 && fl < 280) return 'DSC-LOW'
  if (vs < -500) return 'DSC-HI'
  if (fl >= 280 && Math.abs(vs) < 800) return 'CRZ'
  if (vs > 300) return 'CLB-HI'
  if (vs < -300) return 'DSC-HI'
  return 'CRZ'
}

// ISA pressure at altitude (psi)
function pressureAtFt(ft: number): number {
  // Standard atmosphere: troposphere up to 36089ft
  if (ft <= 36089) {
    const T = 288.15 - 0.0019812 * ft  // K
    return 14.696 * Math.pow(T / 288.15, 5.2559)
  } else {
    // Stratosphere isothermal layer
    return 14.696 * 0.2234 * Math.exp(-0.00004806 * (ft - 36089))
  }
}

function cabinAltAtFL(spec: ClassSpec, fl_ft: number): number {
  // Linear ramp from sea-level to certified cabin-alt at typical cruise FL
  // Most cabin schedules use rate-limited climb but for steady-state CRZ
  // the cabin alt reaches the certified value at FL ~280-360
  if (fl_ft <= 8000) return Math.max(0, fl_ft * 0.05)
  const climbScale = clamp((fl_ft - 8000) / 26000, 0, 1)
  return Math.min(spec.cabinAltCrz_ft, climbScale * spec.cabinAltCrz_ft)
}

// Per-aperture synthesised latch / fatigue / sensor state
interface ApertureState {
  def: ApertureDef
  latchState: LatchState
  plugBoltFatigue: number   // 0..1, only meaningful for plug-type
  wfdIndex: number          // 0..1 cumulative aperture-corner fatigue
  sealDeg: number           // 0..1 gasket degradation
  sensorUncert: number      // 0..1 probability sensor would miss OPEN
  blowoutForce_kN: number   // ΔP×area in kN
  latchStrength_kN: number  // certified latch strength
  margin: number            // latchStrength / blowoutForce
}

function synthAperture(
  f: DFlight, spec: ClassSpec, def: ApertureDef,
  dp_psi: number, hashOffset: number,
  plugMul: number, wfdMul: number
): ApertureState {
  const u1 = dhash(f.icao, 211 + hashOffset)
  const u2 = dhash(f.icao, 212 + hashOffset)
  const u3 = dhash(f.icao, 213 + hashOffset)
  const u4 = dhash(f.icao, 214 + hashOffset)
  const u5 = dhash(f.icao, 215 + hashOffset)

  // Latch state base rate per latch architecture
  let openRate = 0.001
  let suspectRate = 0.02
  let uncertRate = 0.04
  if (def.isPlugType && !spec.isPostAlaska1282) {
    // Pre-Alaska 1282 mod plug door has elevated risk
    suspectRate = 0.10
    uncertRate = 0.15
    openRate = 0.008
  } else if (def.isPlugType && spec.isPostAlaska1282) {
    // Post-AD 2024-02-51 inspection compliance, still elevated risk vs hinged
    suspectRate = 0.04
    uncertRate = 0.06
    openRate = 0.002
  } else if (def.isCargo && def.latchArch.includes('CAM-LOCK')) {
    // Cargo cam-lock historically risky (UAL 811, Turkish 981)
    suspectRate = 0.04
    uncertRate = 0.05
  } else if (def.isAPD) {
    suspectRate = 0.03
    uncertRate = 0.04
    openRate = 0.0  // APD doesn't "open", it ruptures (separate WFD pathway)
  }
  // Per-class SDR proxy amplifies all
  suspectRate *= (1 + spec.baseSdrRate)
  uncertRate *= (1 + spec.baseSdrRate)

  let latchState: LatchState = 'NORMAL'
  if (u1 < openRate) latchState = 'OPEN'
  else if (u1 < openRate + suspectRate) latchState = 'SUSPECT'
  else if (u1 < openRate + suspectRate + uncertRate) latchState = 'UNCERT'

  // Plug bolt fatigue (Alaska 1282 driver) — only meaningful for plug-type
  let plugBoltFatigue = 0
  if (def.isPlugType) {
    plugBoltFatigue = u2 * 0.7
    if (!spec.isPostAlaska1282) plugBoltFatigue = Math.max(plugBoltFatigue, 0.75)
    plugBoltFatigue *= plugMul
  }
  plugBoltFatigue = clamp(plugBoltFatigue, 0, 1)

  // WFD index — aperture-corner fatigue, amplified by class age & SDR rate
  let wfdIndex = u3 * 0.5
  if (spec.cls === 'BO-737-CL' || spec.cls === 'BO-747') wfdIndex += 0.25
  if (def.isAPD && (spec.cls === 'BO-747')) wfdIndex += 0.10  // JAL123 mode
  wfdIndex *= wfdMul
  wfdIndex = clamp(wfdIndex, 0, 1)

  // Seal degradation
  const sealDeg = clamp(u4 * 0.5 + spec.baseSdrRate * 0.3, 0, 1)

  // Sensor uncertainty
  let sensorUncert = 0
  if (def.sensorArch === 'NONE') sensorUncert = 1.0
  else if (def.sensorArch === 'LIMIT-SW') sensorUncert = 0.35 + u5 * 0.2
  else if (def.sensorArch === 'PROX') sensorUncert = 0.20 + u5 * 0.15
  else if (def.sensorArch === 'DUAL') sensorUncert = 0.05 + u5 * 0.10
  sensorUncert = clamp(sensorUncert, 0, 1)

  // Blowout force: F = ΔP_pa × area_m2 → N → kN
  const dp_pa = dp_psi * 6894.76
  const blowoutForce_kN = (def.isAPD ? 0 : dp_pa * def.area_m2 / 1000)

  // Certified latch strength (CS-25.783 requires safety factor 2.0 on max ΔP)
  // Approximated per latch architecture
  let latchStrengthFactor = 2.5  // default safety factor on max-ΔP-load
  if (def.latchArch.includes('PLUG 4-bolt')) latchStrengthFactor = 3.0
  else if (def.latchArch.includes('CAM-LOCK 12-cam')) latchStrengthFactor = 3.2
  else if (def.latchArch.includes('CAM-LOCK 10-cam')) latchStrengthFactor = 2.9
  else if (def.latchArch.includes('CAM-LOCK 8-cam')) latchStrengthFactor = 2.7
  else if (def.latchArch.includes('CAM-LOCK 6-cam')) latchStrengthFactor = 2.3
  else if (def.latchArch.includes('TYPE-III eject')) latchStrengthFactor = 2.4
  else if (def.latchArch.includes('TYPE-A')) latchStrengthFactor = 2.6
  else if (def.latchArch.includes('TYPE-I')) latchStrengthFactor = 2.2
  // Apply degradation from latch state
  if (latchState === 'SUSPECT') latchStrengthFactor *= 0.65
  else if (latchState === 'UNCERT') latchStrengthFactor *= 0.80
  else if (latchState === 'OPEN') latchStrengthFactor *= 0.01
  // Apply seal degradation
  latchStrengthFactor *= (1 - sealDeg * 0.15)
  const dp_max_pa = spec.maxDp_psi * 6894.76
  const F_max_kN = dp_max_pa * def.area_m2 / 1000
  const latchStrength_kN = F_max_kN * latchStrengthFactor

  const margin = blowoutForce_kN > 0.1 ? latchStrength_kN / blowoutForce_kN : 999

  return {
    def, latchState, plugBoltFatigue, wfdIndex, sealDeg,
    sensorUncert, blowoutForce_kN, latchStrength_kN, margin
  }
}

interface Row {
  f: DFlight; phase: Phase; cls: string; spec: ClassSpec
  dp_psi: number; cabinAlt_ft: number
  apertures: ApertureState[]
  worstAp: ApertureState | null
  drivers: Record<string, number>
  score: number; tier: Tier; notes: string[]
}

const PHASE_W: Record<Phase, number> = {
  'GND':0.0, 'CLB-LOW':0.55, 'CLB-HI':1.10, 'CRZ':1.35,
  'DSC-HI':1.05, 'DSC-LOW':0.55, 'OFF':0
}

function computeRow(
  f: DFlight, advMul: number, dpMul: number,
  plugMul: number, wfdMul: number
): Row {
  const ph = classifyPhase(f)
  const sp = specOf(f.type)

  if (ph === 'OFF' || ph === 'GND') {
    return {
      f, phase: ph, cls: sp.cls, spec: sp,
      dp_psi: 0, cabinAlt_ft: 0, apertures: [], worstAp: null,
      drivers: { LATCH:0,BLOWOUT:0,SENSOR:0,PLUG:0,WFD:0,SEAL:0,PHASE:0,MAINT:0 },
      score: 0, tier: 'OFF', notes: []
    }
  }

  // ΔP at current FL
  const cabinAlt = cabinAltAtFL(sp, f.altitudeFt)
  const P_amb = pressureAtFt(f.altitudeFt)
  const P_cab = pressureAtFt(cabinAlt)
  const dp_psi = Math.max(0, (P_cab - P_amb)) * dpMul

  // Phase gate: low-ΔP regimes don't get full score
  if (dp_psi < 1.5) {
    return {
      f, phase: ph, cls: sp.cls, spec: sp,
      dp_psi, cabinAlt_ft: cabinAlt, apertures: [], worstAp: null,
      drivers: { LATCH:0,BLOWOUT:0,SENSOR:0,PLUG:0,WFD:0,SEAL:0,PHASE:0,MAINT:0 },
      score: 0, tier: 'OFF', notes: []
    }
  }

  // Synthesise all apertures
  const apertures: ApertureState[] = []
  let hashOff = 0
  for (const def of sp.apertures) {
    apertures.push(synthAperture(f, sp, def, dp_psi, hashOff, plugMul, wfdMul))
    hashOff += 7
  }

  // Identify worst aperture by composite risk
  let worstAp: ApertureState | null = null
  let worstApScore = -1
  for (const ap of apertures) {
    const latchRisk = ap.latchState === 'OPEN' ? 100 : ap.latchState === 'SUSPECT' ? 75 : ap.latchState === 'UNCERT' ? 50 : 10
    const marginRisk = ap.def.isAPD ? 0 : clamp((3 - ap.margin) / 2.5 * 100, 0, 100)
    const plugRisk = ap.def.isPlugType ? ap.plugBoltFatigue * 100 : 0
    const wfdRisk = ap.wfdIndex * 100
    const sensorRisk = ap.sensorUncert * 100
    const composite = Math.max(latchRisk, marginRisk * 0.9, plugRisk * 0.9, wfdRisk * 0.8, sensorRisk * 0.5)
    if (composite > worstApScore) {
      worstApScore = composite
      worstAp = ap
    }
  }

  // Drivers
  // LATCH: worst latch state
  let dLATCH = 0
  for (const ap of apertures) {
    let l = 0
    if (ap.latchState === 'OPEN') l = 100
    else if (ap.latchState === 'SUSPECT') l = 70
    else if (ap.latchState === 'UNCERT') l = 45
    dLATCH = Math.max(dLATCH, l)
  }

  // BLOWOUT: worst margin
  let dBLOWOUT = 0
  for (const ap of apertures) {
    if (ap.def.isAPD) continue
    const r = clamp((3 - ap.margin) / 2.5 * 100, 0, 100)
    dBLOWOUT = Math.max(dBLOWOUT, r)
  }

  // SENSOR: worst sensor uncertainty
  let dSENSOR = 0
  for (const ap of apertures) {
    if (ap.def.isAPD) continue
    const s = ap.sensorUncert * 100
    dSENSOR = Math.max(dSENSOR, s)
  }

  // PLUG: worst plug-bolt fatigue
  let dPLUG = 0
  let plugApPresent = false
  for (const ap of apertures) {
    if (!ap.def.isPlugType) continue
    plugApPresent = true
    dPLUG = Math.max(dPLUG, ap.plugBoltFatigue * 100)
  }

  // WFD: worst WFD index across apertures + APD
  let dWFD = 0
  for (const ap of apertures) {
    dWFD = Math.max(dWFD, ap.wfdIndex * 100)
  }

  // SEAL: mean seal degradation
  const dSEAL = apertures.length > 0 ?
    apertures.reduce((a, b) => a + b.sealDeg * 100, 0) / apertures.length : 0

  // PHASE: phase × ΔP weight
  const dPHASE = clamp(PHASE_W[ph] * 50 + (dp_psi / 9.0) * 30, 0, 100)

  // MAINT: per-class SDR proxy
  const dMAINT = clamp(sp.baseSdrRate * 220, 0, 100)

  const drivers: Record<string, number> = {
    LATCH: dLATCH, BLOWOUT: dBLOWOUT, SENSOR: dSENSOR, PLUG: dPLUG,
    WFD: dWFD, SEAL: dSEAL, PHASE: dPHASE, MAINT: dMAINT
  }
  const arr = Object.values(drivers)
  const mx = Math.max(...arr)
  const mn = arr.reduce((a, b) => a + b, 0) / arr.length

  let score = (mx * 0.66 + mn * 0.34) * PHASE_W[ph] * advMul

  const notes: string[] = []

  // Hard escalators
  const plugBoltSevere = plugApPresent && dPLUG > 80
  const cargoCamLockSuspect = apertures.some(a => a.def.isCargo && a.def.latchArch.includes('CAM-LOCK') && (a.latchState === 'SUSPECT' || a.latchState === 'OPEN'))
  const wfdSevere = dWFD > 85
  const apdSuspect = apertures.some(a => a.def.isAPD && a.wfdIndex > 0.75)

  if (plugBoltSevere && dp_psi > 4) {
    score = Math.max(score, 95)
    notes.push(`PLUG-BOLT fatigue ${(dPLUG).toFixed(0)}% at ΔP=${dp_psi.toFixed(1)}psi — direct Alaska 1282 mode (NTSB DCA24MA063) · IMMEDIATE descent to FL150 + diversion · QRH RAPID DEPRESSURIZATION · post-AD 2024-02-51 inspection required · SB 737-25A-1955`)
  } else if (cargoCamLockSuspect && dp_psi > 5) {
    score = Math.max(score, 88)
    notes.push(`CARGO-DOOR CAM-LOCK SUSPECT at ΔP=${dp_psi.toFixed(1)}psi — UAL 811 (B747 NTSB AAR-90-01) / Turkish 981 (DC-10 BEA) mode · maintain pressurization, descend to FL100 IMMEDIATE · AD 90-09-06 cam-lock redesign reference`)
  } else if (wfdSevere && dp_psi > 5) {
    score = Math.max(score, 82)
    notes.push(`Widespread-Fatigue-Damage index ${dWFD.toFixed(0)}% at ΔP=${dp_psi.toFixed(1)}psi — Aloha 243 (NTSB AAR-89-03) / CAL611 (ASC AOO-91-01-1) mode · §25.571 LoV may be exceeded · ground for SSID inspection · AC 91-56B aging-aircraft program`)
  } else if (apdSuspect && dp_psi > 5) {
    score = Math.max(score, 78)
    notes.push(`AFT-PRESSURE-DOME suspect at ΔP=${dp_psi.toFixed(1)}psi — JAL 123 (JTSB AAIR-87-02) splice-plate-failure mode · descent to FL100 + structural inspection · Boeing SRM repair compliance audit required`)
  } else if (dBLOWOUT > 60 && dp_psi > 4) {
    score = Math.max(score, 65)
    notes.push(`latch-strength margin compromised at worst aperture (${worstAp?.def.label || '?'}) — F_blow=${worstAp?.blowoutForce_kN.toFixed(0) || '?'}kN vs F_latch=${worstAp?.latchStrength_kN.toFixed(0) || '?'}kN safety-factor ${(worstAp?.margin || 0).toFixed(2)}× · §25.783 minimum 2.0× breached · QRH DOOR FAULT procedure · monitor cabin ΔP`)
  } else if (dSENSOR > 50) {
    score = Math.max(score, 55)
    notes.push(`sensor-coverage uncertainty ${dSENSOR.toFixed(0)}% at worst aperture (${worstAp?.def.label || '?'}) — cockpit cannot confirm latch state · BA 5390 (AAIB Bull 1/92) maintenance-error mode · cross-check via cabin-crew visual inspection · §25.812 indication requirement`)
  } else if (sp.baseSdrRate > 0.15 && dp_psi > 5) {
    score = Math.max(score, 45)
    notes.push(`${sp.cls} elevated SDR-rate baseline ${(sp.baseSdrRate*100).toFixed(0)}% at ΔP=${dp_psi.toFixed(1)}psi — fleet-wide door-latch service-difficulty-report frequency · 14 CFR §121.703 reporting · monitor closely`)
  } else if (apertures.some(a => a.latchState === 'UNCERT')) {
    score = Math.max(score, 25)
    notes.push(`one or more apertures UNCERT state — sensor disagree at worst (${worstAp?.def.label || '?'}) · monitor pressurization rate / cabin-crew check / land at nearest suitable per §25.783 advisory`)
  } else {
    notes.push(`all apertures NORMAL · ΔP ${dp_psi.toFixed(1)}/${sp.maxDp_psi.toFixed(1)}psi · latch-strength margin ${(worstAp?.margin || 0).toFixed(1)}× at worst aperture · §25.783 compliance NOMINAL`)
  }
  score = clamp(score, 0, 100)

  let tier: Tier = 'OFF'
  if (score >= 85) tier = 'BLOWOUT'
  else if (score >= 65) tier = 'CRITICAL'
  else if (score >= 45) tier = 'UNCERT'
  else if (score >= 22) tier = 'WATCH'
  else tier = 'NOMINAL'

  return {
    f, phase: ph, cls: sp.cls, spec: sp,
    dp_psi, cabinAlt_ft: cabinAlt,
    apertures, worstAp,
    drivers, score, tier, notes
  }
}

export default function DoorPlug({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<'AIRCRAFT'|'APERTURES'|'PRECEDENT'|'METHOD'>('AIRCRAFT')
  const [tierFilter, setTierFilter] = useState<Tier|'ALL'>('ALL')
  const [classFilter, setClassFilter] = useState<string>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<Phase|'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [advMul, setAdvMul] = useState(1.0)
  const [dpMul, setDpMul] = useState(1.0)
  const [plugMul, setPlugMul] = useState(1.0)
  const [wfdMul, setWfdMul] = useState(1.0)
  const [shHalo, setShHalo] = useState(true)
  const [shPin, setShPin] = useState(true)
  const [shLbl, setShLbl] = useState(false)
  const [shVec, setShVec] = useState(true)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      const r = computeRow(f, advMul, dpMul, plugMul, wfdMul)
      if (r.phase !== 'OFF' && r.phase !== 'GND') out.push(r)
    }
    out.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.score - a.score))
    return out
  }, [flights, advMul, dpMul, plugMul, wfdMul])

  // === MapLibre overlay
  useEffect(() => {
    if (!map) return
    const SRC = 'doorplug-src'
    const SRC_VEC = 'doorplug-vec-src'
    const ensureSrc = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any })
    }
    ensureSrc(SRC); ensureSrc(SRC_VEC)

    const writeAll = () => {
      const view = rows.filter(r =>
        (tierFilter === 'ALL' || r.tier === tierFilter) &&
        (classFilter === 'ALL' || r.cls === classFilter) &&
        (phaseFilter === 'ALL' || r.phase === phaseFilter)
      )
      const acFeats: any[] = []
      const vecFeats: any[] = []
      for (const r of view) {
        const parts: string[] = []
        parts.push(r.f.callsign || r.f.icao)
        parts.push(r.cls.split('-')[0])
        if (r.worstAp) parts.push(r.worstAp.def.label)
        parts.push(`ΔP${r.dp_psi.toFixed(1)}psi`)
        if (r.worstAp && !r.worstAp.def.isAPD) parts.push(`×${r.worstAp.margin.toFixed(1)}`)
        acFeats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.f.lng, r.f.lat] },
          properties: {
            tier: r.tier, color: TIER_COLOR[r.tier], score: r.score,
            sz: 6 + (r.score / 100) * 14,
            label: parts.join(' · ')
          }
        })
        // ΔP vector: forward along ground-track scaled by ΔP
        if (r.tier === 'BLOWOUT' || r.tier === 'CRITICAL' || r.tier === 'UNCERT') {
          const km = clamp(2 + (r.dp_psi / 9) * 16, 1, 22)
          const brg = (r.f.track || 0) * Math.PI / 180
          const dlat = (km / 111.32) * Math.cos(brg)
          const dlng = (km / (111.32 * Math.cos(r.f.lat * Math.PI / 180))) * Math.sin(brg)
          const endLat = r.f.lat + dlat
          const endLng = r.f.lng + dlng
          vecFeats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[r.f.lng, r.f.lat], [endLng, endLat]] },
            properties: { color: TIER_COLOR[r.tier] }
          })
        }
      }
      ;(map.getSource(SRC) as any).setData({ type: 'FeatureCollection', features: shHalo || shPin || shLbl ? acFeats : [] })
      ;(map.getSource(SRC_VEC) as any).setData({ type: 'FeatureCollection', features: shVec ? vecFeats : [] })
    }
    if (!map.getLayer('doorplug-halo'))
      map.addLayer({ id: 'doorplug-halo', type: 'circle', source: SRC, paint: { 'circle-radius': ['get', 'sz'], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.78 } })
    if (!map.getLayer('doorplug-pin'))
      map.addLayer({ id: 'doorplug-pin', type: 'circle', source: SRC, filter: ['>=', ['get', 'score'], 65], paint: { 'circle-radius': 4.4, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0f17', 'circle-stroke-width': 1.2 } })
    if (!map.getLayer('doorplug-lbl'))
      map.addLayer({ id: 'doorplug-lbl', type: 'symbol', source: SRC, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0b0f17', 'text-halo-width': 1.2 } })
    if (!map.getLayer('doorplug-vec'))
      map.addLayer({ id: 'doorplug-vec', type: 'line', source: SRC_VEC, paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 2.5], 'line-opacity': 0.78 } })

    writeAll()
    return () => {
      for (const id of ['doorplug-lbl', 'doorplug-pin', 'doorplug-halo', 'doorplug-vec']) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [SRC, SRC_VEC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map, rows, tierFilter, classFilter, phaseFilter, shHalo, shPin, shLbl, shVec])

  const visible = rows.filter(r =>
    (tierFilter === 'ALL' || r.tier === tierFilter) &&
    (classFilter === 'ALL' || r.cls === classFilter) &&
    (phaseFilter === 'ALL' || r.phase === phaseFilter) &&
    (!search || (r.f.callsign || r.f.icao).toLowerCase().includes(search.toLowerCase()) ||
      (r.f.type || '').toLowerCase().includes(search.toLowerCase()) ||
      (r.f.operator || '').toLowerCase().includes(search.toLowerCase()))
  )

  const counts: Record<Tier, number> = { 'BLOWOUT': 0, 'CRITICAL': 0, 'UNCERT': 0, 'WATCH': 0, 'NOMINAL': 0, 'OFF': 0 }
  for (const r of rows) counts[r.tier]++
  const muScore = rows.length ? (rows.reduce((a, b) => a + b.score, 0) / rows.length) : 0
  const muDp = rows.length ? (rows.reduce((a, b) => a + b.dp_psi, 0) / rows.length) : 0
  const blowoutCnt = counts['BLOWOUT']
  const critCnt = counts['CRITICAL']
  const suspectLatchCnt = rows.filter(r =>
    r.apertures.some(a => a.latchState === 'SUSPECT' || a.latchState === 'OPEN')
  ).length
  const worst = rows[0]

  // Per-aperture-type aggregation
  const apMap = new Map<string, { type: ApertureType; count: number; suspect: number; muMargin: number; muSens: number; latchArchSet: Set<string> }>()
  for (const r of rows) {
    for (const ap of r.apertures) {
      const key = ap.def.type + '-' + ap.def.label
      const e = apMap.get(key) || { type: ap.def.type, count: 0, suspect: 0, muMargin: 0, muSens: 0, latchArchSet: new Set<string>() }
      e.count++
      if (ap.latchState === 'SUSPECT' || ap.latchState === 'OPEN') e.suspect++
      if (!ap.def.isAPD) e.muMargin += ap.margin
      e.muSens += ap.sensorUncert
      e.latchArchSet.add(ap.def.latchArch)
      apMap.set(key, e)
    }
  }
  const apRows = Array.from(apMap.entries()).map(([key, e]) => ({
    key, type: e.type, count: e.count, suspect: e.suspect,
    muMargin: e.muMargin / e.count, muSens: e.muSens / e.count,
    latchArchs: Array.from(e.latchArchSet).join(' / ')
  })).sort((a, b) => b.suspect - a.suspect || a.muMargin - b.muMargin)

  const precedent = [
    { date: '1954-01-10', type: 'Comet 1', event: 'Cabin window-aperture WFD fatigue cracks at corners — foundational pressure-cabin precedent', fatal: 35, ref: 'De Havilland COI / §25.571 origin' },
    { date: '1974-03-03', type: 'DC-10', event: 'Turkish 981 — aft cargo-door blew off at FL120 / latch-locking failure', fatal: 346, ref: 'BEA F-WL-AW / §25.783 amendment 25-54' },
    { date: '1985-08-12', type: 'B747SR', event: 'JAL 123 — aft-pressure-dome failure from prior tail-strike splice-plate repair', fatal: 520, ref: 'JTSB AAIR-87-02 / SRM compliance AD' },
    { date: '1988-04-28', type: 'B737-200', event: 'Aloha 243 — 5.5m upper fuselage skin separated FL240 (Widespread Fatigue Damage / cold-bond debond)', fatal: 1, ref: 'NTSB AAR-89-03 / AC 91-56B aging-aircraft' },
    { date: '1989-02-24', type: 'B747-122', event: 'UAL 811 — fwd cargo-door opened FL222 over Pacific (latch-cam-sector failure)', fatal: 9, ref: 'NTSB AAR-90-01 + AAR-92-02 / AD 88-12-04 + 90-09-06' },
    { date: '1990-06-10', type: 'BAC 1-11', event: 'BA 5390 — LH cockpit windshield panel departed FL173 (maintenance bolt mis-replacement)', fatal: 0, ref: 'AAIB Bull 1/92' },
    { date: '1996-07-17', type: 'B747-131', event: 'TWA 800 — centre-fuel-tank explosion (drove §25.981 FRM / interacts with skin temp envelope)', fatal: 230, ref: 'NTSB AAR-00-03' },
    { date: '2002-05-25', type: 'B747-200', event: 'CAL 611 — in-flight breakup FL350 from 22-yr-old single-doubler tail-strike repair', fatal: 225, ref: 'ASC AOO-91-01-1' },
    { date: '2024-01-05', type: 'B737-9 MAX', event: 'Alaska 1282 — LEFT-MID DOOR-PLUG departed FL160 climbout / 4 plug bolts MISSING (Renton rework)', fatal: 0, ref: 'NTSB DCA24MA063 / EAD 2024-02-51 / SB 737-25A-1955' },
  ]

  return (
    <div className="fixed top-16 right-3 z-40 w-[490px] max-h-[88vh] flex flex-col rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100 text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-wider text-sky-300">DOORPLUG · APERTURE</span>
          <span className="text-[10px] text-slate-400">Latch-Integrity &amp; Blowout-Risk · §25.783 / Alaska 1282</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-sm leading-none">×</button>
      </div>

      {/* tier strip */}
      <div className="flex gap-1 px-3 py-2 border-b border-slate-700/60">
        <button onClick={() => setTierFilter('ALL')} className={`flex-1 px-1.5 py-1 rounded text-[10px] ${tierFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-300'}`}>ALL · {rows.length}</button>
        {TIER_ORDER.map(t => (
          <button key={t} onClick={() => setTierFilter(t)} className={`flex-1 px-1.5 py-1 rounded text-[10px] font-mono ${tierFilter === t ? 'border' : 'border border-slate-700/60'}`} style={{ background: `${TIER_COLOR[t]}22`, borderColor: tierFilter === t ? TIER_COLOR[t] : undefined, color: TIER_COLOR[t] }}>{t === 'BLOWOUT' ? 'BLOW' : t === 'CRITICAL' ? 'CRIT' : t === 'UNCERT' ? 'UNCT' : t === 'WATCH' ? 'WTCH' : 'NOM'} {counts[t]}</button>
        ))}
      </div>

      {/* summary cells */}
      <div className="grid grid-cols-6 gap-1 px-3 py-2 border-b border-slate-700/60 text-[10px]">
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-SC</div><div className="text-slate-100 font-mono">{muScore.toFixed(0)}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">μ-ΔP</div><div className="font-mono" style={{ color: muDp > 7 ? TIER_COLOR['UNCERT'] : '#cbd5e1' }}>{muDp.toFixed(1)}psi</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">WORST</div><div className="text-slate-100 font-mono truncate">{worst?.f.callsign || worst?.f.icao || '—'}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">BLOW</div><div className="font-mono" style={{ color: blowoutCnt > 0 ? TIER_COLOR['BLOWOUT'] : TIER_COLOR.NOMINAL }}>{blowoutCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">CRIT</div><div className="font-mono" style={{ color: critCnt > 0 ? TIER_COLOR['CRITICAL'] : TIER_COLOR.NOMINAL }}>{critCnt}</div></div>
        <div className="bg-slate-800/50 rounded px-1.5 py-1"><div className="text-slate-500">SUSP-LCH</div><div className="font-mono" style={{ color: suspectLatchCnt > 0 ? TIER_COLOR['UNCERT'] : TIER_COLOR.NOMINAL }}>{suspectLatchCnt}</div></div>
      </div>

      {/* sliders */}
      <div className="px-3 py-2 border-b border-slate-700/60 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-slate-400">ADV-MUL <span className="text-slate-200 font-mono">{(advMul * 100).toFixed(0)}%</span>
            <input type="range" min={50} max={200} value={advMul * 100} onChange={e => setAdvMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">ΔP-MUL <span className="text-slate-200 font-mono">{(dpMul * 100).toFixed(0)}%</span>
            <input type="range" min={50} max={200} value={dpMul * 100} onChange={e => setDpMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">PLUG-MUL <span className="text-slate-200 font-mono">{(plugMul * 100).toFixed(0)}%</span>
            <input type="range" min={50} max={200} value={plugMul * 100} onChange={e => setPlugMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
          <label className="text-[10px] text-slate-400">WFD-MUL <span className="text-slate-200 font-mono">{(wfdMul * 100).toFixed(0)}%</span>
            <input type="range" min={50} max={200} value={wfdMul * 100} onChange={e => setWfdMul(+e.target.value / 100)} className="w-full accent-sky-500" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setClassFilter('ALL')} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === 'ALL' ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>ALL</button>
          {SPECS.map(s => (
            <button key={s.cls} onClick={() => setClassFilter(s.cls)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${classFilter === s.cls ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{s.cls}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(['ALL', 'CLB-LOW', 'CLB-HI', 'CRZ', 'DSC-HI', 'DSC-LOW'] as const).map(p => (
            <button key={p} onClick={() => setPhaseFilter(p as any)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${phaseFilter === p ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{p}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {[['HALO', shHalo, setShHalo], ['PIN', shPin, setShPin], ['LBL', shLbl, setShLbl], ['VEC', shVec, setShVec]].map(([n, v, fn]: any) => (
            <button key={n} onClick={() => fn(!v)} className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${v ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-500'}`}>{n}</button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/op" className="flex-1 ml-1 px-1.5 py-0.5 bg-slate-800/60 border border-slate-700/60 rounded text-[10px] text-slate-200 outline-none focus:border-sky-500/40" />
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-3 pt-2 text-[10px]">
        {(['AIRCRAFT', 'APERTURES', 'PRECEDENT', 'METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-2 py-1 rounded ${tab === t ? 'bg-sky-500/15 border border-sky-500/40 text-slate-100' : 'bg-slate-800/60 border border-slate-700/60 text-slate-400'}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {tab === 'AIRCRAFT' && visible.length === 0 && (
          <div className="text-center text-slate-500 py-6 text-[10px]">No pressurised aircraft in current view · ΔP gate &gt;1.5psi</div>
        )}
        {tab === 'AIRCRAFT' && visible.slice(0, 80).map((r, i) => (
          <div key={i} onClick={() => onFly(r.f.icao)} className="cursor-pointer bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{r.f.callsign || r.f.icao}</span>
              <span className="text-slate-500">·</span>
              <span className="font-mono text-slate-400">{r.f.type || '—'}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.cls}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{r.phase}</span>
              <span className="px-1 rounded font-mono text-[9px]" style={{ background: `${TIER_COLOR[r.tier]}33`, color: TIER_COLOR[r.tier] }}>{r.tier}</span>
              <span className="ml-auto text-slate-400 font-mono">SC {r.score.toFixed(0)}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
              <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">ΔP </span><span className="font-mono text-slate-200">{r.dp_psi.toFixed(1)}/{r.spec.maxDp_psi.toFixed(1)}psi</span></div>
              <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">CAB </span><span className="font-mono text-slate-200">{r.cabinAlt_ft.toFixed(0)}ft</span></div>
              <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">WORST </span><span className="font-mono text-slate-200">{r.worstAp?.def.label || '—'}</span></div>
            </div>
            {r.worstAp && (
              <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
                <div className="bg-slate-900/40 rounded px-1 py-0.5">
                  <span className="text-slate-500">LATCH </span>
                  <span className="font-mono" style={{ color: LATCH_COLOR[r.worstAp.latchState] }}>{r.worstAp.latchState}</span>
                </div>
                {!r.worstAp.def.isAPD && (
                  <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">MARG </span><span className="font-mono" style={{ color: r.worstAp.margin < 2 ? TIER_COLOR['CRITICAL'] : r.worstAp.margin < 2.5 ? TIER_COLOR['UNCERT'] : '#cbd5e1' }}>{r.worstAp.margin.toFixed(2)}×</span></div>
                )}
                <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">SENS </span><span className="font-mono text-slate-200">{(r.worstAp.sensorUncert * 100).toFixed(0)}%</span></div>
              </div>
            )}
            <div className="flex flex-wrap gap-0.5 mt-1">
              {Object.entries(r.drivers).map(([k, v]) => (
                <span key={k} className="px-1 py-0.5 rounded text-[8px] font-mono" style={{ background: v > 70 ? '#ef444433' : v > 45 ? '#f59e0b33' : v > 25 ? '#0ea5e933' : '#33415533', color: v > 70 ? TIER_COLOR['BLOWOUT'] : v > 45 ? TIER_COLOR['UNCERT'] : v > 25 ? TIER_COLOR['WATCH'] : '#94a3b8' }}>{k} {v.toFixed(0)}</span>
              ))}
            </div>
            {r.notes.map((n, j) => (
              <div key={j} className="text-[9px] mt-1 leading-tight" style={{ color: r.tier === 'BLOWOUT' ? TIER_COLOR['BLOWOUT'] : r.tier === 'CRITICAL' ? TIER_COLOR['CRITICAL'] : r.tier === 'UNCERT' ? TIER_COLOR['UNCERT'] : r.tier === 'WATCH' ? TIER_COLOR['WATCH'] : '#94a3b8' }}>{n}</div>
            ))}
          </div>
        ))}

        {tab === 'APERTURES' && apRows.length === 0 && (
          <div className="text-center text-slate-500 py-6 text-[10px]">No apertures in current dataset.</div>
        )}
        {tab === 'APERTURES' && apRows.slice(0, 60).map((a, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-slate-100">{a.key}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{a.type}</span>
              <span className="ml-auto text-slate-400 font-mono">×{a.count}</span>
            </div>
            <div className="text-[9px] text-slate-500 mt-0.5">{a.latchArchs}</div>
            <div className="grid grid-cols-3 gap-1 mt-1 text-[9px]">
              <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">SUSPECT </span><span className="font-mono" style={{ color: a.suspect > 0 ? TIER_COLOR['UNCERT'] : '#cbd5e1' }}>{a.suspect}</span></div>
              <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-MARGIN </span><span className="font-mono" style={{ color: a.muMargin < 2 ? TIER_COLOR['CRITICAL'] : a.muMargin < 2.5 ? TIER_COLOR['UNCERT'] : '#cbd5e1' }}>{a.type === 'APD' ? '—' : a.muMargin.toFixed(2) + '×'}</span></div>
              <div className="bg-slate-900/40 rounded px-1 py-0.5"><span className="text-slate-500">μ-SENS-U </span><span className="font-mono text-slate-200">{(a.muSens * 100).toFixed(0)}%</span></div>
            </div>
          </div>
        ))}

        {tab === 'PRECEDENT' && precedent.map((p, i) => (
          <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded p-1.5">
            <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
              <span className="font-mono text-sky-300">{p.date}</span>
              <span className="px-1 rounded bg-slate-700/50 text-slate-300 font-mono text-[9px]">{p.type}</span>
              {p.fatal > 0 && <span className="ml-auto font-mono text-[9px]" style={{ color: TIER_COLOR['BLOWOUT'] }}>{p.fatal} fatal</span>}
            </div>
            <div className="text-[10px] text-slate-200 mt-1 leading-tight">{p.event}</div>
            <div className="text-[9px] text-slate-500 mt-0.5 italic">{p.ref}</div>
          </div>
        ))}

        {tab === 'METHOD' && (
          <div className="text-[10px] text-slate-300 leading-relaxed space-y-1.5">
            <div>
              <span className="font-mono text-sky-300">Regulatory regime · 14 CFR / EASA CS-25</span>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px]">
              <div><b>§25.783</b> Doors — fuselage-aperture closure / latching / positive-confirmation indication</div>
              <div><b>§25.807</b> Emergency exits — sizing / count / accessibility</div>
              <div><b>§25.812</b> Emergency lighting / exit-indication / cabin signage</div>
              <div><b>§25.365</b> Pressurised compartments — ΔP design + decompression event sizing</div>
              <div><b>§25.571</b> Damage tolerance + fatigue (incl. WFD per Aloha 243 follow-up amendment)</div>
              <div><b>§25.981</b> Fuel tank flammability (TWA 800 follow-up FRM)</div>
              <div><b>§121.703</b> Service Difficulty Report mandatory reporting</div>
              <div><b>AC 25.571-1D</b> Damage Tolerance &amp; Fatigue Evaluation of Structure</div>
              <div><b>AC 91-56B</b> Continuing Structural Integrity of Transport Category Airplanes (Aging Aircraft)</div>
              <div><b>AC 25-9A</b> Smoke Detection / Penetration / Evacuation</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px]">
              <div className="font-mono text-amber-300 mb-1">Alaska 1282 active AD trail</div>
              <div><b>EAD 2024-02-51</b> Boeing 737-9 MAX MID EXIT DOOR PLUG immediate inspection (151 fleet, 9-day grounding)</div>
              <div><b>SB 737-25A-1955</b> Boeing service-bulletin: 4-bolt + 4-stop-pad torque inspection</div>
              <div><b>NTSB DCA24MA063</b> Investigation: 4 bolts MISSING at delivery (Renton FOD/rework)</div>
              <div><b>FAA Boeing Production Audit</b> 6-week 737 production-line audit (Feb-Mar 2024)</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px]">
              <div className="font-mono text-amber-300 mb-1">Per-airframe physics</div>
              <div>F_blowout = ΔP × Aperture_area (N)</div>
              <div>F_latch_certified = F_blowout_max × safety_factor (CS-25.783 minimum 2.0)</div>
              <div>Margin M = F_latch / F_blowout (target ≥ 2.0× at max-ΔP cruise)</div>
              <div>WFD index = cumulative-FC × stress-conc-factor / DSG (per AC 25.571-1D §6.7)</div>
              <div>Sensor uncertainty SU = P(open state NOT detected by cockpit warning)</div>
            </div>
            <div className="bg-slate-800/40 border border-slate-700/40 rounded p-2 text-[9px]">
              <div className="font-mono text-amber-300 mb-1">Driver weighting</div>
              <div>composite = max(LATCH, BLOWOUT, SENSOR, PLUG, WFD, SEAL, PHASE, MAINT) × 0.66</div>
              <div>          + mean(...) × 0.34</div>
              <div>          × PHASE_W × ADV_MUL</div>
              <div className="mt-1">Hard escalators applied for canonical precedent modes:</div>
              <div>· PLUG-BOLT fatigue + ΔP&gt;4psi → ≥95 (Alaska 1282 / DCA24MA063)</div>
              <div>· CARGO-DOOR CAM-LOCK SUSPECT + ΔP&gt;5psi → ≥88 (UAL 811 / Turkish 981)</div>
              <div>· WFD &gt;85% + ΔP&gt;5psi → ≥82 (Aloha 243 / CAL611)</div>
              <div>· APD suspect + ΔP&gt;5psi → ≥78 (JAL 123)</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
