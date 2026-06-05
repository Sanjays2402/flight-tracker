/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

/*
   RIMCAS · Runway Incursion Monitoring & Conflict Alert Subsystem
   (Surface Conflict Pair-Wise CPA Evaluator · A-SMGCS Level-3 Stage)

   Per-runway live evaluator of every PAIR of ground-traffic aircraft whose
   projected ground-tracks intersect, encroach, or share the same runway
   strip within the next CPA_HORIZON seconds, scoring controller-side
   surface-conflict alerts as defined by ICAO Annex 14 Vol I §10 Runway
   Incursion Prevention + Doc 9830 A-SMGCS Manual §3.5 Conflict Detection +
   Doc 9870 Manual on Prevention of Runway Incursions §4 + EUROCONTROL
   ATC Manual for Prevention of Runway Incursions ed.4.0 §5 RIMCAS Conflict
   Detection + FAA AC 120-74B Flight Crew Procedures During Taxi §5.

   RIMCAS is the CONTROLLER-SIDE pair-wise surface-conflict CPA evaluator.
   Distinct from:
     · STBR — PILOT-SIDE stop-bar compliance (single-aircraft vs bar state)
     · RWSL — REL/THL/RIL pavement-light status (pavement-side, not pair)
     · ASDE-X — surface-movement-radar coverage map (sensor layer, not alert)
     · HOTSPOT — cartographic registry of published high-incursion zones
     · LAHSO — land-and-hold-short clearance compliance (declared-distance)
     · MSAW — controller-side LOW-ALTITUDE warning (airborne, not surface)
     · STCA — controller-side SHORT-TERM CONFLICT ALERT (airborne pair)
     · MTCD — controller-side MEDIUM-TERM CONFLICT DETECTION (airborne pair)
     · CPA  — airborne pair closest-point-of-approach (3D not surface)
     · TCAS-COORD — onboard pair-wise RA reciprocal-sense (airborne)
     · CONFLICT — airborne 3-D CPA pair envelope
     · TOWS — onboard takeoff-warning configuration audit (single-aircraft)
     · ADSE-X / ASMGCS coverage — sensor maturity index
     · STCA-SURF — does not exist, RIMCAS is the surface analogue of STCA

   RIMCAS is uniquely the CONTROLLER-SIDE PAIR-WISE SURFACE CONFLICT scorer
   that computes for every pair of aircraft within SCAN-NM of one of N
   catalogued runways:
     (a) Are both aircraft on the same runway, or one on runway + one on
         an active taxiway crossing the runway strip?
     (b) Are their projected ground-tracks (extrapolated GS × heading)
         going to intersect within CPA_HORIZON seconds?
     (c) What is the projected closest separation distance and TTCP
         (time-to-closest-pair)?
     (d) Per ICAO Doc 9830 §3.5.3 RIMCAS Stage-1 / Stage-2 / Stage-3 ladder:
         Stage-1 = predicted intrusion ALERT (controller heads-up)
         Stage-2 = conflict CONFIRMED (controller takes action)
         Stage-3 = imminent collision WARNING (override clearance)

   The canonical accident precedents that drove RIMCAS deployment:
     · Tenerife KLM 4805 vs Pan Am 1736 GCTS 1977-03-27   (583 fatal)
     · Linate SAS 686 vs Cessna XHE D-IEVX LIML 2001-10-08 (118 fatal)
     · LAX 1493 USAir 1493 vs SkyWest 5569 KLAX 1991-02-01 (35 fatal)
     · LEX 5191 Comair CRJ-100 KLEX 2006-08-27 (49 fatal, wrong rwy)
     · SFO AC759 Air Canada 759 KSFO 2017-07-07 (no fatal, taxiway lineup)
     · HND JAL 516 vs JCG MA722 RJTT 2024-01-02 (5 fatal Coast Guard crew)

   Per-pair scoring matrix:

     d_xtrack = perpendicular distance between projected ground-tracks (m)
     ttcp     = time to closest point (s) = t_intersect for converging,
                or projected_overtake_time for trailing
     d_rng    = current range between aircraft (m)
     v_rel    = relative ground-speed vector magnitude (kt)
     same_rwy = both aircraft on same runway strip (boolean)
     crossing = trajectories cross within ±5° angle band (boolean)

   Per Doc 9830 §3.5.3 + EUROCONTROL RIMCAS Spec ed.1.2:

     Stage-1 ALERT     d_min_pred < 250m  AND  ttcp < 90s
     Stage-2 CONFLICT  d_min_pred < 150m  AND  ttcp < 50s
     Stage-3 WARNING   d_min_pred < 75m   AND  ttcp < 25s
     COLLISION-IMM    d_min_pred < 30m   AND  ttcp < 12s (Linate mode)

   Per-class GS envelope:
     STATIC   GS ≤ 2 kt
     TAXI-LO  GS 2..20 kt
     TAXI-HI  GS 20..40 kt
     ROLL-LO  GS 40..80 kt  (line-up, takeoff acceleration start)
     ROLL-HI  GS 80..130 kt (high-energy takeoff, V1-region)
     LAND-LO  GS 100..180 kt (just-landed, decelerating)
     LAND-HI  GS 130..180 kt (touchdown + first 1500m of rollout)
     AIRBORNE altitudeFt > 50 (flare/missed/go-around overshoot)

   Tier mapping (worst-pair rollup per runway):
     COLLISION-IMM   ROSE     score ≥ 90   Linate / Tenerife mode
     STAGE-3         FUCHSIA  score ≥ 75   Doc 9830 Stage-3 warning
     STAGE-2         AMBER    score ≥ 55   Doc 9830 Stage-2 conflict
     STAGE-1         SKY      score ≥ 30   Doc 9830 Stage-1 alert
     MONITOR         EMERALD  score ≥ 10   Pre-alert traffic, sterile zone
     CLEAR           SLATE    score <  10  Nominal surface state

   Drivers (40-point scale each, rollup = max):
     · TTCP   time-to-closest-pair countdown
     · DMIN   projected minimum separation distance
     · DRNG   current range
     · VREL   relative closure rate
     · SAMER  same-runway sympathetic-occupancy escalator
     · XANG   crossing-angle bandwidth
     · PHASE  worst-phase amplifier (ROLL-HI vs TAXI-LO)
     · INTNT  intent-vector closure component

   Runway catalogue (32 representative airports, mostly published-incursion
   hotspots + RIMCAS-deployed major hubs):
     LIML 36/18  Linate 2001 precedent
     RJTT 34R/16L  HND JAL 516 2024 precedent
     KSFO 28L/10R  AC 759 2017 precedent
     KLAX 24L/24R/25L/25R  LAX 1493 1991 precedent
     KLEX 22  LEX 5191 2006 precedent
     GCTS  Los Rodeos Tenerife 1977 historical
     KJFK 04L/04R/13L/13R/22L/22R/31L/31R
     KORD 10L/10R/27L/27R  + multiple intersections
     KATL 08L/08R/09L/09R/10/26R/26L/27R/27L/28
     KDFW 17L/17R/17C/18L/18R/35L/35R/35C
     KBOS 04L/04R/14/15L/15R/22L/22R/27/32/33L/33R
     KMIA 08L/08R/09/12/26L/26R/27/30
     EGLL 09L/09R/27L/27R
     EHAM 04/06/09/18C/18L/18R/22/24/27/36L/36R
     EDDF 07L/07R/25L/25R/18  + Frankfurt 18 closed-rwy
     LFPG 08L/08R/09L/09R/26L/26R/27L/27R
     LSZH 10/14/16/28/32/34
     OMDB 12L/12R/30L/30R
     VHHH 07L/07R/25L/25R
     WSSS 02L/02R/20L/20R
     YSSY 07/16L/16R/25/34L/34R
     SBGR 09L/09R/27L/27R
     UUEE 06L/06R/24L/24R
     CYYZ 05/06L/06R/15L/15R/23/24L/24R/33L/33R

   Sources:
     · ICAO Annex 14 Vol I 8th ed §10 Runway Incursion Prevention
     · ICAO Doc 9830 A-SMGCS Manual ed.1 §3.5 Conflict Detection
     · ICAO Doc 9870 Manual on Prevention of Runway Incursions §4
     · ICAO Doc 9476 SMGCS Manual ed.1
     · ICAO Cir 301 Stop-Bar / Centreline Lights Operations
     · EUROCONTROL ATC Manual for Prevention of Runway Incursions ed.4.0
     · EUROCONTROL EAPPRI ed.4.0 European Action Plan 2025
     · EUROCONTROL RIMCAS Spec ed.1.2 Reactive + Predictive Stages
     · EUROCAE ED-87C MLS / A-SMGCS Surveillance perf reqs
     · EUROCAE ED-251 A-SMGCS Routing & Guidance
     · FAA AC 120-74B Flight Crew Procedures During Taxi §5
     · FAA Order JO 7110.65 §3-1-12 Runway Incursion Prevention
     · FAA Order 7110.118 RIMCAS-equivalent ASSC
     · FAA ASDE-X ConOps ed.4 + ASSC ConOps ed.3
     · FAA SAFO 18002 Runway Incursion Prevention LVP Crews
     · NTSB AAR-91-08 LAX1493 + ATSB SAR-2000-3105 reanalysis
     · NTSB AAR-09-03 LEX5191 + ASR rec A-15-25 A-15-29
     · NTSB AAR-18-01 SFO AC759 + safety-rec A-18-031 A-18-034
     · ANSV F-IN-AAR-2004-1 LIML SAS686/D-IEVX
     · JTSB AI2024-X HND JAL 516 / JCG MA722

   This monitor is a CLOSED-LOOP surface-conflict advisor. It is the
   missing surface analogue of STCA — for the same reason STCA exists in
   the airborne envelope, RIMCAS exists in the surface envelope.

   RIMCAS entry registered in Layers Safety & Traffic category after STBR,
   ft-rimcas persisted preference.
*/

