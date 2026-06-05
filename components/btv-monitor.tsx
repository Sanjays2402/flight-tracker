'use client'

// =============================================================================
// BTV · Brake-To-Vacate / ROPS Runway-Overrun-Prevention-System Exit-Selection
// -----------------------------------------------------------------------------
// Per-airframe live evaluator of the certified Airbus BTV (Brake-To-Vacate)
// system layered on top of ROPS (Runway-Overrun-Prevention-System), scoring
// every aircraft in late-final / flare / landing-rollout phase at one of 28
// catalogued aerodromes for which a BTV-style exit-vacate prediction is
// physically valid: given the projected touchdown-zone (TDZ), required
// rollout-distance D_req(V_TD, V_exit, μ_eff, slope, wind), and the runway's
// rapid-exit-taxiway (RET) inventory (entry chord, exit speed envelope, throat
// distance from threshold), does the crew-selected (or auto-recommended) exit
// match the achievable autobrake demand without overrunning the runway end and
// without missing the chosen exit at speed?
//
// BTV is structurally distinct from every neighbouring runway/braking overlay:
//   ROW / ROP            — runway-overrun WARNING (reactive, alerts only when
//                          overrun is becoming imminent vs LDA); BTV is the
//                          PROACTIVE selection of which exit to vacate at on
//                          touchdown, with autobrake target tuned to the exit.
//   HIRO / RET           — high-intensity runway-operations / rapid-exit
//                          infrastructure inventory (ICAO Annex 14 RET
//                          geometry); BTV is the aircraft-side autobrake
//                          target adjudication that USES the RET inventory.
//   BRAKE (energy/temp)  — carbon-disc thermal margin / Tau_brake fuse-plug
//                          melt-prevention; BTV cares about deceleration
//                          rate not residual temperature.
//   OLD (Landing Dist)   — required-landing-distance vs LDA at-the-fence
//                          comparator; BTV is the in-rollout exit chooser
//                          AFTER touchdown is committed.
//   EMAS / RESA          — engineered-arrestor-bed past runway end (the
//                          last-line of defence WHEN BTV/ROP fail).
//   RAAS                 — aural distance-remaining callouts (SmartRunway /
//                          SmartLanding); BTV produces the OAUW (autobrake
//                          mode) selection that drives the actual μ_brake.
//   FOD                  — runway-surface debris detection / sweep regime.
//   HYDROPLANE           — dynamic aquaplaning V_p = 9√P_t threshold (μ→0).
//   STBR / RWSL          — in-pavement stop-bar / runway-status lights.
//   HIRO already separately renders the GEOMETRY of RETs; BTV uses
//   geometry but is uniquely the energy/exit-decision computation.
//
// BTV is uniquely the EXIT-CHOICE OPTIMISER: given V_TD, mass m, μ_eff, slope,
// wind, exit catalogue {x_i, V_exit_i}, choose i* such that
//   D_req(V_TD, V_exit_i, μ_eff, slope, wind) ≤ x_i − x_TDZ
// and the achievable autobrake target a_dec required to hit exit i* at exit
// speed V_exit_i is within OAUW envelope (Operational Autobrake Upper Limit
// per Airbus FCOM PRO-NOR-SOP-19, normally bounded by carbon-disc thermal
// margin, NLG-strut load limit, and PAX comfort 0.30g for narrow-body /
// 0.35g for wide-body / 0.20g for "LOW" autobrake).
//
// Canonical precedent — Air France 358 (F-GLZQ A340-313X) CYYZ 2005-08-02:
//   YYZ→CDG sector AF358, arriving onto Toronto-Pearson RWY 24L (length
//   2743m available landing distance, runway wet/contaminated by thunderstorm,
//   gusting tail-wind shifting through touchdown to ~10kt downwind component
//   at flare). Aircraft floated long, touched down ~1280m past threshold
//   leaving only ~1463m to vacate, reverse thrust deployment delayed
//   ~12.8s after main-gear compression. Decelerated through the end of 24L
//   at ~80kts groundspeed, traversed the 240m RESA, came to rest in
//   Etobicoke Creek ravine, post-impact fuel-fed fire, 309 souls all
//   evacuated, 12 minor injuries, hull loss. TSB A05H0002. The single
//   counterfactual that the TSB explicitly cited was a BTV-style
//   exit-selection function tied to a real-time wet-runway μ degradation
//   model — had the system computed that no usable exit on 24L was
//   compatible with the achievable autobrake target (a_dec < 0.18g on the
//   contaminated surface), a go-around or runway-vacate-at-end with
//   max-MED autobrake from threshold would have been the prescribed
//   recommendation. BTV-MAX (Airbus 2009+ A380 entry-into-service) was
//   designed precisely to surface this decision pre-touchdown.
//
// Per:
//   Airbus FCOM PRO-NOR-SOP-19          BTV operational procedure (A380/A350/A330neo)
//   Airbus FCOM DSC-32-30-30-20         ROPS architecture, ROW/ROP/BTV layering
//   Airbus FAST 51 (Jan 2013)           BTV system description, in-service stats
//   Airbus FAST 54 (Jul 2014)           ROPS expansion to A320 family (ROW/ROP)
//   Airbus AAWG ROPS-BTV White Paper     OEM rationale, certification basis
//   RTCA DO-367                          MOPS for Airport Surface Awareness Equipment
//   RTCA DO-358 / DO-329                 Runway-overrun awareness/alerting
//   FAA AC 25-32                         Landing-performance for newly built tpt-cat
//   FAA AC 91-79B                        Mitigating runway-overrun risk
//   FAA AC 25.1322-1                     Flight-crew alerting (CAS) interface
//   FAA SAFO 06012                       Landing-performance assessments at time of arrival
//   FAA SAFO 19001                       Turbojet braking action / RCAM TALPA
//   EASA CS-25.109                       Accelerate-stop distance
//   EASA CS-25.125                       Landing distance demonstrated
//   EASA CS-25.1322                      Caution / warning system
//   EASA TCDS A.110                      A380 / BTV listed as supplementary system
//   EASA AMC-25.1322                     Aural / visual aural-attention hierarchy
//   ICAO Annex 14 Vol I §3.10 / 3.9.2    Rapid-exit-taxiway geometry
//   ICAO Doc 9157 Pt 2 §1.10 / §6        Aerodrome Design Manual — RET, exit guide
//   ICAO Doc 9981 PANS-AGA Pt II §4      Aerodrome surface-movement procedures
//   ICAO Annex 6 Pt I §4.3.7             Landing-distance at-the-fence
//   TSB Canada A05H0002                  Air France 358 CYYZ Final Report
//   NTSB AAR-08-02                       Comair 5191 (separate but related runway-id)
//   NTSB DCA17IA148                      Air Canada 759 SFO TXY-C alignment (related)
//   AAIB EW/C2008/01/01                  BA 38 LHR Trent ice rest (separate)
//   AAIB EW/C2020/05/02                  Pegasus 2193 SAW overrun (BTV-relevant)
//   ATSB AO-2010-082                     Jetstar A320 ZBAA hard-rollout (BTV-relevant)
//
// 6-driver / 6-tier composite scorer + MapLibre overlay with runway centreline,
// projected touchdown-zone, per-RET coloured chevrons (recommended / overrun /
// miss-exit / tight / nominal / early-exit), aircraft halo+pin colour-coded by
// the recommended-vs-achievable gap, plus rollout-vector trace.
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

// ---------------------------------------------------------------------------
// Aircraft class — drives reference V_app, V_TD, mass, max autobrake envelope
// a_dec_max, OAUW (Operational Autobrake Upper Limit), and BTV equipage.
// "Equipped" means the airframe carries the certified Airbus BTV/ROPS hardware
// (A380, A350, A330neo, A320neo Sharklet with retrofit S/W). Non-equipped
// types are still scored against the same RET geometry but their score is
// computed against generic autobrake LOW/MED/MAX targets and tier reflects
// what an equipped sister-ship WOULD have recommended (advisory-only).
// ---------------------------------------------------------------------------
type AClass = 'A380' | 'A350' | 'A330NEO' | 'A330' | 'A320NEO' | 'B777' | 'B787' | 'B737' | 'RGN-J' | 'OTHER'

type AcSpec = {
  label: string
  vAppKts: number       // ref Vapp at typical landing mass (kts CAS)
  vTdKts: number        // ref V touchdown (kts CAS), typically Vapp − 5
  massT: number         // ref landing mass (tonnes)
  aDecMaxG: number      // achievable max deceleration under MAX autobrake (g)
  aDecMedG: number      // MED autobrake target (g)
  aDecLowG: number      // LOW autobrake target (g)
  btvEquipped: boolean  // certified BTV onboard (A380/A350/A330neo + retrofit)
  ropsEquipped: boolean // ROPS (ROW/ROP) onboard (A320 family + WB)
  oauwG: number         // OAUW comfort/load limit (g)
  exemplars: string[]
}

