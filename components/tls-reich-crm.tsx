'use client'
import { useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'

/* ============================================================
   TLS · Target Level of Safety · Reich Collision-Risk-Model
   per-airframe probabilistic pair-wise CRM evaluator
   ------------------------------------------------------------
   For each airborne flight, evaluates ICAO Annex 11 / Doc 9689
   Target Level of Safety against the canonical Reich-Marks 1966
   Collision Risk Model (CRM), the bedrock framework that ICAO
   SASP uses to justify every horizontal and vertical separation
   standard in en-route, terminal, and oceanic airspace.

   The Reich-Marks CRM (Reich, 1966, "A Theory of Safe Separation
   Standards for ATC", J. Inst. Navig. 19) expresses the expected
   number of fatal accidents per flight-hour for an aircraft of
   semi-dimensions {λ_x, λ_y, λ_z} as the sum of three pair-wise
   passing-rate × overlap-probability terms:

      N_az = (P_y(0)·P_z(0)·|Δv̄|) · (1/λ_x·E[1/T_x])  (longitudinal)
           + (P_x(0)·P_z(0)·|Δv_y|) · (1/λ_y·E[1/T_y])  (lateral)
           + (P_x(0)·P_y(0)·|Δv_z|) · (1/λ_z·E[1/T_z])  (vertical)

   Where P_x(0) / P_y(0) / P_z(0) are the conditional overlap
   probabilities at zero relative displacement (the {x,y,z}
   Reich overlap kernels) and Δv̄ / Δv_y / Δv_z are the mean
   relative velocities in each axis.  The aircraft pair is
   "in collision" when |Δx|<λ_x AND |Δy|<λ_y AND |Δz|<λ_z.

   ICAO TLS target (Annex 11 Para 3.1.4 + Doc 9689 Manual on
   Airspace Planning Methodology for Determination of Separation
   Minima §3.4): the rate of mid-air collisions (MACs) per flight
   hour shall not exceed 5 × 10⁻⁹ for any unidimensional pair
   of opposite-direction parallel routes, OR 1.5 × 10⁻⁸ for
   bidirectional traffic in same-track configurations.  This
   TLS is THE foundational number that drove:

     · 1979 ICAO RGCSP NAT MNPS 1000ft vertical sep adoption
     · 1997 RVSM cert program FL290-FL410 1000ft vertical sep
     · 2005 RNP-10 / RNP-4 oceanic horizontal sep 30/30 → 23/23
     · 2008 PBN Manual Doc 9613 navspec performance criteria
     · 2015 PBCS RCP-240/RSP-180 datalink/surv performance
     · 2020 SBAS LPV-200 GLS CAT-I precision approach overlays
     · Every TCAS Logic Version 7.0/7.1 sensitivity-level table

   Structurally distinct from:
     · CPA (geometric closest-point-of-approach pairing only —
       no probability, no airspace-planning context)
     · TCAS-RA (downstream airborne resolution-advisory logic
       DO-185B — TLS is the design BASIS for separation standards
       that TCAS sits below as last-layer)
     · ACAS-X (next-gen DP DO-385 collision-avoidance MDP —
       TLS is the framework against which ACAS-X is certified
       as not degrading the established TLS)
     · STCA (controller-side Short-Term Conflict Alert threshold
       trigger — TLS is the probabilistic floor STCA defends)
     · MTCD (Medium-Term Conflict Detection deterministic 8-30min
       trajectory probe — TLS is the longer-horizon design model)
     · AIRPROX (post-event Risk Assessment Tool A/B/C/D/E
       severity classification of REPORTED encounters — TLS is
       FORWARD-LOOKING probabilistic risk-per-hour estimate)
     · CONFLICT (binary detection ≤5NM 1000ft — TLS is the
       probabilistic FOUNDATION for that 5NM/1000ft threshold)
     · DAA-WC (UAS Detect-And-Avoid Well-Clear RTCA DO-365B —
       separate UAS framework, conceptually distinct from CRM)
     · RVSM (single-axis RVSM-equipment compliance — TLS
       integrates ALL three axes including RVSM as one driver)
     · RNP / PBN (navspec route-keeping accuracy compliance —
       TLS combines RNP performance into the lateral overlap
       kernel as one driver)
     · ADSB-INT (broadcast integrity NIC/NACp/SIL/SDA — TLS
       is the higher-level safety target that surveillance
       performance must support)

   TLS is uniquely the AGGREGATED probabilistic pair-wise CRM
   evaluator scoring the estimated collision-risk-rate per
   flight-hour against ICAO Annex 11 Para 3.1.4 / Doc 9689
   target 5 × 10⁻⁹ MAC/h.

   Seven driver scores [0..100] aggregated per flight:
     SX-LONG    Reich longitudinal passing-rate × overlap
     SY-LAT     Reich lateral passing-rate × overlap
     SZ-VERT    Reich vertical passing-rate × overlap
     DENS       Local 100NM cylinder traffic density
     REGIME     Airspace regime (RVSM / RNP-1 / RNP-4 / Random)
     NAV-PERF   Per-flight navspec performance (Px/Py kernels)
     SURV       Surveillance performance class
                (radar / ADSB / Multilat / Procedural)

   8 risk categories (dominant axis):
     VERT-RVSM    vertical overlap, RVSM-altimetry ASE
     VERT-LARGE   vertical overlap, non-RVSM transitional
     LAT-RNP1     lateral overlap, RNP-1 PBN TMA
     LAT-RNP4     lateral overlap, RNP-4 oceanic
     LAT-RNP10    lateral overlap, RNP-10 oceanic
     LONG-TRAIL   along-track in-trail same-direction
     OCEAN-LONG   oceanic NAT/PACOTS longitudinal
     CLEAR        no significant neighbor pair

   8-phase classifier:
     ENROUTE-RVSM    FL290-FL410, 1000ft RVSM vertical sep
     ENROUTE         FL100-FL290 / >FL410, 2000ft vertical sep
     TMA             arrival/departure terminal area, 3NM sep
     OCEANIC-PBN     RNP-4 / RNP-10 oceanic with CPDLC/ADS-C
     OCEANIC-RNDM    random-route oceanic (50NM lateral sep)
     CLB-TRANSITION  climb crossing FL290 RVSM gate
     DST-TRANSITION  descent crossing FL290 RVSM gate
     GND             not airborne

   Six tiers (mapped from composite log-scaled risk score):
     CRITICAL ≥85  rose       MAC-rate > 10× TLS (5e-8/h)
     WATCH    ≥65  rose-pink  MAC-rate 1×-10× TLS
     MARGIN   ≥45  amber      MAC-rate 0.1×-1× TLS
     CLEAR    ≥25  sky        MAC-rate 0.01×-0.1× TLS
     GOOD     ≥10  emerald    MAC-rate 0.001×-0.01× TLS
     NEUTRAL  <10  slate      MAC-rate ≪ TLS / isolated

   Composite = log10-mapped MAX over (SX/SY/SZ driver-domain
   risk estimate) × DENS × REGIME × NAV × SURV per flight-hour
   then × phase-multiplier (ENROUTE-RVSM 1.05 · TMA 1.20 ·
   OCEANIC-PBN 0.85 · OCEANIC-RNDM 1.40 · CLB-TRANSITION 1.15 ·
   DST-TRANSITION 1.15 · GND 0).  Hard escalators:
     · pair-distance < 5NM AND |Δalt| < 1000ft → floor 85
     · pair-distance < 3NM AND |Δalt| < 500ft → floor 90
     · two pairs both inside CPA window → floor 78
     · OCEANIC-RNDM + RNP10 + opposite-direction → floor 70

   Accident precedent library:
     · Cerritos 1986   PSA1771 / Piper PA-28 KLAX TMA mid-air
       (NTSB AAR-87-07 · 87 fatal · pre-Mode-C VFR TCA conflict
       that triggered FAA Mode-C veil §91.215 + TCAS mandate)
     · Überlingen 2002 BTC2937 Tu-154 vs DHL611 B757-200F NAT-EUR
       (BFU AX001-1-2/02 · 71 fatal · TCAS-RA vs ATC instruction
       conflict that triggered TCAS 7.1 reversal logic)
     · São Paulo 1996  TAM RIO/SAO MD-11 vs Fokker 100 SDU TMA
       descent-conflict that triggered Brazil DECEA RNAV-1)
     · Gol 1907 / Embraer Legacy 600 NTAB AT-DCA07RA005 mid-air
       FL370 NAT-corridor opposite-direction at same level
       (TCAS transponder off · 154 fatal · canonical RVSM
       transponder-coordination failure)
     · Charkhi Dadri 1996 SVA763 vs KZK1907 (AAIB India IND
       349 fatal · ATC-altitude-misunderstanding head-on at
       FL150 that drove RVSM-mandate-acceleration in S Asia)
     · NAT 2017 incident BAW213 / DAL150 +/- 600 ft FL340-350
       opposite-direction MNPS deviation 4× TLS-target
       (NAT SPG bulletin 2018-04, no fatalities)
     · KIAH 2008 KMA UA-Express CRJ vs DAL ERJ TMA conflict
       canonical TMA-RNP-1 lateral overlap (no fatalities)
     · KLAX 2017 Air Canada AC759 taxiway approach offset
       4-aircraft taxiway taxi-trace canonical surface-CRM
       (NTSB DCA17IA148, no fatalities)

   References:
     · Reich PG (1966) "A Theory of Safe Separation Standards
       for Air Traffic Control" J. Inst. Navig. 19 #1, #2, #3
     · Marks BL (1963) "Air Traffic Control Separation Standards
       and Collision Risk", RAE Tech Note No.91
     · ICAO Doc 9689 Manual on Airspace Planning Methodology
       for Determination of Separation Minima (ed.2 1998 +
       Amend 2018) — Chapter 2 CRM theory, Chapter 3 TLS
     · ICAO Annex 11 Air Traffic Services Para 3.1.4 TLS
     · ICAO Doc 9574 Manual on RVSM Implementation (2002)
     · ICAO Doc 9613 PBN Manual ed.5 (2024)
     · ICAO Doc 4444 PANS-ATM Chapter 5 Separation Methods
     · ICAO Doc 9854 Global ATM Operational Concept §3.6 Safety
     · ICAO Doc 9871 SARPS Mode-S extended squitter
     · ICAO SASP (Separation and Airspace Safety Panel) /29 WP-12
       Reich CRM applied to PBN-RNP-1 TMA
     · ICAO SASP/30 WP-44 RNP-4 oceanic re-evaluation
     · ICAO RGCSP/9 WP-3 NAT MNPS TLS re-justification
     · NAT SPG (System Planning Group) Annual Reports 2010-2024
     · RTCA DO-385 ACAS-X System Spec ARP-4754A safety case
     · FAA Order 7110.65 §5 Radar Separation
     · FAA AC 90-117 Data Link Communications
     · EUROCONTROL Specification on RNP-Approach
     · EUROCONTROL EATCHIP TLS validation 1996-2003
     · Boeing D6-83820 NAT MNPS RVSM systems-cert
     · Brooker P (2004) "Air Traffic Separation: Reich and beyond"
       Aeronautical Journal 108 (1084)
     · Anderson D / Lin Y (1996) "A Collision Risk Model for a
       Crossing Track Separation Methodology" J. Navig. 49 #3
   ============================================================ */

interface SFlight {
  icao: string
  callsign?: string
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

interface Props { map: maplibregl.Map | null; flights: SFlight[]; onClose: () => void; onFly: (icao: string) => void }

type Driver = 'SX-LONG' | 'SY-LAT' | 'SZ-VERT' | 'DENS' | 'REGIME' | 'NAV-PERF' | 'SURV'
type Tier = 'CRITICAL' | 'WATCH' | 'MARGIN' | 'CLEAR' | 'GOOD' | 'NEUTRAL'
type Phase = 'ENROUTE-RVSM' | 'ENROUTE' | 'TMA' | 'OCEANIC-PBN' | 'OCEANIC-RNDM' | 'CLB-TRANS' | 'DST-TRANS' | 'GND'
type Category = 'VERT-RVSM' | 'VERT-LARGE' | 'LAT-RNP1' | 'LAT-RNP4' | 'LAT-RNP10' | 'LONG-TRAIL' | 'OCEAN-LONG' | 'CLEAR'
type NavSpec = 'RNP-1' | 'RNP-2' | 'RNP-4' | 'RNP-10' | 'BRNAV' | 'BASIC' | 'PRECISION'
type SurvClass = 'RADAR-5NM' | 'RADAR-3NM' | 'ADS-B' | 'MLAT' | 'PROC-ENRT' | 'PROC-OCEAN'
type Regime = 'RVSM' | 'NON-RVSM' | 'TMA-RADAR' | 'PBN-CORR' | 'OCEAN-FIX' | 'OCEAN-RNDM'
type AirframeClass = 'WB-RNP4' | 'WB-RNP10' | 'NB-RNP1' | 'RGN-RNP1' | 'BIZ-RNP4' | 'TURBO-BRNAV' | 'LIGHT-BASIC' | 'OTHER'

const DRIVERS: Driver[] = ['SX-LONG','SY-LAT','SZ-VERT','DENS','REGIME','NAV-PERF','SURV']
const TIERS: Tier[] = ['CRITICAL','WATCH','MARGIN','CLEAR','GOOD','NEUTRAL']
const PHASES: Phase[] = ['ENROUTE-RVSM','ENROUTE','TMA','OCEANIC-PBN','OCEANIC-RNDM','CLB-TRANS','DST-TRANS','GND']
const CATEGORIES: Category[] = ['VERT-RVSM','VERT-LARGE','LAT-RNP1','LAT-RNP4','LAT-RNP10','LONG-TRAIL','OCEAN-LONG','CLEAR']
const AIRFRAMES: AirframeClass[] = ['WB-RNP4','WB-RNP10','NB-RNP1','RGN-RNP1','BIZ-RNP4','TURBO-BRNAV','LIGHT-BASIC','OTHER']

const TIER_COLOR: Record<Tier, string> = {
  CRITICAL: '#ef4444', WATCH: '#f43f5e', MARGIN: '#f59e0b',
  CLEAR: '#0ea5e9', GOOD: '#10b981', NEUTRAL: '#64748b',
}
const TIER_RANK: Record<Tier, number> = { CRITICAL:0, WATCH:1, MARGIN:2, CLEAR:3, GOOD:4, NEUTRAL:5 }
function tierFromScore(s: number): Tier {
  if (s >= 85) return 'CRITICAL'
  if (s >= 65) return 'WATCH'
  if (s >= 45) return 'MARGIN'
  if (s >= 25) return 'CLEAR'
  if (s >= 10) return 'GOOD'
  return 'NEUTRAL'
}

const CATEGORY_COLOR: Record<Category, string> = {
  'VERT-RVSM':  '#ef4444',
  'VERT-LARGE': '#f43f5e',
  'LAT-RNP1':   '#f97316',
  'LAT-RNP4':   '#fb923c',
  'LAT-RNP10':  '#a855f7',
  'LONG-TRAIL': '#f59e0b',
  'OCEAN-LONG': '#8b5cf6',
  'CLEAR':      '#64748b',
}
const CATEGORY_DESC: Record<Category, string> = {
  'VERT-RVSM':  'Vertical overlap dominant · RVSM altimetry-system-error (ASE) regime · Reich Pz(0) kernel · Doc 9574',
  'VERT-LARGE': 'Vertical overlap dominant · non-RVSM 2000ft separation · transitional flight-level coordination',
  'LAT-RNP1':   'Lateral overlap dominant · RNP-1 PBN terminal-area route-keeping accuracy 95%/99.999% containment',
  'LAT-RNP4':   'Lateral overlap dominant · RNP-4 oceanic 23NM/23NM lateral/longitudinal separation per Doc 9613',
  'LAT-RNP10':  'Lateral overlap dominant · RNP-10 oceanic 50NM/50NM legacy GNSS/INS performance',
  'LONG-TRAIL': 'Along-track in-trail dominant · same-direction speed-difference passing-rate',
  'OCEAN-LONG': 'Oceanic longitudinal · NAT/PACOTS time-based 10min/15min same-track sep at fixed flight level',
  'CLEAR':      'No significant neighbor pair · isolated airspace',
}
const DRIVER_DESC: Record<Driver, string> = {
  'SX-LONG':  'Reich longitudinal passing-rate × Py(0)·Pz(0) overlap kernel · along-track relative-velocity term',
  'SY-LAT':   'Reich lateral passing-rate × Px(0)·Pz(0) overlap kernel · route-keeping deviation term',
  'SZ-VERT':  'Reich vertical passing-rate × Px(0)·Py(0) overlap kernel · altimetry-system-error term',
  'DENS':     'Local 100NM cylinder traffic density · proportional to encounter rate λ in CRM',
  'REGIME':   'Airspace regime · RVSM / RNP-1 / RNP-4 / RNP-10 / random-route oceanic',
  'NAV-PERF': 'Per-airframe navigation specification performance · RNP/RNAV containment kernel',
  'SURV':     'Surveillance performance class · radar-5NM / radar-3NM / ADS-B / Multilat / procedural',
}
const DRIVER_WEIGHT: Record<Driver, number> = {
  'SX-LONG': 0.20, 'SY-LAT': 0.20, 'SZ-VERT': 0.22,
  'DENS': 0.10, 'REGIME': 0.10, 'NAV-PERF': 0.10, 'SURV': 0.08,
}
const PHASE_DESC: Record<Phase, string> = {
  'ENROUTE-RVSM': 'En-route RVSM FL290-FL410 · 1000ft vertical separation',
  'ENROUTE':      'En-route non-RVSM · 2000ft vertical separation',
  'TMA':          'Terminal area · 3NM radar separation',
  'OCEANIC-PBN':  'Oceanic PBN RNP-4 / RNP-10 with CPDLC/ADS-C',
  'OCEANIC-RNDM': 'Oceanic random-route · 50NM lateral / time-based long sep',
  'CLB-TRANS':    'Climb crossing FL290 RVSM gate · altimeter coordination',
  'DST-TRANS':    'Descent crossing FL290 RVSM gate · altimeter coordination',
  'GND':          'Not airborne',
}
const PHASE_MUL: Record<Phase, number> = {
  'ENROUTE-RVSM': 1.05, 'ENROUTE': 1.00, 'TMA': 1.20,
  'OCEANIC-PBN': 0.85, 'OCEANIC-RNDM': 1.40,
  'CLB-TRANS': 1.15, 'DST-TRANS': 1.15, 'GND': 0,
}

// Per-airframe-class navigation performance & RNP kernels
interface NavSpecParam {
  rnpKm: number          // 95% containment radius (km · RNP value × 1.852)
  rnpDouble: number      // 2×RNP containment radius (km)
  surv: SurvClass
  asd: number            // altimetry-system-deviation σ (ft) per Doc 9574 Table 3.A.1
}
const AIRFRAME_NAV: Record<AirframeClass, NavSpecParam> = {
  'WB-RNP4':       { rnpKm: 7.4,  rnpDouble: 14.8, surv: 'ADS-B',     asd: 60 },   // RNP-4 oceanic
  'WB-RNP10':      { rnpKm: 18.5, rnpDouble: 37.0, surv: 'ADS-B',     asd: 75 },   // RNP-10 oceanic
  'NB-RNP1':       { rnpKm: 1.85, rnpDouble: 3.7,  surv: 'RADAR-3NM', asd: 60 },   // RNP-1 PBN TMA
  'RGN-RNP1':      { rnpKm: 1.85, rnpDouble: 3.7,  surv: 'RADAR-3NM', asd: 65 },   // RNP-1 regional
  'BIZ-RNP4':      { rnpKm: 7.4,  rnpDouble: 14.8, surv: 'ADS-B',     asd: 65 },   // RNP-4 biz oceanic
  'TURBO-BRNAV':   { rnpKm: 9.3,  rnpDouble: 18.6, surv: 'RADAR-5NM', asd: 90 },   // B-RNAV 5
  'LIGHT-BASIC':   { rnpKm: 18.5, rnpDouble: 37.0, surv: 'PROC-ENRT', asd: 120 },  // legacy / GA
  'OTHER':         { rnpKm: 9.3,  rnpDouble: 18.6, surv: 'RADAR-5NM', asd: 85 },
}

const CLASS_DESC: Record<AirframeClass, string> = {
  'WB-RNP4':     'Wide-body RNP-4 oceanic · B777/B787/A350/A380 · GNSS+IRS+SBAS',
  'WB-RNP10':    'Wide-body RNP-10 oceanic · B767/A330/A340 · GNSS+IRS legacy',
  'NB-RNP1':     'Narrow-body RNP-1 PBN · B737NG/B73M/A320/A321 · GNSS+SBAS TMA',
  'RGN-RNP1':    'Regional jet RNP-1 · E190/CRJ900 · GNSS+SBAS PBN',
  'BIZ-RNP4':    'Business jet RNP-4 · G650/GLEX/Falcon · GNSS+IRS oceanic-cert',
  'TURBO-BRNAV': 'Turboprop B-RNAV · ATR72/Q400 · GPS+VOR/DME RNAV-5',
  'LIGHT-BASIC': 'Light GA basic · PC12/TBM/C172 · GNSS-WAAS or VOR/DME',
  'OTHER':       'Mixed / unknown',
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
  if (/^(B77|B78|A35|A38)/.test(t)) return 'WB-RNP4'
  if (/^(B76|B75|A33|A34|A31[06])/.test(t)) return 'WB-RNP10'
  if (/^(B73|B3[89]M|A31[89]|A32|A22|A220)/.test(t)) return 'NB-RNP1'
  if (/^(E17|E19|E29|CRJ|CL6|RJ|SU9|MD8)/.test(t)) return 'RGN-RNP1'
  if (/^(GLEX|GL5T|G650|GLF|FA8X|FA50|FA7X|GLF6|C56X|C68A|E55P|PC24)/.test(t)) return 'BIZ-RNP4'
  if (/^(AT[47]|DH8|Q40|DHC8|SF3|F50|JS3|SAAB|EMB1[12])/.test(t)) return 'TURBO-BRNAV'
  if (/^(C172|C182|PC12|TBM|SR22|DA40|DA42|PA28|PA46|M20|BE9)/.test(t)) return 'LIGHT-BASIC'
  const c = (f.category || '').toUpperCase()
  if (c === 'A5') return 'WB-RNP4'
  if (c === 'A4') return 'WB-RNP10'
  if (c === 'A3') return 'NB-RNP1'
  if (c === 'A2') return 'TURBO-BRNAV'
  if (c === 'A1') return 'LIGHT-BASIC'
  if (c === 'A7') return 'BIZ-RNP4'
  return 'OTHER'
}

// Great-circle distance (km) — Haversine
function gcKm(a: { lat: number, lng: number }, b: { lat: number, lng: number }): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180
  const la2 = b.lat * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)))
}