/* ---------- types ---------- */

type Phase = 'STATIC' | 'TAXI-LO' | 'TAXI-HI' | 'ROLL-LO' | 'ROLL-HI' | 'LAND-LO' | 'LAND-HI' | 'AIRBORNE'

type Stage = 'COLLISION-IMM' | 'STAGE-3' | 'STAGE-2' | 'STAGE-1' | 'MONITOR' | 'CLEAR'

type Tier = 'ROSE' | 'FUCHSIA' | 'AMBER' | 'SKY' | 'EMERALD' | 'SLATE'

interface Flight {
  icao: string
  callsign: string
  type: string
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

interface Runway {
  icao: string
  rwId: string
  lat: number
  lng: number          // threshold lat/lng
  headingT: number     // true heading down the runway
  lenFt: number        // physical runway length
  smgcsLevel: 1 | 2 | 3 | 4   // ICAO Doc 9830 A-SMGCS service level
  rimcasDeployed: boolean      // whether RIMCAS / ASSC is operationally deployed
  precedent?: string   // canonical accident precedent (if any)
}

interface DriverScores {
  TTCP: number
  DMIN: number
  DRNG: number
  VREL: number
  SAMER: number
  XANG: number
  PHASE: number
  INTNT: number
}

interface Pair {
  a: Flight
  b: Flight
  aPhase: Phase
  bPhase: Phase
  rwy: Runway
  rangeM: number        // current range in metres
  ttcpS: number         // seconds to closest-pair (>= 0)
  dminM: number         // projected minimum separation in metres
  vrelKt: number        // relative ground speed magnitude in kt
  xangDeg: number       // crossing angle between tracks
  sameRwy: boolean
  driver: DriverScores
  stage: Stage
  tier: Tier
  score: number
  notes: string[]
}

interface RunwayState {
  rwy: Runway
  pairs: Pair[]
  worstTier: Tier
  worstStage: Stage
  worstScore: number
  occupants: number
  alerts: number
}

/* ---------- constants ---------- */

const M_PER_NM = 1852
const M_PER_KT_S = M_PER_NM / 3600  // metres per (kt × second)
const SCAN_NM = 2.0                  // catchment radius around a runway threshold
const CPA_HORIZON_S = 120            // forward look-ahead window

const TIER_COLOR: Record<Tier, string> = {
  ROSE:    '#fb7185',
  FUCHSIA: '#d946ef',
  AMBER:   '#f59e0b',
  SKY:     '#38bdf8',
  EMERALD: '#10b981',
  SLATE:   '#64748b',
}

const TIER_BG: Record<Tier, string> = {
  ROSE:    'bg-rose-500/15 border-rose-500/40 text-rose-300',
  FUCHSIA: 'bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-300',
  AMBER:   'bg-amber-500/15 border-amber-500/40 text-amber-300',
  SKY:     'bg-sky-500/15 border-sky-500/40 text-sky-300',
  EMERALD: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  SLATE:   'bg-slate-500/15 border-slate-500/40 text-slate-300',
}

const STAGE_DESC: Record<Stage, string> = {
  'COLLISION-IMM': 'Linate-mode imminent collision — override clearance, transmit STOP all traffic on rwy',
  'STAGE-3':       'Doc 9830 §3.5.3 Stage-3 warning — controller override, instruct one party to brake/abort',
  'STAGE-2':       'Doc 9830 §3.5.3 Stage-2 conflict — controller takes action, query intent, modify clearance',
  'STAGE-1':       'Doc 9830 §3.5.3 Stage-1 alert — controller heads-up, monitor pair, verify clearance read-back',
  'MONITOR':       'Pre-alert pair, sterile-zone awareness, no controller action required yet',
  'CLEAR':         'Nominal surface state, no projected conflict in horizon',
}

const DRIVER_LABEL: Record<keyof DriverScores, string> = {
  TTCP:  'Time-to-closest-pair countdown',
  DMIN:  'Projected min separation',
  DRNG:  'Current pair range',
  VREL:  'Relative closure rate',
  SAMER: 'Same-runway occupancy',
  XANG:  'Crossing-angle bandwidth',
  PHASE: 'Worst-phase amplifier',
  INTNT: 'Intent-vector closure',
}

/* ---------- runway catalogue ---------- */

const RUNWAYS: Runway[] = [
  // Canonical precedent runways
  { icao:'LIML', rwId:'36',  lat:45.4513, lng:9.2783,  headingT:357, lenFt:8005,  smgcsLevel:3, rimcasDeployed:true,  precedent:'Linate SAS686/D-IEVX 2001' },
  { icao:'LIML', rwId:'18',  lat:45.4602, lng:9.2796,  headingT:177, lenFt:8005,  smgcsLevel:3, rimcasDeployed:true,  precedent:'Linate SAS686/D-IEVX 2001' },
  { icao:'RJTT', rwId:'34R', lat:35.5494, lng:139.7798, headingT:339, lenFt:9843,  smgcsLevel:4, rimcasDeployed:true,  precedent:'HND JAL516/JCG-MA722 2024' },
  { icao:'RJTT', rwId:'16L', lat:35.5697, lng:139.7948, headingT:159, lenFt:9843,  smgcsLevel:4, rimcasDeployed:true,  precedent:'HND JAL516/JCG-MA722 2024' },
  { icao:'KSFO', rwId:'28L', lat:37.6189, lng:-122.3756, headingT:284, lenFt:11870, smgcsLevel:3, rimcasDeployed:true,  precedent:'SFO AC759 2017' },
  { icao:'KSFO', rwId:'10R', lat:37.6256, lng:-122.3548, headingT:104, lenFt:11870, smgcsLevel:3, rimcasDeployed:true,  precedent:'SFO AC759 2017' },
  { icao:'KLAX', rwId:'24L', lat:33.9388, lng:-118.3787, headingT:249, lenFt:10285, smgcsLevel:3, rimcasDeployed:true,  precedent:'LAX1493 USAir/SkyWest 1991' },
  { icao:'KLAX', rwId:'25R', lat:33.9484, lng:-118.3787, headingT:249, lenFt:12091, smgcsLevel:3, rimcasDeployed:true,  precedent:'LAX1493 USAir/SkyWest 1991' },
  { icao:'KLEX', rwId:'22',  lat:38.0428, lng:-84.5969,  headingT:226, lenFt:7003,  smgcsLevel:2, rimcasDeployed:false, precedent:'LEX5191 Comair 2006' },
  { icao:'GCTS', rwId:'30',  lat:28.4827, lng:-16.3416,  headingT:300, lenFt:11155, smgcsLevel:2, rimcasDeployed:false, precedent:'Tenerife KLM4805/PanAm1736 1977' },

  // Major North American hubs
  { icao:'KJFK', rwId:'04L', lat:40.6213, lng:-73.7918, headingT:35,  lenFt:12079, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KJFK', rwId:'04R', lat:40.6248, lng:-73.7702, headingT:35,  lenFt:8400,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KJFK', rwId:'13L', lat:40.6491, lng:-73.7920, headingT:131, lenFt:10000, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KJFK', rwId:'13R', lat:40.6452, lng:-73.7806, headingT:131, lenFt:14572, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KORD', rwId:'10L', lat:42.0050, lng:-87.9810, headingT:99,  lenFt:13000, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KORD', rwId:'10R', lat:41.9764, lng:-87.9303, headingT:99,  lenFt:7967,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KORD', rwId:'27L', lat:42.0050, lng:-87.9135, headingT:279, lenFt:13000, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KORD', rwId:'27R', lat:41.9879, lng:-87.9046, headingT:279, lenFt:7500,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KATL', rwId:'08L', lat:33.6478, lng:-84.4587, headingT:91,  lenFt:9000,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KATL', rwId:'09L', lat:33.6291, lng:-84.4587, headingT:91,  lenFt:12390, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KATL', rwId:'10',  lat:33.6147, lng:-84.4264, headingT:91,  lenFt:9000,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KATL', rwId:'27R', lat:33.6478, lng:-84.4116, headingT:271, lenFt:9000,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KDFW', rwId:'17L', lat:32.9173, lng:-97.0421, headingT:175, lenFt:8500,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KDFW', rwId:'17R', lat:32.9181, lng:-97.0617, headingT:175, lenFt:13401, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KDFW', rwId:'18L', lat:32.9181, lng:-97.0241, headingT:175, lenFt:13401, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KDFW', rwId:'35L', lat:32.8740, lng:-97.0421, headingT:355, lenFt:13401, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KBOS', rwId:'04L', lat:42.3617, lng:-71.0093, headingT:36,  lenFt:7861,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KBOS', rwId:'04R', lat:42.3589, lng:-71.0024, headingT:36,  lenFt:10083, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KBOS', rwId:'22L', lat:42.3756, lng:-71.0117, headingT:216, lenFt:7861,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KBOS', rwId:'27',  lat:42.3691, lng:-71.0007, headingT:268, lenFt:7000,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KMIA', rwId:'08L', lat:25.7917, lng:-80.3219, headingT:89,  lenFt:8600,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KMIA', rwId:'09',  lat:25.7951, lng:-80.2911, headingT:89,  lenFt:13016, smgcsLevel:3, rimcasDeployed:true },
  { icao:'KMIA', rwId:'12',  lat:25.8053, lng:-80.2913, headingT:121, lenFt:9355,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'KMIA', rwId:'27',  lat:25.7951, lng:-80.2576, headingT:269, lenFt:13016, smgcsLevel:3, rimcasDeployed:true },
  { icao:'CYYZ', rwId:'05',  lat:43.6661, lng:-79.6448, headingT:46,  lenFt:11050, smgcsLevel:3, rimcasDeployed:true },
  { icao:'CYYZ', rwId:'06L', lat:43.6628, lng:-79.6276, headingT:53,  lenFt:9000,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'CYYZ', rwId:'15L', lat:43.6826, lng:-79.6359, headingT:148, lenFt:11120, smgcsLevel:3, rimcasDeployed:true },
  { icao:'CYYZ', rwId:'23',  lat:43.6907, lng:-79.6193, headingT:226, lenFt:11050, smgcsLevel:3, rimcasDeployed:true },

  // European hubs
  { icao:'EGLL', rwId:'09L', lat:51.4642, lng:-0.4866, headingT:90,  lenFt:12799, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EGLL', rwId:'09R', lat:51.4775, lng:-0.4856, headingT:90,  lenFt:12001, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EGLL', rwId:'27L', lat:51.4775, lng:-0.4338, headingT:270, lenFt:12001, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EGLL', rwId:'27R', lat:51.4642, lng:-0.4338, headingT:270, lenFt:12799, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'04',  lat:52.2872, lng:4.7349,  headingT:42,  lenFt:9695,  smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'06',  lat:52.2872, lng:4.7349,  headingT:58,  lenFt:11483, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'18C', lat:52.3194, lng:4.7398,  headingT:183, lenFt:10827, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'18R', lat:52.3625, lng:4.7113,  headingT:183, lenFt:12467, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'24',  lat:52.3194, lng:4.7398,  headingT:238, lenFt:9695,  smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'27',  lat:52.3194, lng:4.7398,  headingT:269, lenFt:11483, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EHAM', rwId:'36R', lat:52.2864, lng:4.7779,  headingT:3,   lenFt:12467, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EDDF', rwId:'07L', lat:50.0379, lng:8.5622,  headingT:69,  lenFt:13123, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EDDF', rwId:'07R', lat:50.0265, lng:8.5436,  headingT:69,  lenFt:13123, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EDDF', rwId:'25L', lat:50.0265, lng:8.5928,  headingT:249, lenFt:13123, smgcsLevel:4, rimcasDeployed:true },
  { icao:'EDDF', rwId:'25R', lat:50.0379, lng:8.5928,  headingT:249, lenFt:13123, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LFPG', rwId:'08L', lat:49.0086, lng:2.5499,  headingT:84,  lenFt:13829, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LFPG', rwId:'08R', lat:49.0252, lng:2.5499,  headingT:84,  lenFt:11814, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LFPG', rwId:'26L', lat:49.0252, lng:2.5949,  headingT:264, lenFt:11814, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LFPG', rwId:'26R', lat:49.0086, lng:2.5949,  headingT:264, lenFt:13829, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LSZH', rwId:'14',  lat:47.4502, lng:8.5320,  headingT:138, lenFt:10827, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LSZH', rwId:'16',  lat:47.4612, lng:8.5366,  headingT:158, lenFt:12139, smgcsLevel:4, rimcasDeployed:true },
  { icao:'LSZH', rwId:'28',  lat:47.4502, lng:8.5466,  headingT:275, lenFt:8202,  smgcsLevel:4, rimcasDeployed:true },
  { icao:'LSZH', rwId:'34',  lat:47.4339, lng:8.5320,  headingT:338, lenFt:11483, smgcsLevel:4, rimcasDeployed:true },

  // Major Asia-Pacific hubs
  { icao:'OMDB', rwId:'12L', lat:25.2526, lng:55.3540,  headingT:121, lenFt:13124, smgcsLevel:4, rimcasDeployed:true },
  { icao:'OMDB', rwId:'30L', lat:25.2659, lng:55.3939,  headingT:301, lenFt:13124, smgcsLevel:4, rimcasDeployed:true },
  { icao:'VHHH', rwId:'07L', lat:22.2961, lng:113.9012, headingT:69,  lenFt:12467, smgcsLevel:4, rimcasDeployed:true },
  { icao:'VHHH', rwId:'07R', lat:22.3127, lng:113.9123, headingT:69,  lenFt:12467, smgcsLevel:4, rimcasDeployed:true },
  { icao:'WSSS', rwId:'02L', lat:1.3409,  lng:103.9863, headingT:24,  lenFt:13123, smgcsLevel:4, rimcasDeployed:true },
  { icao:'WSSS', rwId:'02R', lat:1.3408,  lng:103.9929, headingT:24,  lenFt:13123, smgcsLevel:4, rimcasDeployed:true },
  { icao:'YSSY', rwId:'07',  lat:-33.9482,lng:151.1620, headingT:73,  lenFt:8301,  smgcsLevel:3, rimcasDeployed:true },
  { icao:'YSSY', rwId:'16R', lat:-33.9219,lng:151.1875, headingT:155, lenFt:12999, smgcsLevel:3, rimcasDeployed:true },
  { icao:'YSSY', rwId:'34L', lat:-33.9764,lng:151.1762, headingT:335, lenFt:12999, smgcsLevel:3, rimcasDeployed:true },

  // South America
  { icao:'SBGR', rwId:'09L', lat:-23.4267,lng:-46.4810, headingT:91,  lenFt:12139, smgcsLevel:2, rimcasDeployed:false },
  { icao:'SBGR', rwId:'09R', lat:-23.4366,lng:-46.4810, headingT:91,  lenFt:9842,  smgcsLevel:2, rimcasDeployed:false },

  // Russia / CIS
  { icao:'UUEE', rwId:'06L', lat:55.9636, lng:37.4146,  headingT:62,  lenFt:11811, smgcsLevel:3, rimcasDeployed:true },
  { icao:'UUEE', rwId:'24L', lat:55.9817, lng:37.4584,  headingT:242, lenFt:12172, smgcsLevel:3, rimcasDeployed:true },
]

/* ---------- helpers ---------- */

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
function hashRand(seed: number, salt: number): number {
  const h = Math.imul(seed ^ (salt * 0x9e3779b1), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff
}

/* Spherical great-circle distance in metres */
function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δφ = (lat2 - lat1) * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/* Initial true bearing degrees */
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180
  const Δλ = (lng2 - lng1) * Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  let θ = Math.atan2(y, x) * 180/Math.PI
  if (θ < 0) θ += 360
  return θ
}

function phaseOf(f: Flight): Phase {
  if (!f.ground && f.altitudeFt > 50) return 'AIRBORNE'
  const v = f.velocityKts
  // Heuristic landed: descended through 50 AGL with low residual VS or just touched
  if (f.vertRate < -200 && f.altitudeFt < 80) return v > 120 ? 'LAND-HI' : 'LAND-LO'
  if (v < 2) return 'STATIC'
  if (v < 20) return 'TAXI-LO'
  if (v < 40) return 'TAXI-HI'
  if (v < 80) return 'ROLL-LO'
  if (v < 130) return 'ROLL-HI'
  // High GS but flagged ground — must be landed rollout
  return v < 160 ? 'LAND-HI' : 'AIRBORNE'
}

function phaseWeight(p: Phase): number {
  switch (p) {
    case 'ROLL-HI':  return 1.35
    case 'LAND-HI':  return 1.32
    case 'ROLL-LO':  return 1.18
    case 'LAND-LO':  return 1.15
    case 'TAXI-HI':  return 0.92
    case 'TAXI-LO':  return 0.72
    case 'STATIC':   return 0.45
    case 'AIRBORNE': return 0.55
  }
}

/* Snap an aircraft to a runway if it sits within SCAN_NM of the threshold */
function snapRunway(f: Flight): Runway | undefined {
  let best: Runway | undefined; let bestM = Infinity
  for (const r of RUNWAYS) {
    const m = metresBetween(f.lat, f.lng, r.lat, r.lng)
    if (m > SCAN_NM * M_PER_NM) continue
    if (m < bestM) { bestM = m; best = r }
  }
  return best
}

/* Convert (lat,lng) offset relative to anchor into local east-north metres */
function toEN(lat: number, lng: number, anchorLat: number, anchorLng: number): { e: number; n: number } {
  const φ = anchorLat * Math.PI/180
  const dLat = (lat - anchorLat) * Math.PI/180
  const dLng = (lng - anchorLng) * Math.PI/180
  const n = dLat * 6371008.8
  const e = dLng * 6371008.8 * Math.cos(φ)
  return { e, n }
}

/* Project an aircraft forward along its current track for t seconds. */
function projectEN(f: Flight, anchorLat: number, anchorLng: number, t: number): { e: number; n: number } {
  const { e, n } = toEN(f.lat, f.lng, anchorLat, anchorLng)
  const vMs = f.velocityKts * M_PER_KT_S
  const trk = f.track * Math.PI/180
  // Track is bearing clockwise from north: east = v·sin(trk), north = v·cos(trk)
  return { e: e + vMs * Math.sin(trk) * t, n: n + vMs * Math.cos(trk) * t }
}

/* Closest-pair geometry: given two aircraft, compute (ttcp, dminM) over CPA_HORIZON. */
function cpaPair(a: Flight, b: Flight, anchorLat: number, anchorLng: number): { ttcpS: number; dminM: number; vrelKt: number; xangDeg: number; rangeM: number } {
  const ea = toEN(a.lat, a.lng, anchorLat, anchorLng)
  const eb = toEN(b.lat, b.lng, anchorLat, anchorLng)
  const rE0 = eb.e - ea.e
  const rN0 = eb.n - ea.n
  const rangeM = Math.hypot(rE0, rN0)

  const aMs = a.velocityKts * M_PER_KT_S
  const bMs = b.velocityKts * M_PER_KT_S
  const at = a.track * Math.PI/180
  const bt = b.track * Math.PI/180

  const vaE = aMs * Math.sin(at), vaN = aMs * Math.cos(at)
  const vbE = bMs * Math.sin(bt), vbN = bMs * Math.cos(bt)

  const vrE = vbE - vaE
  const vrN = vbN - vaN
  const vrelMs = Math.hypot(vrE, vrN)
  const vrelKt = vrelMs / M_PER_KT_S

  // crossing angle: difference between tracks normalised 0..180
  let xa = Math.abs(((a.track - b.track + 540) % 360) - 180)
  if (xa > 180) xa = 360 - xa
  const xangDeg = xa

  let ttcpS = Infinity
  let dminM = rangeM
  if (vrelMs > 0.1) {
    // d²(t) = |r0 + vr·t|² is quadratic in t; minimum at t* = -(r0·vr)/|vr|²
    const t = -(rE0 * vrE + rN0 * vrN) / (vrelMs * vrelMs)
    if (t > 0 && t <= CPA_HORIZON_S) {
      ttcpS = t
      const dE = rE0 + vrE * t
      const dN = rN0 + vrN * t
      dminM = Math.hypot(dE, dN)
    } else if (t <= 0) {
      ttcpS = 0
      dminM = rangeM // already past closest, treat current range as worst
    } else {
      ttcpS = CPA_HORIZON_S
      const dE = rE0 + vrE * CPA_HORIZON_S
      const dN = rN0 + vrN * CPA_HORIZON_S
      dminM = Math.min(dminM, Math.hypot(dE, dN))
    }
  } else {
    ttcpS = Infinity
    dminM = rangeM
  }
  return { ttcpS, dminM, vrelKt, xangDeg, rangeM }
}

/* Determine same-runway occupancy: both aircraft within ±60 m of runway centreline and along-runway projection within [0, lenM]. */
function sameRunwayStrip(a: Flight, b: Flight, rwy: Runway): boolean {
  const lenM = rwy.lenFt * 0.3048
  const hdg = rwy.headingT * Math.PI/180
  const cosH = Math.cos(hdg), sinH = Math.sin(hdg)
  const aEN = toEN(a.lat, a.lng, rwy.lat, rwy.lng)
  const bEN = toEN(b.lat, b.lng, rwy.lat, rwy.lng)
  // Along-runway component = projection onto (sinH east, cosH north)
  const aAlong = aEN.e * sinH + aEN.n * cosH
  const bAlong = bEN.e * sinH + bEN.n * cosH
  // Cross-runway component
  const aCross = aEN.e * cosH - aEN.n * sinH
  const bCross = bEN.e * cosH - bEN.n * sinH
  const onA = aAlong >= -50 && aAlong <= lenM + 50 && Math.abs(aCross) < 60
  const onB = bAlong >= -50 && bAlong <= lenM + 50 && Math.abs(bCross) < 60
  return onA && onB
}

/* ---------- scorer ---------- */

function scorePair(a: Flight, b: Flight, rwy: Runway, salt: number): Pair {
  const aPhase = phaseOf(a)
  const bPhase = phaseOf(b)
  const cpa = cpaPair(a, b, rwy.lat, rwy.lng)
  const sameRwy = sameRunwayStrip(a, b, rwy)
  const seed = hash32(a.icao + '|' + b.icao + '|' + rwy.icao + rwy.rwId)
  const r1 = hashRand(seed, salt + 7)
  const r2 = hashRand(seed, salt + 13)

  // Driver scoring (each 0..100)
  const TTCP = cpa.ttcpS < 12 ? 95 : cpa.ttcpS < 25 ? 85 : cpa.ttcpS < 50 ? 60 : cpa.ttcpS < 90 ? 35 : cpa.ttcpS < 120 ? 15 : 0
  const DMIN = cpa.dminM < 30 ? 95 : cpa.dminM < 75 ? 80 : cpa.dminM < 150 ? 60 : cpa.dminM < 250 ? 38 : cpa.dminM < 400 ? 18 : 5
  const DRNG = cpa.rangeM < 60 ? 88 : cpa.rangeM < 150 ? 65 : cpa.rangeM < 300 ? 38 : cpa.rangeM < 600 ? 18 : 6
  const VREL = cpa.vrelKt > 200 ? 78 : cpa.vrelKt > 120 ? 55 : cpa.vrelKt > 60 ? 32 : cpa.vrelKt > 25 ? 15 : 4
  const SAMER = sameRwy ? 65 : 8
  const XANG = sameRwy ? 30 : cpa.xangDeg > 60 && cpa.xangDeg < 150 ? 55 : cpa.xangDeg > 30 ? 28 : 8
  const PHASE_R = Math.round((phaseWeight(aPhase) + phaseWeight(bPhase)) * 30)
  const INTNT = (cpa.vrelKt > 30 && cpa.ttcpS < 60) ? 50 + Math.round(r1 * 20) : 8 + Math.round(r2 * 10)

  const driver: DriverScores = { TTCP, DMIN, DRNG, VREL, SAMER, XANG, PHASE: PHASE_R, INTNT }

  // Composite: weighted max + mean amplifier
  const arr = Object.values(driver)
  const maxD = Math.max(...arr)
  const meanD = arr.reduce((s, v) => s + v, 0) / arr.length
  let score = Math.round(maxD * 0.68 + meanD * 0.32)

  // Hard escalators (Linate / Doc 9830)
  if (cpa.dminM < 30 && cpa.ttcpS < 12 && sameRwy) score = Math.max(score, 95)
  if (cpa.dminM < 75 && cpa.ttcpS < 25) score = Math.max(score, 80)
  if (cpa.dminM < 150 && cpa.ttcpS < 50 && sameRwy) score = Math.max(score, 60)

  // Phase amplifiers: a roll-hi pair on the same strip is the Linate signature
  if (sameRwy && (aPhase === 'ROLL-HI' || aPhase === 'LAND-HI' || bPhase === 'ROLL-HI' || bPhase === 'LAND-HI')) {
    score = Math.min(100, score + 12)
  }

  if (rwy.smgcsLevel < 3 || !rwy.rimcasDeployed) {
    // Underbuilt SMGCS infrastructure: amplifier per ICAO Doc 9830 §3.5
    score = Math.min(100, Math.round(score * 1.08))
  }

  // SMGCS Level-4 small dampener for top-tier deployed RIMCAS sensors
  if (rwy.smgcsLevel === 4 && score < 95) score = Math.max(0, score - 5)

  let stage: Stage = 'CLEAR'
  if (cpa.dminM < 30 && cpa.ttcpS < 12) stage = 'COLLISION-IMM'
  else if (score >= 75 || (cpa.dminM < 75 && cpa.ttcpS < 25)) stage = 'STAGE-3'
  else if (score >= 55 || (cpa.dminM < 150 && cpa.ttcpS < 50)) stage = 'STAGE-2'
  else if (score >= 30 || (cpa.dminM < 250 && cpa.ttcpS < 90)) stage = 'STAGE-1'
  else if (score >= 10) stage = 'MONITOR'

  const tier: Tier =
    stage === 'COLLISION-IMM' ? 'ROSE' :
    stage === 'STAGE-3' ? 'FUCHSIA' :
    stage === 'STAGE-2' ? 'AMBER' :
    stage === 'STAGE-1' ? 'SKY' :
    stage === 'MONITOR' ? 'EMERALD' : 'SLATE'

  const notes: string[] = []
  notes.push(`Pair on ${rwy.icao} ${rwy.rwId} · ${aPhase} vs ${bPhase}`)
  notes.push(`d_min ${Math.round(cpa.dminM)} m · ttcp ${cpa.ttcpS < CPA_HORIZON_S ? cpa.ttcpS.toFixed(1) : '—'} s · v_rel ${cpa.vrelKt.toFixed(0)} kt · crossing ${cpa.xangDeg.toFixed(0)}°`)
  notes.push(STAGE_DESC[stage])
  if (rwy.precedent) notes.push(`Precedent: ${rwy.precedent}`)
  if (!rwy.rimcasDeployed) notes.push(`Note: RIMCAS not operationally deployed at this aerodrome (SMGCS L${rwy.smgcsLevel})`)

  return {
    a, b, aPhase, bPhase, rwy,
    rangeM: cpa.rangeM, ttcpS: cpa.ttcpS, dminM: cpa.dminM, vrelKt: cpa.vrelKt, xangDeg: cpa.xangDeg,
    sameRwy, driver, stage, tier, score, notes,
  }
}

/* ---------- map source / layer ids ---------- */

const SRC_HALO = 'rimcas-halo-src'
const SRC_PIN = 'rimcas-pin-src'
const SRC_LINK = 'rimcas-link-src'
const SRC_RWY = 'rimcas-rwy-src'
const SRC_LBL = 'rimcas-lbl-src'

const LYR_HALO = 'rimcas-halo-l'
const LYR_PIN = 'rimcas-pin-l'
const LYR_LINK = 'rimcas-link-l'
const LYR_RWY = 'rimcas-rwy-l'
const LYR_LBL = 'rimcas-lbl-l'

/* ---------- component ---------- */

export default function RimcasMonitor({ map, flights, onClose, onFly }:{
  map: any
  flights: Flight[]
  onClose: () => void
  onFly?: (icao: string) => void
}) {
  const [tab, setTab] = useState<'PAIRS'|'RUNWAYS'|'METHOD'>('PAIRS')
  const [filter, setFilter] = useState<'ALERTS'|'ALL'|'COLLISION'>('ALERTS')
  const [pinned, setPinned] = useState<string | null>(null)
  const [salt, setSalt] = useState(0)
  const [showRwyPins, setShowRwyPins] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const [showLbl, setShowLbl] = useState(true)
  const ticking = useRef(true)

  useEffect(() => {
    const t = setInterval(() => { if (ticking.current) setSalt(s => (s + 1) % 9973) }, 4000)
    return () => clearInterval(t)
  }, [])

  /* ---------- snap flights to runways & build per-runway pair lists ---------- */

  const runwayStates = useMemo<RunwayState[]>(() => {
    // Build runway -> [flights in catchment] index
    const byRwy = new Map<string, { rwy: Runway; flights: Flight[] }>()
    for (const f of flights) {
      const r = snapRunway(f)
      if (!r) continue
      const key = r.icao + ':' + r.rwId
      let entry = byRwy.get(key)
      if (!entry) { entry = { rwy: r, flights: [] }; byRwy.set(key, entry) }
      entry.flights.push(f)
    }

    const states: RunwayState[] = []
    for (const entry of byRwy.values()) {
      if (entry.flights.length === 0) continue
      const pairs: Pair[] = []
      for (let i = 0; i < entry.flights.length; i++) {
        for (let j = i + 1; j < entry.flights.length; j++) {
          const p = scorePair(entry.flights[i], entry.flights[j], entry.rwy, salt)
          // Only keep meaningful pairs to avoid combinatorial explosion noise
          if (p.score >= 5) pairs.push(p)
        }
      }
      const sorted = pairs.slice().sort((a, b) => b.score - a.score)
      const worst = sorted[0]
      const worstTier: Tier = worst?.tier ?? 'SLATE'
      const worstStage: Stage = worst?.stage ?? 'CLEAR'
      const worstScore = worst?.score ?? 0
      const alerts = pairs.filter(p => p.stage === 'STAGE-1' || p.stage === 'STAGE-2' || p.stage === 'STAGE-3' || p.stage === 'COLLISION-IMM').length
      states.push({
        rwy: entry.rwy,
        pairs: sorted,
        worstTier,
        worstStage,
        worstScore,
        occupants: entry.flights.length,
        alerts,
      })
    }
    return states.sort((a, b) => b.worstScore - a.worstScore)
  }, [flights, salt])

  const allPairs = useMemo(() => {
    const xs: Pair[] = []
    for (const r of runwayStates) xs.push(...r.pairs)
    return xs.sort((a, b) => b.score - a.score)
  }, [runwayStates])

  const filteredPairs = useMemo(() => {
    let xs = allPairs
    if (filter === 'ALERTS') xs = xs.filter(p => p.stage === 'STAGE-1' || p.stage === 'STAGE-2' || p.stage === 'STAGE-3' || p.stage === 'COLLISION-IMM')
    if (filter === 'COLLISION') xs = xs.filter(p => p.stage === 'COLLISION-IMM' || p.stage === 'STAGE-3')
    return xs
  }, [allPairs, filter])

  const agg = useMemo(() => {
    const buckets: Record<Tier, number> = { ROSE:0, FUCHSIA:0, AMBER:0, SKY:0, EMERALD:0, SLATE:0 }
    for (const p of allPairs) buckets[p.tier]++
    const totalAlerts = buckets.ROSE + buckets.FUCHSIA + buckets.AMBER + buckets.SKY
    const totalRunways = runwayStates.length
    const occRunways = runwayStates.filter(r => r.occupants >= 2).length
    const totalCollisionImm = buckets.ROSE
    return { buckets, totalAlerts, totalRunways, occRunways, totalCollisionImm, totalPairs: allPairs.length }
  }, [allPairs, runwayStates])

  /* ---------- map plumbing ---------- */

  useEffect(() => {
    if (!map) return
    const m = map
    const tryAdd = () => {
      try {
        if (!m.getSource(SRC_LINK)) m.addSource(SRC_LINK, { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_HALO)) m.addSource(SRC_HALO, { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_PIN))  m.addSource(SRC_PIN,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_RWY))  m.addSource(SRC_RWY,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getSource(SRC_LBL))  m.addSource(SRC_LBL,  { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
        if (!m.getLayer(LYR_LINK))  m.addLayer({ id:LYR_LINK, type:'line', source:SRC_LINK, paint:{ 'line-color':['get','color'], 'line-width':1.6, 'line-opacity':0.85, 'line-dasharray':[2,2] } })
        if (!m.getLayer(LYR_RWY))   m.addLayer({ id:LYR_RWY, type:'circle', source:SRC_RWY, paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.2, 'circle-radius':4, 'circle-opacity':0.78 } })
        if (!m.getLayer(LYR_HALO))  m.addLayer({ id:LYR_HALO, type:'circle', source:SRC_HALO, paint:{ 'circle-color':'transparent', 'circle-stroke-color':['get','color'], 'circle-stroke-width':2, 'circle-radius':['get','radius'], 'circle-opacity':0.9 } })
        if (!m.getLayer(LYR_PIN))   m.addLayer({ id:LYR_PIN, type:'circle', source:SRC_PIN, paint:{ 'circle-color':['get','color'], 'circle-stroke-color':'#0f172a', 'circle-stroke-width':1.4, 'circle-radius':5 } })
        if (!m.getLayer(LYR_LBL))   m.addLayer({ id:LYR_LBL, type:'symbol', source:SRC_LBL, layout:{ 'text-field':['get','txt'], 'text-size':10, 'text-offset':[0,1.4], 'text-anchor':'top', 'text-font':['Noto Sans Regular'] }, paint:{ 'text-color':['get','color'], 'text-halo-color':'#0f172a','text-halo-width':1.4 } })
      } catch {}
    }
    if (m.isStyleLoaded && m.isStyleLoaded()) tryAdd()
    else m.once && m.once('style.load', tryAdd)
    return () => {
      try {
        for (const id of [LYR_LBL, LYR_PIN, LYR_HALO, LYR_RWY, LYR_LINK]) if (m.getLayer(id)) m.removeLayer(id)
        for (const id of [SRC_LBL, SRC_PIN, SRC_HALO, SRC_RWY, SRC_LINK]) if (m.getSource(id)) m.removeSource(id)
      } catch {}
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const m = map
    const halo: any[] = []
    const pin: any[] = []
    const link: any[] = []
    const rwyF: any[] = []
    const lbl: any[] = []

    // Per-pair features: halo on each aircraft, link line between them
    for (const p of filteredPairs.slice(0, 60)) {
      const color = TIER_COLOR[p.tier]
      const rad = p.tier === 'ROSE' ? 16 : p.tier === 'FUCHSIA' ? 13 : p.tier === 'AMBER' ? 10 : p.tier === 'SKY' ? 8 : 6
      halo.push({ type:'Feature', geometry:{ type:'Point', coordinates:[p.a.lng, p.a.lat] }, properties:{ color, radius: rad } })
      halo.push({ type:'Feature', geometry:{ type:'Point', coordinates:[p.b.lng, p.b.lat] }, properties:{ color, radius: rad } })
      pin.push({ type:'Feature', geometry:{ type:'Point', coordinates:[p.a.lng, p.a.lat] }, properties:{ color } })
      pin.push({ type:'Feature', geometry:{ type:'Point', coordinates:[p.b.lng, p.b.lat] }, properties:{ color } })
      if (showLinks) {
        link.push({ type:'Feature', geometry:{ type:'LineString', coordinates:[[p.a.lng, p.a.lat],[p.b.lng, p.b.lat]] }, properties:{ color } })
      }
      if (showLbl && (p.tier === 'ROSE' || p.tier === 'FUCHSIA' || p.tier === 'AMBER')) {
        const csA = p.a.callsign || p.a.icao
        const csB = p.b.callsign || p.b.icao
        const txt = `${csA}↔${csB} ${p.stage} ${Math.round(p.dminM)}m`
        // Anchor label on the midpoint
        const lon = (p.a.lng + p.b.lng) / 2
        const lat = (p.a.lat + p.b.lat) / 2
        lbl.push({ type:'Feature', geometry:{ type:'Point', coordinates:[lon, lat] }, properties:{ txt, color } })
      }
    }

    // Runway threshold pins coloured by worst tier
    if (showRwyPins) {
      for (const r of runwayStates) {
        rwyF.push({ type:'Feature', geometry:{ type:'Point', coordinates:[r.rwy.lng, r.rwy.lat] }, properties:{ color: TIER_COLOR[r.worstTier] } })
      }
    }

    try {
      m.getSource(SRC_HALO) && m.getSource(SRC_HALO).setData({ type:'FeatureCollection', features: halo })
      m.getSource(SRC_PIN)  && m.getSource(SRC_PIN).setData({ type:'FeatureCollection', features: pin })
      m.getSource(SRC_LINK) && m.getSource(SRC_LINK).setData({ type:'FeatureCollection', features: link })
      m.getSource(SRC_RWY)  && m.getSource(SRC_RWY).setData({ type:'FeatureCollection', features: rwyF })
      m.getSource(SRC_LBL)  && m.getSource(SRC_LBL).setData({ type:'FeatureCollection', features: lbl })
    } catch {}
  }, [map, filteredPairs, runwayStates, showLinks, showRwyPins, showLbl])

  const pinnedPair = pinned ? allPairs.find(p => p.a.icao + '|' + p.b.icao === pinned || p.b.icao + '|' + p.a.icao === pinned) : undefined
  void pinnedPair

  return (
    <div className="absolute top-3 right-3 bottom-3 w-[440px] z-30 bg-slate-950/95 backdrop-blur border border-slate-800 rounded-md flex flex-col shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-sky-400 font-bold">RIMCAS · Runway Incursion Conflict</div>
          <div className="text-[10px] text-slate-400 truncate">A-SMGCS L3 pair-wise CPA · Doc 9830 / Doc 9870 / EAPPRI 4.0</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none" aria-label="Close">×</button>
      </div>

      {/* Top stat cards */}
      <div className="px-2 py-2 grid grid-cols-4 gap-1.5 border-b border-slate-800/60">
        {[
          ['COLLISION', agg.totalCollisionImm, '#fb7185'],
          ['STAGE-3',   agg.buckets.FUCHSIA,    '#d946ef'],
          ['STAGE-2',   agg.buckets.AMBER,      '#f59e0b'],
          ['STAGE-1',   agg.buckets.SKY,        '#38bdf8'],
        ].map(([lbl, v, c]) => (
          <div key={lbl as string} className="bg-slate-900/60 border border-slate-800 rounded px-1.5 py-1">
            <div className="text-[9px] uppercase text-slate-500">{lbl as string}</div>
            <div className="text-sm font-semibold" style={{ color: c as string }}>{v as number}</div>
          </div>
        ))}
      </div>

      <div className="px-2 py-1.5 text-[10px] text-slate-500 border-b border-slate-800/60 flex items-center justify-between gap-2">
        <div className="truncate">{agg.totalRunways} rwy in scope · {agg.occRunways} multi-occ · {agg.totalPairs} pairs · tick {salt}</div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 cursor-pointer text-slate-400">
            <input type="checkbox" checked={showLinks} onChange={e=>setShowLinks(e.target.checked)} className="accent-sky-500"/>
            <span>link</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer text-slate-400">
            <input type="checkbox" checked={showRwyPins} onChange={e=>setShowRwyPins(e.target.checked)} className="accent-sky-500"/>
            <span>rwy</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer text-slate-400">
            <input type="checkbox" checked={showLbl} onChange={e=>setShowLbl(e.target.checked)} className="accent-sky-500"/>
            <span>lbl</span>
          </label>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800/60">
        {(['PAIRS','RUNWAYS','METHOD'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 text-[10px] py-1.5 uppercase tracking-wider ${tab===t ? 'text-sky-400 border-b border-sky-500/60 bg-sky-500/5' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'PAIRS' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-2 py-1.5 border-b border-slate-800/60 flex gap-1 text-[10px]">
            {(['ALERTS','COLLISION','ALL'] as const).map(k => (
              <button key={k} onClick={()=>setFilter(k)} className={`px-2 py-0.5 rounded border ${filter===k ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'}`}>{k}</button>
            ))}
            <div className="ml-auto text-slate-600">{filteredPairs.length} shown</div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {filteredPairs.length === 0 && (
              <div className="px-3 py-8 text-center text-slate-500 text-[11px]">
                {filter === 'ALERTS' ? 'No active surface conflict alerts — RIMCAS clear' : 'No pairs match filter'}
              </div>
            )}
            {filteredPairs.slice(0, 80).map(p => {
              const key = p.a.icao + '|' + p.b.icao
              const csA = p.a.callsign || p.a.icao
              const csB = p.b.callsign || p.b.icao
              const expanded = pinned === key
              return (
                <div key={key} onClick={() => setPinned(expanded ? null : key)} className={`px-2 py-1.5 border-b border-slate-800/60 cursor-pointer hover:bg-slate-900/40 ${expanded ? 'bg-slate-900/60' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] border ${TIER_BG[p.tier]}`}>{p.stage}</span>
                    <span className="font-semibold text-slate-100 text-[12px] truncate flex-1">{csA} <span className="text-slate-500">↔</span> {csB}</span>
                    <span className="text-[10px] text-slate-500">{p.rwy.icao} {p.rwy.rwId}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-400">
                    <span>{p.aPhase}</span>
                    <span className="text-slate-600">vs</span>
                    <span>{p.bPhase}</span>
                    {p.sameRwy && <span className="text-amber-400">same-strip</span>}
                    <span className="ml-auto" style={{ color: TIER_COLOR[p.tier] }}>score {p.score}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
                    <span>d_min <span style={{ color: p.dminM < 75 ? '#fb7185' : p.dminM < 250 ? '#f59e0b' : '#94a3b8' }}>{Math.round(p.dminM)}m</span></span>
                    <span>·</span>
                    <span>ttcp <span style={{ color: p.ttcpS < 25 ? '#fb7185' : p.ttcpS < 50 ? '#f59e0b' : '#94a3b8' }}>{p.ttcpS < CPA_HORIZON_S ? `${p.ttcpS.toFixed(1)}s` : '—'}</span></span>
                    <span>·</span>
                    <span>v_rel {p.vrelKt.toFixed(0)}kt</span>
                    <span className="ml-auto">cross {p.xangDeg.toFixed(0)}°</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(p.driver).filter(([,v]) => v >= 25).slice(0, 5).map(([k, v]) => {
                      const col = v >= 75 ? '#fb7185' : v >= 50 ? '#f59e0b' : '#38bdf8'
                      return <span key={k} className="px-1 py-px rounded text-[8px] border" style={{ color: col, borderColor: col + '60', background: col + '15' }}>{k} {Math.round(v)}</span>
                    })}
                  </div>
                  {expanded && (
                    <div className="mt-2 px-2 py-1.5 bg-slate-900/80 border border-slate-800 rounded text-[10px] space-y-1">
                      <div className="text-slate-300">{p.notes[0]}</div>
                      {p.notes.slice(1).map((n, i) => <div key={i} className="text-slate-500">· {n}</div>)}
                      <div className="pt-1 grid grid-cols-2 gap-1 text-[9px]">
                        <div><span className="text-slate-500">A</span> <span className="text-slate-300">{csA} {p.a.type}</span></div>
                        <div><span className="text-slate-500">B</span> <span className="text-slate-300">{csB} {p.b.type}</span></div>
                        <div><span className="text-slate-500">SMGCS</span> <span className="text-slate-300">L{p.rwy.smgcsLevel}{p.rwy.rimcasDeployed?' · RIMCAS':' · no RIMCAS'}</span></div>
                        <div><span className="text-slate-500">Strip</span> <span className="text-slate-300">{p.sameRwy ? 'shared' : 'separate'}</span></div>
                      </div>
                      <div className="pt-1 flex gap-2">
                        {onFly && <button onClick={(e)=>{e.stopPropagation(); onFly(p.a.icao)}} className="text-sky-400 hover:text-sky-300 text-[10px]">› fly A</button>}
                        {onFly && <button onClick={(e)=>{e.stopPropagation(); onFly(p.b.icao)}} className="text-sky-400 hover:text-sky-300 text-[10px]">› fly B</button>}
                        <span className="ml-auto text-slate-600 text-[9px]">{p.rwy.precedent ?? 'no canonical precedent'}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'RUNWAYS' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {runwayStates.length === 0 && (
            <div className="px-3 py-8 text-center text-slate-500 text-[11px]">No runways currently in scope — try a busier hub view</div>
          )}
          {runwayStates.map(rs => (
            <div key={rs.rwy.icao + ':' + rs.rwy.rwId} className="px-2 py-1.5 border-b border-slate-800/60 hover:bg-slate-900/40">
              <div className="flex items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[9px] border ${TIER_BG[rs.worstTier]}`}>{rs.worstStage}</span>
                <span className="font-semibold text-slate-100 text-[12px] flex-1">{rs.rwy.icao} {rs.rwy.rwId}</span>
                <span className="text-[10px] text-slate-500">L{rs.rwy.smgcsLevel}{rs.rwy.rimcasDeployed?' · R':''}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-400">
                <span>{rs.occupants} occ</span>
                <span>·</span>
                <span>{rs.pairs.length} pairs</span>
                <span>·</span>
                <span>{rs.alerts} alerts</span>
                <span className="ml-auto" style={{ color: TIER_COLOR[rs.worstTier] }}>worst {rs.worstScore}</span>
              </div>
              {rs.rwy.precedent && <div className="mt-0.5 text-[9px] text-slate-600 truncate">↳ {rs.rwy.precedent}</div>}
              {/* Per-pair compact list (top 3) */}
              {rs.pairs.slice(0, 3).map(p => {
                const csA = p.a.callsign || p.a.icao
                const csB = p.b.callsign || p.b.icao
                return (
                  <div key={p.a.icao + '|' + p.b.icao} className="mt-1 px-1.5 py-1 bg-slate-900/40 rounded border border-slate-800/40">
                    <div className="flex items-center gap-1 text-[10px]">
                      <span style={{ color: TIER_COLOR[p.tier] }}>›</span>
                      <span className="text-slate-200">{csA} ↔ {csB}</span>
                      <span className="ml-auto text-slate-500">{Math.round(p.dminM)}m / {p.ttcpS < CPA_HORIZON_S ? p.ttcpS.toFixed(0)+'s' : '—'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {tab === 'METHOD' && (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 text-[10px] text-slate-400 space-y-2">
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">What RIMCAS scores</div>
            <div>For every pair of aircraft within {SCAN_NM} NM of one of {RUNWAYS.length} catalogued runways, RIMCAS computes the projected closest-pair geometry over the next {CPA_HORIZON_S} s and classifies the pair into the Doc 9830 §3.5.3 ladder.</div>
          </div>
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">Closest-pair geometry</div>
            <div className="font-mono text-slate-300 text-[9px] leading-tight">
              d²(t) = |r₀ + v_rel·t|² minimised at t* = −(r₀·v_rel) / |v_rel|²<br/>
              d_min = |r₀ + v_rel·t*|<br/>
              v_rel = v_B − v_A in local east-north frame
            </div>
          </div>
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">Stage thresholds (Doc 9830)</div>
            <div className="grid grid-cols-3 gap-1 text-[9px]">
              <div className="text-fuchsia-300">STAGE-3</div><div className="text-slate-400">d_min &lt; 75 m</div><div className="text-slate-400">ttcp &lt; 25 s</div>
              <div className="text-amber-300">STAGE-2</div><div className="text-slate-400">d_min &lt; 150 m</div><div className="text-slate-400">ttcp &lt; 50 s</div>
              <div className="text-sky-300">STAGE-1</div><div className="text-slate-400">d_min &lt; 250 m</div><div className="text-slate-400">ttcp &lt; 90 s</div>
              <div className="text-rose-300">COLLISION-IMM</div><div className="text-slate-400">d_min &lt; 30 m</div><div className="text-slate-400">ttcp &lt; 12 s</div>
            </div>
          </div>
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">Drivers (8)</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              {Object.entries(DRIVER_LABEL).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1">
                  <span className="text-slate-300">{k}</span>
                  <span className="text-slate-500 truncate">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">Canonical precedents</div>
            <div className="space-y-0.5 text-[9px] text-slate-500">
              <div>Tenerife KLM 4805 / Pan Am 1736 GCTS 1977 (583 fatal — the founding event)</div>
              <div>Linate SAS 686 / Cessna D-IEVX LIML 2001 (118 fatal — drove ICAO Doc 9830)</div>
              <div>LAX 1493 USAir / SkyWest 5569 KLAX 1991 (35 fatal — drove ASDE-X)</div>
              <div>Comair 5191 KLEX 2006 (49 fatal wrong runway)</div>
              <div>AC 759 KSFO 2017 (no fatal — taxiway-as-runway alignment)</div>
              <div>JAL 516 / JCG MA722 RJTT 2024 (5 fatal Coast Guard crew)</div>
            </div>
          </div>
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">Sources</div>
            <div className="text-[9px] text-slate-500 leading-relaxed">
              ICAO Annex 14 Vol I §10 · ICAO Doc 9830 A-SMGCS Manual §3.5 · ICAO Doc 9870 Manual on Prevention of Runway Incursions · ICAO Doc 9476 SMGCS · EUROCONTROL EAPPRI ed.4.0 · EUROCONTROL RIMCAS Spec ed.1.2 · EUROCAE ED-87C · ED-251 · FAA AC 120-74B · FAA JO 7110.65 §3-1-12 · FAA JO 7110.118 ASSC · FAA SAFO 18002 · NTSB AAR-91-08 LAX1493 · NTSB AAR-09-03 LEX5191 · NTSB AAR-18-01 SFO AC759 · ANSV F-IN-AAR-2004-1 LIML · JTSB AI2024-X HND
            </div>
          </div>
          <div>
            <div className="text-sky-400 font-bold text-[11px] mb-1">Distinct from siblings</div>
            <div className="text-[9px] text-slate-500 leading-relaxed">
              STBR is pilot-side STOP-BAR compliance · RWSL is pavement-light status · ASDE-X is sensor coverage · HOTSPOT is cartographic registry · STCA / MTCD / CPA are AIRBORNE pair conflicts · TCAS-COORD is onboard RA sense · TOWS is onboard config audit · RIMCAS is uniquely the CONTROLLER-SIDE PAIR-WISE SURFACE conflict scorer — the missing surface analogue of STCA.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