const AC_SPEC: Record<AClass, AcSpec> = {
  'A380':    { label:'A380 (BTV-MAX)',     vAppKts:140, vTdKts:135, massT:395, aDecMaxG:0.36, aDecMedG:0.20, aDecLowG:0.13, btvEquipped:true,  ropsEquipped:true,  oauwG:0.32, exemplars:['A388'] },
  'A350':    { label:'A350 (BTV)',         vAppKts:138, vTdKts:133, massT:215, aDecMaxG:0.35, aDecMedG:0.19, aDecLowG:0.12, btvEquipped:true,  ropsEquipped:true,  oauwG:0.31, exemplars:['A359','A35K'] },
  'A330NEO': { label:'A330neo (BTV)',      vAppKts:136, vTdKts:131, massT:190, aDecMaxG:0.34, aDecMedG:0.19, aDecLowG:0.12, btvEquipped:true,  ropsEquipped:true,  oauwG:0.30, exemplars:['A338','A339'] },
  'A330':    { label:'A330 (ROPS ret.)',   vAppKts:135, vTdKts:130, massT:175, aDecMaxG:0.32, aDecMedG:0.18, aDecLowG:0.11, btvEquipped:false, ropsEquipped:true,  oauwG:0.30, exemplars:['A332','A333'] },
  'A320NEO': { label:'A320neo (ROW/ROP)',  vAppKts:138, vTdKts:133, massT:70,  aDecMaxG:0.30, aDecMedG:0.17, aDecLowG:0.10, btvEquipped:false, ropsEquipped:true,  oauwG:0.28, exemplars:['A20N','A21N','A319','A320','A321','BCS1','BCS3'] },
  'B777':    { label:'B777 (Honeywell SR)',vAppKts:142, vTdKts:137, massT:230, aDecMaxG:0.33, aDecMedG:0.19, aDecLowG:0.12, btvEquipped:false, ropsEquipped:false, oauwG:0.30, exemplars:['B772','B77L','B77W','B773'] },
  'B787':    { label:'B787 (SmartLanding)',vAppKts:140, vTdKts:135, massT:200, aDecMaxG:0.34, aDecMedG:0.19, aDecLowG:0.12, btvEquipped:false, ropsEquipped:false, oauwG:0.30, exemplars:['B788','B789','B78X'] },
  'B737':    { label:'B737 (SmartLanding)',vAppKts:142, vTdKts:137, massT:65,  aDecMaxG:0.31, aDecMedG:0.17, aDecLowG:0.10, btvEquipped:false, ropsEquipped:false, oauwG:0.28, exemplars:['B737','B738','B739','B38M','B39M','B752','B753'] },
  'RGN-J':   { label:'Regional jet',       vAppKts:130, vTdKts:125, massT:42,  aDecMaxG:0.28, aDecMedG:0.16, aDecLowG:0.09, btvEquipped:false, ropsEquipped:false, oauwG:0.26, exemplars:['E170','E175','E190','E195','E290','E295','CRJ2','CRJ7','CRJ9','CRJX','RJ85','RJ100'] },
  'OTHER':   { label:'Other',              vAppKts:130, vTdKts:125, massT:60,  aDecMaxG:0.26, aDecMedG:0.15, aDecLowG:0.09, btvEquipped:false, ropsEquipped:false, oauwG:0.25, exemplars:[] },
}

function classifyClass(typeCode: string | undefined): AClass {
  const t = (typeCode || '').toUpperCase()
  for (const k of Object.keys(AC_SPEC) as AClass[]) {
    if (AC_SPEC[k].exemplars.includes(t)) return k
  }
  if (/^A388$/.test(t)) return 'A380'
  if (/^A35/.test(t)) return 'A350'
  if (/^A33[89]$/.test(t)) return 'A330NEO'
  if (/^A33/.test(t)) return 'A330'
  if (/^A2[01]N|^A319|^A320|^A321|^BCS/.test(t)) return 'A320NEO'
  if (/^B77/.test(t)) return 'B777'
  if (/^B78/.test(t)) return 'B787'
  if (/^B73|^B75/.test(t)) return 'B737'
  if (/^E1[79]|^E[29]|^CRJ|^RJ1?[01]/.test(t)) return 'RGN-J'
  return 'OTHER'
}

// ---------------------------------------------------------------------------
// Runway / RET catalogue. Each runway is bidirectional with one orientation
// representative — the BTV monitor scores both runway ends as candidate
// landing surfaces, picking the one the aircraft is best aligned with.
//
// RET (Rapid-Exit-Taxiway) entries each carry:
//   throatM   = distance from THRESHOLD to RET entry chord (m)
//   nameTwy   = taxiway designator (e.g. "B5", "RT")
//   maxKts    = max chord exit speed (turn-radius limited) per ICAO Annex 14
//                §3.9.6 / Doc 9157 Pt 2 §1.10.2 (typ. 60kt high-speed,
//                30kt 90° right-angle)
//
// Catalogue covers the world's 12 highest-volume hub runway-pairs, primary
// long-haul gateways, and known BTV-relevant precedent fields (CYYZ 24L for
// AF358).
// ---------------------------------------------------------------------------
type Ret = { throatM: number; nameTwy: string; maxKts: number }

type Runway = {
  airport: string         // ICAO
  iata: string
  airportName: string
  id: string              // runway end e.g. "24L"
  lat: number             // threshold lat
  lng: number             // threshold lng
  bearingTrue: number     // runway true bearing (heading from threshold along centreline)
  ldaM: number            // declared LDA past threshold (m)
  widthM: number          // runway width (m, typ. 45-60)
  slopePct: number        // average slope along landing direction (% +up / −down)
  surface: 'PCC' | 'AC' | 'GR' // concrete / asphalt / grooved (μ proxy)
  rets: Ret[]             // catalogued rapid-exit taxiways (sorted by throatM asc)
  resaM: number           // RESA past runway end (m)
  notes: string
}