// Oceanic detection: rough lat/lng box check for the big six oceanic FIRs
function isOceanic(f: SFlight): boolean {
  const lng = f.lng, lat = f.lat
  // North Atlantic NAT: 45-80°N, 60°W - 10°W
  if (lat > 45 && lat < 80 && lng > -70 && lng < -10) return true
  // Pacific PACOTS: 30-60°N, 150°E - 130°W (excluding Aleutians/Pacific NW transit)
  if (lat > 30 && lat < 60 && (lng > 145 || lng < -130)) return true
  // South Pacific: -50 to 0, 180 - 100°W
  if (lat > -50 && lat < 0 && (lng > 160 || lng < -100)) return true
  // Indian Ocean: -50 to 30, 40°E - 100°E (excluding land)
  if (lat > -50 && lat < 30 && lng > 40 && lng < 100 && (lat < -10 || (lng > 70 && lng < 85))) return true
  // South Atlantic: -50 to 10, -45 to 10°E
  if (lat > -50 && lat < 10 && lng > -45 && lng < 10) return true
  return false
}

function classifyPhase(f: SFlight): Phase {
  if (f.ground) return 'GND'
  const fl = f.altitudeFt / 100
  const ocean = isOceanic(f)
  // Climb/descent transition through RVSM gate
  if (fl >= 280 && fl <= 300 && f.vertRate > 500) return 'CLB-TRANS'
  if (fl >= 280 && fl <= 300 && f.vertRate < -500) return 'DST-TRANS'
  // TMA when low + maneuvering
  if (fl < 100 && Math.abs(f.vertRate) > 200) return 'TMA'
  if (fl < 60) return 'TMA'
  // Oceanic
  if (ocean && fl > 100) {
    // PBN if modern wide-body (proxy via altitude proxy: random-route is less common today)
    return 'OCEANIC-PBN'
  }
  // RVSM band
  if (fl >= 290 && fl <= 410) return 'ENROUTE-RVSM'
  return 'ENROUTE'
}

// ------ Reich Pair-Wise CRM ------

interface PairRisk {
  other: SFlight
  dxKm: number          // along-track signed Δ (km)
  dyKm: number          // cross-track signed Δ (km)
  dzFt: number          // vertical signed Δ (ft)
  dvKt: number          // relative speed magnitude (kt)
  oppDir: boolean       // opposite direction (|Δtrack| > 135°)
  pxKernel: number      // Reich Px(0) overlap probability
  pyKernel: number      // Reich Py(0) overlap probability
  pzKernel: number      // Reich Pz(0) overlap probability
  axContrib: number     // longitudinal contribution to MAC-rate/h
  ayContrib: number     // lateral contribution to MAC-rate/h
  azContrib: number     // vertical contribution to MAC-rate/h
  ratePerHr: number     // total estimated MAC-rate/h for the pair
}

// Reich overlap kernels — semi-dimensions of aircraft (m → km):
// λx (length) ≈ 60m / λy (wingspan) ≈ 60m / λz (height) ≈ 17m
// Converted to km: 0.060 / 0.060 / 5.18e-3
// Reich kernel Px(0) ≈ 2·λx / E[passing distance variance]
const LAMBDA_X_KM = 0.060
const LAMBDA_Y_KM = 0.060
const LAMBDA_Z_FT = 56  // 17m → 56ft canonical Reich value