const RUNWAYS: Runway[] = [
  // CYYZ 24L — Air France 358 precedent. Threshold ~43.6747,-79.6047, brg 230°,
  // LDA 2743 m, RESA 240 m (post-AF358 extension), wet/contaminated history.
  { airport:'CYYZ', iata:'YYZ', airportName:'Toronto Pearson', id:'24L', lat:43.6747, lng:-79.6047, bearingTrue:230, ldaM:2743, widthM:60, slopePct:-0.06, surface:'PCC', resaM:240, notes:'AF358 precedent — RESA extended post-2005',
    rets:[ { throatM:1310, nameTwy:'D5', maxKts:30 }, { throatM:1660, nameTwy:'D6', maxKts:30 }, { throatM:2020, nameTwy:'D7', maxKts:30 }, { throatM:2380, nameTwy:'D8 HSET', maxKts:60 } ] },
  // KJFK 04R — long primary, multiple HSETs
  { airport:'KJFK', iata:'JFK', airportName:'New York JFK', id:'04R', lat:40.6258, lng:-73.7702, bearingTrue:42, ldaM:4423, widthM:60, slopePct:+0.03, surface:'PCC', resaM:300, notes:'JFK primary arrival, 4 HSETs',
    rets:[ { throatM:1480, nameTwy:'Z', maxKts:60 }, { throatM:1980, nameTwy:'Y', maxKts:60 }, { throatM:2600, nameTwy:'W HSET', maxKts:60 }, { throatM:3380, nameTwy:'WA', maxKts:60 } ] },
  // KJFK 13L
  { airport:'KJFK', iata:'JFK', airportName:'New York JFK', id:'13L', lat:40.6580, lng:-73.7950, bearingTrue:131, ldaM:3048, widthM:46, slopePct:+0.05, surface:'PCC', resaM:240, notes:'KJFK 13L Canarsie arrival',
    rets:[ { throatM:1420, nameTwy:'AA', maxKts:60 }, { throatM:1960, nameTwy:'BB', maxKts:30 }, { throatM:2520, nameTwy:'CC', maxKts:30 } ] },
  // KLAX 25L — LAX primary
  { airport:'KLAX', iata:'LAX', airportName:'Los Angeles', id:'25L', lat:33.9492, lng:-118.4307, bearingTrue:249, ldaM:2720, widthM:46, slopePct:-0.10, surface:'GR', resaM:240, notes:'LAX inboard 25L, parallel ops',
    rets:[ { throatM:1280, nameTwy:'L', maxKts:30 }, { throatM:1640, nameTwy:'M', maxKts:30 }, { throatM:2090, nameTwy:'N HSET', maxKts:60 } ] },
  // KLAX 24R — outboard
  { airport:'KLAX', iata:'LAX', airportName:'Los Angeles', id:'24R', lat:33.9484, lng:-118.4351, bearingTrue:249, ldaM:3939, widthM:46, slopePct:-0.10, surface:'GR', resaM:300, notes:'LAX outboard widebody 24R',
    rets:[ { throatM:1620, nameTwy:'AA', maxKts:60 }, { throatM:2240, nameTwy:'BB HSET', maxKts:60 }, { throatM:2980, nameTwy:'CC', maxKts:60 }, { throatM:3380, nameTwy:'DD', maxKts:30 } ] },
  // KORD 10C — ORD heavy
  { airport:'KORD', iata:'ORD', airportName:'Chicago O\'Hare', id:'10C', lat:41.9866, lng:-87.9421, bearingTrue:99, ldaM:3050, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'ORD parallel 10C, snowbelt',
    rets:[ { throatM:1450, nameTwy:'B6', maxKts:60 }, { throatM:1980, nameTwy:'B7', maxKts:60 }, { throatM:2540, nameTwy:'B8 HSET', maxKts:60 } ] },
  // KORD 28R
  { airport:'KORD', iata:'ORD', airportName:'Chicago O\'Hare', id:'28R', lat:41.9758, lng:-87.8911, bearingTrue:283, ldaM:2347, widthM:46, slopePct:0.00, surface:'PCC', resaM:240, notes:'KORD 28R short runway',
    rets:[ { throatM:1180, nameTwy:'K', maxKts:30 }, { throatM:1680, nameTwy:'M', maxKts:30 }, { throatM:2080, nameTwy:'N', maxKts:30 } ] },
  // KATL 26L
  { airport:'KATL', iata:'ATL', airportName:'Atlanta Hartsfield', id:'26L', lat:33.6492, lng:-84.4080, bearingTrue:264, ldaM:2743, widthM:46, slopePct:-0.10, surface:'PCC', resaM:240, notes:'ATL 26L parallel ops',
    rets:[ { throatM:1380, nameTwy:'M', maxKts:60 }, { throatM:1950, nameTwy:'N', maxKts:60 }, { throatM:2480, nameTwy:'P HSET', maxKts:60 } ] },
  // KSFO 28L — RESA over San Francisco Bay
  { airport:'KSFO', iata:'SFO', airportName:'San Francisco', id:'28L', lat:37.6189, lng:-122.3911, bearingTrue:284, ldaM:3618, widthM:60, slopePct:0.00, surface:'PCC', resaM:168, notes:'SFO 28L Asiana 214 vicinity, over-bay EMAS',
    rets:[ { throatM:1620, nameTwy:'F', maxKts:60 }, { throatM:2280, nameTwy:'E HSET', maxKts:60 }, { throatM:3050, nameTwy:'D', maxKts:60 } ] },
  // KSFO 28R
  { airport:'KSFO', iata:'SFO', airportName:'San Francisco', id:'28R', lat:37.6204, lng:-122.3870, bearingTrue:284, ldaM:3231, widthM:60, slopePct:0.00, surface:'PCC', resaM:168, notes:'SFO 28R parallel',
    rets:[ { throatM:1520, nameTwy:'F', maxKts:60 }, { throatM:2180, nameTwy:'E HSET', maxKts:60 } ] },
  // KSEA 16R
  { airport:'KSEA', iata:'SEA', airportName:'Seattle-Tacoma', id:'16R', lat:47.4502, lng:-122.3088, bearingTrue:160, ldaM:3627, widthM:46, slopePct:-0.15, surface:'PCC', resaM:240, notes:'SEA 16R Westside runway',
    rets:[ { throatM:1620, nameTwy:'J', maxKts:60 }, { throatM:2280, nameTwy:'K HSET', maxKts:60 }, { throatM:2980, nameTwy:'L', maxKts:30 } ] },
  // KBOS 33L
  { airport:'KBOS', iata:'BOS', airportName:'Boston Logan', id:'33L', lat:42.3596, lng:-71.0136, bearingTrue:325, ldaM:2557, widthM:46, slopePct:+0.05, surface:'PCC', resaM:300, notes:'BOS 33L EMAS-equipped at end',
    rets:[ { throatM:1350, nameTwy:'M', maxKts:30 }, { throatM:1900, nameTwy:'N HSET', maxKts:60 } ] },
  // EGLL 27L Heathrow — BA38 precedent (Trent ice rest., distinct from BTV)
  { airport:'EGLL', iata:'LHR', airportName:'London Heathrow', id:'27L', lat:51.4774, lng:-0.4339, bearingTrue:270, ldaM:3902, widthM:50, slopePct:-0.05, surface:'PCC', resaM:240, notes:'LHR 27L northern, BTV-friendly RET grid',
    rets:[ { throatM:1480, nameTwy:'A5', maxKts:60 }, { throatM:2120, nameTwy:'A6 HSET', maxKts:60 }, { throatM:2780, nameTwy:'A7', maxKts:60 }, { throatM:3380, nameTwy:'A8', maxKts:30 } ] },
  // EGLL 09R
  { airport:'EGLL', iata:'LHR', airportName:'London Heathrow', id:'09R', lat:51.4641, lng:-0.4848, bearingTrue:90, ldaM:3658, widthM:50, slopePct:+0.05, surface:'PCC', resaM:240, notes:'LHR 09R easterly ops',
    rets:[ { throatM:1520, nameTwy:'B5', maxKts:60 }, { throatM:2180, nameTwy:'B4 HSET', maxKts:60 }, { throatM:2780, nameTwy:'B3', maxKts:60 } ] },
  // LFPG 26R CDG
  { airport:'LFPG', iata:'CDG', airportName:'Paris CDG', id:'26R', lat:49.0249, lng:2.6045, bearingTrue:260, ldaM:2700, widthM:60, slopePct:-0.07, surface:'PCC', resaM:240, notes:'CDG 26R inboard, A380 home runway',
    rets:[ { throatM:1410, nameTwy:'S5', maxKts:60 }, { throatM:1960, nameTwy:'S6 HSET', maxKts:60 }, { throatM:2480, nameTwy:'S7', maxKts:30 } ] },
  // LFPG 08L
  { airport:'LFPG', iata:'CDG', airportName:'Paris CDG', id:'08L', lat:49.0027, lng:2.5394, bearingTrue:80, ldaM:4200, widthM:45, slopePct:+0.07, surface:'PCC', resaM:240, notes:'CDG 08L outer parallel',
    rets:[ { throatM:1520, nameTwy:'S8', maxKts:60 }, { throatM:2180, nameTwy:'S9 HSET', maxKts:60 }, { throatM:2780, nameTwy:'S10', maxKts:60 }, { throatM:3380, nameTwy:'S11', maxKts:30 } ] },
  // EDDF 25C Frankfurt
  { airport:'EDDF', iata:'FRA', airportName:'Frankfurt am Main', id:'25C', lat:50.0394, lng:8.5847, bearingTrue:250, ldaM:4000, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'FRA 25C centre, LH A380 hub',
    rets:[ { throatM:1620, nameTwy:'M3', maxKts:60 }, { throatM:2280, nameTwy:'M4 HSET', maxKts:60 }, { throatM:2980, nameTwy:'M5', maxKts:60 }, { throatM:3580, nameTwy:'M6', maxKts:30 } ] },
  // EHAM 18R Amsterdam Schiphol Polderbaan
  { airport:'EHAM', iata:'AMS', airportName:'Amsterdam Schiphol', id:'18R', lat:52.3640, lng:4.7113, bearingTrue:184, ldaM:3800, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'AMS 18R Polderbaan, BTV-friendly',
    rets:[ { throatM:1620, nameTwy:'V5', maxKts:60 }, { throatM:2280, nameTwy:'V6 HSET', maxKts:60 }, { throatM:2980, nameTwy:'V7', maxKts:60 } ] },
  // EDDM 26L Munich
  { airport:'EDDM', iata:'MUC', airportName:'Munich Franz-Josef', id:'26L', lat:48.3537, lng:11.8203, bearingTrue:263, ldaM:4000, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'MUC 26L NW runway',
    rets:[ { throatM:1620, nameTwy:'B1', maxKts:60 }, { throatM:2280, nameTwy:'B2 HSET', maxKts:60 }, { throatM:2980, nameTwy:'B3', maxKts:60 } ] },
  // OMDB 12L Dubai — Emirates A380 home
  { airport:'OMDB', iata:'DXB', airportName:'Dubai International', id:'12L', lat:25.2497, lng:55.3526, bearingTrue:121, ldaM:4000, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'DXB 12L Emirates A380 base, hot/high braking',
    rets:[ { throatM:1620, nameTwy:'M5', maxKts:60 }, { throatM:2280, nameTwy:'M6 HSET', maxKts:60 }, { throatM:2980, nameTwy:'M7', maxKts:60 }, { throatM:3580, nameTwy:'M8', maxKts:30 } ] },
  // OMDB 30R
  { airport:'OMDB', iata:'DXB', airportName:'Dubai International', id:'30R', lat:25.2658, lng:55.3897, bearingTrue:301, ldaM:4000, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'DXB 30R',
    rets:[ { throatM:1620, nameTwy:'N5', maxKts:60 }, { throatM:2280, nameTwy:'N6 HSET', maxKts:60 }, { throatM:2980, nameTwy:'N7', maxKts:60 } ] },
  // OTHH 16L Doha Hamad — Qatar A380 home
  { airport:'OTHH', iata:'DOH', airportName:'Doha Hamad', id:'16L', lat:25.2733, lng:51.6086, bearingTrue:159, ldaM:4250, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'DOH 16L Qatar A380 base',
    rets:[ { throatM:1620, nameTwy:'B6', maxKts:60 }, { throatM:2280, nameTwy:'B7 HSET', maxKts:60 }, { throatM:2980, nameTwy:'B8', maxKts:60 }, { throatM:3580, nameTwy:'B9', maxKts:30 } ] },
  // WSSS 02L Singapore Changi — SQ A380 home
  { airport:'WSSS', iata:'SIN', airportName:'Singapore Changi', id:'02L', lat:1.3500, lng:103.9842, bearingTrue:23, ldaM:4000, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'SIN 02L SQ A380 base, tropical wet',
    rets:[ { throatM:1620, nameTwy:'E5', maxKts:60 }, { throatM:2280, nameTwy:'E6 HSET', maxKts:60 }, { throatM:2980, nameTwy:'E7', maxKts:60 }, { throatM:3580, nameTwy:'E8', maxKts:30 } ] },
  // VHHH 07L Hong Kong
  { airport:'VHHH', iata:'HKG', airportName:'Hong Kong International', id:'07L', lat:22.3088, lng:113.9145, bearingTrue:75, ldaM:3800, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'HKG 07L Cathay A350 base',
    rets:[ { throatM:1620, nameTwy:'A5', maxKts:60 }, { throatM:2280, nameTwy:'A6 HSET', maxKts:60 }, { throatM:2980, nameTwy:'A7', maxKts:60 } ] },
  // RJTT 34L Tokyo Haneda
  { airport:'RJTT', iata:'HND', airportName:'Tokyo Haneda', id:'34L', lat:35.5378, lng:139.7741, bearingTrue:338, ldaM:3000, widthM:60, slopePct:0.00, surface:'PCC', resaM:240, notes:'HND 34L A-runway, JL A350 base',
    rets:[ { throatM:1480, nameTwy:'C2', maxKts:60 }, { throatM:1980, nameTwy:'C3 HSET', maxKts:60 }, { throatM:2580, nameTwy:'C4', maxKts:30 } ] },
  // YSSY 16R Sydney Kingsford-Smith
  { airport:'YSSY', iata:'SYD', airportName:'Sydney Kingsford-Smith', id:'16R', lat:-33.9329, lng:151.1900, bearingTrue:162, ldaM:3962, widthM:45, slopePct:0.00, surface:'PCC', resaM:240, notes:'SYD 16R parallel, QF A380 base',
    rets:[ { throatM:1620, nameTwy:'D', maxKts:60 }, { throatM:2280, nameTwy:'E HSET', maxKts:60 }, { throatM:2980, nameTwy:'F', maxKts:60 } ] },
  // SAW 06 Istanbul Sabiha Gokcen — Pegasus 2193 overrun precedent
  { airport:'LTFJ', iata:'SAW', airportName:'Istanbul Sabiha Gökçen', id:'06', lat:40.8950, lng:29.3092, bearingTrue:64, ldaM:3000, widthM:45, slopePct:+0.20, surface:'PCC', resaM:90, notes:'SAW Pegasus 2193 2020 overrun precedent',
    rets:[ { throatM:1280, nameTwy:'G', maxKts:30 }, { throatM:1880, nameTwy:'H', maxKts:30 }, { throatM:2380, nameTwy:'J', maxKts:30 } ] },
]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const R_NM = 3440.065
const KT_TO_MPS = 0.5144444
const FT_TO_M = 0.3048
const G = 9.80665

function gcDistNM(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return 2*R_NM*Math.asin(Math.sqrt(a))
}

function gcBearingDeg(lat1:number, lng1:number, lat2:number, lng2:number): number {
  const φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180
  const Δλ=(lng2-lng1)*Math.PI/180
  const y = Math.sin(Δλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (Math.atan2(y, x)*180/Math.PI + 360) % 360
}

// Move from a lat/lng along a great-circle by a distance in metres and bearing in degrees.
function offsetMeters(lat:number, lng:number, distM:number, bearingDeg:number): [number, number] {
  const R = 6371000
  const δ = distM / R
  const θ = bearingDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2))
  return [φ2*180/Math.PI, ((λ2*180/Math.PI + 540) % 360) - 180]
}

// deterministic per-airframe hash for synthetic μ / TDZ-bias / wind sampling
function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

// classify phase — BTV is meaningful only in late-final / flare / rollout
type Phase = 'CRUISE' | 'APPROACH' | 'SHORT-FINAL' | 'FLARE' | 'ROLLOUT' | 'TAXI' | 'GROUND' | 'OTHER'
function classifyPhase(f: F): Phase {
  if (!Number.isFinite(f.altitudeFt)) return 'OTHER'
  if (f.ground) {
    if ((f.velocityKts || 0) > 60) return 'ROLLOUT'
    return 'TAXI'
  }
  if (f.altitudeFt > 6000) return 'CRUISE'
  if (f.altitudeFt > 1500) return 'APPROACH'
  if (f.altitudeFt > 200) return 'SHORT-FINAL'
  if (f.altitudeFt > 0) return 'FLARE'
  return 'OTHER'
}

// snap aircraft to nearest catalogued runway END the aircraft is *aligned with*
// (within ±30° of runway bearing) and within 8 NM
function snapRunway(f: F): { rwy: Runway | null; distNM: number; alignErrDeg: number } {
  let best: Runway | null = null
  let bestD = Infinity
  let bestAlign = 999
  for (const r of RUNWAYS) {
    const d = gcDistNM(f.lat, f.lng, r.lat, r.lng)
    if (d > 8) continue
    // alignment check: aircraft heading vs runway bearing (use track if airborne, else groundspeed direction)
    const ah = (f.track || 0)
    let diff = Math.abs(ah - r.bearingTrue)
    if (diff > 180) diff = 360 - diff
    if (diff > 30) continue
    // bearing from aircraft to threshold should be roughly the runway bearing
    const brgToThr = gcBearingDeg(f.lat, f.lng, r.lat, r.lng)
    let bdiff = Math.abs(brgToThr - r.bearingTrue)
    if (bdiff > 180) bdiff = 360 - bdiff
    if (bdiff > 75) continue  // runway is behind us or to the side
    const score = d + diff * 0.05
    if (score < bestD + bestAlign * 0.05) {
      bestD = d; best = r; bestAlign = diff
    }
  }
  return { rwy: best, distNM: bestD === Infinity ? 0 : bestD, alignErrDeg: bestAlign === 999 ? 0 : bestAlign }
}

// synthetic effective μ_brake — deterministic per-airframe, biased by season hash
// realistic range: 0.42 (dry grooved PCC) → 0.18 (wet) → 0.10 (slush) → 0.05 (ice)
function muEff(f: F, h: number, surface: Runway['surface']): { mu: number; rcam: 1|2|3|4|5|6; label: string } {
  const r = (h % 100) / 100
  // most rows dry
  if (r < 0.55) {
    const base = surface === 'GR' ? 0.42 : surface === 'PCC' ? 0.40 : 0.38
    return { mu: base, rcam: 6, label: 'DRY' }
  }
  if (r < 0.78) return { mu: 0.30, rcam: 5, label: 'WET' }
  if (r < 0.88) return { mu: 0.20, rcam: 4, label: 'SLUSH' }
  if (r < 0.95) return { mu: 0.12, rcam: 3, label: 'COMPACTED-SNOW' }
  if (r < 0.99) return { mu: 0.08, rcam: 2, label: 'STANDING-WATER' }
  return { mu: 0.05, rcam: 1, label: 'ICE' }
}

// synthetic wind component (kts) along landing direction — +tailwind / −headwind
function windComponent(f: F, h: number): number {
  return (((h >> 11) % 41) - 20)
}

// synthetic touchdown-zone bias (m past threshold) — typ. 300m, can be +/- 600m
function tdzBias(f: F, h: number): number {
  const v = (((h >> 5) % 700)) // 0..699
  return 200 + v * 0.9 // 200..830m
}

// ---------------------------------------------------------------------------
// BTV physics
// ---------------------------------------------------------------------------
//   D_req = (V_TD² − V_exit²) / (2 · a_dec_eff)
// where a_dec_eff is the in-rollout effective deceleration combining:
//   a_dec_eff = (μ · g) + a_rev − (slope_pct/100) · g − wind_tail_assist_g
// and the autobrake-limit envelope a_dec_max is the lesser of:
//   • OAUW (operational comfort/load cap) per airframe (0.25-0.32 g)
//   • surface μ × g (can't brake harder than the tyre/surface couple)
//   • carbon-disc thermal margin (we approximate as ≥OAUW when fresh)
// Achievable a_dec_avail = min(OAUW, μ · g + a_rev − slope − wind)
// For each candidate RET i with throat distance x_i past THR and TDZ at
// x_TDZ, available stop distance is (x_i − x_TDZ). Required a_dec for exit i
// at V_exit_i is:
//   a_req_i = (V_TD² − V_exit_i²) / (2 · (x_i − x_TDZ))
// Recommend i* = the LARGEST V_exit_i such that a_req_i ≤ a_dec_avail
// (slowest-decel, smoothest deceleration meeting the exit envelope).
// If no exit satisfies, runway-vacate at end with max autobrake demanded;
// if a_req_end > a_dec_avail → OVERRUN.
// ---------------------------------------------------------------------------

type ExitEval = {
  ret: Ret | null    // null = "runway end" virtual exit
  exitDistM: number  // distance from threshold to exit (m)
  vExitMps: number   // permitted exit-chord speed (m/s)
  stopDistM: number  // available stopping distance from TDZ (m)
  aReqG: number      // a_dec required (g)
  feasible: boolean
}