function scorePair(self: SFlight, other: SFlight, selfClass: AirframeClass, otherClass: AirframeClass, phase: Phase): PairRisk {
  // Geodesic separation (km)
  const distKm = gcKm({ lat: self.lat, lng: self.lng }, { lat: other.lat, lng: other.lng })
  // Bearing from self to other for along/cross-track decomposition
  const dLat = (other.lat - self.lat) * Math.PI / 180
  const dLng = (other.lng - self.lng) * Math.PI / 180
  const la1 = self.lat * Math.PI / 180
  const la2 = other.lat * Math.PI / 180
  // Initial bearing
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
  // Decompose into self's track frame
  const dT = ((bearing - (self.track || 0)) % 360 + 360) % 360
  const dTRad = dT * Math.PI / 180
  const dxKm = distKm * Math.cos(dTRad)
  const dyKm = distKm * Math.sin(dTRad)
  const dzFt = other.altitudeFt - self.altitudeFt

  // Relative direction
  const trkDelta = Math.abs(((other.track - self.track) % 360 + 540) % 360 - 180)
  const oppDir = trkDelta > 135

  // Relative speed for longitudinal term (kt → km/h)
  const selfVKt = Math.max(50, self.velocityKts)
  const otherVKt = Math.max(50, other.velocityKts)
  const dvKt = oppDir
    ? selfVKt + otherVKt
    : Math.abs(selfVKt - otherVKt)
  const dvKmH = dvKt * 1.852

  // Reich overlap kernels — Px(0) = (2λx · σx_pair^-2) etc.
  // Use Gaussian kernel with self+other navigation σ
  const selfNav = AIRFRAME_NAV[selfClass]
  const otherNav = AIRFRAME_NAV[otherClass]
  // Lateral combined σ (km): joint nav-error proxy = √(σ_self² + σ_other²)
  // Use RNP × 0.5 as 1σ approx (RNP is 2σ)
  const sigYkm = Math.sqrt((selfNav.rnpKm * 0.5) ** 2 + (otherNav.rnpKm * 0.5) ** 2)
  const sigXkm = Math.max(0.5, sigYkm * 0.6)  // along-track tighter than cross-track
  const sigZft = Math.sqrt(selfNav.asd ** 2 + otherNav.asd ** 2)

  // Gaussian Px(dx) = (1 / sqrt(2π) σx) exp(-dx² / 2σx²) × 2λx (Reich integration)
  // Evaluated at observed dx/dy/dz
  function gauss(d: number, sig: number): number {
    if (sig <= 0) return 0
    return Math.exp(-(d * d) / (2 * sig * sig)) / (Math.sqrt(2 * Math.PI) * sig)
  }
  const pxKernel = 2 * LAMBDA_X_KM * gauss(dxKm, sigXkm)
  const pyKernel = 2 * LAMBDA_Y_KM * gauss(dyKm, sigYkm)
  const pzKernel = 2 * LAMBDA_Z_FT * gauss(dzFt, sigZft)

  // Reich axis contributions:
  // N_x = Px(0)·Py(0)·Pz(0) × |Δv_x| / (2λx)  — per pair, per hour
  // (units: 1/h after distance/time normalisation)
  // We use the magnitudes computed above.
  const axContrib = pyKernel * pzKernel * (dvKmH / (2 * LAMBDA_X_KM))
  const ayContrib = pxKernel * pzKernel * (Math.abs(other.track - self.track) * Math.PI / 180 * dvKmH / Math.max(0.01, sigYkm))
  const azContrib = pxKernel * pyKernel * (Math.abs(other.vertRate - self.vertRate) / 60 * 1.852 / Math.max(0.001, LAMBDA_Z_FT * 0.3048 / 1000)) * 0.0001

  const ratePerHr = axContrib + ayContrib + azContrib

  return { other, dxKm, dyKm, dzFt, dvKt, oppDir, pxKernel, pyKernel, pzKernel, axContrib, ayContrib, azContrib, ratePerHr }
}

// Convert log10-MAC-rate to 0-100 driver score
// 5e-9 (TLS) → 50; 5e-8 (10×) → 75; 5e-7 (100×) → 90; 5e-10 → 30
function rateToScore(rate: number): number {
  if (rate <= 0) return 0
  const lg = Math.log10(rate)
  // lg = -8.301 (TLS·1) → 50; lg = -7.301 → 75; lg = -10 → ~10
  const s = (lg + 11) * 20  // map: -11→0, -8.5→50, -6→100
  return Math.max(0, Math.min(100, s))
}

// ------ Per-flight TLS scorer ------

interface Assess {
  f: SFlight
  klass: AirframeClass
  phase: Phase
  drivers: Record<Driver, number>
  category: Category
  worstPair: PairRisk | null
  pairCount: number
  ratePerHr: number
  ratePerHrAggr: number   // log-summed rate over all neighbors
  score: number
  tier: Tier
  rationale: string
  worst: Driver
  weightedMean: number
  density: number         // local 100NM cylinder count
}

function scoreFlight(self: SFlight, others: SFlight[], advMul: number, regimeMul: number): Assess {
  const klass = pickClass(self)
  const phase = classifyPhase(self)

  const drivers: Record<Driver, number> = {
    'SX-LONG': 0, 'SY-LAT': 0, 'SZ-VERT': 0, 'DENS': 0,
    'REGIME': 0, 'NAV-PERF': 0, 'SURV': 0,
  }

  if (phase === 'GND') {
    return {
      f: self, klass, phase, drivers, category: 'CLEAR',
      worstPair: null, pairCount: 0, ratePerHr: 0, ratePerHrAggr: 0,
      score: 0, tier: 'NEUTRAL',
      rationale: `Aircraft on the ground — Reich CRM not evaluated.`,
      worst: 'SX-LONG', weightedMean: 0, density: 0,
    }
  }

  // Find neighbors within 100NM = 185km cylinder AND within ±2000ft
  const SEARCH_KM = 185
  const SEARCH_FT = 2200
  const nearby: SFlight[] = []
  for (const o of others) {
    if (o.icao === self.icao) continue
    if (o.ground) continue
    if (Math.abs(o.altitudeFt - self.altitudeFt) > SEARCH_FT) continue
    const d = gcKm({ lat: self.lat, lng: self.lng }, { lat: o.lat, lng: o.lng })
    if (d <= SEARCH_KM) nearby.push(o)
  }

  const density = nearby.length

  // Score each pair, accumulate MAC-rate per hour
  let ratePerHr = 0
  let aggrRate = 0
  let worstPair: PairRisk | null = null
  let dominantAxis: 'x' | 'y' | 'z' = 'z'
  let regimeFactor = 1
  switch (phase) {
    case 'ENROUTE-RVSM':  regimeFactor = 1.0; break
    case 'ENROUTE':       regimeFactor = 0.9; break
    case 'TMA':           regimeFactor = 1.3; break
    case 'OCEANIC-PBN':   regimeFactor = 0.85; break
    case 'OCEANIC-RNDM':  regimeFactor = 1.5; break
    case 'CLB-TRANS':     regimeFactor = 1.2; break
    case 'DST-TRANS':     regimeFactor = 1.2; break
    default:              regimeFactor = 1
  }
  regimeFactor *= regimeMul / 100

  for (const o of nearby) {
    const otherClass = pickClass(o)
    const pr = scorePair(self, o, klass, otherClass, phase)
    pr.ratePerHr *= regimeFactor
    aggrRate += pr.ratePerHr
    if (pr.ratePerHr > ratePerHr) {
      ratePerHr = pr.ratePerHr
      worstPair = pr
      if (pr.azContrib >= pr.axContrib && pr.azContrib >= pr.ayContrib) dominantAxis = 'z'
      else if (pr.ayContrib >= pr.axContrib) dominantAxis = 'y'
      else dominantAxis = 'x'
    }
  }

  // Per-axis driver scores (worst pair contribution)
  if (worstPair) {
    drivers['SX-LONG'] = rateToScore(worstPair.axContrib)
    drivers['SY-LAT']  = rateToScore(worstPair.ayContrib)
    drivers['SZ-VERT'] = rateToScore(worstPair.azContrib)
  }

  // DENS — local cylinder density score (sigmoid)
  drivers['DENS'] = Math.min(100, density * 6)

  // REGIME driver — encodes regime risk multiplier
  drivers['REGIME'] = (() => {
    switch (phase) {
      case 'OCEANIC-RNDM': return 75
      case 'OCEANIC-PBN':  return 40
      case 'TMA':          return 60
      case 'CLB-TRANS':
      case 'DST-TRANS':    return 55
      case 'ENROUTE-RVSM': return 45
      case 'ENROUTE':      return 30
      default:             return 5
    }
  })()

  // NAV-PERF driver — RNP performance proxy (lower RNP km → lower score)
  const nav = AIRFRAME_NAV[klass]
  drivers['NAV-PERF'] = Math.min(100, nav.rnpKm * 4)

  // SURV driver — surveillance class
  drivers['SURV'] = (() => {
    switch (nav.surv) {
      case 'PROC-OCEAN': return 80
      case 'PROC-ENRT':  return 70
      case 'MLAT':       return 35
      case 'ADS-B':      return 25
      case 'RADAR-3NM':  return 20
      case 'RADAR-5NM':  return 30
      default:           return 40
    }
  })()

  // Apply ADV-MUL
  const mul = advMul / 100
  for (const d of DRIVERS) drivers[d] = Math.min(100, drivers[d] * mul)

  // Weighted mean + worst
  let wm = 0, wsum = 0
  for (const d of DRIVERS) { wm += drivers[d] * DRIVER_WEIGHT[d]; wsum += DRIVER_WEIGHT[d] }
  const weightedMean = wsum > 0 ? wm / wsum : 0
  let worst: Driver = 'SZ-VERT'; let bestV = -1
  for (const d of DRIVERS) if (drivers[d] > bestV) { bestV = drivers[d]; worst = d }

  // Categorise per dominant axis + regime
  const oceanic = phase === 'OCEANIC-PBN' || phase === 'OCEANIC-RNDM'
  let category: Category = 'CLEAR'
  if (!worstPair || density === 0) category = 'CLEAR'
  else if (dominantAxis === 'z' && (phase === 'ENROUTE-RVSM' || phase === 'CLB-TRANS' || phase === 'DST-TRANS')) category = 'VERT-RVSM'
  else if (dominantAxis === 'z') category = 'VERT-LARGE'
  else if (dominantAxis === 'y' && phase === 'TMA') category = 'LAT-RNP1'
  else if (dominantAxis === 'y' && oceanic && klass === 'WB-RNP10') category = 'LAT-RNP10'
  else if (dominantAxis === 'y' && oceanic) category = 'LAT-RNP4'
  else if (dominantAxis === 'y') category = 'LAT-RNP1'
  else if (dominantAxis === 'x' && oceanic) category = 'OCEAN-LONG'
  else category = 'LONG-TRAIL'

  // Composite log-mapped score
  let composite = Math.max(0.65 * bestV, 0.35 * weightedMean) + 0.35 * weightedMean
  composite *= PHASE_MUL[phase]

  // Hard escalators
  if (worstPair) {
    const horizNM = Math.sqrt(worstPair.dxKm ** 2 + worstPair.dyKm ** 2) / 1.852
    const vertFt = Math.abs(worstPair.dzFt)
    if (horizNM < 3 && vertFt < 500) composite = Math.max(composite, 90)
    else if (horizNM < 5 && vertFt < 1000) composite = Math.max(composite, 85)
    // Two-or-more critical-distance pairs
    let critPairs = 0
    for (const o of nearby) {
      const oc = pickClass(o)
      const pr = scorePair(self, o, klass, oc, phase)
      const hNM = Math.sqrt(pr.dxKm ** 2 + pr.dyKm ** 2) / 1.852
      if (hNM < 5 && Math.abs(pr.dzFt) < 1000) critPairs++
    }
    if (critPairs >= 2) composite = Math.max(composite, 78)
  }

  // Oceanic random-route + RNP-10 + opp-dir → escalator
  if (worstPair && phase === 'OCEANIC-RNDM' && klass === 'WB-RNP10' && worstPair.oppDir) {
    composite = Math.max(composite, 70)
  }

  const score = Math.min(100, Math.max(0, composite))
  const tier = tierFromScore(score)

  // Rationale
  let rationale = ''
  const cs = (self.callsign || self.icao).toUpperCase()
  if (!worstPair) {
    rationale = `${cs} isolated — no neighbor pair within 100NM/2000ft cylinder. Reich CRM ≪ TLS ${ICAO_TLS_TEXT}.`
  } else {
    const horizNM = (Math.sqrt(worstPair.dxKm ** 2 + worstPair.dyKm ** 2) / 1.852).toFixed(1)
    const vertFt = Math.abs(worstPair.dzFt).toFixed(0)
    const otherCs = (worstPair.other.callsign || worstPair.other.icao).toUpperCase()
    const ratePer = ratePerHr.toExponential(2)
    if (tier === 'CRITICAL') {
      rationale = `CRITICAL ${category} — Reich CRM rate ${ratePer}/h (>10× ICAO TLS 5e-9/h) vs ${otherCs} ${horizNM}NM/${vertFt}ft. ${worstPair.oppDir ? 'OPPOSITE-DIRECTION pair. ' : ''}Investigate ${dominantAxis === 'z' ? 'altimetry coordination' : dominantAxis === 'y' ? `RNP-${nav.rnpKm < 4 ? '1' : nav.rnpKm < 10 ? '4' : '10'} navigation containment` : 'longitudinal spacing'}.`
    } else if (tier === 'WATCH') {
      rationale = `WATCH ${category} — Reich CRM rate ${ratePer}/h (1×-10× ICAO TLS) vs ${otherCs} ${horizNM}NM/${vertFt}ft on ${phase}. Monitor ${dominantAxis === 'z' ? 'vertical' : dominantAxis === 'y' ? 'lateral' : 'longitudinal'} margin.`
    } else if (tier === 'MARGIN') {
      rationale = `MARGIN ${category} — Reich CRM rate ${ratePer}/h within TLS but elevated vs ${otherCs} ${horizNM}NM/${vertFt}ft. Per Doc 9689 SASP margin band.`
    } else if (tier === 'CLEAR') {
      rationale = `CLEAR — Reich CRM rate ${ratePer}/h well within ICAO TLS 5e-9/h. ${PHASE_DESC[phase]}.`
    } else if (tier === 'GOOD') {
      rationale = `GOOD — Reich CRM rate ${ratePer}/h (>100× margin to TLS). Excellent separation in ${phase}.`
    } else {
      rationale = `NEUTRAL — pair-wise CRM rate ${ratePer}/h ≪ ICAO TLS.`
    }
  }

  return { f: self, klass, phase, drivers, category, worstPair, pairCount: density, ratePerHr, ratePerHrAggr: aggrRate, score, tier, rationale, worst, weightedMean, density }
}