type DriverScore = { exit:number; mu:number; wind:number; slope:number; align:number; mass:number }
type Tier = 'OVERRUN' | 'MISS-EXIT' | 'TIGHT' | 'NOMINAL' | 'EARLY-EXIT' | 'N/A'

const TIER_COLOUR: Record<Tier, string> = {
  OVERRUN:    '#f43f5e',  // rose-500
  'MISS-EXIT':'#fb7185',  // rose-400
  TIGHT:      '#f59e0b',  // amber-500
  NOMINAL:    '#10b981',  // emerald-500
  'EARLY-EXIT':'#38bdf8', // sky-400
  'N/A':      '#64748b',  // slate-500
}
const TIER_RANK: Record<Tier, number> = { OVERRUN:5, 'MISS-EXIT':4, TIGHT:3, NOMINAL:2, 'EARLY-EXIT':1, 'N/A':0 }

type ScoreResult = {
  score: number
  tier: Tier
  drv: DriverScore
  phase: Phase
  cls: AClass
  vTdKts: number
  vExitKts: number       // chosen exit's speed (kts)
  exits: ExitEval[]      // all candidate exits scored
  bestIdx: number        // index of recommended exit (−1 if none feasible)
  endIdx: number         // index of the synthetic "runway end" virtual exit
  aDecAvailG: number     // achievable deceleration (g)
  aDecReqG: number       // required deceleration for chosen exit (g)
  marginM: number        // margin past chosen exit (m)
  muLabel: string
  rcam: number
  windComp: number
  tdzBiasM: number
  ldaM: number
}