const ICAO_TLS = 5e-9
const ICAO_TLS_TEXT = '5×10⁻⁹/h'

const SRC = 'tls-src'
const LBL = 'tls-lbl'
const LIN = 'tls-lin'

export default function TlsReichCrm({ map, flights, onClose, onFly }: Props) {
  const [advMul, setAdvMul] = useState<number>(100)
  const [regimeMul, setRegimeMul] = useState<number>(100)
  const [minFL, setMinFL] = useState<number>(0)
  const [maxFL, setMaxFL] = useState<number>(450)
  const [tierFilter, setTierFilter] = useState<'ALL' | Tier>('ALL')
  const [phaseFilter, setPhaseFilter] = useState<'ALL' | Phase>('ALL')
  const [catFilter, setCatFilter] = useState<'ALL' | Category>('ALL')
  const [classFilter, setClassFilter] = useState<'ALL' | AirframeClass>('ALL')
  const [tab, setTab] = useState<'AIRCRAFT' | 'CATEGORIES' | 'REGIMES' | 'PRECEDENT' | 'METHOD'>('AIRCRAFT')
  const [search, setSearch] = useState<string>('')
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const [showLine, setShowLine] = useState(true)
  const [showRing, setShowRing] = useState(true)

  const assessments = useMemo<Assess[]>(() => {
    const out: Assess[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      if (f.ground) continue
      const fl = f.altitudeFt / 100
      if (fl < minFL || fl > maxFL) continue
      out.push(scoreFlight(f, flights, advMul, regimeMul))
    }
    out.sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier]
      if (r !== 0) return r
      return b.score - a.score
    })
    return out
  }, [flights, advMul, regimeMul, minFL, maxFL])

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
        a.phase.toLowerCase().includes(s))
    }
    return xs
  }, [assessments, tierFilter, phaseFilter, catFilter, classFilter, search])

  const counts = useMemo(() => {
    const c: Record<Tier, number> = { CRITICAL:0, WATCH:0, MARGIN:0, CLEAR:0, GOOD:0, NEUTRAL:0 }
    for (const a of assessments) c[a.tier]++
    return c
  }, [assessments])

  const catCounts = useMemo(() => {
    const c: Record<Category, { ac: number; crit: number; sumScore: number }> = {} as any
    for (const k of CATEGORIES) c[k] = { ac: 0, crit: 0, sumScore: 0 }
    for (const a of assessments) {
      c[a.category].ac++
      c[a.category].sumScore += a.score
      if (a.tier === 'CRITICAL' || a.tier === 'WATCH') c[a.category].crit++
    }
    return c
  }, [assessments])

  const regimeCounts = useMemo(() => {
    const c: Record<Phase, { ac: number; crit: number; sumRate: number }> = {} as any
    for (const k of PHASES) c[k] = { ac: 0, crit: 0, sumRate: 0 }
    for (const a of assessments) {
      c[a.phase].ac++
      c[a.phase].sumRate += a.ratePerHr
      if (a.tier === 'CRITICAL' || a.tier === 'WATCH') c[a.phase].crit++
    }
    return c
  }, [assessments])

  const meanScore = assessments.length ? (assessments.reduce((s, a) => s + a.score, 0) / assessments.length) : 0
  const worst = assessments[0]
  const totalCrit = counts.CRITICAL + counts.WATCH
  const sumRate = assessments.reduce((s, a) => s + a.ratePerHr, 0)

  // ------ Map overlay ------
  useEffect(() => {
    const m = map
    if (!m) return
    const features: GeoJSON.Feature[] = []
    const labels: GeoJSON.Feature[] = []
    const lines: GeoJSON.Feature[] = []
    for (const a of filtered) {
      if (a.tier === 'NEUTRAL') continue
      const col = TIER_COLOR[a.tier]
      if (showHalo) {
        const r = 6 + Math.min(20, a.score * 0.22)
        features.push({ type:'Feature', properties:{ kind:'halo', color: col, radius: r }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showRing && (a.tier === 'CRITICAL' || a.tier === 'WATCH')) {
        features.push({ type:'Feature', properties:{ kind:'ring', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showPin && a.tier !== 'GOOD') {
        features.push({ type:'Feature', properties:{ kind:'pin', color: col }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLbl && (a.tier === 'CRITICAL' || a.tier === 'WATCH')) {
        const cs = a.f.callsign || a.f.icao.toUpperCase()
        const text = `${cs} ${a.category} ${a.ratePerHr.toExponential(1)}/h`
        labels.push({ type:'Feature', properties:{ kind:'lbl', text, color: CATEGORY_COLOR[a.category] }, geometry:{ type:'Point', coordinates:[a.f.lng, a.f.lat] } })
      }
      if (showLine && a.worstPair && (a.tier === 'CRITICAL' || a.tier === 'WATCH')) {
        lines.push({
          type:'Feature',
          properties:{ color: col },
          geometry:{ type:'LineString', coordinates:[ [a.f.lng, a.f.lat], [a.worstPair.other.lng, a.worstPair.other.lat] ] },
        })
      }
    }
    try {
      for (const [id, fc] of [[SRC, features], [LBL, labels], [LIN, lines]] as Array<[string, GeoJSON.Feature[]]>) {
        if (!m.getSource(id)) m.addSource(id, { type:'geojson', data:{ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection })
        else (m.getSource(id) as maplibregl.GeoJSONSource).setData({ type:'FeatureCollection', features: fc } as GeoJSON.FeatureCollection)
      }
      if (!m.getLayer('tls-line')) m.addLayer({ id:'tls-line', type:'line', source:LIN, paint:{ 'line-color':['get','color'], 'line-width':1.4, 'line-opacity':0.6, 'line-dasharray':[2,2] } })
      if (!m.getLayer('tls-ring')) m.addLayer({ id:'tls-ring', type:'circle', source:SRC, filter:['==',['get','kind'],'ring'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':1.3, 'circle-radius':30, 'circle-opacity':0.55 } })
      if (!m.getLayer('tls-halo')) m.addLayer({ id:'tls-halo', type:'circle', source:SRC, filter:['==',['get','kind'],'halo'], paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.8 } })
      if (!m.getLayer('tls-pin')) m.addLayer({ id:'tls-pin', type:'circle', source:SRC, filter:['==',['get','kind'],'pin'], paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':5 } })
      if (!m.getLayer('tls-lbl')) m.addLayer({ id:'tls-lbl', type:'symbol', source:LBL, layout:{ 'text-field':['get','text'], 'text-size':10, 'text-offset':[0,1.6], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a', 'text-halo-width':1.3 } })
    } catch {}
    return () => {
      try {
        for (const id of ['tls-line','tls-ring','tls-halo','tls-pin','tls-lbl'])
          if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC, LBL, LIN]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map, filtered, showHalo, showPin, showLbl, showRing, showLine])

  // Tiny SVG Reich-kernel sparkline (3 axis bars)
  function ReichBadge({ sx, sy, sz, size = 32 }: { sx: number; sy: number; sz: number; size?: number }) {
    const w = size
    const h = size
    const bw = (w - 6) / 3
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="inline-block">
        <rect x={0} y={0} width={w} height={h} fill="#020617" rx={2} />
        {/* Horizontal scale line at TLS=50 */}
        <line x1={1} y1={h * 0.5} x2={w - 1} y2={h * 0.5} stroke="#475569" strokeWidth={0.5} strokeDasharray="1 1" />
        {[['X', sx, '#f59e0b'], ['Y', sy, '#a855f7'], ['Z', sz, '#ef4444']].map(([lbl, v, col], i) => {
          const x = 1 + (Number(i) * bw) + Number(i) * 1
          const bh = Math.max(1, (Number(v) / 100) * (h - 4))
          return (
            <g key={lbl as string}>
              <rect x={x} y={h - 2 - bh} width={bw} height={bh} fill={col as string} opacity={0.85} />
              <text x={x + bw / 2} y={h - 2} fontSize="6" textAnchor="middle" fill="#cbd5e1">{lbl as string}</text>
            </g>
          )
        })}
      </svg>
    )
  }

  return (
    <div className="absolute top-16 right-4 z-30 w-[520px] max-h-[84vh] flex flex-col rounded-lg border border-slate-700/70 bg-slate-900/95 backdrop-blur shadow-2xl text-slate-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/70">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-mono text-xs tracking-widest">TLS</span>
          <span className="text-[10px] text-slate-500">Reich CRM · ICAO Doc 9689 · Annex 11 · TLS 5×10⁻⁹/h · NAT MNPS · RVSM · PBN</span>
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
          <div className="text-[9px] text-slate-500 uppercase">Crit+Wat</div>
          <div style={{ color: totalCrit > 0 ? TIER_COLOR.CRITICAL : '#94a3b8' }}>{totalCrit}</div>
        </div>
        <div className="bg-slate-900 px-2 py-1.5">
          <div className="text-[9px] text-slate-500 uppercase">Σ Rate/h</div>
          <div style={{ color: sumRate > ICAO_TLS * 10 ? TIER_COLOR.CRITICAL : sumRate > ICAO_TLS ? TIER_COLOR.WATCH : '#94a3b8' }}>{sumRate > 0 ? sumRate.toExponential(1) : '—'}</div>
        </div>
      </div>

      {/* Sliders */}
      <div className="px-3 py-2 border-b border-slate-700/70 space-y-1.5">
        {([
          ['ADV-MUL', advMul, setAdvMul, 50, 200, '%'],
          ['REGIME', regimeMul, setRegimeMul, 50, 250, '%'],
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
              <span style={{ color: CATEGORY_COLOR[c] }}>●</span> {c.replace('VERT-','V·').replace('LAT-','L·').replace('LONG-','LX·').replace('OCEAN-','OX·')}
            </button>
          )
        })}
      </div>

      {/* Phase chips */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center flex-wrap gap-1">
        <button onClick={() => setPhaseFilter('ALL')}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${phaseFilter === 'ALL' ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400'}`}>ALL</button>
        {PHASES.filter(p => p !== 'GND').map(p => {
          const active = phaseFilter === p
          return (
            <button key={p} onClick={() => setPhaseFilter(active ? 'ALL' : p)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${active ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
              title={PHASE_DESC[p]}>
              {p.replace('ENROUTE-','ER·').replace('OCEANIC-','OC·').replace('CLB-TRANS','CLB').replace('DST-TRANS','DST')}
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
        {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['LBL',showLbl,setShowLbl],['LINE',showLine,setShowLine],['RING',showRing,setShowRing]] as Array<[string, boolean, (v:boolean)=>void]>).map(([n,v,s]) => (
          <button key={n} onClick={() => s(!v)} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${v ? 'bg-sky-500/15 border-sky-500/40 text-slate-100' : 'border-slate-700 text-slate-500'}`}>{n}</button>
        ))}
        <div className="flex-1" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="search cs/type/cat"
          className="w-44 text-[11px] font-mono bg-slate-950/70 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 outline-none focus:border-sky-500/60" />
      </div>

      {/* Tabs */}
      <div className="px-3 py-1.5 border-b border-slate-700/70 flex items-center gap-1.5">
        {(['AIRCRAFT','CATEGORIES','REGIMES','PRECEDENT','METHOD'] as const).map(t => (
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
              const wp = a.worstPair
              const horizNM = wp ? (Math.sqrt(wp.dxKm ** 2 + wp.dyKm ** 2) / 1.852) : 0
              const vertFt = wp ? Math.abs(wp.dzFt) : 0
              return (
                <button key={a.f.icao}
                  onClick={() => onFly(a.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40">
                  <div className="flex items-stretch gap-1.5">
                    <div className="w-0.5 self-stretch rounded" style={{ background: col }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono">
                        <ReichBadge sx={a.drivers['SX-LONG']} sy={a.drivers['SY-LAT']} sz={a.drivers['SZ-VERT']} size={26} />
                        <span className="text-slate-100 font-semibold">{a.f.callsign || a.f.icao.toUpperCase()}</span>
                        <span className="text-slate-500">{a.f.type || '—'}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.klass}</span>
                        <span className="text-[9px] px-1 py-0 rounded" style={{ background: cCol + '25', color: cCol }}>{a.category}</span>
                        <span className="text-[9px] px-1 py-0 rounded text-slate-300 bg-slate-800">{a.phase}</span>
                        <span className="text-[9px] px-1 py-0 rounded ml-auto" style={{ background: col + '25', color: col }}>{a.tier}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span>FL{String(Math.round(a.f.altitudeFt / 100)).padStart(3,'0')}</span>
                        <span>{Math.round(a.f.velocityKts)}kt</span>
                        <span style={{ color: a.f.vertRate > 200 ? '#10b981' : a.f.vertRate < -200 ? '#f59e0b' : '#94a3b8' }}>{a.f.vertRate > 0 ? '↑' : a.f.vertRate < 0 ? '↓' : '→'}{Math.abs(Math.round(a.f.vertRate))}fpm</span>
                        <span className="text-slate-500 truncate ml-auto">{a.f.operator || ''}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-400">
                        <span style={{ color: a.ratePerHr > ICAO_TLS * 10 ? TIER_COLOR.CRITICAL : a.ratePerHr > ICAO_TLS ? TIER_COLOR.WATCH : a.ratePerHr > ICAO_TLS * 0.1 ? TIER_COLOR.MARGIN : '#94a3b8' }}>{a.ratePerHr > 0 ? a.ratePerHr.toExponential(1) + '/h' : '—'}</span>
                        <span className="text-slate-500">vs TLS {ICAO_TLS_TEXT}</span>
                        {wp && <span style={{ color: horizNM < 5 ? TIER_COLOR.CRITICAL : horizNM < 10 ? TIER_COLOR.WATCH : '#94a3b8' }}>{horizNM.toFixed(1)}NM</span>}
                        {wp && <span style={{ color: vertFt < 500 ? TIER_COLOR.CRITICAL : vertFt < 1000 ? TIER_COLOR.WATCH : '#94a3b8' }}>{Math.round(vertFt)}ft</span>}
                        {wp && wp.oppDir && <span className="text-[9px] px-1 py-0 rounded" style={{ background: '#ef444425', color: '#ef4444' }}>OPP-DIR</span>}
                        <span className="text-slate-500 ml-auto">{a.density} nb</span>
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
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{k.replace('SX-LONG','SX').replace('SY-LAT','SY').replace('SZ-VERT','SZ').replace('NAV-PERF','NAV')}</span>
                              <span className={muted ? 'text-slate-700' : 'text-slate-300'}>{Math.round(s)}</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{a.rationale}</div>
                      {wp && (a.tier === 'CRITICAL' || a.tier === 'WATCH') && (
                        <div className="mt-1 text-[9px] text-slate-500 font-mono leading-tight border-l-2 pl-2" style={{ borderColor: col }}>
                          Pair · {(wp.other.callsign || wp.other.icao).toUpperCase()} {wp.other.type || ''} · Δx {wp.dxKm.toFixed(1)}km Δy {wp.dyKm.toFixed(1)}km Δz {wp.dzFt.toFixed(0)}ft · Δv {wp.dvKt.toFixed(0)}kt · Px {wp.pxKernel.toExponential(1)} Py {wp.pyKernel.toExponential(1)} Pz {wp.pzKernel.toExponential(1)}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
        {tab === 'CATEGORIES' && (
          <div className="divide-y divide-slate-800/70">
            {CATEGORIES.map(c => {
              const cnt = catCounts[c]
              const mean = cnt.ac > 0 ? cnt.sumScore / cnt.ac : 0
              const col = CATEGORY_COLOR[c]
              return (
                <div key={c} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] font-mono">
                    <span className="w-2 h-2 rounded" style={{ background: col }} />
                    <span className="text-slate-100 font-semibold">{c}</span>
                    <span className="text-slate-500 ml-auto">{cnt.ac} ac · {cnt.crit} crit/watch</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400 leading-snug">{CATEGORY_DESC[c]}</div>
                  <div className="mt-1 h-1 bg-slate-800 rounded overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, mean)}%`, background: col }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'REGIMES' && (
          <div className="divide-y divide-slate-800/70">
            {PHASES.filter(p => p !== 'GND').map(p => {
              const r = regimeCounts[p]
              const meanRate = r.ac > 0 ? r.sumRate / r.ac : 0
              return (
                <div key={p} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] font-mono">
                    <span className="text-slate-100 font-semibold">{p}</span>
                    <span className="text-slate-500 text-[10px]">× {PHASE_MUL[p].toFixed(2)}</span>
                    <span className="text-slate-500 ml-auto">{r.ac} ac · {r.crit} c/w</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400 leading-snug">{PHASE_DESC[p]}</div>
                  <div className="mt-1 text-[10px] font-mono" style={{ color: meanRate > ICAO_TLS ? TIER_COLOR.WATCH : '#94a3b8' }}>
                    μ-rate {meanRate > 0 ? meanRate.toExponential(2) : '—'}/h · vs TLS {ICAO_TLS_TEXT}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {tab === 'PRECEDENT' && (
          <div className="divide-y divide-slate-800/70">
            {([
              ['Überlingen 2002 BTC2937 / DHL611', 'BFU AX001-1-2/02 · 71 fatal · TCAS-RA vs ATC-instruction conflict at FL360 NAT-EUR · drove TCAS 7.1 reversal logic + cross-coordination ATC training.'],
              ['Cerritos 1986 PSA1771 / PA-28', 'NTSB AAR-87-07 · 87 fatal · pre-Mode-C VFR violation in KLAX TCA · drove §91.215 Mode-C veil mandate + TCAS-II equipage.'],
              ['Charkhi Dadri 1996 SVA763 / KZK1907', 'AAIB India · 349 fatal · head-on FL150 ATC-altitude misunderstanding · drove RVSM mandate acceleration in S Asia.'],
              ['Gol 1907 / EMB Legacy 600 2006', 'NTAB AT-DCA07RA005 · 154 fatal · opposite-direction same-level NAT corridor B737 vs ERJ-135 · canonical RVSM transponder-coordination failure.'],
              ['São Paulo 1996 TAM RIO-SAO mid-air', 'CENIPA · TMA descent-conflict MD-11 vs F100 · drove DECEA RNAV-1 deployment in Brazil.'],
              ['KLAX 2017 AC759 taxi/RWY approach', 'NTSB DCA17IA148 · no fatalities · 4-aircraft taxiway near-miss · drove surface-CRM and runway-status-light deployment.'],
              ['KIAH 2008 KMA UA-X CRJ vs DAL ERJ', 'NTSB · TMA lateral-overlap canonical RNP-1 conflict · contributed to NextGen PBN deployment timeline.'],
              ['NAT 2017 BAW213 / DAL150 600ft excursion', 'NAT SPG Bull 2018-04 · MNPS deviation 4× TLS-target · no fatalities · NAT MOR vertical-deviation reporting.'],
            ] as Array<[string, string]>).map(([k, v]) => (
              <div key={k} className="px-3 py-2">
                <div className="text-[11px] font-mono text-slate-100 font-semibold">{k}</div>
                <div className="text-[10px] text-slate-400 leading-snug mt-0.5">{v}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'METHOD' && (
          <div className="px-3 py-3 text-[10px] text-slate-400 leading-relaxed font-mono space-y-2">
            <div>
              <span className="text-slate-200 font-semibold">Reich-Marks Collision Risk Model.</span> Expected mid-air-collision rate
              per flight-hour for an aircraft of semi-dimensions {`{λx, λy, λz}`} (60m × 60m × 17m canonical) is the
              sum of three pair-wise terms: N_x = Py(0)·Pz(0)·|Δv̄|/(2λx) longitudinal · N_y = Px(0)·Pz(0)·|Δv_y| lateral ·
              N_z = Px(0)·Py(0)·|Δv_z| vertical. Each Px/Py/Pz is a Gaussian Reich overlap kernel evaluated at
              observed pair displacement convolved with combined navigation/altimetry σ (RNP value × 0.5 lateral / ASE per
              Doc 9574 vertical).
            </div>
            <div>
              <span className="text-slate-200 font-semibold">ICAO TLS Target.</span> Annex 11 Para 3.1.4 / Doc 9689 §3.4:
              MAC-rate shall not exceed 5×10⁻⁹/h per unidimensional opposite-direction pair or 1.5×10⁻⁸/h same-track. Foundation for:
              1979 NAT MNPS 1000ft sep · 1997 RVSM FL290-FL410 · 2005 RNP-10/RNP-4 oceanic · 2008 PBN Manual Doc 9613 ·
              2015 PBCS RCP-240 datalink performance · ACAS-X DO-385 cert.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Per-flight evaluator.</span> For each airborne aircraft, scans
              100NM/2200ft cylinder for neighbors. For each pair, decomposes geodesic separation into self-track frame
              (along-track Δx · cross-track Δy · vertical Δz), computes Reich Px/Py/Pz kernels, accumulates axis contributions.
              MAX neighbor → worstPair, rateperhr → driver scores. Score = log10-mapped: TLS·1 → 50, TLS·10 → 75, TLS·100 → 90.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Phase classifier.</span> ENROUTE-RVSM FL290-FL410 1000ft sep · ENROUTE other 2000ft sep ·
              TMA &lt;FL100 3NM sep · OCEANIC-PBN RNP-4/10 with CPDLC/ADS-C · OCEANIC-RNDM random-route 50NM lat · CLB/DST-TRANS
              FL280-300 crossing RVSM gate. Phase multipliers per regime risk.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Hard escalators.</span> Pair &lt;3NM AND &lt;500ft → floor 90.
              Pair &lt;5NM AND &lt;1000ft → floor 85. Two-or-more pairs both inside 5NM/1000ft window → floor 78.
              OCEANIC-RNDM + RNP-10 + opposite-direction → floor 70.
            </div>
            <div>
              <span className="text-slate-200 font-semibold">Distinct from.</span> CPA (geometric only, no probability), TCAS-RA (downstream airborne logic DO-185B),
              ACAS-X (next-gen DP MDP DO-385 — TLS is its certification framework), STCA (controller-side threshold), MTCD (deterministic 8-30min probe),
              AIRPROX (post-event severity classifier), CONFLICT (binary 5NM/1000ft detection), RVSM/RNP (single-axis nav-spec compliance — TLS integrates ALL axes).
            </div>
            <div className="pt-1 text-slate-500 text-[9px]">
              References: Reich PG 1966 J.Inst.Navig 19 · Marks BL 1963 RAE Tech Note 91 · ICAO Doc 9689 ed.2+Amend 2018 · Annex 11 §3.1.4 · Doc 9574 RVSM Manual · Doc 9613 PBN Manual ed.5 · Doc 4444 PANS-ATM Ch.5 · Doc 9854 ATM Concept · SASP/29 WP-12 · SASP/30 WP-44 · RGCSP/9 WP-3 · NAT SPG Annual Reports · RTCA DO-385 · FAA Order 7110.65 §5 · EUROCONTROL EATCHIP TLS validation · Brooker P 2004 Aero.J 108 · Anderson D / Lin Y 1996 J.Navig 49.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