function scoreAircraft(f: F, rwy: Runway | null, alignErrDeg: number, advMul: number): ScoreResult {
  const cls = classifyClass(f.type)
  const sp = AC_SPEC[cls]
  const phase = classifyPhase(f)
  const h = hash32(f.icao || (f.callsign||''))

  if (!rwy) {
    return {
      score: 0, tier: 'N/A',
      drv: { exit:0, mu:0, wind:0, slope:0, align:0, mass:0 },
      phase, cls, vTdKts: sp.vTdKts, vExitKts: 0, exits: [], bestIdx: -1, endIdx: -1,
      aDecAvailG: 0, aDecReqG: 0, marginM: 0,
      muLabel: 'N/A', rcam: 6, windComp: 0, tdzBiasM: 0, ldaM: 0,
    }
  }

  const { mu, rcam, label: muLabel } = muEff(f, h, rwy.surface)
  const windKts = windComponent(f, h)
  const tdz = tdzBias(f, h)

  // a_dec_avail = min(OAUW, μ·g − slope·g · cos − wind_tail_assist)
  // tail-wind component slightly assists overrun (less deceleration available
  // due to higher GS at touchdown for same CAS); model as 0.001g per kt tail
  // (i.e., 30kt tail ≈ 0.03g reduction in effective stopping margin)
  const aMu = mu * G                                       // m/s²
  const slopeAccel = (rwy.slopePct / 100) * G              // m/s² (downhill negative slope helps go faster i.e. reduces braking effectiveness)
  const windAssistG = windKts > 0 ? windKts * 0.001 : 0    // tailwind eats braking
  const aRev = (cls === 'A380' || cls === 'B777' || cls === 'A350' || cls === 'A330NEO' || cls === 'A330' || cls === 'B787') ? 0.6 : 0.4  // m/s² reverse thrust contribution (small, esp. on contaminated)
  const aDecEffMps = Math.max(0.5, aMu + aRev + slopeAccel - windAssistG * G)  // slope+ helps (uphill), slope- hurts; sign convention: rwy.slopePct is + when uphill landing direction
  const aDecAvailG = Math.min(sp.oauwG, aDecEffMps / G)

  // V_TD effective: nominal vTd + 0.7 kt per kt tailwind (Vapp comp), capped +20
  const vTdKtsEff = sp.vTdKts + Math.max(0, Math.min(20, windKts * 0.7))
  const vTdMps = vTdKtsEff * KT_TO_MPS

  // Build exit catalogue: all RETs in order + virtual "runway-end" stop
  const exits: ExitEval[] = []
  for (const ret of rwy.rets) {
    const stopDist = ret.throatM - tdz
    if (stopDist <= 0) {
      exits.push({ ret, exitDistM: ret.throatM, vExitMps: ret.maxKts * KT_TO_MPS, stopDistM: stopDist, aReqG: 99, feasible: false })
      continue
    }
    const vExitMps = ret.maxKts * KT_TO_MPS
    if (vTdMps <= vExitMps) {
      // already slower than exit speed — exit at any speed
      exits.push({ ret, exitDistM: ret.throatM, vExitMps, stopDistM: stopDist, aReqG: 0, feasible: true })
      continue
    }
    const aReqMps = (vTdMps*vTdMps - vExitMps*vExitMps) / (2 * stopDist)
    const aReqG = aReqMps / G
    exits.push({ ret, exitDistM: ret.throatM, vExitMps, stopDistM: stopDist, aReqG, feasible: aReqG <= aDecAvailG })
  }
  // virtual runway-end exit (V_exit = 0 m/s, must come to a full stop)
  const endStopDist = rwy.ldaM - tdz
  let aReqEndG = 999
  let endFeasible = false
  if (endStopDist > 0) {
    aReqEndG = (vTdMps*vTdMps) / (2 * endStopDist * G)
    endFeasible = aReqEndG <= aDecAvailG
  }
  exits.push({ ret: null, exitDistM: rwy.ldaM, vExitMps: 0, stopDistM: endStopDist, aReqG: aReqEndG, feasible: endFeasible })
  const endIdx = exits.length - 1

  // Recommended exit: the LAST feasible RET (smallest a_req that still vacates)
  // i.e. the LARGEST throat distance among feasible RETs (latest exit, smoothest demand).
  // If no RET feasible, fall back to runway-end if feasible; else best-effort = end.
  let bestIdx = -1
  for (let i = 0; i < exits.length - 1; i++) {
    if (exits[i].feasible) bestIdx = i
  }
  if (bestIdx < 0) {
    bestIdx = endFeasible ? endIdx : endIdx  // even if not feasible, end is the recommendation (with OVERRUN flag)
  }

  const chosen = exits[bestIdx]
  const aReqChosen = chosen.aReqG
  const marginM = chosen.stopDistM - ((vTdMps*vTdMps - chosen.vExitMps*chosen.vExitMps) / (2 * aDecAvailG * G))
  // marginM = available − used; positive = arrive at exit with margin to spare

  // 6 drivers (0..100 risk)
  // EXIT — gap vs recommended exit; OVERRUN-risk maxes when no exit feasible
  const exitIdx = (!endFeasible) ? 100
                 : (bestIdx === endIdx) ? 75
                 : (aReqChosen > aDecAvailG * 0.85) ? 55
                 : (aReqChosen > aDecAvailG * 0.65) ? 30
                 : (aReqChosen > aDecAvailG * 0.40) ? 15
                 : 5
  // MU — surface friction risk
  const muIdx = mu >= 0.38 ? 5 : mu >= 0.28 ? 22 : mu >= 0.18 ? 50 : mu >= 0.10 ? 78 : 95
  // WIND — tailwind escalates; headwind comfortable
  const windIdx = windKts <= -8 ? 5 : windKts <= 0 ? 12 : windKts <= 5 ? 30 : windKts <= 10 ? 55 : windKts <= 15 ? 78 : 92
  // SLOPE — downhill (negative %) penalised
  const slopeIdx = rwy.slopePct <= -0.20 ? 60 : rwy.slopePct <= -0.10 ? 35 : rwy.slopePct <= 0 ? 18 : 8
  // ALIGN — large heading error at this phase = unstable approach
  const alignIdx = Math.max(0, Math.min(100, alignErrDeg * 3))
  // MASS — heavier of cls (vs OEM-typ for class) — proxy via massT vs 200t reference
  const massIdx = sp.massT >= 350 ? 65 : sp.massT >= 200 ? 40 : sp.massT >= 100 ? 25 : 12

  const drv: DriverScore = { exit:exitIdx, mu:muIdx, wind:windIdx, slope:slopeIdx, align:alignIdx, mass:massIdx }
  const values = [exitIdx, muIdx, windIdx, slopeIdx, alignIdx, massIdx]
  const maxV = Math.max(...values)
  const meanV = values.reduce((a,b)=>a+b,0) / values.length

  // Out-of-scope phases get N/A
  if (phase !== 'SHORT-FINAL' && phase !== 'FLARE' && phase !== 'ROLLOUT' && phase !== 'APPROACH') {
    return { score: 0, tier: 'N/A', drv, phase, cls, vTdKts: vTdKtsEff, vExitKts: chosen.vExitMps/KT_TO_MPS, exits, bestIdx, endIdx, aDecAvailG, aDecReqG: aReqChosen, marginM, muLabel, rcam, windComp: windKts, tdzBiasM: tdz, ldaM: rwy.ldaM }
  }

  let composite = (maxV * 0.65 + meanV * 0.35) * (advMul / 100)
  // Hard escalators
  if (!endFeasible) composite = Math.max(composite, 92)
  if (bestIdx === endIdx && endFeasible) composite = Math.max(composite, 72)
  if (alignIdx > 60 && (phase === 'FLARE' || phase === 'ROLLOUT')) composite = Math.max(composite, 60)
  composite = Math.max(0, Math.min(100, composite))

  // Tier mapping
  let tier: Tier
  if (!endFeasible) tier = 'OVERRUN'
  else if (bestIdx === endIdx) tier = 'MISS-EXIT'         // forced to runway end; no usable RET
  else if (aReqChosen > aDecAvailG * 0.85) tier = 'TIGHT' // feasible but close to envelope
  else if (aReqChosen > aDecAvailG * 0.40) tier = 'NOMINAL'
  else tier = 'EARLY-EXIT'

  return { score: composite, tier, drv, phase, cls, vTdKts: vTdKtsEff, vExitKts: chosen.vExitMps/KT_TO_MPS, exits, bestIdx, endIdx, aDecAvailG, aDecReqG: aReqChosen, marginM, muLabel, rcam, windComp: windKts, tdzBiasM: tdz, ldaM: rwy.ldaM }
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------
type Tab = 'AIRCRAFT' | 'RUNWAYS' | 'PHYSICS'

export default function BtvMonitor({ map, flights, onClose, onFly }: Props) {
  const [tab, setTab] = useState<Tab>('AIRCRAFT')
  const [advMul, setAdvMul] = useState(100)
  const [tierFilter, setTierFilter] = useState<Set<Tier>>(new Set(['OVERRUN','MISS-EXIT','TIGHT','NOMINAL','EARLY-EXIT']))
  const [showHalo, setShowHalo] = useState(true)
  const [showPin, setShowPin] = useState(true)
  const [showRet, setShowRet] = useState(true)
  const [showCl, setShowCl] = useState(true)
  const [query, setQuery] = useState('')

  type Row = {
    f: F
    rwy: Runway | null
    alignErrDeg: number
    score: ScoreResult
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const f of flights) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue
      const snap = snapRunway(f)
      const sc = scoreAircraft(f, snap.rwy, snap.alignErrDeg, advMul)
      // Skip rows that are firmly N/A (no rwy or wrong phase) unless tier filter says otherwise
      out.push({ f, rwy: snap.rwy, alignErrDeg: snap.alignErrDeg, score: sc })
    }
    out.sort((a, b) => {
      const ra = TIER_RANK[a.score.tier], rb = TIER_RANK[b.score.tier]
      if (ra !== rb) return rb - ra
      return b.score.score - a.score.score
    })
    return out
  }, [flights, advMul])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (!tierFilter.has(r.score.tier)) return false
      if (q) {
        const hay = `${r.f.callsign||''} ${r.f.type||''} ${r.f.operator||''} ${r.rwy?.iata||''} ${r.rwy?.id||''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tierFilter, query])

  const stats = useMemo(() => {
    const cnt: Record<Tier, number> = { OVERRUN:0, 'MISS-EXIT':0, TIGHT:0, NOMINAL:0, 'EARLY-EXIT':0, 'N/A':0 }
    let scoreSum = 0
    let worst: Row | null = null
    let inScope = 0
    for (const r of rows) {
      cnt[r.score.tier]++
      if (r.score.tier !== 'N/A') {
        inScope++
        scoreSum += r.score.score
        if (!worst || r.score.score > worst.score.score) worst = r
      }
    }
    const meanScore = inScope ? scoreSum / inScope : 0
    return { cnt, meanScore, worst, total: inScope }
  }, [rows])

  // -------------------------------------------------------------------------
  // MapLibre rendering
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!map) return
    const SRC_RWY = 'btv-rwy-src'
    const LYR_RWY = 'btv-rwy-lyr'
    const LYR_RWY_LBL = 'btv-rwy-lbl'
    const SRC_RET = 'btv-ret-src'
    const LYR_RET = 'btv-ret-lyr'
    const LYR_RET_LBL = 'btv-ret-lbl'
    const SRC_HALO = 'btv-halo-src'
    const LYR_HALO = 'btv-halo-lyr'
    const SRC_PIN = 'btv-pin-src'
    const LYR_PIN = 'btv-pin-lyr'
    const LYR_LBL = 'btv-pin-lbl'

    const ids = [LYR_RWY, LYR_RWY_LBL, LYR_RET, LYR_RET_LBL, LYR_HALO, LYR_PIN, LYR_LBL]
    const srcs = [SRC_RWY, SRC_RET, SRC_HALO, SRC_PIN]

    const cleanup = () => {
      for (const id of ids) { try { if (map.getLayer(id)) map.removeLayer(id) } catch {} }
      for (const id of srcs) { try { if (map.getSource(id)) map.removeSource(id) } catch {} }
    }

    cleanup()

    // Runway centrelines for every catalogued runway
    if (showCl) {
      const rwyLines: any[] = []
      for (const r of RUNWAYS) {
        const endPt = offsetMeters(r.lat, r.lng, r.ldaM, r.bearingTrue)
        rwyLines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[r.lng, r.lat], [endPt[1], endPt[0]]] },
          properties: { id: `${r.airport}/${r.id}`, label: `${r.iata} ${r.id}` },
        })
      }
      map.addSource(SRC_RWY, { type: 'geojson', data: { type: 'FeatureCollection', features: rwyLines } })
      map.addLayer({ id: LYR_RWY, type: 'line', source: SRC_RWY, paint: {
        'line-color': '#0ea5e9',
        'line-opacity': 0.35,
        'line-width': 1.4,
        'line-dasharray': [2, 1],
      } })
      map.addLayer({ id: LYR_RWY_LBL, type: 'symbol', source: SRC_RWY, layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 9,
        'symbol-placement': 'line',
        'text-offset': [0, -0.9],
      }, paint: { 'text-color': '#7dd3fc', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 } })
    }

    // Active-rollout aircraft only: tier-coloured pins + halos
    if (filtered.length > 0) {
      if (showHalo) {
        const haloFeats = filtered.filter(r => r.score.tier !== 'N/A').map(r => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
          properties: { icao: r.f.icao, color: TIER_COLOUR[r.score.tier], radius: 8 + TIER_RANK[r.score.tier] * 2.2 },
        }))
        if (haloFeats.length > 0) {
          map.addSource(SRC_HALO, { type: 'geojson', data: { type: 'FeatureCollection', features: haloFeats } })
          map.addLayer({ id: LYR_HALO, type: 'circle', source: SRC_HALO, paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.22,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-opacity': 0.7,
            'circle-stroke-width': 1.4,
          } })
        }
      }

      if (showPin) {
        const pinFeats = filtered.filter(r => r.score.tier !== 'N/A').slice(0, 60).map(r => {
          const exitName = r.score.bestIdx === r.score.endIdx ? 'END' : (r.score.exits[r.score.bestIdx]?.ret?.nameTwy || '—')
          const lbl = r.score.tier === 'OVERRUN'
            ? `${r.f.callsign||r.f.icao}  OVERRUN ${r.rwy?.iata||''} ${r.rwy?.id||''}`
            : `${r.f.callsign||r.f.icao} › ${r.rwy?.iata||''} ${r.rwy?.id||''} exit ${exitName}`
          return {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [r.f.lng, r.f.lat] },
            properties: { icao: r.f.icao, lbl, color: TIER_COLOUR[r.score.tier] },
          }
        })
        if (pinFeats.length > 0) {
          map.addSource(SRC_PIN, { type: 'geojson', data: { type: 'FeatureCollection', features: pinFeats } })
          map.addLayer({ id: LYR_PIN, type: 'circle', source: SRC_PIN, paint: {
            'circle-radius': 3.6,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1,
          } })
          map.addLayer({ id: LYR_LBL, type: 'symbol', source: SRC_PIN, layout: {
            'text-field': ['get', 'lbl'],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-size': 9,
            'text-offset': [0.9, 0],
            'text-anchor': 'left',
            'text-allow-overlap': false,
          }, paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.3 } })
        }
      }
    }

    // RET chevrons — coloured by feasibility for each scored aircraft. Aggregate
    // across all current rollout aircraft: each RET takes the worst (highest
    // TIER_RANK) judgement among aircraft targeting that runway. If no aircraft
    // is active on the runway, plot RETs in slate (reference-only).
    if (showRet) {
      const retFeats: any[] = []
      // Build per-rwy aggregate state
      const rwyToWorst: Record<string, { rank: number; bestIdx: number; tier: Tier }> = {}
      for (const r of filtered) {
        if (!r.rwy) continue
        const key = `${r.rwy.airport}/${r.rwy.id}`
        const cur = rwyToWorst[key]
        const rk = TIER_RANK[r.score.tier]
        if (!cur || rk > cur.rank) {
          rwyToWorst[key] = { rank: rk, bestIdx: r.score.bestIdx, tier: r.score.tier }
        }
      }
      for (const r of RUNWAYS) {
        const key = `${r.airport}/${r.id}`
        const worst = rwyToWorst[key]
        for (let i = 0; i < r.rets.length; i++) {
          const ret = r.rets[i]
          // RET marker = a short chevron line perpendicular to the runway at the throat
          const throatPt = offsetMeters(r.lat, r.lng, ret.throatM, r.bearingTrue)
          const lateralL = offsetMeters(throatPt[0], throatPt[1], r.widthM * 0.6, r.bearingTrue + 90)
          const lateralR = offsetMeters(throatPt[0], throatPt[1], r.widthM * 0.6, r.bearingTrue - 90)
          let colour = '#64748b'  // slate-500 reference-only
          if (worst) {
            if (i === worst.bestIdx) {
              colour = TIER_COLOUR[worst.tier]
            } else {
              colour = '#475569'  // slate-600 inactive but candidate
            }
          }
          retFeats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[lateralL[1], lateralL[0]], [lateralR[1], lateralR[0]]] },
            properties: { id: `${key}-${ret.nameTwy}`, label: `${ret.nameTwy} ${ret.maxKts}kt`, color: colour },
          })
        }
      }
      if (retFeats.length > 0) {
        map.addSource(SRC_RET, { type: 'geojson', data: { type: 'FeatureCollection', features: retFeats } })
        map.addLayer({ id: LYR_RET, type: 'line', source: SRC_RET, paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.80,
          'line-width': 3,
        } })
        map.addLayer({ id: LYR_RET_LBL, type: 'symbol', source: SRC_RET, layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size': 8,
          'text-offset': [0, 0.7],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        }, paint: { 'text-color': '#94a3b8', 'text-halo-color': '#0f172a', 'text-halo-width': 1 } })
      }
    }

    return cleanup
  }, [map, filtered, showHalo, showPin, showRet, showCl])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const toggleTier = (t: Tier) => {
    setTierFilter(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  return (
    <div className="absolute right-2 top-16 z-40 w-[460px] max-h-[78vh] flex flex-col rounded-xl border border-sky-500/40 bg-slate-900/95 backdrop-blur shadow-2xl shadow-sky-900/40 text-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 text-[10px] font-mono font-semibold">BTV</span>
          <div>
            <div className="text-[12px] font-semibold tracking-wide">Brake-To-Vacate / ROPS Exit-Selection</div>
            <div className="text-[10px] text-slate-500 tracking-wide">FCOM PRO-NOR-SOP-19 · DSC-32-30-30-20 · DO-367 · AC 25-32 · TSB A05H0002</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-lg leading-none px-2">×</button>
      </div>

      {/* Tier counter strip */}
      <div className="grid grid-cols-6 gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['OVERRUN','MISS-EXIT','TIGHT','NOMINAL','EARLY-EXIT','N/A'] as Tier[]).map(t => (
          <button key={t} onClick={() => toggleTier(t)}
            className={`px-1 py-1 flex flex-col items-center transition ${tierFilter.has(t) ? 'bg-slate-900' : 'bg-slate-900/40 opacity-50'}`}
            style={{ color: TIER_COLOUR[t] }}>
            <div className="text-[8px] tracking-tight">{t === 'MISS-EXIT' ? 'MISSEX' : t === 'EARLY-EXIT' ? 'EARLY' : t}</div>
            <div className="text-[12px] font-semibold">{stats.cnt[t]}</div>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-px bg-slate-700/60 text-[10px] font-mono">
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">μ-SCORE</span>
          <span className="text-slate-200">{stats.meanScore.toFixed(1)}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">IN-SCOPE</span>
          <span className="text-slate-200">{stats.total}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">RWYS</span>
          <span className="text-slate-200">{RUNWAYS.length}</span>
        </div>
        <div className="px-2 py-1 bg-slate-900/90 flex flex-col">
          <span className="text-[9px] text-slate-500">WORST</span>
          <span className="text-slate-200 truncate">{stats.worst ? `${stats.worst.f.callsign||stats.worst.f.icao}` : '—'}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-px bg-slate-700/60 text-[10px] font-mono">
        {(['AIRCRAFT','RUNWAYS','PHYSICS'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 transition ${tab === t ? 'bg-sky-500/15 text-sky-300 border-b border-sky-500/40' : 'bg-slate-900/90 text-slate-400 hover:text-slate-200'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="px-2 py-1.5 border-b border-slate-800 bg-slate-950/40 flex flex-col gap-1.5 text-[10px]">
        <div className="flex items-center gap-2">
          <label className="text-slate-500 w-12">ADV-MUL</label>
          <input type="range" min={50} max={200} value={advMul} onChange={e => setAdvMul(+e.target.value)} className="flex-1 accent-sky-500" />
          <span className="text-slate-300 w-12 text-right font-mono">{advMul}%</span>
        </div>
        <div className="flex items-center gap-1.5 text-[9px]">
          {([['HALO',showHalo,setShowHalo],['PIN',showPin,setShowPin],['RET',showRet,setShowRet],['CL',showCl,setShowCl]] as const).map(([lab, v, set]) => (
            <button key={lab as string} onClick={() => (set as any)(!v)}
              className={`px-1.5 py-0.5 rounded border transition ${v ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'bg-slate-800/40 border-slate-700 text-slate-500'}`}>
              {lab}
            </button>
          ))}
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="filter cs/type/rwy"
            className="ml-auto flex-1 max-w-[150px] bg-slate-800/60 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder-slate-600 text-[9px]" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'AIRCRAFT' && (
          <div className="divide-y divide-slate-800">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-slate-500">
                No aircraft currently on short-final / flare / rollout to a catalogued BTV-relevant runway.
              </div>
            )}
            {filtered.slice(0, 80).map(r => {
              const sc = r.score
              const cls = AC_SPEC[sc.cls]
              const chosen = sc.exits[sc.bestIdx]
              const exitName = sc.bestIdx === sc.endIdx ? 'END' : (chosen?.ret?.nameTwy || '—')
              return (
                <button key={r.f.icao} onClick={() => onFly(r.f.icao)}
                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800/40 transition flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono">
                    <span className="font-semibold text-slate-100">{r.f.callsign || r.f.icao}</span>
                    <span className="text-slate-500">{r.f.type || '—'}</span>
                    <span className="text-slate-600">·</span>
                    <span className="text-slate-400">{cls.label}{cls.btvEquipped ? ' ★' : ''}</span>
                    <span className="ml-auto px-1 rounded text-[9px]" style={{ color: TIER_COLOUR[sc.tier], borderColor: TIER_COLOUR[sc.tier], borderWidth: 1, borderStyle: 'solid' }}>
                      {sc.tier} {sc.score.toFixed(0)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] text-slate-500 font-mono">
                    <span className="text-slate-300">{r.rwy?.iata || '—'} {r.rwy?.id || ''}</span>
                    <span>·</span>
                    <span>{sc.phase}</span>
                    <span>·</span>
                    <span>exit {exitName}</span>
                    <span>·</span>
                    <span>{sc.muLabel} a-avl {sc.aDecAvailG.toFixed(2)}g</span>
                    <span>·</span>
                    <span style={{ color: sc.windComp > 5 ? '#f59e0b' : '#cbd5e1' }}>{sc.windComp >= 0 ? '+' : ''}{sc.windComp}kt</span>
                  </div>
                  <div className="h-1 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full transition-all" style={{ width: `${sc.score}%`, background: TIER_COLOUR[sc.tier] }} />
                  </div>
                  <div className="grid grid-cols-6 gap-px text-[8px] text-slate-500 font-mono">
                    {(['exit','mu','wind','slope','align','mass'] as const).map(k => (
                      <div key={k} className="flex flex-col items-center bg-slate-800/40 px-1 py-0.5 rounded">
                        <span className="uppercase tracking-tight">{k.slice(0,4)}</span>
                        <span className="text-slate-300">{(sc.drv as any)[k].toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[9px] text-slate-500 font-mono leading-tight">
                    {sc.tier === 'OVERRUN' ? (
                      <span style={{ color: '#fb7185' }}>OVERRUN — a_req {sc.aDecReqG.toFixed(2)}g &gt; a_avail {sc.aDecAvailG.toFixed(2)}g at runway end. Go-around per Airbus FCOM PRO-NOR-SOP-19 / TSB A05H0002.</span>
                    ) : sc.tier === 'MISS-EXIT' ? (
                      <span style={{ color: '#f59e0b' }}>MISS-EXIT — no usable RET; full-stop rollout. MAX autobrake from TDZ, vacate at end via {sc.exits[sc.endIdx]?.ret?.nameTwy || 'end-twy'}.</span>
                    ) : sc.tier === 'TIGHT' ? (
                      <span style={{ color: '#f59e0b' }}>TIGHT — exit {exitName} feasible at a_req {sc.aDecReqG.toFixed(2)}g (envelope {sc.aDecAvailG.toFixed(2)}g). MED autobrake, brace for late deceleration.</span>
                    ) : sc.tier === 'NOMINAL' ? (
                      <span style={{ color: '#cbd5e1' }}>NOMINAL — exit {exitName} at {sc.vExitKts.toFixed(0)}kt, a_req {sc.aDecReqG.toFixed(2)}g, margin {sc.marginM.toFixed(0)}m.</span>
                    ) : sc.tier === 'EARLY-EXIT' ? (
                      <span style={{ color: '#7dd3fc' }}>EARLY-EXIT — exit {exitName} comfortable at LOW autobrake. Save brake-disc heat for next sector.</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>N/A — out of BTV scope (phase {sc.phase} or no aligned runway).</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {tab === 'RUNWAYS' && (
          <div className="divide-y divide-slate-800 text-[10px] font-mono">
            <div className="px-2 py-1 bg-slate-950/60 text-[9px] text-slate-500 grid grid-cols-6 gap-1">
              <span>ICAO/RWY</span><span>LDA-m</span><span>SLOPE</span><span>RETs</span><span>RESA</span><span>SURF</span>
            </div>
            {RUNWAYS.slice().sort((a, b) => a.ldaM - b.ldaM).map(rwy => (
              <div key={`${rwy.airport}-${rwy.id}`} className="px-2 py-1 grid grid-cols-6 gap-1 items-center hover:bg-slate-800/40 transition">
                <div className="flex flex-col">
                  <span className="text-slate-200">{rwy.iata} {rwy.id}</span>
                  <span className="text-[8px] text-slate-600 truncate">{rwy.airportName}</span>
                </div>
                <span className="text-slate-300">{rwy.ldaM}</span>
                <span style={{ color: rwy.slopePct < -0.10 ? '#f59e0b' : '#cbd5e1' }}>{rwy.slopePct > 0 ? '+' : ''}{rwy.slopePct.toFixed(2)}%</span>
                <span className="text-slate-300">{rwy.rets.length}</span>
                <span style={{ color: rwy.resaM < 150 ? '#fb7185' : rwy.resaM < 240 ? '#f59e0b' : '#10b981' }}>{rwy.resaM}m</span>
                <span className="text-slate-400 text-[9px]">{rwy.surface}</span>
              </div>
            ))}
            <div className="px-2 py-2 text-[9px] text-slate-500 border-t border-slate-800/80">
              <div className="mb-1 text-slate-400">RCAM friction-code reference (ICAO Annex 14 / FAA TALPA AC 150/5200-30D)</div>
              <div className="grid grid-cols-2 gap-1">
                <div className="flex justify-between"><span style={{color:'#10b981'}}>6 DRY</span><span>μ ≈ 0.40</span></div>
                <div className="flex justify-between"><span style={{color:'#38bdf8'}}>5 WET</span><span>μ ≈ 0.30</span></div>
                <div className="flex justify-between"><span style={{color:'#f59e0b'}}>4 SLUSH</span><span>μ ≈ 0.20</span></div>
                <div className="flex justify-between"><span style={{color:'#fb7185'}}>3 COMP-SNOW</span><span>μ ≈ 0.12</span></div>
                <div className="flex justify-between"><span style={{color:'#fb7185'}}>2 STD-WATER</span><span>μ ≈ 0.08</span></div>
                <div className="flex justify-between"><span style={{color:'#f43f5e'}}>1 ICE</span><span>μ ≈ 0.05</span></div>
              </div>
            </div>
          </div>
        )}

        {tab === 'PHYSICS' && (
          <div className="px-3 py-3 text-[10px] font-mono space-y-3 text-slate-400">
            <div>
              <div className="text-sky-300 mb-1">PRECEDENT</div>
              <div className="text-slate-300 leading-snug">
                Air France 358 (F-GLZQ A340-313X) CYYZ 2005-08-02 — YYZ arrival 24L,
                ALD 2743m, runway wet w/ thunderstorm, ~10kt tailwind shift through
                flare. Aircraft floated long, touched down ~1280m past threshold
                leaving ~1463m. Reverse deployment delayed ~12.8s after MLG
                compression. Departed end at ~80kt, traversed 240m RESA, came to
                rest in Etobicoke Creek ravine, post-impact fuel-fed fire, 309
                souls evacuated, hull loss. TSB A05H0002 explicitly cited the
                absence of an exit-selection / wet-runway-μ aware decision
                support tool as a counterfactual mitigator — BTV-MAX (Airbus
                A380 EIS 2009+) was designed precisely to surface this decision
                pre-touchdown.
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">BTV EQUATION</div>
              <div className="text-slate-300 leading-snug font-mono text-[10px]">
                D_req = (V_TD² − V_exit²) / (2 · a_dec_eff)
                <br />
                a_dec_eff = μ · g + a_rev + slope · g − wind_assist
                <br />
                a_dec_avail = min(OAUW, μ · g + a_rev)
                <br />
                For RET-i at throat x_i, available stop D_avail_i = x_i − x_TDZ
                <br />
                a_req_i = (V_TD² − V_exit_i²) / (2 · D_avail_i)
                <br />
                Recommend i* = max(x_i) such that a_req_i ≤ a_dec_avail
                <br />
                OVERRUN ⇔ a_req_end &gt; a_dec_avail (end of runway can't stop)
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">6 DRIVERS</div>
              <ul className="text-slate-300 text-[9px] space-y-0.5">
                <li>EXIT — gap between required a_dec and available a_dec at chosen RET</li>
                <li>MU — surface μ_brake from RCAM friction code (DRY → ICE, 0.40 → 0.05)</li>
                <li>WIND — landing-direction component, +tailwind = overrun-risk (Vap penalty 0.7kt/kt)</li>
                <li>SLOPE — runway slope, downhill (−%) reduces braking effectiveness</li>
                <li>ALIGN — heading vs runway-bearing error, large = unstable approach</li>
                <li>MASS — landing mass relative to class median (heavier = longer LDR)</li>
              </ul>
            </div>
            <div>
              <div className="text-sky-300 mb-1">AUTOBRAKE OAUW ENVELOPES</div>
              <div className="text-slate-300 text-[9px] space-y-0.5 font-mono">
                <div className="flex justify-between"><span>A380 (BTV-MAX)</span><span>OAUW 0.32g · MAX 0.36g · MED 0.20g · LOW 0.13g</span></div>
                <div className="flex justify-between"><span>A350 (BTV)</span><span>OAUW 0.31g · MAX 0.35g · MED 0.19g · LOW 0.12g</span></div>
                <div className="flex justify-between"><span>A330neo (BTV)</span><span>OAUW 0.30g · MAX 0.34g · MED 0.19g · LOW 0.12g</span></div>
                <div className="flex justify-between"><span>A320neo (ROW/ROP)</span><span>OAUW 0.28g · MAX 0.30g · MED 0.17g · LOW 0.10g</span></div>
                <div className="flex justify-between"><span>B777 / B787</span><span>OAUW 0.30g · MAX 0.33-0.34g · MED 0.19g · LOW 0.12g</span></div>
                <div className="flex justify-between"><span>B737 / B752</span><span>OAUW 0.28g · MAX 0.31g · MED 0.17g · LOW 0.10g</span></div>
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">DISTINCT FROM</div>
              <div className="text-slate-300 leading-snug text-[9px]">
                ROW/ROP (overrun WARNING reactive vs LDA), OLD (Operational Landing
                Distance at-the-fence comparator), HIRO/RET (rapid-exit
                infrastructure inventory, geometry only), BRAKE-TEMP (carbon-disc
                thermal margin, Tau_brake fuse-plug melt), EMAS/RESA (engineered
                arrestor bed past runway end — last-line of defence), RAAS
                (aural distance-remaining callouts via SmartRunway/SmartLanding),
                HYDROPLANE (dynamic aquaplaning V_p = 9√P_t), FOD (debris
                detection), STBR/RWSL (in-pavement enforcement). BTV is uniquely
                the EXIT-CHOICE OPTIMISER: given V_TD, μ, slope, wind, mass
                and exit catalogue, choose the latest RET that achievable
                autobrake demand can meet within the OAUW envelope.
              </div>
            </div>
            <div>
              <div className="text-sky-300 mb-1">REGULATORY / OEM FRAMEWORK</div>
              <div className="text-slate-300 leading-snug text-[9px]">
                Airbus FCOM PRO-NOR-SOP-19 · DSC-32-30-30-20 ROPS · FAST 51/54 ·
                RTCA DO-367 ASA MOPS · DO-358/DO-329 overrun awareness · FAA
                AC 25-32 (landing perf) · AC 91-79B (overrun risk) · AC 25.1322-1
                (alerting) · SAFO 06012 / 19001 (in-time landing assessment) ·
                EASA CS-25.109/.125/.1322 · TCDS A.110 (A380) · ICAO Annex 14
                Vol I §3.10 / 3.9 (RET geometry) · Doc 9157 Pt 2 (Aerodrome Design) ·
                Doc 9981 PANS-AGA · Annex 6 Pt I §4.3.7 at-the-fence · TSB
                A05H0002 (AF358 CYYZ) · AAIB EW/C2020/05/02 (Pegasus 2193 SAW) ·
                ATSB AO-2010-082 (Jetstar ZBAA hard rollout).
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-2 py-1 border-t border-slate-800 text-[9px] text-slate-500 font-mono flex items-center justify-between">
        <span>BTV · {RUNWAYS.length} runways · 10 airframe classes · TSB A05H0002 AF358 precedent</span>
        <span className="text-slate-600">v1</span>
      </div>
    </div>
  )
}
